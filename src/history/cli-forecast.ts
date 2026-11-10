import {
  cliForecastSchema,
  type CliForecast,
  type CliForecastLimit,
  type QuotaReadSource,
} from "../domain/cli-forecast.js";
import { readingFreshness } from "../domain/freshness.js";
import type { HistoryAnalytics } from "../domain/history.js";

/** The key `cachedAccounts` entries use for one account. */
export function forecastAccountKey(platform: string, accountAlias: string) {
  return `${platform}\0${accountAlias}`;
}

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

export function buildCliForecast(
  analytics: HistoryAnalytics,
  options: {
    source?: QuotaReadSource;
    // Accounts whose current reading is a cached fallback (forecastAccountKey).
    cachedAccounts?: ReadonlySet<string>;
  } = {},
): CliForecast {
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
    ...(account.status === "ok"
      ? readingFreshness(
          account.observedAt,
          options.cachedAccounts?.has(
            forecastAccountKey(account.platform, account.accountAlias),
          ) ?? false,
          nowMilliseconds,
        )
      : {
          ...readingFreshness(account.observedAt, false, nowMilliseconds),
          stale: false,
        }),
    status: account.status,
    error: account.error,
    limits: account.limits.map((limit): CliForecastLimit => ({
      key: limit.key,
      ...(limit.applicability === undefined
        ? {}
        : { applicability: limit.applicability }),
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
            limit.projectionStatus === "exhaustion_projected" ||
            limit.projectionStatus === "reset_unconfirmed",
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
    source: options.source ?? { kind: "scan" },
    historyHealth: analytics.historyHealth,
    riskRanking,
    fleetBurn,
    accounts,
  });
}
