import type { QuotaReport, QuotaReportRow } from "./quota-report.js";
import {
  formatBar,
  formatLocalConstantFootnote,
  formatPercent,
  formatReportTimestamp,
  formatReset,
  formatRowPosition,
  formatUseLine,
  formatWatchLine,
} from "./quota-format.js";

function pad(
  value: string,
  width: number,
  alignment: "left" | "right",
): string {
  return alignment === "left" ? value.padEnd(width) : value.padStart(width);
}

function rowLabel(row: QuotaReportRow): string {
  return row.depth === 1 ? `  └ ${row.label}` : row.label;
}

function rowStatus(row: QuotaReportRow): string {
  if (row.support === "unsupported") {
    return "unsupported";
  }
  if (row.constantSuspect) {
    return "CONSTANT-SUSPECT";
  }
  return "";
}

export function renderTextReport(report: QuotaReport): string {
  const lines = [
    `QUOTA — ${formatReportTimestamp(report)}`,
    formatUseLine(report.use, report),
    formatWatchLine(report.watch, report),
    "",
  ];

  const labelWidth = Math.max(
    18,
    ...report.accounts.flatMap((account) =>
      account.rows.map((row) => rowLabel(row).length),
    ),
  );
  const positionWidth = Math.max(
    18,
    ...report.accounts.flatMap((account) =>
      account.rows.map((row) => formatRowPosition(row).length),
    ),
  );

  for (const account of report.accounts) {
    const plan = account.plan === null ? "" : ` · ${account.plan}`;
    lines.push(
      `${pad(account.platform.toLocaleUpperCase("en-US"), 8, "left")}${account.displayAccount}${plan}`,
    );
    if (account.status === "error") {
      lines.push(
        `  ERROR ${account.error?.code ?? "unknown"} — ${account.error?.message ?? ""}`,
        "",
      );
      continue;
    }

    for (const row of account.rows) {
      const consumed =
        row.consumedPercent === null ? "" : formatPercent(row.consumedPercent);
      const reset = formatReset(
        row.resetAt,
        row.timeRemainingMinutes,
        report,
        row.resetDisplay,
      );
      lines.push(
        `  ${pad(rowLabel(row), labelWidth, "left")}  ${pad(consumed, 6, "right")}  ${pad(formatBar(row.consumedPercent), 10, "left")}  ${pad(formatRowPosition(row), positionWidth, "left")}  ${reset}${rowStatus(row).length > 0 ? `  ${rowStatus(row)}` : ""}`.trimEnd(),
      );
    }
    lines.push("");
  }

  if (report.usesLocalConstants) {
    lines.push(formatLocalConstantFootnote(report), "");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}
