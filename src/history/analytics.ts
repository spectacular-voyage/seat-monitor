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
  HistoryResetEvent,
  HistoryResolution,
  HistorySeriesPoint,
} from "./types.js";

const MINIMUM_RATE_SPAN_MINUTES = 15;
const MINIMUM_RATE_SAMPLES = 3;
const MINIMUM_MEASURABLE_CHANGE = 0.5;
const MATERIAL_DROP_PERCENT = 5;
const MAXIMUM_CHART_POINTS = 500;
const PERIOD_CONTEXT_MULTIPLIER = 1.05;

type MeasuredPoint = HistorySeriesPoint & { usedPercent: number };

function seriesKey(
  accountAlias: string,
  platform: string,
  limitKey: string,
): string {
  return `${platform}\0${accountAlias.toLocaleLowerCase("en-US")}\0${limitKey}`;
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
    return measured.filter((point) => point.resetAt === latest.resetAt);
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

export function projectExhaustion(
  points: readonly HistorySeriesPoint[],
  effectiveResetAt: string | null,
): Projection {
  const epoch = latestEpoch(points);
  const first = epoch[0];
  const latest = epoch.at(-1);
  if (first === undefined || latest === undefined) {
    return {
      status: "insufficient_history",
      ratePercentPerHour: null,
      projectedExhaustionAt: null,
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
      projectedExhaustionAt: latest.observedAt,
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
      projectedExhaustionAt: null,
      sampleCount: epoch.length,
      spanMinutes,
    };
  }

  const slopes: number[] = [];
  for (let leftIndex = 0; leftIndex < epoch.length; leftIndex += 1) {
    const left = epoch[leftIndex];
    if (left === undefined) {
      continue;
    }
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < epoch.length;
      rightIndex += 1
    ) {
      const right = epoch[rightIndex];
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
  if (slopes.length === 0) {
    return {
      status: "insufficient_history",
      ratePercentPerHour: null,
      projectedExhaustionAt: null,
      sampleCount: epoch.length,
      spanMinutes,
    };
  }
  const rate = median(slopes);
  if (!Number.isFinite(rate) || rate <= 0) {
    return {
      status: "not_consuming",
      ratePercentPerHour: 0,
      projectedExhaustionAt: null,
      sampleCount: epoch.length,
      spanMinutes,
    };
  }

  const exhaustionMilliseconds =
    Date.parse(latest.observedAt) +
    ((100 - latest.usedPercent) / rate) * 3_600_000;
  const projectedExhaustionAt = new Date(exhaustionMilliseconds).toISOString();
  const resetMilliseconds =
    effectiveResetAt === null ? null : Date.parse(effectiveResetAt);
  return {
    status:
      resetMilliseconds === null
        ? "exhaustion_projected"
        : exhaustionMilliseconds < resetMilliseconds
          ? "exhausts_before_reset"
          : "reset_before_exhaustion",
    ratePercentPerHour: Number(rate.toFixed(3)),
    projectedExhaustionAt,
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
  resetEvents: readonly HistoryResetEvent[];
  historyHealth: HistoryHealth;
  nowMilliseconds: number;
  fromMilliseconds: number;
  toMilliseconds: number;
  requestedResolution: HistoryResolution;
  periodMultiplier?: 1 | 2 | 5 | 10;
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
  const seriesByKey = new Map(
    options.series.map((series) => [
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
      const reportRows = reportAccount?.rows ?? [];
      const historicalSeries = options.series.filter(
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
        const providerMarkers = isFable
          ? []
          : options.resetEvents
              .filter(
                (event) =>
                  event.platform === snapshot.platform &&
                  event.accountAlias.toLocaleLowerCase("en-US") ===
                    snapshot.accountAlias.toLocaleLowerCase("en-US") &&
                  event.limitKey === key,
              )
              .map((event) => ({ at: event.resetAt, kind: event.kind }));
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
        status: snapshot.status,
        error: snapshot.status === "error" ? snapshot.error : null,
        limits,
      };
    },
  );
  const watch = report.watch;

  return historyAnalyticsSchema.parse({
    apiVersion: 1,
    generatedAt: new Date(options.nowMilliseconds).toISOString(),
    from: new Date(options.fromMilliseconds).toISOString(),
    to: new Date(options.toMilliseconds).toISOString(),
    requestedResolution: options.requestedResolution,
    periodMultiplier: options.periodMultiplier ?? null,
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
