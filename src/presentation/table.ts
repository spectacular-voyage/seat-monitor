import type { QuotaReport, QuotaReportRow } from "./quota-report.js";
import {
  formatBar,
  formatLocalConstantFootnote,
  formatPercent,
  formatReportTimestamp,
  formatReset,
  formatRowPosition,
  formatSourceLine,
  formatStaleNote,
  formatUseLine,
  formatWatchLine,
} from "./quota-format.js";

function escapeCell(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("|", "\\|")
    .replaceAll(/[\r\n]+/gu, " ");
}

function markdownRow(cells: readonly string[]): string {
  return `| ${cells.map(escapeCell).join(" | ")} |`;
}

function rowStatus(row: QuotaReportRow): string {
  if (row.applicability === "not_applicable") return "not applicable";
  if (row.support === "unsupported") {
    return "unsupported";
  }
  if (row.key === "base.session" && row.consumedPercent === null) {
    return "unknown";
  }
  return row.constantSuspect ? "**CONSTANT-SUSPECT**" : "";
}

export function renderMarkdownReport(report: QuotaReport): string {
  const source = formatSourceLine(report);
  const lines = [
    `# QUOTA — ${formatReportTimestamp(report)}`,
    "",
    ...(source === null ? [] : [source, ""]),
    formatUseLine(report.use, report),
    "",
    formatWatchLine(report.watch, report),
    "",
  ];

  for (const account of report.accounts) {
    const plan = account.plan === null ? "" : ` · ${account.plan}`;
    lines.push(
      `## ${account.platform.toLocaleUpperCase("en-US")} ${account.displayAccount}${plan}`,
      "",
    );
    if (account.status === "error") {
      lines.push(
        `Error (${account.error?.code ?? "unknown"}): ${account.error?.message ?? ""}`,
        "",
      );
      continue;
    }
    const staleNote = formatStaleNote(account, report);
    if (staleNote !== null) {
      lines.push(`**${staleNote}**`, "");
    }

    lines.push(
      markdownRow([
        "Limit",
        "Consumed",
        "Level",
        "Position",
        "Reset",
        "Status",
      ]),
      "| --- | ---: | --- | --- | --- | --- |",
    );
    for (const row of account.rows) {
      lines.push(
        markdownRow([
          row.depth === 1 ? `↳ ${row.label}` : row.label,
          row.consumedPercent === null
            ? ""
            : formatPercent(row.consumedPercent),
          formatBar(row.consumedPercent),
          formatRowPosition(row),
          formatReset(
            row.resetAt,
            row.timeRemainingMinutes,
            report,
            row.resetDisplay,
          ),
          rowStatus(row),
        ]),
      );
    }
    lines.push("");
  }

  if (report.usesLocalConstants) {
    lines.push(formatLocalConstantFootnote(report), "");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}
