import { describe, expect, it } from "vitest";
import type { HistoryAnalytics } from "../../src/domain/history.js";
import { projectExhaustion } from "../../src/history/analytics.js";
import { buildFleetQuotaTotals } from "../../src/history/fleet-quota.js";
import type { HistoryLimitSeries } from "../../src/history/types.js";

const now = Date.parse("2026-11-04T12:00:00Z");
const at = (minutes: number) => new Date(now + minutes * 60_000).toISOString();
type Account = HistoryAnalytics["accounts"][number];
function account(
  alias: string,
  used: number | null,
  rate: number | null,
  platform: "Claude" | "Codex" = "Claude",
  resetMinutes: number | null = 240,
): Account {
  return {
    accountAlias: alias,
    platform,
    plan: null,
    status: "ok",
    error: null,
    observedAt: at(0),
    lastActivityAt: null,
    limits: [
      {
        key: platform === "Claude" ? "base.weekly" : "codex.primary",
        label: "Quota",
        depth: 0,
        parentKey: null,
        availability: "available",
        currentUsedPercent: used,
        headroomPercent: used === null ? null : 100 - used,
        windowDurationMinutes: 10080,
        resetAt: resetMinutes === null ? null : at(resetMinutes),
        resetSource: "provider",
        minutesUntilReset: resetMinutes,
        points: [],
        resetMarkers: [],
        projection: {
          ...projectExhaustion([], null),
          ratePercentPerHour: rate,
        },
      },
    ],
  };
}
function series(
  member: Account,
  samples: [number, number | null][],
  key = member.platform === "Claude" ? "base.weekly" : "codex.primary",
): HistoryLimitSeries {
  return {
    accountAlias: member.accountAlias,
    platform: member.platform,
    plan: null,
    limit: { key, label: key, scope: "window", availability: "available" },
    points: samples.map(([minutes, used]) => ({
      observedAt: at(minutes),
      usedPercent: used,
      minimumUsedPercent: used,
      maximumUsedPercent: used,
      resetAt: null,
      windowDurationMinutes: 10080,
      sampleCount: 1,
      resolution: "raw",
    })),
  };
}
function totals(accounts: Account[], history: HistoryLimitSeries[] = []) {
  return buildFleetQuotaTotals(accounts, history, now - 3_600_000, now, 60);
}

describe("fleet quota totals", () => {
  it("normalizes each provider separately and excludes session/Fable usage", () => {
    const one = account("one", 20, 10),
      two = account("two", 80, 30),
      codex = account("one", 25, 5, "Codex", 60);
    const result = totals(
      [one, two, codex],
      [
        series(one, [
          [-2, 10],
          [0, 20],
        ]),
        series(two, [
          [-2, 70],
          [0, 80],
        ]),
        series(one, [[0, 99]], "base.session"),
        series(one, [[0, 99]], "fable.weekly"),
        series(codex, [[0, 25]]),
      ],
    );
    expect(result[0]).toMatchObject({
      accountCount: 2,
      currentUsedPercent: 50,
      ratePercentPerHour: 20,
      status: "exhaustion_projected",
      projectedExhaustionAt: at(150),
      projectionEndUsedPercent: 100,
    });
    expect(result[0]?.points.map((p) => p.usedPercent)).toEqual([40, 50]);
    expect(result[1]).toMatchObject({
      accountCount: 1,
      currentUsedPercent: 25,
      ratePercentPerHour: 5,
      status: "reset_before_exhaustion",
      projectedExhaustionAt: null,
      projectionEndAt: at(60),
      projectionEndUsedPercent: 30,
    });
  });

  it("does not count missing or stale accounts as unused quota", () => {
    const one = account("one", 50, 10),
      missing = account("missing", null, null);
    const result = totals([one, missing], [series(one, [[0, 50]])])[0];
    expect(result).toMatchObject({
      accountCount: 2,
      currentUsedPercent: null,
      status: "unavailable",
      projectionEndAt: null,
    });
    expect(result?.points[0]?.usedPercent).toBeNull();
    const stale = account("stale", 30, 10);
    stale.observedAt = at(-6);
    expect(totals([one, stale])[0]?.status).toBe("unavailable");
    const noLimit = { ...one, limits: [] };
    expect(totals([noLimit])[0]?.currentUsedPercent).toBeNull();
  });

  it("joins staggered readings but leaves unknown and stale history gaps", () => {
    const one = account("ONE", 60, 10),
      two = account("two", 70, 10);
    const historyOne = series(one, [
      [-10, 50],
      [-9, 55],
      [-8, null],
      [-7, 60],
      [0, 60],
    ]);
    historyOne.accountAlias = "one";
    const result = totals([one, two], [historyOne, series(two, [[-9, 70]])])[0];
    expect(result?.points.map((p) => p.usedPercent)).toEqual([
      null,
      62.5,
      null,
      65,
      null,
    ]);
    expect(result?.points.at(-1)?.breakBefore).toBe(true);
  });

  it("uses rollup freshness for hourly and daily history", () => {
    const one = account("one", 60, 10),
      two = account("two", 70, 10);
    const a = series(one, [
        [-30, 60],
        [0, 60],
      ]),
      b = series(two, [[-30, 70]]);
    for (const entry of [a, b])
      for (const p of entry.points) p.resolution = "hour";
    expect(
      totals([one, two], [a, b])[0]?.points.map((p) => p.usedPercent),
    ).toEqual([65, 65]);
  });

  it("requires a rate for each account with remaining quota", () => {
    expect(
      totals([account("one", 50, 10), account("two", 50, null)])[0],
    ).toMatchObject({
      status: "insufficient_history",
      projectionEndAt: null,
      currentUsedPercent: 50,
    });
    expect(
      totals([
        account("one", 50, 10, "Claude", null),
        account("two", 100, null, "Claude", null),
      ])[0],
    ).toMatchObject({
      status: "exhaustion_projected",
      currentUsedPercent: 75,
      ratePercentPerHour: 5,
    });
  });

  it.each([
    [50, 0, "not_consuming"],
    [100, null, "already_exhausted"],
    [50, 0.001, "beyond_horizon"],
  ] as const)(
    "handles %s%% used at %s pp/h without an unbounded exhaustion date",
    (used, rate, status) => {
      const result = totals([account("one", used, rate, "Claude", null)])[0];
      expect(result?.status).toBe(status);
      expect(result?.projectedExhaustionAt).toBeNull();
      expect(result?.projectionEndAt).toBe(
        status === "beyond_horizon" ? at(7 * 24 * 60) : null,
      );
    },
  );

  it("does not assume a past reset restores capacity", () => {
    expect(totals([account("one", 80, 10, "Claude", -10)])[0]).toMatchObject({
      status: "exhaustion_projected",
      nextResetAt: null,
      projectedExhaustionAt: at(120),
    });
  });

  it("reports an empty fleet without inventing zero usage", () => {
    expect(
      totals([]).every(
        (total) =>
          total.status === "unavailable" &&
          total.currentUsedPercent === null &&
          total.points.length === 0,
      ),
    ).toBe(true);
  });
});
