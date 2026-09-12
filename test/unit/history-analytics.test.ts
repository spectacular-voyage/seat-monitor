import { describe, expect, it } from "vitest";

import {
  quotaSuccessSchema,
  type QuotaSnapshot,
} from "../../src/domain/quota.js";
import {
  buildHistoryAnalytics,
  projectExhaustion,
  providerResetMarkers,
} from "../../src/history/analytics.js";
import type {
  HistoryLimitSeries,
  HistoryResetEvent,
  HistorySeriesPoint,
} from "../../src/history/types.js";
import {
  claudeSnapshot,
  codexSnapshot,
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
  resetAt: string | null = resetAfter(300),
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

function withoutResets(
  snapshot: QuotaSnapshot,
  keys: readonly string[],
): QuotaSnapshot {
  if (snapshot.status !== "ok") {
    throw new TypeError("Expected a successful quota fixture.");
  }
  return quotaSuccessSchema.parse({
    ...snapshot,
    limits: snapshot.limits.map((limit) =>
      keys.includes(limit.key) ? { ...limit, resetAt: null } : limit,
    ),
  });
}

function resetEvent(
  limitKey: string,
  resetAt: string,
  lastSeenAt = minutesBeforeNow(1),
): HistoryResetEvent {
  return {
    accountAlias: "claude-ops@example.com",
    platform: "Claude",
    limitKey,
    resetAt,
    lastSeenAt,
    kind: "provider",
  };
}

function accountSessionSeries(
  accountAlias: string,
  platform: "Claude" | "Codex",
  key: string,
  values: readonly number[],
): HistoryLimitSeries {
  return {
    accountAlias,
    platform,
    plan: platform === "Claude" ? "max" : "pro",
    limit: {
      key,
      label: key,
      scope: "window",
      availability: "available",
    },
    points: values.map((value, index) =>
      point(minutesBeforeNow((values.length - index - 1) * 15), value, null),
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

  it("preserves a fresh exhausted reading when retained series are unavailable", () => {
    const result = buildHistoryAnalytics({
      snapshots: [claudeSnapshot({ sessionUsed: 100 })],
      series: [],
      historyHealth: "unavailable",
      nowMilliseconds,
      fromMilliseconds: nowMilliseconds - 24 * 60 * 60_000,
      toMilliseconds: nowMilliseconds,
      requestedResolution: "raw",
      timeZone: "America/Los_Angeles",
    });
    const session = result.accounts[0]?.limits.find(
      (limit) => limit.key === "base.session",
    );

    expect(session?.points).toEqual([]);
    expect(session?.projection).toEqual(
      expect.objectContaining({
        status: "already_exhausted",
        projectedFromUsedPercent: 100,
        projectedExhaustionAt: new Date(nowMilliseconds).toISOString(),
        sampleCount: 1,
        spanMinutes: 0,
      }),
    );
  });

  it("prefers the current provider reset over retained history", () => {
    const currentReset = resetAfter(300);
    const result = buildHistoryAnalytics({
      snapshots: [claudeSnapshot({ weeklyRemainingMinutes: 300 })],
      series: [],
      resetEvents: [resetEvent("base.weekly", resetAfter(600))],
      historyHealth: "ready",
      nowMilliseconds,
      fromMilliseconds: nowMilliseconds - 24 * 60 * 60_000,
      toMilliseconds: nowMilliseconds,
      requestedResolution: "raw",
      timeZone: "America/Los_Angeles",
    });

    expect(
      result.accounts[0]?.limits.find((limit) => limit.key === "base.weekly"),
    ).toEqual(
      expect.objectContaining({
        resetAt: currentReset,
        resetSource: "provider",
      }),
    );
  });

  it("advances a recent weekly anchor and shares it with Fable", () => {
    const snapshot = withoutResets(claudeSnapshot(), [
      "base.weekly",
      "fable.weekly",
    ]);
    const previousReset = minutesBeforeNow(24 * 60);
    const expectedReset = new Date(
      Date.parse(previousReset) + 7 * 24 * 60 * 60_000,
    ).toISOString();
    const result = buildHistoryAnalytics({
      snapshots: [snapshot],
      series: [series("base.weekly", [10, 20, 30], null)],
      resetEvents: [resetEvent("base.weekly", previousReset)],
      historyHealth: "ready",
      nowMilliseconds,
      fromMilliseconds: nowMilliseconds - 7 * 24 * 60 * 60_000,
      toMilliseconds: nowMilliseconds,
      requestedResolution: "raw",
      timeZone: "America/Los_Angeles",
    });

    const weekly = result.accounts[0]?.limits.find(
      (limit) => limit.key === "base.weekly",
    );
    const fable = result.accounts[0]?.limits.find(
      (limit) => limit.key === "fable.weekly",
    );
    expect(weekly).toEqual(
      expect.objectContaining({
        resetAt: expectedReset,
        resetSource: "expected",
      }),
    );
    expect(fable).toEqual(
      expect.objectContaining({
        resetAt: expectedReset,
        resetSource: "expected",
      }),
    );
    expect(weekly?.projection.status).toBe("exhaustion_projected");
  });

  it("carries a still-future Session reset but does not extrapolate it", () => {
    const snapshot = withoutResets(
      claudeSnapshot({ sessionRemainingMinutes: null }),
      ["base.session"],
    );
    const futureReset = resetAfter(60);
    const future = buildHistoryAnalytics({
      snapshots: [snapshot],
      series: [],
      resetEvents: [resetEvent("base.session", futureReset)],
      historyHealth: "ready",
      nowMilliseconds,
      fromMilliseconds: nowMilliseconds - 24 * 60 * 60_000,
      toMilliseconds: nowMilliseconds,
      requestedResolution: "raw",
      timeZone: "America/Los_Angeles",
    });
    const elapsed = buildHistoryAnalytics({
      snapshots: [snapshot],
      series: [],
      resetEvents: [resetEvent("base.session", minutesBeforeNow(60))],
      historyHealth: "ready",
      nowMilliseconds,
      fromMilliseconds: nowMilliseconds - 24 * 60 * 60_000,
      toMilliseconds: nowMilliseconds,
      requestedResolution: "raw",
      timeZone: "America/Los_Angeles",
    });

    expect(
      future.accounts[0]?.limits.find((limit) => limit.key === "base.session"),
    ).toEqual(
      expect.objectContaining({
        resetAt: futureReset,
        resetSource: "expected",
      }),
    );
    expect(
      elapsed.accounts[0]?.limits.find((limit) => limit.key === "base.session"),
    ).toEqual(expect.objectContaining({ resetAt: null, resetSource: null }));
  });

  it("refuses to advance a weekly anchor by more than one period", () => {
    const snapshot = withoutResets(claudeSnapshot(), ["base.weekly"]);
    const result = buildHistoryAnalytics({
      snapshots: [snapshot],
      series: [],
      resetEvents: [resetEvent("base.weekly", minutesBeforeNow(8 * 24 * 60))],
      historyHealth: "ready",
      nowMilliseconds,
      fromMilliseconds: nowMilliseconds - 10 * 24 * 60 * 60_000,
      toMilliseconds: nowMilliseconds,
      requestedResolution: "raw",
      timeZone: "America/Los_Angeles",
    });

    expect(
      result.accounts[0]?.limits.find((limit) => limit.key === "base.weekly"),
    ).toEqual(expect.objectContaining({ resetAt: null, resetSource: null }));
  });

  it("refuses an expected reset whose local time does not exist", () => {
    const springNow = Date.parse("2026-03-02T18:00:00.000Z");
    const snapshot = withoutResets(claudeSnapshot(), ["base.weekly"]);
    const result = buildHistoryAnalytics({
      snapshots: [snapshot],
      series: [],
      resetEvents: [
        resetEvent(
          "base.weekly",
          "2026-03-01T10:30:00.000Z",
          "2026-03-01T10:00:00.000Z",
        ),
      ],
      historyHealth: "ready",
      nowMilliseconds: springNow,
      fromMilliseconds: springNow - 7 * 24 * 60 * 60_000,
      toMilliseconds: springNow,
      requestedResolution: "raw",
      timeZone: "America/Los_Angeles",
    });

    expect(
      result.accounts[0]?.limits.find((limit) => limit.key === "base.weekly"),
    ).toEqual(expect.objectContaining({ resetAt: null, resetSource: null }));
  });

  it("preserves a historical projection boundary after a current scan error", () => {
    const historicalReset = resetAfter(300);
    const failed: QuotaSnapshot = {
      accountAlias: "claude-ops@example.com",
      platform: "Claude",
      status: "error",
      plan: null,
      limits: [],
      observedAt: new Date(nowMilliseconds).toISOString(),
      error: { code: "timeout", message: "Claude usage check timed out." },
    };
    const result = buildHistoryAnalytics({
      snapshots: [failed],
      series: [series("base.session", [70, 80, 90], historicalReset)],
      resetEvents: [resetEvent("base.session", historicalReset)],
      historyHealth: "degraded",
      nowMilliseconds,
      fromMilliseconds: nowMilliseconds - 24 * 60 * 60_000,
      toMilliseconds: nowMilliseconds,
      requestedResolution: "raw",
      timeZone: "America/Los_Angeles",
    });

    const session = result.accounts[0]?.limits.find(
      (limit) => limit.key === "base.session",
    );
    expect(session).toEqual(
      expect.objectContaining({
        resetAt: historicalReset,
        resetSource: "expected",
      }),
    );
    expect(session?.projection.status).toBe("exhausts_before_reset");
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

  it("builds account session overlays and total vendor burn series", () => {
    const claudeOne = claudeSnapshot({ alias: "claude-one@example.com" });
    const claudeTwo = claudeSnapshot({ alias: "claude-two@example.com" });
    const codex = codexSnapshot("codex-one@example.com");
    const result = buildHistoryAnalytics({
      snapshots: [claudeOne, claudeTwo, codex],
      series: [
        accountSessionSeries(
          "claude-one@example.com",
          "Claude",
          "base.session",
          [0, 10, 15],
        ),
        accountSessionSeries(
          "claude-two@example.com",
          "Claude",
          "base.session",
          [0, 20, 30],
        ),
        accountSessionSeries(
          "codex-one@example.com",
          "Codex",
          "codex.primary",
          [10, 15, 20],
        ),
      ],
      historyHealth: "ready",
      nowMilliseconds,
      fromMilliseconds: nowMilliseconds - 24 * 60 * 60_000,
      toMilliseconds: nowMilliseconds,
      requestedResolution: "raw",
      periodMultiplier: 1,
      scanIntervalSeconds: 60,
      timeZone: "America/Los_Angeles",
    });

    expect(result.fleetThroughput.sessions).toEqual([
      expect.objectContaining({
        accountAlias: "claude-one@example.com",
        platform: "Claude",
      }),
      expect.objectContaining({
        accountAlias: "claude-two@example.com",
        platform: "Claude",
      }),
      expect.objectContaining({
        accountAlias: "codex-one@example.com",
        platform: "Codex",
        limitKey: "codex.primary",
      }),
    ]);
    expect(result.fleetThroughput.from).toBe(minutesBeforeNow(315));
    expect(
      result.fleetThroughput.sessions[0]?.points.map(
        (point) => point.usedPercent,
      ),
    ).toContain(15);
    expect(
      result.fleetThroughput.vendors
        .find((vendor) => vendor.platform === "Claude")
        ?.points.at(-1),
    ).toEqual(
      expect.objectContaining({
        ratePercentPerHour: 105,
        accountCount: 2,
      }),
    );
    expect(
      result.fleetThroughput.vendors
        .find((vendor) => vendor.platform === "Codex")
        ?.points.at(-1),
    ).toEqual(
      expect.objectContaining({
        ratePercentPerHour: 20,
        accountCount: 1,
      }),
    );
    expect(result.fleetThroughput.smoothingWindowMinutes).toBe(60);
  });

  it("keeps small provider regressions in the total burn calculation", () => {
    const active = claudeSnapshot({ alias: "claude-active@example.com" });
    const idle = claudeSnapshot({ alias: "claude-idle@example.com" });
    const result = buildHistoryAnalytics({
      snapshots: [active, idle],
      series: [
        accountSessionSeries(
          "claude-active@example.com",
          "Claude",
          "base.session",
          [56, 60, 59, 64],
        ),
        accountSessionSeries(
          "claude-idle@example.com",
          "Claude",
          "base.session",
          [0, 0, 0, 0],
        ),
      ],
      historyHealth: "ready",
      nowMilliseconds,
      fromMilliseconds: nowMilliseconds - 24 * 60 * 60_000,
      toMilliseconds: nowMilliseconds,
      requestedResolution: "raw",
      periodMultiplier: 1,
      scanIntervalSeconds: 60,
      timeZone: "America/Los_Angeles",
    });
    const rates = result.fleetThroughput.vendors.find(
      (vendor) => vendor.platform === "Claude",
    )?.points;

    expect(rates?.map((point) => point.ratePercentPerHour)).toEqual([
      16, 12, 10.667,
    ]);
    expect(rates?.map((point) => point.accountCount)).toEqual([2, 2, 2]);
  });

  it("does not calculate a fleet rate across a session reset", () => {
    const snapshot = claudeSnapshot({ alias: "claude-reset@example.com" });
    const result = buildHistoryAnalytics({
      snapshots: [snapshot],
      series: [
        accountSessionSeries(
          "claude-reset@example.com",
          "Claude",
          "base.session",
          [80, 90, 5, 10],
        ),
      ],
      historyHealth: "ready",
      nowMilliseconds,
      fromMilliseconds: nowMilliseconds - 24 * 60 * 60_000,
      toMilliseconds: nowMilliseconds,
      requestedResolution: "raw",
      periodMultiplier: 1,
      scanIntervalSeconds: 60,
      timeZone: "America/Los_Angeles",
    });
    const rates = result.fleetThroughput.vendors.find(
      (vendor) => vendor.platform === "Claude",
    )?.points;

    expect(rates?.map((point) => point.ratePercentPerHour)).toEqual([40, 30]);
  });

  it("honors a provider reset when the usage drop is small", () => {
    const snapshot = claudeSnapshot({ alias: "claude-low-reset@example.com" });
    const resetSeries = accountSessionSeries(
      "claude-low-reset@example.com",
      "Claude",
      "base.session",
      [3, 4, 1, 2],
    );
    const previousReset = minutesBeforeNow(20);
    const nextReset = resetAfter(300);
    resetSeries.points = resetSeries.points.map((historyPoint, index) => ({
      ...historyPoint,
      resetAt: index < 2 ? previousReset : nextReset,
    }));
    const result = buildHistoryAnalytics({
      snapshots: [snapshot],
      series: [resetSeries],
      historyHealth: "ready",
      nowMilliseconds,
      fromMilliseconds: nowMilliseconds - 24 * 60 * 60_000,
      toMilliseconds: nowMilliseconds,
      requestedResolution: "raw",
      periodMultiplier: 1,
      scanIntervalSeconds: 60,
      timeZone: "America/Los_Angeles",
    });
    const rates = result.fleetThroughput.vendors.find(
      (vendor) => vendor.platform === "Claude",
    )?.points;

    expect(rates?.map((point) => point.ratePercentPerHour)).toEqual([4, 4]);
  });

  it.each([
    [1, 60],
    [7, 6 * 60],
    [30, 24 * 60],
    [365, 7 * 24 * 60],
  ])(
    "uses scale-aware smoothing for a %d-day fleet range",
    (days, expectedSmoothingMinutes) => {
      const snapshot = claudeSnapshot({ alias: "claude-scale@example.com" });
      const result = buildHistoryAnalytics({
        snapshots: [snapshot],
        series: [
          accountSessionSeries(
            "claude-scale@example.com",
            "Claude",
            "base.session",
            [0, 5, 10],
          ),
        ],
        historyHealth: "ready",
        nowMilliseconds,
        fromMilliseconds: nowMilliseconds - days * 86_400_000,
        toMilliseconds: nowMilliseconds,
        requestedResolution: "auto",
        scanIntervalSeconds: 60,
        timeZone: "America/Los_Angeles",
      });

      expect(result.fleetThroughput.from).toBe(
        new Date(nowMilliseconds - days * 86_400_000).toISOString(),
      );
      expect(result.fleetThroughput.smoothingWindowMinutes).toBe(
        expectedSmoothingMinutes,
      );
    },
  );

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
    expect(result.fleetThroughput.sessions).toEqual([
      expect.objectContaining({ limitKey: "codex.primary" }),
    ]);
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
