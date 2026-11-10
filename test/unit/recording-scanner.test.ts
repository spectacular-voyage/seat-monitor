import { describe, expect, it, vi } from "vitest";

import type { QuotaSnapshot } from "../../src/domain/quota.js";
import { createRecordingScanner } from "../../src/history/recording-scanner.js";
import { HistoryService } from "../../src/history/service.js";
import type { HistoryStore } from "../../src/history/sqlite-store.js";

describe("recording scanner", () => {
  it("records a successful scan once and returns the original snapshots", async () => {
    const snapshots: QuotaSnapshot[] = [];
    const recordScan = vi.fn();
    const store = {
      recordScan,
      maintain: vi.fn(),
      listScans: vi.fn(),
      readSeries: vi.fn(),
      listResetEvents: vi.fn(),
      close: vi.fn(),
    } satisfies HistoryStore;
    const scanner = createRecordingScanner({
      scan: () => Promise.resolve(snapshots),
      history: new HistoryService(store),
      source: "server",
      now: () => new Date("2026-09-02T18:00:00.000Z"),
    });

    await expect(scanner()).resolves.toBe(snapshots);
    expect(recordScan).toHaveBeenCalledOnce();
    expect(recordScan).toHaveBeenCalledWith(
      "server",
      snapshots,
      new Date("2026-09-02T18:00:00.000Z"),
    );
  });

  it("does not change scan results when persistence fails", async () => {
    const store = {
      recordScan: vi.fn(() => {
        throw new Error("disk failure");
      }),
      maintain: vi.fn(),
      listScans: vi.fn(),
      readSeries: vi.fn(),
      listResetEvents: vi.fn(),
      close: vi.fn(),
    } satisfies HistoryStore;
    const history = new HistoryService(store);
    const scanner = createRecordingScanner({
      scan: () => Promise.resolve([]),
      history,
      source: "cli",
    });

    await expect(scanner()).resolves.toEqual([]);
    expect(history.health).toBe("degraded");
  });

  it("omits a paused account from recorded history while retaining it in the response", async () => {
    const snapshots: QuotaSnapshot[] = [
      {
        accountAlias: "Claude",
        platform: "Claude",
        status: "ok",
        plan: null,
        limits: [],
        observedAt: "2026-10-22T00:00:00.000Z",
      },
    ];
    const recordScan = vi.fn();
    const store = {
      recordScan,
      maintain: vi.fn(),
      listScans: vi.fn(),
      readSeries: vi.fn(),
      listResetEvents: vi.fn(),
      close: vi.fn(),
    } satisfies HistoryStore;
    const scanner = createRecordingScanner({
      scan: () => Promise.resolve(snapshots),
      history: new HistoryService(store),
      source: "server",
      excludedAccountAlias: () => "Claude",
    });
    await expect(scanner()).resolves.toBe(snapshots);
    expect(recordScan).toHaveBeenCalledWith("server", [], expect.any(Date));
  });
});
