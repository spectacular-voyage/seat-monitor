import { spawn } from "node:child_process";

const MAX_OUTPUT_BYTES = 1_000_000;

export class ProcessTimeoutError extends Error {
  public constructor() {
    super("Provider command timed out.");
    this.name = "ProcessTimeoutError";
  }
}

export class ProcessSpawnError extends Error {
  public readonly code: string | undefined;

  public constructor(error: NodeJS.ErrnoException) {
    super("Provider command could not be started.");
    this.name = "ProcessSpawnError";
    this.code = error.code;
  }
}

export class ProcessOutputError extends Error {
  public constructor() {
    super("Provider command emitted too much output.");
    this.name = "ProcessOutputError";
  }
}

export type CommandResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
};

export type RunCommand = (options: {
  command: string;
  args: readonly string[];
  environment: NodeJS.ProcessEnv;
  timeoutMilliseconds: number;
}) => Promise<CommandResult>;

export function minimalChildEnvironment(
  additions: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const allowedKeys = [
    "PATH",
    "HOME",
    "USERPROFILE",
    "SystemRoot",
    "WINDIR",
    "TMPDIR",
    "TEMP",
    "TMP",
    "LANG",
    "LC_ALL",
    "SSL_CERT_FILE",
    "NODE_EXTRA_CA_CERTS",
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "NO_PROXY",
  ] as const;

  const environment: NodeJS.ProcessEnv = {};
  for (const key of allowedKeys) {
    const value = process.env[key];
    if (value !== undefined) {
      environment[key] = value;
    }
  }

  return {
    ...environment,
    NO_COLOR: "1",
    TERM: "dumb",
    ...additions,
  };
}

export const runCommand: RunCommand = async (options) =>
  new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(options.command, [...options.args], {
      env: options.environment,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let outputExceeded = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMilliseconds);

    const append = (current: string, chunk: Buffer): string => {
      const next = current + chunk.toString("utf8");
      if (Buffer.byteLength(next, "utf8") > MAX_OUTPUT_BYTES) {
        outputExceeded = true;
        child.kill("SIGKILL");
      }
      return next;
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });

    child.once("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(new ProcessSpawnError(error));
    });

    child.once("close", (exitCode) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new ProcessTimeoutError());
        return;
      }
      if (outputExceeded) {
        reject(new ProcessOutputError());
        return;
      }
      resolve({ exitCode, stdout, stderr });
    });
  });
