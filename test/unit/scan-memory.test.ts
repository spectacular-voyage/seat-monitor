import { describe, expect, it } from "vitest";
import {
  assertScanMemoryBudget,
  startProcessMemoryMonitor,
} from "../../src/services/scan-memory.js";
import { runCommand } from "../../src/services/process.js";

// Exercise real resident memory in another process, not heap statistics in Vitest.
describe.skipIf(process.platform !== "linux")(
  "scan memory acceptance gate",
  () => {
    it("counts a resident child and fails an intentionally undersized budget", async () => {
      const monitor = startProcessMemoryMonitor();
      await runCommand({
        command: process.execPath,
        args: [
          "-e",
          "globalThis.allocation = Buffer.alloc(64 * 1024 * 1024, 1); setTimeout(() => {}, 200);",
        ],
        environment: {},
        timeoutMilliseconds: 2_000,
      });
      const report = monitor.stop();
      expect(report.maxChildren).toBeGreaterThanOrEqual(1);
      expect(
        report.processes.some(
          (row) =>
            row.pid !== process.pid && row.peakRssBytes > 64 * 1024 * 1024,
        ),
      ).toBe(true);
      expect(report.remainingChildren).toEqual([]);
      expect(() => assertScanMemoryBudget(report, 1)).toThrow("exceeds budget");
      expect(() =>
        assertScanMemoryBudget(report, report.peakRssBytes),
      ).not.toThrow();
      expect(() =>
        assertScanMemoryBudget({ ...report, supported: false }),
      ).toThrow("unavailable");
      expect(() =>
        assertScanMemoryBudget(
          { ...report, remainingChildren: [123] },
          report.peakRssBytes,
        ),
      ).toThrow("children remain");
    });
  },
);

it.skipIf(process.platform !== "linux")(
  "finds a child spawned by a native worker thread",
  async () => {
    const inner =
      "globalThis.allocation = Buffer.alloc(32 * 1024 * 1024, 1); setTimeout(() => {}, 300);";
    const worker = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(inner)}], { stdio: 'ignore' });`;
    const source = `new (require('node:worker_threads').Worker)(${JSON.stringify(worker)}, { eval: true });`;
    const monitor = startProcessMemoryMonitor();
    try {
      await runCommand({
        command: process.execPath,
        args: ["-e", source],
        environment: {},
        timeoutMilliseconds: 2_000,
      });
    } finally {
      const report = monitor.stop();
      expect(report.maxChildren).toBeGreaterThanOrEqual(2);
      expect(report.remainingChildren).toEqual([]);
    }
  },
);
