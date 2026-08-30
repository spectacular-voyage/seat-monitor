import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  AccountConfigurationError,
  defaultAccountsConfigPath,
  loadAccounts,
  readAccountDefinitions,
  type AccountDefinition,
} from "../../src/config/accounts.js";

describe("account configuration file", () => {
  it("loads strict JSON account definitions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "seat-monitor-config-"));
    const filePath = join(directory, "accounts.json");
    await writeFile(
      filePath,
      JSON.stringify({
        accounts: [
          {
            accountAlias: "claude-user@example.com",
            platform: "Claude",
            auth: { type: "claude_profile", profile: "claude-user" },
          },
        ],
      }),
    );

    try {
      expect(readAccountDefinitions(filePath)).toEqual([
        expect.objectContaining({
          accountAlias: "claude-user@example.com",
          enabled: true,
        }),
      ]);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("rejects missing and malformed configuration files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "seat-monitor-config-"));
    const malformedPath = join(directory, "malformed.json");
    await writeFile(malformedPath, "{not-json");

    try {
      expect(() =>
        readAccountDefinitions(join(directory, "missing.json")),
      ).toThrow(AccountConfigurationError);
      expect(() => readAccountDefinitions(malformedPath)).toThrow(
        AccountConfigurationError,
      );
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("uses an absolute explicit path or the standard user config path", () => {
    expect(
      defaultAccountsConfigPath(
        { SEAT_MONITOR_CONFIG: "/config/accounts.json" },
        "/home/user",
      ),
    ).toBe("/config/accounts.json");
    expect(defaultAccountsConfigPath({}, "/home/user")).toBe(
      "/home/user/.config/seat-monitor/accounts.json",
    );
    expect(() =>
      defaultAccountsConfigPath(
        { SEAT_MONITOR_CONFIG: "relative.json" },
        "/home/user",
      ),
    ).toThrow(AccountConfigurationError);
  });
});

describe("loadAccounts", () => {
  it("resolves Claude credentials from the declared environment key", () => {
    const definitions: AccountDefinition[] = [
      {
        accountAlias: "Claude_Work",
        platform: "Claude",
        auth: {
          type: "claude_setup_token",
          credentialEnv: "CLAUDE_TOKEN_WORK",
        },
      },
    ];

    expect(
      loadAccounts(definitions, { CLAUDE_TOKEN_WORK: "secret" }, "/profiles"),
    ).toEqual([
      {
        accountAlias: "Claude_Work",
        platform: "Claude",
        auth: {
          type: "claude_setup_token",
          credentialEnv: "CLAUDE_TOKEN_WORK",
          credential: "secret",
        },
      },
    ]);
  });

  it("resolves Codex profile names below the configured profile root", () => {
    const definitions: AccountDefinition[] = [
      {
        accountAlias: "codex-user@example.com",
        platform: "Codex",
        auth: { type: "codex_profile", profile: "user-example" },
      },
    ];

    expect(loadAccounts(definitions, {}, "/profiles")).toEqual([
      {
        accountAlias: "codex-user@example.com",
        platform: "Codex",
        auth: {
          type: "codex_profile",
          profile: "user-example",
          codexHome: "/profiles/user-example",
        },
      },
    ]);
  });

  it("resolves Claude profile names below the configured profile root", () => {
    const definitions: AccountDefinition[] = [
      {
        accountAlias: "claude-user@example.com",
        platform: "Claude",
        auth: { type: "claude_profile", profile: "user-example" },
      },
    ];

    expect(loadAccounts(definitions, {}, "/codex", "/claude")).toEqual([
      {
        accountAlias: "claude-user@example.com",
        platform: "Claude",
        auth: {
          type: "claude_profile",
          profile: "user-example",
          claudeConfigDir: "/claude/user-example",
        },
      },
    ]);
  });

  it("retains access-token mode for managed Codex workspaces", () => {
    const definitions: AccountDefinition[] = [
      {
        accountAlias: "Codex_Business",
        platform: "Codex",
        auth: {
          type: "codex_access_token",
          credentialEnv: "CODEX_TOKEN_WORK",
        },
      },
    ];

    const [account] = loadAccounts(
      definitions,
      { CODEX_TOKEN_WORK: "secret" },
      "/profiles",
    );
    expect(account?.auth).toEqual({
      type: "codex_access_token",
      credentialEnv: "CODEX_TOKEN_WORK",
      credential: "secret",
    });
  });

  it("accepts email-style account aliases", () => {
    expect(
      loadAccounts(
        [
          {
            accountAlias: "claude-user@example.com",
            platform: "Claude",
            auth: {
              type: "claude_setup_token",
              credentialEnv: "CLAUDE_USER",
            },
          },
        ],
        { CLAUDE_USER: "secret" },
        "/profiles",
      ),
    ).toHaveLength(1);
  });

  it("filters disabled accounts before duplicate validation", () => {
    const definitions: AccountDefinition[] = [
      {
        accountAlias: "Same",
        platform: "Claude",
        auth: {
          type: "claude_setup_token",
          credentialEnv: "CLAUDE_ONE",
        },
        enabled: true,
      },
      {
        accountAlias: "same",
        platform: "Claude",
        auth: {
          type: "claude_setup_token",
          credentialEnv: "CLAUDE_TWO",
        },
        enabled: false,
      },
    ];

    expect(loadAccounts(definitions, {}, "/profiles")).toHaveLength(1);
  });

  it("rejects duplicate enabled aliases case-insensitively", () => {
    const definitions: AccountDefinition[] = [
      {
        accountAlias: "Same",
        platform: "Claude",
        auth: {
          type: "claude_setup_token",
          credentialEnv: "CLAUDE_ONE",
        },
      },
      {
        accountAlias: "same",
        platform: "Codex",
        auth: { type: "codex_profile", profile: "same" },
      },
    ];

    expect(() => loadAccounts(definitions, {}, "/profiles")).toThrow(
      AccountConfigurationError,
    );
  });

  it("rejects invalid environment variable names", () => {
    expect(() =>
      loadAccounts(
        [
          {
            accountAlias: "Account",
            platform: "Claude",
            auth: {
              type: "claude_setup_token",
              credentialEnv: "not-valid",
            },
          },
        ],
        {},
        "/profiles",
      ),
    ).toThrow(AccountConfigurationError);
  });

  it("rejects relative profile roots", () => {
    expect(() =>
      loadAccounts(
        [
          {
            accountAlias: "Codex",
            platform: "Codex",
            auth: { type: "codex_profile", profile: "personal" },
          },
        ],
        {},
        "relative/profiles",
      ),
    ).toThrow(AccountConfigurationError);
  });

  it("rejects relative Claude profile roots", () => {
    expect(() =>
      loadAccounts(
        [
          {
            accountAlias: "Claude",
            platform: "Claude",
            auth: { type: "claude_profile", profile: "personal" },
          },
        ],
        {},
        "/codex",
        "relative/profiles",
      ),
    ).toThrow(AccountConfigurationError);
  });
});
