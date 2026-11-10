import { z } from "zod";

export const platformSchema = z.enum(["Claude", "Codex"]);

const isoInstantSchema = z.iso.datetime({ offset: true });

export const quotaLimitSchema = z
  .object({
    key: z.string().min(1),
    label: z.string().min(1),
    scope: z.enum(["global", "model", "window"]),
    availability: z.enum(["available", "unsupported"]),
    applicability: z.literal("not_applicable").optional(),
    usedPercent: z.number().min(0).max(100).nullable(),
    windowDurationMinutes: z.number().positive().nullable(),
    resetAt: isoInstantSchema.nullable(),
  })
  .strict()
  .superRefine((limit, context) => {
    if (
      limit.applicability === "not_applicable" &&
      (limit.key !== "base.session" ||
        limit.usedPercent !== null ||
        limit.windowDurationMinutes !== null ||
        limit.resetAt !== null)
    ) {
      context.addIssue({
        code: "custom",
        message: "N/A sessions cannot contain quota values.",
      });
    }
    if (
      limit.availability === "unsupported" &&
      (limit.usedPercent !== null ||
        limit.windowDurationMinutes !== null ||
        limit.resetAt !== null)
    ) {
      context.addIssue({
        code: "custom",
        message: "Unsupported limits cannot contain quota values.",
      });
    }
  });

export const quotaErrorCodeSchema = z.enum([
  "missing_credential",
  "unauthorized",
  "identity_mismatch",
  "forbidden",
  "rate_limited",
  "timeout",
  "network",
  "invalid_response",
  // The provider answered, but its output carries no session or week quota windows: quota is UNKNOWN, never 0% and never ok.
  "quota_unavailable",
  "unsupported",
]);

export const quotaErrorSchema = z
  .object({
    code: quotaErrorCodeSchema,
    message: z.string().min(1),
  })
  .strict();

export const resetOfferSchema = z
  .object({
    label: z.string().min(1),
    count: z.number().int().positive(),
    expiresAt: isoInstantSchema.nullable(),
  })
  .strict();

const snapshotBaseShape = {
  accountAlias: z.string().min(1),
  platform: platformSchema,
  observedAt: isoInstantSchema,
} as const;

export const quotaSuccessSchema = z
  .object({
    ...snapshotBaseShape,
    status: z.literal("ok"),
    plan: z.string().min(1).nullable(),
    limits: z.array(quotaLimitSchema).min(1),
    resetOffers: z.array(resetOfferSchema).nullable().optional(),
    // Present only when the provider refused a live read (for example HTTP 429)
    // and the reading is a retained cached fallback; observedAt is its cache time.
    source: z.literal("cache").optional(),
  })
  .strict();

export const quotaFailureSchema = z
  .object({
    ...snapshotBaseShape,
    status: z.literal("error"),
    plan: z.null(),
    limits: z.tuple([]),
    error: quotaErrorSchema,
  })
  .strict();

export const quotaSnapshotSchema = z.discriminatedUnion("status", [
  quotaSuccessSchema,
  quotaFailureSchema,
]);

export const publicQuotaLimitSchema = quotaLimitSchema.extend({
  minutesUntilReset: z.number().int().nonnegative().nullable(),
});

export const publicQuotaSuccessSchema = quotaSuccessSchema
  .omit({ source: true })
  .extend({
    limits: z.array(publicQuotaLimitSchema).min(1),
    // Whole seconds from observedAt to when this response was generated.
    ageSeconds: z.number().int().nonnegative(),
    // A cached fallback, or a reading older than the stale threshold: not a
    // current measurement. Usage only rises within a window, so a stale
    // percentage is a lower bound until that window resets.
    stale: z.boolean(),
    // When the reading is a cached fallback, the time it was cached; else null.
    cachedAt: isoInstantSchema.nullable(),
  });

export const publicQuotaSnapshotSchema = z.discriminatedUnion("status", [
  publicQuotaSuccessSchema,
  quotaFailureSchema,
]);

export const publicQuotaArraySchema = z.array(publicQuotaSnapshotSchema);

export type Platform = z.infer<typeof platformSchema>;
export type QuotaErrorCode = z.infer<typeof quotaErrorCodeSchema>;
export type QuotaLimit = z.infer<typeof quotaLimitSchema>;
export type ResetOffer = z.infer<typeof resetOfferSchema>;
export type QuotaSnapshot = z.infer<typeof quotaSnapshotSchema>;
export type PublicQuotaSnapshot = z.infer<typeof publicQuotaSnapshotSchema>;
