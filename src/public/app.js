const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const LONGEST_QUOTA_PERIOD_MINUTES = 10_080;
const PERIOD_CONTEXT_MULTIPLIER = 1.05;
const ACCOUNT_SERIES_COLOR_COUNT = 8;
const VENDOR_RATE_COLOR_CLASSES = {
  Claude: "throughput-color-claude",
  Codex: "throughput-color-codex",
};

const accountCards = document.querySelector("#account-cards");
const accountCount = document.querySelector("#account-count");
const limitCount = document.querySelector("#limit-count");
const errorCount = document.querySelector("#error-count");
const historyStatus = document.querySelector("#history-status");
const lastChecked = document.querySelector("#last-checked");
const appVersion = document.querySelector("#app-version");
const connectionStatus = document.querySelector("#connection-status");
const generalStrategy = document.querySelector("#general-strategy");
const fableStrategy = document.querySelector("#fable-strategy");
const watchStrategy = document.querySelector("#watch-strategy");
const fleetCapacity = document.querySelector("#fleet-capacity");
const throughputCharts = document.querySelector("#fleet-throughput-charts");
const topWarnings = document.querySelector("#top-warnings");
const rangeControls = document.querySelector("#range-controls");
const throughputRangeControls = document.querySelector(
  "#throughput-range-controls",
);
const stackedHistoryMedia = window.matchMedia("(max-width: 780px)");

let loading = false;
let periodMultiplier = 1;
let throughputRangeDays = 1;

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

function formatAxisDateTime(value) {
  return new Intl.DateTimeFormat([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
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

function formatWeeklyResetMoment(resetAt) {
  const parts = new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).formatToParts(new Date(resetAt));
  const value = (type) => parts.find((part) => part.type === type)?.value ?? "";
  return `${value("weekday")}, ${value("hour")}:${value("minute")}${value("dayPeriod").toLocaleLowerCase("en-US")}`;
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
        .filter((limit) => limit.projection.status === "exhausts_before_reset")
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
    warnings.push(
      createWarning(
        "warning",
        `${account.accountAlias} · ${limit.label}`,
        limit.projection.projectedExhaustionAt === null
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

function addTimeAxisHover(
  svg,
  { rangeStart, rangeEnd, width, height, left, right, top, bottom },
) {
  const guide = svgElement("line", {
    y1: top,
    y2: height - bottom,
    class: "chart-hover-guide",
    visibility: "hidden",
  });
  const labelBackground = svgElement("rect", {
    y: height - bottom + 4,
    width: 108,
    height: bottom - 5,
    rx: 3,
    class: "chart-hover-label-background",
    visibility: "hidden",
  });
  const label = svgElement("text", {
    y: height - 5,
    class: "chart-hover-label",
    "text-anchor": "middle",
    visibility: "hidden",
  });
  const target = svgElement("rect", {
    x: left,
    y: top,
    width: width - left - right,
    height: height - top - bottom,
    class: "chart-hover-target",
  });
  const setVisible = (visible) => {
    const visibility = visible ? "visible" : "hidden";
    guide.setAttribute("visibility", visibility);
    labelBackground.setAttribute("visibility", visibility);
    label.setAttribute("visibility", visibility);
  };
  target.addEventListener("pointermove", (event) => {
    const bounds = svg.getBoundingClientRect();
    if (bounds.width <= 0) {
      return;
    }
    const svgX = Math.max(
      left,
      Math.min(
        width - right,
        ((event.clientX - bounds.left) / bounds.width) * width,
      ),
    );
    const milliseconds =
      rangeStart +
      ((svgX - left) / (width - left - right)) * (rangeEnd - rangeStart);
    const labelX = Math.max(left + 54, Math.min(width - right - 54, svgX));
    guide.setAttribute("x1", String(svgX));
    guide.setAttribute("x2", String(svgX));
    labelBackground.setAttribute("x", String(labelX - 54));
    label.setAttribute("x", String(labelX));
    label.textContent = formatAxisDateTime(milliseconds);
    setVisible(true);
  });
  target.addEventListener("pointerleave", () => setVisible(false));
  svg.append(guide, labelBackground, label, target);
}

function projectionLineEnd(limit, projectionAt) {
  if (projectionAt === null || !Number.isFinite(projectionAt)) {
    return null;
  }
  if (
    limit.projection.status === "exhausts_before_reset" ||
    limit.projection.status === "exhaustion_projected"
  ) {
    return projectionAt;
  }
  if (limit.projection.status !== "reset_before_exhaustion") {
    return null;
  }
  const resetAt =
    limit.resetAt === null ? Number.NaN : Date.parse(limit.resetAt);
  return Number.isFinite(resetAt) ? Math.min(resetAt, projectionAt) : null;
}

function createUsageGraph(
  limit,
  queryStart,
  rangeEnd,
  overlays = [],
  chartWidth = 640,
) {
  const wrapper = element("div", "chart-wrap");
  const chartLimits = [limit, ...overlays];
  const resetAtMilliseconds =
    limit.depth === 0 && limit.resetAt !== null
      ? Date.parse(limit.resetAt)
      : Number.NaN;
  const futureResetAt =
    Number.isFinite(resetAtMilliseconds) && resetAtMilliseconds > rangeEnd
      ? resetAtMilliseconds
      : null;
  const durationMilliseconds =
    inferredWindowDurationMinutes(limit) *
    periodMultiplier *
    PERIOD_CONTEXT_MULTIPLIER *
    60_000;
  const rangeStart =
    futureResetAt === null
      ? chartRangeStart(limit, queryStart, rangeEnd)
      : Math.max(queryStart, futureResetAt - durationMilliseconds);
  const series = chartLimits.map((chartLimit) => {
    const projectionAt =
      chartLimit.projection.projectedExhaustionAt === null
        ? null
        : Date.parse(chartLimit.projection.projectedExhaustionAt);
    return {
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
      projectionAt,
      projectionLineEndAt: projectionLineEnd(chartLimit, projectionAt),
    };
  });
  if (series.every((entry) => entry.measured.length === 0)) {
    wrapper.append(
      element("p", "chart-empty", "No measured history in this time range."),
    );
    return wrapper;
  }

  const forecasts = series.filter(
    (entry) =>
      entry.measured.length > 0 &&
      entry.projectionAt !== null &&
      Number.isFinite(entry.projectionAt) &&
      entry.projectionLineEndAt !== null &&
      Number.isFinite(entry.projectionLineEndAt) &&
      entry.projectionLineEndAt >
        Date.parse(entry.measured.at(-1)?.observedAt ?? ""),
  );
  const maximumExtension = rangeEnd + (rangeEnd - rangeStart) * 0.25;
  const forecastEnd = forecasts.reduce(
    (end, entry) =>
      Math.max(
        end,
        Math.min(entry.projectionLineEndAt ?? rangeEnd, maximumExtension),
      ),
    rangeEnd,
  );
  const chartEnd = futureResetAt ?? forecastEnd;
  const chartStart = rangeStart;
  const width = chartWidth;
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
    markerValues.push({
      at: limit.resetAt,
      kind: futureResetAt === null ? "provider" : "projected",
      source: limit.resetSource,
    });
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
        : marker.kind === "projected"
          ? marker.source === "expected"
            ? "Expected reset"
            : "Projected reset"
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
      entry.projectionLineEndAt !== null &&
      entry.projectionAt > Date.parse(latest.observedAt)
    ) {
      const forecastEnd = Math.min(entry.projectionLineEndAt, chartEnd);
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
    futureResetAt !== null
      ? `projected reset · ${formatAxisDateTime(futureResetAt)}`
      : forecasts.length > 0 && chartEnd > rangeEnd
        ? `forecast · ${formatAxisDateTime(chartEnd)}`
        : "now";
  svg.append(startLabel, endLabel);
  addTimeAxisHover(svg, {
    rangeStart: chartStart,
    rangeEnd: chartEnd,
    width,
    height,
    left,
    right,
    top,
    bottom,
  });
  wrapper.append(svg);
  return wrapper;
}

function niceRateCeiling(value) {
  if (!Number.isFinite(value) || value <= 0) {
    return 1;
  }
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const normalized = value / magnitude;
  const step = [1, 2, 5, 10].find((candidate) => normalized <= candidate) ?? 10;
  return step * magnitude;
}

function formatWindowMinutes(minutes) {
  if (minutes % (7 * 24 * 60) === 0) {
    return `${minutes / (7 * 24 * 60)}w`;
  }
  if (minutes % (24 * 60) === 0) {
    return `${minutes / (24 * 60)}d`;
  }
  if (minutes % 60 === 0) {
    return `${minutes / 60}h`;
  }
  return `${minutes}m`;
}

function createThroughputLineGraph(
  series,
  rangeStart,
  rangeEnd,
  { ariaLabel, maximum, formatAxisValue, breakOnDecrease = false },
) {
  const wrapper = element("div", "throughput-plot");
  const visibleSeries = series
    .map((entry) => ({
      ...entry,
      points: entry.points
        .filter(
          (point) =>
            Number.isFinite(point.value) &&
            Date.parse(point.observedAt) >= rangeStart &&
            Date.parse(point.observedAt) <= rangeEnd,
        )
        .sort(
          (left, right) =>
            Date.parse(left.observedAt) - Date.parse(right.observedAt),
        ),
    }))
    .filter((entry) => entry.points.length > 0);
  if (visibleSeries.length === 0) {
    wrapper.append(
      element(
        "p",
        "throughput-chart-empty",
        "More session history is needed for this chart.",
      ),
    );
    return wrapper;
  }

  const width = 760;
  const height = 196;
  const left = 48;
  const right = 12;
  const top = 12;
  const bottom = 26;
  const innerWidth = width - left - right;
  const innerHeight = height - top - bottom;
  const x = (milliseconds) =>
    left +
    ((milliseconds - rangeStart) / (rangeEnd - rangeStart || 1)) * innerWidth;
  const y = (value) =>
    top + ((maximum - Math.min(maximum, value)) / maximum) * innerHeight;
  const svg = svgElement("svg", {
    viewBox: `0 0 ${width} ${height}`,
    role: "img",
    "aria-label": ariaLabel,
  });
  const title = svgElement("title");
  title.textContent = ariaLabel;
  svg.append(title);

  for (const value of [0, maximum / 2, maximum]) {
    svg.append(
      svgElement("line", {
        x1: left,
        x2: width - right,
        y1: y(value),
        y2: y(value),
        class: "throughput-grid-line",
      }),
    );
    const label = svgElement("text", {
      x: left - 7,
      y: y(value) + 4,
      class: "throughput-axis-label",
      "text-anchor": "end",
    });
    label.textContent = formatAxisValue(value);
    svg.append(label);
  }

  for (const entry of visibleSeries) {
    const path = svgElement("path", {
      d: entry.points
        .map((point, index) => {
          const previous = entry.points[index - 1];
          const command =
            index === 0 ||
            (breakOnDecrease &&
              previous !== undefined &&
              point.value < previous.value)
              ? "M"
              : "L";
          return `${command}${x(Date.parse(point.observedAt)).toFixed(2)},${y(point.value).toFixed(2)}`;
        })
        .join(" "),
      class: `throughput-line ${entry.colorClass}`,
    });
    const lineTitle = svgElement("title");
    lineTitle.textContent = entry.label;
    path.append(lineTitle);
    svg.append(path);
    const latest = entry.points.at(-1);
    if (latest !== undefined) {
      const point = svgElement("circle", {
        cx: x(Date.parse(latest.observedAt)),
        cy: y(latest.value),
        r: 3.5,
        class: `throughput-point ${entry.colorClass}`,
      });
      const pointTitle = svgElement("title");
      pointTitle.textContent = `${entry.label}: ${formatAxisValue(latest.value)}`;
      point.append(pointTitle);
      svg.append(point);
    }
  }

  const startLabel = svgElement("text", {
    x: left,
    y: height - 6,
    class: "throughput-time-label",
  });
  startLabel.textContent = formatAxisDateTime(rangeStart);
  const endLabel = svgElement("text", {
    x: width - right,
    y: height - 6,
    class: "throughput-time-label",
    "text-anchor": "end",
  });
  endLabel.textContent = "now";
  svg.append(startLabel, endLabel);
  addTimeAxisHover(svg, {
    rangeStart,
    rangeEnd,
    width,
    height,
    left,
    right,
    top,
    bottom,
  });
  wrapper.append(svg);
  return wrapper;
}

function createThroughputCard(className, title, description) {
  const card = element("article", `throughput-chart ${className}`);
  const heading = element("header", "throughput-chart-heading");
  heading.append(
    element("h3", "throughput-chart-title", title),
    element("p", "throughput-chart-description", description),
  );
  card.append(heading);
  return card;
}

function createSessionLegend(series) {
  const legend = element("div", "throughput-legend");
  for (const entry of series) {
    const item = element("span", "throughput-legend-item");
    const swatch = element(
      "span",
      `throughput-legend-swatch ${entry.colorClass}`,
    );
    item.append(
      swatch,
      element("span", "throughput-legend-platform", entry.platform),
      element("span", "throughput-legend-label", entry.label),
    );
    legend.append(item);
  }
  return legend;
}

function emptyFleetThroughput(from, to) {
  return {
    from,
    to,
    rateWindowMinutes: 30,
    smoothingWindowMinutes: 60,
    sessions: [],
    vendors: [
      { platform: "Claude", points: [] },
      { platform: "Codex", points: [] },
    ],
  };
}

function renderFleetThroughput(throughput) {
  throughputCharts.replaceChildren();
  const rangeStart = Date.parse(throughput.from);
  const rangeEnd = Date.parse(throughput.to);
  const sessions = throughput.sessions.map((session, index) => ({
    label: session.accountAlias,
    platform: session.platform,
    colorClass: `throughput-color-${index % ACCOUNT_SERIES_COLOR_COUNT}`,
    points: session.points.map((point) => ({
      observedAt: point.observedAt,
      value: point.usedPercent,
    })),
  }));
  for (const platform of ["Claude", "Codex"]) {
    const platformSessions = sessions.filter(
      (session) => session.platform === platform,
    );
    const usageTitle =
      platform === "Claude"
        ? "Claude account sessions"
        : "Codex account primaries";
    const usage = createThroughputCard(
      `throughput-usage throughput-${platform.toLocaleLowerCase("en-US")}`,
      usageTitle,
      `${platform === "Claude" ? "Session" : "Primary"} quota consumed; each line is one account.`,
    );
    if (platformSessions.length > 0) {
      usage.append(createSessionLegend(platformSessions));
    }
    usage.append(
      createThroughputLineGraph(platformSessions, rangeStart, rangeEnd, {
        ariaLabel: `${platform} account quota consumption`,
        maximum: 100,
        formatAxisValue: (value) => `${Math.round(value)}%`,
        breakOnDecrease: true,
      }),
    );
    throughputCharts.append(usage);
  }

  for (const platform of ["Claude", "Codex"]) {
    const vendor = throughput.vendors.find(
      (candidate) => candidate.platform === platform,
    );
    const points = (vendor?.points ?? []).map((point) => ({
      observedAt: point.observedAt,
      value: point.ratePercentPerHour,
    }));
    const maximum = niceRateCeiling(
      Math.max(0, ...points.map((point) => point.value)),
    );
    const latestAccountCount = vendor?.points.at(-1)?.accountCount ?? 0;
    const rateTitle =
      platform === "Claude"
        ? "Claude average session rate"
        : "Codex average primary rate";
    const card = createThroughputCard(
      `throughput-rate throughput-${platform.toLocaleLowerCase("en-US")}`,
      rateTitle,
      `${formatWindowMinutes(throughput.smoothingWindowMinutes)} moving average of the trailing-${throughput.rateWindowMinutes}m slope across measurable accounts${latestAccountCount === 0 ? "." : ` · ${latestAccountCount} in the latest sample.`}`,
    );
    card.append(
      createThroughputLineGraph(
        [
          {
            label: `${platform} mean rate`,
            colorClass: VENDOR_RATE_COLOR_CLASSES[platform],
            points,
          },
        ],
        rangeStart,
        rangeEnd,
        {
          ariaLabel: `${platform} average account consumption rate`,
          maximum,
          formatAxisValue: (value) =>
            `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(value)}%/h`,
        },
      ),
    );
    throughputCharts.append(card);
  }
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

function createLimitMetrics(limits) {
  const table = element("table", "limit-metrics");
  table.append(
    element("caption", "visually-hidden", "Usage rate and exhaustion outlook"),
  );

  const head = element("thead");
  const headingRow = element("tr");
  const rowHeadingSpacer = element("th", "metric-row-spacer");
  rowHeadingSpacer.setAttribute("aria-hidden", "true");
  const rateHeading = element("th", "metric-column-heading", "Usage rate");
  rateHeading.scope = "col";
  const outlookHeading = element("th", "metric-column-heading", "Outlook");
  outlookHeading.scope = "col";
  headingRow.append(rowHeadingSpacer, rateHeading, outlookHeading);
  head.append(headingRow);

  const body = element("tbody");
  for (const limit of limits) {
    const row = element("tr");
    const rowHeading = element(
      "th",
      "metric-row-heading",
      limits.length === 1
        ? limit.label
        : limit.depth === 1
          ? "Fable"
          : "All models",
    );
    rowHeading.scope = "row";
    const rate = element("td", "metric-cell");
    rate.append(
      element("strong", "metric-value", formatRate(limit.projection)),
    );
    const outlook = element("td", "metric-cell");
    outlook.append(
      element("strong", "metric-value", projectionText(limit.projection)),
    );
    row.append(rowHeading, rate, outlook);
    body.append(row);
  }
  table.append(head, body);
  return table;
}

function createLimit(
  limit,
  rangeStart,
  rangeEnd,
  overlays = [],
  chartWidth = 640,
) {
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
      ? limit.key === "base.session"
        ? "Starts when a message is sent"
        : "Reset unknown"
      : limit.depth === 1
        ? limit.resetSource === "expected"
          ? "Expected shared weekly reset · "
          : "Shares weekly reset · "
        : limit.resetSource === "expected"
          ? "Expected reset · "
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
  const usageValue = element("strong", "usage-value");
  const primaryUsage = element("span", "usage-primary-value");
  primaryUsage.append(
    element("span", "", formatPercent(limit.currentUsedPercent)),
    element("span", "usage-series-label", " all"),
  );
  usageValue.append(primaryUsage);
  for (const overlay of overlays) {
    const overlayUsage = element(
      "span",
      `usage-overlay-value ${toneForLimit(overlay)}-text`,
    );
    overlayUsage.append(
      element("span", "", formatPercent(overlay.currentUsedPercent)),
      element("span", "usage-series-label", " fable"),
    );
    usageValue.append(element("span", "usage-divider", " / "), overlayUsage);
  }
  usage.append(usageValue, element("span", "usage-caption", "used"));
  heading.append(identity, usage);
  section.append(heading);
  if (overlays.length > 0) {
    section.append(createChartLegend([limit, ...overlays]));
  }
  section.append(
    createUsageGraph(limit, rangeStart, rangeEnd, overlays, chartWidth),
  );

  section.append(createLimitMetrics([limit, ...overlays]));
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
    const chartWidth =
      entry.limit.key === "base.session" &&
      entries.length > 1 &&
      !stackedHistoryMedia.matches
        ? 304
        : 640;
    panel.append(
      createLimit(
        entry.limit,
        rangeStart,
        rangeEnd,
        entry.overlays,
        chartWidth,
      ),
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

function createCapacityLimit(
  limit,
  { showReset = true, sharedReset = false } = {},
) {
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
  if (!showReset) {
    return row;
  }
  const isWeekly = limit.windowDurationMinutes === LONGEST_QUOTA_PERIOD_MINUTES;
  const resetPrefix =
    limit.resetAt === null
      ? limit.key === "base.session"
        ? "starts when a message is sent"
        : "reset unknown"
      : isWeekly
        ? `${limit.resetSource === "expected" ? "expected reset" : "resets"} ${formatWeeklyResetMoment(limit.resetAt)} (`
        : limit.resetSource === "expected"
          ? "expected reset in "
          : "resets in ";
  const reset = element(
    "span",
    `capacity-reset ${sharedReset ? "shared-reset" : ""} ${isWeekly ? "weekly-reset" : ""}`,
    resetPrefix,
  );
  if (limit.resetAt !== null) {
    const time = element("time", "countdown");
    time.dataset.resetAt = limit.resetAt;
    time.dateTime = limit.resetAt;
    time.textContent = formatCountdown(limit.resetAt);
    reset.append(time);
    if (isWeekly) {
      reset.append(")");
    }
  }
  row.append(reset);
  return row;
}

function createCapacityLimitGroup(parent, children) {
  const sharesReset = children.length > 0;
  const group = element(
    "div",
    `capacity-limit-group ${sharesReset ? "shared-reset-group" : ""}`,
  );
  group.append(createCapacityLimit(parent, { sharedReset: sharesReset }));
  for (const child of children) {
    group.append(createCapacityLimit(child, { showReset: false }));
  }
  return group;
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
    const renderedKeys = new Set();
    for (const limit of account.limits.filter((entry) => entry.depth === 0)) {
      const children = account.limits.filter(
        (candidate) => candidate.parentKey === limit.key,
      );
      limits.append(createCapacityLimitGroup(limit, children));
      renderedKeys.add(limit.key);
      for (const child of children) {
        renderedKeys.add(child.key);
      }
    }
    for (const limit of account.limits) {
      if (!renderedKeys.has(limit.key)) {
        limits.append(createCapacityLimitGroup(limit, []));
      }
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
  const providerClass =
    account.platform === "Claude"
      ? "claude-history"
      : account.platform === "Codex"
        ? "codex-history"
        : "";
  const card = element("article", `account-card ${providerClass}`);
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

function expectedLimitCount(account) {
  if (account.limits.length > 0) {
    return account.limits.length;
  }
  return account.platform === "Claude" ? 3 : 1;
}

function limitReportingCounts(accounts) {
  return accounts.reduce(
    (counts, account) => ({
      reported:
        counts.reported + (account.status === "ok" ? account.limits.length : 0),
      expected: counts.expected + expectedLimitCount(account),
    }),
    { reported: 0, expected: 0 },
  );
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
  const limitReporting = limitReportingCounts(accounts);
  const errors = accounts.filter(
    (account) => account.status === "error",
  ).length;
  accountCount.textContent = String(accounts.length);
  limitCount.textContent = `${limitReporting.reported} / ${limitReporting.expected}`;
  limitCount.setAttribute(
    "aria-label",
    `${limitReporting.reported} reported limits out of ${limitReporting.expected} expected`,
  );
  errorCount.textContent = String(errors);
  historyStatus.textContent =
    payload.historyHealth === "ready" ? "Local · ready" : "Local · degraded";
  historyStatus.className =
    payload.historyHealth === "ready" ? "healthy-text" : "warning-text";
  renderTopWarnings({ ...payload, accounts });
  renderFleetCapacity(accounts);
  renderFleetThroughput(
    payload.fleetThroughput ?? emptyFleetThroughput(payload.from, payload.to),
  );
  renderRecommendations(payload.recommendations);
  updateCountdowns();
}

function fallbackLimit(limit, weeklyLimit) {
  const isFable = limit.key.startsWith("fable");
  const effectiveResetAt = isFable
    ? (weeklyLimit?.resetAt ?? null)
    : limit.resetAt;
  return {
    key: limit.key,
    label: limit.label,
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
    limits:
      snapshot.status === "ok"
        ? snapshot.limits.map((limit) =>
            fallbackLimit(
              limit,
              snapshot.limits.find(
                (candidate) => candidate.key === "base.weekly",
              ),
            ),
          )
        : [],
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
    fleetThroughput: emptyFleetThroughput(
      new Date(
        now - 300 * periodMultiplier * PERIOD_CONTEXT_MULTIPLIER * 60_000,
      ).toISOString(),
      new Date(now).toISOString(),
    ),
    recommendations: { general: null, fable: null, watch: null },
  });
}

function renderUnavailableShell() {
  accountCount.textContent = "—";
  limitCount.textContent = "—";
  limitCount.removeAttribute("aria-label");
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
  throughputCharts.replaceChildren(
    element(
      "article",
      "throughput-empty",
      "Start seat-monitor-server to load fleet throughput history.",
    ),
  );
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

async function loadServerVersion() {
  try {
    const status = await requestJson("/api/server/status");
    if (typeof status.version === "string") {
      appVersion.textContent = `v${status.version}`;
    }
  } catch {
    appVersion.textContent = "version unavailable";
  }
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
    const throughputFrom = new Date(
      to.getTime() - throughputRangeDays * 86_400_000,
    );
    const throughputQuery = new URLSearchParams({
      from: throughputFrom.toISOString(),
      to: to.toISOString(),
      resolution: "auto",
    });
    let fleetThroughput = analytics.fleetThroughput;
    try {
      const throughputAnalytics = await requestJson(
        `/api/history/analytics?${throughputQuery}`,
      );
      fleetThroughput = throughputAnalytics.fleetThroughput;
    } catch {
      // Keep the primary analytics response when the longer range is unavailable.
    }
    renderAnalytics({ ...analytics, fleetThroughput });
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
throughputRangeControls.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-throughput-days]");
  if (!button) {
    return;
  }
  throughputRangeDays = Number(button.dataset.throughputDays);
  for (const candidate of throughputRangeControls.querySelectorAll("button")) {
    candidate.setAttribute("aria-pressed", String(candidate === button));
  }
  void fetchDashboard(false);
});
stackedHistoryMedia.addEventListener("change", () => {
  void fetchDashboard(false);
});
setInterval(updateCountdowns, 1_000);
setInterval(() => {
  void fetchDashboard(false);
}, 60_000);
void fetchDashboard(false);
void loadServerVersion();
