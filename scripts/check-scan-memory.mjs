import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { loadConfiguredAccounts } from "../dist/config/accounts.js";
import {
  assertScanMemoryBudget,
  startProcessMemoryMonitor,
  SCAN_MEMORY_BUDGET_BYTES,
} from "../dist/services/scan-memory.js";

const { values } = parseArgs({
  options: {
    url: { type: "string", default: "http://127.0.0.1:3000" },
    "budget-mb": { type: "string", default: "500" },
    scans: { type: "string", default: "1" },
    "interval-seconds": { type: "string", default: "60" },
  },
});
const url = new URL(values.url);
if (
  url.protocol !== "http:" ||
  !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
)
  throw new Error(
    "Use a local server URL; its processes must be visible in /proc.",
  );
const budgetBytes = Number(values["budget-mb"]) * 1_000_000;
const scans = Number(values.scans);
const intervalSeconds = Number(values["interval-seconds"]);
if (
  !Number.isSafeInteger(budgetBytes) ||
  budgetBytes <= 0 ||
  !Number.isSafeInteger(scans) ||
  scans < 1 ||
  !Number.isSafeInteger(intervalSeconds) ||
  intervalSeconds < 0
)
  throw new Error(
    "Budget and scan count must be positive integers; interval must be a nonnegative integer.",
  );
async function get(path) {
  const response = await fetch(new URL(path, url), {
    signal: AbortSignal.timeout(600_000),
  });
  if (!response.ok) throw new Error(`Server returned HTTP ${response.status}.`);
  return response.json();
}
const identity = await get("/api/server/status");
if (!Number.isSafeInteger(identity.pid) || identity.pid <= 0)
  throw new Error("Server did not supply its PID.");
const expected = loadConfiguredAccounts();
if (expected.length === 0)
  throw new Error("A full-scan check requires configured accounts.");
let failed = false;
for (let scan = 1; scan <= scans; scan += 1) {
  if (scan > 1) await delay(intervalSeconds * 1_000);
  const startedAt = Date.now();
  const monitor = startProcessMemoryMonitor(identity.pid);
  let snapshots;
  let completedIdentity;
  let memory;
  try {
    snapshots = await get("/api/quota?refresh=true");
    completedIdentity = await get("/api/server/status");
  } finally {
    memory = monitor.stop();
  }
  console.log(
    JSON.stringify({
      event: "scan-memory-check",
      scan,
      startedAt: new Date(startedAt).toISOString(),
      durationSeconds: (Date.now() - startedAt) / 1_000,
      staleAccounts: snapshots.filter(
        (snapshot) => Date.now() - Date.parse(snapshot.observedAt) > 300_000,
      ).length,
      accounts: snapshots.length,
      successfulAccounts: snapshots.filter(
        (snapshot) => snapshot.status === "ok",
      ).length,
      budgetBytes,
      defaultBudgetBytes: SCAN_MEMORY_BUDGET_BYTES,
      ...memory,
    }),
  );
  try {
    if (completedIdentity.pid !== identity.pid)
      throw new Error(
        "Server restarted during measurement; repeat the full scan check.",
      );
    assertScanMemoryBudget(memory, budgetBytes);
  } catch (error) {
    console.error(error.message);
    failed = true;
  }
  try {
    if (
      snapshots.length !== expected.length ||
      expected.some(
        (account) =>
          !snapshots.some(
            (snapshot) =>
              snapshot.accountAlias === account.accountAlias &&
              snapshot.platform === account.platform &&
              snapshot.status === "ok",
          ),
      )
    )
      throw new Error(
        "Full scan must successfully read every configured account; missing or failed probes cannot pass the budget gate.",
      );
  } catch (error) {
    console.error(error.message);
    failed = true;
  }
}
process.exitCode = failed ? 1 : 0;
