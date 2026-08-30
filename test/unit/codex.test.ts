import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { LoadedCodexProfileAccount } from "../../src/config/accounts.js";
import { publicQuotaArraySchema } from "../../src/domain/quota.js";
import { toPublicSnapshots } from "../../src/presentation/public-dto.js";
import {
  createCodexProvider,
  normalizeCodexResult,
} from "../../src/services/codex.js";

async function loadFixture() {
  return JSON.parse(
    await readFile(
      new URL("../fixtures/codex-rate-limits.json", import.meta.url),
      "utf8",
    ),
  ) as { accountResult: unknown; rateLimitsResult: unknown };
}

describe("normalizeCodexResult", () => {
  it("normalizes every App Server rate-limit window", async () => {
    const fixture = await loadFixture();
    const snapshot = normalizeCodexResult(
      "Codex_Work",
      fixture,
      "2026-08-26T18:00:00.000Z",
    );

    expect(snapshot.status).toBe("ok");
    if (snapshot.status !== "ok") {
      throw new TypeError("Expected a successful snapshot.");
    }
    expect(snapshot.plan).toBe("business");
    expect(snapshot.limits.map((limit) => limit.key)).toEqual([
      "codex.primary",
      "codex.secondary",
      "codex_other.primary",
    ]);
    expect(snapshot.limits[0]?.resetAt).toBe("2026-08-27T02:00:00.000Z");
    expect(snapshot.limits.every((limit) => limit.key !== "fable")).toBe(true);

    const publicSnapshots = toPublicSnapshots(
      [snapshot],
      Date.parse("2026-08-26T18:00:00.000Z"),
    );
    expect(publicSnapshots[0]?.status).toBe("ok");
    expect(publicQuotaArraySchema.safeParse(publicSnapshots).success).toBe(
      true,
    );
  });

  it("rejects a response with no quota windows", () => {
    expect(() =>
      normalizeCodexResult(
        "Codex_Work",
        {
          accountResult: { account: { type: "chatgpt", planType: "pro" } },
          rateLimitsResult: { rateLimits: null },
        },
        "2026-08-26T18:00:00.000Z",
      ),
    ).toThrow();
  });

  it("uses a persistent profile without injecting an access token", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "seat-monitor-test-codex-"));
    await writeFile(join(codexHome, "auth.json"), "{}", { mode: 0o600 });
    const account: LoadedCodexProfileAccount = {
      accountAlias: "codex-personal@example.com",
      platform: "Codex",
      auth: {
        type: "codex_profile",
        profile: "personal",
        codexHome,
      },
    };
    let receivedEnvironment: NodeJS.ProcessEnv | undefined;
    const fixture = await loadFixture();
    const provider = createCodexProvider({
      read: (options) => {
        receivedEnvironment = options.environment;
        return Promise.resolve(fixture);
      },
    });

    try {
      const snapshot = await provider.scan(account, {
        now: () => new Date("2026-08-26T18:00:00.000Z"),
        timeoutMilliseconds: 8_000,
      });
      expect(snapshot.status).toBe("ok");
      if (receivedEnvironment === undefined) {
        throw new TypeError("Expected Codex App Server to run.");
      }
      expect(receivedEnvironment.CODEX_HOME).toBe(codexHome);
      expect(receivedEnvironment.CODEX_ACCESS_TOKEN).toBeUndefined();
      expect(await readFile(join(codexHome, "auth.json"), "utf8")).toBe("{}");
    } finally {
      await rm(codexHome, { force: true, recursive: true });
    }
  });

  it("reports a missing profile login without starting App Server", async () => {
    const account: LoadedCodexProfileAccount = {
      accountAlias: "codex-personal@example.com",
      platform: "Codex",
      auth: {
        type: "codex_profile",
        profile: "personal",
        codexHome: "/missing/profile",
      },
    };
    let readCalled = false;
    const provider = createCodexProvider({
      profileIsReady: () => Promise.resolve(false),
      read: () => {
        readCalled = true;
        return Promise.reject(new Error("should not run"));
      },
    });

    const snapshot = await provider.scan(account, {
      now: () => new Date("2026-08-26T18:00:00.000Z"),
      timeoutMilliseconds: 8_000,
    });
    expect(snapshot.status).toBe("error");
    if (snapshot.status !== "error") {
      throw new TypeError("Expected a profile error.");
    }
    expect(snapshot.error.code).toBe("missing_credential");
    expect(readCalled).toBe(false);
  });
});
