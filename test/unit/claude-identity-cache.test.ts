import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { LoadedAccount } from "../../src/config/accounts.js";
import type { QuotaLimit } from "../../src/domain/quota.js";
import {
  createClaudeProvider,
  readClaudeCredentialState,
  type ClaudeCredentialState,
} from "../../src/services/claude.js";
import {
  ClaudeUsageHttpError,
  type ReadClaudeHttpUsage,
} from "../../src/services/claude-usage-http.js";
import type { RunCommand } from "../../src/services/process.js";

const profileAccount: LoadedAccount = {
  accountAlias: "claude-profile@example.com",
  platform: "Claude",
  auth: {
    type: "claude_profile",
    profile: "profile",
    expectedEmail: "profile@example.com",
    claudeConfigDir: "/profiles/profile",
  },
};
const weekly: QuotaLimit = {
  key: "base.weekly",
  label: "Current Week (All Models)",
  scope: "window",
  availability: "available",
  usedPercent: 12,
  windowDurationMinutes: 10_080,
  resetAt: "2026-09-05T00:00:00.000Z",
};
const START = Date.parse("2026-08-30T00:00:00.000Z");
let setCredentialsDuringAuth: (
  next: ClaudeCredentialState | null,
) => void = () => undefined;
const MINUTE = 60_000;

function harness(
  options: {
    email?: string;
    authStdout?: () => string | null;
    duringAuth?: (check: number) => void;
  } = {},
) {
  let clock = START;
  let credentials: ClaudeCredentialState | null = {
    fingerprint: "first",
    expiresAtMilliseconds: START + 8 * 60 * MINUTE,
  };
  const authChecks: number[] = [];
  const httpStatuses: (number | null)[] = [];
  const run: RunCommand = (command) => {
    if (command.args[0] === "--version") {
      return Promise.resolve({
        exitCode: 0,
        stdout: "2.1.314 (Claude Code)\n",
        stderr: "",
      });
    }
    if (command.args[0] === "auth") {
      authChecks.push(clock);
      options.duringAuth?.(authChecks.length);
      return Promise.resolve({
        exitCode: 0,
        stdout:
          options.authStdout?.() ??
          JSON.stringify({
            loggedIn: true,
            email: options.email ?? "profile@example.com",
            subscriptionType: "max",
          }),
        stderr: "",
      });
    }
    return Promise.reject(new Error("unexpected Claude command"));
  };
  const readHttpUsage: ReadClaudeHttpUsage = () => {
    const status = httpStatuses.shift() ?? null;
    if (status !== null) {
      return Promise.reject(new ClaudeUsageHttpError(status));
    }
    return Promise.resolve({
      limits: [weekly],
      observedAt: new Date(clock).toISOString(),
      source: "http",
    });
  };
  setCredentialsDuringAuth = (next) => {
    credentials = next;
  };
  const provider = createClaudeProvider({
    run,
    readHttpUsage,
    profileIsReady: () => Promise.resolve(true),
    readProfileState: () => Promise.resolve(null),
    readCredentialState: () =>
      credentials === null
        ? Promise.reject(new Error("unreadable"))
        : Promise.resolve(credentials),
  });
  return {
    authChecks,
    httpStatuses,
    advance(milliseconds: number) {
      clock += milliseconds;
    },
    setCredentials(next: ClaudeCredentialState | null) {
      credentials = next;
    },
    scan: () =>
      provider.scan(profileAccount, {
        now: () => new Date(clock),
        timeoutMilliseconds: 8_000,
      }),
  };
}

describe("Claude identity checks between scans", () => {
  it("reuses a check while the credentials file is unchanged", async () => {
    const profile = harness();
    expect(await profile.scan()).toMatchObject({ status: "ok", plan: "max" });
    profile.advance(MINUTE);
    expect(await profile.scan()).toMatchObject({
      status: "ok",
      plan: "max",
      limits: [weekly],
    });
    expect(profile.authChecks).toEqual([START]);
  });

  it("checks again when the credentials change, the token nears expiry, or an hour passes", async () => {
    const profile = harness();
    await profile.scan();

    // Another login, or a token refresh, rewrites the credentials file.
    profile.advance(MINUTE);
    profile.setCredentials({
      fingerprint: "second",
      expiresAtMilliseconds: START + 8 * 60 * MINUTE,
    });
    await profile.scan();
    expect(profile.authChecks).toHaveLength(2);

    // Within five minutes of expiry the CLI is asked, so it refreshes.
    profile.advance(MINUTE);
    profile.setCredentials({
      fingerprint: "second",
      expiresAtMilliseconds: START + 2 * MINUTE + 5 * MINUTE,
    });
    await profile.scan();
    expect(profile.authChecks).toHaveLength(3);

    profile.setCredentials({
      fingerprint: "second",
      expiresAtMilliseconds: START + 8 * 60 * MINUTE,
    });
    profile.advance(59 * MINUTE);
    await profile.scan();
    expect(profile.authChecks).toHaveLength(3);
    profile.advance(MINUTE);
    await profile.scan();
    expect(profile.authChecks).toHaveLength(4);
  });

  it("checks every scan when the credentials cannot be read", async () => {
    const profile = harness();
    profile.setCredentials(null);
    await profile.scan();
    profile.advance(MINUTE);
    await profile.scan();
    expect(profile.authChecks).toHaveLength(2);
  });

  it("checks again and retries once when a reused token is rejected", async () => {
    const profile = harness();
    await profile.scan();
    profile.advance(MINUTE);
    profile.httpStatuses.push(401);
    expect(await profile.scan()).toMatchObject({
      status: "ok",
      limits: [weekly],
    });
    expect(profile.authChecks).toEqual([START, START + MINUTE]);
  });

  it("checks again after a run that refreshed the token, then holds it", async () => {
    const profile = harness({
      duringAuth: (check) => {
        if (check === 1) {
          setCredentialsDuringAuth({
            fingerprint: "refreshed",
            expiresAtMilliseconds: START + 8 * 60 * MINUTE,
          });
        }
      },
    });
    await profile.scan();
    expect(profile.authChecks).toHaveLength(2);
    profile.advance(MINUTE);
    await profile.scan();
    expect(profile.authChecks).toHaveLength(2);
  });

  it("never holds a check whose credentials changed while it ran", async () => {
    let login = 0;
    const profile = harness({
      duringAuth: () => {
        login += 1;
        setCredentialsDuringAuth({
          fingerprint: `login-${String(login)}`,
          expiresAtMilliseconds: START + 8 * 60 * MINUTE,
        });
      },
    });
    expect(await profile.scan()).toMatchObject({ status: "ok" });
    expect(profile.authChecks).toHaveLength(2);
    profile.advance(MINUTE);
    await profile.scan();
    expect(profile.authChecks).toHaveLength(4);
  });

  it("reports a failed re-check after a rejected token instead of falling back", async () => {
    let stdout: string | null = null;
    const profile = harness({ authStdout: () => stdout });
    await profile.scan();
    profile.advance(MINUTE);
    profile.httpStatuses.push(401);
    stdout = "not json";
    expect(await profile.scan()).toMatchObject({
      status: "error",
      error: { code: "invalid_response" },
    });
  });

  it("reports the plan the re-check found", async () => {
    let plan = "max";
    const profile = harness({
      authStdout: () =>
        JSON.stringify({
          loggedIn: true,
          email: "profile@example.com",
          subscriptionType: plan,
        }),
    });
    await profile.scan();
    profile.advance(MINUTE);
    profile.httpStatuses.push(401);
    plan = "ultra";
    expect(await profile.scan()).toMatchObject({ status: "ok", plan: "ultra" });
  });

  it("never holds a failed identity check", async () => {
    const profile = harness({ email: "other@example.com" });
    expect(await profile.scan()).toMatchObject({
      status: "error",
      error: { code: "identity_mismatch" },
    });
    profile.advance(MINUTE);
    await profile.scan();
    expect(profile.authChecks).toHaveLength(2);
  });
});

describe("Claude credential state", () => {
  const directories: string[] = [];
  afterEach(async () => {
    await Promise.all(
      directories
        .splice(0)
        .map((directory) => rm(directory, { force: true, recursive: true })),
    );
  });

  async function profileDirectory(contents: string): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "seat-monitor-claude-"));
    directories.push(directory);
    await writeFile(join(directory, ".credentials.json"), contents);
    return directory;
  }

  it("fingerprints the file and reads the token expiry", async () => {
    const credentials = JSON.stringify({
      claudeAiOauth: { accessToken: "secret", expiresAt: START },
    });
    const state = await readClaudeCredentialState(
      await profileDirectory(credentials),
    );
    expect(state.expiresAtMilliseconds).toBe(START);
    expect(state.fingerprint).toMatch(/^[0-9a-f]{64}$/u);
    expect(state.fingerprint).not.toContain("secret");
    expect(
      (
        await readClaudeCredentialState(
          await profileDirectory(`${credentials}\n`),
        )
      ).fingerprint,
    ).not.toBe(state.fingerprint);
  });

  it("reports no expiry for other layouts and refuses oversized files", async () => {
    expect(
      await readClaudeCredentialState(await profileDirectory("{}")),
    ).toMatchObject({ expiresAtMilliseconds: null });
    await expect(
      readClaudeCredentialState(
        await profileDirectory(`"${"x".repeat(1_000_001)}"`),
      ),
    ).rejects.toBeInstanceOf(RangeError);
  });
});
