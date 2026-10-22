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

    current = Date.parse("2026-10-15T21:19:00Z");
    expect(await afterRestart()).toEqual(stale);
    expect(readOffer).toHaveBeenCalledTimes(2);

    current += 60_000;
    const cleared = await afterRestart();
    expect(cleared[0]).toEqual({
      accountAlias: account.accountAlias,
      status: "ok",
      lastConfirmedAt: "2026-10-15T21:20:00.000Z",
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

  it("slows to one probe per hour after a rate limit", async () => {
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
    const third: LoadedAccount = {
      ...account,
      accountAlias: "Claude_Third",
      auth: {
        type: "claude_profile",
        profile: "third",
        expectedEmail: "third@example.com",
        claudeConfigDir: "/unused/third-profile",
      },
    };
    const initial = Date.parse("2026-10-15T20:00:00Z");
    let current = initial;
    let stored = {};
    let secondReads = 0;
    const readOffer = vi.fn((candidate: LoadedAccount) => {
      if (candidate.accountAlias === second.accountAlias) secondReads += 1;
      return Promise.resolve(
        candidate.accountAlias === second.accountAlias && secondReads === 1
          ? {
              accountAlias: candidate.accountAlias,
              status: "overloaded" as const,
              offers: [],
              httpStatus: 529,
            }
          : {
              accountAlias: candidate.accountAlias,
              status: "ok" as const,
              offers: [],
            },
      );
    });
    const options = {
      accounts: [account, second, third],
      verifiedAliases: () =>
        Promise.resolve(
          new Set([
            account.accountAlias,
            second.accountAlias,
            third.accountAlias,
          ]),
        ),
      now: () => new Date(current),
      storage: {
        load: () => Promise.resolve(structuredClone(stored)),
        save: (entries: typeof stored) => {
          stored = structuredClone(entries);
          return Promise.resolve();
        },
      },
      readOffer,
    };
    const read = createClaudeResetReader(options);
    await read();
    current = initial + 60_000;
    expect((await read())[1]).toEqual({
      accountAlias: second.accountAlias,
      status: "overloaded",
      httpStatus: 529,
      offers: [],
      lastConfirmedAt: null,
    });
    expect(readOffer).toHaveBeenCalledTimes(2);

    const afterRestart = createClaudeResetReader(options);
    current = initial + 60 * 60_000;
    expect((await afterRestart())[2]?.status).toBe("pending");
    expect(readOffer).toHaveBeenCalledTimes(2);

    current = initial + 61 * 60_000;
    expect((await afterRestart())[2]?.status).toBe("ok");
    expect(readOffer.mock.calls[2]?.[0].accountAlias).toBe(third.accountAlias);

    current = initial + 120 * 60_000;
    await afterRestart();
    expect(readOffer).toHaveBeenCalledTimes(3);

    current = initial + 121 * 60_000;
    expect((await afterRestart())[0]?.status).toBe("ok");
    expect(readOffer.mock.calls[3]?.[0].accountAlias).toBe(
      account.accountAlias,
    );

    current = initial + 181 * 60_000;
    await afterRestart();
    expect(readOffer.mock.calls[4]?.[0].accountAlias).toBe(second.accountAlias);
  });

  it("revisits confirmed accounts while another account stays rate limited", async () => {
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
    const initial = Date.parse("2026-10-15T20:00:00Z");
    let current = initial;
    let stored = {};
    const readOffer = vi.fn((candidate: LoadedAccount) =>
      Promise.resolve({
        accountAlias: candidate.accountAlias,
        status:
          candidate.accountAlias === account.accountAlias
            ? ("ok" as const)
            : ("rate_limited" as const),
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

    await read();
    current += 60_000;
    await read();
    current += 60 * 60_000;
    await read();

    expect(
      readOffer.mock.calls.map(([candidate]) => candidate.accountAlias),
    ).toEqual([
      account.accountAlias,
      second.accountAlias,
      account.accountAlias,
    ]);
  });
});
