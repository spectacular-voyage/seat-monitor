import type { QuotaLimit } from "../domain/quota.js";

/** Absence verifies session applicability only for an independently known Ultra plan
 * and a complete native quota section. Legacy `max` or a partial report is not evidence. */
export function verifiedUltraSession(
  output: string,
  limits: readonly QuotaLimit[],
  ultraPlan: boolean,
): boolean {
  if (
    !ultraPlan ||
    /^\s*Current session\b/imu.test(output) ||
    /^\s*(?:error|failed|unauthorized|timeout)\b/imu.test(output)
  )
    return false;
  const header = output.indexOf(
    "You are currently using your subscription to power your Claude Code usage",
  );
  const weekly = output.indexOf("Current week (all models):");
  const fable = output.indexOf("Current week (Fable):");
  const end = output.indexOf("What's contributing to your limits usage?");
  if (
    header < 0 ||
    weekly <= header ||
    fable <= weekly ||
    end <= fable ||
    [...output.matchAll(/^\s*Current\b/gimu)].length !== 2
  )
    return false;
  return ["base.weekly", "fable.weekly"].every((key) =>
    limits.some(
      (limit) =>
        limit.key === key &&
        limit.usedPercent !== null &&
        limit.usedPercent >= 0 &&
        limit.usedPercent <= 100 &&
        limit.resetAt !== null,
    ),
  );
}
