/**
 * Reset times within this much of each other are one provider reset: the
 * providers round and jitter the reset time they report from scan to scan.
 * The provider reset markers in analytics.ts use the same tolerance.
 */
export const RESET_JITTER_MILLISECONDS = 120_000;

export type ResetSighting = {
  resetAtMilliseconds: number;
  seenAtMilliseconds: number;
};

/**
 * Whether a later sighting of a limit's reset time still describes the same
 * reset as an earlier one. It does when the reset time moved by no more than
 * jitter, or when the earlier reset had not yet passed and the reset time
 * moved forward with the clock: a window that has not started reports "now
 * plus the window" on every scan. The next window's reset, seen after the
 * earlier one passed, is neither, however long the gap between sightings.
 */
export function sameResetEpoch(
  earlier: ResetSighting,
  later: ResetSighting,
): boolean {
  const seenDelta = later.seenAtMilliseconds - earlier.seenAtMilliseconds;
  if (seenDelta < 0) {
    return false;
  }
  const resetDelta = later.resetAtMilliseconds - earlier.resetAtMilliseconds;
  if (Math.abs(resetDelta) <= RESET_JITTER_MILLISECONDS) {
    return true;
  }
  return (
    later.seenAtMilliseconds < earlier.resetAtMilliseconds &&
    Math.abs(resetDelta - seenDelta) <= RESET_JITTER_MILLISECONDS
  );
}
