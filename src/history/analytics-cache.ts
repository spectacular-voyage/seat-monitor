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
    // Answers built for an older scan can never be served again.
    for (const [key, held] of this.#entries) {
      if (held.scanId !== entry.scanId) this.#entries.delete(key);
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
