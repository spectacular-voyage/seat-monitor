const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const LONGEST_QUOTA_PERIOD_MINUTES = 10_080;
const PERIOD_CONTEXT_MULTIPLIER = 1.05;

const accountCards = document.querySelector("#account-cards");
const accountCount = document.querySelector("#account-count");
const limitCount = document.querySelector("#limit-count");
const errorCount = document.querySelector("#error-count");
const historyStatus = document.querySelector("#history-status");
const lastChecked = document.querySelector("#last-checked");
const connectionStatus = document.querySelector("#connection-status");
const generalStrategy = document.querySelector("#general-strategy");
const fableStrategy = document.querySelector("#fable-strategy");
const watchStrategy = document.querySelector("#watch-strategy");
const fleetCapacity = document.querySelector("#fleet-capacity");
const topWarnings = document.querySelector("#top-warnings");
const rangeControls = document.querySelector("#range-controls");

let loading = false;
let periodMultiplier = 1;

function element(name, className, text) {
  const value = document.createElement(name);
  if (className) {
    value.className = className;
  }
  if (text !== undefined) {
    value.textContent = text;
  }
  return value;
}

function svgElement(name, attributes = {}) {
  const value = document.createElementNS(SVG_NAMESPACE, name);
  for (const [key, attribute] of Object.entries(attributes)) {
    value.setAttribute(key, String(attribute));
  }
  return value;
}

function formatPercent(value) {
  if (value === null || !Number.isFinite(value)) {
    return "Unknown";
  }
  return `${new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 2,
  }).format(value)}%`;
}

function formatRate(projection) {
  if (projection.ratePercentPerHour === null) {
    return "Rate needs more history";
  }
  if (projection.ratePercentPerHour === 0) {
    return "No measurable consumption";
  }
  const basis = {
    epoch: "epoch pace",
    recent_30m: "recent 30m",
    recent_1h: "recent 1h",
    recent_3h: "recent 3h",
  }[projection.rateBasis];
  return `${formatPercent(projection.ratePercentPerHour)} per hour${basis === undefined ? "" : ` · ${basis}`}`;
}

function formatDateTime(value) {
  return new Intl.DateTimeFormat([], {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatCountdown(resetAt) {
  const remainingSeconds = Math.max(
    0,
    Math.ceil((Date.parse(resetAt) - Date.now()) / 1_000),
  );
  if (!Number.isFinite(remainingSeconds)) {
    return "Unknown";
  }
  if (remainingSeconds === 0) {
    return "now";
  }
  const days = Math.floor(remainingSeconds / 86_400);
  const hours = Math.floor((remainingSeconds % 86_400) / 3_600);
  const minutes = Math.floor((remainingSeconds % 3_600) / 60);
  if (days > 0) {
    return `${days}d ${hours}h`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m`;
}

function projectionText(projection) {
  const exhaustion = formatExhaustionRange(projection);
  switch (projection.status) {
    case "already_exhausted":
      return "Quota is exhausted";
    case "exhausts_before_reset":
      return `Projected empty ${exhaustion}`;
    case "reset_before_exhaustion":
      return "Reset is expected before exhaustion";
    case "exhaustion_projected":
      return `Projected empty ${exhaustion}`;
    case "not_consuming":
      return "Usage is currently flat";
    default:
      return "Projection needs more history";
  }
}

function formatExhaustionRange(projection) {
  if (projection.projectedExhaustionAt === null) {
    return "at an unknown time";
  }
  const start = formatDateTime(projection.projectedExhaustionAt);
  if (
    projection.projectedExhaustionRangeEndAt === null ||
    projection.projectedExhaustionRangeEndAt === undefined
  ) {
    return start;
  }
  return `${start}–${formatDateTime(projection.projectedExhaustionRangeEndAt)}`;
}

function formatInterval(seconds) {
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = seconds / 60;
  return Number.isInteger(minutes) ? `${minutes}m` : `${minutes.toFixed(1)}m`;
}

function createWarning(tone, title, detail, action) {
  const warning = element("article", `warning-item ${tone}`);
  const marker = element(
    "span",
    "warning-marker",
    tone === "healthy" ? "✓" : "!",
  );
  marker.setAttribute("aria-hidden", "true");
  const copy = element("div", "warning-copy");
  copy.append(
    element("strong", "warning-title", title),
    element("p", "warning-detail", detail),
  );
  if (action !== undefined) {
    const button = element("button", "warning-action", action.label);
    button.type = "button";
    button.addEventListener("click", action.run);
    copy.append(button);
  }
  warning.append(marker, copy);
  return warning;
}

function renderTopWarnings(payload) {
  const warnings = [];
  const scanIntervalSeconds = payload.scanIntervalSeconds ?? null;
  const lastScanAt = payload.lastScanAt ?? null;
  const generatedAt = Number.isFinite(Date.parse(payload.generatedAt))
    ? Date.parse(payload.generatedAt)
    : Date.now();
  if (scanIntervalSeconds !== null) {
    if (lastScanAt === null) {
      warnings.push(
        createWarning(
          "warning",
          "Waiting for the first scheduled scan",
          `Expected every ${formatInterval(scanIntervalSeconds)} after completion.`,
        ),
      );
    } else {
      const ageMilliseconds = generatedAt - Date.parse(lastScanAt);
      const staleAfterMilliseconds = scanIntervalSeconds * 2 * 1_000;
      if (ageMilliseconds > staleAfterMilliseconds) {
        warnings.push(
          createWarning(
            "danger",
            "Scheduled scans are stale",
            `Last completed ${formatDateTime(lastScanAt)}; expected within two ${formatInterval(scanIntervalSeconds)} intervals.`,
            { label: "Refresh now", run: () => void fetchDashboard(true) },
          ),
        );
      }
    }
  }

  const exhaustions = payload.accounts
    .filter((account) => account.status === "ok")
    .flatMap((account) =>
      account.limits
        .filter(
          (limit) =>
            limit.projection.status === "already_exhausted" ||
            limit.projection.status === "exhausts_before_reset",
        )
        .map((limit) => ({ account, limit })),
    )
    .sort((left, right) => {
      const leftAt = left.limit.projection.projectedExhaustionAt;
      const rightAt = right.limit.projection.projectedExhaustionAt;
      return (
        (leftAt === null ? Number.NEGATIVE_INFINITY : Date.parse(leftAt)) -
        (rightAt === null ? Number.NEGATIVE_INFINITY : Date.parse(rightAt))
      );
    });
  for (const { account, limit } of exhaustions) {
    const exhausted = limit.projection.status === "already_exhausted";
    warnings.push(
      createWarning(
        exhausted ? "danger" : "warning",
        `${account.accountAlias} · ${limit.label}`,
        exhausted
          ? "Quota is exhausted."
          : limit.projection.projectedExhaustionAt === null
            ? "Projected to exhaust before reset."
            : `Projected to exhaust ${formatExhaustionRange(limit.projection)} before reset.`,
      ),
    );
  }

  if (warnings.length === 0) {
    const scanDetail =
      lastScanAt === null
        ? "Current scan timing is unavailable."
        : `Last scan completed ${formatDateTime(lastScanAt)}.`;
    warnings.push(
      createWarning("healthy", "No projected exhaustions", scanDetail),
    );
  }
  topWarnings.replaceChildren(...warnings);
}

function toneForLimit(limit) {
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

function inferredWindowDurationMinutes(limit) {
  if (limit.windowDurationMinutes !== null) {
    return limit.windowDurationMinutes;
  }
  if (limit.key === "base.session" || limit.key === "codex_bengalfox.primary") {
    return 300;
  }
  if (limit.key.includes("weekly") || limit.key.endsWith(".secondary")) {
    return LONGEST_QUOTA_PERIOD_MINUTES;
  }
  return LONGEST_QUOTA_PERIOD_MINUTES;
}

function chartRangeStart(limit, queryStart, rangeEnd) {
  const durationMilliseconds =
    inferredWindowDurationMinutes(limit) *
    periodMultiplier *
    PERIOD_CONTEXT_MULTIPLIER *
    60_000;
  return Math.max(queryStart, rangeEnd - durationMilliseconds);
}

function createUsageGraph(limit, queryStart, rangeEnd, overlays = []) {
  const wrapper = element("div", "chart-wrap");
  const chartLimits = [limit, ...overlays];
  const rangeStart = chartRangeStart(limit, queryStart, rangeEnd);
  const series = chartLimits.map((chartLimit) => ({
    limit: chartLimit,
    measured: chartLimit.points.filter((point) => {
      const observedAt = Date.parse(point.observedAt);
      return (
        point.usedPercent !== null &&
        Number.isFinite(observedAt) &&
        observedAt >= rangeStart &&
        observedAt <= rangeEnd
      );
    }),
    projectionAt:
      chartLimit.projection.projectedExhaustionAt === null
        ? null
        : Date.parse(chartLimit.projection.projectedExhaustionAt),
  }));
  if (series.every((entry) => entry.measured.length === 0)) {
    wrapper.append(
      element("p", "chart-empty", "History begins after the next scan."),
    );
    return wrapper;
  }

  const forecasts = series.filter(
    (entry) =>
      entry.measured.length > 0 &&
      entry.projectionAt !== null &&
      Number.isFinite(entry.projectionAt) &&
      (entry.limit.projection.status === "exhausts_before_reset" ||
        entry.limit.projection.status === "exhaustion_projected"),
  );
  const maximumExtension = rangeEnd + (rangeEnd - rangeStart) * 0.25;
  const chartEnd = forecasts.reduce(
    (end, entry) =>
      Math.max(end, Math.min(entry.projectionAt ?? rangeEnd, maximumExtension)),
    rangeEnd,
  );
  const chartStart = rangeStart;
  const width = 640;
  const height = 176;
  const left = 36;
  const right = 12;
  const top = 12;
  const bottom = 24;
  const innerWidth = width - left - right;
  const innerHeight = height - top - bottom;
  const x = (milliseconds) =>
    left +
    ((milliseconds - chartStart) / (chartEnd - chartStart || 1)) * innerWidth;
  const y = (percent) => top + ((100 - percent) / 100) * innerHeight;

  const svg = svgElement("svg", {
    viewBox: `0 0 ${width} ${height}`,
    role: "img",
    "aria-label": chartLimits
      .map(
        (chartLimit) =>
          `${chartLimit.label} currently ${formatPercent(chartLimit.currentUsedPercent)}`,
      )
      .join("; "),
  });
  const title = svgElement("title");
  title.textContent = `${chartLimits.map((chartLimit) => chartLimit.label).join(" and ")} usage history`;
  svg.append(title);

  for (const percent of [0, 50, 100]) {
    svg.append(
      svgElement("line", {
        x1: left,
        x2: width - right,
        y1: y(percent),
        y2: y(percent),
        class: "chart-grid-line",
      }),
    );
    const label = svgElement("text", {
      x: left - 7,
      y: y(percent) + 4,
      class: "chart-axis-label",
      "text-anchor": "end",
    });
    label.textContent = String(percent);
    svg.append(label);
  }

  const markerValues = [...limit.resetMarkers];
  if (
    limit.depth === 0 &&
    limit.resetAt !== null &&
    !markerValues.some((marker) => marker.at === limit.resetAt)
  ) {
    markerValues.push({ at: limit.resetAt, kind: "provider" });
  }
  for (const marker of markerValues) {
    const milliseconds = Date.parse(marker.at);
    if (milliseconds < chartStart || milliseconds > chartEnd) {
      continue;
    }
    const line = svgElement("line", {
      x1: x(milliseconds),
      x2: x(milliseconds),
      y1: top,
      y2: height - bottom,
      class: `reset-marker ${marker.kind}`,
    });
    const markerTitle = svgElement("title");
    const markerLabel =
      marker.kind === "provider"
        ? "Provider reset"
        : marker.kind === "adjustment"
          ? "Provider reset adjustment"
          : "Inferred reset";
    markerTitle.textContent = `${markerLabel} ${formatDateTime(marker.at)}`;
    line.append(markerTitle);
    svg.append(line);
  }

  for (const entry of series) {
    if (entry.measured.length === 0) {
      continue;
    }
    const nestedClass = entry.limit.depth === 1 ? " nested" : "";
    svg.append(
      svgElement("path", {
        d: entry.measured
          .map((point, index) => {
            const command = index === 0 ? "M" : "L";
            return `${command}${x(Date.parse(point.observedAt)).toFixed(2)},${y(point.usedPercent).toFixed(2)}`;
          })
          .join(" "),
        class: `usage-line${nestedClass}`,
      }),
    );

    const latest = entry.measured.at(-1);
    if (latest === undefined) {
      continue;
    }
    svg.append(
      svgElement("circle", {
        cx: x(Date.parse(latest.observedAt)),
        cy: y(latest.usedPercent),
        r: 4,
        class: `usage-point${nestedClass}`,
      }),
    );
    const showsForecast = forecasts.includes(entry);
    if (
      showsForecast &&
      entry.projectionAt !== null &&
      entry.projectionAt > Date.parse(latest.observedAt)
    ) {
      const forecastEnd = Math.min(entry.projectionAt, chartEnd);
      const forecastProgress =
        (forecastEnd - Date.parse(latest.observedAt)) /
        (entry.projectionAt - Date.parse(latest.observedAt));
      const forecastUsed =
        latest.usedPercent + (100 - latest.usedPercent) * forecastProgress;
      svg.append(
        svgElement("line", {
          x1: x(Date.parse(latest.observedAt)),
          y1: y(latest.usedPercent),
          x2: x(forecastEnd),
          y2: y(forecastUsed),
          class: `forecast-line${nestedClass}`,
        }),
      );
    }
  }

  const startLabel = svgElement("text", {
    x: left,
    y: height - 5,
    class: "chart-time-label",
  });
  startLabel.textContent = formatDateTime(new Date(chartStart).toISOString());
  const endLabel = svgElement("text", {
    x: width - right,
    y: height - 5,
    class: "chart-time-label",
    "text-anchor": "end",
  });
  endLabel.textContent =
    forecasts.length > 0 && chartEnd > rangeEnd ? "forecast" : "now";
  svg.append(startLabel, endLabel);
  wrapper.append(svg);
  return wrapper;
}

function createChartLegend(limits) {
  const legend = element("div", "chart-legend");
  for (const limit of limits) {
    const item = element("span", "legend-item");
    item.append(
      element("span", `legend-swatch ${limit.depth === 1 ? "nested" : ""}`),
      element("span", "legend-label", limit.label),
      element(
        "strong",
        "legend-value",
        formatPercent(limit.currentUsedPercent),
      ),
    );
    legend.append(item);
  }
  return legend;
}

function createLimit(limit, rangeStart, rangeEnd, overlays = []) {
  const section = element(
    "section",
    `limit ${limit.depth === 1 ? "nested-limit" : ""}`,
  );
  const heading = element("div", "limit-heading");
  const identity = element("div");
  identity.append(element("h4", "limit-name", limit.label));
  const reset = element(
    "p",
    "limit-reset",
    limit.resetAt === null
      ? "Reset unknown"
      : limit.depth === 1
        ? "Shares weekly reset · "
        : "Resets ",
  );
  if (limit.resetAt !== null) {
    const time = element("time", "countdown");
    time.dataset.resetAt = limit.resetAt;
    time.dateTime = limit.resetAt;
    time.textContent = formatCountdown(limit.resetAt);
    reset.append(time);
  }
  identity.append(reset);
  const usage = element("div", `current-usage ${toneForLimit(limit)}`);
  usage.append(
    element("strong", "usage-value", formatPercent(limit.currentUsedPercent)),
    element("span", "usage-caption", "used"),
  );
  heading.append(identity, usage);
  section.append(heading);
  if (overlays.length > 0) {
    section.append(createChartLegend([limit, ...overlays]));
  }
  section.append(createUsageGraph(limit, rangeStart, rangeEnd, overlays));

  const metrics = element("div", "limit-metrics");
  for (const metricLimit of [limit, ...overlays]) {
    const prefix =
      overlays.length === 0
        ? ""
        : metricLimit.depth === 1
          ? "Fable "
          : "All-model ";
    const rate = element("div");
    rate.append(element("span", "metric-label", `${prefix}usage rate`));
    rate.append(
      element("strong", "metric-value", formatRate(metricLimit.projection)),
    );
    const forecast = element("div");
    forecast.append(element("span", "metric-label", `${prefix}outlook`));
    forecast.append(
      element("strong", "metric-value", projectionText(metricLimit.projection)),
    );
    metrics.append(rate, forecast);
  }
  section.append(metrics);
  return section;
}

function panelClass(limit) {
  if (limit.key === "base.session") {
    return "session-panel";
  }
  if (limit.key === "base.weekly") {
    return "weekly-panel";
  }
  if (limit.depth === 1) {
    return "fable-panel";
  }
  return "provider-panel";
}

function createWindowPanels(account, rangeStart, rangeEnd) {
  const panels = element("div", "window-grid");
  const entries = [];
  for (const limit of account.limits) {
    if (
      limit.depth === 1 &&
      account.limits.some((candidate) => candidate.key === limit.parentKey)
    ) {
      continue;
    }
    const overlays = account.limits.filter(
      (candidate) => candidate.depth === 1 && candidate.parentKey === limit.key,
    );
    entries.push({ limit, overlays });
  }
  for (const entry of entries) {
    const panel = element(
      "div",
      `window-panel ${panelClass(entry.limit)} ${entry.overlays.length > 0 ? "combined-panel" : ""}`,
    );
    panel.append(
      createLimit(entry.limit, rangeStart, rangeEnd, entry.overlays),
    );
    panels.append(panel);
  }
  if (entries.length === 1) {
    panels.classList.add("single-panel");
  }
  return panels;
}

function createCapacityMeter(limit) {
  const used = limit.currentUsedPercent ?? 0;
  const svg = svgElement("svg", {
    viewBox: "0 0 100 8",
    role: "img",
    "aria-label": `${limit.label}: ${formatPercent(limit.currentUsedPercent)} used`,
    class: "capacity-meter",
    preserveAspectRatio: "none",
  });
  svg.append(
    svgElement("rect", {
      x: 0,
      y: 0,
      width: 100,
      height: 8,
      rx: 2,
      class: "capacity-track",
    }),
    svgElement("rect", {
      x: 0,
      y: 0,
      width: used,
      height: 8,
      rx: 2,
      class: `capacity-fill ${toneForLimit(limit)}`,
    }),
  );
  return svg;
}

function createCapacityLimit(limit) {
  const row = element(
    "div",
    `capacity-limit ${limit.depth === 1 ? "subcap" : ""}`,
  );
  row.append(
    element(
      "span",
      "capacity-limit-name",
      `${limit.depth === 1 ? "↳ " : ""}${limit.label}`,
    ),
    element(
      "strong",
      `capacity-percent ${toneForLimit(limit)}-text`,
      formatPercent(limit.currentUsedPercent),
    ),
    createCapacityMeter(limit),
  );
  const reset = element(
    "span",
    "capacity-reset",
    limit.resetAt === null
      ? "reset unknown"
      : limit.depth === 1
        ? "weekly reset · "
        : "resets in ",
  );
  if (limit.resetAt !== null) {
    const time = element("time", "countdown");
    time.dataset.resetAt = limit.resetAt;
    time.dateTime = limit.resetAt;
    time.textContent = formatCountdown(limit.resetAt);
    reset.append(time);
  }
  row.append(reset);
  return row;
}

function createFleetAccount(account) {
  const item = element("article", "fleet-account");
  const header = element("header", "fleet-account-header");
  const identity = element("div", "fleet-identity");
  identity.append(
    element("span", "fleet-platform", account.platform),
    element("strong", "fleet-alias", account.accountAlias),
    element(
      "span",
      "fleet-plan",
      account.plan === null ? "" : `· ${account.plan}`,
    ),
  );
  header.append(identity);
  if (account.status === "error") {
    header.append(element("span", "danger-text", "Check failed"));
  }
  item.append(header);
  if (account.limits.length === 0) {
    item.append(
      element(
        "p",
        "fleet-empty",
        account.error?.message ?? "No quota limits reported.",
      ),
    );
  } else {
    const limits = element("div", "capacity-limits");
    for (const limit of account.limits) {
      limits.append(createCapacityLimit(limit));
    }
    item.append(limits);
  }
  return item;
}

function renderFleetCapacity(accounts) {
  fleetCapacity.replaceChildren();
  if (accounts.length === 0) {
    fleetCapacity.append(
      element("p", "fleet-loading", "No account capacity is recorded yet."),
    );
    return;
  }
  for (const account of accounts) {
    fleetCapacity.append(createFleetAccount(account));
  }
}

function createAccountCard(account, rangeStart, rangeEnd) {
  const card = element("article", "account-card");
  const header = element("header", "account-header");
  const identity = element("div", "account-identity-line");
  identity.append(
    element("span", "account-vendor", account.platform),
    element("h3", "account-name", account.accountAlias),
    element(
      "span",
      "account-meta",
      `· ${account.plan === null ? "plan not reported" : `${account.plan} plan`} · ${
        account.lastActivityAt === null || account.lastActivityAt === undefined
          ? "no recent usage change"
          : `active ${formatDateTime(account.lastActivityAt)}`
      }`,
    ),
  );
  header.append(identity);
  if (account.status === "error") {
    header.append(element("span", "pill danger", "Check failed"));
  }
  card.append(header);

  if (account.status === "error") {
    const error = element("div", "account-error");
    error.append(
      element("strong", "", account.error.code.replaceAll("_", " ")),
      element("p", "", account.error.message),
    );
    card.append(error);
  }
  if (account.limits.length === 0) {
    card.append(
      element(
        "p",
        "card-empty",
        account.status === "error"
          ? "Previous usage history is not available yet."
          : "No quota limits were reported.",
      ),
    );
  } else {
    card.append(createWindowPanels(account, rangeStart, rangeEnd));
  }
  return card;
}

function strategyContent(target, label, value, detail, tone = "neutral") {
  target.replaceChildren();
  target.append(
    element("span", "strategy-label", label),
    element("strong", `strategy-value ${tone}`, value),
    element("p", "strategy-detail", detail),
  );
}

function renderRecommendations(recommendations) {
  if (recommendations.general === null) {
    strategyContent(
      generalStrategy,
      "General work",
      "No viable account",
      "No account has enough known headroom and a usable reset.",
      "warning-text",
    );
  } else {
    strategyContent(
      generalStrategy,
      "General work",
      recommendations.general.accountAlias,
      `${formatPercent(recommendations.general.headroomPercent)} effective headroom · ${recommendations.general.limitLabel} resets ${formatDateTime(recommendations.general.resetAt)}`,
      "healthy-text",
    );
  }

  if (recommendations.fable === null) {
    strategyContent(
      fableStrategy,
      "Fable work",
      "Not available",
      "No account reports a usable Fable sub-cap.",
    );
  } else {
    const reason = {
      healthy_fable_capacity:
        "Session, shared weekly, and Fable headroom are all usable.",
      projected_before_reset:
        "A Fable constraint is projected to exhaust before its reset.",
      limited_headroom:
        "At least one Fable constraint has less than 20% headroom.",
    }[recommendations.fable.reason];
    strategyContent(
      fableStrategy,
      "Fable work",
      `${recommendations.fable.action === "use" ? "Use" : "Conserve"} ${recommendations.fable.accountAlias}`,
      `${formatPercent(recommendations.fable.effectiveHeadroomPercent)} effective headroom · ${reason}`,
      recommendations.fable.action === "use" ? "healthy-text" : "warning-text",
    );
  }

  if (recommendations.watch === null) {
    strategyContent(
      watchStrategy,
      "Fleet watch",
      "No measured risk",
      "Account-wide consumption is not currently available.",
    );
  } else {
    strategyContent(
      watchStrategy,
      "Fleet watch",
      recommendations.watch.accountAlias,
      `${formatPercent(recommendations.watch.consumedPercent)} consumed on ${recommendations.watch.limitKey}`,
      recommendations.watch.consumedPercent >= 90
        ? "danger-text"
        : "warning-text",
    );
  }
}

function renderAnalytics(payload) {
  accountCards.replaceChildren();
  const rangeStart = Date.parse(payload.from);
  const rangeEnd = Date.parse(payload.to);
  const accounts = [...payload.accounts].sort((left, right) => {
    const leftActivity =
      left.lastActivityAt === null || left.lastActivityAt === undefined
        ? Number.NEGATIVE_INFINITY
        : Date.parse(left.lastActivityAt);
    const rightActivity =
      right.lastActivityAt === null || right.lastActivityAt === undefined
        ? Number.NEGATIVE_INFINITY
        : Date.parse(right.lastActivityAt);
    return (
      rightActivity - leftActivity ||
      Date.parse(right.observedAt) - Date.parse(left.observedAt) ||
      left.accountAlias.localeCompare(right.accountAlias)
    );
  });
  if (accounts.length === 0) {
    accountCards.append(
      element(
        "article",
        "empty-card",
        "No recorded scans yet. Refresh to create the first local snapshot.",
      ),
    );
  } else {
    for (const account of accounts) {
      accountCards.append(createAccountCard(account, rangeStart, rangeEnd));
    }
  }
  const limits = accounts.reduce(
    (total, account) => total + account.limits.length,
    0,
  );
  const errors = accounts.filter(
    (account) => account.status === "error",
  ).length;
  accountCount.textContent = String(accounts.length);
  limitCount.textContent = String(limits);
  errorCount.textContent = String(errors);
  historyStatus.textContent =
    payload.historyHealth === "ready" ? "Local · ready" : "Local · degraded";
  historyStatus.className =
    payload.historyHealth === "ready" ? "healthy-text" : "warning-text";
  renderTopWarnings({ ...payload, accounts });
  renderFleetCapacity(accounts);
  renderRecommendations(payload.recommendations);
  updateCountdowns();
}

function fallbackLimit(limit) {
  return {
    key: limit.key,
    label: limit.label,
    depth: limit.key.startsWith("fable") ? 1 : 0,
    parentKey: limit.key.startsWith("fable") ? "base.weekly" : null,
    availability: limit.availability,
    currentUsedPercent: limit.usedPercent,
    headroomPercent:
      limit.usedPercent === null ? null : 100 - limit.usedPercent,
    windowDurationMinutes: limit.windowDurationMinutes,
    resetAt: limit.key.startsWith("fable") ? null : limit.resetAt,
    minutesUntilReset: limit.minutesUntilReset,
    points: [],
    resetMarkers: [],
    projection: {
      status: "insufficient_history",
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

function renderLiveFallback(snapshots) {
  const now = Date.now();
  const accounts = snapshots.map((snapshot) => ({
    accountAlias: snapshot.accountAlias,
    platform: snapshot.platform,
    plan: snapshot.plan,
    observedAt: snapshot.observedAt,
    lastActivityAt: null,
    status: snapshot.status,
    error: snapshot.status === "error" ? snapshot.error : null,
    limits: snapshot.status === "ok" ? snapshot.limits.map(fallbackLimit) : [],
  }));
  renderAnalytics({
    generatedAt: new Date(now).toISOString(),
    from: new Date(
      now -
        LONGEST_QUOTA_PERIOD_MINUTES *
          periodMultiplier *
          PERIOD_CONTEXT_MULTIPLIER *
          60_000,
    ).toISOString(),
    to: new Date(now).toISOString(),
    accounts,
    historyHealth: "degraded",
    lastScanAt:
      snapshots
        .map((snapshot) => snapshot.observedAt)
        .sort()
        .at(-1) ?? null,
    scanIntervalSeconds: null,
    recommendations: { general: null, fable: null, watch: null },
  });
}

function renderUnavailableShell() {
  accountCount.textContent = "—";
  limitCount.textContent = "—";
  errorCount.textContent = "—";
  historyStatus.textContent = "Not connected";
  historyStatus.className = "warning-text";
  topWarnings.replaceChildren(
    createWarning(
      "danger",
      "Seat Monitor is not connected",
      "Start seat-monitor-server to resume scheduled scans.",
    ),
  );
  fleetCapacity.replaceChildren(
    element(
      "p",
      "fleet-loading",
      "Start seat-monitor-server to load current fleet capacity.",
    ),
  );
  strategyContent(
    generalStrategy,
    "General work",
    "Start Seat Monitor",
    "Run seat-monitor-server, then open http://127.0.0.1:3000.",
    "warning-text",
  );
  strategyContent(
    fableStrategy,
    "Fable work",
    "Waiting for quota",
    "Fable stays nested inside the shared weekly window.",
  );
  strategyContent(
    watchStrategy,
    "Fleet watch",
    "Waiting for quota",
    "The local API is not available from a file:// preview.",
  );
  const card = element("article", "empty-card offline-card");
  card.append(
    element("strong", "", "This preview is not connected to Seat Monitor."),
    element(
      "span",
      "",
      "Start seat-monitor-server and open the loopback URL to load account cards and graphs.",
    ),
  );
  accountCards.replaceChildren(card);
}

function updateCountdowns() {
  for (const value of document.querySelectorAll("[data-reset-at]")) {
    value.textContent = formatCountdown(value.dataset.resetAt);
  }
}

async function requestJson(url) {
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error("Dashboard request failed.");
  }
  return response.json();
}

async function fetchDashboard(forceRefresh = false) {
  if (loading) {
    return;
  }
  loading = true;
  connectionStatus.textContent = "Refreshing…";
  connectionStatus.className = "connection";

  let snapshots = null;
  try {
    snapshots = await requestJson(
      forceRefresh ? "/api/quota?refresh=true" : "/api/quota",
    );
    if (!Array.isArray(snapshots)) {
      throw new Error("Quota response was invalid.");
    }
    const to = new Date();
    const from = new Date(
      to.getTime() -
        LONGEST_QUOTA_PERIOD_MINUTES *
          periodMultiplier *
          PERIOD_CONTEXT_MULTIPLIER *
          60_000,
    );
    const query = new URLSearchParams({
      from: from.toISOString(),
      to: to.toISOString(),
      resolution: "auto",
      periods: String(periodMultiplier),
    });
    const analytics = await requestJson(`/api/history/analytics?${query}`);
    renderAnalytics(analytics);
    const errors = analytics.accounts.filter(
      (account) => account.status === "error",
    ).length;
    connectionStatus.textContent =
      errors === 0 ? "All account checks completed" : "Partial account failure";
    connectionStatus.className =
      errors === 0 ? "connection healthy-text" : "connection warning-text";
  } catch {
    if (snapshots !== null) {
      renderLiveFallback(snapshots);
      connectionStatus.textContent =
        "Live quota available; history is unavailable";
      connectionStatus.className = "connection warning-text";
    } else {
      renderUnavailableShell();
      connectionStatus.textContent = "Dashboard could not refresh";
      connectionStatus.className = "connection danger-text";
    }
  } finally {
    loading = false;
    lastChecked.textContent = new Date().toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  }
}

rangeControls.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-periods]");
  if (!button) {
    return;
  }
  periodMultiplier = Number(button.dataset.periods);
  for (const candidate of rangeControls.querySelectorAll("button")) {
    candidate.setAttribute("aria-pressed", String(candidate === button));
  }
  void fetchDashboard(false);
});
setInterval(updateCountdowns, 1_000);
setInterval(() => {
  void fetchDashboard(false);
}, 60_000);
void fetchDashboard(false);
