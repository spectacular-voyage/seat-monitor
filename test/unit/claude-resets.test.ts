import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { LoadedAccount } from "../../src/config/accounts.js";
import { readClaudeAccountResets } from "../../src/services/claude-resets.js";

describe("Claude reset offers", () => {
  it("reports only active unspent offers without exposing credentials", async () => {
    const directory = await mkdtemp(join(tmpdir(), "seat-monitor-resets-"));
    try {
      await writeFile(
        join(directory, ".credentials.json"),
        JSON.stringify({ claudeAiOauth: { accessToken: "private-token" } }),
      );
      const account: LoadedAccount = {
        accountAlias: "Claude_Test",
        platform: "Claude",
        auth: {
          type: "claude_profile",
          profile: "test",
          expectedEmail: "test@example.com",
          claudeConfigDir: directory,
        },
      };
      const fetch = vi.fn(() =>
        Promise.resolve(
          Response.json({
            cedar_ember: {
              grants: [
                {
                  label: "Full reset",
                  resets_left: 2,
                  starts_at: "2026-10-01T00:00:00Z",
                  ends_at: "2026-10-23T07:00:00Z",
                },
                {
                  label: "Expired",
                  resets_left: 1,
                  ends_at: "2026-10-01T00:00:00Z",
                },
                { label: "Used", resets_left: 0 },
              ],
            },
          }),
        ),
      );

      const result = await readClaudeAccountResets(account, {
        fetch,
        now: () => new Date("2026-10-15T20:00:00Z"),
      });

      expect(result).toEqual({
        accountAlias: "Claude_Test",
        status: "ok",
        offers: [
          {
            label: "Full reset",
            count: 2,
            expiresAt: "2026-10-23T07:00:00Z",
          },
        ],
      });
      expect(fetch).toHaveBeenCalledOnce();
      expect(JSON.stringify(result)).not.toContain("private-token");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
