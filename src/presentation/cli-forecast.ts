import type { CliForecast, CliForecastLimit } from "../domain/cli-forecast.js";

function value(value: number | null, suffix = ""): string {
  return value === null ? "—" : `${String(value)}${suffix}`;
}

function windowDuration(minutes: number): string {
  if (minutes % (7 * 24 * 60) === 0) {
    return `${String(minutes / (7 * 24 * 60))}w`;
  }
  if (minutes % (24 * 60) === 0) {
    return `${String(minutes / (24 * 60))}d`;
  }
  if (minutes % 60 === 0) {
    return `${String(minutes / 60)}h`;
  }
  return `${String(minutes)}m`;
}

function fleetBurnBasis(forecast: CliForecast): string {
  const first = forecast.fleetBurn[0];
  return first === undefined
    ? ""
    : `${windowDuration(first.smoothingWindowMinutes)} moving average of summed trailing-${String(first.rateWindowMinutes)}m account slopes`;
}

function projectionRange(limit: CliForecastLimit): string {
  if (limit.projectedExhaustionAt === null) {
    return "unknown";
  }
  return limit.projectedExhaustionRangeEndAt === null
    ? limit.projectedExhaustionAt
    : `${limit.projectedExhaustionAt}–${limit.projectedExhaustionRangeEndAt}`;
}

function outlook(limit: CliForecastLimit): string {
  switch (limit.projectionStatus) {
    case "already_exhausted":
      return `already exhausted at ${projectionRange(limit)}`;
    case "exhausts_before_reset":
      return `exhausts before reset at ${projectionRange(limit)}${limit.minutesToExhaustion === null ? "" : ` (${String(limit.minutesToExhaustion)}m)`}`;
    case "reset_before_exhaustion":
      return `reset before projected exhaustion at ${projectionRange(limit)}`;
    case "exhaustion_projected":
      return `exhaustion projected at ${projectionRange(limit)}${limit.minutesToExhaustion === null ? "" : ` (${String(limit.minutesToExhaustion)}m)`}`;
    case "not_consuming":
      return "not consuming";
    case "insufficient_history":
      return "insufficient history";
  }
}

function reset(limit: CliForecastLimit): string {
  return limit.resetAt === null
    ? "reset unknown"
    : `reset ${limit.resetAt} (${limit.resetSource ?? "unknown source"})`;
}

export function renderTextForecast(forecast: CliForecast): string {
  const burnBasis = fleetBurnBasis(forecast);
  const lines = [
    `FORECAST — ${forecast.generatedAt}`,
    `HISTORY — ${forecast.historyHealth}`,
    "",
    `FLEET BURN${burnBasis.length === 0 ? "" : ` — ${burnBasis}`}`,
  ];
  for (const burn of forecast.fleetBurn) {
    lines.push(
      `  ${burn.platform}: ${value(burn.totalRatePercentPerHour, " pp/h")} · ${String(burn.accountCount)} measurable account${burn.accountCount === 1 ? "" : "s"}${burn.observedAt === null ? "" : ` · ${burn.observedAt}`}`,
    );
  }
  lines.push("", "WHO EXHAUSTS NEXT");
  if (forecast.riskRanking.length === 0) {
    lines.push("  No exhaustion time is currently derivable.");
  } else {
    for (const risk of forecast.riskRanking) {
      const when =
        risk.projectedExhaustionAt === null
          ? "unknown time"
          : `${risk.projectedExhaustionAt}${risk.minutesToExhaustion === null ? "" : ` (${String(risk.minutesToExhaustion)}m)`}`;
      lines.push(
        `  ${String(risk.rank)}. ${risk.accountAlias} · ${risk.label} — ${when}`,
      );
    }
  }
  for (const account of forecast.accounts) {
    lines.push(
      "",
      `${account.platform.toLocaleUpperCase("en-US")} ${account.accountAlias}`,
    );
    if (account.status === "error") {
      lines.push(
        `  ERROR ${account.error?.code ?? "unknown"} — ${account.error?.message ?? ""}`,
      );
    }
    for (const limit of account.limits) {
      lines.push(
        `  ${limit.label}: ${value(limit.usedPercent, "%")} · ${value(limit.ratePercentPerHour, "%/h")} (${limit.rateBasis ?? "no basis"}) · ${outlook(limit)} · ${reset(limit)} · ${String(limit.sampleCount)} samples/${String(limit.observationSpanMinutes)}m`,
      );
    }
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderMarkdownForecast(forecast: CliForecast): string {
  const lines = [
    `# FORECAST — ${forecast.generatedAt}`,
    "",
    `History: **${forecast.historyHealth}**`,
    "",
    "## Fleet burn",
    "",
    fleetBurnBasis(forecast),
    "",
    "| Provider | Total burn | Measurable accounts | Observed |",
    "| --- | ---: | ---: | --- |",
    ...forecast.fleetBurn.map(
      (burn) =>
        `| ${burn.platform} | ${value(burn.totalRatePercentPerHour, " pp/h")} | ${String(burn.accountCount)} | ${burn.observedAt ?? "—"} |`,
    ),
    "",
    "## Who exhausts next",
    "",
  ];
  if (forecast.riskRanking.length === 0) {
    lines.push("No exhaustion time is currently derivable.", "");
  } else {
    for (const risk of forecast.riskRanking) {
      lines.push(
        `${String(risk.rank)}. **${risk.accountAlias} · ${risk.label}** — ${risk.projectedExhaustionAt ?? "unknown time"}${risk.minutesToExhaustion === null ? "" : ` (${String(risk.minutesToExhaustion)}m)`}`,
      );
    }
    lines.push("");
  }
  for (const account of forecast.accounts) {
    lines.push(
      `## ${account.platform.toLocaleUpperCase("en-US")} ${account.accountAlias}`,
      "",
      "| Limit | Consumed | Rate | Basis | Outlook | Reset | Samples | Span |",
      "| --- | ---: | ---: | --- | --- | --- | ---: | ---: |",
    );
    for (const limit of account.limits) {
      lines.push(
        `| ${limit.label.replaceAll("|", "\\|")} | ${value(limit.usedPercent, "%")} | ${value(limit.ratePercentPerHour, "%/h")} | ${limit.rateBasis ?? "—"} | ${outlook(limit)} | ${reset(limit)} | ${String(limit.sampleCount)} | ${String(limit.observationSpanMinutes)}m |`,
      );
    }
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}
