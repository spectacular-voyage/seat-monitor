export const LONGEST_QUOTA_PERIOD_MINUTES = 10_080;

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
  return (
    left.platform.localeCompare(right.platform) ||
    left.accountAlias.localeCompare(right.accountAlias)
  );
}
