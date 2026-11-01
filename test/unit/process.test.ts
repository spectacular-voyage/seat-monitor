import { describe, expect, it } from "vitest";

import {
  ProcessOutputError,
  ProcessSpawnError,
  ProcessTimeoutError,
  runCommand,
} from "../../src/services/process.js";

describe("provider process runner", () => {
  it("captures bounded stdout, stderr, and the exit code", async () => {
    const result = await runCommand({
      command: process.execPath,
      args: [
        "-e",
        'process.stdout.write("out"); process.stderr.write("err"); process.exitCode = 7;',
      ],
      environment: {},
      timeoutMilliseconds: 1_000,
    });

    expect(result).toEqual({ exitCode: 7, stdout: "out", stderr: "err" });
  });

  it("rejects commands that exceed the process deadline", async () => {
    await expect(
      runCommand({
        command: process.execPath,
        args: ["-e", "setInterval(() => {}, 1_000);"],
        environment: {},
        timeoutMilliseconds: 20,
      }),
    ).rejects.toBeInstanceOf(ProcessTimeoutError);
  });

  it("rejects excessive provider output", async () => {
    await expect(
      runCommand({
        command: process.execPath,
        args: ["-e", 'process.stdout.write("x".repeat(1_100_000));'],
        environment: {},
        timeoutMilliseconds: 1_000,
      }),
    ).rejects.toBeInstanceOf(ProcessOutputError);
  });

  it("normalizes spawn failures without returning system details", async () => {
    await expect(
      runCommand({
        command: "/definitely/missing/seat-monitor-provider",
        args: [],
        environment: {},
        timeoutMilliseconds: 1_000,
      }),
    ).rejects.toBeInstanceOf(ProcessSpawnError);
  });
});

describe.skipIf(process.platform !== "linux")("provider descendants", () => {
  it.each(["timeout", "success", "output"])(
    "reaps the entire group on %s",
    async (mode) => {
      const { mkdtemp, readFile, rm } = await import("node:fs/promises");
      const { tmpdir } = await import("node:os");
      const { join } = await import("node:path");
      const directory = await mkdtemp(
        join(tmpdir(), "seat-monitor-descendant-"),
      );
      const pidFile = join(directory, "pid");
      const source = `
      const { spawn } = require('node:child_process');
      const { writeFileSync } = require('node:fs');
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });
      writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
      ${mode === "success" ? "setTimeout(() => process.exit(0), 50);" : mode === "output" ? "setTimeout(() => process.stdout.write('x'.repeat(1100000)), 50);" : "setInterval(() => {}, 1000);"}
    `;
      try {
        const result = runCommand({
          command: process.execPath,
          args: ["-e", source],
          environment: {},
          timeoutMilliseconds: 500,
        });
        if (mode === "success")
          await expect(result).resolves.toMatchObject({ exitCode: 0 });
        else
          await expect(result).rejects.toBeInstanceOf(
            mode === "timeout" ? ProcessTimeoutError : ProcessOutputError,
          );
        const pid = (await readFile(pidFile, "utf8")).trim();
        let status = "";
        try {
          status = await readFile(`/proc/${pid}/status`, "utf8");
        } catch {
          /* Reaped. */
        }
        expect(status === "" || /^State:\s+Z/mu.test(status)).toBe(true);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});
