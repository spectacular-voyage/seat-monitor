import {
  historyAnalyticsSchema,
  type AnalyticsLimit,
  type HistoryAnalytics,
  type Projection,
} from "../domain/history.js";
import type { QuotaSnapshot } from "../domain/quota.js";
import { MINIMUM_USABLE_HEADROOM_PERCENT } from "../presentation/quota-constants.js";
import { buildQuotaReport } from "../presentation/quota-report.js";
import { toPublicSnapshots } from "../presentation/public-dto.js";
import { minutesUntilReset } from "../services/time.js";
import type { HistoryHealth } from "./service.js";
import type {
  HistoryLimitSeries,
  HistoryResolution,
  HistorySeriesPoint,
} from "./types.js";

const MINIMUM_RATE_SPAN_MINUTES = 15;
const MINIMUM_RATE_SAMPLES = 3;
const MINIMUM_MEASURABLE_CHANGE = 0.5;
const MATERIAL_DROP_PERCENT = 5;
const MAXIMUM_CHART_POINTS = 500;
const PERIOD_CONTEXT_MULTIPLIER = 1.05;
const RESET_JITTER_MILLISECONDS = 120_000;

type MeasuredPoint = HistorySeriesPoint & { usedPercent: number };
type RateBasis = "epoch" | "recent_30m" | "recent_1h" | "recent_3h";
type RateCandidate = { basis: RateBasis; rate: number };

function isSparkLimit(key: string): boolean {
  return key.startsWith("codex_bengalfox.");
}

function seriesKey(
  accountAlias: string,
  platform: string,
  limitKey: string,
): string {
  return `${platform}\0${accountAlias.toLocaleLowerCase("en-US")}\0${limitKey}`;
}

function latestActivityAt(
  accountAlias: string,
  platform: string,
  series: readonly HistoryLimitSeries[],
): string | null {
  let latestMilliseconds: number | null = null;
  for (const limit of series) {
    if (
      limit.platform !== platform ||
      limit.accountAlias.toLocaleLowerCase("en-US") !==
        accountAlias.toLocaleLowerCase("en-US")
    ) {
      continue;
    }
    const measured = limit.points
      .filter(
        (point): point is HistorySeriesPoint & { usedPercent: number } =>
          point.usedPercent !== null,
      )
      .sort(
        (left, right) =>
          Date.parse(left.observedAt) - Date.parse(right.observedAt),
      );
    const first = measured[0];
    if (first !== undefined && first.usedPercent > 0) {
      latestMilliseconds = Math.max(
        latestMilliseconds ?? Number.NEGATIVE_INFINITY,
        Date.parse(first.observedAt),
      );
    }
    for (let index = 1; index < measured.length; index += 1) {
      const previous = measured[index - 1];
      const current = measured[index];
      if (
        previous !== undefined &&
        current !== undefined &&
        current.usedPercent > previous.usedPercent
      ) {
        latestMilliseconds = Math.max(
          latestMilliseconds ?? Number.NEGATIVE_INFINITY,
          Date.parse(current.observedAt),
        );
      }
    }
  }
  return latestMilliseconds === null
    ? null
    : new Date(latestMilliseconds).toISOString();
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const value = sorted[middle];
  if (value === undefined) {
    throw new RangeError("A median requires at least one value.");
  }
  if (sorted.length % 2 === 1) {
    return value;
  }
  const previous = sorted[middle - 1];
  if (previous === undefined) {
    throw new RangeError("A median pair is incomplete.");
  }
  return (previous + value) / 2;
}

function latestEpoch(points: readonly HistorySeriesPoint[]): MeasuredPoint[] {
  const measured = points
    .filter((point): point is MeasuredPoint => point.usedPercent !== null)
    .sort(
      (left, right) =>
        Date.parse(left.observedAt) - Date.parse(right.observedAt),
    );
  const latest = measured.at(-1);
  if (latest === undefined) {
    return [];
  }
  if (latest.resetAt !== null) {
    const latestReset = Date.parse(latest.resetAt);
    return measured.filter(
      (point) =>
        point.resetAt !== null &&
        Math.abs(Date.parse(point.resetAt) - latestReset) <=
          RESET_JITTER_MILLISECONDS,
    );
  }

  let epochStart = 0;
  for (let index = 1; index < measured.length; index += 1) {
    const previous = measured[index - 1];
    const current = measured[index];
    if (
      previous !== undefined &&
      current !== undefined &&
      previous.usedPercent - current.usedPercent >= MATERIAL_DROP_PERCENT
    ) {
      epochStart = index;
    }
  }
  return measured.slice(epochStart);
}

function monotonicUsage(points: readonly MeasuredPoint[]): MeasuredPoint[] {
  let maximum = 0;
  return points.map((point) => {
    maximum = Math.max(maximum, point.usedPercent);
    return { ...point, usedPercent: maximum };
  });
}

function pairwiseRate(points: readonly MeasuredPoint[]): number | null {
  const slopes: number[] = [];
  for (let leftIndex = 0; leftIndex < points.length; leftIndex += 1) {
    const left = points[leftIndex];
    if (left === undefined) {
      continue;
    }
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < points.length;
      rightIndex += 1
    ) {
      const right = points[rightIndex];
      if (right === undefined) {
        continue;
      }
      const hours =
        (Date.parse(right.observedAt) - Date.parse(left.observedAt)) /
        3_600_000;
      if (hours > 0) {
        slopes.push((right.usedPercent - left.usedPercent) / hours);
      }
    }
  }
  return slopes.length === 0 ? null : median(slopes);
}

function recentEndpointRate(
  points: readonly MeasuredPoint[],
  latestMilliseconds: number,
  minutes: number,
): number | null {
  const recent = points.filter(
    (point) =>
      Date.parse(point.observedAt) >= latestMilliseconds - minutes * 60_000,
  );
  const first = recent[0];
  const latest = recent.at(-1);
  if (first === undefined || latest === undefined || recent.length < 3) {
    return null;
  }
  const spanHours =
    (Date.parse(latest.observedAt) - Date.parse(first.observedAt)) / 3_600_000;
  const change = latest.usedPercent - first.usedPercent;
  if (
    spanHours * 60 < MINIMUM_RATE_SPAN_MINUTES ||
    change < 2 ||
    spanHours <= 0
  ) {
    return null;
  }
  return change / spanHours;
}

function projectedAt(
  observedMilliseconds: number,
  usedPercent: number,
  rate: number,
): number {
  return observedMilliseconds + ((100 - usedPercent) / rate) * 3_600_000;
}

export function projectExhaustion(
  points: readonly HistorySeriesPoint[],
  effectiveResetAt: string | null,
): Projection {
  const epoch = latestEpoch(points);
  const monotonicEpoch = monotonicUsage(epoch);
  const first = monotonicEpoch[0];
  const latest = monotonicEpoch.at(-1);
  if (first === undefined || latest === undefined) {
    return {
      status: "insufficient_history",
      ratePercentPerHour: null,
      rateBasis: null,
      projectedFromUsedPercent: null,
      projectedExhaustionAt: null,
      projectedExhaustionRangeEndAt: null,
      sampleCount: epoch.length,
      spanMinutes: 0,
    };
  }
  const spanMinutes = Math.max(
    0,
    (Date.parse(latest.observedAt) - Date.parse(first.observedAt)) / 60_000,
  );
  if (latest.usedPercent === 100) {
    return {
      status: "already_exhausted",
      ratePercentPerHour: null,
      rateBasis: null,
      projectedFromUsedPercent: latest.usedPercent,
      projectedExhaustionAt: latest.observedAt,
      projectedExhaustionRangeEndAt: null,
      sampleCount: epoch.length,
      spanMinutes,
    };
  }
  const usageValues = epoch.map((point) => point.usedPercent);
  if (
    epoch.length < MINIMUM_RATE_SAMPLES ||
    spanMinutes < MINIMUM_RATE_SPAN_MINUTES ||
    Math.max(...usageValues) - Math.min(...usageValues) <
      MINIMUM_MEASURABLE_CHANGE
  ) {
    return {
      status: "insufficient_history",
      ratePercentPerHour: null,
      rateBasis: null,
      projectedFromUsedPercent: latest.usedPercent,
      projectedExhaustionAt: null,
      projectedExhaustionRangeEndAt: null,
      sampleCount: epoch.length,
      spanMinutes,
    };
  }

  const epochRate = pairwiseRate(monotonicEpoch);
  if (epochRate === null) {
    return {
      status: "insufficient_history",
      ratePercentPerHour: null,
      rateBasis: null,
      projectedFromUsedPercent: latest.usedPercent,
      projectedExhaustionAt: null,
      projectedExhaustionRangeEndAt: null,
      sampleCount: epoch.length,
      spanMinutes,
    };
  }
  const latestMilliseconds = Date.parse(latest.observedAt);
  const candidates: RateCandidate[] = [];
  if (Number.isFinite(epochRate) && epochRate > 0) {
    candidates.push({ basis: "epoch", rate: epochRate });
  }
  for (const window of [
    { basis: "recent_30m", minutes: 30 },
    { basis: "recent_1h", minutes: 60 },
    { basis: "recent_3h", minutes: 180 },
  ] as const) {
    const rate = recentEndpointRate(
      monotonicEpoch,
      latestMilliseconds,
      window.minutes,
    );
    if (rate !== null && Number.isFinite(rate) && rate > 0) {
      candidates.push({ basis: window.basis, rate });
    }
  }
  const selected = candidates.reduce<RateCandidate | null>(
    (best, candidate) =>
      best === null || candidate.rate > best.rate ? candidate : best,
    null,
  );
  if (selected === null) {
    return {
      status: "not_consuming",
      ratePercentPerHour: 0,
      rateBasis: null,
      projectedFromUsedPercent: latest.usedPercent,
      projectedExhaustionAt: null,
      projectedExhaustionRangeEndAt: null,
      sampleCount: epoch.length,
      spanMinutes,
    };
  }

  const exhaustionMilliseconds = projectedAt(
    latestMilliseconds,
    latest.usedPercent,
    selected.rate,
  );
  const projectedExhaustionAt = new Date(exhaustionMilliseconds).toISOString();
  const resetMilliseconds =
    effectiveResetAt === null ? null : Date.parse(effectiveResetAt);
  const baselineExhaustionMilliseconds =
    epochRate > 0
      ? projectedAt(latestMilliseconds, latest.usedPercent, epochRate)
      : exhaustionMilliseconds;
  const projectedExhaustionRangeEndAt =
    baselineExhaustionMilliseconds > exhaustionMilliseconds + 60_000 &&
    (resetMilliseconds === null ||
      baselineExhaustionMilliseconds < resetMilliseconds)
      ? new Date(baselineExhaustionMilliseconds).toISOString()
      : null;
  return {
    status:
      resetMilliseconds === null
        ? "exhaustion_projected"
        : exhaustionMilliseconds < resetMilliseconds
          ? "exhausts_before_reset"
          : "reset_before_exhaustion",
    ratePercentPerHour: Number(selected.rate.toFixed(3)),
    rateBasis: selected.basis,
    projectedFromUsedPercent: latest.usedPercent,
    projectedExhaustionAt,
    projectedExhaustionRangeEndAt,
    sampleCount: epoch.length,
    spanMinutes,
  };
}

function inferredMarkers(
  points: readonly HistorySeriesPoint[],
): { at: string; kind: "inferred" }[] {
  const markers: { at: string; kind: "inferred" }[] = [];
  const measured = points.filter(
    (point): point is HistorySeriesPoint & { usedPercent: number } =>
      point.usedPercent !== null,
  );
  for (let index = 1; index < measured.length; index += 1) {
    const previous = measured[index - 1];
    const current = measured[index];
    if (
      previous !== undefined &&
      current !== undefined &&
      previous.usedPercent - current.usedPercent >= MATERIAL_DROP_PERCENT &&
      previous.resetAt === current.resetAt
    ) {
      markers.push({ at: current.observedAt, kind: "inferred" });
    }
  }
  return markers;
}

export function providerResetMarkers(
  points: readonly HistorySeriesPoint[],
): { at: string; kind: "provider" | "adjustment" }[] {
  const candidates = points
    .filter(
      (point): point is HistorySeriesPoint & { resetAt: string } =>
        point.resetAt !== null,
    )
    .sort(
      (left, right) =>
        Date.parse(left.observedAt) - Date.parse(right.observedAt),
    );
  const markers: { at: string; kind: "provider" | "adjustment" }[] = [];
  const seen = new Set<string>();
  for (let index = 1; index < candidates.length; index += 1) {
    const previous = candidates[index - 1];
    const current = candidates[index];
    if (previous === undefined || current === undefined) {
      continue;
    }
    const previousObserved = Date.parse(previous.observedAt);
    const currentObserved = Date.parse(current.observedAt);
    const previousReset = Date.parse(previous.resetAt);
    const currentReset = Date.parse(current.resetAt);
    const observedDelta = currentObserved - previousObserved;
    const resetDelta = currentReset - previousReset;
    if (
      observedDelta <= 0 ||
      Math.abs(resetDelta) <= RESET_JITTER_MILLISECONDS
    ) {
      continue;
    }
    const rollingTolerance = Math.max(
      RESET_JITTER_MILLISECONDS,
      observedDelta * 0.2,
    );
    if (Math.abs(resetDelta - observedDelta) <= rollingTolerance) {
      continue;
    }

    const crossedBoundary =
      previousReset >= previousObserved - RESET_JITTER_MILLISECONDS &&
      previousReset <= currentObserved + RESET_JITTER_MILLISECONDS;
    const marker = {
      at: new Date(
        crossedBoundary ? previousReset : currentObserved,
      ).toISOString(),
      kind: crossedBoundary ? ("provider" as const) : ("adjustment" as const),
    };
    const markerKey = `${marker.kind}\0${marker.at}`;
    if (!seen.has(markerKey)) {
      seen.add(markerKey);
      markers.push(marker);
    }
  }
  return markers;
}

function downsample(
  points: readonly HistorySeriesPoint[],
): HistorySeriesPoint[] {
  if (points.length <= MAXIMUM_CHART_POINTS) {
    return [...points];
  }
  const selected: HistorySeriesPoint[] = [];
  for (let index = 0; index < MAXIMUM_CHART_POINTS; index += 1) {
    const sourceIndex = Math.round(
      (index / (MAXIMUM_CHART_POINTS - 1)) * (points.length - 1),
    );
    const point = points[sourceIndex];
    if (point !== undefined && selected.at(-1) !== point) {
      selected.push(point);
    }
  }
  return selected;
}

function fableRecommendation(
  accounts: HistoryAnalytics["accounts"],
): HistoryAnalytics["recommendations"]["fable"] {
  const candidates = accounts.flatMap((account) => {
    if (account.platform !== "Claude" || account.status !== "ok") {
      return [];
    }
    const constraints = ["base.session", "base.weekly", "fable.weekly"]
      .map((key) => account.limits.find((limit) => limit.key === key))
      .filter((limit): limit is AnalyticsLimit => limit !== undefined);
    const fable = constraints.find((limit) => limit.key === "fable.weekly");
    if (
      constraints.length !== 3 ||
      fable?.availability !== "available" ||
      constraints.some((limit) => limit.headroomPercent === null)
    ) {
      return [];
    }
    const effectiveHeadroomPercent = Math.min(
      ...constraints.map((limit) => limit.headroomPercent ?? 0),
    );
    const projectedExhaustions = constraints
      .filter(
        (limit) =>
          limit.projection.status === "exhausts_before_reset" &&
          limit.projection.projectedExhaustionAt !== null,
      )
      .map((limit) => limit.projection.projectedExhaustionAt ?? "")
      .sort();
    const projectedExhaustionAt = projectedExhaustions[0] ?? null;
    const atRisk = projectedExhaustionAt !== null;
    return [
      {
        accountAlias: account.accountAlias,
        effectiveHeadroomPercent,
        projectedExhaustionAt,
        atRisk,
        resetMilliseconds: Math.min(
          ...constraints
            .map((limit) =>
              limit.resetAt === null
                ? Number.POSITIVE_INFINITY
                : Date.parse(limit.resetAt),
            )
            .filter(Number.isFinite),
        ),
      },
    ];
  });
  candidates.sort(
    (left, right) =>
      Number(left.atRisk) - Number(right.atRisk) ||
      (left.effectiveHeadroomPercent >= MINIMUM_USABLE_HEADROOM_PERCENT
        ? 0
        : 1) -
        (right.effectiveHeadroomPercent >= MINIMUM_USABLE_HEADROOM_PERCENT
          ? 0
          : 1) ||
      left.resetMilliseconds - right.resetMilliseconds ||
      left.accountAlias.localeCompare(right.accountAlias),
  );
  const candidate = candidates[0];
  if (candidate === undefined) {
    return null;
  }
  const healthy =
    !candidate.atRisk &&
    candidate.effectiveHeadroomPercent >= MINIMUM_USABLE_HEADROOM_PERCENT;
  return {
    accountAlias: candidate.accountAlias,
    action: healthy ? "use" : "conserve",
    effectiveHeadroomPercent: candidate.effectiveHeadroomPercent,
    projectedExhaustionAt: candidate.projectedExhaustionAt,
    reason: candidate.atRisk
      ? "projected_before_reset"
      : healthy
        ? "healthy_fable_capacity"
        : "limited_headroom",
  };
}

export function buildHistoryAnalytics(options: {
  snapshots: readonly QuotaSnapshot[];
  series: readonly HistoryLimitSeries[];
  historyHealth: HistoryHealth;
  nowMilliseconds: number;
  fromMilliseconds: number;
  toMilliseconds: number;
  requestedResolution: HistoryResolution;
  periodMultiplier?: NonNullable<HistoryAnalytics["periodMultiplier"]>;
  lastScanAt?: string;
  scanIntervalSeconds?: number;
  showSpark?: boolean;
  timeZone: string;
}): HistoryAnalytics {
  const publicSnapshots = toPublicSnapshots(
    options.snapshots,
    options.nowMilliseconds,
  );
  const report = buildQuotaReport(publicSnapshots, {
    nowMilliseconds: options.nowMilliseconds,
    timeZone: options.timeZone,
  });
  const visibleSeries =
    options.showSpark === false
      ? options.series.filter((series) => !isSparkLimit(series.limit.key))
      : options.series;
  const seriesByKey = new Map(
    visibleSeries.map((series) => [
      seriesKey(series.accountAlias, series.platform, series.limit.key),
      series,
    ]),
  );

  const accounts: HistoryAnalytics["accounts"] = options.snapshots.map(
    (snapshot) => {
      const reportAccount = report.accounts.find(
        (account) =>
          account.accountAlias === snapshot.accountAlias &&
          account.platform === snapshot.platform,
      );
      const reportRows = (reportAccount?.rows ?? []).filter(
        (row) => options.showSpark !== false || !isSparkLimit(row.key),
      );
      const historicalSeries = visibleSeries.filter(
        (series) =>
          series.accountAlias.toLocaleLowerCase("en-US") ===
            snapshot.accountAlias.toLocaleLowerCase("en-US") &&
          series.platform === snapshot.platform,
      );
      const limitKeys =
        reportRows.length > 0
          ? reportRows.map((row) => row.key)
          : historicalSeries.map((series) => series.limit.key);
      const limits = limitKeys.flatMap((key): AnalyticsLimit[] => {
        const row = reportRows.find((candidate) => candidate.key === key);
        const history = seriesByKey.get(
          seriesKey(snapshot.accountAlias, snapshot.platform, key),
        );
        if (row === undefined && history === undefined) {
          return [];
        }
        const isFable =
          snapshot.platform === "Claude" && key.startsWith("fable");
        const parent = reportRows.find(
          (candidate) => candidate.key === "base.weekly",
        );
        const resetAt = isFable
          ? (parent?.resetAt ?? null)
          : (row?.resetAt ?? history?.points.at(-1)?.resetAt ?? null);
        const windowDurationMinutes = isFable
          ? (parent?.windowDurationMinutes ??
            history?.points.at(-1)?.windowDurationMinutes ??
            null)
          : (row?.windowDurationMinutes ??
            history?.points.at(-1)?.windowDurationMinutes ??
            null);
        const points = history?.points ?? [];
        const periodStartMilliseconds =
          options.periodMultiplier === undefined ||
          windowDurationMinutes === null
            ? options.fromMilliseconds
            : Math.max(
                options.fromMilliseconds,
                options.toMilliseconds -
                  windowDurationMinutes *
                    options.periodMultiplier *
                    PERIOD_CONTEXT_MULTIPLIER *
                    60_000,
              );
        const chartPoints = points.filter(
          (point) => Date.parse(point.observedAt) >= periodStartMilliseconds,
        );
        const providerMarkers = isFable ? [] : providerResetMarkers(points);
        return [
          {
            key,
            label: row?.label ?? history?.limit.label ?? key,
            depth: row?.depth ?? (isFable ? 1 : 0),
            parentKey: row?.parentKey ?? (isFable ? "base.weekly" : null),
            availability:
              row?.support ?? history?.limit.availability ?? "unsupported",
            currentUsedPercent:
              row?.consumedPercent ?? points.at(-1)?.usedPercent ?? null,
            headroomPercent:
              row?.headroomPercent ??
              (points.at(-1)?.usedPercent === null ||
              points.at(-1)?.usedPercent === undefined
                ? null
                : 100 - (points.at(-1)?.usedPercent ?? 100)),
            windowDurationMinutes,
            resetAt,
            minutesUntilReset: minutesUntilReset(
              resetAt,
              options.nowMilliseconds,
            ),
            points: downsample(chartPoints),
            resetMarkers: isFable
              ? []
              : [...providerMarkers, ...inferredMarkers(points)].sort(
                  (left, right) => Date.parse(left.at) - Date.parse(right.at),
                ),
            projection: projectExhaustion(points, resetAt),
          },
        ];
      });
      return {
        accountAlias: snapshot.accountAlias,
        platform: snapshot.platform,
        plan: snapshot.plan,
        observedAt: snapshot.observedAt,
        lastActivityAt: latestActivityAt(
          snapshot.accountAlias,
          snapshot.platform,
          visibleSeries,
        ),
        status: snapshot.status,
        error: snapshot.status === "error" ? snapshot.error : null,
        limits,
      };
    },
  );
  accounts.sort(
    (left, right) =>
      (right.lastActivityAt === null
        ? Number.NEGATIVE_INFINITY
        : Date.parse(right.lastActivityAt)) -
        (left.lastActivityAt === null
          ? Number.NEGATIVE_INFINITY
          : Date.parse(left.lastActivityAt)) ||
      Date.parse(right.observedAt) - Date.parse(left.observedAt) ||
      left.accountAlias.localeCompare(right.accountAlias),
  );
  const watch = report.watch;

  return historyAnalyticsSchema.parse({
    apiVersion: 1,
    generatedAt: new Date(options.nowMilliseconds).toISOString(),
    from: new Date(options.fromMilliseconds).toISOString(),
    to: new Date(options.toMilliseconds).toISOString(),
    requestedResolution: options.requestedResolution,
    periodMultiplier: options.periodMultiplier ?? null,
    lastScanAt: options.lastScanAt ?? null,
    scanIntervalSeconds: options.scanIntervalSeconds ?? null,
    historyHealth: options.historyHealth,
    accounts,
    recommendations: {
      general:
        report.use === null
          ? null
          : {
              accountAlias: report.use.accountAlias,
              platform: report.use.platform,
              limitLabel: report.use.limitLabel,
              headroomPercent: report.use.headroomPercent,
              resetAt: report.use.resetAt,
            },
      watch:
        watch?.row.consumedPercent === null || watch === null
          ? null
          : {
              accountAlias: watch.accountAlias,
              platform: watch.platform,
              limitKey: watch.row.key,
              consumedPercent: watch.row.consumedPercent,
            },
      fable: fableRecommendation(accounts),
    },
  });
}
