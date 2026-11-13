/**
 * Serialized `/api/history/analytics` answers, held until the history changes.
 *
 * Every dashboard tab asks for the same live ranges on each refresh, but the
 * answer only changes when a scan is recorded. Building one reads the reset
 * events and the series from SQLite and then spends hundreds of milliseconds
 * of CPU, so each live range is built once per recorded scan and then served
 * from memory. An entry also expires after `maximumAgeMilliseconds`, so the
 * time-relative parts of a cached answer (its `generatedAt`, reset countdowns
 * and the overdue-scan warning) never fall more than one scan interval behind
 * when scans stop arriving.
 */
export type AnalyticsCacheEntry = {
  /** The newest recorded scan when the answer was built. */
  scanId: number;
  builtAtMilliseconds: number;
  body: string;
};

// The dashboard asks for two live ranges; a few more allow for other period
// and account choices without holding an unbounded set of answers.
const MAXIMUM_ENTRIES = 8;

export class AnalyticsResponseCache {
  readonly #maximumAgeMilliseconds: number;
  readonly #entries = new Map<string, AnalyticsCacheEntry>();

  public constructor(maximumAgeMilliseconds: number) {
    this.#maximumAgeMilliseconds = maximumAgeMilliseconds;
  }

  public read(
    key: string,
    scanId: number,
    nowMilliseconds: number,
  ): string | undefined {
    const entry = this.#entries.get(key);
    if (
      entry?.scanId !== scanId ||
      nowMilliseconds < entry.builtAtMilliseconds ||
      nowMilliseconds - entry.builtAtMilliseconds >=
        this.#maximumAgeMilliseconds
    ) {
      return undefined;
    }
    return entry.body;
  }

  public write(entry: AnalyticsCacheEntry & { key: string }): void {
    // Answers for an older scan, or past their age, can never be served again.
    for (const [key, held] of this.#entries) {
      if (
        held.scanId !== entry.scanId ||
        entry.builtAtMilliseconds - held.builtAtMilliseconds >=
          this.#maximumAgeMilliseconds
      ) {
        this.#entries.delete(key);
      }
    }
    this.#entries.delete(entry.key);
    if (this.#entries.size >= MAXIMUM_ENTRIES) {
      const oldest = this.#entries.keys().next().value;
      if (oldest !== undefined) this.#entries.delete(oldest);
    }
    this.#entries.set(entry.key, {
      scanId: entry.scanId,
      builtAtMilliseconds: entry.builtAtMilliseconds,
      body: entry.body,
    });
  }

  public get size(): number {
    return this.#entries.size;
  }
}
