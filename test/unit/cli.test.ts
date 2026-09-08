import { describe, expect, it, vi } from "vitest";

import { runCli } from "../../src/cli.js";
import { cliForecastSchema } from "../../src/domain/cli-forecast.js";
import {
  publicQuotaArraySchema,
  quotaSuccessSchema,
  type QuotaSnapshot,
} from "../../src/domain/quota.js";
import { HistoryService } from "../../src/history/service.js";
import { openSqliteHistoryStore } from "../../src/history/sqlite-store.js";
import { PACKAGE_VERSION } from "../../src/version.js";

function fixture(
  usedPercent = 42,
  observedAt = "2026-08-26T18:00:00.000Z",
  resetAt = "2026-08-26T18:45:00.000Z",
): QuotaSnapshot {
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
        usedPercent,
        windowDurationMinutes: 300,
        resetAt,
      },
    ],
    observedAt,
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
  it("advertises forecast mode without scanning", async () => {
    const stdout = writer();
    let scanned = false;

    const exitCode = await runCli(["--help"], {
      scan: () => {
        scanned = true;
        return Promise.resolve([]);
      },
      stdout: stdout.sink,
      stderr: writer().sink,
    });

    expect(exitCode).toBe(0);
    expect(scanned).toBe(false);
    expect(stdout.read()).toContain("--forecast");
  });

  it("reports its package version without scanning", async () => {
    const stdout = writer();
    let scanned = false;

    const exitCode = await runCli(["--version"], {
      scan: () => {
        scanned = true;
        return Promise.resolve([]);
      },
      stdout: stdout.sink,
      stderr: writer().sink,
    });

    expect(exitCode).toBe(0);
    expect(scanned).toBe(false);
    expect(stdout.read()).toBe(`${PACKAGE_VERSION}\n`);
  });

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

  it("records an injected scan when an explicit history service is supplied", async () => {
    const history = new HistoryService(
      openSqliteHistoryStore(
        {
          filePath: ":memory:",
          rawRetentionHours: 6,
          hourlyRetentionDays: 30,
          retentionDays: 365,
        },
        { now: () => new Date("2026-08-26T18:00:00.000Z") },
      ),
    );
    const stdout = writer();
    const observedAt = "2026-08-26T18:00:00.000Z";
    const exitCode = await runCli(["--json"], {
      scan: () => Promise.resolve([fixture()]),
      history,
      now: () => new Date(observedAt),
      stdout: stdout.sink,
      stderr: writer().sink,
    });

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout.read())).toHaveLength(1);
    expect(
      history.listScans({
        fromMilliseconds: Date.parse("2026-08-26T17:00:00.000Z"),
        toMilliseconds: Date.parse("2026-08-26T19:00:00.000Z"),
        limit: 10,
      }),
    ).toHaveLength(1);
    history.close();
  });

  it("emits a lean versioned forecast while preserving explicit states", async () => {
    const history = new HistoryService(
      openSqliteHistoryStore(
        {
          filePath: ":memory:",
          rawRetentionHours: 6,
          hourlyRetentionDays: 30,
          retentionDays: 365,
        },
        { now: () => new Date("2026-08-26T18:00:00.000Z") },
      ),
    );
    const resetAt = "2026-08-26T22:00:00.000Z";
    for (const [usedPercent, observedAt] of [
      [40, "2026-08-26T17:30:00.000Z"],
      [50, "2026-08-26T17:45:00.000Z"],
    ] as const) {
      history.recordScan(
        "server",
        [fixture(usedPercent, observedAt, resetAt)],
        new Date(observedAt),
      );
    }
    const stdout = writer();
    const exitCode = await runCli(["--forecast", "--json"], {
      scan: () =>
        Promise.resolve([fixture(60, "2026-08-26T18:00:00.000Z", resetAt)]),
      history,
      now: () => new Date("2026-08-26T18:00:00.000Z"),
      timeZone: "America/Los_Angeles",
      stdout: stdout.sink,
      stderr: writer().sink,
    });
    const payload = cliForecastSchema.parse(JSON.parse(stdout.read()));

    expect(exitCode).toBe(0);
    expect(payload.apiVersion).toBe(1);
    expect(Array.isArray(payload)).toBe(false);
    expect(stdout.read()).not.toContain('"points"');
    expect(payload.riskRanking).toEqual([
      expect.objectContaining({
        rank: 1,
        accountAlias: "Codex_Work",
        limitKey: "codex.primary",
        projectionStatus: "exhausts_before_reset",
        minutesToExhaustion: 60,
      }),
    ]);
    expect(payload.accounts).toEqual([
      expect.objectContaining({
        limits: [
          expect.objectContaining({
            currentConsumedPercent: 60,
            ratePercentPerHour: 40,
            rateBasis: "epoch",
            sampleCount: 3,
            observationSpanMinutes: 30,
            resetAt,
            resetSource: "provider",
          }),
        ],
      }),
    ]);
    history.close();
  });

  it("reports insufficient history without fabricating an exhaustion time", async () => {
    const stdout = writer();
    await runCli(["--forecast", "--json"], {
      scan: () => Promise.resolve([fixture()]),
      now: () => new Date("2026-08-26T18:00:00.000Z"),
      stdout: stdout.sink,
      stderr: writer().sink,
    });
    const payload = cliForecastSchema.parse(JSON.parse(stdout.read()));

    expect(payload.historyHealth).toBe("unavailable");
    expect(payload.riskRanking).toEqual([]);
    expect(payload.accounts[0]?.limits[0]).toEqual(
      expect.objectContaining({
        projectionStatus: "insufficient_history",
        projectedExhaustionAt: null,
        projectedExhaustionRangeEndAt: null,
        minutesToExhaustion: null,
        sampleCount: 0,
        observationSpanMinutes: 0,
      }),
    );
  });

  it("preserves a fresh already-exhausted state without retained history", async () => {
    const stdout = writer();

    await runCli(["--forecast", "--json"], {
      scan: () => Promise.resolve([fixture(100)]),
      now: () => new Date("2026-08-26T18:00:00.000Z"),
      stdout: stdout.sink,
      stderr: writer().sink,
    });
    const payload = cliForecastSchema.parse(JSON.parse(stdout.read()));

    expect(payload.historyHealth).toBe("unavailable");
    expect(payload.accounts[0]?.limits[0]).toEqual(
      expect.objectContaining({
        currentConsumedPercent: 100,
        projectionStatus: "already_exhausted",
        projectedExhaustionAt: "2026-08-26T18:00:00.000Z",
        minutesToExhaustion: 0,
        sampleCount: 1,
      }),
    );
    expect(payload.riskRanking).toEqual([
      expect.objectContaining({
        accountAlias: "Codex_Work",
        projectionStatus: "already_exhausted",
        minutesToExhaustion: 0,
      }),
    ]);
  });

  it("reads forecast history before closing an owned service", async () => {
    const history = new HistoryService(
      openSqliteHistoryStore({
        filePath: ":memory:",
        rawRetentionHours: 6,
        hourlyRetentionDays: 30,
        retentionDays: 365,
      }),
    );
    const events: string[] = [];
    const readSeries = vi.spyOn(history, "readSeries");
    readSeries.mockImplementation(() => {
      events.push("read");
      return [];
    });
    vi.spyOn(history, "close").mockImplementation(() => {
      events.push("close");
    });

    await runCli(["--forecast"], {
      scan: () => Promise.resolve([fixture()]),
      createHistory: () => history,
      now: () => new Date("2026-08-26T18:00:00.000Z"),
      stdout: writer().sink,
      stderr: writer().sink,
    });

    expect(events).toEqual(["read", "close"]);
  });

  it("renders forecast text and Markdown only in explicit forecast mode", async () => {
    const text = writer();
    const markdown = writer();
    const dependencies = {
      scan: () => Promise.resolve([fixture()]),
      now: () => new Date("2026-08-26T18:00:00.000Z"),
      stderr: writer().sink,
    };

    await runCli(["--forecast"], { ...dependencies, stdout: text.sink });
    await runCli(["--forecast", "--format=md"], {
      ...dependencies,
      stdout: markdown.sink,
    });

    expect(text.read()).toContain("WHO EXHAUSTS NEXT");
    expect(text.read()).toContain("insufficient history");
    expect(markdown.read()).toContain("## Who exhausts next");
    expect(markdown.read()).toContain("| Limit | Consumed | Rate |");
  });

  it("keeps account-error exit codes unchanged in forecast mode", async () => {
    const stdout = writer();
    const failed: QuotaSnapshot = {
      accountAlias: "Claude_Personal",
      platform: "Claude",
      status: "error",
      plan: null,
      limits: [],
      observedAt: "2026-08-26T18:00:00.000Z",
      error: { code: "timeout", message: "Usage check timed out." },
    };

    const exitCode = await runCli(["--forecast", "--json"], {
      scan: () => Promise.resolve([failed]),
      now: () => new Date("2026-08-26T18:00:00.000Z"),
      stdout: stdout.sink,
      stderr: writer().sink,
    });

    expect(exitCode).toBe(1);
    const account = cliForecastSchema.parse(JSON.parse(stdout.read()))
      .accounts[0];
    expect(account?.accountAlias).toBe("Claude_Personal");
    expect(account?.status).toBe("error");
    expect(account?.error?.code).toBe("timeout");
  });

  it("keeps the current snapshot when retained history becomes unreadable", async () => {
    const history = new HistoryService(
      openSqliteHistoryStore({
        filePath: ":memory:",
        rawRetentionHours: 6,
        hourlyRetentionDays: 30,
        retentionDays: 365,
      }),
    );
    history.close();
    const stdout = writer();

    const exitCode = await runCli(["--forecast", "--json"], {
      scan: () => Promise.resolve([fixture(100)]),
      history,
      now: () => new Date("2026-08-26T18:00:00.000Z"),
      stdout: stdout.sink,
      stderr: writer().sink,
    });
    const payload = cliForecastSchema.parse(JSON.parse(stdout.read()));

    expect(exitCode).toBe(0);
    expect(payload.historyHealth).toBe("degraded");
    expect(payload.accounts[0]?.limits[0]).toEqual(
      expect.objectContaining({
        currentConsumedPercent: 100,
        projectionStatus: "already_exhausted",
        projectedExhaustionAt: "2026-08-26T18:00:00.000Z",
      }),
    );
  });
});
