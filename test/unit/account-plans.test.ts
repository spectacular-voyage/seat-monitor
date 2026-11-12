import { describe, expect, it, vi } from "vitest";

import type { LoadedAccount } from "../../src/config/accounts.js";
import {
  quotaSuccessSchema,
  type QuotaSnapshot,
} from "../../src/domain/quota.js";
import type {
  BillingFetchResult,
  ProviderBilling,
} from "../../src/services/account-billing.js";
import {
  BILLING_CHECK_INTERVAL_MILLISECONDS,
  BILLING_RATE_LIMITED_RETRY_MILLISECONDS,
  BILLING_RETRY_MILLISECONDS,
  claudeTierLabel,
  createAccountPlanReader,
  nextDeclaredBillingDate,
  nextMonthlyAnniversary,
  resolveRenewal,
  type AccountBillingStore,
} from "../../src/services/account-plans.js";

const timeZone = "America/Los_Angeles";
const now = Date.parse("2026-11-12T18:00:00.000Z");

const claude: LoadedAccount = {
  accountAlias: "claude-ultra",
  platform: "Claude",
  auth: {
    type: "claude_profile",
    profile: "ultra",
    expectedEmail: "ultra@example.com",
    claudeConfigDir: "/synthetic-claude-ultra",
  },
};
const codex: LoadedAccount = {
  accountAlias: "codex-pro",
  platform: "Codex",
  auth: {
    type: "codex_profile",
    profile: "pro",
    codexHome: "/synthetic-codex-pro",
  },
};
const tokenAccount: LoadedAccount = {
  accountAlias: "codex-token",
  platform: "Codex",
  auth: {
    type: "codex_access_token",
    credentialEnv: "CODEX_TOKEN",
    credential: undefined,
  },
};

function billing(overrides: Partial<ProviderBilling> = {}): ProviderBilling {
  return {
    plan: null,
    planDisplayName: null,
    rateLimitTier: null,
    subscriptionStatus: "active",
    billingPeriod: null,
    subscribedAt: null,
    renewsAt: null,
    endsAt: null,
    willRenew: null,
    ...overrides,
  };
}

type StoredEntries = Awaited<ReturnType<AccountBillingStore["load"]>>;

function memoryStore(): AccountBillingStore & { entries: StoredEntries } {
  const store: AccountBillingStore & { entries: StoredEntries } = {
    entries: {},
    load: () => Promise.resolve(store.entries),
    save: (entries) => {
      store.entries = structuredClone(entries);
      return Promise.resolve();
    },
  };
  return store;
}

function ok(value: ProviderBilling): BillingFetchResult {
  return { status: "ok", billing: value, httpStatus: 200 };
}

describe("Claude tier labels", () => {
  it.each([
    [
      {
        plan: "max",
        planDisplayName: "Ultra",
        rateLimitTier: "default_claude_max_20x",
      },
      "Ultra",
    ],
    [
      {
        plan: "max",
        planDisplayName: null,
        rateLimitTier: "default_claude_max_5x",
      },
      "Max 5x",
    ],
    [
      {
        plan: "max",
        planDisplayName: "Max",
        rateLimitTier: "default_claude_max_5x",
      },
      "Max 5x",
    ],
    [
      {
        plan: "max",
        planDisplayName: null,
        rateLimitTier: "default_claude_max_20x",
      },
      "Max 20x",
    ],
    [
      {
        plan: "ultra",
        planDisplayName: null,
        rateLimitTier: "default_claude_max_5x",
      },
      "Ultra",
    ],
    [{ plan: "max", planDisplayName: null, rateLimitTier: null }, "Max"],
    [{ plan: "pro", planDisplayName: null, rateLimitTier: null }, "Pro"],
    [{ plan: null, planDisplayName: null, rateLimitTier: null }, null],
  ] as const)("labels %o as %s", (input, expected) => {
    expect(claudeTierLabel(input)).toBe(expected);
  });
});

describe("billing date arithmetic", () => {
  it("finds the next monthly anniversary strictly after now", () => {
    const anchor = Date.parse("2026-08-13T02:05:19.809Z");
    expect(
      new Date(
        nextMonthlyAnniversary(anchor, Date.parse("2026-11-12T18:00:00Z")),
      ).toISOString(),
    ).toBe("2026-11-13T02:05:19.809Z");
    expect(
      new Date(
        nextMonthlyAnniversary(anchor, Date.parse("2026-11-13T02:05:19.809Z")),
      ).toISOString(),
    ).toBe("2026-12-13T02:05:19.809Z");
  });

  it("clamps month-end anchors without drifting", () => {
    const anchor = Date.parse("2026-01-31T12:00:00Z");
    expect(
      new Date(
        nextMonthlyAnniversary(anchor, Date.parse("2026-02-10T00:00:00Z")),
      ).toISOString(),
    ).toBe("2026-02-28T12:00:00.000Z");
    expect(
      new Date(
        nextMonthlyAnniversary(anchor, Date.parse("2026-03-01T00:00:00Z")),
      ).toISOString(),
    ).toBe("2026-03-31T12:00:00.000Z");
  });

  it("rolls a multi-year-old anchor forward", () => {
    expect(
      new Date(
        nextMonthlyAnniversary(
          Date.parse("2024-06-13T15:38:53Z"),
          Date.parse("2026-11-12T18:00:00Z"),
        ),
      ).toISOString(),
    ).toBe("2026-11-13T15:38:53.000Z");
  });

  it("chooses today, later this month, or next month for a declared day", () => {
    expect(nextDeclaredBillingDate(12, now, timeZone)).toBe("2026-11-12");
    expect(nextDeclaredBillingDate(20, now, timeZone)).toBe("2026-11-20");
    expect(nextDeclaredBillingDate(3, now, timeZone)).toBe("2026-12-03");
    expect(
      nextDeclaredBillingDate(31, Date.parse("2027-02-10T18:00:00Z"), timeZone),
    ).toBe("2027-02-28");
    expect(
      nextDeclaredBillingDate(31, Date.parse("2026-12-31T20:00:00Z"), timeZone),
    ).toBe("2026-12-31");
  });

  it("uses the server time zone's calendar day", () => {
    // 02:00 UTC on Nov 13 is still Nov 12 in Los Angeles.
    expect(
      nextDeclaredBillingDate(13, Date.parse("2026-11-13T02:00:00Z"), timeZone),
    ).toBe("2026-11-13");
    expect(
      nextDeclaredBillingDate(12, Date.parse("2026-11-13T02:00:00Z"), timeZone),
    ).toBe("2026-11-12");
  });
});

describe("renewal precedence", () => {
  const base = { nowMilliseconds: now, timeZone };

  it("presents a future provider renewal as the provider's local date", () => {
    expect(
      resolveRenewal({
        ...base,
        account: { ...codex, billing: { renewalDay: 3, autoRenew: false } },
        billing: billing({
          renewsAt: "2026-12-02T07:30:35.000Z",
          willRenew: true,
          billingPeriod: "monthly",
        }),
        subscribedAt: null,
      }),
    ).toEqual({
      date: "2026-12-01",
      at: "2026-12-02T07:30:35.000Z",
      dateSource: "provider",
      autoRenew: true,
      autoRenewSource: "provider",
    });
  });

  it("presents a provider cancellation as the end date", () => {
    expect(
      resolveRenewal({
        ...base,
        account: codex,
        billing: billing({
          renewsAt: "2026-12-02T07:30:35.000Z",
          endsAt: "2026-11-20T07:30:35.000Z",
          willRenew: false,
        }),
        subscribedAt: null,
      }),
    ).toMatchObject({
      date: "2026-11-19",
      autoRenew: false,
      dateSource: "provider",
    });
  });

  it("prefers a declared day over a Claude estimate, and declares auto-renewal", () => {
    expect(
      resolveRenewal({
        ...base,
        account: { ...claude, billing: { renewalDay: 20, autoRenew: false } },
        billing: billing({ subscribedAt: "2026-08-06T04:04:28.598Z" }),
        subscribedAt: "2026-08-06T04:04:28.598Z",
      }),
    ).toEqual({
      date: "2026-11-20",
      at: null,
      dateSource: "declared",
      autoRenew: false,
      autoRenewSource: "declared",
    });
  });

  it("estimates Claude renewal from the subscription start", () => {
    expect(
      resolveRenewal({
        ...base,
        account: claude,
        billing: billing({ subscribedAt: "2026-08-06T04:04:28.598Z" }),
        subscribedAt: "2026-08-06T04:04:28.598Z",
      }),
    ).toEqual({
      date: "2026-12-05",
      at: null,
      dateSource: "estimated",
      autoRenew: null,
      autoRenewSource: null,
    });
  });

  it("never presents a past provider date; it rolls forward as an estimate", () => {
    expect(
      resolveRenewal({
        ...base,
        account: codex,
        billing: billing({
          renewsAt: "2026-10-16T21:27:19.000Z",
          billingPeriod: "monthly",
        }),
        subscribedAt: null,
      }),
    ).toMatchObject({ date: "2026-11-16", at: null, dateSource: "estimated" });
  });

  it("does not estimate annual, inactive, or anchorless subscriptions", () => {
    for (const value of [
      billing({
        renewsAt: "2026-10-16T21:27:19.000Z",
        billingPeriod: "yearly",
      }),
      billing({
        subscribedAt: "2026-08-06T04:04:28.598Z",
        subscriptionStatus: "inactive",
      }),
      billing(),
    ]) {
      expect(
        resolveRenewal({
          ...base,
          account: codex,
          billing: value,
          subscribedAt: value.subscribedAt,
        }).date,
      ).toBeNull();
    }
  });
});

describe("account plan reader", () => {
  function snapshot(account: LoadedAccount, plan: string): QuotaSnapshot {
    return quotaSuccessSchema.parse({
      accountAlias: account.accountAlias,
      platform: account.platform,
      status: "ok",
      plan,
      limits: [
        {
          key: "base.weekly",
          label: "Current Week (All Models)",
          scope: "window",
          availability: "available",
          usedPercent: 10,
          windowDurationMinutes: null,
          resetAt: "2026-11-15T17:00:00.000Z",
        },
      ],
      observedAt: "2026-11-12T17:59:00.000Z",
    });
  }

  it("shows local tiers immediately, then provider billing after one background check", async () => {
    const storage = memoryStore();
    let clock = now;
    const fetchBilling = vi.fn((account: LoadedAccount) =>
      Promise.resolve(
        account.platform === "Claude"
          ? ok(
              billing({
                plan: "max",
                planDisplayName: "Ultra",
                rateLimitTier: "default_claude_max_20x",
                subscribedAt: "2026-08-06T04:04:28.598Z",
              }),
            )
          : ok(
              billing({
                plan: "pro",
                renewsAt: "2026-12-02T07:30:35.000Z",
                willRenew: true,
                billingPeriod: "monthly",
              }),
            ),
      ),
    );
    const sleep = vi.fn(() => Promise.resolve());
    const reader = createAccountPlanReader({
      accounts: [claude, codex, tokenAccount],
      snapshots: () => [snapshot(claude, "max"), snapshot(codex, "pro")],
      now: () => new Date(clock),
      timeZone,
      storage,
      fetchBilling,
      sleep,
      readProfileState: () =>
        Promise.resolve({
          planDisplayName: "Ultra",
          rateLimitTier: "default_claude_max_20x",
          subscriptionCreatedAt: null,
        }),
    });

    const first = await reader.read();
    expect(first.accounts.map((account) => account.tier)).toEqual([
      "Ultra",
      "Pro",
      null,
    ]);
    expect(
      first.accounts.map((account) => account.billingCheck.status),
    ).toEqual(["pending", "pending", "unsupported"]);
    await reader.refreshDue();
    expect(fetchBilling).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledOnce();

    const second = await reader.read();
    expect(second.accounts[0]).toMatchObject({
      tier: "Ultra",
      tierSource: "provider",
      scan: { status: "ok", observedAt: "2026-11-12T17:59:00.000Z" },
      renewal: { date: "2026-12-05", dateSource: "estimated", autoRenew: null },
      billingCheck: { status: "ok", checkedAt: "2026-11-12T18:00:00.000Z" },
    });
    expect(second.accounts[1]).toMatchObject({
      tier: "Pro",
      billingPeriod: "monthly",
      renewal: { date: "2026-12-01", dateSource: "provider", autoRenew: true },
    });
    expect(second.accounts[2]).toMatchObject({
      scan: { status: "pending" },
      billingCheck: { status: "unsupported" },
    });
    expect(JSON.stringify(storage.entries)).not.toContain("token");

    // Within the check interval, a read makes no provider request.
    clock += BILLING_CHECK_INTERVAL_MILLISECONDS - 1;
    await reader.read();
    await reader.refreshDue();
    expect(fetchBilling).toHaveBeenCalledTimes(2);
    clock += 1;
    await reader.read();
    await reader.refreshDue();
    expect(fetchBilling).toHaveBeenCalledTimes(4);
  });

  it("keeps the last confirmed billing through failures and backs off", async () => {
    const storage = memoryStore();
    let clock = now;
    const fetchBilling = vi
      .fn<(account: LoadedAccount) => Promise<BillingFetchResult>>()
      .mockResolvedValueOnce(
        ok(billing({ renewsAt: "2026-12-02T07:30:35.000Z", willRenew: true })),
      )
      .mockResolvedValue({
        status: "unavailable",
        httpStatus: 429,
        reason: "http_error",
      });
    const reader = createAccountPlanReader({
      accounts: [codex],
      snapshots: () => null,
      now: () => new Date(clock),
      timeZone,
      storage,
      fetchBilling,
    });
    await reader.refreshDue();
    clock += BILLING_CHECK_INTERVAL_MILLISECONDS;
    await reader.refreshDue();
    const result = await reader.read();
    expect(result.accounts[0]).toMatchObject({
      renewal: { autoRenew: true },
      billingCheck: {
        status: "unavailable",
        httpStatus: 429,
        checkedAt: "2026-11-12T18:00:00.000Z",
      },
    });
    clock += BILLING_RETRY_MILLISECONDS;
    await reader.refreshDue();
    expect(fetchBilling).toHaveBeenCalledTimes(2);
    clock +=
      BILLING_RATE_LIMITED_RETRY_MILLISECONDS - BILLING_RETRY_MILLISECONDS;
    await reader.refreshDue();
    expect(fetchBilling).toHaveBeenCalledTimes(3);
  });

  it("never shows another identity's billing", async () => {
    const storage = memoryStore();
    const fetchBilling = vi
      .fn<(account: LoadedAccount) => Promise<BillingFetchResult>>()
      .mockResolvedValueOnce(ok(billing({ planDisplayName: "Ultra" })))
      .mockResolvedValue({
        status: "unavailable",
        httpStatus: 200,
        reason: "identity_mismatch",
      });
    let clock = now;
    const options = {
      snapshots: () => null,
      now: () => new Date(clock),
      timeZone,
      storage,
      fetchBilling,
      readProfileState: () => Promise.resolve(null),
    };
    await createAccountPlanReader({
      ...options,
      accounts: [claude],
    }).refreshDue();

    // The alias now points at a different pinned identity.
    const reseated: LoadedAccount = {
      ...claude,
      auth: { ...claude.auth, expectedEmail: "other@example.com" } as never,
    };
    const reader = createAccountPlanReader({
      ...options,
      accounts: [reseated],
    });
    expect((await reader.read()).accounts[0]).toMatchObject({
      tier: null,
      billingCheck: { status: "pending" },
    });

    // An identity mismatch drops retained facts for the same identity too.
    clock += BILLING_CHECK_INTERVAL_MILLISECONDS;
    const original = createAccountPlanReader({
      ...options,
      accounts: [claude],
    });
    await original.refreshDue();
    expect((await original.read()).accounts[0]).toMatchObject({
      tier: null,
      billingCheck: { status: "unavailable" },
    });
  });

  it("marks a declared Ultra plan as declared when the provider does not name it", async () => {
    const declared: LoadedAccount = { ...claude, plan: "ultra" };
    const reader = createAccountPlanReader({
      accounts: [declared],
      snapshots: () => [snapshot(declared, "ultra")],
      now: () => new Date(now),
      timeZone,
      storage: memoryStore(),
      fetchBilling: () => Promise.resolve(null),
      readProfileState: () => Promise.resolve(null),
    });
    expect((await reader.read()).accounts[0]).toMatchObject({
      plan: "ultra",
      tier: "Ultra",
      tierSource: "declared",
    });
  });

  it("reports failed scans with their error code", async () => {
    const reader = createAccountPlanReader({
      accounts: [codex],
      snapshots: () => [
        {
          accountAlias: codex.accountAlias,
          platform: "Codex",
          status: "error",
          plan: null,
          limits: [],
          observedAt: "2026-11-12T17:59:00.000Z",
          error: {
            code: "unauthorized",
            message: "Codex could not authenticate.",
          },
        },
      ],
      now: () => new Date(now),
      timeZone,
      storage: memoryStore(),
      fetchBilling: () => Promise.resolve(null),
    });
    expect((await reader.read()).accounts[0]?.scan).toEqual({
      status: "error",
      errorCode: "unauthorized",
      observedAt: "2026-11-12T17:59:00.000Z",
    });
  });
});
