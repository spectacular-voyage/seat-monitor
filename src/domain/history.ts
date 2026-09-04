import { z } from "zod";

import {
  platformSchema,
  quotaErrorSchema,
  quotaSnapshotSchema,
} from "./quota.js";

const isoInstantSchema = z.iso.datetime({ offset: true });

export const historyHealthSchema = z.enum(["ready", "degraded", "unavailable"]);

export const historySeriesPointSchema = z
  .object({
    observedAt: isoInstantSchema,
    usedPercent: z.number().min(0).max(100).nullable(),
    minimumUsedPercent: z.number().min(0).max(100).nullable(),
    maximumUsedPercent: z.number().min(0).max(100).nullable(),
    resetAt: isoInstantSchema.nullable(),
    windowDurationMinutes: z.number().positive().nullable(),
    sampleCount: z.number().int().positive(),
    resolution: z.enum(["raw", "hour"]),
  })
  .strict();

export const projectionSchema = z
  .object({
    status: z.enum([
      "insufficient_history",
      "not_consuming",
      "already_exhausted",
      "exhausts_before_reset",
      "reset_before_exhaustion",
      "exhaustion_projected",
    ]),
    ratePercentPerHour: z.number().nonnegative().nullable(),
    rateBasis: z
      .enum(["epoch", "recent_30m", "recent_1h", "recent_3h"])
      .nullable(),
    projectedFromUsedPercent: z.number().min(0).max(100).nullable(),
    projectedExhaustionAt: isoInstantSchema.nullable(),
    projectedExhaustionRangeEndAt: isoInstantSchema.nullable(),
    sampleCount: z.number().int().nonnegative(),
    spanMinutes: z.number().nonnegative(),
  })
  .strict();

export const resetMarkerSchema = z
  .object({
    at: isoInstantSchema,
    kind: z.enum(["provider", "adjustment", "inferred"]),
  })
  .strict();

export const analyticsLimitSchema = z
  .object({
    key: z.string().min(1),
    label: z.string().min(1),
    depth: z.union([z.literal(0), z.literal(1)]),
    parentKey: z.string().min(1).nullable(),
    availability: z.enum(["available", "unsupported"]),
    currentUsedPercent: z.number().min(0).max(100).nullable(),
    headroomPercent: z.number().min(0).max(100).nullable(),
    windowDurationMinutes: z.number().positive().nullable(),
    resetAt: isoInstantSchema.nullable(),
    minutesUntilReset: z.number().int().nonnegative().nullable(),
    points: z.array(historySeriesPointSchema),
    resetMarkers: z.array(resetMarkerSchema),
    projection: projectionSchema,
  })
  .strict();

export const analyticsAccountSchema = z
  .object({
    accountAlias: z.string().min(1),
    platform: platformSchema,
    plan: z.string().min(1).nullable(),
    observedAt: isoInstantSchema,
    lastActivityAt: isoInstantSchema.nullable(),
    status: z.enum(["ok", "error"]),
    error: quotaErrorSchema.nullable(),
    limits: z.array(analyticsLimitSchema),
  })
  .strict();

const useRecommendationSchema = z
  .object({
    accountAlias: z.string().min(1),
    platform: platformSchema,
    limitLabel: z.string().min(1),
    headroomPercent: z.number().min(0).max(100),
    resetAt: isoInstantSchema,
  })
  .strict();

const watchRecommendationSchema = z
  .object({
    accountAlias: z.string().min(1),
    platform: platformSchema,
    limitKey: z.string().min(1),
    consumedPercent: z.number().min(0).max(100),
  })
  .strict();

const fableRecommendationSchema = z
  .object({
    accountAlias: z.string().min(1),
    action: z.enum(["use", "conserve"]),
    effectiveHeadroomPercent: z.number().min(0).max(100),
    projectedExhaustionAt: isoInstantSchema.nullable(),
    reason: z.enum([
      "healthy_fable_capacity",
      "projected_before_reset",
      "limited_headroom",
    ]),
  })
  .strict();

export const historyAnalyticsSchema = z
  .object({
    apiVersion: z.literal(1),
    generatedAt: isoInstantSchema,
    from: isoInstantSchema,
    to: isoInstantSchema,
    requestedResolution: z.enum(["auto", "raw", "hour"]),
    periodMultiplier: z
      .union([
        z.literal(0.5),
        z.literal(1),
        z.literal(2),
        z.literal(5),
        z.literal(10),
      ])
      .nullable(),
    lastScanAt: isoInstantSchema.nullable(),
    scanIntervalSeconds: z.number().positive().nullable(),
    historyHealth: historyHealthSchema,
    accounts: z.array(analyticsAccountSchema),
    recommendations: z
      .object({
        general: useRecommendationSchema.nullable(),
        watch: watchRecommendationSchema.nullable(),
        fable: fableRecommendationSchema.nullable(),
      })
      .strict(),
  })
  .strict();

export const historyScansSchema = z
  .object({
    apiVersion: z.literal(1),
    generatedAt: isoInstantSchema,
    from: isoInstantSchema,
    to: isoInstantSchema,
    historyHealth: historyHealthSchema,
    runs: z.array(
      z
        .object({
          id: z.number().int().positive(),
          source: z.enum(["cli", "server"]),
          completedAt: isoInstantSchema,
          snapshots: z.array(quotaSnapshotSchema),
        })
        .strict(),
    ),
    nextCursor: z.number().int().positive().nullable(),
  })
  .strict();

export type HistoryAnalytics = z.infer<typeof historyAnalyticsSchema>;
export type AnalyticsLimit = z.infer<typeof analyticsLimitSchema>;
export type Projection = z.infer<typeof projectionSchema>;
