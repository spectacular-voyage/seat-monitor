const VENDOR_FILTER_STORAGE_KEY = "seat-monitor:visible-vendors";
const REFRESH_MILLISECONDS = 60_000;
const PENDING_REFRESH_MILLISECONDS = 10_000;
const MAX_PENDING_REFRESHES = 30;
const SOON_DAYS = 7;
const TIER_RANK = ["Ultra", "Max 20x", "Max 5x", "Max", "Pro", "Plus"];

const planSummary = document.querySelector("#plan-summary");
const planTable = document.querySelector("#plan-table");
const connectionStatus = document.querySelector("#connection-status");
const lastChecked = document.querySelector("#last-checked");
const appVersion = document.querySelector("#app-version");
const orderControls = document.querySelector("#plan-order-controls");
const vendorFilters = document.querySelector("#vendor-filters");
const vendorCheckboxes = [...vendorFilters.querySelectorAll("input")];

let latestPayload = null;
let planOrder = "renewal";
let pendingRefreshes = 0;
let refreshTimer = null;

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

function tierClass(tier) {
  if (/^ultra$/iu.test(tier)) return "tier-ultra";
  if (/^max\b/iu.test(tier)) return "tier-max";
  return "tier-other";
}

function parseCalendarDate(value) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function daysUntil(value) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((parseCalendarDate(value) - today) / 86_400_000);
}

function formatCalendarDate(value) {
  const date = parseCalendarDate(value);
  return new Intl.DateTimeFormat([], {
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(date.getFullYear() === new Date().getFullYear()
      ? {}
      : { year: "numeric" }),
  }).format(date);
}

function formatDaysUntil(days) {
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days < 0) return `${-days} days ago`;
  return `in ${days} days`;
}

function formatAge(value) {
  const minutes = Math.max(
    0,
    Math.round((Date.now() - Date.parse(value)) / 60_000),
  );
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

function titleCase(value) {
  return value
    .split(/[-_\s]+/u)
    .filter((part) => part.length > 0)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function providerName(account) {
  return account.platform === "Claude" ? "Anthropic" : "OpenAI";
}

function sourceTag(account, source, subject) {
  if (source === "estimated") {
    const tag = element("span", "source-tag estimated", "est.");
    tag.title =
      account.subscribedAt === null
        ? `Estimated ${subject}.`
        : `Estimated ${subject}: the monthly anniversary of the subscription start (${formatCalendarDate(account.subscribedAt.slice(0, 10))}). ${providerName(account)} does not report this date.`;
    return tag;
  }
  if (source === "declared") {
    const tag = element("span", "source-tag declared", "declared");
    tag.title = `From this account's billing settings in accounts.json.`;
    return tag;
  }
  return null;
}

function createTierCell(account) {
  const cell = element("td", "plan-tier");
  cell.dataset.label = "Tier";
  if (account.tier === null) {
    cell.append(element("span", "unknown-text", "Not reported"));
    return cell;
  }
  cell.append(
    element("span", `tier-pill ${tierClass(account.tier)}`, account.tier),
  );
  if (account.tierSource === "declared") {
    const tag = element("span", "source-tag declared", "declared");
    tag.title = 'From "plan": "ultra" in accounts.json.';
    cell.append(tag);
  }
  return cell;
}

function createDateCell(account) {
  const cell = element("td", "plan-date");
  cell.dataset.label = "Next billing";
  const { renewal } = account;
  if (renewal.date === null) {
    cell.append(element("span", "unknown-text", "Not reported"));
    return cell;
  }
  const days = daysUntil(renewal.date);
  const line = element("span", "plan-date-line");
  const label = element(
    "time",
    "plan-date-value",
    `${renewal.autoRenew === false ? "Ends " : ""}${formatCalendarDate(renewal.date)}`,
  );
  label.dateTime = renewal.date;
  if (renewal.at !== null) {
    label.title = `${providerName(account)} reports ${new Date(renewal.at).toLocaleString()}`;
  }
  line.append(label);
  const tag = sourceTag(account, renewal.dateSource, "billing date");
  if (tag !== null) line.append(tag);
  cell.append(
    line,
    element(
      "span",
      `plan-date-relative ${days <= SOON_DAYS ? "warning-text" : ""}`,
      formatDaysUntil(days),
    ),
  );
  return cell;
}

function createRenewalCell(account) {
  const cell = element("td", "plan-renewal");
  cell.dataset.label = "Renewal";
  const { renewal } = account;
  if (renewal.autoRenew === true) {
    cell.append(element("span", "healthy-text", "Auto-renews"));
  } else if (renewal.autoRenew === false) {
    cell.append(element("span", "pill stale", "Set to expire"));
  } else {
    const unknown = element("span", "unknown-text", "Not reported");
    unknown.title =
      account.platform === "Claude"
        ? 'Anthropic does not report cancellations to Claude Code. Add "billing": {"autoRenew": false} in accounts.json to record one.'
        : "The provider did not report whether this subscription renews.";
    cell.append(unknown);
  }
  if (renewal.autoRenewSource === "declared") {
    const tag = element("span", "source-tag declared", "declared");
    tag.title = "From this account's billing settings in accounts.json.";
    cell.append(tag);
  }
  return cell;
}

function billingCheckText(account) {
  const check = account.billingCheck;
  if (check.status === "unsupported") {
    return {
      text: "Token account: no billing data",
      tone: "unknown-text",
    };
  }
  if (check.status === "pending") {
    return { text: "Checking…", tone: "unknown-text" };
  }
  if (check.status === "unavailable") {
    const reason =
      check.httpStatus === null
        ? "Billing check failed"
        : `Billing check failed (HTTP ${check.httpStatus})`;
    return {
      text:
        check.checkedAt === null
          ? reason
          : `${reason}; last confirmed ${formatAge(check.checkedAt)}`,
      tone: "warning-text",
    };
  }
  return {
    text: `Checked ${formatAge(check.checkedAt)}`,
    tone: "unknown-text",
  };
}

function createStatusCell(account) {
  const cell = element("td", "plan-status");
  cell.dataset.label = "Subscription";
  const status = account.subscriptionStatus;
  cell.append(
    element(
      "span",
      status === null
        ? "unknown-text"
        : status === "active"
          ? "healthy-text"
          : "danger-text",
      status === null ? "Status not reported" : titleCase(status),
    ),
  );
  if (account.billingPeriod !== null) {
    cell.append(
      element("span", "plan-subtle", `Billed ${account.billingPeriod}`),
    );
  }
  if (account.scan.status === "error") {
    cell.append(
      element(
        "span",
        "danger-text plan-subtle",
        `Quota scan: ${account.scan.errorCode.replaceAll("_", " ")}`,
      ),
    );
  }
  const check = billingCheckText(account);
  cell.append(element("span", `plan-subtle ${check.tone}`, check.text));
  return cell;
}

function createRow(account) {
  const row = element("tr", "plan-row");
  row.dataset.accountPlatform = account.platform;
  const identity = element("th", "plan-account");
  identity.scope = "row";
  identity.append(
    element("span", "plan-alias", account.accountAlias),
    element(
      "span",
      `plan-vendor vendor-${account.platform.toLowerCase()}`,
      account.platform,
    ),
  );
  row.append(
    identity,
    createTierCell(account),
    createDateCell(account),
    createRenewalCell(account),
    createStatusCell(account),
  );
  return row;
}

function tierRank(account) {
  const rank = TIER_RANK.indexOf(account.tier ?? "");
  return rank === -1 ? TIER_RANK.length : rank;
}

const COMPARATORS = {
  renewal: (left, right) =>
    (left.renewal.date ?? "9999-12-31").localeCompare(
      right.renewal.date ?? "9999-12-31",
    ) || left.accountAlias.localeCompare(right.accountAlias),
  tier: (left, right) =>
    left.platform.localeCompare(right.platform) ||
    tierRank(left) - tierRank(right) ||
    left.accountAlias.localeCompare(right.accountAlias),
  account: (left, right) => left.accountAlias.localeCompare(right.accountAlias),
};

function visibleVendors() {
  return new Set(
    vendorCheckboxes
      .filter((checkbox) => checkbox.checked)
      .map((checkbox) => checkbox.value),
  );
}

function summaryTile(label, value, detail, tone = "") {
  const tile = element("article", "plan-summary-tile");
  tile.append(
    element("span", "summary-label", label),
    element("strong", tone, value),
  );
  if (detail) {
    tile.append(element("span", "plan-subtle", detail));
  }
  return tile;
}

function renderSummary(accounts) {
  planSummary.replaceChildren();
  if (accounts.length === 0) {
    planSummary.append(
      element("p", "plans-empty", "No accounts match the selected vendors."),
    );
    return;
  }
  const tiers = new Map();
  for (const account of [...accounts].sort(COMPARATORS.tier)) {
    const tier = account.tier ?? "Unknown plan";
    const key = `${account.platform}\0${tier}`;
    const entry = tiers.get(key) ?? {
      platform: account.platform,
      tier,
      count: 0,
    };
    entry.count += 1;
    tiers.set(key, entry);
  }
  const tierList = element("div", "tier-counts");
  for (const { platform, tier, count } of tiers.values()) {
    const item = element("span", "tier-count");
    item.append(
      element("span", "plan-subtle", platform),
      element("span", `tier-pill ${tierClass(tier)}`, tier),
      element("strong", "", `× ${count}`),
    );
    tierList.append(item);
  }
  const tierTile = element("article", "plan-summary-tile plan-summary-tiers");
  tierTile.append(element("span", "summary-label", "Seats by tier"), tierList);

  const dated = accounts
    .filter((account) => account.renewal.date !== null)
    .sort(COMPARATORS.renewal);
  const next = dated[0];
  const soon = dated.filter(
    (account) => daysUntil(account.renewal.date) <= SOON_DAYS,
  ).length;
  const expiring = accounts.filter(
    (account) => account.renewal.autoRenew === false,
  );
  planSummary.append(
    tierTile,
    summaryTile(
      "Next billing",
      next === undefined ? "—" : formatCalendarDate(next.renewal.date),
      next === undefined
        ? "No billing dates reported"
        : `${next.accountAlias} · ${formatDaysUntil(daysUntil(next.renewal.date))}`,
    ),
    summaryTile(
      `Within ${SOON_DAYS} days`,
      String(soon),
      `${dated.length} of ${accounts.length} accounts have a billing date`,
    ),
    summaryTile(
      "Set to expire",
      String(expiring.length),
      expiring.length === 0
        ? "No cancellations reported or declared"
        : expiring.map((account) => account.accountAlias).join(", "),
      expiring.length === 0 ? "" : "warning-text",
    ),
  );
}

function render() {
  if (latestPayload === null) return;
  const vendors = visibleVendors();
  const accounts = latestPayload.accounts.filter((account) =>
    vendors.has(account.platform),
  );
  renderSummary(accounts);
  planTable.replaceChildren();
  if (latestPayload.accounts.length === 0) {
    planTable.append(
      element("p", "plans-empty", "No accounts are configured."),
    );
    return;
  }
  if (accounts.length === 0) {
    planTable.append(
      element("p", "plans-empty", "No accounts match the selected vendors."),
    );
    return;
  }
  const table = element("table", "plan-table");
  const head = element("thead");
  const headings = element("tr");
  for (const heading of [
    "Account",
    "Tier",
    "Next billing",
    "Renewal",
    "Subscription",
  ]) {
    const cell = element("th", "", heading);
    cell.scope = "col";
    headings.append(cell);
  }
  head.append(headings);
  const body = element("tbody");
  for (const account of [...accounts].sort(COMPARATORS[planOrder])) {
    body.append(createRow(account));
  }
  table.append(head, body);
  planTable.append(table);
}

async function requestJson(url) {
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error("Request failed.");
  }
  return response.json();
}

function scheduleRefresh() {
  clearTimeout(refreshTimer);
  const pending =
    latestPayload?.accounts.some(
      (account) => account.billingCheck.status === "pending",
    ) ?? false;
  const usePending = pending && pendingRefreshes < MAX_PENDING_REFRESHES;
  if (usePending) pendingRefreshes += 1;
  refreshTimer = setTimeout(
    () => {
      void loadPlans();
    },
    usePending ? PENDING_REFRESH_MILLISECONDS : REFRESH_MILLISECONDS,
  );
}

async function loadPlans() {
  try {
    const payload = await requestJson("/api/accounts");
    if (!Array.isArray(payload.accounts)) {
      throw new Error("Account plan response was invalid.");
    }
    latestPayload = payload;
    render();
    const pending = payload.accounts.filter(
      (account) => account.billingCheck.status === "pending",
    ).length;
    connectionStatus.textContent =
      pending === 0
        ? "Account plans loaded"
        : `Checking billing for ${pending} account${pending === 1 ? "" : "s"}…`;
    connectionStatus.className =
      pending === 0 ? "connection healthy-text" : "connection";
  } catch {
    connectionStatus.textContent =
      latestPayload === null
        ? "Account plans could not be loaded"
        : "Refresh failed; showing the last loaded plans";
    connectionStatus.className = "connection danger-text";
    if (latestPayload === null) {
      planSummary.replaceChildren(
        element(
          "p",
          "plans-empty",
          "Start seat-monitor-server to load account plans.",
        ),
      );
      planTable.replaceChildren();
    }
  } finally {
    lastChecked.textContent = new Date().toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    scheduleRefresh();
  }
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

try {
  const saved = JSON.parse(localStorage.getItem(VENDOR_FILTER_STORAGE_KEY));
  if (
    Array.isArray(saved) &&
    saved.every((vendor) => vendor === "Claude" || vendor === "Codex")
  ) {
    for (const checkbox of vendorCheckboxes) {
      checkbox.checked = saved.includes(checkbox.value);
    }
  }
} catch {
  // Filtering still works when browser storage is unavailable.
}

vendorFilters.addEventListener("change", () => {
  render();
  try {
    localStorage.setItem(
      VENDOR_FILTER_STORAGE_KEY,
      JSON.stringify([...visibleVendors()]),
    );
  } catch {
    // Keep the current selection even if it cannot be saved.
  }
});

orderControls.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-plan-order]");
  if (!button) {
    return;
  }
  planOrder = button.dataset.planOrder;
  for (const candidate of orderControls.querySelectorAll("button")) {
    candidate.setAttribute("aria-pressed", String(candidate === button));
  }
  render();
});

void loadPlans();
void loadServerVersion();
