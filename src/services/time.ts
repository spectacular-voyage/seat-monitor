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

type ZonedDateParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

function zonedParts(
  instantMilliseconds: number,
  timeZone: string,
): ZonedDateParts {
  const values = new Map<string, number>(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date(instantMilliseconds))
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );
  const part = (name: string): number => {
    const value = values.get(name);
    if (value === undefined || !Number.isInteger(value)) {
      throw new TypeError(`Missing ${name} in timezone conversion.`);
    }
    return value;
  };
  return {
    year: part("year"),
    month: part("month"),
    day: part("day"),
    hour: part("hour"),
    minute: part("minute"),
    second: part("second"),
  };
}

function zonedTimeToInstant(parts: ZonedDateParts, timeZone: string): number {
  const targetAsUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  let candidate = targetAsUtc;
  for (let iteration = 0; iteration < 4; iteration += 1) {
    const rendered = zonedParts(candidate, timeZone);
    const renderedAsUtc = Date.UTC(
      rendered.year,
      rendered.month - 1,
      rendered.day,
      rendered.hour,
      rendered.minute,
      rendered.second,
    );
    candidate = targetAsUtc - (renderedAsUtc - candidate);
  }
  const verified = zonedParts(candidate, timeZone);
  if (
    verified.year !== parts.year ||
    verified.month !== parts.month ||
    verified.day !== parts.day ||
    verified.hour !== parts.hour ||
    verified.minute !== parts.minute ||
    verified.second !== parts.second
  ) {
    throw new TypeError("Local date-time could not be resolved.");
  }
  return candidate;
}

export function addCalendarDaysInTimeZone(
  instantMilliseconds: number,
  days: number,
  timeZone: string,
): number {
  if (!Number.isFinite(instantMilliseconds) || !Number.isInteger(days)) {
    throw new TypeError(
      "Calendar-day arithmetic requires a valid instant and whole days.",
    );
  }
  const source = zonedParts(instantMilliseconds, timeZone);
  const normalized = new Date(
    Date.UTC(
      source.year,
      source.month - 1,
      source.day + days,
      source.hour,
      source.minute,
      source.second,
    ),
  );
  return zonedTimeToInstant(
    {
      year: normalized.getUTCFullYear(),
      month: normalized.getUTCMonth() + 1,
      day: normalized.getUTCDate(),
      hour: normalized.getUTCHours(),
      minute: normalized.getUTCMinutes(),
      second: normalized.getUTCSeconds(),
    },
    timeZone,
  );
}
