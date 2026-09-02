const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const DEFAULT_RANGE_HOURS = 168;

const refreshButton = document.querySelector("#refresh");
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
const rangeControls = document.querySelector("#range-controls");

let loading = false;
let rangeHours = DEFAULT_RANGE_HOURS;

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
  return `${formatPercent(projection.ratePercentPerHour)} per hour`;
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
  switch (projection.status) {
    case "already_exhausted":
      return "Quota is exhausted";
    case "exhausts_before_reset":
      return `Projected empty ${formatDateTime(projection.projectedExhaustionAt)}`;
    case "reset_before_exhaustion":
      return "Reset is expected before exhaustion";
    case "exhaustion_projected":
      return `Projected empty ${formatDateTime(projection.projectedExhaustionAt)}`;
    case "not_consuming":
      return "Usage is currently flat";
    default:
      return "Projection needs more history";
  }
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

function createUsageGraph(limit, rangeStart, rangeEnd) {
  const wrapper = element("div", "chart-wrap");
  const measured = limit.points.filter(
    (point) =>
      point.usedPercent !== null &&
      Number.isFinite(Date.parse(point.observedAt)),
  );
  if (measured.length === 0) {
    wrapper.append(
      element("p", "chart-empty", "History begins after the next scan."),
    );
    return wrapper;
  }

  const projectionAt =
    limit.projection.projectedExhaustionAt === null
      ? null
      : Date.parse(limit.projection.projectedExhaustionAt);
  const maximumExtension = rangeEnd + (rangeEnd - rangeStart) * 0.25;
  const chartEnd =
    projectionAt !== null && Number.isFinite(projectionAt)
      ? Math.max(rangeEnd, Math.min(projectionAt, maximumExtension))
      : rangeEnd;
  const chartStart = Math.min(rangeStart, Date.parse(measured[0].observedAt));
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
    "aria-label": `${limit.label} usage history, currently ${formatPercent(limit.currentUsedPercent)}`,
  });
  const title = svgElement("title");
  title.textContent = `${limit.label} usage history`;
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
    markerTitle.textContent = `${marker.kind === "provider" ? "Provider" : "Inferred"} reset ${formatDateTime(marker.at)}`;
    line.append(markerTitle);
    svg.append(line);
  }

  svg.append(
    svgElement("path", {
      d: measured
        .map((point, index) => {
          const command = index === 0 ? "M" : "L";
          return `${command}${x(Date.parse(point.observedAt)).toFixed(2)},${y(point.usedPercent).toFixed(2)}`;
        })
        .join(" "),
      class: `usage-line ${limit.depth === 1 ? "nested" : ""}`,
    }),
  );

  const latest = measured.at(-1);
  if (latest) {
    svg.append(
      svgElement("circle", {
        cx: x(Date.parse(latest.observedAt)),
        cy: y(latest.usedPercent),
        r: 4,
        class: "usage-point",
      }),
    );
    if (
      projectionAt !== null &&
      projectionAt > Date.parse(latest.observedAt) &&
      projectionAt <= chartEnd
    ) {
      svg.append(
        svgElement("line", {
          x1: x(Date.parse(latest.observedAt)),
          y1: y(latest.usedPercent),
          x2: x(projectionAt),
          y2: y(100),
          class: "forecast-line",
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
    projectionAt !== null && chartEnd > rangeEnd ? "forecast" : "now";
  svg.append(startLabel, endLabel);
  wrapper.append(svg);
  return wrapper;
}

function createLimit(limit, rangeStart, rangeEnd) {
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
  section.append(heading, createUsageGraph(limit, rangeStart, rangeEnd));

  const metrics = element("div", "limit-metrics");
  const rate = element("div");
  rate.append(element("span", "metric-label", "Usage rate"));
  rate.append(element("strong", "metric-value", formatRate(limit.projection)));
  const forecast = element("div");
  forecast.append(element("span", "metric-label", "Outlook"));
  forecast.append(
    element("strong", "metric-value", projectionText(limit.projection)),
  );
  metrics.append(rate, forecast);
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
  for (const limit of account.limits) {
    const panel = element(
      "div",
      `window-panel ${panelClass(limit)} ${limit.depth === 1 ? "subcap-panel" : ""}`,
    );
    panel.append(createLimit(limit, rangeStart, rangeEnd));
    panels.append(panel);
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
  const identity = element("div");
  identity.append(
    element("p", "account-vendor", account.platform),
    element("h3", "account-name", account.accountAlias),
    element(
      "p",
      "account-plan",
      account.plan === null ? "Plan not reported" : `${account.plan} plan`,
    ),
  );
  header.append(
    identity,
    element(
      "span",
      `pill ${account.status === "ok" ? "healthy" : "danger"}`,
      account.status === "ok" ? "Current" : "Check failed",
    ),
  );
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
  if (payload.accounts.length === 0) {
    accountCards.append(
      element(
        "article",
        "empty-card",
        "No recorded scans yet. Refresh to create the first local snapshot.",
      ),
    );
  } else {
    for (const account of payload.accounts) {
      accountCards.append(createAccountCard(account, rangeStart, rangeEnd));
    }
  }
  const limits = payload.accounts.reduce(
    (total, account) => total + account.limits.length,
    0,
  );
  const errors = payload.accounts.filter(
    (account) => account.status === "error",
  ).length;
  accountCount.textContent = String(payload.accounts.length);
  limitCount.textContent = String(limits);
  errorCount.textContent = String(errors);
  historyStatus.textContent =
    payload.historyHealth === "ready" ? "Local · ready" : "Local · degraded";
  historyStatus.className =
    payload.historyHealth === "ready" ? "healthy-text" : "warning-text";
  renderFleetCapacity(payload.accounts);
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
    resetAt: limit.key.startsWith("fable") ? null : limit.resetAt,
    minutesUntilReset: limit.minutesUntilReset,
    points: [],
    resetMarkers: [],
    projection: {
      status: "insufficient_history",
      ratePercentPerHour: null,
      projectedExhaustionAt: null,
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
    status: snapshot.status,
    error: snapshot.status === "error" ? snapshot.error : null,
    limits: snapshot.status === "ok" ? snapshot.limits.map(fallbackLimit) : [],
  }));
  renderAnalytics({
    from: new Date(now - rangeHours * 3_600_000).toISOString(),
    to: new Date(now).toISOString(),
    accounts,
    historyHealth: "degraded",
    recommendations: { general: null, fable: null, watch: null },
  });
}

function renderUnavailableShell() {
  accountCount.textContent = "—";
  limitCount.textContent = "—";
  errorCount.textContent = "—";
  historyStatus.textContent = "Not connected";
  historyStatus.className = "warning-text";
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
  refreshButton.disabled = true;
  refreshButton.classList.add("spinning");
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
    const from = new Date(to.getTime() - rangeHours * 3_600_000);
    const query = new URLSearchParams({
      from: from.toISOString(),
      to: to.toISOString(),
      resolution: "auto",
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
    refreshButton.disabled = false;
    refreshButton.classList.remove("spinning");
    lastChecked.textContent = new Date().toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  }
}

refreshButton.addEventListener("click", () => {
  void fetchDashboard(true);
});
rangeControls.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-range-hours]");
  if (!button) {
    return;
  }
  rangeHours = Number(button.dataset.rangeHours);
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
