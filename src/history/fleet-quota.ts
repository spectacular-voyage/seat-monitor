import type { HistoryAnalytics } from "../domain/history.js";
import type { HistoryLimitSeries, HistorySeriesPoint } from "./types.js";

type FleetTotal = HistoryAnalytics["fleetThroughput"]["totals"][number];
const FRESH_READING_MILLISECONDS = 300_000;
const FORECAST_HORIZON_MILLISECONDS = 7 * 86_400_000;

function readingLifetime(point: HistorySeriesPoint): number {
  return point.resolution === "day"
    ? 36 * 3_600_000
    : point.resolution === "hour"
      ? 90 * 60_000
      : FRESH_READING_MILLISECONDS;
}

export function buildFleetQuotaTotals(
  accounts: HistoryAnalytics["accounts"],
  series: readonly HistoryLimitSeries[],
  fromMilliseconds: number,
  toMilliseconds: number,
  scanIntervalSeconds: number,
): FleetTotal[] {
  return (["Claude", "Codex"] as const).map((platform): FleetTotal => {
    const members = accounts.filter((account) => account.platform === platform);
    const limitKey = platform === "Claude" ? "base.weekly" : "codex.primary";
    const limits = members.map((account) =>
      account.limits.find((limit) => limit.key === limitKey),
    );
    // Keep a fixed roster: missing accounts must never silently reduce the denominator.
    const roster = new Set(
      members.map((account) => account.accountAlias.toLowerCase()),
    );
    const bucketMilliseconds = Math.max(
      60_000,
      scanIntervalSeconds * 1_000,
      Math.ceil((toMilliseconds - fromMilliseconds) / 499),
    );
    const buckets = new Map<
      number,
      { alias: string; point: HistorySeriesPoint }[]
    >();
    for (const history of series) {
      const alias = history.accountAlias.toLowerCase();
      if (
        history.platform !== platform ||
        history.limit.key !== limitKey ||
        !roster.has(alias)
      )
        continue;
      for (const point of history.points) {
        const at = Date.parse(point.observedAt);
        if (at < fromMilliseconds || at > toMilliseconds) continue;
        const bucket = Math.floor((at - fromMilliseconds) / bucketMilliseconds);
        const entries = buckets.get(bucket) ?? [];
        entries.push({ alias, point });
        buckets.set(bucket, entries);
      }
    }
    const readings = new Map<string, HistorySeriesPoint>();
    const points: FleetTotal["points"] = [];
    let previousAt: number | null = null;
    for (const [, events] of [...buckets].sort(
      ([left], [right]) => left - right,
    )) {
      events.sort(
        (left, right) =>
          Date.parse(left.point.observedAt) -
          Date.parse(right.point.observedAt),
      );
      for (const event of events) readings.set(event.alias, event.point);
      const latest = events.at(-1);
      if (latest === undefined) continue;
      const at = Date.parse(latest.point.observedAt);
      const values = [...readings.values()];
      const complete =
        readings.size === members.length &&
        values.every(
          (point) =>
            point.usedPercent !== null &&
            at - Date.parse(point.observedAt) <= readingLifetime(point),
        );
      points.push({
        observedAt: latest.point.observedAt,
        usedPercent: complete
          ? values.reduce((sum, point) => sum + (point.usedPercent ?? 0), 0) /
            members.length
          : null,
        breakBefore:
          previousAt !== null &&
          at - previousAt > Math.min(...values.map(readingLifetime)),
      });
      previousAt = at;
    }
    const current =
      members.length > 0 &&
      members.every((account, index) => {
        const age = toMilliseconds - Date.parse(account.observedAt);
        return (
          account.status === "ok" &&
          age >= 0 &&
          age <= FRESH_READING_MILLISECONDS &&
          limits[index]?.currentUsedPercent !== null &&
          limits[index]?.currentUsedPercent !== undefined
        );
      });
    const used = current
      ? limits.reduce(
          (sum, limit) => sum + (limit?.currentUsedPercent ?? 0),
          0,
        ) / members.length
      : null;
    const resets = limits.flatMap((limit) => {
      const at = Date.parse(limit?.resetAt ?? "");
      return at > toMilliseconds ? [at] : [];
    });
    const nextReset = resets.length > 0 ? Math.min(...resets) : null;
    const total: FleetTotal = {
      platform,
      accountCount: members.length,
      observedAt: new Date(toMilliseconds).toISOString(),
      currentUsedPercent: used,
      ratePercentPerHour: null,
      nextResetAt:
        nextReset === null ? null : new Date(nextReset).toISOString(),
      projectedExhaustionAt: null,
      projectionEndAt: null,
      projectionEndUsedPercent: null,
      status: "unavailable",
      points,
    };
    if (used === null) return total;
    if (used >= 100) return { ...total, status: "already_exhausted" };
    const rates = limits.map((limit) =>
      limit?.currentUsedPercent === 100
        ? 0
        : limit?.projection.ratePercentPerHour,
    );
    if (rates.some((rate) => rate === null || rate === undefined))
      return { ...total, status: "insufficient_history" };
    const rate =
      rates.reduce<number>((sum, value) => sum + (value ?? 0), 0) /
      members.length;
    total.ratePercentPerHour = rate;
    if (rate <= 0) return { ...total, status: "not_consuming" };
    // Pooled forecast assumes work can move between accounts. Stop before a refill;
    // do not extrapolate the historical average through drops or missing readings.
    const exhaustion = toMilliseconds + ((100 - used) / rate) * 3_600_000;
    const horizon = toMilliseconds + FORECAST_HORIZON_MILLISECONDS;
    const end = Math.min(exhaustion, nextReset ?? horizon, horizon);
    total.projectionEndAt = new Date(end).toISOString();
    total.projectionEndUsedPercent = Math.min(
      100,
      used + rate * ((end - toMilliseconds) / 3_600_000),
    );
    if (nextReset !== null && nextReset <= exhaustion && nextReset <= horizon) {
      total.status = "reset_before_exhaustion";
    } else if (exhaustion <= horizon) {
      total.status = "exhaustion_projected";
      total.projectedExhaustionAt = new Date(exhaustion).toISOString();
    } else total.status = "beyond_horizon";
    return total;
  });
}
