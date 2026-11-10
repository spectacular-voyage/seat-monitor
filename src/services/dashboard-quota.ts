import type { Platform } from "../domain/quota.js";
import { quotaSnapshotSchema, type QuotaSnapshot } from "../domain/quota.js";
import {
  findRunningServer,
  type ExternalServerIdentity,
} from "../server-lifecycle.js";

// /api/quota waits for an in-flight scheduled scan, which can take a while.
const QUOTA_READ_TIMEOUT_MILLISECONDS = 60_000;

export type DashboardQuotaRead =
  | { kind: "server"; url: string; snapshots: QuotaSnapshot[] }
  // No running dashboard server was found.
  | { kind: "none" }
  // A server answered, but its quota cannot stand in for a direct scan.
  | { kind: "unusable"; url: string; reason: string };

export type ReadDashboardQuota = (
  accounts: readonly { platform: Platform; accountAlias: string }[],
) => Promise<DashboardQuotaRead>;

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Dashboard quota row is not an object.");
  }
  return { ...(value as Record<string, unknown>) };
}

/** A public /api/quota row back to the snapshot the server scanned. */
export function snapshotFromDashboardRow(row: unknown): QuotaSnapshot {
  const snapshot = record(row);
  if (snapshot.status === "ok") {
    const cached = typeof snapshot.cachedAt === "string";
    delete snapshot.ageSeconds;
    delete snapshot.stale;
    delete snapshot.cachedAt;
    if (!Array.isArray(snapshot.limits)) {
      throw new TypeError("Dashboard quota limits are not an array.");
    }
    snapshot.limits = snapshot.limits.map((value: unknown) => {
      const limit = record(value);
      delete limit.minutesUntilReset;
      return limit;
    });
    if (cached) {
      snapshot.source = "cache";
    }
  }
  return quotaSnapshotSchema.parse(snapshot);
}

function accountKey(account: { platform: string; accountAlias: string }) {
  return `${account.platform}\0${account.accountAlias}`;
}

export function createDashboardQuotaReader(
  dependencies: {
    findServer?: () => Promise<ExternalServerIdentity | null>;
    fetch?: typeof fetch;
    timeoutMilliseconds?: number;
  } = {},
): ReadDashboardQuota {
  return async (accounts) => {
    let server: ExternalServerIdentity | null;
    try {
      server = await (dependencies.findServer ?? findRunningServer)();
    } catch {
      return { kind: "none" };
    }
    if (server === null) {
      return { kind: "none" };
    }
    const unusable = (reason: string): DashboardQuotaRead => ({
      kind: "unusable",
      url: server.url,
      reason,
    });

    let payload: unknown;
    try {
      const response = await (dependencies.fetch ?? fetch)(
        new URL("/api/quota", server.url),
        {
          headers: { Accept: "application/json" },
          redirect: "error",
          signal: AbortSignal.timeout(
            dependencies.timeoutMilliseconds ?? QUOTA_READ_TIMEOUT_MILLISECONDS,
          ),
        },
      );
      if (!response.ok) {
        await response.body?.cancel();
        return unusable(`HTTP ${String(response.status)}`);
      }
      payload = await response.json();
    } catch {
      return unusable("no quota response");
    }

    let snapshots: QuotaSnapshot[];
    try {
      if (!Array.isArray(payload)) {
        throw new TypeError("Dashboard quota is not an array.");
      }
      snapshots = payload.map(snapshotFromDashboardRow);
    } catch {
      return unusable("its quota response was not understood");
    }

    // The server must be scanning exactly the accounts this CLI is configured
    // for; otherwise its numbers are not this CLI's answer.
    const expected = new Set(accounts.map(accountKey));
    const reported = new Set(snapshots.map(accountKey));
    if (
      reported.size !== snapshots.length ||
      reported.size !== expected.size ||
      [...reported].some((key) => !expected.has(key))
    ) {
      return unusable("it reports a different account set");
    }
    return { kind: "server", url: server.url, snapshots };
  };
}
