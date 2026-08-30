import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import type { LoadedAccount } from "../../src/config/accounts.js";
import { createClaudeProvider } from "../../src/services/claude.js";
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
});
