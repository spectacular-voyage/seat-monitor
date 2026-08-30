import { z } from "zod";

export const platformSchema = z.enum(["Claude", "Codex"]);

const isoInstantSchema = z.iso.datetime({ offset: true });

export const quotaLimitSchema = z
  .object({
    key: z.string().min(1),
    label: z.string().min(1),
    scope: z.enum(["global", "model", "window"]),
    availability: z.enum(["available", "unsupported"]),
    usedPercent: z.number().min(0).max(100).nullable(),
    windowDurationMinutes: z.number().positive().nullable(),
    resetAt: isoInstantSchema.nullable(),
  })
  .strict()
  .superRefine((limit, context) => {
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
  "forbidden",
  "rate_limited",
  "timeout",
  "network",
  "invalid_response",
  "unsupported",
]);

export const quotaErrorSchema = z
  .object({
    code: quotaErrorCodeSchema,
    message: z.string().min(1),
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

export const publicQuotaSuccessSchema = quotaSuccessSchema.extend({
  limits: z.array(publicQuotaLimitSchema).min(1),
});

export const publicQuotaSnapshotSchema = z.discriminatedUnion("status", [
  publicQuotaSuccessSchema,
  quotaFailureSchema,
]);

export const publicQuotaArraySchema = z.array(publicQuotaSnapshotSchema);

export type Platform = z.infer<typeof platformSchema>;
export type QuotaErrorCode = z.infer<typeof quotaErrorCodeSchema>;
export type QuotaLimit = z.infer<typeof quotaLimitSchema>;
export type QuotaSnapshot = z.infer<typeof quotaSnapshotSchema>;
export type PublicQuotaSnapshot = z.infer<typeof publicQuotaSnapshotSchema>;
