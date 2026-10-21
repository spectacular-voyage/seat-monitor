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
      let requestedUrl: string | null = null;
      let requestedHeaders: RequestInit["headers"];
      const fetch = vi.fn(
        (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
          requestedUrl =
            typeof input === "string"
              ? input
              : input instanceof URL
                ? input.href
                : input.url;
          requestedHeaders = init?.headers;
          return Promise.resolve(
            Response.json({
              cedar_ember: {
                eligible: true,
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
          );
        },
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
      expect(requestedUrl).toBe(
        "https://api.anthropic.com/api/oauth/usage?cedar_ember=1",
      );
      expect(new Headers(requestedHeaders).get("User-Agent")).toBe(
        "claude-cli/2.1.296 (external, cli)",
      );
      expect(JSON.stringify(result)).not.toContain("private-token");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("distinguishes HTTP 429 and 529 from a confirmed empty offer list", async () => {
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
      const result = await readClaudeAccountResets(account, {
        fetch: () =>
          Promise.resolve(
            Response.json(
              { error: { type: "rate_limit_error" } },
              { status: 429 },
            ),
          ),
      });
      expect(result).toEqual({
        accountAlias: "Claude_Test",
        status: "rate_limited",
        offers: [],
        httpStatus: 429,
      });
      const overloaded = await readClaudeAccountResets(account, {
        fetch: () =>
          Promise.resolve(
            Response.json(
              { error: { type: "overloaded_error" } },
              { status: 529 },
            ),
          ),
      });
      expect(overloaded).toEqual({
        accountAlias: "Claude_Test",
        status: "overloaded",
        offers: [],
        httpStatus: 529,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not treat an ineligible client response as proof of no offers", async () => {
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
      const result = await readClaudeAccountResets(account, {
        fetch: () =>
          Promise.resolve(
            Response.json({
              cedar_ember: {
                eligible: false,
                ineligible_reason: "surface",
                grants: [],
              },
            }),
          ),
      });
      expect(result).toEqual({
        accountAlias: "Claude_Test",
        status: "unavailable",
        offers: [],
      });
      const missingGrants = await readClaudeAccountResets(account, {
        fetch: () =>
          Promise.resolve(Response.json({ cedar_ember: { eligible: true } })),
      });
      expect(missingGrants.status).toBe("unavailable");
      const emptyGrants = await readClaudeAccountResets(account, {
        fetch: () =>
          Promise.resolve(
            Response.json({ cedar_ember: { eligible: true, grants: [] } }),
          ),
      });
      expect(emptyGrants).toEqual({
        accountAlias: "Claude_Test",
        status: "ok",
        offers: [],
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
