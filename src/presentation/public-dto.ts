import {
  publicQuotaArraySchema,
  type PublicQuotaSnapshot,
  type QuotaSnapshot,
} from "../domain/quota.js";
import { minutesUntilReset } from "../services/time.js";

export function toPublicSnapshots(
  snapshots: readonly QuotaSnapshot[],
  nowMilliseconds: number,
): PublicQuotaSnapshot[] {
  const output = snapshots.map((snapshot): PublicQuotaSnapshot => {
    if (snapshot.status === "error") {
      return snapshot;
    }

    return {
      ...snapshot,
      limits: snapshot.limits.map((limit) => ({
        ...limit,
        minutesUntilReset: minutesUntilReset(limit.resetAt, nowMilliseconds),
      })),
    };
  });

  return publicQuotaArraySchema.parse(output);
}
