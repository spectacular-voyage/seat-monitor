export const LONGEST_QUOTA_PERIOD_MINUTES = 10_080;

function compareAccountIdentity(left, right) {
  return (
    left.platform.localeCompare(right.platform) ||
    left.accountAlias.localeCompare(right.accountAlias)
  );
}

export function sessionUtilizationPercent(account) {
  // Keep this definition in step with the account-wide Session series used by
  // history analytics. Codex Primary orders the trailing Codex group.
  const key = account.platform === "Claude" ? "base.session" : "codex.primary";
  const usedPercent = account.limits.find(
    (limit) => limit.key === key,
  )?.currentUsedPercent;
  return Number.isFinite(usedPercent) ? usedPercent : Number.NEGATIVE_INFINITY;
}

export function compareAccountsBySessionUtilization(left, right) {
  const leftIsCodex = left.platform === "Codex";
  const rightIsCodex = right.platform === "Codex";
  if (leftIsCodex !== rightIsCodex) {
    return leftIsCodex ? 1 : -1;
  }
  const leftUsed = sessionUtilizationPercent(left);
  const rightUsed = sessionUtilizationPercent(right);
  if (leftUsed !== rightUsed) {
    return rightUsed - leftUsed;
  }
  return compareAccountIdentity(left, right);
}

export function weeklyResetTimestamp(account) {
  const weeklyLimit = account.limits.find(
    (limit) =>
      limit.depth === 0 &&
      limit.windowDurationMinutes === LONGEST_QUOTA_PERIOD_MINUTES,
  );
  if (weeklyLimit?.resetAt === null || weeklyLimit?.resetAt === undefined) {
    return Number.POSITIVE_INFINITY;
  }
  const timestamp = Date.parse(weeklyLimit.resetAt);
  return Number.isFinite(timestamp) ? timestamp : Number.POSITIVE_INFINITY;
}

export function compareFleetAccountsByWeeklyReset(left, right) {
  const leftReset = weeklyResetTimestamp(left);
  const rightReset = weeklyResetTimestamp(right);
  if (leftReset !== rightReset) {
    return leftReset - rightReset;
  }
  return compareAccountIdentity(left, right);
}
