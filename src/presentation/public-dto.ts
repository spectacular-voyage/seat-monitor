import { readingFreshness } from "../domain/freshness.js";
import {
  publicQuotaArraySchema,
  type PublicQuotaSnapshot,
  type QuotaSnapshot,
} from "../domain/quota.js";
import { minutesUntilReset } from "../services/time.js";

function hasLapsed(resetAt: string | null, nowMilliseconds: number): boolean {
  return resetAt !== null && Date.parse(resetAt) <= nowMilliseconds;
}

/**
 * A limit whose window has reset since the reading no longer describes current
 * usage, so its percentage and past reset become unknown instead of being
 * reported as a number. A Fable sub-cap without its own reset follows the
 * weekly window it is nested in.
 */
export function withoutLapsedLimits(
  snapshot: QuotaSnapshot,
  nowMilliseconds: number,
): QuotaSnapshot {
  if (snapshot.status === "error") {
    return snapshot;
  }
  const weeklyLapsed =
    snapshot.platform === "Claude" &&
    snapshot.limits.some(
      (limit) =>
        limit.key === "base.weekly" &&
        hasLapsed(limit.resetAt, nowMilliseconds),
    );
  return {
    ...snapshot,
    limits: snapshot.limits.map((limit) =>
      limit.availability === "available" &&
      (hasLapsed(limit.resetAt, nowMilliseconds) ||
        (weeklyLapsed &&
          limit.key.startsWith("fable") &&
          limit.resetAt === null))
        ? { ...limit, usedPercent: null, resetAt: null }
        : limit,
    ),
  };
}

export function toPublicSnapshots(
  snapshots: readonly QuotaSnapshot[],
  nowMilliseconds: number,
): PublicQuotaSnapshot[] {
  const output = snapshots.map((snapshot): PublicQuotaSnapshot => {
    if (snapshot.status === "error") {
      return snapshot;
    }

    const { source, ...current } = withoutLapsedLimits(
      snapshot,
      nowMilliseconds,
    ) as typeof snapshot;
    return {
      ...current,
      limits: current.limits.map((limit) => ({
        ...limit,
        minutesUntilReset: minutesUntilReset(limit.resetAt, nowMilliseconds),
      })),
      ...readingFreshness(
        snapshot.observedAt,
        source === "cache",
        nowMilliseconds,
      ),
    };
  });

  return publicQuotaArraySchema.parse(output);
}
