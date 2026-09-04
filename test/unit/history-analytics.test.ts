import { describe, expect, it } from "vitest";

import { quotaSuccessSchema } from "../../src/domain/quota.js";
import {
  buildHistoryAnalytics,
  projectExhaustion,
  providerResetMarkers,
} from "../../src/history/analytics.js";
import type {
  HistoryLimitSeries,
  HistorySeriesPoint,
} from "../../src/history/types.js";
import {
  claudeSnapshot,
  codexSnapshotWithSpark,
  nowMilliseconds,
  resetAfter,
} from "../helpers/quota-fixtures.js";

function point(
  observedAt: string,
  usedPercent: number,
  resetAt: string | null,
): HistorySeriesPoint {
  return {
    observedAt,
    usedPercent,
    minimumUsedPercent: usedPercent,
    maximumUsedPercent: usedPercent,
    resetAt,
    windowDurationMinutes: null,
    sampleCount: 1,
    resolution: "raw",
  };
}

function minutesBeforeNow(minutes: number): string {
  return new Date(nowMilliseconds - minutes * 60_000).toISOString();
}

function series(
  key: string,
  values: readonly number[],
  resetAt = resetAfter(300),
): HistoryLimitSeries {
  return {
    accountAlias: "claude-ops@example.com",
    platform: "Claude",
    plan: "max",
    limit: {
      key,
      label: key,
      scope: "window",
      availability: "available",
    },
    points: values.map((value, index) =>
      point(minutesBeforeNow((values.length - index - 1) * 60), value, resetAt),
    ),
  };
}

describe("historical quota analytics", () => {
  it("estimates a robust rate and reports exhaustion before reset", () => {
    const resetAt = new Date(nowMilliseconds + 5 * 60 * 60_000).toISOString();
    const result = projectExhaustion(
      [
        point(minutesBeforeNow(120), 70, resetAt),
        point(minutesBeforeNow(60), 80, resetAt),
        point(minutesBeforeNow(0), 90, resetAt),
      ],
      resetAt,
    );

    expect(result.status).toBe("exhausts_before_reset");
    expect(result.ratePercentPerHour).toBe(10);
    expect(result.projectedExhaustionAt).toBe(
      new Date(nowMilliseconds + 60 * 60_000).toISOString(),
    );
  });

  it("never fits a rate across provider reset epochs", () => {
    const oldReset = minutesBeforeNow(180);
    const currentReset = resetAfter(300);
    const result = projectExhaustion(
      [
        point(minutesBeforeNow(240), 90, oldReset),
        point(minutesBeforeNow(120), 5, currentReset),
        point(minutesBeforeNow(60), 10, currentReset),
        point(minutesBeforeNow(0), 15, currentReset),
      ],
      currentReset,
    );

    expect(result.sampleCount).toBe(3);
    expect(result.ratePercentPerHour).toBe(5);
    expect(result.status).toBe("reset_before_exhaustion");
  });

  it("uses a monotonic envelope and the fastest supported recent pace", () => {
    const resetAt = resetAfter(600);
    const result = projectExhaustion(
      [
        point(minutesBeforeNow(720), 50, resetAt),
        point(minutesBeforeNow(180), 88, resetAt),
        point(minutesBeforeNow(60), 92, resetAt),
        point(minutesBeforeNow(30), 94, resetAt),
        point(minutesBeforeNow(1), 96, resetAt),
        point(minutesBeforeNow(0), 95, resetAt),
      ],
      resetAt,
    );

    expect(result.status).toBe("exhausts_before_reset");
    expect(result.projectedFromUsedPercent).toBe(96);
    expect(result.ratePercentPerHour).toBe(4);
    expect(result.rateBasis).toBe("recent_30m");
    expect(result.projectedExhaustionAt).toBe(
      new Date(nowMilliseconds + 60 * 60_000).toISOString(),
    );
    expect(result.projectedExhaustionRangeEndAt).not.toBeNull();
  });

  it("withholds projections for sparse or flat observations", () => {
    const resetAt = resetAfter(300);
    expect(
      projectExhaustion(
        [
          point(minutesBeforeNow(60), 20, resetAt),
          point(minutesBeforeNow(0), 20, resetAt),
        ],
        resetAt,
      ).status,
    ).toBe("insufficient_history");
  });

  it("treats Fable as nested capacity without converting its percentage", () => {
    const snapshot = claudeSnapshot({
      sessionUsed: 20,
      weeklyUsed: 10,
      fableUsed: 60,
      sessionRemainingMinutes: 300,
      weeklyRemainingMinutes: 300,
    });
    const result = buildHistoryAnalytics({
      snapshots: [snapshot],
      series: [
        series("base.session", [10, 15, 20], resetAfter(300)),
        series("base.weekly", [8, 9, 10], resetAfter(300)),
        series("fable.weekly", [50, 55, 60], resetAfter(300)),
      ],
      historyHealth: "ready",
      nowMilliseconds,
      fromMilliseconds: nowMilliseconds - 24 * 60 * 60_000,
      toMilliseconds: nowMilliseconds,
      requestedResolution: "raw",
      timeZone: "America/Los_Angeles",
    });

    expect(result.recommendations.fable).toEqual(
      expect.objectContaining({
        accountAlias: "claude-ops@example.com",
        action: "use",
        effectiveHeadroomPercent: 40,
        reason: "healthy_fable_capacity",
      }),
    );
    expect(
      result.accounts[0]?.limits.find((limit) => limit.key === "fable.weekly"),
    ).toEqual(
      expect.objectContaining({
        depth: 1,
        parentKey: "base.weekly",
        currentUsedPercent: 60,
        headroomPercent: 40,
        windowDurationMinutes: 10_080,
        resetAt: resetAfter(300),
        resetMarkers: [],
      }),
    );
  });

  it("recommends conserving Fable when its projection beats the shared reset", () => {
    const snapshot = claudeSnapshot({
      sessionUsed: 20,
      weeklyUsed: 10,
      fableUsed: 90,
      sessionRemainingMinutes: 300,
      weeklyRemainingMinutes: 300,
    });
    const result = buildHistoryAnalytics({
      snapshots: [snapshot],
      series: [
        series("base.session", [10, 15, 20]),
        series("base.weekly", [8, 9, 10]),
        series("fable.weekly", [70, 80, 90]),
      ],
      historyHealth: "ready",
      nowMilliseconds,
      fromMilliseconds: nowMilliseconds - 24 * 60 * 60_000,
      toMilliseconds: nowMilliseconds,
      requestedResolution: "raw",
      timeZone: "America/Los_Angeles",
    });

    expect(result.recommendations.fable).toEqual(
      expect.objectContaining({
        action: "conserve",
        effectiveHeadroomPercent: 10,
        reason: "projected_before_reset",
      }),
    );
  });

  it("does not invent a Fable recommendation for unsupported capacity", () => {
    const current = claudeSnapshot();
    if (current.status !== "ok") {
      throw new TypeError("Expected a successful Claude fixture.");
    }
    const unsupported = quotaSuccessSchema.parse({
      ...current,
      limits: [
        ...current.limits.filter((limit) => !limit.key.startsWith("fable")),
        {
          key: "fable",
          label: "Fable",
          scope: "model",
          availability: "unsupported",
          usedPercent: null,
          windowDurationMinutes: null,
          resetAt: null,
        },
      ],
    });
    const result = buildHistoryAnalytics({
      snapshots: [unsupported],
      series: [],
      historyHealth: "ready",
      nowMilliseconds,
      fromMilliseconds: nowMilliseconds - 24 * 60 * 60_000,
      toMilliseconds: nowMilliseconds,
      requestedResolution: "raw",
      timeZone: "America/Los_Angeles",
    });

    expect(result.recommendations.fable).toBeNull();
  });

  it("filters chart points by each limit's selected quota periods", () => {
    const snapshot = claudeSnapshot({
      sessionRemainingMinutes: 120,
      weeklyRemainingMinutes: 3_000,
    });
    const resetAt = resetAfter(3_000);
    const historicalSeries = [
      {
        ...series("base.session", [], resetAfter(120)),
        points: [
          point(minutesBeforeNow(360), 5, resetAfter(120)),
          point(minutesBeforeNow(300), 10, resetAfter(120)),
          point(minutesBeforeNow(60), 15, resetAfter(120)),
        ],
      },
      {
        ...series("base.weekly", [], resetAt),
        points: [
          point(minutesBeforeNow(8 * 24 * 60), 5, resetAt),
          point(minutesBeforeNow(6 * 24 * 60), 10, resetAt),
          point(minutesBeforeNow(60), 15, resetAt),
        ],
      },
    ];
    const result = buildHistoryAnalytics({
      snapshots: [snapshot],
      series: historicalSeries,
      historyHealth: "ready",
      nowMilliseconds,
      fromMilliseconds: nowMilliseconds - 10 * 24 * 60 * 60_000,
      toMilliseconds: nowMilliseconds,
      requestedResolution: "raw",
      periodMultiplier: 1,
      timeZone: "America/Los_Angeles",
    });

    const limits = result.accounts[0]?.limits;
    expect(result.periodMultiplier).toBe(1);
    expect(
      limits?.find((limit) => limit.key === "base.session")?.points,
    ).toHaveLength(2);
    expect(
      limits?.find((limit) => limit.key === "base.weekly")?.points,
    ).toHaveLength(2);

    const halfPeriodResult = buildHistoryAnalytics({
      snapshots: [snapshot],
      series: historicalSeries,
      historyHealth: "ready",
      nowMilliseconds,
      fromMilliseconds: nowMilliseconds - 10 * 24 * 60 * 60_000,
      toMilliseconds: nowMilliseconds,
      requestedResolution: "raw",
      periodMultiplier: 0.5,
      timeZone: "America/Los_Angeles",
    });
    expect(halfPeriodResult.periodMultiplier).toBe(0.5);
    expect(
      halfPeriodResult.accounts[0]?.limits.find(
        (limit) => limit.key === "base.session",
      )?.points,
    ).toHaveLength(1);
    expect(
      halfPeriodResult.accounts[0]?.limits.find(
        (limit) => limit.key === "base.weekly",
      )?.points,
    ).toHaveLength(1);
  });

  it("sorts accounts by their latest observed usage increase", () => {
    const older = claudeSnapshot({ alias: "claude-older@example.com" });
    const recent = claudeSnapshot({ alias: "claude-recent@example.com" });
    const resetAt = resetAfter(300);
    const result = buildHistoryAnalytics({
      snapshots: [older, recent],
      series: [
        {
          ...series("base.session", [], resetAt),
          accountAlias: "claude-older@example.com",
          points: [
            point(minutesBeforeNow(180), 0, resetAt),
            point(minutesBeforeNow(120), 5, resetAt),
            point(minutesBeforeNow(60), 5, resetAt),
          ],
        },
        {
          ...series("base.session", [], resetAt),
          accountAlias: "claude-recent@example.com",
          points: [
            point(minutesBeforeNow(180), 0, resetAt),
            point(minutesBeforeNow(30), 10, resetAt),
            point(minutesBeforeNow(0), 10, resetAt),
          ],
        },
      ],
      historyHealth: "ready",
      nowMilliseconds,
      fromMilliseconds: nowMilliseconds - 24 * 60 * 60_000,
      toMilliseconds: nowMilliseconds,
      requestedResolution: "raw",
      lastScanAt: new Date(nowMilliseconds).toISOString(),
      scanIntervalSeconds: 60,
      timeZone: "America/Los_Angeles",
    });

    expect(result.accounts.map((account) => account.accountAlias)).toEqual([
      "claude-recent@example.com",
      "claude-older@example.com",
    ]);
    expect(result.accounts.map((account) => account.lastActivityAt)).toEqual([
      minutesBeforeNow(30),
      minutesBeforeNow(120),
    ]);
    expect(result.lastScanAt).toBe(new Date(nowMilliseconds).toISOString());
    expect(result.scanIntervalSeconds).toBe(60);
  });

  it("can hide Spark without changing the raw Codex snapshot", () => {
    const snapshot = codexSnapshotWithSpark();
    const result = buildHistoryAnalytics({
      snapshots: [snapshot],
      series: [],
      historyHealth: "ready",
      nowMilliseconds,
      fromMilliseconds: nowMilliseconds - 24 * 60 * 60_000,
      toMilliseconds: nowMilliseconds,
      requestedResolution: "raw",
      showSpark: false,
      timeZone: "America/Los_Angeles",
    });

    expect(result.accounts[0]?.limits.map((limit) => limit.key)).toEqual([
      "codex.primary",
    ]);
    expect(snapshot.status === "ok" ? snapshot.limits : []).toHaveLength(2);
  });

  it("suppresses rolling resets but preserves boundaries and adjustments", () => {
    const start = Date.parse("2026-09-02T18:00:00.000Z");
    const rolling = [0, 60, 120].map((minutes) =>
      point(
        new Date(start + minutes * 60_000).toISOString(),
        0,
        new Date(start + (minutes + 300) * 60_000).toISOString(),
      ),
    );
    expect(providerResetMarkers(rolling)).toEqual([]);

    const boundary = providerResetMarkers([
      point("2026-09-02T18:59:00.000Z", 80, "2026-09-02T19:00:00.000Z"),
      point("2026-09-02T19:01:00.000Z", 0, "2026-09-09T19:00:00.000Z"),
    ]);
    expect(boundary).toEqual([
      { at: "2026-09-02T19:00:00.000Z", kind: "provider" },
    ]);

    const adjustment = providerResetMarkers([
      point("2026-09-02T18:00:00.000Z", 10, "2026-09-02T23:00:00.000Z"),
      point("2026-09-02T19:00:00.000Z", 10, "2026-09-03T01:00:00.000Z"),
    ]);
    expect(adjustment).toEqual([
      { at: "2026-09-02T19:00:00.000Z", kind: "adjustment" },
    ]);
  });
});
