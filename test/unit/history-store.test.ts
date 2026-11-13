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

  it("holds an analytics read's pages in its own cache", () => {
    const database = new DatabaseSync(":memory:");
    const store = new SqliteHistoryStore(database, {
      filePath: ":memory:",
      rawRetentionHours: 6,
      hourlyRetentionDays: 30,
      retentionDays: 365,
    });
    expect(database.prepare("PRAGMA cache_size").get()).toEqual({
      cache_size: -16_384,
    });
    store.close();
  });

  it("keeps one reset event per reset, however its time jitters or rolls", () => {
    const database = new DatabaseSync(":memory:");
    const store = new SqliteHistoryStore(database, {
      filePath: ":memory:",
      rawRetentionHours: 6,
      hourlyRetentionDays: 30,
      retentionDays: 365,
    });
    const start = Date.parse("2026-09-01T00:00:00.000Z");
    const record = (minute: number, resetAt: number) => {
      const observedAt = new Date(start + minute * 60_000).toISOString();
      store.recordScan(
        "server",
        [snapshot(observedAt, 10, new Date(resetAt).toISOString())],
        new Date(observedAt),
      );
    };
    // An unstarted window reports "now plus the window" on every scan.
    for (let minute = 0; minute < 10; minute += 1) {
      record(minute, start + minute * 60_000 + 7 * 86_400_000);
    }
    // Once started, the reset is fixed but its reported time jitters.
    const fixed = start + 9 * 60_000 + 7 * 86_400_000;
    for (let minute = 10; minute < 20; minute += 1) {
      record(minute, fixed + (minute % 2 === 0 ? 0 : 975));
    }
    const rows = () =>
      database
        .prepare(
          "SELECT reset_at_ms, first_seen_at_ms, last_seen_at_ms FROM reset_events ORDER BY last_seen_at_ms",
        )
        .all();
    expect(rows()).toEqual([
      {
        reset_at_ms: fixed + 975,
        first_seen_at_ms: start,
        last_seen_at_ms: start + 19 * 60_000,
      },
    ]);

    // The next week's reset is a new event.
    record(7 * 24 * 60 + 30, fixed + 7 * 86_400_000);
    expect(rows()).toHaveLength(2);
    expect(
      store.listResetEvents({
        fromMilliseconds: start,
        toMilliseconds: start + 30 * 86_400_000,
        resolution: "auto",
      }),
    ).toEqual([
      expect.objectContaining({
        resetAt: new Date(fixed + 975).toISOString(),
      }),
      expect.objectContaining({
        resetAt: new Date(fixed + 7 * 86_400_000).toISOString(),
      }),
    ]);
    store.close();
  });

  it("compacts reset events written one per scan without changing the latest", () => {
    const database = new DatabaseSync(":memory:");
    const store = new SqliteHistoryStore(database, {
      filePath: ":memory:",
      rawRetentionHours: 6,
      hourlyRetentionDays: 30,
      retentionDays: 365,
    });
    const start = Date.parse("2026-09-01T00:00:00.000Z");
    const insert = database.prepare(`
      INSERT INTO reset_events(
        account_key, account_alias, platform, limit_key, reset_at_ms,
        first_seen_at_ms, last_seen_at_ms, kind
      ) VALUES (?, 'alias', 'Codex', ?, ?, ?, ?, 'provider')
    `);
    // Rows as older releases wrote them: one per scan of an unstarted
    // window, then a fixed reset, then the next window.
    for (let minute = 0; minute < 300; minute += 1) {
      const seen = start + minute * 60_000;
      insert.run("account", "codex.primary", seen + 18_000_000, seen, seen);
    }
    const nextWindow = start + 299 * 60_000 + 18_000_000;
    insert.run(
      "account",
      "codex.primary",
      nextWindow + 18_000_000,
      nextWindow + 60_000,
      nextWindow + 60_000,
    );
    insert.run("other", "codex.primary", start, start, start);
    const latestBefore = store.listResetEvents({
      fromMilliseconds: 0,
      toMilliseconds: start + 86_400_000,
      resolution: "auto",
    });

    store.maintain(new Date(start + 86_400_000));

    expect(
      database
        .prepare(
          "SELECT account_key, reset_at_ms, first_seen_at_ms, last_seen_at_ms FROM reset_events ORDER BY account_key, last_seen_at_ms",
        )
        .all(),
    ).toEqual([
      {
        account_key: "account",
        reset_at_ms: start + 299 * 60_000 + 18_000_000,
        first_seen_at_ms: start,
        last_seen_at_ms: start + 299 * 60_000,
      },
      {
        account_key: "account",
        reset_at_ms: nextWindow + 18_000_000,
        first_seen_at_ms: nextWindow + 60_000,
        last_seen_at_ms: nextWindow + 60_000,
      },
      {
        account_key: "other",
        reset_at_ms: start,
        first_seen_at_ms: start,
        last_seen_at_ms: start,
      },
    ]);
    const latestAfter = store.listResetEvents({
      fromMilliseconds: 0,
      toMilliseconds: start + 86_400_000,
      resolution: "auto",
    });
    expect(latestAfter.at(-1)).toEqual(latestBefore.at(-1));
    expect(
      database
        .prepare(
          "SELECT value FROM history_metadata WHERE key = 'reset_events_compacted_ms'",
        )
        .get(),
    ).toEqual({ value: String(start + 86_400_000) });
    store.close();
  });

  it("returns the space compaction frees to the file system", () => {
    const filePath = join(directory(), "history.sqlite3");
    const database = new DatabaseSync(filePath);
    database.exec("PRAGMA journal_mode = WAL;");
    const store = new SqliteHistoryStore(database, {
      filePath,
      rawRetentionHours: 6,
      hourlyRetentionDays: 30,
      retentionDays: 365,
    });
    const start = Date.parse("2026-09-01T00:00:00.000Z");
    const insert = database.prepare(`
      INSERT INTO reset_events(
        account_key, account_alias, platform, limit_key, reset_at_ms,
        first_seen_at_ms, last_seen_at_ms, kind
      ) VALUES (?, 'alias', 'Claude', 'base.session', ?, ?, ?, 'provider')
    `);
    database.exec("BEGIN");
    for (let minute = 0; minute < 40_000; minute += 1) {
      const seen = start + minute * 60_000;
      insert.run("a".repeat(64), seen + 18_000_000, seen, seen);
    }
    database.exec("COMMIT; PRAGMA wal_checkpoint(TRUNCATE);");
    const before = statSync(filePath).size;

    store.maintain(new Date(start + 40_000 * 60_000));

    expect(
      database.prepare("SELECT COUNT(*) AS count FROM reset_events").get(),
    ).toEqual({ count: 1 });
    expect(before).toBeGreaterThan(8 * 1_048_576);
    expect(statSync(filePath).size).toBeLessThan(1_048_576);
    store.close();
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
