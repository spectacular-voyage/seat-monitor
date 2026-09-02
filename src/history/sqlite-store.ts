import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import {
  quotaSnapshotSchema,
  type Platform,
  type QuotaLimit,
  type QuotaSnapshot,
} from "../domain/quota.js";
import type { HistoryConfiguration } from "./config.js";
import type {
  HistoryLimitSeries,
  HistoryResetEvent,
  HistoryResolution,
  HistorySeriesPoint,
  ScanHistoryQuery,
  ScanSource,
  SeriesHistoryQuery,
  StoredScanRun,
} from "./types.js";

const DAY_MILLISECONDS = 86_400_000;
const HOUR_MILLISECONDS = 3_600_000;

type RunRow = {
  id: number;
  source: string;
  completed_at_ms: number;
};

type AccountRow = {
  id: number;
  account_alias: string;
  platform: string;
  observed_at_ms: number;
  status: string;
  plan: string | null;
  error_code: string | null;
  error_message: string | null;
};

type LimitRow = {
  limit_key: string;
  label: string;
  scope: string;
  availability: string;
  used_percent: number | null;
  window_duration_minutes: number | null;
  reset_at_ms: number | null;
};

type RawSeriesRow = LimitRow & {
  account_key: string;
  account_alias: string;
  platform: string;
  plan: string | null;
  observed_at_ms: number;
};

type RollupRow = {
  account_key: string;
  account_alias: string;
  platform: string;
  plan: string | null;
  limit_key: string;
  label: string;
  scope: string;
  availability: string;
  bucket_start_ms: number;
  sample_count: number;
  last_used_percent: number | null;
  minimum_used_percent: number | null;
  maximum_used_percent: number | null;
  last_reset_at_ms: number | null;
  last_window_duration_minutes: number | null;
};

type ResetRow = {
  account_alias: string;
  platform: string;
  limit_key: string;
  reset_at_ms: number;
};

type SeriesRecord = {
  accountKey: string;
  accountAlias: string;
  platform: Platform;
  plan: string | null;
  limit: Pick<QuotaLimit, "key" | "label" | "scope" | "availability">;
  point: HistorySeriesPoint;
};

type HourAccumulator = {
  template: RawSeriesRow;
  bucketStart: number;
  sampleCount: number;
  firstUsed: number | null;
  lastUsed: number | null;
  minimumUsed: number | null;
  maximumUsed: number | null;
  usedSum: number;
  usedCount: number;
  lastResetAt: number | null;
  lastWindowDuration: number | null;
};

export type HistoryStore = {
  recordScan(
    source: ScanSource,
    snapshots: readonly QuotaSnapshot[],
    completedAt: Date,
  ): void;
  listScans(query: ScanHistoryQuery): StoredScanRun[];
  readSeries(query: SeriesHistoryQuery): HistoryLimitSeries[];
  listResetEvents(query: SeriesHistoryQuery): HistoryResetEvent[];
  maintain(now: Date): void;
  close(): void;
};

function asNumber(value: number | bigint): number {
  const converted = Number(value);
  if (!Number.isSafeInteger(converted)) {
    throw new RangeError("SQLite identifier exceeds the safe integer range.");
  }
  return converted;
}

function accountKey(snapshot: QuotaSnapshot): string {
  return createHash("sha256")
    .update(snapshot.platform)
    .update("\0")
    .update(snapshot.accountAlias.toLocaleLowerCase("en-US"))
    .digest("hex");
}

function instant(milliseconds: number | null): string | null {
  return milliseconds === null ? null : new Date(milliseconds).toISOString();
}

function platform(value: string): Platform {
  if (value !== "Claude" && value !== "Codex") {
    throw new TypeError("Stored history contains an invalid platform.");
  }
  return value;
}

function scope(value: string): QuotaLimit["scope"] {
  if (value !== "global" && value !== "model" && value !== "window") {
    throw new TypeError("Stored history contains an invalid limit scope.");
  }
  return value;
}

function availability(value: string): QuotaLimit["availability"] {
  if (value !== "available" && value !== "unsupported") {
    throw new TypeError("Stored history contains invalid availability.");
  }
  return value;
}

function createSchema(database: DatabaseSync): void {
  const versionRow = database.prepare("PRAGMA user_version").get() as
    { user_version?: number } | undefined;
  const version = versionRow?.user_version ?? 0;
  if (version > 1) {
    throw new TypeError("History database schema is newer than this version.");
  }
  if (version === 1) {
    database.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    return;
  }
  database.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS history_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS scan_runs (
      id INTEGER PRIMARY KEY,
      source TEXT NOT NULL CHECK (source IN ('cli', 'server')),
      completed_at_ms INTEGER NOT NULL,
      account_count INTEGER NOT NULL CHECK (account_count >= 0),
      error_count INTEGER NOT NULL CHECK (error_count >= 0)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS scan_runs_completed_idx
      ON scan_runs(completed_at_ms DESC, id DESC);
    CREATE TABLE IF NOT EXISTS account_snapshots (
      id INTEGER PRIMARY KEY,
      scan_run_id INTEGER NOT NULL REFERENCES scan_runs(id) ON DELETE CASCADE,
      account_key TEXT NOT NULL,
      account_alias TEXT NOT NULL,
      platform TEXT NOT NULL CHECK (platform IN ('Claude', 'Codex')),
      observed_at_ms INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('ok', 'error')),
      plan TEXT,
      error_code TEXT,
      error_message TEXT,
      CHECK (
        (status = 'ok' AND error_code IS NULL AND error_message IS NULL) OR
        (status = 'error' AND plan IS NULL AND error_code IS NOT NULL AND error_message IS NOT NULL)
      )
    ) STRICT;
    CREATE INDEX IF NOT EXISTS account_snapshots_series_idx
      ON account_snapshots(account_key, observed_at_ms);
    CREATE TABLE IF NOT EXISTS limit_snapshots (
      id INTEGER PRIMARY KEY,
      account_snapshot_id INTEGER NOT NULL REFERENCES account_snapshots(id) ON DELETE CASCADE,
      limit_key TEXT NOT NULL,
      label TEXT NOT NULL,
      scope TEXT NOT NULL CHECK (scope IN ('global', 'model', 'window')),
      availability TEXT NOT NULL CHECK (availability IN ('available', 'unsupported')),
      used_percent REAL,
      window_duration_minutes REAL,
      reset_at_ms INTEGER,
      UNIQUE(account_snapshot_id, limit_key),
      CHECK (used_percent IS NULL OR (used_percent >= 0 AND used_percent <= 100)),
      CHECK (window_duration_minutes IS NULL OR window_duration_minutes > 0)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS limit_snapshots_key_idx
      ON limit_snapshots(limit_key, account_snapshot_id);
    CREATE TABLE IF NOT EXISTS reset_events (
      account_key TEXT NOT NULL,
      account_alias TEXT NOT NULL,
      platform TEXT NOT NULL CHECK (platform IN ('Claude', 'Codex')),
      limit_key TEXT NOT NULL,
      reset_at_ms INTEGER NOT NULL,
      first_seen_at_ms INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK (kind = 'provider'),
      PRIMARY KEY(account_key, limit_key, reset_at_ms, kind)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS reset_events_time_idx
      ON reset_events(reset_at_ms);
    CREATE TABLE IF NOT EXISTS hourly_limit_rollups (
      account_key TEXT NOT NULL,
      account_alias TEXT NOT NULL,
      platform TEXT NOT NULL CHECK (platform IN ('Claude', 'Codex')),
      plan TEXT,
      limit_key TEXT NOT NULL,
      label TEXT NOT NULL,
      scope TEXT NOT NULL CHECK (scope IN ('global', 'model', 'window')),
      availability TEXT NOT NULL CHECK (availability IN ('available', 'unsupported')),
      bucket_start_ms INTEGER NOT NULL,
      sample_count INTEGER NOT NULL CHECK (sample_count > 0),
      first_used_percent REAL,
      last_used_percent REAL,
      minimum_used_percent REAL,
      maximum_used_percent REAL,
      average_used_percent REAL,
      last_reset_at_ms INTEGER,
      last_window_duration_minutes REAL,
      PRIMARY KEY(account_key, limit_key, bucket_start_ms)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS hourly_rollups_time_idx
      ON hourly_limit_rollups(bucket_start_ms);
    PRAGMA user_version = 1;
  `);
}

function aggregateHours(rows: readonly RawSeriesRow[]): HourAccumulator[] {
  const buckets = new Map<string, HourAccumulator>();
  for (const row of rows) {
    const bucketStart =
      Math.floor(row.observed_at_ms / HOUR_MILLISECONDS) * HOUR_MILLISECONDS;
    const key = `${row.account_key}\0${row.limit_key}\0${String(bucketStart)}`;
    let bucket = buckets.get(key);
    if (bucket === undefined) {
      bucket = {
        template: row,
        bucketStart,
        sampleCount: 0,
        firstUsed: row.used_percent,
        lastUsed: row.used_percent,
        minimumUsed: row.used_percent,
        maximumUsed: row.used_percent,
        usedSum: 0,
        usedCount: 0,
        lastResetAt: row.reset_at_ms,
        lastWindowDuration: row.window_duration_minutes,
      };
      buckets.set(key, bucket);
    }
    bucket.sampleCount += 1;
    bucket.lastUsed = row.used_percent;
    bucket.lastResetAt = row.reset_at_ms;
    bucket.lastWindowDuration = row.window_duration_minutes;
    bucket.template = row;
    if (row.used_percent !== null) {
      bucket.usedSum += row.used_percent;
      bucket.usedCount += 1;
      bucket.minimumUsed =
        bucket.minimumUsed === null
          ? row.used_percent
          : Math.min(bucket.minimumUsed, row.used_percent);
      bucket.maximumUsed =
        bucket.maximumUsed === null
          ? row.used_percent
          : Math.max(bucket.maximumUsed, row.used_percent);
    }
  }
  return [...buckets.values()];
}

function groupSeries(records: readonly SeriesRecord[]): HistoryLimitSeries[] {
  const grouped = new Map<string, HistoryLimitSeries>();
  for (const record of records) {
    const key = `${record.accountKey}\0${record.limit.key}`;
    let series = grouped.get(key);
    if (series === undefined) {
      series = {
        accountAlias: record.accountAlias,
        platform: record.platform,
        plan: record.plan,
        limit: record.limit,
        points: [],
      };
      grouped.set(key, series);
    }
    series.accountAlias = record.accountAlias;
    series.plan = record.plan;
    series.limit = record.limit;
    series.points.push(record.point);
  }
  return [...grouped.values()]
    .map((series) => ({
      ...series,
      points: series.points.sort(
        (left, right) =>
          Date.parse(left.observedAt) - Date.parse(right.observedAt),
      ),
    }))
    .sort(
      (left, right) =>
        left.platform.localeCompare(right.platform) ||
        left.accountAlias.localeCompare(right.accountAlias) ||
        left.limit.key.localeCompare(right.limit.key),
    );
}

export class SqliteHistoryStore implements HistoryStore {
  readonly #database: DatabaseSync;
  readonly #configuration: HistoryConfiguration;
  readonly #now: () => Date;

  public constructor(
    database: DatabaseSync,
    configuration: HistoryConfiguration,
    now: () => Date = () => new Date(),
  ) {
    this.#database = database;
    this.#configuration = configuration;
    this.#now = now;
    createSchema(database);
  }

  public recordScan(
    source: ScanSource,
    snapshots: readonly QuotaSnapshot[],
    completedAt: Date,
  ): void {
    const insertRun = this.#database.prepare(`
      INSERT INTO scan_runs(source, completed_at_ms, account_count, error_count)
      VALUES (?, ?, ?, ?)
    `);
    const insertAccount = this.#database.prepare(`
      INSERT INTO account_snapshots(
        scan_run_id, account_key, account_alias, platform, observed_at_ms,
        status, plan, error_code, error_message
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertLimit = this.#database.prepare(`
      INSERT INTO limit_snapshots(
        account_snapshot_id, limit_key, label, scope, availability,
        used_percent, window_duration_minutes, reset_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertReset = this.#database.prepare(`
      INSERT OR IGNORE INTO reset_events(
        account_key, account_alias, platform, limit_key, reset_at_ms,
        first_seen_at_ms, kind
      ) VALUES (?, ?, ?, ?, ?, ?, 'provider')
    `);

    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const runResult = insertRun.run(
        source,
        completedAt.getTime(),
        snapshots.length,
        snapshots.filter((snapshot) => snapshot.status === "error").length,
      );
      const runId = asNumber(runResult.lastInsertRowid);
      for (const snapshot of snapshots) {
        const key = accountKey(snapshot);
        const accountResult = insertAccount.run(
          runId,
          key,
          snapshot.accountAlias,
          snapshot.platform,
          Date.parse(snapshot.observedAt),
          snapshot.status,
          snapshot.plan,
          snapshot.status === "error" ? snapshot.error.code : null,
          snapshot.status === "error" ? snapshot.error.message : null,
        );
        const accountSnapshotId = asNumber(accountResult.lastInsertRowid);
        if (snapshot.status === "ok") {
          for (const limit of snapshot.limits) {
            insertLimit.run(
              accountSnapshotId,
              limit.key,
              limit.label,
              limit.scope,
              limit.availability,
              limit.usedPercent,
              limit.windowDurationMinutes,
              limit.resetAt === null ? null : Date.parse(limit.resetAt),
            );
            if (limit.resetAt !== null) {
              insertReset.run(
                key,
                snapshot.accountAlias,
                snapshot.platform,
                limit.key,
                Date.parse(limit.resetAt),
                Date.parse(snapshot.observedAt),
              );
            }
          }
        }
      }
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  public listScans(query: ScanHistoryQuery): StoredScanRun[] {
    const conditions = ["completed_at_ms >= ?", "completed_at_ms <= ?"];
    const parameters: SQLInputValue[] = [
      query.fromMilliseconds,
      query.toMilliseconds,
    ];
    if (query.beforeId !== undefined) {
      conditions.push("id < ?");
      parameters.push(query.beforeId);
    }
    parameters.push(query.limit);
    const runs = this.#database
      .prepare(
        `SELECT id, source, completed_at_ms FROM scan_runs
         WHERE ${conditions.join(" AND ")}
         ORDER BY id DESC LIMIT ?`,
      )
      .all(...parameters) as unknown as RunRow[];
    const readAccounts = this.#database.prepare(`
      SELECT id, account_alias, platform, observed_at_ms, status, plan,
             error_code, error_message
      FROM account_snapshots WHERE scan_run_id = ? ORDER BY id
    `);
    const readLimits = this.#database.prepare(`
      SELECT limit_key, label, scope, availability, used_percent,
             window_duration_minutes, reset_at_ms
      FROM limit_snapshots WHERE account_snapshot_id = ? ORDER BY id
    `);

    return runs.map((run): StoredScanRun => {
      const accounts = readAccounts.all(run.id) as unknown as AccountRow[];
      const snapshots = accounts.map((account): QuotaSnapshot => {
        const base = {
          accountAlias: account.account_alias,
          platform: platform(account.platform),
          observedAt: new Date(account.observed_at_ms).toISOString(),
        };
        if (account.status === "error") {
          return quotaSnapshotSchema.parse({
            ...base,
            status: "error",
            plan: null,
            limits: [],
            error: {
              code: account.error_code,
              message: account.error_message,
            },
          });
        }
        const rows = readLimits.all(account.id) as unknown as LimitRow[];
        return quotaSnapshotSchema.parse({
          ...base,
          status: "ok",
          plan: account.plan,
          limits: rows.map((limit) => ({
            key: limit.limit_key,
            label: limit.label,
            scope: scope(limit.scope),
            availability: availability(limit.availability),
            usedPercent: limit.used_percent,
            windowDurationMinutes: limit.window_duration_minutes,
            resetAt: instant(limit.reset_at_ms),
          })),
        });
      });
      if (run.source !== "cli" && run.source !== "server") {
        throw new TypeError("Stored history contains an invalid scan source.");
      }
      return {
        id: run.id,
        source: run.source,
        completedAt: new Date(run.completed_at_ms).toISOString(),
        snapshots,
      };
    });
  }

  public readSeries(query: SeriesHistoryQuery): HistoryLimitSeries[] {
    const nowMilliseconds = this.#now().getTime();
    const rawBoundary =
      nowMilliseconds - this.#configuration.rawRetentionDays * DAY_MILLISECONDS;
    const records: SeriesRecord[] = [];

    const addRaw = (
      fromMilliseconds: number,
      toMilliseconds: number,
      resolution: Exclude<HistoryResolution, "auto">,
    ): void => {
      if (fromMilliseconds >= toMilliseconds) {
        return;
      }
      const rows = this.#readRawRows(
        fromMilliseconds,
        toMilliseconds,
        query.accountAlias,
      );
      if (resolution === "raw") {
        for (const row of rows) {
          records.push(this.#rawRecord(row));
        }
        return;
      }
      for (const bucket of aggregateHours(rows)) {
        records.push(this.#hourRecord(bucket));
      }
    };

    const addRollups = (
      fromMilliseconds: number,
      toMilliseconds: number,
    ): void => {
      if (fromMilliseconds >= toMilliseconds) {
        return;
      }
      for (const row of this.#readRollupRows(
        fromMilliseconds,
        toMilliseconds,
        query.accountAlias,
      )) {
        records.push(this.#rollupRecord(row));
      }
    };

    if (query.resolution === "raw") {
      addRaw(query.fromMilliseconds, query.toMilliseconds, "raw");
    } else if (query.resolution === "hour") {
      addRollups(
        query.fromMilliseconds,
        Math.min(query.toMilliseconds, rawBoundary),
      );
      addRaw(
        Math.max(query.fromMilliseconds, rawBoundary),
        query.toMilliseconds,
        "hour",
      );
    } else {
      addRollups(
        query.fromMilliseconds,
        Math.min(query.toMilliseconds, rawBoundary),
      );
      addRaw(
        Math.max(query.fromMilliseconds, rawBoundary),
        query.toMilliseconds,
        "raw",
      );
    }
    return groupSeries(records);
  }

  public listResetEvents(query: SeriesHistoryQuery): HistoryResetEvent[] {
    const conditions = ["reset_at_ms >= ?", "reset_at_ms <= ?"];
    const parameters: SQLInputValue[] = [
      query.fromMilliseconds,
      query.toMilliseconds,
    ];
    if (query.accountAlias !== undefined) {
      conditions.push("account_alias = ? COLLATE NOCASE");
      parameters.push(query.accountAlias);
    }
    const rows = this.#database
      .prepare(
        `SELECT account_alias, platform, limit_key, reset_at_ms
         FROM reset_events WHERE ${conditions.join(" AND ")}
         ORDER BY reset_at_ms`,
      )
      .all(...parameters) as unknown as ResetRow[];
    return rows.map((row) => ({
      accountAlias: row.account_alias,
      platform: platform(row.platform),
      limitKey: row.limit_key,
      resetAt: new Date(row.reset_at_ms).toISOString(),
      kind: "provider",
    }));
  }

  public maintain(now: Date): void {
    const nowMilliseconds = now.getTime();
    const lastMaintenanceRow = this.#database
      .prepare(
        "SELECT value FROM history_metadata WHERE key = 'last_maintenance_ms'",
      )
      .get() as { value?: string } | undefined;
    const lastMaintenance = Number(lastMaintenanceRow?.value ?? "0");
    if (
      Number.isFinite(lastMaintenance) &&
      nowMilliseconds - lastMaintenance < DAY_MILLISECONDS
    ) {
      return;
    }

    const rawCutoff =
      nowMilliseconds - this.#configuration.rawRetentionDays * DAY_MILLISECONDS;
    const totalCutoff =
      nowMilliseconds - this.#configuration.retentionDays * DAY_MILLISECONDS;
    const oldRows = this.#readRawRows(
      Number.MIN_SAFE_INTEGER,
      rawCutoff,
      undefined,
    );
    const rollups = aggregateHours(oldRows);
    const insertRollup = this.#database.prepare(`
      INSERT OR REPLACE INTO hourly_limit_rollups(
        account_key, account_alias, platform, plan, limit_key, label, scope,
        availability, bucket_start_ms, sample_count, first_used_percent,
        last_used_percent, minimum_used_percent, maximum_used_percent,
        average_used_percent, last_reset_at_ms, last_window_duration_minutes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.#database.exec("BEGIN IMMEDIATE");
    try {
      for (const bucket of rollups) {
        const row = bucket.template;
        insertRollup.run(
          row.account_key,
          row.account_alias,
          row.platform,
          row.plan,
          row.limit_key,
          row.label,
          row.scope,
          row.availability,
          bucket.bucketStart,
          bucket.sampleCount,
          bucket.firstUsed,
          bucket.lastUsed,
          bucket.minimumUsed,
          bucket.maximumUsed,
          bucket.usedCount === 0 ? null : bucket.usedSum / bucket.usedCount,
          bucket.lastResetAt,
          bucket.lastWindowDuration,
        );
      }
      this.#database
        .prepare("DELETE FROM scan_runs WHERE completed_at_ms < ?")
        .run(rawCutoff);
      this.#database
        .prepare("DELETE FROM hourly_limit_rollups WHERE bucket_start_ms < ?")
        .run(totalCutoff);
      this.#database
        .prepare("DELETE FROM reset_events WHERE reset_at_ms < ?")
        .run(totalCutoff);
      this.#database
        .prepare(
          `INSERT OR REPLACE INTO history_metadata(key, value)
           VALUES ('last_maintenance_ms', ?)`,
        )
        .run(String(nowMilliseconds));
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
    this.#database.exec("PRAGMA wal_checkpoint(PASSIVE); PRAGMA optimize;");
  }

  public close(): void {
    this.#database.close();
  }

  #readRawRows(
    fromMilliseconds: number,
    toMilliseconds: number,
    accountAlias: string | undefined,
  ): RawSeriesRow[] {
    const conditions = ["a.observed_at_ms >= ?", "a.observed_at_ms < ?"];
    const parameters: SQLInputValue[] = [fromMilliseconds, toMilliseconds];
    if (accountAlias !== undefined) {
      conditions.push("a.account_alias = ? COLLATE NOCASE");
      parameters.push(accountAlias);
    }
    return this.#database
      .prepare(
        `SELECT a.account_key, a.account_alias, a.platform, a.plan,
                a.observed_at_ms, l.limit_key, l.label, l.scope,
                l.availability, l.used_percent, l.window_duration_minutes,
                l.reset_at_ms
         FROM account_snapshots a
         JOIN limit_snapshots l ON l.account_snapshot_id = a.id
         WHERE ${conditions.join(" AND ")}
         ORDER BY a.observed_at_ms, a.id, l.id`,
      )
      .all(...parameters) as unknown as RawSeriesRow[];
  }

  #readRollupRows(
    fromMilliseconds: number,
    toMilliseconds: number,
    accountAlias: string | undefined,
  ): RollupRow[] {
    const conditions = ["bucket_start_ms >= ?", "bucket_start_ms < ?"];
    const parameters: SQLInputValue[] = [fromMilliseconds, toMilliseconds];
    if (accountAlias !== undefined) {
      conditions.push("account_alias = ? COLLATE NOCASE");
      parameters.push(accountAlias);
    }
    return this.#database
      .prepare(
        `SELECT account_key, account_alias, platform, plan, limit_key, label,
                scope, availability, bucket_start_ms, sample_count,
                last_used_percent, minimum_used_percent, maximum_used_percent,
                last_reset_at_ms, last_window_duration_minutes
         FROM hourly_limit_rollups
         WHERE ${conditions.join(" AND ")}
         ORDER BY bucket_start_ms`,
      )
      .all(...parameters) as unknown as RollupRow[];
  }

  #rawRecord(row: RawSeriesRow): SeriesRecord {
    return {
      accountKey: row.account_key,
      accountAlias: row.account_alias,
      platform: platform(row.platform),
      plan: row.plan,
      limit: {
        key: row.limit_key,
        label: row.label,
        scope: scope(row.scope),
        availability: availability(row.availability),
      },
      point: {
        observedAt: new Date(row.observed_at_ms).toISOString(),
        usedPercent: row.used_percent,
        minimumUsedPercent: row.used_percent,
        maximumUsedPercent: row.used_percent,
        resetAt: instant(row.reset_at_ms),
        windowDurationMinutes: row.window_duration_minutes,
        sampleCount: 1,
        resolution: "raw",
      },
    };
  }

  #hourRecord(bucket: HourAccumulator): SeriesRecord {
    const row = bucket.template;
    return {
      accountKey: row.account_key,
      accountAlias: row.account_alias,
      platform: platform(row.platform),
      plan: row.plan,
      limit: {
        key: row.limit_key,
        label: row.label,
        scope: scope(row.scope),
        availability: availability(row.availability),
      },
      point: {
        observedAt: new Date(bucket.bucketStart).toISOString(),
        usedPercent: bucket.lastUsed,
        minimumUsedPercent: bucket.minimumUsed,
        maximumUsedPercent: bucket.maximumUsed,
        resetAt: instant(bucket.lastResetAt),
        windowDurationMinutes: bucket.lastWindowDuration,
        sampleCount: bucket.sampleCount,
        resolution: "hour",
      },
    };
  }

  #rollupRecord(row: RollupRow): SeriesRecord {
    return {
      accountKey: row.account_key,
      accountAlias: row.account_alias,
      platform: platform(row.platform),
      plan: row.plan,
      limit: {
        key: row.limit_key,
        label: row.label,
        scope: scope(row.scope),
        availability: availability(row.availability),
      },
      point: {
        observedAt: new Date(row.bucket_start_ms).toISOString(),
        usedPercent: row.last_used_percent,
        minimumUsedPercent: row.minimum_used_percent,
        maximumUsedPercent: row.maximum_used_percent,
        resetAt: instant(row.last_reset_at_ms),
        windowDurationMinutes: row.last_window_duration_minutes,
        sampleCount: row.sample_count,
        resolution: "hour",
      },
    };
  }
}

export function openSqliteHistoryStore(
  configuration: HistoryConfiguration,
  options: { now?: () => Date } = {},
): SqliteHistoryStore {
  if (configuration.filePath !== ":memory:") {
    const parent = dirname(configuration.filePath);
    const parentExisted = existsSync(parent);
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    if (!parentExisted) {
      chmodSync(parent, 0o700);
    }
  }
  const database = new DatabaseSync(configuration.filePath, { timeout: 5_000 });
  if (configuration.filePath !== ":memory:") {
    chmodSync(configuration.filePath, 0o600);
    database.exec("PRAGMA journal_mode = WAL;");
  }
  return new SqliteHistoryStore(database, configuration, options.now);
}
