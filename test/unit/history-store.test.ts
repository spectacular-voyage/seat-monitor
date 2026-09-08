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
  rawRetentionHours = 6,
  hourlyRetentionDays = 30,
  retentionDays = 365,
): HistoryStore {
  return openSqliteHistoryStore(
    { filePath, rawRetentionHours, hourlyRetentionDays, retentionDays },
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
    const store = open(":memory:", now, 24, 5, 10);
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
        lastSeenAt: secondOldAt,
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
    database.exec("PRAGMA user_version = 3");

    expect(
      () =>
        new SqliteHistoryStore(database, {
          filePath: ":memory:",
          rawRetentionHours: 6,
          hourlyRetentionDays: 30,
          retentionDays: 365,
        }),
    ).toThrow("newer than this version");
    database.close();
  });

  it("migrates reset events to retain their last observation", () => {
    const database = new DatabaseSync(":memory:");
    database.exec(`
      CREATE TABLE reset_events (
        account_key TEXT NOT NULL,
        account_alias TEXT NOT NULL,
        platform TEXT NOT NULL,
        limit_key TEXT NOT NULL,
        reset_at_ms INTEGER NOT NULL,
        first_seen_at_ms INTEGER NOT NULL,
        kind TEXT NOT NULL,
        PRIMARY KEY(account_key, limit_key, reset_at_ms, kind)
      ) STRICT;
      INSERT INTO reset_events VALUES (
        'account', 'claude-history@example.com', 'Claude', 'base.weekly',
        1788969600000, 1788364800000, 'provider'
      );
      PRAGMA user_version = 1;
    `);

    const store = new SqliteHistoryStore(database, {
      filePath: ":memory:",
      rawRetentionHours: 6,
      hourlyRetentionDays: 30,
      retentionDays: 365,
    });
    const version = database.prepare("PRAGMA user_version").get() as {
      user_version: number;
    };
    const event = database
      .prepare("SELECT first_seen_at_ms, last_seen_at_ms FROM reset_events")
      .get();
    const dailyTable = database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'daily_limit_rollups'",
      )
      .get();

    expect(version.user_version).toBe(2);
    expect(dailyTable).toEqual({ name: "daily_limit_rollups" });
    expect(event).toEqual({
      first_seen_at_ms: 1_788_364_800_000,
      last_seen_at_ms: 1_788_364_800_000,
    });
    store.close();
  });

  it("adds the daily tier to a version 2 database", () => {
    const database = new DatabaseSync(":memory:");
    database.exec("PRAGMA user_version = 2");

    const store = new SqliteHistoryStore(database, {
      filePath: ":memory:",
      rawRetentionHours: 6,
      hourlyRetentionDays: 30,
      retentionDays: 365,
    });
    const version = database.prepare("PRAGMA user_version").get() as {
      user_version: number;
    };
    const dailyTable = database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'daily_limit_rollups'",
      )
      .get();

    expect(version.user_version).toBe(2);
    expect(dailyTable).toEqual({ name: "daily_limit_rollups" });
    store.close();
  });

  it("continuously compacts raw scans into hourly and daily tiers", () => {
    const now = "2026-09-10T12:07:00.000Z";
    const store = open(":memory:", now, 6, 2, 10);
    const resetAt = "2026-09-12T12:00:00.000Z";
    const observations = [
      ["2026-09-06T10:05:00.000Z", 10],
      ["2026-09-06T11:05:00.000Z", 20],
      ["2026-09-09T10:05:00.000Z", 30],
      ["2026-09-09T10:35:00.000Z", 40],
      ["2026-09-10T10:30:00.000Z", 50],
    ] as const;
    for (const [observedAt, usedPercent] of observations) {
      store.recordScan(
        "server",
        [snapshot(observedAt, usedPercent, resetAt)],
        new Date(observedAt),
      );
    }

    store.maintain(new Date(now));

    const points = store.readSeries({
      fromMilliseconds: Date.parse("2026-09-01T00:00:00.000Z"),
      toMilliseconds: Date.parse("2026-09-11T00:00:00.000Z"),
      resolution: "auto",
    })[0]?.points;
    expect(points).toEqual([
      expect.objectContaining({
        resolution: "day",
        usedPercent: 20,
        sampleCount: 2,
      }),
      expect.objectContaining({
        resolution: "hour",
        usedPercent: 40,
        sampleCount: 2,
      }),
      expect.objectContaining({
        resolution: "raw",
        usedPercent: 50,
        sampleCount: 1,
      }),
    ]);
    expect(
      store.listScans({
        fromMilliseconds: Date.parse("2026-09-01T00:00:00.000Z"),
        toMilliseconds: Date.parse("2026-09-11T00:00:00.000Z"),
        limit: 10,
      }),
    ).toHaveLength(1);
    store.close();
  });

  it("bounds auto-resolution points while preserving sample counts", () => {
    const now = Date.parse("2026-09-10T12:07:00.000Z");
    const store = open(":memory:", new Date(now).toISOString(), 6, 1, 10);
    const resetAt = new Date(now + 24 * 60 * 60_000).toISOString();
    const sampleCount = 3 * 24 * 60;
    for (let index = sampleCount; index > 0; index -= 1) {
      const observedAt = new Date(now - index * 60_000).toISOString();
      store.recordScan(
        "server",
        [snapshot(observedAt, index % 100, resetAt)],
        new Date(observedAt),
      );
    }

    store.maintain(new Date(now));
    const fromMilliseconds =
      Math.floor((now - 3 * 24 * 60 * 60_000) / (24 * 60 * 60_000)) *
      (24 * 60 * 60_000);
    const points = store.readSeries({
      fromMilliseconds,
      toMilliseconds: now,
      resolution: "auto",
    })[0]?.points;

    expect(points?.length).toBeLessThan(450);
    expect(points?.reduce((total, point) => total + point.sampleCount, 0)).toBe(
      sampleCount,
    );
    expect(new Set(points?.map((point) => point.resolution))).toEqual(
      new Set(["raw", "hour", "day"]),
    );
    store.close();
  });
});
