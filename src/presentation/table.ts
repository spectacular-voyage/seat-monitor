import type { PublicQuotaSnapshot } from "../domain/quota.js";

const percentageFormatter = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 2,
});

function escapeCell(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("|", "\\|")
    .replaceAll(/[\r\n]+/gu, " ");
}

function formatMinutes(minutes: number | null): string {
  if (minutes === null) {
    return "N/A";
  }
  if (minutes === 0) {
    return "Now";
  }
  if (minutes < 60) {
    return `${String(minutes)}m`;
  }

  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder === 0
    ? `${String(hours)}h`
    : `${String(hours)}h ${String(remainder)}m`;
}

function row(cells: readonly string[]): string {
  return `| ${cells.map(escapeCell).join(" | ")} |`;
}

export function renderMarkdownTable(
  snapshots: readonly PublicQuotaSnapshot[],
): string {
  const lines = [
    row([
      "Account",
      "Platform",
      "Plan",
      "Limit",
      "Used",
      "Resets In",
      "Status",
    ]),
    "| --- | --- | --- | --- | ---: | ---: | --- |",
  ];

  for (const snapshot of snapshots) {
    if (snapshot.status === "error") {
      lines.push(
        row([
          snapshot.accountAlias,
          snapshot.platform,
          "N/A",
          "N/A",
          "N/A",
          "N/A",
          `Error (${snapshot.error.code}): ${snapshot.error.message}`,
        ]),
      );
      continue;
    }

    for (const limit of snapshot.limits) {
      lines.push(
        row([
          snapshot.accountAlias,
          snapshot.platform,
          snapshot.plan ?? "N/A",
          limit.label,
          limit.usedPercent === null
            ? "N/A"
            : `${percentageFormatter.format(limit.usedPercent)}%`,
          formatMinutes(limit.minutesUntilReset),
          limit.availability === "available" ? "OK" : "Unsupported",
        ]),
      );
    }
  }

  return `${lines.join("\n")}\n`;
}
