import { open } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import type {
  LoadedAccount,
  LoadedClaudeProfileAccount,
  LoadedCodexProfileAccount,
} from "../config/accounts.js";
import { PACKAGE_VERSION } from "../version.js";

const MAX_BYTES = 1_000_000;
const REQUEST_TIMEOUT_MILLISECONDS = 10_000;
const USER_AGENT = `seat-monitor/${PACKAGE_VERSION}`;

export const CLAUDE_PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";
export const CODEX_SUBSCRIPTIONS_URL =
  "https://chatgpt.com/backend-api/subscriptions";

/** Normalized, non-secret subscription facts. Never identifiers or tokens. */
export type ProviderBilling = {
  plan: string | null;
  planDisplayName: string | null;
  rateLimitTier: string | null;
  subscriptionStatus: string | null;
  billingPeriod: string | null;
  subscribedAt: string | null;
  renewsAt: string | null;
  // A scheduled end: cancellation, or a subscription that will not renew.
  endsAt: string | null;
  willRenew: boolean | null;
};

export type BillingFetchResult =
  | { status: "ok"; billing: ProviderBilling; httpStatus: number }
  | {
      status: "unavailable";
      httpStatus: number | null;
      reason:
        | "credential_unavailable"
        | "identity_mismatch"
        | "http_error"
        | "invalid_response"
        | "network_error";
    };

export type FetchAccountBilling = (
  account: LoadedAccount,
) => Promise<BillingFetchResult | null>;

const shortText = z.string().trim().min(1).max(64);
const optionalText = shortText.nullable().optional().catch(null);
const optionalBoolean = z.boolean().nullable().optional().catch(null);
const instant = z
  .string()
  .max(64)
  .refine((value) => Number.isFinite(Date.parse(value)))
  .transform((value) => new Date(Date.parse(value)).toISOString());
const optionalInstant = instant.nullable().optional().catch(null);

class NoBillingFactsError extends TypeError {
  public constructor() {
    super("The provider response carried no recognizable billing facts.");
    this.name = "NoBillingFactsError";
  }
}

const claudeProfileSchema = z.object({
  account: z.object({ email: z.email() }),
  organization: z.object({
    organization_type: optionalText,
    rate_limit_tier: optionalText,
    subscription_status: optionalText,
    subscription_created_at: optionalInstant,
    plan_display_name: optionalText,
  }),
});

/** Anthropic's OAuth profile. It names the plan and subscription status, but
 * carries no renewal date or cancellation state. */
export function parseClaudeProfile(
  payload: unknown,
  expectedEmail: string,
): ProviderBilling | "identity_mismatch" {
  const { account, organization } = claudeProfileSchema.parse(payload);
  if (account.email.toLowerCase() !== expectedEmail.toLowerCase()) {
    return "identity_mismatch";
  }
  const organizationType = organization.organization_type ?? null;
  const billing = {
    plan:
      organizationType === null
        ? null
        : organizationType.replace(/^claude_/u, ""),
    planDisplayName: organization.plan_display_name ?? null,
    rateLimitTier: organization.rate_limit_tier ?? null,
    subscriptionStatus: organization.subscription_status ?? null,
  };
  // An empty organization must not replace previously confirmed facts.
  if (Object.values(billing).every((value) => value === null)) {
    throw new NoBillingFactsError();
  }
  return {
    ...billing,
    billingPeriod: null,
    subscribedAt: organization.subscription_created_at ?? null,
    renewsAt: null,
    endsAt: null,
    willRenew: null,
  };
}

const codexSubscriptionSchema = z.object({
  plan_type: optionalText,
  is_active: optionalBoolean,
  active_start: optionalInstant,
  active_until: optionalInstant,
  will_renew: optionalBoolean,
  billing_period: optionalText,
  is_delinquent: optionalBoolean,
  entitlement: z
    .object({
      has_active_subscription: optionalBoolean,
      renews_at: optionalInstant,
      // Strict: an unreadable cancellation must fail the response, never
      // fall through to a reported renewal.
      cancels_at: instant.nullable().optional(),
      billing_period: optionalText,
      is_delinquent: optionalBoolean,
    })
    .nullable()
    .optional(),
  last_active_subscription: z
    .object({ will_renew: optionalBoolean })
    .nullable()
    .optional()
    .catch(null),
});

/** ChatGPT's subscription record for the token's own account. Its live
 * `renews_at`/`active_until` replace the id_token claim, which never rolls
 * forward after the original sign-in. */
export function parseCodexSubscription(payload: unknown): ProviderBilling {
  const subscription = codexSubscriptionSchema.parse(payload);
  const entitlement = subscription.entitlement ?? null;
  const cancelsAt = entitlement?.cancels_at ?? null;
  const reportedRenewal =
    subscription.will_renew ??
    subscription.last_active_subscription?.will_renew ??
    null;
  const willRenew = cancelsAt === null ? reportedRenewal : false;
  const periodEnd = entitlement?.renews_at ?? subscription.active_until ?? null;
  const active =
    entitlement?.has_active_subscription ?? subscription.is_active ?? null;
  const delinquent =
    (subscription.is_delinquent ?? entitlement?.is_delinquent) === true;
  if (
    (subscription.plan_type ?? null) === null &&
    active === null &&
    periodEnd === null &&
    reportedRenewal === null
  ) {
    throw new NoBillingFactsError();
  }
  return {
    plan: subscription.plan_type ?? null,
    planDisplayName: null,
    rateLimitTier: null,
    subscriptionStatus:
      active === false
        ? "inactive"
        : delinquent
          ? "delinquent"
          : active === true
            ? "active"
            : null,
    billingPeriod:
      entitlement?.billing_period ?? subscription.billing_period ?? null,
    subscribedAt: subscription.active_start ?? null,
    renewsAt: active === false || willRenew === false ? null : periodEnd,
    endsAt:
      active === false
        ? null
        : (cancelsAt ?? (willRenew === false ? periodEnd : null)),
    willRenew: active === false ? null : willRenew,
  };
}

async function readJsonFile(path: string): Promise<unknown> {
  const file = await open(path, "r");
  try {
    if ((await file.stat()).size > MAX_BYTES) {
      throw new RangeError("Profile file is too large.");
    }
    return JSON.parse(await file.readFile("utf8")) as unknown;
  } finally {
    await file.close();
  }
}

type JsonResponse =
  | { kind: "ok"; status: number; payload: unknown }
  | { kind: "http_error"; status: number }
  | { kind: "invalid_response"; status: number }
  | { kind: "network_error" };

async function requestJson(
  fetchImplementation: typeof fetch,
  url: string,
  headers: Record<string, string>,
): Promise<JsonResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, REQUEST_TIMEOUT_MILLISECONDS);
  try {
    const response = await fetchImplementation(url, {
      headers: {
        ...headers,
        Accept: "application/json",
        "User-Agent": USER_AGENT,
      },
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      return { kind: "http_error", status: response.status };
    }
    if (response.body === null) {
      return { kind: "invalid_response", status: response.status };
    }
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for await (const chunk of response.body) {
      if (!(chunk instanceof Uint8Array)) {
        return { kind: "invalid_response", status: response.status };
      }
      bytes += chunk.byteLength;
      if (bytes > MAX_BYTES) {
        controller.abort();
        return { kind: "invalid_response", status: response.status };
      }
      chunks.push(chunk);
    }
    try {
      return {
        kind: "ok",
        status: response.status,
        payload: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
      };
    } catch {
      return { kind: "invalid_response", status: response.status };
    }
  } catch {
    return { kind: "network_error" };
  } finally {
    clearTimeout(timer);
  }
}

function failure(response: Exclude<JsonResponse, { kind: "ok" }>) {
  return {
    status: "unavailable" as const,
    httpStatus: response.kind === "network_error" ? null : response.status,
    reason: response.kind,
  };
}

const claudeCredentialsSchema = z.object({
  claudeAiOauth: z.object({ accessToken: z.string().min(1).max(16_384) }),
});

async function fetchClaudeBilling(
  account: LoadedClaudeProfileAccount,
  fetchImplementation: typeof fetch,
): Promise<BillingFetchResult> {
  let accessToken: string;
  try {
    accessToken = claudeCredentialsSchema.parse(
      await readJsonFile(
        join(account.auth.claudeConfigDir, ".credentials.json"),
      ),
    ).claudeAiOauth.accessToken;
  } catch {
    return {
      status: "unavailable",
      httpStatus: null,
      reason: "credential_unavailable",
    };
  }
  const response = await requestJson(fetchImplementation, CLAUDE_PROFILE_URL, {
    Authorization: `Bearer ${accessToken}`,
    "anthropic-beta": "oauth-2025-04-20",
  });
  if (response.kind !== "ok") return failure(response);
  try {
    const billing = parseClaudeProfile(
      response.payload,
      account.auth.expectedEmail,
    );
    return billing === "identity_mismatch"
      ? {
          status: "unavailable",
          httpStatus: response.status,
          reason: "identity_mismatch",
        }
      : { status: "ok", billing, httpStatus: response.status };
  } catch {
    return {
      status: "unavailable",
      httpStatus: response.status,
      reason: "invalid_response",
    };
  }
}

const codexAuthSchema = z.object({
  tokens: z.object({
    access_token: z.string().min(1).max(16_384),
    account_id: z.string().min(1).max(256),
  }),
});

async function fetchCodexBilling(
  account: LoadedCodexProfileAccount,
  fetchImplementation: typeof fetch,
): Promise<BillingFetchResult> {
  let tokens: z.infer<typeof codexAuthSchema>["tokens"];
  try {
    tokens = codexAuthSchema.parse(
      await readJsonFile(join(account.auth.codexHome, "auth.json")),
    ).tokens;
  } catch {
    return {
      status: "unavailable",
      httpStatus: null,
      reason: "credential_unavailable",
    };
  }
  const url = new URL(CODEX_SUBSCRIPTIONS_URL);
  url.searchParams.set("account_id", tokens.account_id);
  const response = await requestJson(fetchImplementation, url.toString(), {
    Authorization: `Bearer ${tokens.access_token}`,
    "chatgpt-account-id": tokens.account_id,
  });
  if (response.kind !== "ok") return failure(response);
  try {
    return {
      status: "ok",
      billing: parseCodexSubscription(response.payload),
      httpStatus: response.status,
    };
  } catch {
    return {
      status: "unavailable",
      httpStatus: response.status,
      reason: "invalid_response",
    };
  }
}

/** Reads billing for persistent profiles; null for token-injected accounts. */
export function createAccountBillingFetcher(
  dependencies: { fetch?: typeof fetch } = {},
): FetchAccountBilling {
  const fetchImplementation = dependencies.fetch ?? fetch;
  return async (account) => {
    if (account.auth.type === "claude_profile") {
      return fetchClaudeBilling(
        { ...account, platform: "Claude", auth: account.auth },
        fetchImplementation,
      );
    }
    if (account.auth.type === "codex_profile") {
      return fetchCodexBilling(
        { ...account, platform: "Codex", auth: account.auth },
        fetchImplementation,
      );
    }
    return null;
  };
}
