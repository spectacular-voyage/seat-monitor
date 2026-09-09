import { z } from "zod";

import { historyHealthSchema, projectionSchema } from "./history.js";
import { platformSchema, quotaErrorSchema } from "./quota.js";

const isoInstantSchema = z.iso.datetime({ offset: true });

const cliForecastLimitSchema = z
  .object({
    key: z.string().min(1),
    label: z.string().min(1),
    currentConsumedPercent: z.number().min(0).max(100).nullable(),
    ratePercentPerHour: z.number().nonnegative().nullable(),
    rateBasis: projectionSchema.shape.rateBasis,
    projectionStatus: projectionSchema.shape.status,
    projectedExhaustionAt: isoInstantSchema.nullable(),
    projectedExhaustionRangeEndAt: isoInstantSchema.nullable(),
    minutesToExhaustion: z.number().int().nonnegative().nullable(),
    resetAt: isoInstantSchema.nullable(),
    resetSource: z.enum(["provider", "expected"]).nullable(),
    sampleCount: z.number().int().nonnegative(),
    observationSpanMinutes: z.number().nonnegative(),
  })
  .strict();

const cliForecastAccountSchema = z
  .object({
    accountAlias: z.string().min(1),
    platform: platformSchema,
    plan: z.string().min(1).nullable(),
    observedAt: isoInstantSchema,
    status: z.enum(["ok", "error"]),
    error: quotaErrorSchema.nullable(),
    limits: z.array(cliForecastLimitSchema),
  })
  .strict();

const cliRiskEntrySchema = z
  .object({
    rank: z.number().int().positive(),
    accountAlias: z.string().min(1),
    platform: platformSchema,
    limitKey: z.string().min(1),
    label: z.string().min(1),
    projectionStatus: projectionSchema.shape.status,
    projectedExhaustionAt: isoInstantSchema.nullable(),
    projectedExhaustionRangeEndAt: isoInstantSchema.nullable(),
    minutesToExhaustion: z.number().int().nonnegative().nullable(),
    resetAt: isoInstantSchema.nullable(),
    resetSource: z.enum(["provider", "expected"]).nullable(),
  })
  .strict();

export const cliForecastSchema = z
  .object({
    apiVersion: z.literal(1),
    generatedAt: isoInstantSchema,
    historyHealth: historyHealthSchema,
    riskRanking: z.array(cliRiskEntrySchema),
    accounts: z.array(cliForecastAccountSchema),
  })
  .strict();

export type CliForecast = z.infer<typeof cliForecastSchema>;
export type CliForecastLimit = z.infer<typeof cliForecastLimitSchema>;
