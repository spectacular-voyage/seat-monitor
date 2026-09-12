import {
  cliForecastSchema,
  type CliForecast,
  type CliForecastLimit,
} from "../domain/cli-forecast.js";
import type { HistoryAnalytics } from "../domain/history.js";

function minutesToExhaustion(
  projectedExhaustionAt: string | null,
  nowMilliseconds: number,
): number | null {
  if (projectedExhaustionAt === null) {
    return null;
  }
  return Math.max(
    0,
    Math.ceil((Date.parse(projectedExhaustionAt) - nowMilliseconds) / 60_000),
  );
}

export function buildCliForecast(analytics: HistoryAnalytics): CliForecast {
  const nowMilliseconds = Date.parse(analytics.generatedAt);
  const fleetBurn = analytics.fleetThroughput.vendors.map((vendor) => {
    const latest = vendor.points.at(-1);
    return {
      platform: vendor.platform,
      totalRatePercentPerHour: latest?.ratePercentPerHour ?? null,
      accountCount: latest?.accountCount ?? 0,
      observedAt: latest?.observedAt ?? null,
      rateWindowMinutes: analytics.fleetThroughput.rateWindowMinutes,
      smoothingWindowMinutes: analytics.fleetThroughput.smoothingWindowMinutes,
    };
  });
  const accounts = analytics.accounts.map((account) => ({
    accountAlias: account.accountAlias,
    platform: account.platform,
    plan: account.plan,
    observedAt: account.observedAt,
    status: account.status,
    error: account.error,
    limits: account.limits.map((limit): CliForecastLimit => ({
      key: limit.key,
      label: limit.label,
      usedPercent: limit.currentUsedPercent,
      ratePercentPerHour: limit.projection.ratePercentPerHour,
      rateBasis: limit.projection.rateBasis,
      projectionStatus: limit.projection.status,
      projectedExhaustionAt: limit.projection.projectedExhaustionAt,
      projectedExhaustionRangeEndAt:
        limit.projection.projectedExhaustionRangeEndAt,
      minutesToExhaustion: minutesToExhaustion(
        limit.projection.projectedExhaustionAt,
        nowMilliseconds,
      ),
      resetAt: limit.resetAt,
      resetSource: limit.resetSource,
      sampleCount: limit.projection.sampleCount,
      observationSpanMinutes: limit.projection.spanMinutes,
    })),
  }));
  const riskRanking = accounts
    .flatMap((account) =>
      account.limits
        .filter(
          (limit) =>
            limit.projectionStatus === "already_exhausted" ||
            limit.projectionStatus === "exhausts_before_reset" ||
            limit.projectionStatus === "exhaustion_projected",
        )
        .map((limit) => ({ account, limit })),
    )
    .sort((left, right) => {
      const leftAt = left.limit.projectedExhaustionAt;
      const rightAt = right.limit.projectedExhaustionAt;
      return (
        (leftAt === null ? Number.POSITIVE_INFINITY : Date.parse(leftAt)) -
          (rightAt === null ? Number.POSITIVE_INFINITY : Date.parse(rightAt)) ||
        left.account.accountAlias.localeCompare(right.account.accountAlias) ||
        left.limit.key.localeCompare(right.limit.key)
      );
    })
    .map(({ account, limit }, index) => ({
      rank: index + 1,
      accountAlias: account.accountAlias,
      platform: account.platform,
      limitKey: limit.key,
      label: limit.label,
      projectionStatus: limit.projectionStatus,
      projectedExhaustionAt: limit.projectedExhaustionAt,
      projectedExhaustionRangeEndAt: limit.projectedExhaustionRangeEndAt,
      minutesToExhaustion: limit.minutesToExhaustion,
      resetAt: limit.resetAt,
      resetSource: limit.resetSource,
    }));

  return cliForecastSchema.parse({
    apiVersion: 1,
    generatedAt: analytics.generatedAt,
    historyHealth: analytics.historyHealth,
    riskRanking,
    fleetBurn,
    accounts,
  });
}
