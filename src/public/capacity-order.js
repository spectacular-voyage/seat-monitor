export const LONGEST_QUOTA_PERIOD_MINUTES = 10_080;
// A reading older than this (now - observedAt) is shown as STALE: the ruled maximum acceptable reading age.
export const READING_STALE_AFTER_SECONDS = 300;

export function readingIsStale(observedAt, nowMilliseconds) {
  const observed = Date.parse(observedAt);
  return (
    Number.isFinite(observed) &&
    Number.isFinite(nowMilliseconds) &&
    nowMilliseconds - observed > READING_STALE_AFTER_SECONDS * 1_000
  );
}

function compareAccountIdentity(left, right) {
  return (
    left.platform.localeCompare(right.platform) ||
    left.accountAlias.localeCompare(right.accountAlias)
  );
}

function limitUsedPercent(account, key) {
  const usedPercent = account.limits.find(
    (limit) => limit.key === key,
  )?.currentUsedPercent;
  return Number.isFinite(usedPercent) ? usedPercent : Number.NEGATIVE_INFINITY;
}

export function sessionUtilizationPercent(account) {
  // Keep this definition in step with the account-wide Session series used by
  // history analytics. Codex Primary orders the trailing Codex group.
  return limitUsedPercent(
    account,
    account.platform === "Claude" ? "base.session" : "codex.primary",
  );
}

export function weeklyUtilizationPercent(account) {
  // Keep this definition in step with the canonical weekly limit used by fleet
  // throughput: Codex reports its account-wide week as Codex Primary.
  return limitUsedPercent(
    account,
    account.platform === "Claude" ? "base.weekly" : "codex.primary",
  );
}

function compareAccountsByUtilization(left, right, utilizationPercent) {
  const leftIsCodex = left.platform === "Codex";
  const rightIsCodex = right.platform === "Codex";
  if (leftIsCodex !== rightIsCodex) {
    return leftIsCodex ? 1 : -1;
  }
  const leftUsed = utilizationPercent(left);
  const rightUsed = utilizationPercent(right);
  if (leftUsed !== rightUsed) {
    return rightUsed - leftUsed;
  }
  return compareAccountIdentity(left, right);
}

export function compareAccountsBySessionUtilization(left, right) {
  return compareAccountsByUtilization(left, right, sessionUtilizationPercent);
}

export function compareAccountsByWeeklyUtilization(left, right) {
  return compareAccountsByUtilization(left, right, weeklyUtilizationPercent);
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

export function toneForLimit(limit) {
  // A missing CURRENT reading (for example quota_unavailable) is neither healthy nor a zero: it is neutral and unknown (SEAT-MON-72, #74).
  if (limit.currentUsedPercent === null) {
    return "unknown";
  }
  if (
    limit.projection.status === "already_exhausted" ||
    limit.projection.status === "exhausts_before_reset" ||
    (limit.currentUsedPercent !== null && limit.currentUsedPercent >= 90)
  ) {
    return "danger";
  }
  if (limit.currentUsedPercent !== null && limit.currentUsedPercent >= 75) {
    return "warning";
  }
  return "healthy";
}
