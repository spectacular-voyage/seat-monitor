import { readHistoryConfiguration } from "./config.js";
import { openSqliteHistoryStore, type HistoryStore } from "./sqlite-store.js";
import type {
  HistoryLimitSeries,
  HistoryResetEvent,
  ScanHistoryQuery,
  ScanSource,
  SeriesHistoryQuery,
  StoredScanRun,
} from "./types.js";
import type { QuotaSnapshot } from "../domain/quota.js";

export type HistoryHealth = "ready" | "degraded" | "unavailable";

export class HistoryUnavailableError extends Error {
  public constructor() {
    super("Historical quota data is unavailable.");
    this.name = "HistoryUnavailableError";
  }
}

export class HistoryService {
  readonly #store: HistoryStore | null;
  #health: HistoryHealth;

  public constructor(
    store: HistoryStore | null,
    initialHealth?: HistoryHealth,
  ) {
    this.#store = store;
    this.#health = initialHealth ?? (store === null ? "unavailable" : "ready");
  }

  public get health(): HistoryHealth {
    return this.#health;
  }

  public recordScan(
    source: ScanSource,
    snapshots: readonly QuotaSnapshot[],
    completedAt: Date,
  ): void {
    if (this.#store === null) {
      return;
    }
    try {
      this.#store.recordScan(source, snapshots, completedAt);
      this.#store.maintain(completedAt);
    } catch {
      this.#health = "degraded";
    }
  }

  public listScans(query: ScanHistoryQuery): StoredScanRun[] {
    return this.#read((store) => store.listScans(query));
  }

  public readSeries(query: SeriesHistoryQuery): HistoryLimitSeries[] {
    return this.#read((store) => store.readSeries(query));
  }

  public listResetEvents(query: SeriesHistoryQuery): HistoryResetEvent[] {
    return this.#read((store) => store.listResetEvents(query));
  }

  public close(): void {
    if (this.#store === null) {
      return;
    }
    try {
      this.#store.close();
    } catch {
      this.#health = "degraded";
    }
  }

  #read<T>(operation: (store: HistoryStore) => T): T {
    if (this.#store === null) {
      throw new HistoryUnavailableError();
    }
    try {
      return operation(this.#store);
    } catch {
      this.#health = "degraded";
      throw new HistoryUnavailableError();
    }
  }
}

export function createDefaultHistoryService(
  environment: NodeJS.ProcessEnv = process.env,
  now: () => Date = () => new Date(),
  defaults: {
    rawRetentionDays?: number;
    retentionDays?: number;
  } = {},
): HistoryService {
  try {
    const store = openSqliteHistoryStore(
      readHistoryConfiguration(environment, defaults),
      {
        now,
      },
    );
    try {
      store.maintain(now());
      return new HistoryService(store);
    } catch {
      return new HistoryService(store, "degraded");
    }
  } catch {
    return new HistoryService(null);
  }
}
