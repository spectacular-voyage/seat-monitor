import type { QuotaSnapshot } from "../domain/quota.js";

export type ScanSchedulerOptions = {
  refresh: () => Promise<QuotaSnapshot[]>;
  intervalMilliseconds: number;
  scanOnStartup: boolean;
  onError?: () => void;
};

export class ScanScheduler {
  readonly #refresh: () => Promise<QuotaSnapshot[]>;
  readonly #intervalMilliseconds: number;
  readonly #scanOnStartup: boolean;
  readonly #onError: () => void;
  #timer: NodeJS.Timeout | null = null;
  #inFlight: Promise<void> | null = null;
  #running = false;

  public constructor(options: ScanSchedulerOptions) {
    if (
      !Number.isInteger(options.intervalMilliseconds) ||
      options.intervalMilliseconds < 1
    ) {
      throw new RangeError("Scan interval must be a positive integer.");
    }
    this.#refresh = options.refresh;
    this.#intervalMilliseconds = options.intervalMilliseconds;
    this.#scanOnStartup = options.scanOnStartup;
    this.#onError = options.onError ?? (() => undefined);
  }

  public start(): void {
    if (this.#running) {
      return;
    }
    this.#running = true;
    if (this.#scanOnStartup) {
      void this.#run();
    } else {
      this.#schedule();
    }
  }

  public restartCountdown(): void {
    if (this.#running) {
      this.#schedule();
    }
  }

  public async stop(): Promise<void> {
    this.#running = false;
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    await this.#inFlight;
  }

  #schedule(): void {
    if (!this.#running) {
      return;
    }
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
    }
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.#run();
    }, this.#intervalMilliseconds);
  }

  async #run(): Promise<void> {
    if (!this.#running || this.#inFlight !== null) {
      return this.#inFlight ?? undefined;
    }
    this.#inFlight = this.#refresh()
      .then(() => undefined)
      .catch(() => {
        this.#onError();
      })
      .finally(() => {
        this.#inFlight = null;
        this.#schedule();
      });
    return this.#inFlight;
  }
}
