import { describe, expect, it } from "vitest";

import { quotaSuccessSchema } from "../../src/domain/quota.js";
import {
  buildHistoryAnalytics,
  projectExhaustion,
} from "../../src/history/analytics.js";
import type {
  HistoryLimitSeries,
  HistorySeriesPoint,
} from "../../src/history/types.js";
import {
  claudeSnapshot,
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
      resetEvents: [],
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
      resetEvents: [],
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
      resetEvents: [],
      historyHealth: "ready",
      nowMilliseconds,
      fromMilliseconds: nowMilliseconds - 24 * 60 * 60_000,
      toMilliseconds: nowMilliseconds,
      requestedResolution: "raw",
      timeZone: "America/Los_Angeles",
    });

    expect(result.recommendations.fable).toBeNull();
  });
});
