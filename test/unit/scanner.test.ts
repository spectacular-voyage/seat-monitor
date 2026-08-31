import { describe, expect, it } from "vitest";

import type { LoadedAccount } from "../../src/config/accounts.js";
import { quotaSuccessSchema } from "../../src/domain/quota.js";
import type { QuotaProvider } from "../../src/services/provider.js";
import { createScanner } from "../../src/services/scan-accounts.js";

function account(alias: string, credential = "token"): LoadedAccount {
  return {
    accountAlias: alias,
    platform: "Codex",
    auth: {
      type: "codex_access_token",
      credentialEnv: `TOKEN_${alias.toLocaleUpperCase("en-US")}`,
      credential,
    },
  };
}

function claudeAccount(alias: string): LoadedAccount {
  return {
    accountAlias: alias,
    platform: "Claude",
    auth: {
      type: "claude_setup_token",
      credentialEnv: `TOKEN_${alias.toLocaleUpperCase("en-US")}`,
      credential: "token",
    },
  };
}

function success(alias: string, platform: LoadedAccount["platform"] = "Codex") {
  return quotaSuccessSchema.parse({
    accountAlias: alias,
    platform,
    status: "ok",
    plan: "business",
    limits: [
      {
        key: "codex.primary",
        label: "Codex Primary",
        scope: "window",
        availability: "available",
        usedPercent: 25,
        windowDurationMinutes: 300,
        resetAt: "2026-08-26T19:20:00.000Z",
      },
    ],
    observedAt: "2026-08-26T18:00:00.000Z",
  });
}

describe("account scanner", () => {
  it("preserves configuration order across out-of-order completions", async () => {
    const provider: QuotaProvider = {
      async scan(loadedAccount) {
        const delay = loadedAccount.accountAlias === "First" ? 15 : 0;
        await new Promise((resolve) => setTimeout(resolve, delay));
        return success(loadedAccount.accountAlias);
      },
    };
    const scan = createScanner({
      accounts: [account("First"), account("Second")],
      providers: { Claude: provider, Codex: provider },
      now: () => new Date("2026-08-26T18:00:00.000Z"),
    });

    expect((await scan()).map((snapshot) => snapshot.accountAlias)).toEqual([
      "First",
      "Second",
    ]);
  });

  it("bounds concurrent provider checks", async () => {
    let active = 0;
    let maximumActive = 0;
    const provider: QuotaProvider = {
      async scan(loadedAccount) {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return success(loadedAccount.accountAlias);
      },
    };
    const scan = createScanner({
      accounts: Array.from({ length: 10 }, (_, index) =>
        account(`Account_${String(index)}`),
      ),
      providers: { Claude: provider, Codex: provider },
      concurrency: 3,
    });

    expect(await scan()).toHaveLength(10);
    expect(maximumActive).toBe(3);
  });

  it("uses a longer Claude deadline while preserving the Codex bound", async () => {
    const received = new Map<string, number>();
    const provider: QuotaProvider = {
      scan(loadedAccount, context) {
        received.set(loadedAccount.accountAlias, context.timeoutMilliseconds);
        return Promise.resolve(
          success(loadedAccount.accountAlias, loadedAccount.platform),
        );
      },
    };
    const scan = createScanner({
      accounts: [claudeAccount("Claude"), account("Codex")],
      providers: { Claude: provider, Codex: provider },
    });

    const snapshots = await scan();
    expect(snapshots.every((snapshot) => snapshot.status === "ok")).toBe(true);
    expect(received).toEqual(
      new Map([
        ["Claude", 16_000],
        ["Codex", 8_000],
      ]),
    );
  });

  it("returns missing credentials as account-level errors", async () => {
    const provider: QuotaProvider = {
      scan(loadedAccount) {
        return Promise.resolve(success(loadedAccount.accountAlias));
      },
    };
    const scan = createScanner({
      accounts: [account("Missing", "")],
      providers: { Claude: provider, Codex: provider },
      now: () => new Date("2026-08-26T18:00:00.000Z"),
    });

    const snapshots = await scan();
    expect(snapshots).toHaveLength(1);
    const missing = snapshots[0];
    expect(missing?.status).toBe("error");
    if (missing?.status !== "error") {
      throw new TypeError("Expected a missing-credential failure.");
    }
    expect(missing.error.code).toBe("missing_credential");
  });

  it("isolates thrown provider failures", async () => {
    const provider: QuotaProvider = {
      scan(loadedAccount) {
        if (loadedAccount.accountAlias === "Broken") {
          return Promise.reject(new Error("secret provider response"));
        }
        return Promise.resolve(success(loadedAccount.accountAlias));
      },
    };
    const scan = createScanner({
      accounts: [account("Healthy"), account("Broken")],
      providers: { Claude: provider, Codex: provider },
      now: () => new Date("2026-08-26T18:00:00.000Z"),
    });
    const snapshots = await scan();

    expect(snapshots.map((snapshot) => snapshot.status)).toEqual([
      "ok",
      "error",
    ]);
    expect(JSON.stringify(snapshots)).not.toContain("secret provider response");
  });
});
