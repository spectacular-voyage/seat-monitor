import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import type { LoadedAccount } from "../../src/config/accounts.js";
import {
  createClaudeProvider,
  managedMcpIsConfigured,
} from "../../src/services/claude.js";
import type { RunCommand } from "../../src/services/process.js";

const account: LoadedAccount = {
  accountAlias: "Claude_Personal",
  platform: "Claude",
  auth: {
    type: "claude_setup_token",
    credentialEnv: "CLAUDE_TOKEN_PERSONAL",
    credential: "test-token",
  },
};

describe("managed MCP detection", () => {
  it.each([
    ["darwin", "/Library/Application Support/ClaudeCode/managed-mcp.json"],
    ["linux", "/etc/claude-code/managed-mcp.json"],
    ["win32", "C:\\Program Files\\ClaudeCode\\managed-mcp.json"],
  ] as const)("checks the documented %s path", async (platform, expected) => {
    let receivedPath: string | undefined;

    const configured = await managedMcpIsConfigured(platform, (filePath) => {
      receivedPath = filePath;
      return Promise.resolve();
    });

    expect(configured).toBe(true);
    expect(receivedPath).toBe(expected);
  });

  it("reports an absent managed MCP file", async () => {
    const configured = await managedMcpIsConfigured("linux", () =>
      Promise.reject(new Error("missing")),
    );

    expect(configured).toBe(false);
  });

  it("skips unsupported platform paths", async () => {
    let checkCalled = false;
    const configured = await managedMcpIsConfigured("aix", () => {
      checkCalled = true;
      return Promise.resolve();
    });

    expect(configured).toBe(false);
    expect(checkCalled).toBe(false);
  });
});

describe("Claude provider", () => {
  it("reports plan and explicit unsupported quota metrics", async () => {
    const fixture = await readFile(
      new URL("../fixtures/claude-auth-status.json", import.meta.url),
      "utf8",
    );
    let callCount = 0;
    let receivedEnvironment: NodeJS.ProcessEnv | undefined;
    const run: RunCommand = (options) => {
      callCount += 1;
      receivedEnvironment = options.environment;
      return Promise.resolve({
        exitCode: 0,
        stdout: fixture,
        stderr: "",
      });
    };
    const provider = createClaudeProvider({ run });

    const snapshot = await provider.scan(account, {
      now: () => new Date("2026-08-26T18:00:00.000Z"),
      timeoutMilliseconds: 8_000,
    });

    expect(snapshot.status).toBe("ok");
    if (snapshot.status !== "ok") {
      throw new TypeError("Expected a successful snapshot.");
    }
    expect(snapshot.plan).toBe("max");
    expect(snapshot.limits).toEqual([
      expect.objectContaining({ key: "base", availability: "unsupported" }),
      expect.objectContaining({ key: "fable", availability: "unsupported" }),
    ]);
    expect(callCount).toBe(1);
    if (receivedEnvironment === undefined) {
      throw new TypeError("Expected the provider command to run.");
    }
    expect(receivedEnvironment.CLAUDE_CODE_OAUTH_TOKEN).toBe("test-token");
    expect(receivedEnvironment.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("redacts nonzero command failures", async () => {
    const run: RunCommand = () =>
      Promise.resolve({
        exitCode: 1,
        stdout: "",
        stderr: "secret-token provider detail",
      });
    const provider = createClaudeProvider({ run });

    const snapshot = await provider.scan(account, {
      now: () => new Date("2026-08-26T18:00:00.000Z"),
      timeoutMilliseconds: 8_000,
    });

    expect(snapshot.status).toBe("error");
    expect(JSON.stringify(snapshot)).not.toContain("secret-token");
  });

  it("reads plan and quota windows from a persistent profile", async () => {
    const authFixture = await readFile(
      new URL("../fixtures/claude-auth-status.json", import.meta.url),
      "utf8",
    );
    const usageFixture = await readFile(
      new URL("../fixtures/claude-usage.txt", import.meta.url),
      "utf8",
    );
    const profileAccount: LoadedAccount = {
      accountAlias: "claude-profile@example.com",
      platform: "Claude",
      auth: {
        type: "claude_profile",
        profile: "profile",
        claudeConfigDir: "/profiles/profile",
      },
    };
    const environments: NodeJS.ProcessEnv[] = [];
    const argumentLists: string[][] = [];
    const run: RunCommand = (options) => {
      environments.push(options.environment);
      argumentLists.push([...options.args]);
      return Promise.resolve({
        exitCode: 0,
        stdout: options.args[0] === "auth" ? authFixture : usageFixture,
        stderr: "",
      });
    };
    const provider = createClaudeProvider({
      run,
      profileIsReady: () => Promise.resolve(true),
      managedMcpIsConfigured: () => Promise.resolve(false),
    });

    const snapshot = await provider.scan(profileAccount, {
      now: () => new Date("2026-08-30T00:30:00.000Z"),
      timeoutMilliseconds: 8_000,
    });

    expect(snapshot.status).toBe("ok");
    if (snapshot.status !== "ok") {
      throw new TypeError("Expected a successful profile snapshot.");
    }
    expect(snapshot.plan).toBe("max");
    expect(snapshot.limits.map((limit) => limit.key)).toEqual([
      "base.session",
      "base.weekly",
      "fable.weekly",
    ]);
    expect(environments).toHaveLength(2);
    expect(environments[0]?.CLAUDE_CONFIG_DIR).toBe("/profiles/profile");
    expect(environments[0]?.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(environments[0]?.DISABLE_TELEMETRY).toBeUndefined();
    expect(argumentLists).toEqual([
      ["auth", "status", "--json"],
      [
        "--setting-sources",
        "",
        "--strict-mcp-config",
        "-p",
        "/usage",
        "--no-session-persistence",
      ],
    ]);
  });

  it("preserves an enterprise-managed MCP configuration", async () => {
    const authFixture = await readFile(
      new URL("../fixtures/claude-auth-status.json", import.meta.url),
      "utf8",
    );
    const usageFixture = await readFile(
      new URL("../fixtures/claude-usage.txt", import.meta.url),
      "utf8",
    );
    const profileAccount: LoadedAccount = {
      accountAlias: "claude-enterprise@example.com",
      platform: "Claude",
      auth: {
        type: "claude_profile",
        profile: "enterprise",
        claudeConfigDir: "/profiles/enterprise",
      },
    };
    const argumentLists: string[][] = [];
    const provider = createClaudeProvider({
      profileIsReady: () => Promise.resolve(true),
      managedMcpIsConfigured: () => Promise.resolve(true),
      run: (options) => {
        argumentLists.push([...options.args]);
        return Promise.resolve({
          exitCode: 0,
          stdout: options.args[0] === "auth" ? authFixture : usageFixture,
          stderr: "",
        });
      },
    });

    const snapshot = await provider.scan(profileAccount, {
      now: () => new Date("2026-09-02T18:00:00.000Z"),
      timeoutMilliseconds: 16_000,
    });

    expect(snapshot.status).toBe("ok");
    expect(argumentLists).toEqual([
      ["auth", "status", "--json"],
      ["--setting-sources", "", "-p", "/usage", "--no-session-persistence"],
    ]);
  });

  it("reports a missing profile without starting Claude", async () => {
    const profileAccount: LoadedAccount = {
      accountAlias: "claude-profile@example.com",
      platform: "Claude",
      auth: {
        type: "claude_profile",
        profile: "profile",
        claudeConfigDir: "/missing/profile",
      },
    };
    let runCalled = false;
    const provider = createClaudeProvider({
      profileIsReady: () => Promise.resolve(false),
      run: () => {
        runCalled = true;
        return Promise.reject(new Error("should not run"));
      },
    });

    const snapshot = await provider.scan(profileAccount, {
      now: () => new Date("2026-08-30T00:30:00.000Z"),
      timeoutMilliseconds: 8_000,
    });
    expect(snapshot.status).toBe("error");
    if (snapshot.status !== "error") {
      throw new TypeError("Expected a profile error.");
    }
    expect(snapshot.error.code).toBe("missing_credential");
    expect(snapshot.error.message).toBe(
      "Claude profile profile is not logged in. Run: seat-monitor-claude-login 'claude-profile@example.com'",
    );
    expect(runCalled).toBe(false);
  });
});
