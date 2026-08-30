import { describe, expect, it } from "vitest";

import {
  minutesUntilReset,
  unixSecondsToIso,
} from "../../src/services/time.js";

describe("minutesUntilReset", () => {
  const now = Date.parse("2026-08-26T12:00:00.000Z");

  it.each([
    [null, null],
    ["2026-08-26T12:00:00.000Z", 0],
    ["2026-08-26T11:59:00.000Z", 0],
    ["2026-08-26T12:00:00.001Z", 1],
    ["2026-08-26T12:01:00.000Z", 1],
    ["2026-08-26T12:01:00.001Z", 2],
  ])("maps %s to %s minutes", (resetAt, expected) => {
    expect(minutesUntilReset(resetAt, now)).toBe(expected);
  });

  it("rejects invalid instants", () => {
    expect(() => minutesUntilReset("not-a-date", now)).toThrow(TypeError);
  });
});

describe("unixSecondsToIso", () => {
  it("converts Unix seconds to an ISO instant", () => {
    expect(unixSecondsToIso(1_787_796_000)).toBe("2026-08-27T02:00:00.000Z");
  });

  it("rejects unsafe timestamps", () => {
    expect(() => unixSecondsToIso(Number.MAX_SAFE_INTEGER)).toThrow(TypeError);
  });
});
