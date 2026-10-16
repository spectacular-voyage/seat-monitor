import { describe, expect, it } from "vitest";

import type { LoadedAccount } from "../../src/config/accounts.js";
import {
  quotaFailureSchema,
  quotaSuccessSchema,
  type QuotaSnapshot,
} from "../../src/domain/quota.js";
import { createCodexResetReader } from "../../src/services/codex-reset-cache.js";

const account: LoadedAccount = {
  accountAlias: "Codex_Test",
  platform: "Codex",
  auth: {
    type: "codex_profile",
    profile: "test",
    codexHome: "/unused/test-profile",
  },
};

function success(
  observedAt: string,
  resetOffers: { label: string; count: number; expiresAt: string | null }[],
): QuotaSnapshot {
  return quotaSuccessSchema.parse({
    accountAlias: account.accountAlias,
    platform: "Codex",
    status: "ok",
    plan: "pro",
    observedAt,
    resetOffers,
    limits: [
      {
        key: "codex.primary",
        label: "Primary",
        scope: "window",
        availability: "available",
        usedPercent: 25,
        windowDurationMinutes: 300,
        resetAt: null,
      },
    ],
  });
}

describe("Codex reset cache", () => {
  it("retains the last confirmed credits through failed scans and restart", async () => {
    let current = Date.parse("2026-10-15T20:00:00Z");
    let snapshots: QuotaSnapshot[] = [
      success("2026-10-15T20:00:00Z", [
        {
          label: "Full reset",
          count: 1,
          expiresAt: "2026-10-22T16:00:00Z",
        },
      ]),
    ];
    let stored = {};
    const options = {
      accounts: [account],
      snapshots: () => Promise.resolve(snapshots),
      now: () => new Date(current),
      storage: {
        load: () => Promise.resolve(structuredClone(stored)),
        save: (entries: typeof stored) => {
          stored = structuredClone(entries);
          return Promise.resolve();
        },
      },
    };
    const read = createCodexResetReader(options);
    expect(await read()).toEqual([
      {
        accountAlias: account.accountAlias,
        status: "ok",
        lastConfirmedAt: "2026-10-15T20:00:00Z",
        offers: [
          {
            label: "Full reset",
            count: 1,
            expiresAt: "2026-10-22T16:00:00Z",
          },
        ],
      },
    ]);
    snapshots = [
      quotaFailureSchema.parse({
        accountAlias: account.accountAlias,
        platform: "Codex",
        status: "error",
        plan: null,
        observedAt: "2026-10-15T20:01:00Z",
        limits: [],
        error: { code: "network", message: "Temporary failure" },
      }),
    ];
    const afterRestart = createCodexResetReader(options);
    const stale = await afterRestart();
    expect(stale[0]?.status).toBe("unavailable");
    expect(stale[0]?.offers).toHaveLength(1);
    expect(stale[0]?.lastConfirmedAt).toBe("2026-10-15T20:00:00Z");

    current = Date.parse("2026-10-23T00:00:00Z");
    expect((await afterRestart())[0]?.offers).toEqual([]);
    snapshots = [success("2026-10-23T00:00:00Z", [])];
    expect((await afterRestart())[0]).toEqual({
      accountAlias: account.accountAlias,
      status: "ok",
      lastConfirmedAt: "2026-10-23T00:00:00Z",
      offers: [],
    });
  });
});
