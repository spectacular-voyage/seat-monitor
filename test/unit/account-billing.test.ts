import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { LoadedAccount } from "../../src/config/accounts.js";
import {
  CLAUDE_PROFILE_URL,
  createAccountBillingFetcher,
  parseClaudeProfile,
  parseCodexSubscription,
} from "../../src/services/account-billing.js";
import { PACKAGE_VERSION } from "../../src/version.js";

// Sanitized shapes observed from the live endpoints on 2026-11-12.
function claudeProfile(overrides: Record<string, unknown> = {}) {
  return {
    account: {
      uuid: "synthetic-account",
      email: "Synthetic@Example.com",
      has_claude_max: true,
    },
    organization: {
      uuid: "synthetic-organization",
      name: "Synthetic Organization",
      organization_type: "claude_max",
      billing_type: "stripe_subscription",
      rate_limit_tier: "default_claude_max_20x",
      subscription_status: "active",
      subscription_created_at: "2026-08-06T04:04:28.598782Z",
      plan_display_name: "Ultra",
      plan_display_label: "Ultra plan",
      ...overrides,
    },
  };
}

function codexSubscription(
  overrides: Record<string, unknown> = {},
  entitlement: Record<string, unknown> = {},
) {
  return {
    id: "synthetic-subscription",
    entitlement: {
      subscription_id: "synthetic-subscription",
      has_active_subscription: true,
      subscription_plan: "chatgptpro",
      expires_at: "2026-12-02T13:30:35+00:00",
      renews_at: "2026-12-02T07:30:35+00:00",
      cancels_at: null,
      billing_period: "monthly",
      is_delinquent: false,
      ...entitlement,
    },
    last_active_subscription: {
      subscription_id: "synthetic-subscription",
      will_renew: true,
      cancellation_outcome: null,
    },
    plan_type: "pro",
    is_active: true,
    active_start: null,
    active_until: "2026-12-02T07:30:35Z",
    billing_period: "monthly",
    will_renew: true,
    is_delinquent: false,
    ...overrides,
  };
}

describe("Claude OAuth profile billing", () => {
  it("normalizes plan, tier, status and subscription start without identifiers", () => {
    const billing = parseClaudeProfile(
      claudeProfile(),
      "synthetic@example.com",
    );
    expect(billing).toEqual({
      plan: "max",
      planDisplayName: "Ultra",
      rateLimitTier: "default_claude_max_20x",
      subscriptionStatus: "active",
      billingPeriod: null,
      subscribedAt: "2026-08-06T04:04:28.598Z",
      renewsAt: null,
      endsAt: null,
      willRenew: null,
    });
    expect(JSON.stringify(billing)).not.toContain("synthetic-organization");
  });

  it("keeps Max 5x without a display name", () => {
    expect(
      parseClaudeProfile(
        claudeProfile({
          rate_limit_tier: "default_claude_max_5x",
          plan_display_name: undefined,
        }),
        "synthetic@example.com",
      ),
    ).toMatchObject({
      planDisplayName: null,
      rateLimitTier: "default_claude_max_5x",
    });
  });

  it("refuses a profile authenticated as another account", () => {
    expect(
      parseClaudeProfile(claudeProfile(), "someone-else@example.com"),
    ).toBe("identity_mismatch");
  });

  it("drops malformed optional fields instead of failing the account", () => {
    expect(
      parseClaudeProfile(
        claudeProfile({
          subscription_created_at: "not a date",
          plan_display_name: 7,
        }),
        "synthetic@example.com",
      ),
    ).toMatchObject({ subscribedAt: null, planDisplayName: null });
  });
});

describe("Codex subscription billing", () => {
  it("uses the live renewal instant and renewal flag", () => {
    expect(parseCodexSubscription(codexSubscription())).toEqual({
      plan: "pro",
      planDisplayName: null,
      rateLimitTier: null,
      subscriptionStatus: "active",
      billingPeriod: "monthly",
      subscribedAt: null,
      renewsAt: "2026-12-02T07:30:35.000Z",
      endsAt: null,
      willRenew: true,
    });
  });

  it("reports a scheduled cancellation as an end date", () => {
    expect(
      parseCodexSubscription(
        codexSubscription({}, { cancels_at: "2026-12-02T07:30:35+00:00" }),
      ),
    ).toMatchObject({
      renewsAt: null,
      endsAt: "2026-12-02T07:30:35.000Z",
      willRenew: false,
    });
  });

  it("treats will_renew false as expiring at the period end", () => {
    expect(
      parseCodexSubscription(
        codexSubscription({
          will_renew: false,
          last_active_subscription: { will_renew: false },
        }),
      ),
    ).toMatchObject({
      renewsAt: null,
      endsAt: "2026-12-02T07:30:35.000Z",
      willRenew: false,
    });
  });

  it("falls back to the last active subscription's renewal flag", () => {
    expect(
      parseCodexSubscription(codexSubscription({ will_renew: undefined })),
    ).toMatchObject({ willRenew: true });
  });

  it("reports inactive subscriptions without a renewal", () => {
    expect(
      parseCodexSubscription(
        codexSubscription(
          { is_active: false },
          { has_active_subscription: false },
        ),
      ),
    ).toMatchObject({
      subscriptionStatus: "inactive",
      renewsAt: null,
      endsAt: null,
      willRenew: null,
    });
  });

  it("rejects an unreadable cancellation instead of reporting a renewal", () => {
    expect(() =>
      parseCodexSubscription(
        codexSubscription({}, { cancels_at: "next Tuesday-ish" }),
      ),
    ).toThrow();
    expect(() =>
      parseCodexSubscription(codexSubscription({ entitlement: "corrupt" })),
    ).toThrow();
  });

  it("rejects a response with no recognizable billing facts", () => {
    expect(() => parseCodexSubscription({})).toThrow();
    expect(() =>
      parseClaudeProfile(
        { account: { email: "synthetic@example.com" }, organization: {} },
        "synthetic@example.com",
      ),
    ).toThrow();
  });

  it("reports delinquent subscriptions", () => {
    expect(
      parseCodexSubscription(codexSubscription({ is_delinquent: true })),
    ).toMatchObject({ subscriptionStatus: "delinquent" });
  });
});

describe("account billing fetcher", () => {
  const directories: string[] = [];
  afterEach(async () => {
    await Promise.all(
      directories.map((directory) =>
        rm(directory, { force: true, recursive: true }),
      ),
    );
    directories.length = 0;
  });

  async function profileDirectory(files: Record<string, unknown>) {
    const directory = await mkdtemp(join(tmpdir(), "seat-monitor-billing-"));
    directories.push(directory);
    await mkdir(directory, { recursive: true });
    for (const [name, value] of Object.entries(files)) {
      await writeFile(join(directory, name), JSON.stringify(value));
    }
    return directory;
  }

  function jsonResponse(payload: unknown, status = 200) {
    return new Response(JSON.stringify(payload), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }

  it("reads the Claude profile with the profile's own bearer token", async () => {
    const claudeConfigDir = await profileDirectory({
      ".credentials.json": { claudeAiOauth: { accessToken: "claude-token" } },
    });
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(jsonResponse(claudeProfile())),
    );
    const account: LoadedAccount = {
      accountAlias: "claude-synthetic",
      platform: "Claude",
      auth: {
        type: "claude_profile",
        profile: "synthetic",
        expectedEmail: "synthetic@example.com",
        claudeConfigDir,
      },
    };

    await expect(
      createAccountBillingFetcher({ fetch })(account),
    ).resolves.toMatchObject({
      status: "ok",
      httpStatus: 200,
      billing: { planDisplayName: "Ultra" },
    });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(CLAUDE_PROFILE_URL);
    expect(init?.headers).toMatchObject({
      Authorization: "Bearer claude-token",
      "User-Agent": `seat-monitor/${PACKAGE_VERSION}`,
    });
    expect(init?.redirect).toBe("error");
  });

  it("reads the Codex subscription for the profile's own account", async () => {
    const codexHome = await profileDirectory({
      "auth.json": {
        tokens: {
          access_token: "codex-token",
          account_id: "account-123",
          id_token: "ignored",
          refresh_token: "ignored",
        },
      },
    });
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(jsonResponse(codexSubscription())),
    );
    const account: LoadedAccount = {
      accountAlias: "codex-synthetic",
      platform: "Codex",
      auth: { type: "codex_profile", profile: "synthetic", codexHome },
    };

    await expect(
      createAccountBillingFetcher({ fetch })(account),
    ).resolves.toMatchObject({
      status: "ok",
      billing: { renewsAt: "2026-12-02T07:30:35.000Z", willRenew: true },
    });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(
      "https://chatgpt.com/backend-api/subscriptions?account_id=account-123",
    );
    expect(init?.headers).toMatchObject({
      Authorization: "Bearer codex-token",
      "chatgpt-account-id": "account-123",
    });
  });

  it("distinguishes missing credentials, HTTP errors, bad payloads and network failures", async () => {
    const missing: LoadedAccount = {
      accountAlias: "codex-missing",
      platform: "Codex",
      auth: {
        type: "codex_profile",
        profile: "missing",
        codexHome: join(await profileDirectory({}), "does-not-exist"),
      },
    };
    const never = vi.fn<typeof globalThis.fetch>();
    await expect(
      createAccountBillingFetcher({ fetch: never })(missing),
    ).resolves.toEqual({
      status: "unavailable",
      httpStatus: null,
      reason: "credential_unavailable",
    });
    expect(never).not.toHaveBeenCalled();

    const codexHome = await profileDirectory({
      "auth.json": { tokens: { access_token: "codex-token", account_id: "a" } },
    });
    const account: LoadedAccount = {
      accountAlias: "codex-synthetic",
      platform: "Codex",
      auth: { type: "codex_profile", profile: "synthetic", codexHome },
    };
    const outcomes: [() => Promise<Response>, unknown][] = [
      [
        () => Promise.resolve(jsonResponse({}, 401)),
        { status: "unavailable", httpStatus: 401, reason: "http_error" },
      ],
      [
        () => Promise.resolve(new Response("<html>", { status: 200 })),
        { status: "unavailable", httpStatus: 200, reason: "invalid_response" },
      ],
      [
        () => Promise.resolve(jsonResponse({})),
        { status: "unavailable", httpStatus: 200, reason: "invalid_response" },
      ],
      [
        () => Promise.reject(new TypeError("fetch failed")),
        { status: "unavailable", httpStatus: null, reason: "network_error" },
      ],
    ];
    for (const [respond, expected] of outcomes) {
      await expect(
        createAccountBillingFetcher({ fetch: vi.fn(respond) })(account),
      ).resolves.toEqual(expected);
    }
  });

  it("reports a Claude identity mismatch without billing", async () => {
    const claudeConfigDir = await profileDirectory({
      ".credentials.json": { claudeAiOauth: { accessToken: "claude-token" } },
    });
    const account: LoadedAccount = {
      accountAlias: "claude-synthetic",
      platform: "Claude",
      auth: {
        type: "claude_profile",
        profile: "synthetic",
        expectedEmail: "expected@example.com",
        claudeConfigDir,
      },
    };
    await expect(
      createAccountBillingFetcher({
        fetch: () => Promise.resolve(jsonResponse(claudeProfile())),
      })(account),
    ).resolves.toEqual({
      status: "unavailable",
      httpStatus: 200,
      reason: "identity_mismatch",
    });
  });

  it("makes no request for token-injected accounts", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(
      createAccountBillingFetcher({ fetch })({
        accountAlias: "codex-token",
        platform: "Codex",
        auth: {
          type: "codex_access_token",
          credentialEnv: "CODEX_TOKEN",
          credential: "secret",
        },
      }),
    ).resolves.toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
});
