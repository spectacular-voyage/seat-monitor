export function minutesUntilReset(
  resetAt: string | null,
  nowMilliseconds: number,
): number | null {
  if (resetAt === null) {
    return null;
  }

  const resetMilliseconds = Date.parse(resetAt);
  if (!Number.isFinite(resetMilliseconds)) {
    throw new TypeError("resetAt must be a valid ISO-8601 instant.");
  }

  return Math.max(0, Math.ceil((resetMilliseconds - nowMilliseconds) / 60_000));
}

export function unixSecondsToIso(unixSeconds: number): string {
  const milliseconds = unixSeconds * 1_000;
  if (!Number.isSafeInteger(milliseconds)) {
    throw new TypeError("Reset timestamp is outside the supported range.");
  }

  const date = new Date(milliseconds);
  if (!Number.isFinite(date.getTime())) {
    throw new TypeError("Reset timestamp is invalid.");
  }

  return date.toISOString();
}
