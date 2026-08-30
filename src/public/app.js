const refreshButton = document.querySelector("#refresh");
const rows = document.querySelector("#quota-rows");
const accountCount = document.querySelector("#account-count");
const limitCount = document.querySelector("#limit-count");
const errorCount = document.querySelector("#error-count");
const lastChecked = document.querySelector("#last-checked");
const connectionStatus = document.querySelector("#connection-status");

let loading = false;

function cell(text, className) {
  const element = document.createElement("td");
  element.textContent = text;
  if (className) {
    element.className = className;
  }
  return element;
}

function statusPill(text, tone) {
  const wrapper = document.createElement("td");
  const pill = document.createElement("span");
  pill.className = `pill ${tone}`;
  pill.textContent = text;
  wrapper.append(pill);
  return wrapper;
}

function usageCell(limit) {
  if (limit.usedPercent === null) {
    return cell("N/A", "muted");
  }

  const wrapper = document.createElement("td");
  wrapper.className = "usage";
  const value = document.createElement("span");
  value.textContent = `${new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 2,
  }).format(limit.usedPercent)}%`;
  const progress = document.createElement("progress");
  progress.max = 100;
  progress.value = limit.usedPercent;
  progress.setAttribute("aria-label", `${limit.label} usage`);
  wrapper.append(value, progress);
  return wrapper;
}

function countdownCell(resetAt) {
  const element = cell("N/A", resetAt === null ? "muted" : "countdown");
  if (resetAt !== null) {
    element.dataset.resetAt = resetAt;
  }
  return element;
}

function addErrorRow(snapshot) {
  const row = document.createElement("tr");
  row.append(
    cell(snapshot.accountAlias, "account"),
    cell(snapshot.platform),
    cell("N/A", "muted"),
    cell("N/A", "muted"),
    cell("N/A", "muted"),
    cell("N/A", "muted"),
    statusPill(snapshot.error.code.replaceAll("_", " "), "danger"),
  );
  row.title = snapshot.error.message;
  rows.append(row);
}

function addLimitRow(snapshot, limit) {
  const row = document.createElement("tr");
  row.append(
    cell(snapshot.accountAlias, "account"),
    cell(snapshot.platform),
    cell(snapshot.plan ?? "N/A", snapshot.plan === null ? "muted" : ""),
    cell(limit.label),
    usageCell(limit),
    countdownCell(limit.resetAt),
    statusPill(
      limit.availability === "available" ? "Available" : "Unsupported",
      limit.availability === "available" ? "healthy" : "neutral",
    ),
  );
  rows.append(row);
}

function render(snapshots) {
  rows.replaceChildren();

  if (snapshots.length === 0) {
    const row = document.createElement("tr");
    const empty = cell(
      "No accounts are enabled. Add one to your accounts.json configuration.",
      "empty",
    );
    empty.colSpan = 7;
    row.append(empty);
    rows.append(row);
  } else {
    for (const snapshot of snapshots) {
      if (snapshot.status === "error") {
        addErrorRow(snapshot);
      } else {
        for (const limit of snapshot.limits) {
          addLimitRow(snapshot, limit);
        }
      }
    }
  }

  const limits = snapshots.reduce(
    (total, snapshot) =>
      total + (snapshot.status === "ok" ? snapshot.limits.length : 0),
    0,
  );
  const errors = snapshots.filter(
    (snapshot) => snapshot.status === "error",
  ).length;
  accountCount.textContent = String(snapshots.length);
  limitCount.textContent = String(limits);
  errorCount.textContent = String(errors);
  lastChecked.textContent = new Date().toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  connectionStatus.textContent =
    errors === 0 ? "All account checks completed" : "Partial account failure";
  connectionStatus.className =
    errors === 0 ? "connection healthy-text" : "connection warning-text";
  updateCountdowns();
}

function formatCountdown(resetAt) {
  const remainingSeconds = Math.max(
    0,
    Math.ceil((Date.parse(resetAt) - Date.now()) / 1_000),
  );
  if (!Number.isFinite(remainingSeconds)) {
    return "N/A";
  }
  if (remainingSeconds === 0) {
    return "Now";
  }

  const hours = Math.floor(remainingSeconds / 3_600);
  const minutes = Math.floor((remainingSeconds % 3_600) / 60);
  const seconds = remainingSeconds % 60;
  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }
  return `${minutes}m ${seconds}s`;
}

function updateCountdowns() {
  for (const element of document.querySelectorAll("[data-reset-at]")) {
    element.textContent = formatCountdown(element.dataset.resetAt);
  }
}

async function fetchQuota(forceRefresh = false) {
  if (loading) {
    return;
  }
  loading = true;
  refreshButton.disabled = true;
  refreshButton.classList.add("spinning");
  connectionStatus.textContent = "Refreshing…";
  connectionStatus.className = "connection";

  try {
    const response = await fetch(
      forceRefresh ? "/api/quota?refresh=true" : "/api/quota",
      { headers: { Accept: "application/json" }, cache: "no-store" },
    );
    if (!response.ok) {
      throw new Error("Quota request failed.");
    }
    const snapshots = await response.json();
    if (!Array.isArray(snapshots)) {
      throw new Error("Quota response was invalid.");
    }
    render(snapshots);
  } catch {
    connectionStatus.textContent = "Dashboard could not refresh";
    connectionStatus.className = "connection danger-text";
  } finally {
    loading = false;
    refreshButton.disabled = false;
    refreshButton.classList.remove("spinning");
  }
}

refreshButton.addEventListener("click", () => {
  void fetchQuota(true);
});
setInterval(updateCountdowns, 1_000);
setInterval(() => {
  void fetchQuota(false);
}, 60_000);
void fetchQuota(false);
