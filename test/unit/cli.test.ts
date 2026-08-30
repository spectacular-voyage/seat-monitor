import { describe, expect, it } from "vitest";

import { runCli } from "../../src/cli.js";
import {
  publicQuotaArraySchema,
  quotaSuccessSchema,
  type QuotaSnapshot,
} from "../../src/domain/quota.js";

function fixture(): QuotaSnapshot {
  return quotaSuccessSchema.parse({
    accountAlias: "Codex_Work",
    platform: "Codex",
    status: "ok",
    plan: "business",
    limits: [
      {
        key: "codex.primary",
        label: "Codex | Primary",
        scope: "window",
        availability: "available",
        usedPercent: 42,
        windowDurationMinutes: 300,
        resetAt: "2026-08-26T18:45:00.000Z",
      },
    ],
    observedAt: "2026-08-26T18:00:00.000Z",
  });
}

function writer() {
  let value = "";
  return {
    sink: {
      write(chunk: string) {
        value += chunk;
      },
    },
    read: () => value,
  };
}

describe("CLI", () => {
  it("emits only minified parseable JSON", async () => {
    const stdout = writer();
    const stderr = writer();
    const exitCode = await runCli(["--json"], {
      scan: () => Promise.resolve([fixture()]),
      now: () => new Date("2026-08-26T18:00:00.000Z"),
      stdout: stdout.sink,
      stderr: stderr.sink,
    });

    expect(exitCode).toBe(0);
    expect(stderr.read()).toBe("");
    expect(stdout.read()).not.toContain("\n\n");
    const payload = publicQuotaArraySchema.parse(JSON.parse(stdout.read()));
    expect(payload).toEqual([
      expect.objectContaining({ accountAlias: "Codex_Work" }),
    ]);
  });

  it("defaults to a log-free aligned text report", async () => {
    const stdout = writer();
    const stderr = writer();
    const exitCode = await runCli([], {
      scan: () => Promise.resolve([fixture()]),
      now: () => new Date("2026-08-26T18:00:00.000Z"),
      timeZone: "America/Los_Angeles",
      stdout: stdout.sink,
      stderr: stderr.sink,
    });

    expect(exitCode).toBe(0);
    expect(stderr.read()).toBe("");
    expect(stdout.read()).toContain("QUOTA — 2026-08-26 11:00 PDT");
    expect(stdout.read()).toContain("USE:   Codex_Work");
    expect(stdout.read()).toContain("CODEX");
    expect(stdout.read()).not.toContain("| Limit |");
  });

  it("emits Markdown only when requested", async () => {
    const stdout = writer();
    const stderr = writer();
    const exitCode = await runCli(["--format=md"], {
      scan: () => Promise.resolve([fixture()]),
      now: () => new Date("2026-08-26T18:00:00.000Z"),
      timeZone: "America/Los_Angeles",
      stdout: stdout.sink,
      stderr: stderr.sink,
    });

    expect(exitCode).toBe(0);
    expect(stderr.read()).toBe("");
    expect(stdout.read()).toContain("| Limit | Consumed | Level |");
  });

  it("rejects conflicting flags with exit 2", async () => {
    const stdout = writer();
    const stderr = writer();
    const exitCode = await runCli(["--json", "--format", "json"], {
      scan: () => Promise.resolve([]),
      stdout: stdout.sink,
      stderr: stderr.sink,
    });

    expect(exitCode).toBe(2);
    expect(stdout.read()).toBe("");
    expect(stderr.read()).toContain("Usage:");
  });

  it("initializes account configuration without scanning", async () => {
    const stdout = writer();
    const stderr = writer();
    let scanned = false;
    const exitCode = await runCli(["--init-config"], {
      initializeConfig: () => Promise.resolve("/config/accounts.json"),
      scan: () => {
        scanned = true;
        return Promise.resolve([]);
      },
      stdout: stdout.sink,
      stderr: stderr.sink,
    });

    expect(exitCode).toBe(0);
    expect(scanned).toBe(false);
    expect(stderr.read()).toBe("");
    expect(stdout.read()).toContain("/config/accounts.json");
  });

  it("returns exit 1 while preserving account-level error output", async () => {
    const stdout = writer();
    const stderr = writer();
    const failed: QuotaSnapshot = {
      accountAlias: "Claude_Personal",
      platform: "Claude",
      status: "error",
      plan: null,
      limits: [],
      observedAt: "2026-08-26T18:00:00.000Z",
      error: {
        code: "missing_credential",
        message: "Credential is missing.",
      },
    };

    const exitCode = await runCli(["--format", "json"], {
      scan: () => Promise.resolve([failed]),
      stdout: stdout.sink,
      stderr: stderr.sink,
    });

    expect(exitCode).toBe(1);
    expect(stderr.read()).toBe("");
    expect(
      publicQuotaArraySchema.parse(JSON.parse(stdout.read())),
    ).toHaveLength(1);
  });
});
