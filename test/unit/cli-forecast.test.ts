import { describe, expect, it } from "vitest";

import {
  quotaSuccessSchema,
  type QuotaSnapshot,
} from "../../src/domain/quota.js";
import { buildHistoryAnalytics } from "../../src/history/analytics.js";
import { buildCliForecast } from "../../src/history/cli-forecast.js";
import type { HistoryLimitSeries } from "../../src/history/types.js";
import {
  renderMarkdownForecast,
  renderTextForecast,
} from "../../src/presentation/cli-forecast.js";

const nowMilliseconds = Date.parse("2026-09-08T18:00:00.000Z");

function instant(minutesFromNow: number): string {
  return new Date(nowMilliseconds + minutesFromNow * 60_000).toISOString();
}

function snapshot(
  accountAlias: string,
  usedPercent: number,
  resetAt: string | null,
): QuotaSnapshot {
  return quotaSuccessSchema.parse({
    accountAlias,
    platform: "Codex",
    status: "ok",
    plan: "pro",
    limits: [
      {
        key: "codex.primary",
        label: "Codex Primary",
        scope: "window",
        availability: "available",
        usedPercent,
        windowDurationMinutes: 300,
        resetAt,
      },
    ],
    observedAt: instant(0),
  });
}

function series(
  accountAlias: string,
  values: readonly (readonly [minutesFromNow: number, usedPercent: number])[],
  resetAt: string | null,
): HistoryLimitSeries {
  return {
    accountAlias,
    platform: "Codex",
    plan: "pro",
    limit: {
      key: "codex.primary",
      label: "Codex Primary",
      scope: "window",
      availability: "available",
    },
    points: values.map(([minutesFromNow, usedPercent]) => ({
      observedAt: instant(minutesFromNow),
      usedPercent,
      minimumUsedPercent: usedPercent,
      maximumUsedPercent: usedPercent,
      resetAt,
      windowDurationMinutes: 300,
      sampleCount: 1,
      resolution: "raw",
    })),
  };
}

describe("CLI forecast contract", () => {
  it("preserves every projection state and ranks only derivable risks", () => {
    const farReset = instant(600);
    const nearReset = instant(30);
    const snapshots = [
      snapshot("already", 100, farReset),
      snapshot("before-reset", 50, farReset),
      snapshot("no-reset", 50, null),
      snapshot("reset-first", 50, nearReset),
      snapshot("flat", 48, farReset),
      snapshot("new", 10, farReset),
    ];
    const commonRise = [
      [-60, 10],
      [-30, 20],
      [-15, 30],
      [0, 50],
    ] as const;
    const analytics = buildHistoryAnalytics({
      snapshots,
      series: [
        series("already", [[-15, 100]], farReset),
        series("before-reset", commonRise, farReset),
        series("no-reset", commonRise, null),
        series("reset-first", commonRise, nearReset),
        series(
          "flat",
          [
            [-30, 50],
            [-15, 49],
            [0, 48],
          ],
          farReset,
        ),
        series("new", [[0, 10]], farReset),
      ],
      historyHealth: "ready",
      nowMilliseconds,
      fromMilliseconds: nowMilliseconds - 7 * 86_400_000,
      toMilliseconds: nowMilliseconds,
      requestedResolution: "auto",
      timeZone: "America/Los_Angeles",
    });
    const forecast = buildCliForecast(analytics);
    const statuses = Object.fromEntries(
      forecast.accounts.map((account) => [
        account.accountAlias,
        account.limits[0]?.projectionStatus,
      ]),
    );

    expect(statuses).toEqual({
      already: "already_exhausted",
      "before-reset": "exhausts_before_reset",
      "no-reset": "exhaustion_projected",
      "reset-first": "reset_before_exhaustion",
      flat: "not_consuming",
      new: "insufficient_history",
    });
    expect(
      forecast.fleetBurn.find((burn) => burn.platform === "Codex"),
    ).toEqual(
      expect.objectContaining({
        totalRatePercentPerHour: 120,
        accountCount: 4,
        rateWindowMinutes: 30,
        smoothingWindowMinutes: 6 * 60,
      }),
    );
    expect(
      forecast.riskRanking.map((risk) => [
        risk.rank,
        risk.accountAlias,
        risk.minutesToExhaustion,
      ]),
    ).toEqual([
      [1, "already", 0],
      [2, "before-reset", 50],
      [3, "no-reset", 50],
    ]);
    expect(forecast.riskRanking[1]).toEqual(
      expect.objectContaining({
        projectedExhaustionAt: instant(50),
        projectedExhaustionRangeEndAt: instant(75),
      }),
    );
    expect(
      forecast.accounts.find(
        (account) => account.accountAlias === "reset-first",
      )?.limits[0]?.minutesToExhaustion,
    ).toBe(50);
    for (const alias of ["flat", "new"]) {
      const limit = forecast.accounts.find(
        (account) => account.accountAlias === alias,
      )?.limits[0];
      expect(limit?.minutesToExhaustion).toBeNull();
      expect(limit?.projectedExhaustionAt).toBeNull();
    }

    const text = renderTextForecast(forecast);
    const markdown = renderMarkdownForecast(forecast);
    expect(text).toContain("already exhausted at");
    expect(text).toContain("FLEET BURN — 6h moving average");
    expect(text).toContain("Codex: 120 pp/h · 4 measurable accounts");
    expect(text).toContain("exhausts before reset at");
    expect(text).toContain("reset before projected exhaustion at");
    expect(text).toContain("exhaustion projected at");
    expect(text).toContain("not consuming");
    expect(text).toContain("insufficient history");
    expect(markdown).toContain("## Who exhausts next");
    expect(markdown).toContain("## Fleet burn");
    expect(markdown).toContain("| Codex | 120 pp/h | 4 |");
    expect(markdown).toContain("| Limit | Consumed | Rate | Basis |");
    for (const [minutes, label] of [
      [7 * 24 * 60, "1w"],
      [24 * 60, "1d"],
      [30, "30m"],
    ] as const) {
      expect(
        renderTextForecast({
          ...forecast,
          fleetBurn: forecast.fleetBurn.map((burn) => ({
            ...burn,
            smoothingWindowMinutes: minutes,
          })),
        }),
      ).toContain(`FLEET BURN — ${label} moving average`);
    }

    const resetFirst = forecast.accounts.find(
      (account) => account.accountAlias === "reset-first",
    );
    const firstRisk = forecast.riskRanking[0];
    expect(resetFirst).toBeDefined();
    expect(firstRisk).toBeDefined();
    if (resetFirst === undefined || firstRisk === undefined) {
      return;
    }
    const edgeText = renderTextForecast({
      ...forecast,
      riskRanking: [
        {
          ...firstRisk,
          projectedExhaustionAt: null,
          minutesToExhaustion: null,
        },
      ],
      accounts: [
        {
          ...resetFirst,
          status: "error",
          error: { code: "timeout", message: "Usage check timed out." },
          limits: resetFirst.limits.map((limit) => ({
            ...limit,
            projectedExhaustionAt: null,
            projectedExhaustionRangeEndAt: null,
          })),
        },
      ],
    });
    expect(edgeText).toContain("unknown time");
    expect(edgeText).toContain("ERROR timeout — Usage check timed out.");
    expect(edgeText).toContain("reset before projected exhaustion at unknown");
  });
});
