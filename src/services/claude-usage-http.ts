import { open } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { LoadedClaudeProfileAccount } from "../config/accounts.js";
import type { QuotaLimit } from "../domain/quota.js";
import { ProcessTimeoutError } from "./process.js";

const MAX_RESPONSE_BYTES = 1_000_000;
const credentialsSchema = z.object({
  claudeAiOauth: z.object({ accessToken: z.string().min(1) }),
});
const limitSchema = z.object({
  kind: z.enum(["session", "weekly_all", "weekly_scoped"]),
  group: z.enum(["session", "weekly"]),
  percent: z.number().min(0).max(100).nullable(),
  resets_at: z.iso.datetime({ offset: true }).nullable(),
  scope: z
    .object({
      model: z.object({ display_name: z.string() }).nullable(),
      surface: z.unknown().nullable(),
    })
    .nullable(),
});
const usageSchema = z.object({ limits: z.array(limitSchema).min(1) });

export class ClaudeUsageHttpError extends Error {
  public constructor(public readonly status?: number) {
    super("Claude HTTP quota could not be read.");
    this.name = "ClaudeUsageHttpError";
  }
}

/** Use the provider's normalized limits, not local advice or a scoped share of
 * the weekly total. In particular weekly_scoped_shares is NOT Fable utilization.
 * Unknown layouts fall back to the native CLI instead of guessing a mapping.
 */
export function parseClaudeHttpUsage(
  payload: unknown,
  ultraPlan: boolean,
): QuotaLimit[] {
  const { limits } = usageSchema.parse(payload);
  const mapped = new Map<string, QuotaLimit>();
  for (const limit of limits) {
    let key: string;
    let label: string;
    if (
      limit.kind === "session" &&
      limit.group === "session" &&
      limit.scope === null
    ) {
      key = "base.session";
      label = "Current Session";
    } else if (
      limit.kind === "weekly_all" &&
      limit.group === "weekly" &&
      limit.scope === null
    ) {
      key = "base.weekly";
      label = "Current Week (All Models)";
    } else if (
      limit.kind === "weekly_scoped" &&
      limit.group === "weekly" &&
      limit.scope?.model?.display_name === "Fable" &&
      limit.scope.surface === null
    ) {
      key = "fable.weekly";
      label = "Current Week (Fable)";
    } else {
      throw new ClaudeUsageHttpError();
    }
    if (mapped.has(key)) throw new ClaudeUsageHttpError();
    mapped.set(key, {
      key,
      label,
      scope: "window",
      availability: "available",
      usedPercent: limit.percent,
      windowDurationMinutes: null,
      resetAt:
        limit.resets_at === null
          ? null
          : new Date(limit.resets_at).toISOString(),
    });
  }
  if (![...mapped.values()].some((limit) => limit.usedPercent !== null))
    throw new ClaudeUsageHttpError();
  const verifiedUltra =
    ultraPlan &&
    mapped.size === 2 &&
    ["base.weekly", "fable.weekly"].every((key) => {
      const limit = mapped.get(key);
      return (
        limit?.usedPercent !== null &&
        limit?.usedPercent !== undefined &&
        limit.resetAt !== null
      );
    });
  const session: QuotaLimit = mapped.get("base.session") ?? {
    key: "base.session",
    label: "Current Session",
    scope: "window",
    availability: "available",
    usedPercent: null,
    windowDurationMinutes: null,
    resetAt: null,
    ...(verifiedUltra ? { applicability: "not_applicable" as const } : {}),
  };
  const weekly = mapped.get("base.weekly");
  const fable: QuotaLimit = mapped.get("fable.weekly") ?? {
    key: "fable",
    label: "Fable",
    scope: "model",
    availability: "unsupported",
    usedPercent: null,
    windowDurationMinutes: null,
    resetAt: null,
  };
  return [session, ...(weekly === undefined ? [] : [weekly]), fable];
}

async function readProfileJson(
  directory: string,
  name: string,
): Promise<unknown> {
  const file = await open(join(directory, name), "r");
  try {
    if ((await file.stat()).size > MAX_RESPONSE_BYTES)
      throw new ClaudeUsageHttpError();
    return JSON.parse(await file.readFile("utf8")) as unknown;
  } finally {
    await file.close();
  }
}

async function readAccessToken(directory: string): Promise<string> {
  return credentialsSchema.parse(
    await readProfileJson(directory, ".credentials.json"),
  ).claudeAiOauth.accessToken;
}

const nativeCacheSchema = z.object({
  oauthAccount: z.object({
    accountUuid: z.string().min(1),
    emailAddress: z.email(),
  }),
  cachedUsageUtilization: z.object({
    accountUuid: z.string().min(1),
    fetchedAtMs: z.number().int().nonnegative(),
    utilization: z.unknown(),
  }),
});
export type ClaudeHttpUsage = {
  limits: QuotaLimit[];
  observedAt: string;
  source: "http" | "cache";
};

export function parseClaudeNativeCache(
  payload: unknown,
  account: LoadedClaudeProfileAccount,
  ultraPlan: boolean,
  now: Date,
): ClaudeHttpUsage {
  const { oauthAccount, cachedUsageUtilization: cached } =
    nativeCacheSchema.parse(payload);
  if (
    oauthAccount.emailAddress.toLowerCase() !==
      account.auth.expectedEmail.toLowerCase() ||
    cached.accountUuid !== oauthAccount.accountUuid ||
    cached.fetchedAtMs > now.getTime()
  )
    throw new ClaudeUsageHttpError();
  return {
    limits: parseClaudeHttpUsage(cached.utilization, ultraPlan),
    observedAt: new Date(cached.fetchedAtMs).toISOString(),
    source: "cache",
  };
}

export type ReadClaudeHttpUsage = (options: {
  account: LoadedClaudeProfileAccount;
  ultraPlan: boolean;
  cliVersion: string;
  timeoutMilliseconds: number;
  now: () => Date;
}) => Promise<ClaudeHttpUsage>;

export function createClaudeHttpUsageReader(
  dependencies: {
    fetch?: typeof fetch;
    accessToken?: (directory: string) => Promise<string>;
    nativeCache?: (directory: string) => Promise<unknown>;
  } = {},
): ReadClaudeHttpUsage {
  // Last successful normalized quota only, never unbounded history or bearer data.
  const previous = new Map<string, ClaudeHttpUsage>();
  return async (options) => {
    if (!/^\d+\.\d+\.\d+$/u.test(options.cliVersion))
      throw new ClaudeUsageHttpError();
    const accessToken = await (dependencies.accessToken ?? readAccessToken)(
      options.account.auth.claudeConfigDir,
    );
    const cacheKey = `${options.account.auth.claudeConfigDir}\0${options.account.auth.expectedEmail.toLowerCase()}`;
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      options.timeoutMilliseconds,
    );
    try {
      const response = await (dependencies.fetch ?? fetch)(
        "https://api.anthropic.com/api/oauth/usage?cedar_ember=1&skip_spend=1",
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "anthropic-beta": "oauth-2025-04-20",
            "User-Agent": `claude-cli/${options.cliVersion} (external, cli)`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          redirect: "error",
          signal: controller.signal,
        },
      );
      if (!response.ok) {
        await response.body?.cancel();
        throw new ClaudeUsageHttpError(response.status);
      }
      if (response.body === null) throw new ClaudeUsageHttpError();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      for await (const chunk of response.body) {
        if (!(chunk instanceof Uint8Array)) throw new ClaudeUsageHttpError();
        bytes += chunk.byteLength;
        if (bytes > MAX_RESPONSE_BYTES) {
          controller.abort();
          throw new ClaudeUsageHttpError();
        }
        chunks.push(chunk);
      }
      const result: ClaudeHttpUsage = {
        limits: parseClaudeHttpUsage(
          JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
          options.ultraPlan,
        ),
        observedAt: options.now().toISOString(),
        source: "http",
      };
      previous.delete(cacheKey);
      if (previous.size >= 64) {
        const oldest = previous.keys().next().value;
        if (oldest !== undefined) previous.delete(oldest);
      }
      previous.set(cacheKey, result);
      return result;
    } catch (error) {
      if (
        error instanceof ClaudeUsageHttpError &&
        (error.status === 429 || error.status === 529)
      ) {
        let retained = previous.get(cacheKey);
        try {
          const payload = await (
            dependencies.nativeCache ??
            ((directory: string) => readProfileJson(directory, ".claude.json"))
          )(options.account.auth.claudeConfigDir);
          const native = parseClaudeNativeCache(
            payload,
            options.account,
            options.ultraPlan,
            options.now(),
          );
          if (retained === undefined || native.observedAt > retained.observedAt)
            retained = native;
        } catch {
          /* Missing, malformed, or wrong-identity cache is never used. */
        }
        if (retained !== undefined) {
          process.stderr.write(
            `${JSON.stringify({ event: "claude-usage-cached", httpStatus: error.status, observedAt: retained.observedAt })}\n`,
          );
          return { ...retained, source: "cache" };
        }
      }
      // A rejected bearer must never revive an earlier successful observation.
      if (
        error instanceof ClaudeUsageHttpError &&
        (error.status === 401 || error.status === 403)
      )
        previous.delete(cacheKey);
      if (controller.signal.aborted && !(error instanceof ClaudeUsageHttpError))
        throw new ProcessTimeoutError();
      if (error instanceof ClaudeUsageHttpError) throw error;
      throw new ClaudeUsageHttpError();
    } finally {
      clearTimeout(timer);
    }
  };
}
