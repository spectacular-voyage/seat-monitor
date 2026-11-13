import { describe, expect, it } from "vitest";

import { sameResetEpoch } from "../../src/history/reset-epochs.js";

const HOUR = 3_600_000;
const sighting = (seenAtMilliseconds: number, resetAtMilliseconds: number) => ({
  seenAtMilliseconds,
  resetAtMilliseconds,
});

describe("reset epochs", () => {
  it("treats jitter and a rolling unstarted window as one reset", () => {
    expect(
      sameResetEpoch(sighting(0, 5 * HOUR), sighting(60_000, 5 * HOUR + 975)),
    ).toBe(true);
    expect(
      sameResetEpoch(
        sighting(0, 5 * HOUR),
        sighting(60_000, 5 * HOUR + 60_000),
      ),
    ).toBe(true);
    // Scans that failed for half an hour still see the same rolling window.
    expect(
      sameResetEpoch(sighting(0, 5 * HOUR), sighting(HOUR / 2, 5.5 * HOUR)),
    ).toBe(true);
  });

  it("starts a new reset once the earlier one has passed", () => {
    // The next window, seen right after the reset, moved exactly with the clock.
    expect(
      sameResetEpoch(
        sighting(0, 5 * HOUR),
        sighting(5 * HOUR + 60_000, 10 * HOUR + 60_000),
      ),
    ).toBe(false);
    // A weekly reset seen a week apart is the next week's reset.
    expect(
      sameResetEpoch(sighting(0, 100 * HOUR), sighting(168 * HOUR, 268 * HOUR)),
    ).toBe(false);
    // A provider that moves the reset, and out-of-order sightings, are not merged.
    expect(
      sameResetEpoch(sighting(0, 5 * HOUR), sighting(60_000, 3 * HOUR)),
    ).toBe(false);
    expect(
      sameResetEpoch(sighting(60_000, 5 * HOUR), sighting(0, 5 * HOUR)),
    ).toBe(false);
  });
});
