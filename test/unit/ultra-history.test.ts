import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import {
  quotaSnapshotSchema,
  quotaSuccessSchema,
  type QuotaSnapshot,
} from "../../src/domain/quota.js";
import { buildHistoryAnalytics } from "../../src/history/analytics.js";
import { buildCliForecast } from "../../src/history/cli-forecast.js";
import { openSqliteHistoryStore } from "../../src/history/sqlite-store.js";
import {
  renderTextForecast,
  renderMarkdownForecast,
} from "../../src/presentation/cli-forecast.js";
import { toPublicSnapshots } from "../../src/presentation/public-dto.js";
import { buildQuotaReport } from "../../src/presentation/quota-report.js";
import { parseClaudeUsageOutput } from "../../src/services/claude-usage.js";

const now = Date.parse("2026-08-30T00:30:00.000Z");
const usage = readFileSync(
  new URL("../fixtures/claude-usage-ultra.txt", import.meta.url),
  "utf8",
);
const limited = readFileSync(
  new URL("../fixtures/claude-usage.txt", import.meta.url),
  "utf8",
);
const query = {
  fromMilliseconds: now - 3 * 60 * 60_000,
  toMilliseconds: now,
  resolution: "raw" as const,
};
function snapshot(output = usage, ultra = true, observedAt = now) {
  return quotaSuccessSchema.parse({
    accountAlias: "claude-synthetic@example.com",
    platform: "Claude",
    plan: "ultra",
    status: "ok",
    observedAt: new Date(observedAt).toISOString(),
    limits: parseClaudeUsageOutput(output, observedAt, ultra),
  });
}
function open(filePath: string) {
  return openSqliteHistoryStore(
    {
      filePath,
      rawRetentionHours: 6,
      hourlyRetentionDays: 30,
      retentionDays: 365,
    },
    { now: () => new Date(now) },
  );
}

describe("Ultra history and forecasts", () => {
  it("adds nullable metadata to old databases without reinterpreting old rows, and round-trips N/A", () => {
    const directory = mkdtempSync(join(tmpdir(), "seat-monitor-ultra-"));
    try {
      const path = join(directory, "history.sqlite3");
      const oldUnknown = snapshot(usage, false, now - 60_000);
      let store = open(path);
      store.recordScan("cli", [oldUnknown], new Date(now - 60_000));
      store.close();
      // Reproduce the pre-change database with a real old observation intact.
      const oldDatabase = new DatabaseSync(path);
      oldDatabase.exec("ALTER TABLE limit_snapshots DROP COLUMN applicability");
      const version = oldDatabase.prepare("PRAGMA user_version").get();
      oldDatabase.close();
      store = open(path);
      const current = snapshot();
      store.recordScan("cli", [current], new Date(now));
      store.close();
      store = open(path);
      const runs = store.listScans({ ...query, limit: 10 });
      store.close();
      expect(runs.flatMap((run) => run.snapshots)).toEqual([
        current,
        oldUnknown,
      ]);
      const database = new DatabaseSync(path);
      expect(database.prepare("PRAGMA user_version").get()).toEqual(version);
      expect(
        database
          .prepare(
            "SELECT applicability FROM limit_snapshots WHERE limit_key = 'base.session' ORDER BY id",
          )
          .all(),
      ).toEqual([{ applicability: null }, { applicability: "not_applicable" }]);
      database.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not revive old session burn, reset, headroom or risk, while weekly limits remain usable", () => {
    const store = open(":memory:");
    try {
      for (const [minutes, percent] of [
        [120, 70],
        [60, 80],
        [30, 90],
      ]) {
        const at = now - (minutes ?? 0) * 60_000;
        const old = snapshot(
          limited.replace("8% used", `${String(percent)}% used`),
          false,
          at,
        );
        store.recordScan("cli", [old], new Date(at));
      }
      const current = snapshot();
      store.recordScan("cli", [current], new Date(now));
      const options = {
        ...query,
        nowMilliseconds: now,
        requestedResolution: "raw" as const,
        historyHealth: "ready" as const,
        timeZone: "America/Los_Angeles",
        series: store.readSeries(query),
        resetEvents: store.listResetEvents(query),
      };
      const analytics = buildHistoryAnalytics({
        ...options,
        snapshots: [current],
      });
      const session = analytics.accounts[0]?.limits.find(
        (limit) => limit.key === "base.session",
      );
      expect(session).toMatchObject({
        applicability: "not_applicable",
        label: "Session (N/A)",
        currentUsedPercent: null,
        headroomPercent: null,
        windowDurationMinutes: null,
        resetAt: null,
        resetSource: null,
        minutesUntilReset: null,
        projection: {
          status: "not_applicable",
          ratePercentPerHour: null,
          projectedExhaustionAt: null,
        },
      });
      expect(session?.points.some((point) => point.usedPercent === 90)).toBe(
        true,
      );
      expect(analytics.fleetThroughput.sessions).toEqual([]);
      expect(
        analytics.fleetThroughput.vendors.every(
          (vendor) => vendor.points.length === 0,
        ),
      ).toBe(true);
      expect(analytics.recommendations.fable).toMatchObject({
        accountAlias: current.accountAlias,
        effectiveHeadroomPercent: 24,
      });
      expect(analytics.recommendations.general).not.toBeNull();
      const forecast = buildCliForecast(analytics);
      expect(
        forecast.riskRanking.some((entry) => entry.limitKey === "base.session"),
      ).toBe(false);
      expect(
        forecast.accounts[0]?.limits.find(
          (limit) => limit.key === "base.session",
        ),
      ).toMatchObject({
        applicability: "not_applicable",
        usedPercent: null,
        projectionStatus: "not_applicable",
        resetAt: null,
        ratePercentPerHour: null,
      });
      expect(renderTextForecast(forecast)).toContain(
        "N/A (verified Ultra has no five-hour session limit)",
      );
      expect(renderMarkdownForecast(forecast)).toContain("no session reset");
      const report = buildQuotaReport(toPublicSnapshots([current], now), {
        nowMilliseconds: now,
        timeZone: "America/Los_Angeles",
      });
      expect(
        report.accounts[0]?.rows.find((row) => row.key === "base.session"),
      ).toMatchObject({
        applicability: "not_applicable",
        consumedPercent: null,
        elapsedPercent: null,
        windowConstant: null,
      });
      expect(report.use).not.toBeNull();

      const failed = quotaSnapshotSchema.parse({
        accountAlias: current.accountAlias,
        platform: "Claude",
        status: "error",
        observedAt: current.observedAt,
        plan: null,
        limits: [],
        error: { code: "quota_unavailable", message: "No quota reading." },
      });
      for (const latest of [
        snapshot(usage, false),
        failed,
      ] satisfies QuotaSnapshot[]) {
        const negative = buildHistoryAnalytics({
          ...options,
          snapshots: [latest],
        });
        const unknown = negative.accounts[0]?.limits.find(
          (limit) => limit.key === "base.session",
        );
        expect(unknown).not.toHaveProperty("applicability");
        expect(unknown?.projection.status).toBe("insufficient_history");
        expect(negative.recommendations.fable).toBeNull();
      }
    } finally {
      store.close();
    }
  });
});
