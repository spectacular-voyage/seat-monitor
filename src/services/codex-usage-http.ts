import { z } from "zod";

import type { CodexAppServerResult } from "./codex-app-server.js";
import {
  codexRequestHeaders,
  readCodexTokens,
  requestJson,
  type CodexTokens,
} from "./provider-http.js";

/**
 * Codex quota read straight from the endpoints the Codex App Server itself
 * calls. Starting `codex app-server` against a profile opens that profile's
 * whole thread-state database (tens to hundreds of MB, indexed from its session
 * transcripts) before it answers, so a per-scan launch costs far more disk I/O
 * than the two small HTTP reads it wraps.
 */
export const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
export const CODEX_RESET_CREDITS_URL =
  "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";

export type CodexUsageHttpFailure =
  | "credential_unavailable"
  | "http_error"
  | "invalid_response"
  | "network_error";

export class CodexUsageHttpError extends Error {
  public readonly reason: CodexUsageHttpFailure;
  public readonly status: number | null;

  public constructor(reason: CodexUsageHttpFailure, status: number | null) {
    super("Codex HTTP quota could not be read.");
    this.name = "CodexUsageHttpError";
    this.reason = reason;
    this.status = status;
  }
}

const windowSchema = z.object({
  used_percent: z.number().min(0).max(100),
  limit_window_seconds: z.number().positive().nullable().optional(),
  reset_at: z.number().int().nonnegative().nullable().optional(),
});

const rateLimitSchema = z.object({
  primary_window: windowSchema.nullable().optional(),
  secondary_window: windowSchema.nullable().optional(),
});

// `rate_limit` must be present (null is a real "no quota" answer); a payload
// without it is an unknown layout and must fall back to the App Server.
const usageSchema = z.object({
  plan_type: z.string().min(1).nullable().optional(),
  rate_limit: rateLimitSchema.nullable(),
  additional_rate_limits: z
    .array(
      z.object({
        limit_name: z.string().min(1).nullable().optional(),
        metered_feature: z.string().min(1),
        rate_limit: rateLimitSchema.nullable(),
      }),
    )
    .nullable()
    .optional(),
  rate_limit_reset_credits: z
    .object({ available_count: z.number().int().nonnegative() })
    .nullable()
    .optional(),
});

const resetCreditsSchema = z.object({
  available_count: z.number().int().nonnegative(),
  credits: z.array(
    z.object({
      status: z.string(),
      title: z.string().nullable().optional(),
      expires_at: z.iso.datetime({ offset: true }).nullable().optional(),
    }),
  ),
});

type CodexUsage = z.infer<typeof usageSchema>;
type RateLimit = z.infer<typeof rateLimitSchema>;
type RateWindow = z.infer<typeof windowSchema>;

function appServerWindow(window: RateWindow | null | undefined) {
  if (window === null || window === undefined) return null;
  return {
    usedPercent: window.used_percent,
    windowDurationMins:
      window.limit_window_seconds === null ||
      window.limit_window_seconds === undefined
        ? null
        : window.limit_window_seconds / 60,
    resetsAt: window.reset_at ?? null,
  };
}

function appServerBucket(
  limitId: string,
  limitName: string | null,
  planType: string | null,
  rateLimit: RateLimit,
) {
  return {
    limitId,
    limitName,
    planType,
    primary: appServerWindow(rateLimit.primary_window),
    secondary: appServerWindow(rateLimit.secondary_window),
  };
}

function appServerResetCredits(usage: CodexUsage, creditsPayload: unknown) {
  if (
    usage.rate_limit_reset_credits === null ||
    usage.rate_limit_reset_credits === undefined
  ) {
    return undefined;
  }
  const listed = resetCreditsSchema.safeParse(creditsPayload);
  if (!listed.success) {
    // Count only: offers keep their number without titles or expiry.
    return {
      availableCount: usage.rate_limit_reset_credits.available_count,
      credits: null,
    };
  }
  return {
    availableCount: listed.data.available_count,
    credits: listed.data.credits.map((credit) => ({
      status: credit.status,
      title: credit.title ?? null,
      expiresAt:
        credit.expires_at === null || credit.expires_at === undefined
          ? null
          : Math.floor(Date.parse(credit.expires_at) / 1_000),
    })),
  };
}

function toAppServerResult(
  usage: CodexUsage,
  creditsPayload: unknown,
): CodexAppServerResult {
  // Mirror the App Server: the main window is limit "codex"; each additional
  // limit is keyed by its metered feature (e.g. codex_bengalfox for Spark).
  const planType = usage.plan_type ?? null;
  const buckets: Record<string, ReturnType<typeof appServerBucket>> = {};
  if (usage.rate_limit !== null) {
    buckets.codex = appServerBucket("codex", null, planType, usage.rate_limit);
  }
  for (const extra of usage.additional_rate_limits ?? []) {
    if (extra.rate_limit === null || extra.metered_feature in buckets) continue;
    buckets[extra.metered_feature] = appServerBucket(
      extra.metered_feature,
      extra.limit_name ?? null,
      planType,
      extra.rate_limit,
    );
  }
  const resetCredits = appServerResetCredits(usage, creditsPayload);
  return {
    accountResult: { account: { planType } },
    rateLimitsResult: {
      rateLimitsByLimitId: buckets,
      ...(resetCredits === undefined
        ? {}
        : { rateLimitResetCredits: resetCredits }),
    },
  };
}

/** Converts the HTTP payloads to the App Server result the normalizer reads. */
export function codexHttpUsageToAppServerResult(
  usagePayload: unknown,
  creditsPayload: unknown,
): CodexAppServerResult {
  return toAppServerResult(usageSchema.parse(usagePayload), creditsPayload);
}

export type ReadCodexHttpUsage = (options: {
  codexHome: string;
  timeoutMilliseconds: number;
}) => Promise<CodexAppServerResult>;

export function createCodexHttpUsageReader(
  dependencies: { fetch?: typeof fetch } = {},
): ReadCodexHttpUsage {
  const fetchImplementation = dependencies.fetch ?? fetch;
  return async ({ codexHome, timeoutMilliseconds }) => {
    let tokens: CodexTokens;
    try {
      tokens = await readCodexTokens(codexHome);
    } catch {
      throw new CodexUsageHttpError("credential_unavailable", null);
    }
    const headers = codexRequestHeaders(tokens);
    const response = await requestJson(
      fetchImplementation,
      CODEX_USAGE_URL,
      headers,
      timeoutMilliseconds,
    );
    if (response.kind !== "ok") {
      throw new CodexUsageHttpError(
        response.kind,
        response.kind === "network_error" ? null : response.status,
      );
    }
    const usage = usageSchema.safeParse(response.payload);
    if (!usage.success) {
      throw new CodexUsageHttpError("invalid_response", response.status);
    }
    // The usage payload only counts reset credits; their titles and expiry
    // need the list, which is skipped when there is nothing to list.
    let creditsPayload: unknown = null;
    if ((usage.data.rate_limit_reset_credits?.available_count ?? 0) > 0) {
      const credits = await requestJson(
        fetchImplementation,
        CODEX_RESET_CREDITS_URL,
        headers,
        timeoutMilliseconds,
      );
      if (credits.kind === "ok") creditsPayload = credits.payload;
    }
    return toAppServerResult(usage.data, creditsPayload);
  };
}
