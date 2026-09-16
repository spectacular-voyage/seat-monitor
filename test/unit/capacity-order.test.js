import { describe, expect, it } from "vitest";

import {
  compareFleetAccountsByWeeklyReset,
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
