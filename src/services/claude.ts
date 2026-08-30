import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

import { quotaSuccessSchema, type QuotaLimit } from "../domain/quota.js";
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
};

export function createClaudeProvider(
  dependencies: ClaudeProviderDependencies = {},
): QuotaProvider {
  const command = dependencies.command ?? "claude";
  const run = dependencies.run ?? runCommand;

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

      const configDirectory = await mkdtemp(
        join(tmpdir(), "seat-monitor-claude-"),
      );

      try {
        const result = await run({
          command,
          args: ["auth", "status", "--json"],
          environment: minimalChildEnvironment({
            CLAUDE_CODE_OAUTH_TOKEN: account.auth.credential,
            CLAUDE_CONFIG_DIR: configDirectory,
            DISABLE_AUTOUPDATER: "1",
            DISABLE_ERROR_REPORTING: "1",
            DISABLE_TELEMETRY: "1",
          }),
          timeoutMilliseconds: context.timeoutMilliseconds,
        });
        const observedAt = context.now().toISOString();

        if (result.exitCode !== 0) {
          return createFailureSnapshot(
            account,
            "unauthorized",
            "Claude CLI could not authenticate this account.",
            observedAt,
          );
        }

        let payload: unknown;
        try {
          payload = JSON.parse(result.stdout);
        } catch {
          return createFailureSnapshot(
            account,
            "invalid_response",
            "Claude CLI returned an invalid authentication response.",
            observedAt,
          );
        }

        const parsed = claudeAuthStatusSchema.safeParse(payload);
        if (!parsed.success) {
          return createFailureSnapshot(
            account,
            "invalid_response",
            "Claude CLI returned an unexpected authentication response.",
            observedAt,
          );
        }

        if (!parsed.data.loggedIn) {
          return createFailureSnapshot(
            account,
            "unauthorized",
            "Claude account is not authenticated.",
            observedAt,
          );
        }

        return quotaSuccessSchema.parse({
          accountAlias: account.accountAlias,
          platform: account.platform,
          status: "ok",
          plan: parsed.data.subscriptionType ?? null,
          limits: unsupportedClaudeLimits,
          observedAt,
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
        return createFailureSnapshot(
          account,
          "network",
          "Claude account check failed.",
          observedAt,
        );
      } finally {
        await rm(configDirectory, { force: true, recursive: true });
      }
    },
  };
}
