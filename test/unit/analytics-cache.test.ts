import { describe, expect, it } from "vitest";

import { AnalyticsResponseCache } from "../../src/history/analytics-cache.js";

describe("analytics response cache", () => {
  it("serves an answer for its scan until it is a full age old", () => {
    const cache = new AnalyticsResponseCache(60_000);
    cache.write({
      key: "week",
      scanId: 7,
      builtAtMilliseconds: 1_000,
      body: "a",
    });

    expect(cache.read("week", 7, 1_000)).toBe("a");
    expect(cache.read("week", 7, 60_999)).toBe("a");
    expect(cache.read("week", 7, 61_000)).toBeUndefined();
    expect(cache.read("week", 8, 2_000)).toBeUndefined();
    expect(cache.read("day", 7, 2_000)).toBeUndefined();
    // A clock that steps backwards never serves an answer from its future.
    expect(cache.read("week", 7, 999)).toBeUndefined();
  });

  it("drops answers for older scans when a newer one is written", () => {
    const cache = new AnalyticsResponseCache(60_000);
    cache.write({ key: "week", scanId: 7, builtAtMilliseconds: 0, body: "a" });
    cache.write({ key: "day", scanId: 7, builtAtMilliseconds: 0, body: "b" });
    expect(cache.size).toBe(2);
    cache.write({ key: "week", scanId: 8, builtAtMilliseconds: 0, body: "c" });

    expect(cache.size).toBe(1);
    expect(cache.read("day", 7, 0)).toBeUndefined();
    expect(cache.read("week", 8, 0)).toBe("c");
  });
});
