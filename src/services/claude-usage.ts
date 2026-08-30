import type { QuotaLimit } from "../domain/quota.js";

const monthIndexes: Readonly<Record<string, number>> = {
  Jan: 0,
  Feb: 1,
  Mar: 2,
  Apr: 3,
  May: 4,
  Jun: 5,
  Jul: 6,
  Aug: 7,
  Sep: 8,
  Oct: 9,
  Nov: 10,
  Dec: 11,
};

type DateParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

function partsAt(instantMilliseconds: number, timeZone: string): DateParts {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const values = new Map<string, number>(
    formatter
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

function localTimeToInstant(target: DateParts, timeZone: string): number {
  const targetAsUtc = Date.UTC(
    target.year,
    target.month - 1,
    target.day,
    target.hour,
    target.minute,
    target.second,
  );
  let candidate = targetAsUtc;

  for (let iteration = 0; iteration < 4; iteration += 1) {
    const rendered = partsAt(candidate, timeZone);
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

  const verified = partsAt(candidate, timeZone);
  if (
    verified.year !== target.year ||
    verified.month !== target.month ||
    verified.day !== target.day ||
    verified.hour !== target.hour ||
    verified.minute !== target.minute
  ) {
    throw new TypeError("Claude reset time could not be resolved.");
  }
  return candidate;
}

export function parseClaudeResetAt(
  value: string,
  nowMilliseconds: number,
): string {
  const match =
    /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2}),\s+(\d{1,2})(?::(\d{2}))?(am|pm)\s+\(([^)]+)\)$/u.exec(
      value.trim(),
    );
  if (match === null) {
    throw new TypeError("Claude reset time has an unsupported format.");
  }

  const monthName = match[1];
  const monthIndex =
    monthName === undefined ? undefined : monthIndexes[monthName];
  const day = Number(match[2]);
  const hour12 = Number(match[3]);
  const minute = Number(match[4] ?? "0");
  const meridiem = match[5];
  const timeZone = match[6];
  if (
    monthIndex === undefined ||
    !Number.isInteger(day) ||
    day < 1 ||
    day > 31 ||
    !Number.isInteger(hour12) ||
    hour12 < 1 ||
    hour12 > 12 ||
    !Number.isInteger(minute) ||
    minute < 0 ||
    minute > 59 ||
    (meridiem !== "am" && meridiem !== "pm") ||
    timeZone === undefined
  ) {
    throw new TypeError("Claude reset time is invalid.");
  }

  const currentYear = partsAt(nowMilliseconds, timeZone).year;
  const hour = meridiem === "am" ? hour12 % 12 : (hour12 % 12) + 12;
  const target = {
    year: currentYear,
    month: monthIndex + 1,
    day,
    hour,
    minute,
    second: 0,
  };
  let resetMilliseconds = localTimeToInstant(target, timeZone);

  const thirtyOneDays = 31 * 24 * 60 * 60 * 1_000;
  if (resetMilliseconds < nowMilliseconds - thirtyOneDays) {
    resetMilliseconds = localTimeToInstant(
      { ...target, year: currentYear + 1 },
      timeZone,
    );
  }
  return new Date(resetMilliseconds).toISOString();
}

type UsageWindowDefinition = {
  key: string;
  label: string;
  lineLabel: string;
  windowDurationMinutes: number;
};

const windowDefinitions: readonly UsageWindowDefinition[] = [
  {
    key: "base.session",
    label: "Current Session",
    lineLabel: "Current session",
    windowDurationMinutes: 300,
  },
  {
    key: "base.weekly",
    label: "Current Week (All Models)",
    lineLabel: "Current week (all models)",
    windowDurationMinutes: 10_080,
  },
  {
    key: "fable.weekly",
    label: "Current Week (Fable)",
    lineLabel: "Current week (Fable)",
    windowDurationMinutes: 10_080,
  },
];

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export function parseClaudeUsageOutput(
  output: string,
  nowMilliseconds: number,
): QuotaLimit[] {
  const limits: QuotaLimit[] = [];

  for (const definition of windowDefinitions) {
    const pattern = new RegExp(
      `^${escapeRegularExpression(definition.lineLabel)}:\\s+(\\d+(?:\\.\\d+)?)% used(?:\\s+·\\s+resets (.+))?$`,
      "imu",
    );
    const match = pattern.exec(output);
    if (match === null) {
      continue;
    }
    const usedPercent = Number(match[1]);
    const resetText = match[2];
    if (!Number.isFinite(usedPercent)) {
      throw new TypeError("Claude usage percentage is invalid.");
    }

    limits.push({
      key: definition.key,
      label: definition.label,
      scope: "window",
      availability: "available",
      usedPercent,
      windowDurationMinutes: definition.windowDurationMinutes,
      resetAt:
        resetText === undefined
          ? null
          : parseClaudeResetAt(resetText, nowMilliseconds),
    });
  }

  if (!limits.some((limit) => limit.key === "base.session")) {
    throw new TypeError("Claude usage output is missing the session window.");
  }
  if (!limits.some((limit) => limit.key === "fable.weekly")) {
    limits.push({
      key: "fable",
      label: "Fable",
      scope: "model",
      availability: "unsupported",
      usedPercent: null,
      windowDurationMinutes: null,
      resetAt: null,
    });
  }
  return limits;
}
