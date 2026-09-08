import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  readServerRuntimeState,
  resolveServerRuntimePaths,
  restartDetachedServer,
  startDetachedServer,
  stopDetachedServer,
  writeServerRuntimeState,
  type ServerRuntimeState,
} from "../../src/server-lifecycle.js";
import { runServerCli } from "../../src/server.js";

const temporaryDirectories: string[] = [];

function directory(): string {
  const value = mkdtempSync(join(tmpdir(), "seat-monitor-server-test-"));
  temporaryDirectories.push(value);
  return value;
}

afterEach(() => {
  for (const value of temporaryDirectories.splice(0)) {
    rmSync(value, { force: true, recursive: true });
  }
});

function writer() {
  let value = "";
  return {
    sink: { write: (chunk: string) => (value += chunk) },
    read: () => value,
  };
}

function runtimeState(
  instanceId = "1298b3d9-e131-4b4c-a1c6-54124064fd82",
  pid = 42_424,
): ServerRuntimeState {
  return {
    schemaVersion: 1,
    instanceId,
    pid,
    startedAt: "2026-09-07T18:00:00.000Z",
    host: "127.0.0.1",
    port: 3_000,
    url: "http://127.0.0.1:3000/",
  };
}

describe("detached server lifecycle", () => {
  it("starts only after the detached server acknowledges its identity", async () => {
    const paths = resolveServerRuntimePaths({
      XDG_STATE_HOME: directory(),
    });
    const stdout = writer();
    const stderr = writer();
    const launchDetached = vi.fn(
      async ({ instanceId }: { instanceId: string }) => {
        await writeServerRuntimeState(paths, runtimeState(instanceId));
        return 42_424;
      },
    );

    await expect(
      startDetachedServer({
        paths,
        now: () => new Date("2026-09-07T18:00:00.000Z"),
        stdout: stdout.sink,
        stderr: stderr.sink,
        launchDetached,
        isProcessAlive: () => true,
        fetchIdentity: () => Promise.resolve(true),
        sleep: () => Promise.resolve(),
      }),
    ).resolves.toBe(0);

    expect(launchDetached).toHaveBeenCalledOnce();
    expect(stdout.read()).toContain("started in background (pid: 42424)");
    expect(stdout.read()).toContain(paths.stderrLog);
    expect(stderr.read()).toBe("");
    if (process.platform !== "win32") {
      expect(statSync(paths.directory).mode & 0o777).toBe(0o700);
      expect(statSync(paths.state).mode & 0o777).toBe(0o600);
    }
  });

  it("stops only an identity-matched live process", async () => {
    const paths = resolveServerRuntimePaths({
      XDG_STATE_HOME: directory(),
    });
    const state = runtimeState();
    await writeServerRuntimeState(paths, state);
    let alive = true;
    const signals: NodeJS.Signals[] = [];
    const stdout = writer();

    await expect(
      stopDetachedServer({
        paths,
        stdout: stdout.sink,
        isProcessAlive: () => alive,
        fetchIdentity: () => Promise.resolve(true),
        sendSignal: (_pid, signal) => {
          signals.push(signal);
          alive = false;
        },
        sleep: () => Promise.resolve(),
      }),
    ).resolves.toBe(0);

    expect(signals).toEqual(["SIGTERM"]);
    expect(stdout.read()).toContain("stopped (pid: 42424)");
    await expect(readServerRuntimeState(paths)).resolves.toBeNull();
  });

  it("refuses to signal an unverified live PID", async () => {
    const paths = resolveServerRuntimePaths({
      XDG_STATE_HOME: directory(),
    });
    const state = runtimeState();
    await writeServerRuntimeState(paths, state);
    const signals = vi.fn();
    const stderr = writer();

    await expect(
      stopDetachedServer({
        paths,
        stderr: stderr.sink,
        isProcessAlive: () => true,
        fetchIdentity: () => Promise.resolve(false),
        sendSignal: signals,
      }),
    ).resolves.toBe(1);

    expect(signals).not.toHaveBeenCalled();
    expect(stderr.read()).toContain("identity could not be verified");
    await expect(readServerRuntimeState(paths)).resolves.toEqual(state);
  });

  it("clears dead stale state before starting a replacement", async () => {
    const paths = resolveServerRuntimePaths({
      XDG_STATE_HOME: directory(),
    });
    await writeServerRuntimeState(paths, runtimeState());
    const launchedPid = 52_525;

    await expect(
      startDetachedServer({
        paths,
        now: () => new Date("2026-09-07T18:00:00.000Z"),
        stdout: writer().sink,
        isProcessAlive: (pid) => pid === launchedPid,
        fetchIdentity: () => Promise.resolve(true),
        launchDetached: async ({ instanceId }) => {
          await writeServerRuntimeState(
            paths,
            runtimeState(instanceId, launchedPid),
          );
          return launchedPid;
        },
        sleep: () => Promise.resolve(),
      }),
    ).resolves.toBe(0);

    expect((await readServerRuntimeState(paths))?.pid).toBe(launchedPid);
  });

  it("escalates to SIGKILL when graceful stop times out", async () => {
    const paths = resolveServerRuntimePaths({
      XDG_STATE_HOME: directory(),
    });
    const state = runtimeState();
    await writeServerRuntimeState(paths, state);
    let alive = true;
    const signals: NodeJS.Signals[] = [];

    await expect(
      stopDetachedServer({
        paths,
        stdout: writer().sink,
        isProcessAlive: () => alive,
        fetchIdentity: () => Promise.resolve(true),
        sendSignal: (_pid, signal) => {
          signals.push(signal);
          if (signal === "SIGKILL") {
            alive = false;
          }
        },
        stopTimeoutMilliseconds: 0,
        killTimeoutMilliseconds: 0,
      }),
    ).resolves.toBe(0);

    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("terminates a child that never acknowledges startup", async () => {
    const paths = resolveServerRuntimePaths({
      XDG_STATE_HOME: directory(),
    });
    const signals: NodeJS.Signals[] = [];
    const stderr = writer();

    await expect(
      startDetachedServer({
        paths,
        stderr: stderr.sink,
        launchDetached: () => Promise.resolve(42_424),
        isProcessAlive: () => true,
        fetchIdentity: () => Promise.resolve(false),
        sendSignal: (_pid, signal) => signals.push(signal),
        startupTimeoutMilliseconds: 0,
      }),
    ).resolves.toBe(1);

    expect(signals).toEqual(["SIGTERM"]);
    expect(stderr.read()).toContain("did not acknowledge");
  });

  it("restarts by stopping the verified process before launching", async () => {
    const paths = resolveServerRuntimePaths({
      XDG_STATE_HOME: directory(),
    });
    const oldState = runtimeState();
    await writeServerRuntimeState(paths, oldState);
    const alive = new Set([oldState.pid]);
    const events: string[] = [];

    await expect(
      restartDetachedServer({
        paths,
        now: () => new Date("2026-09-07T18:00:00.000Z"),
        isProcessAlive: (pid) => alive.has(pid),
        fetchIdentity: () => Promise.resolve(true),
        sendSignal: (pid) => {
          events.push(`stop:${String(pid)}`);
          alive.delete(pid);
        },
        launchDetached: async ({ instanceId }) => {
          events.push("start");
          alive.add(52_525);
          await writeServerRuntimeState(
            paths,
            runtimeState(instanceId, 52_525),
          );
          return 52_525;
        },
        sleep: () => Promise.resolve(),
        stdout: writer().sink,
      }),
    ).resolves.toBe(0);

    expect(events).toEqual(["stop:42424", "start"]);
    expect((await readServerRuntimeState(paths))?.pid).toBe(52_525);
  });

  it("keeps bare invocation foreground-compatible and rejects unknown commands", async () => {
    const runForeground = vi.fn(() => Promise.resolve());
    const stdout = writer();
    const stderr = writer();

    await expect(
      runServerCli([], { runForeground, stdout: stdout.sink }),
    ).resolves.toBe(0);
    await expect(
      runServerCli(["bogus"], { runForeground, stderr: stderr.sink }),
    ).resolves.toBe(2);

    expect(runForeground).toHaveBeenCalledOnce();
    expect(stderr.read()).toContain("seat-monitor-server [start|stop|restart]");
  });
});
