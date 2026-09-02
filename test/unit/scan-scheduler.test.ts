import { afterEach, describe, expect, it, vi } from "vitest";

import { ScanScheduler } from "../../src/services/scan-scheduler.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("scan scheduler", () => {
  it("waits until a startup scan completes before beginning the interval", async () => {
    vi.useFakeTimers();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const refresh = vi.fn(async () => {
      if (refresh.mock.calls.length === 1) {
        await gate;
      }
      return [];
    });
    const scheduler = new ScanScheduler({
      refresh,
      intervalMilliseconds: 60_000,
      scanOnStartup: true,
    });

    scheduler.start();
    expect(refresh).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(refresh).toHaveBeenCalledOnce();

    release?.();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(59_999);
    expect(refresh).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(refresh).toHaveBeenCalledTimes(2);
    await scheduler.stop();
  });

  it("can delay the initial scan and restart the countdown", async () => {
    vi.useFakeTimers();
    const refresh = vi.fn(() => Promise.resolve([]));
    const scheduler = new ScanScheduler({
      refresh,
      intervalMilliseconds: 60_000,
      scanOnStartup: false,
    });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(30_000);
    scheduler.restartCountdown();
    await vi.advanceTimersByTimeAsync(59_999);
    expect(refresh).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(refresh).toHaveBeenCalledOnce();
    await scheduler.stop();
  });

  it("isolates scan errors and continues scheduling", async () => {
    vi.useFakeTimers();
    const onError = vi.fn();
    const refresh = vi
      .fn<() => Promise<[]>>()
      .mockRejectedValueOnce(new Error("scan failed"))
      .mockResolvedValue([]);
    const scheduler = new ScanScheduler({
      refresh,
      intervalMilliseconds: 60_000,
      scanOnStartup: true,
      onError,
    });

    scheduler.start();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onError).toHaveBeenCalledOnce();
    expect(refresh).toHaveBeenCalledTimes(2);
    await scheduler.stop();
  });

  it("rejects invalid intervals", () => {
    expect(
      () =>
        new ScanScheduler({
          refresh: () => Promise.resolve([]),
          intervalMilliseconds: 0,
          scanOnStartup: true,
        }),
    ).toThrow("positive integer");
  });
});
