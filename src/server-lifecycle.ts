import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

import { z } from "zod";

const STARTUP_TIMEOUT_MILLISECONDS = 60_000;
const STOP_TIMEOUT_MILLISECONDS = 5_000;
const KILL_TIMEOUT_MILLISECONDS = 1_000;
const POLL_INTERVAL_MILLISECONDS = 100;

const serverRuntimeStateSchema = z
  .object({
    schemaVersion: z.literal(1),
    instanceId: z.uuid(),
    pid: z.number().int().positive(),
    startedAt: z.iso.datetime({ offset: true }),
    host: z.enum(["127.0.0.1", "localhost"]),
    port: z.number().int().min(1).max(65_535),
    url: z.url(),
  })
  .strict();

const serverStatusIdentitySchema = z
  .object({
    mode: z.enum(["foreground", "background"]),
    instanceId: z.uuid().nullable(),
    pid: z.number().int().positive(),
    startedAt: z.iso.datetime({ offset: true }).nullable(),
    host: z.enum(["127.0.0.1", "localhost"]),
    port: z.number().int().min(1).max(65_535),
    version: z.string().min(1),
  })
  .loose();

export type ServerRuntimeState = z.infer<typeof serverRuntimeStateSchema>;
export type ExternalServerIdentity = Pick<
  z.infer<typeof serverStatusIdentitySchema>,
  "pid" | "version"
> & { url: string };

export type ServerRuntimePaths = {
  directory: string;
  state: string;
  stdoutLog: string;
  stderrLog: string;
};

type Writable = { write: (value: string) => unknown };

export type LifecycleDependencies = {
  paths?: ServerRuntimePaths;
  environment?: NodeJS.ProcessEnv;
  entryPath?: string;
  execPath?: string;
  execArguments?: readonly string[];
  now?: () => Date;
  stdout?: Writable;
  stderr?: Writable;
  sleep?: (milliseconds: number) => Promise<void>;
  launchDetached?: (options: {
    instanceId: string;
    paths: ServerRuntimePaths;
  }) => Promise<number>;
  isProcessAlive?: (pid: number) => boolean;
  fetchIdentity?: (state: ServerRuntimeState) => Promise<boolean>;
  findExternalServer?: () => Promise<ExternalServerIdentity | null>;
  sendSignal?: (pid: number, signal: NodeJS.Signals) => void;
  startupTimeoutMilliseconds?: number;
  stopTimeoutMilliseconds?: number;
  killTimeoutMilliseconds?: number;
};

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

export function resolveServerRuntimePaths(
  environment: NodeJS.ProcessEnv = process.env,
): ServerRuntimePaths {
  const configured = environment.SEAT_MONITOR_SERVER_RUNTIME_DIR;
  const stateRoot =
    environment.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
  const directory = configured ?? join(stateRoot, "seat-monitor", "server");
  if (!isAbsolute(directory)) {
    throw new TypeError(
      "Seat Monitor server runtime directory must be absolute.",
    );
  }
  return {
    directory,
    state: join(directory, "state.json"),
    stdoutLog: join(directory, "stdout.log"),
    stderrLog: join(directory, "stderr.log"),
  };
}

export async function readServerRuntimeState(
  paths: ServerRuntimePaths,
): Promise<ServerRuntimeState | null> {
  try {
    return serverRuntimeStateSchema.parse(
      JSON.parse(await readFile(paths.state, "utf8")),
    );
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export async function writeServerRuntimeState(
  paths: ServerRuntimePaths,
  state: ServerRuntimeState,
): Promise<void> {
  const value = serverRuntimeStateSchema.parse(state);
  await mkdir(paths.directory, { mode: 0o700, recursive: true });
  await chmod(paths.directory, 0o700);
  const temporaryPath = `${paths.state}.${String(process.pid)}.${randomUUID()}.tmp`;
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporaryPath, paths.state);
  await chmod(paths.state, 0o600);
}

export async function clearServerRuntimeState(
  paths: ServerRuntimePaths,
  instanceId?: string,
): Promise<void> {
  if (instanceId !== undefined) {
    const current = await readServerRuntimeState(paths);
    if (current?.instanceId !== instanceId) {
      return;
    }
  }
  await rm(paths.state, { force: true });
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(
      error instanceof Error &&
      "code" in error &&
      error.code === "ESRCH"
    );
  }
}

async function fetchIdentity(state: ServerRuntimeState): Promise<boolean> {
  const payload = await fetchServerStatus(state.url);
  return (
    payload?.mode === "background" &&
    payload.instanceId === state.instanceId &&
    payload.pid === state.pid
  );
}

async function fetchServerStatus(
  url: string,
): Promise<z.infer<typeof serverStatusIdentitySchema> | null> {
  try {
    const response = await fetch(new URL("/api/server/status", url), {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(500),
    });
    if (!response.ok) {
      return null;
    }
    const parsed = serverStatusIdentitySchema.safeParse(await response.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function probeForegroundServer(
  url: string,
): Promise<ExternalServerIdentity | null> {
  const payload = await fetchServerStatus(url);
  if (payload?.mode !== "foreground" || payload.instanceId !== null) {
    return null;
  }
  return {
    pid: payload.pid,
    version: payload.version,
    url: new URL("/", url).toString(),
  };
}

async function launchDetached(
  options: {
    instanceId: string;
    paths: ServerRuntimePaths;
  },
  dependencies: LifecycleDependencies,
): Promise<number> {
  const environment = dependencies.environment ?? process.env;
  const entryPath = dependencies.entryPath;
  if (entryPath === undefined) {
    throw new TypeError("Detached launch requires the server entry path.");
  }
  await mkdir(options.paths.directory, { mode: 0o700, recursive: true });
  await chmod(options.paths.directory, 0o700);
  const stdoutLog = await open(options.paths.stdoutLog, "a", 0o600);
  const stderrLog = await open(options.paths.stderrLog, "a", 0o600);
  try {
    await chmod(options.paths.stdoutLog, 0o600);
    await chmod(options.paths.stderrLog, 0o600);
    const child = spawn(
      dependencies.execPath ?? process.execPath,
      [
        ...(dependencies.execArguments ?? process.execArgv),
        entryPath,
        "__run",
        options.instanceId,
      ],
      {
        detached: true,
        env: {
          ...environment,
          SEAT_MONITOR_SERVER_RUNTIME_DIR: options.paths.directory,
        },
        stdio: ["ignore", stdoutLog.fd, stderrLog.fd],
      },
    );
    if (child.pid === undefined) {
      throw new Error("Detached server process did not report a PID.");
    }
    child.unref();
    return child.pid;
  } finally {
    await stdoutLog.close();
    await stderrLog.close();
  }
}

function lifecycleDefaults(dependencies: LifecycleDependencies) {
  return {
    paths:
      dependencies.paths ??
      resolveServerRuntimePaths(dependencies.environment ?? process.env),
    now: dependencies.now ?? (() => new Date()),
    stdout: dependencies.stdout ?? process.stdout,
    stderr: dependencies.stderr ?? process.stderr,
    sleep: dependencies.sleep ?? sleep,
    isProcessAlive: dependencies.isProcessAlive ?? processIsAlive,
    fetchIdentity: dependencies.fetchIdentity ?? fetchIdentity,
    findExternalServer:
      dependencies.findExternalServer ?? (() => Promise.resolve(null)),
    sendSignal:
      dependencies.sendSignal ??
      ((pid: number, signal: NodeJS.Signals) => process.kill(pid, signal)),
  };
}

async function waitForProcessExit(
  pid: number,
  timeoutMilliseconds: number,
  isProcessAlive: (pid: number) => boolean,
  wait: (milliseconds: number) => Promise<void>,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      return true;
    }
    await wait(POLL_INTERVAL_MILLISECONDS);
  }
  return !isProcessAlive(pid);
}

export async function startDetachedServer(
  dependencies: LifecycleDependencies = {},
): Promise<number> {
  const runtime = lifecycleDefaults(dependencies);
  const existing = await readServerRuntimeState(runtime.paths);
  if (existing !== null) {
    if (
      runtime.isProcessAlive(existing.pid) &&
      (await runtime.fetchIdentity(existing))
    ) {
      runtime.stdout.write(
        `Seat Monitor is already running in background (pid: ${String(existing.pid)}) at ${existing.url}.\n`,
      );
      return 0;
    }
    if (runtime.isProcessAlive(existing.pid)) {
      runtime.stderr.write(
        `Refusing to replace unverified live server state for pid ${String(existing.pid)}.\n`,
      );
      return 1;
    }
    await clearServerRuntimeState(runtime.paths, existing.instanceId);
  }

  const instanceId = randomUUID();
  runtime.stdout.write(
    `Starting Seat Monitor in background; waiting up to ${String(
      (dependencies.startupTimeoutMilliseconds ??
        STARTUP_TIMEOUT_MILLISECONDS) / 1_000,
    )}s for readiness.\n`,
  );
  const launchedAt = runtime.now().getTime();
  const launchedPid = await (
    dependencies.launchDetached ??
    ((options) => launchDetached(options, dependencies))
  )({ instanceId, paths: runtime.paths });
  const deadline =
    Date.now() +
    (dependencies.startupTimeoutMilliseconds ?? STARTUP_TIMEOUT_MILLISECONDS);
  while (Date.now() < deadline) {
    const state = await readServerRuntimeState(runtime.paths);
    if (
      state?.instanceId === instanceId &&
      state.pid === launchedPid &&
      Date.parse(state.startedAt) >= launchedAt &&
      (await runtime.fetchIdentity(state))
    ) {
      runtime.stdout.write(
        `Seat Monitor started in background (pid: ${String(launchedPid)}) at ${state.url}.\nLogs: ${runtime.paths.stdoutLog} and ${runtime.paths.stderrLog}\n`,
      );
      return 0;
    }
    if (!runtime.isProcessAlive(launchedPid)) {
      break;
    }
    await runtime.sleep(POLL_INTERVAL_MILLISECONDS);
  }

  if (runtime.isProcessAlive(launchedPid)) {
    runtime.sendSignal(launchedPid, "SIGTERM");
  }
  await clearServerRuntimeState(runtime.paths, instanceId);
  runtime.stderr.write(
    `Seat Monitor did not acknowledge background startup. See ${runtime.paths.stderrLog}.\n`,
  );
  return 1;
}

export async function statusDetachedServer(
  dependencies: LifecycleDependencies = {},
): Promise<number> {
  const runtime = lifecycleDefaults(dependencies);
  const state = await readServerRuntimeState(runtime.paths);
  if (state === null) {
    const external = await runtime.findExternalServer();
    if (external !== null) {
      runtime.stdout.write(
        `Seat Monitor is running in externally managed foreground mode (pid: ${String(external.pid)}) at ${external.url} (version ${external.version}).\n`,
      );
      return 0;
    }
    runtime.stdout.write("Seat Monitor is not running in background.\n");
    return 1;
  }
  if (!runtime.isProcessAlive(state.pid)) {
    runtime.stderr.write(
      `Seat Monitor has stale background state for dead pid ${String(state.pid)}.\n`,
    );
    return 1;
  }
  if (!(await runtime.fetchIdentity(state))) {
    runtime.stderr.write(
      `Seat Monitor background identity could not be verified for pid ${String(state.pid)}.\n`,
    );
    return 1;
  }
  runtime.stdout.write(
    `Seat Monitor is running in background (pid: ${String(state.pid)}) at ${state.url}.\n`,
  );
  return 0;
}

export async function stopDetachedServer(
  dependencies: LifecycleDependencies = {},
): Promise<number> {
  const runtime = lifecycleDefaults(dependencies);
  const state = await readServerRuntimeState(runtime.paths);
  if (state === null) {
    runtime.stdout.write("Seat Monitor is not running in background.\n");
    return 0;
  }
  if (!runtime.isProcessAlive(state.pid)) {
    await clearServerRuntimeState(runtime.paths, state.instanceId);
    runtime.stdout.write("Seat Monitor is not running; cleared stale state.\n");
    return 0;
  }
  if (!(await runtime.fetchIdentity(state))) {
    runtime.stderr.write(
      `Refusing to stop pid ${String(state.pid)} because its Seat Monitor identity could not be verified.\n`,
    );
    return 1;
  }

  runtime.sendSignal(state.pid, "SIGTERM");
  let stopped = await waitForProcessExit(
    state.pid,
    dependencies.stopTimeoutMilliseconds ?? STOP_TIMEOUT_MILLISECONDS,
    runtime.isProcessAlive,
    runtime.sleep,
  );
  if (!stopped) {
    runtime.sendSignal(state.pid, "SIGKILL");
    stopped = await waitForProcessExit(
      state.pid,
      dependencies.killTimeoutMilliseconds ?? KILL_TIMEOUT_MILLISECONDS,
      runtime.isProcessAlive,
      runtime.sleep,
    );
  }
  if (!stopped) {
    runtime.stderr.write(
      `Seat Monitor process ${String(state.pid)} did not stop.\n`,
    );
    return 1;
  }
  await clearServerRuntimeState(runtime.paths, state.instanceId);
  runtime.stdout.write(`Seat Monitor stopped (pid: ${String(state.pid)}).\n`);
  return 0;
}

export async function restartDetachedServer(
  dependencies: LifecycleDependencies = {},
): Promise<number> {
  const stopped = await stopDetachedServer(dependencies);
  return stopped === 0 ? startDetachedServer(dependencies) : stopped;
}
