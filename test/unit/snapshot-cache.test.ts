import { describe, expect, it, vi } from "vitest";

import { SnapshotCache } from "../../src/services/snapshot-cache.js";

describe("SnapshotCache", () => {
  it("coalesces concurrent scans and honors the freshness window", async () => {
    let now = new Date("2026-08-26T18:00:00.000Z");
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const scan = vi.fn(async () => {
      await gate;
      return [];
    });
    const cache = new SnapshotCache({
      scan,
      freshnessMilliseconds: 30_000,
      now: () => now,
    });

    const first = cache.read();
    const second = cache.read(true);
    release?.();
    await Promise.all([first, second]);
    expect(scan).toHaveBeenCalledOnce();

    await cache.read();
    expect(scan).toHaveBeenCalledOnce();

    now = new Date("2026-08-26T18:00:31.000Z");
    await cache.read();
    expect(scan).toHaveBeenCalledTimes(2);
  });
});
