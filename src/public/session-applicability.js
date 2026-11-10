// Shared by capacity, detail and the history-offline fallback. Returning null
// leaves every applicable or unknown session on the existing rendering path.
export function createNotApplicableSession(limit, element, compact = false) {
  if (limit.applicability !== "not_applicable") return null;
  if (compact) {
    const row = element("div", "capacity-limit");
    row.append(
      element("span", "capacity-limit-name", limit.label),
      element("strong", "capacity-percent", "N/A"),
    );
    return row;
  }
  const section = element("section", "limit");
  section.append(
    element("h4", "limit-name", limit.label),
    element(
      "p",
      "limit-reset",
      "N/A: verified Ultra has no five-hour session limit. Weekly limits still apply.",
    ),
  );
  return section;
}

export function fallbackLimit(limit, weeklyLimit) {
  const isFable = limit.key.startsWith("fable");
  const sessionNotApplicable = limit.applicability === "not_applicable";
  const effectiveResetAt = isFable
    ? (weeklyLimit?.resetAt ?? null)
    : limit.resetAt;
  return {
    key: limit.key,
    ...(sessionNotApplicable ? { applicability: "not_applicable" } : {}),
    label: sessionNotApplicable ? "Session (N/A)" : limit.label,
    depth: isFable ? 1 : 0,
    parentKey: isFable ? "base.weekly" : null,
    availability: limit.availability,
    currentUsedPercent: limit.usedPercent,
    headroomPercent:
      limit.usedPercent === null ? null : 100 - limit.usedPercent,
    windowDurationMinutes: limit.windowDurationMinutes,
    resetAt: effectiveResetAt,
    resetSource: effectiveResetAt === null ? null : "provider",
    minutesUntilReset: isFable
      ? (weeklyLimit?.minutesUntilReset ?? null)
      : limit.minutesUntilReset,
    points: [],
    resetMarkers: [],
    projection: {
      status: sessionNotApplicable ? "not_applicable" : "insufficient_history",
      ratePercentPerHour: null,
      rateBasis: null,
      projectedFromUsedPercent: null,
      projectedExhaustionAt: null,
      projectedExhaustionRangeEndAt: null,
      sampleCount: 0,
      spanMinutes: 0,
    },
  };
}
