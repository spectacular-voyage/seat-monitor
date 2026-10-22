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

  it("quiets one account for 15 minutes before its single probe", async () => {
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
    let current = Date.parse("2026-10-15T20:00:00Z");
    let stored = {};
    const changes: (string | null)[] = [];
    const readOffer = vi.fn((candidate: LoadedAccount) =>
      Promise.resolve({
        accountAlias: candidate.accountAlias,
        status: "rate_limited" as const,
        httpStatus: 429,
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
      quietProbeAccountAlias: account.accountAlias,
      onQuietAccountChange: (alias) => changes.push(alias),
    });

    const initial = await read();
    expect(initial.map((item) => item.status)).toEqual(["pending", "pending"]);
    expect(initial[0]?.quietUntil).toBe("2026-10-15T20:15:00.000Z");
    expect(changes).toEqual([account.accountAlias]);
    current += 14 * 60_000;
    await read();
    expect(readOffer).not.toHaveBeenCalled();
    current += 60_000;
    const result = await read();
    expect(readOffer).toHaveBeenCalledOnce();
    expect(readOffer.mock.calls[0]?.[0].accountAlias).toBe(
      account.accountAlias,
    );
    expect(result[0]).toMatchObject({
      status: "rate_limited",
      httpStatus: 429,
    });
    expect(changes).toEqual([account.accountAlias, null]);
    current += 60_000;
    await read();
    expect(readOffer).toHaveBeenCalledOnce();
  });

  it("runs the quiet probe when its timer elapses without another dashboard read", async () => {
    vi.useFakeTimers();
    try {
      let current = Date.parse("2026-10-15T20:00:00Z");
      const readOffer = vi.fn(() =>
        Promise.resolve({
          accountAlias: account.accountAlias,
          status: "unavailable" as const,
          reason: "surface" as const,
          offers: [],
        }),
      );
      let stored = {};
      const read = createClaudeResetReader({
        accounts: [account],
        verifiedAliases: () => Promise.resolve(new Set([account.accountAlias])),
        now: () => new Date(current),
        storage: {
          load: () => Promise.resolve(structuredClone(stored)),
          save: (entries: typeof stored) => {
            stored = structuredClone(entries);
            return Promise.resolve();
          },
        },
        readOffer,
        quietProbeAccountAlias: account.accountAlias,
      });
      await read();
      current += 15 * 60_000;
      await vi.advanceTimersByTimeAsync(15 * 60_000);
      expect(readOffer).toHaveBeenCalledOnce();
      expect((await read())[0]).toMatchObject({
        status: "unavailable",
        reason: "surface",
        lastConfirmedAt: null,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-arms an early timer so the quiet account always resumes", async () => {
    vi.useFakeTimers();
    try {
      const startedAt = Date.parse("2026-10-15T20:00:00Z");
      let current = startedAt;
      const changes: (string | null)[] = [];
      const readOffer = vi.fn(() =>
        Promise.resolve({
          accountAlias: account.accountAlias,
          status: "ok" as const,
          offers: [],
        }),
      );
      const read = createClaudeResetReader({
        accounts: [account],
        verifiedAliases: () => Promise.resolve(new Set([account.accountAlias])),
        now: () => new Date(current),
        storage: {
          load: () => Promise.resolve({}),
          save: () => Promise.resolve(),
        },
        readOffer,
        quietProbeAccountAlias: account.accountAlias,
        onQuietAccountChange: (alias) => changes.push(alias),
      });
      await read();
      current = startedAt + 15 * 60_000 - 1;
      await vi.advanceTimersByTimeAsync(15 * 60_000);
      expect(readOffer).not.toHaveBeenCalled();
      current += 1;
      await vi.advanceTimersByTimeAsync(1);
      expect(readOffer).toHaveBeenCalledOnce();
      expect(changes).toEqual([account.accountAlias, null]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels the pause if the account is no longer verified", async () => {
    let verified = true;
    const changes: (string | null)[] = [];
    const readOffer = vi.fn();
    const read = createClaudeResetReader({
      accounts: [account],
      verifiedAliases: () =>
        Promise.resolve(new Set(verified ? [account.accountAlias] : [])),
      now: () => new Date("2026-10-15T20:00:00Z"),
      storage: {
        load: () => Promise.resolve({}),
        save: () => Promise.resolve(),
      },
      readOffer,
      quietProbeAccountAlias: account.accountAlias,
      onQuietAccountChange: (alias) => changes.push(alias),
    });
    await read();
    verified = false;
    expect((await read())[0]).toMatchObject({
      status: "unavailable",
      lastConfirmedAt: null,
    });
    expect(changes).toEqual([account.accountAlias, null]);
    expect(readOffer).not.toHaveBeenCalled();
  });

  it("rejects a quiet target that is not a configured Claude profile", () => {
    expect(() =>
      createClaudeResetReader({
        accounts: [account],
        verifiedAliases: () => Promise.resolve(new Set()),
        quietProbeAccountAlias: "Missing",
      }),
    ).toThrow("not configured");
  });
});
