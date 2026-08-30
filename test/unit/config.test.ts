import { describe, expect, it } from "vitest";

import {
  AccountConfigurationError,
  loadAccounts,
  type AccountDefinition,
} from "../../src/config/accounts.js";

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
});
