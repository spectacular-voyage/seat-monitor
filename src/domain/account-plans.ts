import { z } from "zod";

import { platformSchema, quotaErrorCodeSchema } from "./quota.js";

const isoInstantSchema = z.iso.datetime({ offset: true });

/** Where a fact came from. `provider` is reported by Anthropic or OpenAI,
 * `declared` comes from accounts.json, and `estimated` is computed from a
 * provider anchor such as the subscription start date. */
export const billingSourceSchema = z.enum([
  "provider",
  "declared",
  "estimated",
]);

export const accountPlanSchema = z
  .object({
    accountAlias: z.string().min(1),
    platform: platformSchema,
    scan: z
      .object({
        status: z.enum(["ok", "error", "pending"]),
        errorCode: quotaErrorCodeSchema.nullable(),
        observedAt: isoInstantSchema.nullable(),
      })
      .strict(),
    // Provider plan identifier, such as `max`, `ultra` or `pro`.
    plan: z.string().min(1).nullable(),
    // Display tier, such as `Ultra`, `Max 5x` or `Pro`.
    tier: z.string().min(1).nullable(),
    tierSource: z.enum(["provider", "declared"]).nullable(),
    subscriptionStatus: z.string().min(1).nullable(),
    billingPeriod: z.string().min(1).nullable(),
    subscribedAt: isoInstantSchema.nullable(),
    renewal: z
      .object({
        // Next billing date in the server's time zone (YYYY-MM-DD). When
        // autoRenew is false, the date the subscription ends instead.
        date: z.iso.date().nullable(),
        // The exact provider instant behind `date`, when one is reported.
        at: isoInstantSchema.nullable(),
        dateSource: billingSourceSchema.nullable(),
        autoRenew: z.boolean().nullable(),
        autoRenewSource: z.enum(["provider", "declared"]).nullable(),
      })
      .strict(),
    billingCheck: z
      .object({
        status: z.enum(["ok", "pending", "unavailable", "unsupported"]),
        // Time of the last successful provider check, retained across failures.
        checkedAt: isoInstantSchema.nullable(),
        httpStatus: z.number().int().min(100).max(599).nullable(),
      })
      .strict(),
  })
  .strict();

export const accountPlansResponseSchema = z
  .object({
    apiVersion: z.literal(1),
    generatedAt: isoInstantSchema,
    timeZone: z.string().min(1),
    accounts: z.array(accountPlanSchema),
  })
  .strict();

export type BillingSource = z.infer<typeof billingSourceSchema>;
export type AccountPlan = z.infer<typeof accountPlanSchema>;
export type AccountPlansResponse = z.infer<typeof accountPlansResponseSchema>;
