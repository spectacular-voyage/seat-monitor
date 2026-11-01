import { describe, expect, it } from "vitest";

import {
  compareAccountsBySessionUtilization,
  compareFleetAccountsByWeeklyReset,
  READING_STALE_AFTER_SECONDS,
  readingIsStale,
  sessionUtilizationPercent,
  toneForLimit,
  weeklyResetTimestamp,
} from "../../src/public/capacity-order.js";

function account(accountAlias, platform, resetAt) {
  return {
    accountAlias,
    platform,
    limits: [
      {
        depth: 0,
        windowDurationMinutes: 10_080,
        resetAt,
      },
    ],
  };
}

function sessionAccount(accountAlias, platform, usedPercent) {
  return {
    accountAlias,
    platform,
    limits: [
      {
        key: platform === "Claude" ? "base.session" : "codex.primary",
        currentUsedPercent: usedPercent,
      },
    ],
  };
}

describe("At a glance account ordering", () => {
  it("orders measured weekly resets first and unknown resets last", () => {
    const accounts = [
      account("missing", "Claude", null),
      account("later", "Claude", "2026-09-18T12:00:00.000Z"),
      account("invalid", "Codex", "not-a-date"),
      account("soon", "Codex", "2026-09-17T12:00:00.000Z"),
    ];

    expect(weeklyResetTimestamp(accounts[0])).toBe(Number.POSITIVE_INFINITY);
    expect(weeklyResetTimestamp(accounts[2])).toBe(Number.POSITIVE_INFINITY);
    expect(
      accounts
        .sort(compareFleetAccountsByWeeklyReset)
        .map(({ accountAlias }) => accountAlias),
    ).toEqual(["soon", "later", "missing", "invalid"]);
  });

  it("uses provider and alias as stable reset-time tie-breakers", () => {
    const resetAt = "2026-09-17T12:00:00.000Z";
    const accounts = [
      account("zeta", "Claude", resetAt),
      account("beta", "Codex", resetAt),
      account("alpha", "Claude", resetAt),
    ];

    expect(
      accounts
        .sort(compareFleetAccountsByWeeklyReset)
        .map(({ platform, accountAlias }) => `${platform}:${accountAlias}`),
    ).toEqual(["Claude:alpha", "Claude:zeta", "Codex:beta"]);
  });
});

describe("Per-account history ordering", () => {
  it("orders Claude session utilization high to low and keeps Codex last", () => {
    const accounts = [
      sessionAccount("missing", "Claude", null),
      sessionAccount("low", "Claude", 12),
      sessionAccount("high", "Codex", 84),
      sessionAccount("also-missing", "Codex", null),
    ];

    expect(sessionUtilizationPercent(accounts[0])).toBe(
      Number.NEGATIVE_INFINITY,
    );
    expect(
      accounts
        .sort(compareAccountsBySessionUtilization)
        .map(({ accountAlias }) => accountAlias),
    ).toEqual(["low", "missing", "high", "also-missing"]);
  });

  it("uses provider and alias as stable session-utilization tie-breakers", () => {
    const accounts = [
      sessionAccount("zeta", "Claude", 50),
      sessionAccount("beta", "Codex", 50),
      sessionAccount("alpha", "Claude", 50),
    ];

    expect(
      accounts
        .sort(compareAccountsBySessionUtilization)
        .map(({ platform, accountAlias }) => `${platform}:${accountAlias}`),
    ).toEqual(["Claude:alpha", "Claude:zeta", "Codex:beta"]);
  });
});

describe("toneForLimit (SEAT-MON-72, #74)", () => {
  const limit = (currentUsedPercent, status = "not_consuming") => ({
    currentUsedPercent,
    projection: { status },
  });

  it("is neutral and unknown for a missing current reading, never healthy", () => {
    expect(toneForLimit(limit(null, "insufficient_history"))).toBe("unknown");
  });

  it("keeps an observed zero healthy and the thresholds as before (control)", () => {
    expect(toneForLimit(limit(0))).toBe("healthy");
    expect(toneForLimit(limit(75))).toBe("warning");
    expect(toneForLimit(limit(90))).toBe("danger");
    expect(toneForLimit(limit(10, "exhausts_before_reset"))).toBe("danger");
  });
});

describe("reading STALE threshold (seat-monitor probe RAM, 300 s)", () => {
  const observedAt = "2026-11-01T08:00:00.000Z";
  const at = (seconds) => Date.parse(observedAt) + seconds * 1_000;

  it("is 300 seconds", () => {
    expect(READING_STALE_AFTER_SECONDS).toBe(300);
  });

  it("flags a reading older than 300 s and not one at or under it", () => {
    expect(readingIsStale(observedAt, at(301))).toBe(true);
    expect(readingIsStale(observedAt, at(3_600))).toBe(true);
    expect(readingIsStale(observedAt, at(300))).toBe(false);
    expect(readingIsStale(observedAt, at(299))).toBe(false);
    expect(readingIsStale(observedAt, at(0))).toBe(false);
  });

  it("does not flag a reading it cannot place in time", () => {
    expect(readingIsStale("not a date", at(600))).toBe(false);
    expect(readingIsStale(observedAt, Number.NaN)).toBe(false);
  });
});
