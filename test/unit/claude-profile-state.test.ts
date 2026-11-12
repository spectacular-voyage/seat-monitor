import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { LoadedClaudeProfileAccount } from "../../src/config/accounts.js";
import {
  isUltraDisplayName,
  parseClaudeProfileState,
  readClaudeProfileState,
} from "../../src/services/claude-profile-state.js";

// Sanitized shape of a monitor profile's .claude.json, observed 2026-11-12.
function state(overrides: Record<string, unknown> = {}) {
  return {
    numStartups: 3,
    oauthAccount: {
      accountUuid: "synthetic-account",
      emailAddress: "Synthetic@Example.com",
      organizationUuid: "synthetic-organization",
      billingType: "stripe_subscription",
      subscriptionCreatedAt: "2026-08-06T04:04:28.598782Z",
      planDisplayName: "Ultra",
      organizationRateLimitTier: "default_claude_max_20x",
      ...overrides,
    },
  };
}

describe("Claude profile state", () => {
  it("returns plan facts for the pinned identity only", () => {
    expect(parseClaudeProfileState(state(), "synthetic@example.com")).toEqual({
      planDisplayName: "Ultra",
      rateLimitTier: "default_claude_max_20x",
      subscriptionCreatedAt: "2026-08-06T04:04:28.598Z",
    });
    expect(parseClaudeProfileState(state(), "other@example.com")).toBeNull();
    expect(parseClaudeProfileState({}, "synthetic@example.com")).toBeNull();
  });

  it("treats an absent display name as unknown, not Ultra", () => {
    const parsed = parseClaudeProfileState(
      state({ planDisplayName: undefined }),
      "synthetic@example.com",
    );
    expect(parsed?.planDisplayName).toBeNull();
    expect(isUltraDisplayName(parsed?.planDisplayName ?? null)).toBe(false);
    expect(isUltraDisplayName("ultra")).toBe(true);
    expect(isUltraDisplayName("Ultra plan")).toBe(false);
  });

  it("reads the profile file and fails closed when it is missing or malformed", async () => {
    const directory = await mkdtemp(join(tmpdir(), "seat-monitor-state-"));
    const account: LoadedClaudeProfileAccount = {
      accountAlias: "claude-synthetic",
      platform: "Claude",
      auth: {
        type: "claude_profile",
        profile: "synthetic",
        expectedEmail: "synthetic@example.com",
        claudeConfigDir: directory,
      },
    };
    try {
      await expect(readClaudeProfileState(account)).resolves.toBeNull();
      await writeFile(join(directory, ".claude.json"), "{not json");
      await expect(readClaudeProfileState(account)).resolves.toBeNull();
      await writeFile(join(directory, ".claude.json"), JSON.stringify(state()));
      await expect(readClaudeProfileState(account)).resolves.toMatchObject({
        planDisplayName: "Ultra",
      });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
