import { mkdtemp, stat, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { LoadedCodexProfileAccount } from "../../src/config/accounts.js";
import {
  loginCodexProfile,
  type RunInteractiveCommand,
} from "../../src/services/codex-login.js";

describe("loginCodexProfile", () => {
  it("forces file-backed auth in an isolated profile", async () => {
    const root = await mkdtemp(join(tmpdir(), "seat-monitor-login-test-"));
    const codexHome = join(root, "personal");
    const account: LoadedCodexProfileAccount = {
      accountAlias: "codex-personal@example.com",
      platform: "Codex",
      auth: { type: "codex_profile", profile: "personal", codexHome },
    };
    let receivedArgs: readonly string[] = [];
    let receivedEnvironment: NodeJS.ProcessEnv | undefined;
    const run: RunInteractiveCommand = async (options) => {
      receivedArgs = options.args;
      receivedEnvironment = options.environment;
      await writeFile(join(codexHome, "auth.json"), "{}", { mode: 0o644 });
      return 0;
    };

    try {
      const authPath = await loginCodexProfile(account, { run });
      expect(authPath).toBe(join(codexHome, "auth.json"));
      expect(receivedArgs).toEqual([
        "-c",
        'cli_auth_credentials_store="file"',
        "login",
      ]);
      if (receivedEnvironment === undefined) {
        throw new TypeError("Expected login command to run.");
      }
      expect(receivedEnvironment.CODEX_HOME).toBe(codexHome);
      expect(receivedEnvironment.CODEX_ACCESS_TOKEN).toBeUndefined();
      expect((await stat(codexHome)).mode & 0o777).toBe(0o700);
      expect((await stat(authPath)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
