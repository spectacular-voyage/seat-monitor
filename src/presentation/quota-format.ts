import type {
  QuotaReport,
  QuotaReportRow,
  ResetDisplay,
  UseRecommendation,
  WatchRecommendation,
} from "./quota-report.js";
import { MINIMUM_USABLE_HEADROOM_PERCENT } from "./quota-constants.js";

type ZonedParts = {
  year: string;
  month: string;
  monthShort: string;
  day: string;
  weekday: string;
  hour: string;
  minute: string;
  timeZoneName: string;
};

function zonedParts(milliseconds: number, timeZone: string): ZonedParts {
  const numeric = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    weekday: "short",
    timeZoneName: "short",
  }).formatToParts(new Date(milliseconds));
  const shortMonth = new Intl.DateTimeFormat("en-US", {
    timeZone,
    month: "short",
  }).format(new Date(milliseconds));
  const values = new Map<string, string>(
    numeric
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  const value = (key: string): string => values.get(key) ?? "";
  return {
    year: value("year"),
    month: value("month"),
    monthShort: shortMonth,
    day: value("day"),
    weekday: value("weekday"),
    hour: value("hour"),
    minute: value("minute"),
    timeZoneName: value("timeZoneName"),
  };
}

export function formatReportTimestamp(report: QuotaReport): string {
  const parts = zonedParts(report.nowMilliseconds, report.timeZone);
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} ${parts.timeZoneName}`;
}

export function formatPercent(value: number): string {
  return `${new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 1,
  }).format(value)}%`;
}

export function formatDuration(minutes: number): string {
  const sign = minutes < 0 ? "-" : "";
  const absolute = Math.abs(minutes);
  if (absolute < 60) {
    return `${sign}${String(absolute)}m`;
  }
  const hours = Math.floor(absolute / 60);
  const remainder = absolute % 60;
  return remainder === 0
    ? `${sign}${String(hours)}h`
    : `${sign}${String(hours)}h ${String(remainder)}m`;
}

function localDateOrdinal(parts: ZonedParts): number {
  return Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
  );
}

function displayMonth(parts: ZonedParts): string {
  return parts.month === "09" ? "Sept" : parts.monthShort;
}

export function formatResetMoment(
  resetAt: string,
  report: QuotaReport,
  display: ResetDisplay,
): string {
  const resetMilliseconds = Date.parse(resetAt);
  const nowParts = zonedParts(report.nowMilliseconds, report.timeZone);
  const resetParts = zonedParts(resetMilliseconds, report.timeZone);
  const dayDifference = Math.round(
    (localDateOrdinal(resetParts) - localDateOrdinal(nowParts)) /
      (24 * 60 * 60 * 1_000),
  );
  const clock = `${resetParts.hour}:${resetParts.minute}`;
  if (display === "clock-only") {
    return `at ${clock}`;
  }
  if (display === "weekday-date") {
    const year =
      resetParts.year === nowParts.year ? "" : `, ${resetParts.year}`;
    return `${resetParts.weekday}, ${displayMonth(resetParts)} ${String(Number(resetParts.day))}${year} at ${clock}`;
  }
  if (dayDifference === 0) {
    return `at ${clock}`;
  }
  if (dayDifference > 0 && dayDifference <= 6) {
    return `${resetParts.weekday} at ${clock}`;
  }
  const year = resetParts.year === nowParts.year ? "" : `, ${resetParts.year}`;
  return `${displayMonth(resetParts)} ${String(Number(resetParts.day))}${year} at ${clock}`;
}

export function formatReset(
  resetAt: string | null,
  timeRemainingMinutes: number | null,
  report: QuotaReport,
  display: ResetDisplay,
): string {
  if (resetAt === null || timeRemainingMinutes === null) {
    return "";
  }
  return `resets ${formatResetMoment(resetAt, report, display)} (${formatDuration(timeRemainingMinutes)})`;
}

export function formatBar(consumedPercent: number | null): string {
  if (consumedPercent === null) {
    return "";
  }
  const filled =
    consumedPercent < 5 ? 0 : Math.min(10, Math.ceil(consumedPercent / 10));
  return `${"▓".repeat(filled)}${"░".repeat(10 - filled)}`;
}

export function formatRowPosition(row: QuotaReportRow): string {
  if (row.depth === 1) {
    return "";
  }
  if (row.constantSuspect) {
    return row.timeRemainingMinutes === null
      ? ""
      : `remaining ${formatDuration(row.timeRemainingMinutes)}`;
  }
  return row.elapsedPercent === null
    ? ""
    : `${formatPercent(row.elapsedPercent)} elapsed${row.windowDurationSource === "constant" ? "*" : ""}`;
}

export function formatUseLine(
  recommendation: UseRecommendation | null,
  report: QuotaReport,
): string {
  if (recommendation === null) {
    return `USE:   no account has ≥${formatPercent(MINIMUM_USABLE_HEADROOM_PERCENT)} usable headroom with a known reset`;
  }
  return `USE:   ${recommendation.accountAlias} — ${recommendation.limitLabel} ${formatPercent(recommendation.headroomPercent)} free, ${formatReset(recommendation.resetAt, recommendation.timeRemainingMinutes, report, recommendation.resetDisplay)}`;
}

export function formatWatchLine(
  recommendation: WatchRecommendation | null,
  report: QuotaReport,
): string {
  if (recommendation === null) {
    return "WATCH: no measured fleet limit is available";
  }

  const row = recommendation.row;
  const consumed =
    row.consumedPercent === null ? "" : formatPercent(row.consumedPercent);
  const clauses: string[] = [];
  if (row.depth === 1 && row.subCapFraction !== null) {
    clauses.push(
      `${row.label.replace(" sub-cap", "")} ${consumed} of its ${formatPercent(row.subCapFraction * 100)} sub-cap*`,
    );
  } else {
    clauses.push(`${row.label} ${consumed} consumed`);
  }
  if (recommendation.elapsedPercent !== null) {
    clauses.push(
      `${formatPercent(recommendation.elapsedPercent)} elapsed${recommendation.elapsedUsesConstant ? "*" : ""}`,
    );
  }
  if (recommendation.constantSuspect) {
    clauses.push("CONSTANT-SUSPECT");
  }
  const reset = formatReset(
    recommendation.resetAt,
    recommendation.timeRemainingMinutes,
    report,
    row.resetDisplay,
  );
  if (reset.length > 0) {
    clauses.push(reset);
  }
  return `WATCH: ${recommendation.accountAlias} — ${clauses.join(", ")}`;
}

export function formatLocalConstantFootnote(report: QuotaReport): string {
  let claudeSession = false;
  let claudeWeekly = false;
  let codexWeekly = false;
  let fableFraction = false;
  for (const account of report.accounts) {
    for (const row of account.rows) {
      if (row.windowDurationSource === "constant") {
        if (account.platform === "Claude" && row.key === "base.session") {
          claudeSession = true;
        } else if (account.platform === "Claude" && row.key === "base.weekly") {
          claudeWeekly = true;
        } else if (account.platform === "Codex") {
          codexWeekly = true;
        }
      }
      if (row.subCapConstant !== null && row.subCapFraction !== null) {
        fableFraction = true;
      }
    }
  }
  const labels = [
    claudeSession ? "Claude session 5h" : null,
    claudeWeekly ? "Claude weekly 7d" : null,
    codexWeekly ? "Codex weekly fallback 7d" : null,
    fableFraction ? "Fable sub-cap 50% of Max weekly allowance" : null,
  ].filter((label): label is string => label !== null);
  return `* local constants, checked 2026-08-29: ${labels.join("; ")}. Not returned by the provider.`;
}
