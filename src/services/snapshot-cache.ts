import type { QuotaSnapshot } from "../domain/quota.js";
import type { Scanner } from "./scan-accounts.js";

export class SnapshotCache {
  readonly #scan: Scanner;
  readonly #freshnessMilliseconds: number;
  readonly #now: () => Date;
  #cached: { snapshots: QuotaSnapshot[]; cachedAt: number } | null = null;
  #inFlight: Promise<QuotaSnapshot[]> | null = null;

  public get hasSnapshot(): boolean {
    return this.#cached !== null;
  }

  public constructor(options: {
    scan: Scanner;
    freshnessMilliseconds: number;
    now: () => Date;
  }) {
    this.#scan = options.scan;
    this.#freshnessMilliseconds = options.freshnessMilliseconds;
    this.#now = options.now;
  }

  public async read(forceRefresh = false): Promise<QuotaSnapshot[]> {
    const nowMilliseconds = this.#now().getTime();
    if (
      !forceRefresh &&
      this.#cached !== null &&
      nowMilliseconds - this.#cached.cachedAt < this.#freshnessMilliseconds
    ) {
      return this.#cached.snapshots;
    }

    if (this.#inFlight !== null) {
      return this.#inFlight;
    }

    this.#inFlight = this.#scan()
      .then((snapshots) => {
        this.#cached = {
          snapshots,
          cachedAt: this.#now().getTime(),
        };
        return snapshots;
      })
      .finally(() => {
        this.#inFlight = null;
      });
    return this.#inFlight;
  }

  public async readLatest(): Promise<QuotaSnapshot[]> {
    if (this.#inFlight !== null) {
      return this.#inFlight;
    }
    if (this.#cached !== null) {
      return this.#cached.snapshots;
    }
    return this.read();
  }
}
