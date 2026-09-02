import { constants } from "node:fs";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

import { quotaSuccessSchema, type QuotaLimit } from "../domain/quota.js";
import { parseClaudeUsageOutput } from "./claude-usage.js";
import { createFailureSnapshot } from "./failure.js";
import {
  minimalChildEnvironment,
  ProcessSpawnError,
  ProcessTimeoutError,
  runCommand,
  type RunCommand,
} from "./process.js";
import type { QuotaProvider } from "./provider.js";

const claudeAuthStatusSchema = z.looseObject({
  loggedIn: z.boolean(),
  subscriptionType: z.string().min(1).nullable().optional(),
});

const unsupportedClaudeLimits: readonly QuotaLimit[] = [
  {
    key: "base",
    label: "Base",
    scope: "global",
    availability: "unsupported",
    usedPercent: null,
    windowDurationMinutes: null,
    resetAt: null,
  },
  {
    key: "fable",
    label: "Fable",
    scope: "model",
    availability: "unsupported",
    usedPercent: null,
    windowDurationMinutes: null,
    resetAt: null,
  },
];

export type ClaudeProviderDependencies = {
  command?: string;
  run?: RunCommand;
  profileIsReady?: (claudeConfigDir: string) => Promise<boolean>;
};

async function profileIsReady(claudeConfigDir: string): Promise<boolean> {
  try {
    await access(
      join(claudeConfigDir, ".credentials.json"),
      constants.R_OK | constants.W_OK,
    );
    return true;
  } catch {
    return false;
  }
}

function parseAuthStatus(
  stdout: string,
): z.infer<typeof claudeAuthStatusSchema> {
  let payload: unknown;
  try {
    payload = JSON.parse(stdout);
  } catch {
    throw new TypeError("Claude CLI returned invalid JSON.");
  }
  return claudeAuthStatusSchema.parse(payload);
}

export function createClaudeProvider(
  dependencies: ClaudeProviderDependencies = {},
): QuotaProvider {
  const command = dependencies.command ?? "claude";
  const run = dependencies.run ?? runCommand;
  const isProfileReady = dependencies.profileIsReady ?? profileIsReady;

  return {
    async scan(account, context) {
      if (account.platform !== "Claude") {
        return createFailureSnapshot(
          account,
          "invalid_response",
          "Claude provider received an incompatible account configuration.",
          context.now().toISOString(),
        );
      }

      let temporaryDirectory: string | null = null;

      try {
        let environment: NodeJS.ProcessEnv;
        const readsQuota = account.auth.type === "claude_profile";
        if (account.auth.type === "claude_profile") {
          if (!(await isProfileReady(account.auth.claudeConfigDir))) {
            return createFailureSnapshot(
              account,
              "missing_credential",
              `Claude profile ${account.auth.profile} is not logged in. Run: seat-monitor-claude-login '${account.accountAlias}'`,
              context.now().toISOString(),
            );
          }
          environment = minimalChildEnvironment({
            CLAUDE_CONFIG_DIR: account.auth.claudeConfigDir,
            CLAUDE_CODE_SKIP_PROMPT_HISTORY: "1",
            DISABLE_AUTOUPDATER: "1",
            DISABLE_ERROR_REPORTING: "1",
            // Claude omits the Fable quota line from /usage when
            // DISABLE_TELEMETRY is set, so profile quota reads must not set it.
          });
        } else {
          temporaryDirectory = await mkdtemp(
            join(tmpdir(), "seat-monitor-claude-"),
          );
          environment = minimalChildEnvironment({
            CLAUDE_CODE_OAUTH_TOKEN: account.auth.credential,
            CLAUDE_CONFIG_DIR: temporaryDirectory,
            CLAUDE_CODE_SKIP_PROMPT_HISTORY: "1",
            DISABLE_AUTOUPDATER: "1",
            DISABLE_ERROR_REPORTING: "1",
            DISABLE_TELEMETRY: "1",
          });
        }

        const authResult = await run({
          command,
          args: ["auth", "status", "--json"],
          environment,
          timeoutMilliseconds: context.timeoutMilliseconds,
        });
        if (authResult.exitCode !== 0) {
          return createFailureSnapshot(
            account,
            "unauthorized",
            "Claude CLI could not authenticate this account.",
            context.now().toISOString(),
          );
        }

        const authStatus = parseAuthStatus(authResult.stdout);
        if (!authStatus.loggedIn) {
          return createFailureSnapshot(
            account,
            "unauthorized",
            "Claude account is not authenticated.",
            context.now().toISOString(),
          );
        }

        let limits = unsupportedClaudeLimits;
        let observedAt = context.now();
        if (readsQuota) {
          const usageResult = await run({
            command,
            args: [
              "--setting-sources",
              "",
              "--strict-mcp-config",
              "-p",
              "/usage",
              "--no-session-persistence",
            ],
            environment,
            timeoutMilliseconds: context.timeoutMilliseconds,
          });
          observedAt = context.now();
          if (usageResult.exitCode !== 0) {
            return createFailureSnapshot(
              account,
              "invalid_response",
              "Claude CLI could not read account usage.",
              observedAt.toISOString(),
            );
          }
          limits = parseClaudeUsageOutput(
            usageResult.stdout,
            observedAt.getTime(),
          );
        }

        return quotaSuccessSchema.parse({
          accountAlias: account.accountAlias,
          platform: account.platform,
          status: "ok",
          plan: authStatus.subscriptionType ?? null,
          limits,
          observedAt: observedAt.toISOString(),
        });
      } catch (error) {
        const observedAt = context.now().toISOString();
        if (error instanceof ProcessTimeoutError) {
          return createFailureSnapshot(
            account,
            "timeout",
            "Claude account check timed out.",
            observedAt,
          );
        }
        if (error instanceof ProcessSpawnError && error.code === "ENOENT") {
          return createFailureSnapshot(
            account,
            "unsupported",
            "Claude CLI is not installed or is not on PATH.",
            observedAt,
          );
        }
        if (error instanceof TypeError || error instanceof z.ZodError) {
          return createFailureSnapshot(
            account,
            "invalid_response",
            "Claude CLI returned an invalid account response.",
            observedAt,
          );
        }
        return createFailureSnapshot(
          account,
          "network",
          "Claude account check failed.",
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
