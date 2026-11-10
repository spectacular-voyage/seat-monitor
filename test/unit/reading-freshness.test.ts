import { describe, expect, it } from "vitest";

import {
  READING_STALE_AFTER_SECONDS,
  readingFreshness,
} from "../../src/domain/freshness.js";
import {
  toPublicSnapshots,
  withoutLapsedLimits,
} from "../../src/presentation/public-dto.js";
import { renderMarkdownReport } from "../../src/presentation/table.js";
import { renderTextReport } from "../../src/presentation/text-report.js";
import {
  cachedReading,
  claudeSnapshot,
  codexSnapshot,
  nowMilliseconds,
  report,
} from "../helpers/quota-fixtures.js";

const now = new Date(nowMilliseconds).toISOString();
const secondsAgo = (seconds: number) =>
  new Date(nowMilliseconds - seconds * 1_000).toISOString();

describe("reading freshness", () => {
  it("matches the dashboard's 300-second STALE threshold", () => {
    expect(READING_STALE_AFTER_SECONDS).toBe(300);
    expect(readingFreshness(secondsAgo(300), false, nowMilliseconds)).toEqual({
      ageSeconds: 300,
      stale: false,
      cachedAt: null,
    });
    expect(readingFreshness(secondsAgo(301), false, nowMilliseconds)).toEqual({
      ageSeconds: 301,
      stale: true,
      cachedAt: null,
    });
  });

  it("always marks a cached fallback stale, however recent", () => {
    expect(readingFreshness(secondsAgo(5), true, nowMilliseconds)).toEqual({
      ageSeconds: 5,
      stale: true,
      cachedAt: secondsAgo(5),
    });
  });

  it("publishes age, staleness and the cache time on every reading", () => {
    const [live, cached] = toPublicSnapshots(
      [
        claudeSnapshot({ alias: "live@example.com" }),
        cachedReading(claudeSnapshot(), secondsAgo(90)),
      ],
      nowMilliseconds,
    );
    expect(live).toMatchObject({ ageSeconds: 0, stale: false, cachedAt: null });
    expect(live).not.toHaveProperty("source");
    expect(cached).toMatchObject({
      ageSeconds: 90,
      stale: true,
      cachedAt: secondsAgo(90),
    });
    expect(cached).not.toHaveProperty("source");
  });
});

describe("windows that reset after the reading", () => {
  it("become unknown, with the nested Fable sub-cap following its week", () => {
    const lapsed = claudeSnapshot({
      sessionRemainingMinutes: -10,
      weeklyRemainingMinutes: -1,
    });
    // A Fable reading without its own reset inherits the weekly window's.
    const reading =
      lapsed.status === "ok"
        ? {
            ...lapsed,
            limits: lapsed.limits.map((limit) =>
              limit.key === "fable.weekly"
                ? { ...limit, resetAt: null }
                : limit,
            ),
          }
        : lapsed;
    const current = withoutLapsedLimits(reading, nowMilliseconds);
    expect(
      current.status === "ok" &&
        current.limits.map(({ key, usedPercent, resetAt }) => ({
          key,
          usedPercent,
          resetAt,
        })),
    ).toEqual([
      { key: "base.session", usedPercent: null, resetAt: null },
      { key: "base.weekly", usedPercent: null, resetAt: null },
      { key: "fable.weekly", usedPercent: null, resetAt: null },
    ]);
  });

  it("leave current windows, unsupported limits and error rows unchanged", () => {
    const reading = claudeSnapshot({ sessionRemainingMinutes: -10 });
    const current = withoutLapsedLimits(reading, nowMilliseconds);
    expect(current.status === "ok" && current.limits.slice(1)).toEqual(
      reading.status === "ok" && reading.limits.slice(1),
    );
    const failure = {
      accountAlias: "x",
      platform: "Codex" as const,
      observedAt: now,
      status: "error" as const,
      plan: null,
      limits: [] as [],
      error: { code: "timeout" as const, message: "timed out" },
    };
    expect(withoutLapsedLimits(failure, nowMilliseconds)).toBe(failure);
  });
});

describe("stale readings in the quota report", () => {
  const stale = cachedReading(
    claudeSnapshot({ alias: "claude-cached@example.com", weeklyUsed: 10 }),
    secondsAgo(2 * 86_400 + 3_600),
  );

  it("never drive USE but still drive WATCH, flagged STALE", () => {
    const quota = report([stale, codexSnapshot()]);
    expect(quota.use?.accountAlias).not.toBe("claude-cached@example.com");
    const onlyStale = report([stale]);
    expect(onlyStale.use).toBeNull();
    expect(onlyStale.watch?.staleAgeSeconds).toBe(2 * 86_400 + 3_600);
    expect(renderTextReport(onlyStale)).toMatch(/^WATCH: .*STALE 2d 1h old/mu);
  });

  it("labels the account in text and Markdown with its cache time and age", () => {
    const quota = report([stale]);
    expect(renderTextReport(quota)).toContain(
      "  STALE — cached reading from 2026-08-27 17:57 PDT, 2d 1h old; usage may be higher now",
    );
    expect(renderMarkdownReport(quota)).toContain(
      "**STALE — cached reading from 2026-08-27 17:57 PDT, 2d 1h old; usage may be higher now**",
    );
  });

  it("labels an old live reading as a reading, not a cached one", () => {
    const old = { ...claudeSnapshot(), observedAt: secondsAgo(600) };
    expect(renderTextReport(report([old]))).toContain(
      "STALE — reading from 2026-08-29 18:47 PDT, 10m old",
    );
    expect(renderTextReport(report([claudeSnapshot()]))).not.toContain("STALE");
  });
});
