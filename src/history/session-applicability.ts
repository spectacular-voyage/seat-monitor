import type { DatabaseSync } from "node:sqlite";

/** Additive, nullable metadata: old observations and old writers remain unknown.
 * Rollup numeric series are unchanged; applicability belongs to the current snapshot. */
export function ensureSessionApplicability(database: DatabaseSync): void {
  const columns = database.prepare("PRAGMA table_info(limit_snapshots)").all();
  // Older isolated migration callers can supply only a reset-events table.
  if (columns.length === 0) return;
  if (!columns.some((column) => column.name === "applicability")) {
    database.exec(
      "ALTER TABLE limit_snapshots ADD COLUMN applicability TEXT CHECK (applicability IS NULL OR applicability = 'not_applicable')",
    );
  }
}

export function storedApplicability(value: unknown): {
  applicability?: "not_applicable";
} {
  if (value === null || value === undefined) return {};
  if (value !== "not_applicable")
    throw new TypeError("Invalid stored applicability.");
  return { applicability: value };
}
