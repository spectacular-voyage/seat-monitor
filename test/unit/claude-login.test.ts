import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { LoadedClaudeProfileAccount } from "../../src/config/accounts.js";
import {
  loginClaudeProfile,
  type RunInteractiveClaudeCommand,
} from "../../src/services/claude-login.js";

describe("loginClaudeProfile", () => {
  it("stores an isolated Claude login with restrictive permissions", async () => {
    const root = await mkdtemp(join(tmpdir(), "seat-monitor-claude-login-"));
    const claudeConfigDir = join(root, "personal");
    const account: LoadedClaudeProfileAccount = {
      accountAlias: "claude-personal@example.com",
      platform: "Claude",
      auth: { type: "claude_profile", profile: "personal", claudeConfigDir },
    };
    let receivedArgs: readonly string[] = [];
    let receivedEnvironment: NodeJS.ProcessEnv | undefined;
    const run: RunInteractiveClaudeCommand = async (options) => {
      receivedArgs = options.args;
      receivedEnvironment = options.environment;
      await writeFile(join(claudeConfigDir, ".credentials.json"), "{}", {
        mode: 0o644,
      });
      return 0;
    };

    try {
      const credentialsPath = await loginClaudeProfile(account, { run });
      expect(credentialsPath).toBe(join(claudeConfigDir, ".credentials.json"));
      expect(receivedArgs).toEqual(["auth", "login", "--claudeai"]);
      if (receivedEnvironment === undefined) {
        throw new TypeError("Expected login command to run.");
      }
      expect(receivedEnvironment.CLAUDE_CONFIG_DIR).toBe(claudeConfigDir);
      expect(receivedEnvironment.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
      expect((await stat(claudeConfigDir)).mode & 0o777).toBe(0o700);
      expect((await stat(credentialsPath)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
