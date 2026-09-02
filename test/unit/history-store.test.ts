import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  quotaSnapshotSchema,
  quotaSuccessSchema,
  type QuotaSnapshot,
} from "../../src/domain/quota.js";
import {
  openSqliteHistoryStore,
  SqliteHistoryStore,
  type HistoryStore,
} from "../../src/history/sqlite-store.js";

const temporaryDirectories: string[] = [];

function directory(): string {
  const value = mkdtempSync(join(tmpdir(), "seat-monitor-history-test-"));
  temporaryDirectories.push(value);
  return value;
}

afterEach(() => {
  for (const value of temporaryDirectories.splice(0)) {
    rmSync(value, { force: true, recursive: true });
  }
});

function snapshot(
  observedAt: string,
  usedPercent: number,
  resetAt: string,
): QuotaSnapshot {
  return quotaSuccessSchema.parse({
    accountAlias: "claude-history@example.com",
    platform: "Claude",
    status: "ok",
    plan: "max",
    observedAt,
    limits: [
      {
        key: "base.weekly",
        label: "Current Week (All Models)",
        scope: "window",
        availability: "available",
        usedPercent,
        windowDurationMinutes: null,
        resetAt,
      },
    ],
  });
}

function open(
  filePath: string,
  now: string,
  rawRetentionDays = 30,
  retentionDays = 365,
): HistoryStore {
  return openSqliteHistoryStore(
    { filePath, rawRetentionDays, retentionDays },
    { now: () => new Date(now) },
  );
}

describe("SQLite history store", () => {
  it("round-trips normalized success and error snapshots after reopen", () => {
    const filePath = join(directory(), "state", "history.sqlite3");
    const observedAt = "2026-09-02T17:00:00.000Z";
    const success = snapshot(observedAt, 42, "2026-09-05T17:00:00.000Z");
    const failure = quotaSnapshotSchema.parse({
      accountAlias: "codex-error@example.com",
      platform: "Codex",
      observedAt,
      status: "error",
      plan: null,
      limits: [],
      error: { code: "timeout", message: "Codex account check timed out." },
    });

    const first = open(filePath, observedAt);
    first.recordScan("cli", [success, failure], new Date(observedAt));
    first.close();

    const reopened = open(filePath, observedAt);
    const runs = reopened.listScans({
      fromMilliseconds: Date.parse("2026-09-01T00:00:00.000Z"),
      toMilliseconds: Date.parse("2026-09-03T00:00:00.000Z"),
      limit: 10,
    });
    reopened.close();

    expect(runs).toEqual([
      expect.objectContaining({
        source: "cli",
        snapshots: [success, failure],
      }),
    ]);
    if (process.platform !== "win32") {
      expect(statSync(filePath).mode & 0o777).toBe(0o600);
      expect(statSync(dirname(filePath)).mode & 0o777).toBe(0o700);
    }
  });

  it("rolls expired raw points into hours before pruning scans", () => {
    const now = "2026-09-10T12:00:00.000Z";
    const store = open(":memory:", now, 1, 10);
    const oldAt = "2026-09-08T10:05:00.000Z";
    const secondOldAt = "2026-09-08T10:35:00.000Z";
    const resetAt = "2026-09-09T10:00:00.000Z";
    store.recordScan("server", [snapshot(oldAt, 10, resetAt)], new Date(oldAt));
    store.recordScan(
      "server",
      [snapshot(secondOldAt, 18, resetAt)],
      new Date(secondOldAt),
    );
    store.maintain(new Date(now));

    expect(
      store.listScans({
        fromMilliseconds: Date.parse("2026-09-08T00:00:00.000Z"),
        toMilliseconds: Date.parse("2026-09-09T00:00:00.000Z"),
        limit: 10,
      }),
    ).toEqual([]);
    const series = store.readSeries({
      fromMilliseconds: Date.parse("2026-09-08T00:00:00.000Z"),
      toMilliseconds: Date.parse("2026-09-09T00:00:00.000Z"),
      resolution: "hour",
    });
    expect(series[0]?.points).toEqual([
      expect.objectContaining({
        usedPercent: 18,
        minimumUsedPercent: 10,
        maximumUsedPercent: 18,
        sampleCount: 2,
        resolution: "hour",
      }),
    ]);
    expect(
      store.listResetEvents({
        fromMilliseconds: Date.parse("2026-09-08T00:00:00.000Z"),
        toMilliseconds: Date.parse("2026-09-10T00:00:00.000Z"),
        resolution: "auto",
      }),
    ).toEqual([
      expect.objectContaining({
        limitKey: "base.weekly",
        resetAt,
        kind: "provider",
      }),
    ]);
    store.close();
  });

  it("filters raw series by account without exposing the account key", () => {
    const now = "2026-09-02T18:00:00.000Z";
    const store = open(":memory:", now);
    store.recordScan(
      "server",
      [snapshot("2026-09-02T17:00:00.000Z", 10, "2026-09-05T17:00:00.000Z")],
      new Date("2026-09-02T17:00:00.000Z"),
    );
    const series = store.readSeries({
      fromMilliseconds: Date.parse("2026-09-02T16:00:00.000Z"),
      toMilliseconds: Date.parse(now),
      resolution: "raw",
      accountAlias: "CLAUDE-HISTORY@EXAMPLE.COM",
    });
    store.close();

    expect(series).toEqual([
      expect.objectContaining({
        accountAlias: "claude-history@example.com",
        points: [expect.objectContaining({ usedPercent: 10 })],
      }),
    ]);
    expect(JSON.stringify(series)).not.toContain("accountKey");
  });

  it("refuses to downgrade a newer database schema", () => {
    const database = new DatabaseSync(":memory:");
    database.exec("PRAGMA user_version = 2");

    expect(
      () =>
        new SqliteHistoryStore(database, {
          filePath: ":memory:",
          rawRetentionDays: 30,
          retentionDays: 365,
        }),
    ).toThrow("newer than this version");
    database.close();
  });
});
