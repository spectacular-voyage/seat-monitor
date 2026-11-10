import { describe, expect, it } from "vitest";

import {
  toPublicSnapshots,
  withoutLapsedLimits,
} from "../../src/presentation/public-dto.js";
import {
  createDashboardQuotaReader,
  snapshotFromDashboardRow,
} from "../../src/services/dashboard-quota.js";
import {
  cachedReading,
  claudeSnapshot,
  codexSnapshot,
  nowMilliseconds,
} from "../helpers/quota-fixtures.js";

const server = { pid: 4_242, version: "0.2.0", url: "http://127.0.0.1:3000/" };
const cached = cachedReading(
  claudeSnapshot({ alias: "claude-cached@example.com" }),
  new Date(nowMilliseconds - 120_000).toISOString(),
);
const scanned = [claudeSnapshot(), cached, codexSnapshot()];
const configured = scanned.map(({ platform, accountAlias }) => ({
  platform,
  accountAlias,
}));

function reader(response: () => Response | Promise<Response>) {
  const requests: string[] = [];
  return {
    requests,
    read: createDashboardQuotaReader({
      findServer: () => Promise.resolve(server),
      fetch: (input) => {
        if (!(input instanceof URL)) {
          throw new TypeError("The reader requests a URL.");
        }
        requests.push(input.href);
        return Promise.resolve(response());
      },
    }),
  };
}

describe("dashboard quota reader", () => {
  it("returns the server's scan, keeping which readings were cached", async () => {
    const published = JSON.parse(
      JSON.stringify(toPublicSnapshots(scanned, nowMilliseconds)),
    ) as unknown;
    const { read, requests } = reader(() => Response.json(published));
    await expect(read(configured)).resolves.toEqual({
      kind: "server",
      url: server.url,
      snapshots: scanned.map((snapshot) =>
        withoutLapsedLimits(snapshot, nowMilliseconds),
      ),
    });
    expect(requests).toEqual(["http://127.0.0.1:3000/api/quota"]);
  });

  it("accepts an older server that does not publish freshness fields", () => {
    const [published] = toPublicSnapshots([claudeSnapshot()], nowMilliseconds);
    const legacy = { ...published } as Record<string, unknown>;
    delete legacy.ageSeconds;
    delete legacy.stale;
    delete legacy.cachedAt;
    expect(snapshotFromDashboardRow(legacy)).toEqual(claudeSnapshot());
  });

  it("treats a failed server lookup as no server", async () => {
    const read = createDashboardQuotaReader({
      findServer: () => Promise.reject(new Error("unreadable state")),
    });
    await expect(read(configured)).resolves.toEqual({ kind: "none" });
  });

  it("finds nothing to read when no server is running", async () => {
    const read = createDashboardQuotaReader({
      findServer: () => Promise.resolve(null),
      fetch: () => {
        throw new Error("must not fetch");
      },
    });
    await expect(read(configured)).resolves.toEqual({ kind: "none" });
  });

  it.each([
    ["an HTTP failure", () => new Response(null, { status: 503 }), "HTTP 503"],
    [
      "a refused connection",
      () => {
        throw new TypeError("fetch failed");
      },
      "no quota response",
    ],
    [
      "an unparseable payload",
      () => Response.json({ accounts: [] }),
      "its quota response was not understood",
    ],
    [
      "a different account set",
      () =>
        Response.json(toPublicSnapshots([claudeSnapshot()], nowMilliseconds)),
      "it reports a different account set",
    ],
  ])(
    "refuses %s so the CLI scans directly",
    async (_case, response, reason) => {
      const { read } = reader(response);
      await expect(read(configured)).resolves.toEqual({
        kind: "unusable",
        url: server.url,
        reason,
      });
    },
  );
});
