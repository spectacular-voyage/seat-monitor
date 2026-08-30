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
