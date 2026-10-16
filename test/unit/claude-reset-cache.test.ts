import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
    const directory = await mkdtemp(
      join(tmpdir(), "seat-monitor-reset-cache-"),
    );
    const filePath = join(directory, "claude-resets.json");
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
      filePath,
      readOffer,
    };
    try {
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

      const persisted = await readFile(filePath, "utf8");
      expect(persisted).toContain("Full reset");
      expect((await stat(filePath)).mode & 0o777).toBe(0o600);
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
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
