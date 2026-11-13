import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { LoadedCodexProfileAccount } from "../../src/config/accounts.js";
import { publicQuotaArraySchema } from "../../src/domain/quota.js";
import { toPublicSnapshots } from "../../src/presentation/public-dto.js";
import {
  createCodexProvider,
  normalizeCodexResult,
} from "../../src/services/codex.js";
import { CodexUsageHttpError } from "../../src/services/codex-usage-http.js";

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

  it("reports available reset credits and expiry without exposing credit IDs", async () => {
    const fixture = await loadFixture();
    const rateLimitsResult = fixture.rateLimitsResult as Record<
      string,
      unknown
    >;
    const snapshot = normalizeCodexResult(
      "Codex_Work",
      {
        ...fixture,
        rateLimitsResult: {
          ...rateLimitsResult,
          rateLimitResetCredits: {
            availableCount: 3,
            credits: [
              {
                id: "private-credit-1",
                status: "available",
                title: "Full reset",
                expiresAt: Date.parse("2026-10-22T16:00:00Z") / 1_000,
              },
              {
                id: "private-credit-2",
                status: "available",
                title: "Expired reset",
                expiresAt: Date.parse("2026-10-01T00:00:00Z") / 1_000,
              },
            ],
          },
        },
      },
      "2026-10-15T20:00:00Z",
    );
    expect(snapshot.status).toBe("ok");
    if (snapshot.status !== "ok") throw new TypeError("Expected Codex quota.");
    expect(snapshot.resetOffers).toEqual([
      {
        label: "Full reset",
        count: 1,
        expiresAt: "2026-10-22T16:00:00.000Z",
      },
      { label: "Reset credit", count: 1, expiresAt: null },
    ]);
    expect(JSON.stringify(snapshot)).not.toContain("private-credit");
  });

  it("keeps quota available when reset-credit details are malformed", async () => {
    const fixture = await loadFixture();
    const rateLimitsResult = fixture.rateLimitsResult as Record<
      string,
      unknown
    >;
    const snapshot = normalizeCodexResult(
      "Codex_Work",
      {
        ...fixture,
        rateLimitsResult: {
          ...rateLimitsResult,
          rateLimitResetCredits: { availableCount: "unknown" },
        },
      },
      "2026-10-15T20:00:00Z",
    );
    expect(snapshot.status).toBe("ok");
    if (snapshot.status !== "ok") throw new TypeError("Expected Codex quota.");
    expect(snapshot.limits).toHaveLength(3);
    expect(snapshot.resetOffers).toBeNull();
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
      readHttpUsage: null,
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
    expect(snapshot.error.message).toBe(
      "Codex profile personal is not logged in. Run: seat-monitor-codex-login 'codex-personal@example.com'",
    );
    expect(readCalled).toBe(false);
  });
  const profileAccount: LoadedCodexProfileAccount = {
    accountAlias: "codex-personal@example.com",
    platform: "Codex",
    auth: {
      type: "codex_profile",
      profile: "personal",
      codexHome: "/profiles/personal",
    },
  };
  const scanContext = {
    now: () => new Date("2026-08-26T18:00:00.000Z"),
    timeoutMilliseconds: 8_000,
  };

  it("reads profile quota over HTTP without starting App Server", async () => {
    const fixture = await loadFixture();
    let readCalled = false;
    let httpHome: string | undefined;
    const provider = createCodexProvider({
      profileIsReady: () => Promise.resolve(true),
      readHttpUsage: (options) => {
        httpHome = options.codexHome;
        return Promise.resolve(fixture);
      },
      read: () => {
        readCalled = true;
        return Promise.reject(new Error("should not run"));
      },
    });

    const snapshot = await provider.scan(profileAccount, scanContext);
    expect(snapshot.status).toBe("ok");
    expect(httpHome).toBe("/profiles/personal");
    expect(readCalled).toBe(false);
  });

  it("falls back to App Server when the direct read fails", async () => {
    const fixture = await loadFixture();
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    let receivedEnvironment: NodeJS.ProcessEnv | undefined;
    const provider = createCodexProvider({
      profileIsReady: () => Promise.resolve(true),
      readHttpUsage: () =>
        Promise.reject(new CodexUsageHttpError("http_error", 401)),
      read: (options) => {
        receivedEnvironment = options.environment;
        return Promise.resolve(fixture);
      },
    });

    try {
      const snapshot = await provider.scan(profileAccount, scanContext);
      expect(snapshot.status).toBe("ok");
      expect(receivedEnvironment?.CODEX_HOME).toBe("/profiles/personal");
      expect(stderr).toHaveBeenCalledWith(
        `${JSON.stringify({ event: "codex-usage-fallback", reason: "http_error", httpStatus: 401 })}\n`,
      );
    } finally {
      stderr.mockRestore();
    }
  });

  it("reports a direct answer with no quota windows without App Server", async () => {
    let readCalled = false;
    const provider = createCodexProvider({
      profileIsReady: () => Promise.resolve(true),
      readHttpUsage: () =>
        Promise.resolve({
          accountResult: { account: { planType: "free" } },
          rateLimitsResult: { rateLimitsByLimitId: {} },
        }),
      read: () => {
        readCalled = true;
        return Promise.reject(new Error("should not run"));
      },
    });

    const snapshot = await provider.scan(profileAccount, scanContext);
    expect(snapshot.status).toBe("error");
    if (snapshot.status !== "error") throw new TypeError("Expected an error.");
    expect(snapshot.error.code).toBe("unsupported");
    expect(readCalled).toBe(false);
  });

  it("never reads token-injected accounts over HTTP", async () => {
    const fixture = await loadFixture();
    let httpCalled = false;
    const provider = createCodexProvider({
      readHttpUsage: () => {
        httpCalled = true;
        return Promise.reject(new Error("should not run"));
      },
      read: () => Promise.resolve(fixture),
    });

    const snapshot = await provider.scan(
      {
        accountAlias: "codex-token",
        platform: "Codex",
        auth: {
          type: "codex_access_token",
          credentialEnv: "CODEX_TOKEN",
          credential: "token-value",
        },
      },
      scanContext,
    );
    expect(snapshot.status).toBe("ok");
    expect(httpCalled).toBe(false);
  });
});
