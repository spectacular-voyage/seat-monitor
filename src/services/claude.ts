import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

import {
  quotaSuccessSchema,
  type QuotaLimit,
  type QuotaSnapshot,
} from "../domain/quota.js";
import {
  ClaudeUsageUnavailableError,
  parseClaudeUsageOutput,
} from "./claude-usage.js";
import {
  createClaudeHttpUsageReader,
  ClaudeUsageHttpError,
  type ReadClaudeHttpUsage,
} from "./claude-usage-http.js";
import {
  isUltraDisplayName,
  readClaudeProfileState,
  type ReadClaudeProfileState,
} from "./claude-profile-state.js";
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
  email: z.email().optional(),
  subscriptionType: z.string().min(1).nullable().optional(),
});

type AuthStatus = z.infer<typeof claudeAuthStatusSchema>;

/**
 * `claude auth status` starts the whole Claude CLI (a ~300 MB binary), so a
 * profile's identity check is reused between scans. A login as another
 * account rewrites `.credentials.json`, so a changed file is checked again at
 * once; the check is also repeated hourly, and shortly before the access
 * token expires, because the CLI refreshes an expired token while answering.
 */
const IDENTITY_RECHECK_MILLISECONDS = 3_600_000;
const TOKEN_REFRESH_MARGIN_MILLISECONDS = 5 * 60_000;
const MAX_CREDENTIAL_BYTES = 1_000_000;

export type ClaudeCredentialState = {
  /** SHA-256 of the file; kept in memory only. */
  fingerprint: string;
  expiresAtMilliseconds: number | null;
};

type VerifiedProfile = {
  fingerprint: string;
  verifiedAtMilliseconds: number;
  subscriptionType: string | null;
};

type AuthCheck =
  | { kind: "verified"; status: AuthStatus }
  | { kind: "failed"; snapshot: QuotaSnapshot };

const credentialExpirySchema = z.object({
  claudeAiOauth: z.object({
    expiresAt: z.number().int().positive().optional(),
  }),
});

export async function readClaudeCredentialState(
  claudeConfigDir: string,
): Promise<ClaudeCredentialState> {
  const file = await open(join(claudeConfigDir, ".credentials.json"), "r");
  try {
    if ((await file.stat()).size > MAX_CREDENTIAL_BYTES) {
      throw new RangeError("Claude credentials file is too large.");
    }
    const bytes = await file.readFile();
    const expiry = credentialExpirySchema.safeParse(
      JSON.parse(bytes.toString("utf8")) as unknown,
    );
    return {
      fingerprint: createHash("sha256").update(bytes).digest("hex"),
      expiresAtMilliseconds: expiry.success
        ? (expiry.data.claudeAiOauth.expiresAt ?? null)
        : null,
    };
  } finally {
    await file.close();
  }
}

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
  managedMcpIsConfigured?: () => Promise<boolean>;
  readHttpUsage?: ReadClaudeHttpUsage | null;
  readProfileState?: ReadClaudeProfileState;
  readCredentialState?: (
    claudeConfigDir: string,
  ) => Promise<ClaudeCredentialState>;
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

type CheckManagedMcpPath = (filePath: string) => Promise<void>;

const checkManagedMcpPath: CheckManagedMcpPath = (filePath) =>
  access(filePath, constants.F_OK);

export async function managedMcpIsConfigured(
  platform: NodeJS.Platform = process.platform,
  checkPath: CheckManagedMcpPath = checkManagedMcpPath,
): Promise<boolean> {
  let filePath: string | null;
  switch (platform) {
    case "darwin":
      filePath = "/Library/Application Support/ClaudeCode/managed-mcp.json";
      break;
    case "linux":
      filePath = "/etc/claude-code/managed-mcp.json";
      break;
    case "win32":
      filePath = "C:\\Program Files\\ClaudeCode\\managed-mcp.json";
      break;
    default:
      filePath = null;
  }

  if (filePath === null) {
    return false;
  }
  try {
    await checkPath(filePath);
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
  const readHttpUsage =
    dependencies.readHttpUsage === null
      ? null
      : (dependencies.readHttpUsage ?? createClaudeHttpUsageReader());
  let cliVersion: Promise<string> | null = null;
  function version(timeoutMilliseconds: number): Promise<string> {
    cliVersion ??= run({
      command,
      args: ["--version"],
      environment: minimalChildEnvironment({ DISABLE_AUTOUPDATER: "1" }),
      timeoutMilliseconds,
    })
      .then((result) => {
        const match = /^(\d+\.\d+\.\d+) \(Claude Code\)/u.exec(
          result.stdout.trim(),
        );
        if (result.exitCode !== 0 || match?.[1] === undefined)
          throw new ClaudeUsageHttpError();
        return match[1];
      })
      .catch((error: unknown) => {
        cliVersion = null;
        throw error;
      });
    return cliVersion;
  }
  const isProfileReady = dependencies.profileIsReady ?? profileIsReady;
  const readProfileState =
    dependencies.readProfileState ?? readClaudeProfileState;
  const hasManagedMcpConfig =
    dependencies.managedMcpIsConfigured ?? managedMcpIsConfigured;
  const readCredentials =
    dependencies.readCredentialState ?? readClaudeCredentialState;
  // Successful identity checks per profile and expected email.
  const verifiedProfiles = new Map<string, VerifiedProfile>();

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

      const scratch: { directory: string | null } = { directory: null };
      // Created only when a Claude CLI command runs: most profile scans reuse
      // an identity check and read quota over HTTP without one.
      const workDirectory = async (): Promise<string> => {
        // A quota probe has no project context. Avoid loading workspace files.
        scratch.directory ??= await mkdtemp(
          join(tmpdir(), "seat-monitor-claude-"),
        );
        return scratch.directory;
      };

      try {
        let environment: NodeJS.ProcessEnv;
        const readsQuota = account.auth.type === "claude_profile";
        const profile =
          account.auth.type === "claude_profile" ? account.auth : null;
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
          environment = minimalChildEnvironment({
            CLAUDE_CODE_OAUTH_TOKEN: account.auth.credential,
            CLAUDE_CONFIG_DIR: await workDirectory(),
            CLAUDE_CODE_SKIP_PROMPT_HISTORY: "1",
            DISABLE_AUTOUPDATER: "1",
            DISABLE_ERROR_REPORTING: "1",
            DISABLE_TELEMETRY: "1",
          });
        }
        const identityKey =
          profile === null
            ? null
            : `${profile.claudeConfigDir}\0${profile.expectedEmail.toLocaleLowerCase("en-US")}`;

        const readCredentialsOrNull = (claudeConfigDir: string) =>
          readCredentials(claudeConfigDir).catch(() => null);

        // A held check answers only while the credentials file is unchanged,
        // the check is under an hour old and the token is not about to expire.
        const reuseIdentityCheck = async (): Promise<AuthStatus | null> => {
          if (profile === null || identityKey === null) return null;
          const held = verifiedProfiles.get(identityKey);
          if (held === undefined) return null;
          const nowMilliseconds = context.now().getTime();
          const age = nowMilliseconds - held.verifiedAtMilliseconds;
          if (age < 0 || age >= IDENTITY_RECHECK_MILLISECONDS) return null;
          const credentials = await readCredentialsOrNull(
            profile.claudeConfigDir,
          );
          if (
            credentials?.fingerprint !== held.fingerprint ||
            (credentials.expiresAtMilliseconds !== null &&
              credentials.expiresAtMilliseconds - nowMilliseconds <=
                TOKEN_REFRESH_MARGIN_MILLISECONDS)
          ) {
            return null;
          }
          return {
            loggedIn: true,
            email: profile.expectedEmail,
            subscriptionType: held.subscriptionType,
          };
        };

        // Runs `claude auth status`, which also refreshes an expired access
        // token, and checks the profile's identity.
        // One `claude auth status` run, checked against the expected identity.
        const runAuthStatus = async (): Promise<AuthCheck> => {
          const failed = (
            code: "unauthorized" | "invalid_response" | "identity_mismatch",
            message: string,
          ): AuthCheck => ({
            kind: "failed",
            snapshot: createFailureSnapshot(
              account,
              code,
              message,
              context.now().toISOString(),
            ),
          });
          const authResult = await run({
            command,
            args: ["auth", "status", "--json"],
            environment,
            cwd: await workDirectory(),
            timeoutMilliseconds: context.timeoutMilliseconds,
          });
          if (authResult.exitCode !== 0) {
            return failed(
              "unauthorized",
              "Claude CLI could not authenticate this account.",
            );
          }
          const status = parseAuthStatus(authResult.stdout);
          if (!status.loggedIn) {
            return failed(
              "unauthorized",
              "Claude account is not authenticated.",
            );
          }
          if (profile === null) {
            return { kind: "verified", status };
          }
          if (status.email === undefined) {
            return failed(
              "invalid_response",
              "Claude CLI did not report an authenticated email for identity verification.",
            );
          }
          if (
            status.email.toLocaleLowerCase("en-US") !==
            profile.expectedEmail.toLocaleLowerCase("en-US")
          ) {
            return failed(
              "identity_mismatch",
              `Claude profile ${profile.profile} is authenticated as ${status.email}, expected ${profile.expectedEmail}. Run: seat-monitor-claude-login '${account.accountAlias}'`,
            );
          }
          return { kind: "verified", status };
        };

        // Runs the check and holds it only for the credentials file it saw:
        // the file must read the same before and after, so a login racing the
        // check is never held under this identity. A run that refreshed the
        // token changed the file, so the check runs once more against it.
        const checkIdentity = async (): Promise<AuthCheck> => {
          if (profile === null || identityKey === null) {
            return runAuthStatus();
          }
          verifiedProfiles.delete(identityKey);
          for (let attempt = 1; ; attempt += 1) {
            const before = await readCredentialsOrNull(profile.claudeConfigDir);
            const checked = await runAuthStatus();
            if (checked.kind === "failed") return checked;
            const after = await readCredentialsOrNull(profile.claudeConfigDir);
            if (
              before !== null &&
              after !== null &&
              before.fingerprint === after.fingerprint
            ) {
              verifiedProfiles.set(identityKey, {
                fingerprint: after.fingerprint,
                verifiedAtMilliseconds: context.now().getTime(),
                subscriptionType: checked.status.subscriptionType ?? null,
              });
              return checked;
            }
            // Unreadable, or still changing: verified, but not held.
            if (before === null || after === null || attempt >= 2) {
              return checked;
            }
          }
        };

        let authStatus = await reuseIdentityCheck();
        const reusedIdentity = authStatus !== null;
        if (authStatus === null) {
          const checked = await checkIdentity();
          if (checked.kind === "failed") return checked.snapshot;
          authStatus = checked.status;
        }

        let limits = unsupportedClaudeLimits;
        const declaredPlan = "plan" in account ? account.plan : undefined;
        // Claude Code still reports Ultra as `max`; its cached profile fetch
        // names the plan. Either that provider label or an operator
        // declaration upgrades native `max`; legacy `max` alone never does.
        const classifyUltra = async (status: AuthStatus): Promise<boolean> => {
          const nativePlan = status.subscriptionType?.toLowerCase() ?? null;
          return (
            nativePlan === "ultra" ||
            (nativePlan === "max" &&
              profile !== null &&
              (declaredPlan === "ultra" ||
                isUltraDisplayName(
                  (
                    await readProfileState({
                      ...account,
                      auth: profile,
                    })
                  )?.planDisplayName ?? null,
                )))
          );
        };
        let ultraPlan = await classifyUltra(authStatus);
        let observedAt = context.now();
        let httpSucceeded = false;
        let cachedReading = false;
        if (profile !== null && readHttpUsage !== null) {
          const reportFallback = (error: unknown) => {
            // Preserve native quota/refresh behavior if the undocumented HTTP
            // contract changes or is unavailable. Never fabricate partial quota.
            process.stderr.write(
              `${JSON.stringify({ event: "claude-usage-fallback", httpStatus: error instanceof ClaudeUsageHttpError ? (error.status ?? null) : null })}\n`,
            );
          };
          const readUsage = async () => {
            try {
              return await readHttpUsage({
                account: { ...account, auth: profile },
                ultraPlan,
                cliVersion: await version(context.timeoutMilliseconds),
                now: context.now,
                timeoutMilliseconds: context.timeoutMilliseconds,
              });
            } catch (error) {
              return { error };
            }
          };
          let usage = await readUsage();
          // A held identity check can outlive its token: check again, which
          // refreshes the token, and retry once. The check's own errors reach
          // the scan's handler, never the native quota fallback.
          if (
            "error" in usage &&
            reusedIdentity &&
            usage.error instanceof ClaudeUsageHttpError &&
            (usage.error.status === 401 || usage.error.status === 403)
          ) {
            const checked = await checkIdentity();
            if (checked.kind === "failed") return checked.snapshot;
            authStatus = checked.status;
            ultraPlan = await classifyUltra(authStatus);
            usage = await readUsage();
          }
          if ("error" in usage) {
            reportFallback(usage.error);
          } else {
            limits = usage.limits;
            observedAt = new Date(usage.observedAt);
            httpSucceeded = true;
            cachedReading = usage.source === "cache";
          }
        }
        if (readsQuota && !httpSucceeded) {
          const usageArguments = ["--setting-sources", ""];
          if (!(await hasManagedMcpConfig())) {
            usageArguments.push("--strict-mcp-config");
          }
          usageArguments.push("-p", "/usage", "--no-session-persistence");
          const usageResult = await run({
            command,
            args: usageArguments,
            environment,
            cwd: await workDirectory(),
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
            ultraPlan,
          );
        }

        return quotaSuccessSchema.parse({
          accountAlias: account.accountAlias,
          platform: account.platform,
          status: "ok",
          plan: ultraPlan ? "ultra" : (authStatus.subscriptionType ?? null),
          limits,
          observedAt: observedAt.toISOString(),
          ...(cachedReading ? { source: "cache" as const } : {}),
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
        if (error instanceof ClaudeUsageUnavailableError) {
          return createFailureSnapshot(
            account,
            "quota_unavailable",
            "Claude /usage did not supply session or week quota windows; the quota is unknown.",
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
        if (scratch.directory !== null) {
          await rm(scratch.directory, { force: true, recursive: true });
        }
      }
    },
  };
}
