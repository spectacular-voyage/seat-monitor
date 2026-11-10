// A reading older than this is STALE. Keep it in step with the dashboard's
// READING_STALE_AFTER_SECONDS in src/public/capacity-order.js.
export const READING_STALE_AFTER_SECONDS = 300;

export type ReadingFreshness = {
  ageSeconds: number;
  stale: boolean;
  cachedAt: string | null;
};

/** How old a reading is, and whether it may be presented as current. A cached
 * fallback is always stale, whatever its age. */
export function readingFreshness(
  observedAt: string,
  cached: boolean,
  nowMilliseconds: number,
): ReadingFreshness {
  const ageSeconds = Math.max(
    0,
    Math.floor((nowMilliseconds - Date.parse(observedAt)) / 1_000),
  );
  return {
    ageSeconds,
    stale: cached || ageSeconds > READING_STALE_AFTER_SECONDS,
    cachedAt: cached ? observedAt : null,
  };
}
