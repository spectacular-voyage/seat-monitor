import { constants } from "node:fs";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

import {
  quotaSuccessSchema,
  type QuotaLimit,
  type QuotaSnapshot,
} from "../domain/quota.js";
import {
  CodexProtocolError,
  readCodexAppServer,
  type CodexAppServerResult,
  type ReadCodexAppServer,
} from "./codex-app-server.js";
import { createFailureSnapshot } from "./failure.js";
import {
  minimalChildEnvironment,
  ProcessSpawnError,
  ProcessTimeoutError,
} from "./process.js";
import type { QuotaProvider } from "./provider.js";
import { unixSecondsToIso } from "./time.js";

const accountResultSchema = z.looseObject({
  account: z
    .looseObject({
      planType: z.string().min(1).nullable().optional(),
    })
    .nullable(),
});

const rateWindowSchema = z.looseObject({
  usedPercent: z.number().min(0).max(100),
  windowDurationMins: z.number().positive().nullable().optional(),
  resetsAt: z.number().int().nonnegative().nullable().optional(),
});

const rateLimitBucketSchema = z.looseObject({
  limitId: z.string().min(1),
  limitName: z.string().min(1).nullable().optional(),
  planType: z.string().min(1).nullable().optional(),
  primary: rateWindowSchema.nullable().optional(),
  secondary: rateWindowSchema.nullable().optional(),
});

const rateLimitsResultSchema = z.looseObject({
  rateLimits: rateLimitBucketSchema.nullable().optional(),
  rateLimitsByLimitId: z
    .record(z.string(), rateLimitBucketSchema)
    .nullable()
    .optional(),
});

export type CodexProviderDependencies = {
  command?: string;
  read?: ReadCodexAppServer;
  profileIsReady?: (codexHome: string) => Promise<boolean>;
};

async function profileIsReady(codexHome: string): Promise<boolean> {
  try {
    await access(join(codexHome, "auth.json"), constants.R_OK | constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function titleCase(value: string): string {
  return value
    .split(/[-_\s]+/u)
    .filter((part) => part.length > 0)
    .map(
      (part) => `${part.charAt(0).toLocaleUpperCase("en-US")}${part.slice(1)}`,
    )
    .join(" ");
}

export function normalizeCodexResult(
  accountAlias: string,
  result: CodexAppServerResult,
  observedAt: string,
): QuotaSnapshot {
  const account = accountResultSchema.parse(result.accountResult);
  const rateLimits = rateLimitsResultSchema.parse(result.rateLimitsResult);

  if (account.account === null) {
    throw new CodexProtocolError(1);
  }

  const buckets =
    rateLimits.rateLimitsByLimitId === undefined ||
    rateLimits.rateLimitsByLimitId === null
      ? rateLimits.rateLimits === undefined || rateLimits.rateLimits === null
        ? []
        : [rateLimits.rateLimits]
      : Object.values(rateLimits.rateLimitsByLimitId);

  const limits: QuotaLimit[] = [];
  for (const bucket of buckets) {
    for (const windowName of ["primary", "secondary"] as const) {
      const window = bucket[windowName];
      if (window === undefined || window === null) {
        continue;
      }
      const bucketLabel = bucket.limitName ?? titleCase(bucket.limitId);
      limits.push({
        key: `${bucket.limitId}.${windowName}`,
        label: `${bucketLabel} ${titleCase(windowName)}`,
        scope: "window",
        availability: "available",
        usedPercent: window.usedPercent,
        windowDurationMinutes: window.windowDurationMins ?? null,
        resetAt:
          window.resetsAt === undefined || window.resetsAt === null
            ? null
            : unixSecondsToIso(window.resetsAt),
      });
    }
  }

  if (limits.length === 0) {
    throw new CodexProtocolError(2);
  }
  const bucketPlan = buckets.find(
    (bucket) => bucket.planType !== undefined && bucket.planType !== null,
  )?.planType;

  return quotaSuccessSchema.parse({
    accountAlias,
    platform: "Codex",
    status: "ok",
    plan: account.account.planType ?? bucketPlan ?? null,
    limits,
    observedAt,
  });
}

export function createCodexProvider(
  dependencies: CodexProviderDependencies = {},
): QuotaProvider {
  const command = dependencies.command ?? "codex";
  const read = dependencies.read ?? readCodexAppServer;
  const isProfileReady = dependencies.profileIsReady ?? profileIsReady;

  return {
    async scan(account, context) {
      if (account.platform !== "Codex") {
        return createFailureSnapshot(
          account,
          "invalid_response",
          "Codex provider received an incompatible account configuration.",
          context.now().toISOString(),
        );
      }

      let temporaryDirectory: string | null = null;

      try {
        let environment: NodeJS.ProcessEnv;
        if (account.auth.type === "codex_profile") {
          if (!(await isProfileReady(account.auth.codexHome))) {
            return createFailureSnapshot(
              account,
              "missing_credential",
              `Codex profile ${account.auth.profile} is not logged in. Run the codex:login command for this account.`,
              context.now().toISOString(),
            );
          }
          environment = minimalChildEnvironment({
            CODEX_HOME: account.auth.codexHome,
          });
        } else {
          temporaryDirectory = await mkdtemp(
            join(tmpdir(), "seat-monitor-codex-"),
          );
          environment = minimalChildEnvironment({
            CODEX_ACCESS_TOKEN: account.auth.credential,
            CODEX_HOME: temporaryDirectory,
          });
        }

        const result = await read({
          command,
          environment,
          timeoutMilliseconds: context.timeoutMilliseconds,
        });
        const observedAt = context.now().toISOString();
        return normalizeCodexResult(account.accountAlias, result, observedAt);
      } catch (error) {
        const observedAt = context.now().toISOString();
        if (error instanceof ProcessTimeoutError) {
          return createFailureSnapshot(
            account,
            "timeout",
            "Codex account check timed out.",
            observedAt,
          );
        }
        if (error instanceof ProcessSpawnError && error.code === "ENOENT") {
          return createFailureSnapshot(
            account,
            "unsupported",
            "Codex CLI is not installed or is not on PATH.",
            observedAt,
          );
        }
        if (error instanceof CodexProtocolError) {
          const unsupported = error.requestId === 2;
          return createFailureSnapshot(
            account,
            unsupported ? "unsupported" : "unauthorized",
            unsupported
              ? "Codex quota is not available for this credential type."
              : "Codex App Server could not authenticate this account.",
            observedAt,
          );
        }
        return createFailureSnapshot(
          account,
          "invalid_response",
          "Codex App Server returned an invalid quota response.",
          observedAt,
        );
      } finally {
        if (temporaryDirectory !== null) {
          await rm(temporaryDirectory, { force: true, recursive: true });
        }
      }
    },
  };
}
