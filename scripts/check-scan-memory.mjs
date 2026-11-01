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
    scans: { type: "string", default: "3" },
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
if (
  !Number.isSafeInteger(budgetBytes) ||
  budgetBytes <= 0 ||
  !Number.isSafeInteger(scans) ||
  scans < 1
)
  throw new Error("Budget and scan count must be positive integers.");
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
  const monitor = startProcessMemoryMonitor(identity.pid);
  let snapshots;
  let memory;
  try {
    snapshots = await get("/api/quota?refresh=true");
  } finally {
    memory = monitor.stop();
  }
  console.log(
    JSON.stringify({
      event: "scan-memory-check",
      scan,
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
