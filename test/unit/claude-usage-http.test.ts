import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { LoadedClaudeProfileAccount } from "../../src/config/accounts.js";
import {
  createClaudeHttpUsageReader,
  parseClaudeHttpUsage,
  ClaudeUsageHttpError,
  parseClaudeNativeCache,
} from "../../src/services/claude-usage-http.js";
import { parseClaudeUsageOutput } from "../../src/services/claude-usage.js";
import { createClaudeProvider } from "../../src/services/claude.js";
import { ProcessTimeoutError } from "../../src/services/process.js";

const fixture = JSON.parse(
  readFileSync(
    new URL("../fixtures/claude-usage-http.json", import.meta.url),
    "utf8",
  ),
) as {
  limits: {
    kind: string;
    group: string;
    percent: number | null;
    resets_at: string | null;
    scope: unknown;
  }[];
};
const native = readFileSync(
  new URL("../fixtures/claude-usage.txt", import.meta.url),
  "utf8",
);
const account: LoadedClaudeProfileAccount = {
  accountAlias: "synthetic",
  platform: "Claude",
  auth: {
    type: "claude_profile",
    profile: "synthetic",
    expectedEmail: "synthetic@example.com",
    claudeConfigDir: "/synthetic",
  },
};
const options = {
  account,
  ultraPlan: false,
  cliVersion: "2.1.314",
  timeoutMilliseconds: 1_000,
  now: () => new Date("2026-08-30T00:30:00Z"),
};
const context = {
  now: () => new Date("2026-08-30T00:30:00Z"),
  timeoutMilliseconds: 1_000,
};

describe("Claude HTTP quota mapping", () => {
  it("matches every native quota field without converting Fable to weekly share", () => {
    expect(parseClaudeHttpUsage(fixture, false)).toEqual(
      parseClaudeUsageOutput(native, context.now().getTime()),
    );
  });
  it("requires independent Ultra identity and a complete weekly/Fable reading for N/A", () => {
    const weekly = { limits: fixture.limits.slice(1) };
    expect(parseClaudeHttpUsage(weekly, true)[0]).toHaveProperty(
      "applicability",
      "not_applicable",
    );
    expect(parseClaudeHttpUsage(weekly, false)[0]).not.toHaveProperty(
      "applicability",
    );
    expect(
      parseClaudeHttpUsage({ limits: [fixture.limits[1]] }, true)[0],
    ).not.toHaveProperty("applicability");
    expect(parseClaudeHttpUsage(fixture, true)[0]).not.toHaveProperty(
      "applicability",
    );
  });
  it("preserves unknown readings and absent Fable semantics", () => {
    const limits = parseClaudeHttpUsage(
      {
        limits: [
          { ...fixture.limits[0], percent: null, resets_at: null },
          fixture.limits[1],
        ],
      },
      false,
    );
    expect(limits[0]).toMatchObject({ usedPercent: null, resetAt: null });
    expect(limits[2]).toMatchObject({
      key: "fable",
      availability: "unsupported",
    });
  });
  it.each([
    {},
    { limits: [] },
    { limits: [fixture.limits[0], fixture.limits[0]] },
    { limits: [{ ...fixture.limits[0], percent: 101 }] },
    { limits: [{ ...fixture.limits[0], percent: null }] },
    { limits: [{ ...fixture.limits[0], resets_at: "not-a-date" }] },
    { limits: [{ ...fixture.limits[0], kind: "new_window" }] },
    { limits: [{ ...fixture.limits[0], group: "weekly" }] },
  ])(
    "refuses incomplete or changed schemas for native fallback: %j",
    (payload) => {
      expect(() => parseClaudeHttpUsage(payload, false)).toThrow();
    },
  );
});

describe("bounded authenticated HTTP reader", () => {
  it("uses the isolated profile, installed CLI version and rejects redirects", async () => {
    const read = createClaudeHttpUsageReader({
      accessToken: (directory) => {
        expect(directory).toBe("/synthetic");
        return Promise.resolve("private-token");
      },
      fetch: (url, init) => {
        expect(url).toBe(
          "https://api.anthropic.com/api/oauth/usage?cedar_ember=1&skip_spend=1",
        );
        expect(init).toMatchObject({
          redirect: "error",
          headers: {
            Authorization: "Bearer private-token",
            "User-Agent": "claude-cli/2.1.314 (external, cli)",
          },
        });
        return Promise.resolve(Response.json(fixture));
      },
    });
    expect(await read(options)).toMatchObject({
      limits: parseClaudeHttpUsage(fixture, false),
      source: "http",
    });
  });
  it.each([401, 403, 429, 529])(
    "redacts HTTP %i without retrying",
    async (status) => {
      let calls = 0;
      const read = createClaudeHttpUsageReader({
        accessToken: () => Promise.resolve("private-token"),
        fetch: () => {
          calls += 1;
          return Promise.resolve(new Response("private response", { status }));
        },
      });
      await expect(read(options)).rejects.toMatchObject({
        status,
        message: "Claude HTTP quota could not be read.",
      });
      expect(calls).toBe(1);
    },
  );
  it("bounds the response body and handles invalid JSON without leaking it", async () => {
    for (const body of ["x".repeat(1_100_000), "private-invalid-json"]) {
      const read = createClaudeHttpUsageReader({
        accessToken: () => Promise.resolve("token"),
        fetch: () => Promise.resolve(new Response(body)),
      });
      await expect(read(options)).rejects.toBeInstanceOf(ClaudeUsageHttpError);
    }
  });
  it("aborts an HTTP request at the provider deadline", async () => {
    const read = createClaudeHttpUsageReader({
      accessToken: () => Promise.resolve("token"),
      fetch: (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new Error("private transport")),
            { once: true },
          );
        }),
    });
    await expect(
      read({ ...options, timeoutMilliseconds: 10 }),
    ).rejects.toBeInstanceOf(ProcessTimeoutError);
  });
});

describe("HTTP-first provider compatibility", () => {
  function provider(
    readHttpUsage: ReturnType<typeof createClaudeHttpUsageReader>,
    email = "synthetic@example.com",
  ) {
    const calls: string[][] = [];
    const result = createClaudeProvider({
      profileIsReady: () => Promise.resolve(true),
      managedMcpIsConfigured: () => Promise.resolve(false),
      readHttpUsage,
      run: ({ args }) => {
        calls.push([...args]);
        return Promise.resolve({
          exitCode: 0,
          stderr: "",
          stdout:
            args[0] === "auth"
              ? JSON.stringify({
                  loggedIn: true,
                  email,
                  subscriptionType: "max",
                })
              : args[0] === "--version"
                ? "2.1.314 (Claude Code)"
                : native,
        });
      },
    });
    return { result, calls };
  }
  it("verifies identity each scan, caches only CLI version and skips the heavyweight usage process", async () => {
    const read = vi.fn(() =>
      Promise.resolve({
        limits: parseClaudeHttpUsage(fixture, false),
        observedAt: context.now().toISOString(),
        source: "http" as const,
      }),
    );
    const { result, calls } = provider(read);
    for (let i = 0; i < 2; i++)
      expect((await result.scan(account, context)).status).toBe("ok");
    expect(calls).toEqual([
      ["auth", "status", "--json"],
      ["--version"],
      ["auth", "status", "--json"],
    ]);
    expect(read).toHaveBeenCalledTimes(2);
  });
  it("does not request quota for a mismatched authenticated identity", async () => {
    const read = vi.fn(() =>
      Promise.resolve({
        limits: [],
        observedAt: context.now().toISOString(),
        source: "http" as const,
      }),
    );
    const { result } = provider(read, "wrong@example.com");
    expect(await result.scan(account, context)).toMatchObject({
      status: "error",
      error: { code: "identity_mismatch" },
    });
    expect(read).not.toHaveBeenCalled();
  });
  it("retains native CLI quota on HTTP failure, including refresh and schema changes", async () => {
    const { result, calls } = provider(() =>
      Promise.reject(new ClaudeUsageHttpError(429)),
    );
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      const snapshot = await result.scan(account, context);
      expect(snapshot).toMatchObject({
        status: "ok",
        limits: parseClaudeUsageOutput(native, context.now().getTime()),
      });
      expect(calls.at(-1)).toContain("/usage");
      expect(stderr.mock.calls.flat().join("")).toContain('"httpStatus":429');
    } finally {
      stderr.mockRestore();
    }
  });
});

function nativeCache(fetchedAtMs = context.now().getTime() - 600_000) {
  return {
    oauthAccount: {
      accountUuid: "synthetic-id",
      emailAddress: account.auth.expectedEmail,
    },
    cachedUsageUtilization: {
      accountUuid: "synthetic-id",
      fetchedAtMs,
      utilization: fixture,
    },
  };
}

describe("identity-bound throttling fallback", () => {
  it("reads the same native quota cache but preserves its actual age", async () => {
    const read = createClaudeHttpUsageReader({
      accessToken: () => Promise.resolve("token"),
      nativeCache: () => Promise.resolve(nativeCache()),
      fetch: () => Promise.resolve(new Response(null, { status: 429 })),
    });
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      expect(await read(options)).toEqual({
        limits: parseClaudeHttpUsage(fixture, false),
        observedAt: "2026-08-30T00:20:00.000Z",
        source: "cache",
      });
    } finally {
      stderr.mockRestore();
    }
  });
  it("prefers its latest successful HTTP observation to an older native cache", async () => {
    let status = 200;
    const read = createClaudeHttpUsageReader({
      accessToken: () => Promise.resolve("token"),
      nativeCache: () => Promise.resolve(nativeCache()),
      fetch: () =>
        Promise.resolve(
          status === 200
            ? Response.json(fixture)
            : new Response(null, { status }),
        ),
    });
    const fresh = await read(options);
    status = 429;
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      expect(await read(options)).toEqual({ ...fresh, source: "cache" });
    } finally {
      stderr.mockRestore();
    }
    status = 401;
    await expect(read(options)).rejects.toMatchObject({ status: 401 });
  });
  it.each(["email", "account", "future"])(
    "rejects %s cache mismatches",
    (mismatch) => {
      const payload = nativeCache();
      if (mismatch === "email")
        payload.oauthAccount.emailAddress = "wrong@example.com";
      if (mismatch === "account")
        payload.cachedUsageUtilization.accountUuid = "wrong-id";
      if (mismatch === "future")
        payload.cachedUsageUtilization.fetchedAtMs =
          context.now().getTime() + 1;
      expect(() =>
        parseClaudeNativeCache(payload, account, false, context.now()),
      ).toThrow();
    },
  );
  it("never uses cache to hide denied authorization", async () => {
    for (const status of [401, 403]) {
      const cached = vi.fn(() => Promise.resolve(nativeCache()));
      const read = createClaudeHttpUsageReader({
        accessToken: () => Promise.resolve("token"),
        nativeCache: cached,
        fetch: () => Promise.resolve(new Response(null, { status })),
      });
      await expect(read(options)).rejects.toMatchObject({ status });
      expect(cached).not.toHaveBeenCalled();
    }
  });
});

it("reads bounded native profile files and rejects missing or oversized credentials", async () => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const directory = await mkdtemp(join(tmpdir(), "seat-monitor-http-profile-"));
  const local = {
    ...options,
    account: {
      ...account,
      auth: { ...account.auth, claudeConfigDir: directory },
    },
  };
  const read = createClaudeHttpUsageReader({
    fetch: () => Promise.resolve(new Response(null, { status: 429 })),
  });
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  try {
    await expect(read(local)).rejects.toThrow();
    await writeFile(
      join(directory, ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: "test-token" } }),
    );
    await writeFile(
      join(directory, ".claude.json"),
      JSON.stringify(nativeCache()),
    );
    expect(await read(local)).toMatchObject({
      source: "cache",
      observedAt: "2026-08-30T00:20:00.000Z",
    });
    await writeFile(
      join(directory, ".credentials.json"),
      "x".repeat(1_000_001),
    );
    await expect(read(local)).rejects.toBeInstanceOf(ClaudeUsageHttpError);
    await expect(
      read({ ...local, cliVersion: "bad\r\nheader" }),
    ).rejects.toBeInstanceOf(ClaudeUsageHttpError);
  } finally {
    stderr.mockRestore();
    await rm(directory, { recursive: true, force: true });
  }
});
