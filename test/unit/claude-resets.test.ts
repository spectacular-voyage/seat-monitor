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
        "https://api.anthropic.com/api/oauth/usage?cedar_ember=1&skip_spend=1",
      );
      expect(new Headers(requestedHeaders).get("User-Agent")).toBe(
        "claude-cli/2.1.296 (external, cli)",
      );
      expect(new Headers(requestedHeaders).get("Content-Type")).toBe(
        "application/json",
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
        httpStatus: 200,
        reason: "surface",
        ineligibleReason: "surface",
      });
      for (const [reportedReason, retainedReason] of [
        ["not_enrolled", "not_enrolled"],
        [null, null],
        ["private response with an email@example.com", null],
      ]) {
        const ineligible = await readClaudeAccountResets(account, {
          fetch: () =>
            Promise.resolve(
              Response.json({
                cedar_ember: {
                  eligible: false,
                  ineligible_reason: reportedReason,
                  grants: [],
                },
              }),
            ),
        });
        expect(ineligible).toMatchObject({
          status: "unavailable",
          reason: "ineligible",
          ineligibleReason: retainedReason,
        });
        expect(JSON.stringify(ineligible)).not.toContain("email@example.com");
      }
      const noGrant = await readClaudeAccountResets(account, {
        fetch: () =>
          Promise.resolve(
            Response.json({
              cedar_ember: {
                eligible: false,
                ineligible_reason: "no_grant",
                grants: [],
              },
            }),
          ),
      });
      expect(noGrant).toEqual({
        accountAlias: "Claude_Test",
        status: "ok",
        httpStatus: 200,
        ineligibleReason: "no_grant",
        offers: [],
      });
      const contradictory = await readClaudeAccountResets(account, {
        fetch: () =>
          Promise.resolve(
            Response.json({
              cedar_ember: {
                eligible: false,
                ineligible_reason: "no_grant",
                grants: [{ resets_left: 1 }],
              },
            }),
          ),
      });
      expect(contradictory).toMatchObject({
        status: "unavailable",
        reason: "ineligible",
        ineligibleReason: "no_grant",
      });
      const missingGrants = await readClaudeAccountResets(account, {
        fetch: () =>
          Promise.resolve(Response.json({ cedar_ember: { eligible: true } })),
      });
      expect(missingGrants.status).toBe("unavailable");
      expect(missingGrants.reason).toBe("invalid_response");
      const missingBlock = await readClaudeAccountResets(account, {
        fetch: () => Promise.resolve(Response.json({ cedar_ember: null })),
      });
      expect(missingBlock.reason).toBe("missing_reset_block");
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
      const networkError = await readClaudeAccountResets(account, {
        fetch: () => Promise.reject(new Error("private provider response")),
      });
      expect(networkError).toEqual({
        accountAlias: "Claude_Test",
        status: "unavailable",
        offers: [],
        reason: "network_error",
      });
      const serverError = await readClaudeAccountResets(account, {
        fetch: () => Promise.resolve(new Response(null, { status: 503 })),
      });
      expect(serverError).toMatchObject({
        status: "unavailable",
        httpStatus: 503,
      });
      await writeFile(
        join(directory, ".credentials.json"),
        "invalid credentials",
      );
      const credentialError = await readClaudeAccountResets(account);
      expect(credentialError.reason).toBe("credential_unavailable");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not request offers for a setup-token account", async () => {
    const setupAccount: LoadedAccount = {
      accountAlias: "Claude_Setup",
      platform: "Claude",
      auth: {
        type: "claude_setup_token",
        credentialEnv: "CLAUDE_TOKEN",
        credential: "token",
      },
    };
    const fetch = vi.fn();
    expect(await readClaudeAccountResets(setupAccount, { fetch })).toEqual({
      accountAlias: "Claude_Setup",
      status: "unavailable",
      offers: [],
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});
