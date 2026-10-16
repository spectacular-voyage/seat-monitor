import { describe, expect, it, vi } from "vitest";

import type { LoadedAccount } from "../../src/config/accounts.js";
import { createClaudeResetReader } from "../../src/services/claude-reset-cache.js";
import type { ClaudeAccountResets } from "../../src/services/claude-resets.js";

const account: LoadedAccount = {
  accountAlias: "Claude_Test",
  platform: "Claude",
  auth: {
    type: "claude_profile",
    profile: "test",
    expectedEmail: "test@example.com",
    claudeConfigDir: "/unused/test-profile",
  },
};

describe("Claude reset cache", () => {
  it("checks once per 20 minutes and retains confirmed offers after a failed read and restart", async () => {
    let stored = {};
    const storage = {
      load: () => Promise.resolve(structuredClone(stored)),
      save: (entries: typeof stored) => {
        stored = structuredClone(entries);
        return Promise.resolve();
      },
    };
    let current = Date.parse("2026-10-15T20:00:00Z");
    const responses: ClaudeAccountResets[] = [
      {
        accountAlias: account.accountAlias,
        status: "ok",
        offers: [
          {
            label: "Full reset",
            count: 1,
            expiresAt: "2026-10-20T00:00:00Z",
          },
        ],
      },
      {
        accountAlias: account.accountAlias,
        status: "rate_limited",
        offers: [],
      },
      { accountAlias: account.accountAlias, status: "ok", offers: [] },
    ];
    const readOffer = vi.fn(() => Promise.resolve(responses.shift()!));
    const options = {
      accounts: [account],
      verifiedAliases: () => Promise.resolve(new Set([account.accountAlias])),
      now: () => new Date(current),
      storage,
      readOffer,
    };
    const read = createClaudeResetReader(options);
    const first = await read();
    expect(first[0]).toEqual({
      accountAlias: account.accountAlias,
      status: "ok",
      lastConfirmedAt: "2026-10-15T20:00:00.000Z",
      offers: [
        {
          label: "Full reset",
          count: 1,
          expiresAt: "2026-10-20T00:00:00Z",
        },
      ],
    });
    current += 19 * 60_000;
    expect(await read()).toEqual(first);
    expect(readOffer).toHaveBeenCalledTimes(1);

    current += 60_000;
    const stale = await read();
    expect(stale[0]).toEqual({ ...first[0], status: "rate_limited" });
    expect(readOffer).toHaveBeenCalledTimes(2);

    expect(JSON.stringify(stored)).toContain("Full reset");
    const afterRestart = createClaudeResetReader(options);
    current += 19 * 60_000;
    expect(await afterRestart()).toEqual(stale);
    expect(readOffer).toHaveBeenCalledTimes(2);

    current += 60_000;
    const cleared = await afterRestart();
    expect(cleared[0]).toEqual({
      accountAlias: account.accountAlias,
      status: "ok",
      lastConfirmedAt: "2026-10-15T20:40:00.000Z",
      offers: [],
    });
    expect(readOffer).toHaveBeenCalledTimes(3);
  });

  it("staggered checks never send a fleet burst or recheck an account early", async () => {
    const second: LoadedAccount = {
      ...account,
      accountAlias: "Claude_Second",
      auth: {
        type: "claude_profile",
        profile: "second",
        expectedEmail: "second@example.com",
        claudeConfigDir: "/unused/second-profile",
      },
    };
    let stored = {};
    let current = Date.parse("2026-10-15T20:00:00Z");
    const readOffer = vi.fn((candidate: LoadedAccount) =>
      Promise.resolve({
        accountAlias: candidate.accountAlias,
        status: "ok" as const,
        offers: [],
      }),
    );
    const read = createClaudeResetReader({
      accounts: [account, second],
      verifiedAliases: () =>
        Promise.resolve(new Set([account.accountAlias, second.accountAlias])),
      now: () => new Date(current),
      storage: {
        load: () => Promise.resolve(structuredClone(stored)),
        save: (entries: typeof stored) => {
          stored = structuredClone(entries);
          return Promise.resolve();
        },
      },
      readOffer,
    });

    const first = await read();
    expect(first.map((item) => item.status)).toEqual(["ok", "pending"]);
    expect(readOffer).toHaveBeenCalledTimes(1);
    expect(readOffer.mock.calls[0]?.[0].accountAlias).toBe(
      account.accountAlias,
    );

    current += 59_000;
    expect((await read()).map((item) => item.status)).toEqual([
      "ok",
      "pending",
    ]);
    expect(readOffer).toHaveBeenCalledTimes(1);

    current += 1_000;
    expect((await read()).map((item) => item.status)).toEqual(["ok", "ok"]);
    expect(readOffer).toHaveBeenCalledTimes(2);
    expect(readOffer.mock.calls[1]?.[0].accountAlias).toBe(second.accountAlias);

    current += 19 * 60_000;
    await read();
    expect(readOffer).toHaveBeenCalledTimes(3);
    expect(readOffer.mock.calls[2]?.[0].accountAlias).toBe(
      account.accountAlias,
    );
  });
});
