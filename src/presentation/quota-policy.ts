import type { Platform } from "../domain/quota.js";

/** Local product policy for the two decision-oriented lead lines. */
export const QUOTA_DECISION_POLICY = {
  // Spark remains visible in account detail, but this installation does not use it.
  ignoredLimitKeyPrefixes: {
    Claude: [],
    Codex: ["codex_bengalfox."],
  },
  // WATCH represents account/fleet constraints, not narrower model sub-caps.
  maximumWatchDepth: 0,
} as const satisfies {
  ignoredLimitKeyPrefixes: Record<Platform, readonly string[]>;
  maximumWatchDepth: 0 | 1;
};
