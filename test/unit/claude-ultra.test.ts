import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  accountDefinitionSchema,
  loadAccounts,
  type LoadedClaudeProfileAccount,
} from "../../src/config/accounts.js";
import { quotaLimitSchema } from "../../src/domain/quota.js";
import { parseClaudeUsageOutput } from "../../src/services/claude-usage.js";
import { createClaudeProvider } from "../../src/services/claude.js";

const usage = readFileSync(
  new URL("../fixtures/claude-usage-ultra.txt", import.meta.url),
  "utf8",
);
const limitedUsage = readFileSync(
  new URL("../fixtures/claude-usage.txt", import.meta.url),
  "utf8",
);
const now = Date.parse("2026-08-30T00:30:00.000Z");
const account: LoadedClaudeProfileAccount = {
  accountAlias: "claude-synthetic@example.com",
  platform: "Claude",
  auth: {
    type: "claude_profile",
    profile: "synthetic",
    expectedEmail: "synthetic@example.com",
    claudeConfigDir: "/synthetic-profile-never-read",
  },
};

async function scan(
  nativePlan: string | null,
  declared = false,
  output = usage,
  exitCode = 0,
) {
  const provider = createClaudeProvider({
    readHttpUsage: null,
    profileIsReady: () => Promise.resolve(true),
    managedMcpIsConfigured: () => Promise.resolve(false),
    run: ({ args }) =>
      Promise.resolve({
        exitCode: args[0] === "auth" ? 0 : exitCode,
        stdout:
          args[0] === "auth"
            ? JSON.stringify({
                loggedIn: true,
                email: "synthetic@example.com",
                subscriptionType: nativePlan,
                authMethod: "oauth_token",
                apiProvider: "firstParty",
              })
            : output,
        stderr: "",
      }),
  });
  return provider.scan(
    { ...account, ...(declared ? { plan: "ultra" as const } : {}) },
    {
      now: () => new Date(now),
      timeoutMilliseconds: 8000,
    },
  );
}

function expectNA(output = usage) {
  const limits = parseClaudeUsageOutput(output, now, true);
  expect(limits[0]).toMatchObject({
    key: "base.session",
    applicability: "not_applicable",
    usedPercent: null,
    resetAt: null,
    windowDurationMinutes: null,
  });
  expect(limits.slice(1)).toMatchObject([
    {
      key: "base.weekly",
      usedPercent: 76,
      resetAt: "2026-09-03T17:00:00.000Z",
    },
    {
      key: "fable.weekly",
      usedPercent: 2,
      resetAt: "2026-09-03T17:00:00.000Z",
    },
  ]);
  return limits;
}

describe("verified Ultra applicability", () => {
  it.each([
    ["ultra", false],
    ["max", true],
  ] as const)(
    "accepts native %s with declaration=%s and a complete reading",
    async (plan, declared) => {
      const snapshot = await scan(plan, declared);
      expect(snapshot).toMatchObject({
        status: "ok",
        plan: "ultra",
        limits: expectNA(),
      });
    },
  );

  it.each([
    ["max", false],
    ["pro", true],
    [null, true],
    ["unknown", true],
  ] as const)(
    "keeps native %s with declaration=%s unknown",
    async (plan, declared) => {
      expectNA();
      const snapshot = await scan(plan, declared);
      expect(snapshot.status).toBe("ok");
      expect(snapshot.limits[0]).toMatchObject({
        key: "base.session",
        usedPercent: null,
        resetAt: null,
      });
      expect(snapshot.limits[0]).not.toHaveProperty("applicability");
      expect(snapshot.plan).not.toBe("ultra");
    },
  );

  it.each([
    ["truncated footer", usage.split("What's contributing")[0] ?? ""],
    ["missing header", usage.replace(/You are currently[^\n]+/u, "")],
    ["missing Fable", usage.replace(/^Current week \(Fable\):.*\n/mu, "")],
    [
      "missing weekly",
      usage.replace(/^Current week \(all models\):.*\n/mu, ""),
    ],
    [
      "missing reset",
      usage.replace(
        "76% used · resets Sep 3, 10am (America/Los_Angeles)",
        "76% used",
      ),
    ],
    ["malformed session", `Current session: unreadable\n${usage}`],
    ["extra window", `${usage}\nCurrent month: unreadable`],
    ["duplicate weekly", `${usage}\nCurrent week (all models): 1% used`],
    ["embedded error", `${usage}\nError: usage fetch failed`],
  ])(
    "refuses N/A for %s while the paired complete report passes",
    (_name, incomplete) => {
      expectNA();
      expect(
        parseClaudeUsageOutput(incomplete, now, true)[0],
      ).not.toHaveProperty("applicability");
    },
  );

  it("keeps session-bearing Ultra and limited plans limited", async () => {
    expectNA();
    for (const [plan, declared] of [
      ["ultra", false],
      ["max", true],
      ["max", false],
      ["pro", false],
    ] as const) {
      const result = await scan(plan, declared, limitedUsage);
      expect(result.limits[0]).toMatchObject({
        key: "base.session",
        usedPercent: 8,
        resetAt: "2026-08-30T02:40:00.000Z",
      });
      expect(result.limits[0]).not.toHaveProperty("applicability");
    }
  });

  it("never makes failed, empty or invalid-reset output N/A", async () => {
    expectNA();
    for (const [output, exitCode] of [
      [usage, 1],
      ["", 0],
      [
        usage.replaceAll("Sep 3, 10am (America/Los_Angeles)", "invalid reset"),
        0,
      ],
    ] as const) {
      const result = await scan("ultra", false, output, exitCode);
      expect(result.status).toBe("error");
      expect(result.limits).toEqual([]);
    }
  });

  it("loads only an explicit profile declaration without inspecting a profile", () => {
    const definition = {
      accountAlias: account.accountAlias,
      platform: "Claude" as const,
      plan: "ultra" as const,
      auth: {
        type: "claude_profile" as const,
        profile: "synthetic",
        expectedEmail: "synthetic@example.com",
      },
    };
    expect(accountDefinitionSchema.parse(definition)).toHaveProperty(
      "plan",
      "ultra",
    );
    expect(
      loadAccounts(
        [definition],
        {},
        "/synthetic-codex",
        "/synthetic-claude",
      )[0],
    ).toHaveProperty("plan", "ultra");
    expect(
      accountDefinitionSchema.safeParse({ ...definition, plan: "max" }).success,
    ).toBe(false);
  });

  it("rejects numeric, resetting or non-session N/A values", () => {
    const session = expectNA()[0];
    for (const invalid of [
      { usedPercent: 0 },
      { resetAt: "2026-09-03T17:00:00.000Z" },
      { windowDurationMinutes: 300 },
      { key: "base.weekly" },
    ]) {
      expect(
        quotaLimitSchema.safeParse({ ...session, ...invalid }).success,
      ).toBe(false);
    }
  });
});
