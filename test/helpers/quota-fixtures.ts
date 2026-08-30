import {
  quotaSuccessSchema,
  type QuotaSnapshot,
} from "../../src/domain/quota.js";
import { toPublicSnapshots } from "../../src/presentation/public-dto.js";
import { buildQuotaReport } from "../../src/presentation/quota-report.js";

export const nowMilliseconds = Date.parse("2026-08-30T01:57:00.000Z");

export function resetAfter(minutes: number): string {
  return new Date(nowMilliseconds + minutes * 60_000).toISOString();
}

export function claudeSnapshot(
  options: {
    alias?: string;
    weeklyUsed?: number;
    weeklyRemainingMinutes?: number;
    fableUsed?: number;
    sessionUsed?: number;
    sessionRemainingMinutes?: number | null;
  } = {},
): QuotaSnapshot {
  const sessionRemaining = options.sessionRemainingMinutes ?? 80;
  const weeklyRemaining = options.weeklyRemainingMinutes ?? 6_700;
  return quotaSuccessSchema.parse({
    accountAlias: options.alias ?? "claude-ops@example.com",
    platform: "Claude",
    status: "ok",
    plan: "max",
    limits: [
      {
        key: "base.session",
        label: "Current Session",
        scope: "window",
        availability: "available",
        usedPercent: options.sessionUsed ?? 9,
        windowDurationMinutes: null,
        resetAt:
          options.sessionRemainingMinutes === null
            ? null
            : resetAfter(sessionRemaining),
      },
      {
        key: "base.weekly",
        label: "Current Week (All Models)",
        scope: "window",
        availability: "available",
        usedPercent: options.weeklyUsed ?? 89,
        windowDurationMinutes: null,
        resetAt: resetAfter(weeklyRemaining),
      },
      {
        key: "fable.weekly",
        label: "Current Week (Fable)",
        scope: "window",
        availability: "available",
        usedPercent: options.fableUsed ?? 94,
        windowDurationMinutes: null,
        resetAt: resetAfter(weeklyRemaining),
      },
    ],
    observedAt: new Date(nowMilliseconds).toISOString(),
  });
}

export function codexSnapshot(
  alias = "codex-next@example.com",
  resetMinutes = 300,
): QuotaSnapshot {
  return quotaSuccessSchema.parse({
    accountAlias: alias,
    platform: "Codex",
    status: "ok",
    plan: "pro",
    limits: [
      {
        key: "codex.primary",
        label: "Codex Primary",
        scope: "window",
        availability: "available",
        usedPercent: 0,
        windowDurationMinutes: 10_080,
        resetAt: resetAfter(resetMinutes),
      },
    ],
    observedAt: new Date(nowMilliseconds).toISOString(),
  });
}

export function report(snapshots: readonly QuotaSnapshot[]) {
  return buildQuotaReport(toPublicSnapshots(snapshots, nowMilliseconds), {
    nowMilliseconds,
    timeZone: "America/Los_Angeles",
  });
}
