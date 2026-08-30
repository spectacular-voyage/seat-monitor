import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

import { z } from "zod";

import {
  ProcessOutputError,
  ProcessSpawnError,
  ProcessTimeoutError,
} from "./process.js";

const MAX_OUTPUT_BYTES = 1_000_000;

const rpcMessageSchema = z.looseObject({
  id: z.number().int().optional(),
  result: z.unknown().optional(),
  error: z.unknown().optional(),
});

export class CodexProtocolError extends Error {
  public readonly requestId: number | undefined;

  public constructor(requestId?: number) {
    super("Codex App Server returned a protocol error.");
    this.name = "CodexProtocolError";
    this.requestId = requestId;
  }
}

export type CodexAppServerResult = {
  accountResult: unknown;
  rateLimitsResult: unknown;
};

export type ReadCodexAppServer = (options: {
  command: string;
  environment: NodeJS.ProcessEnv;
  timeoutMilliseconds: number;
}) => Promise<CodexAppServerResult>;

export const readCodexAppServer: ReadCodexAppServer = async (options) =>
  new Promise<CodexAppServerResult>((resolve, reject) => {
    const child = spawn(options.command, ["app-server", "--stdio"], {
      env: options.environment,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const lines = createInterface({ input: child.stdout });

    let settled = false;
    let outputBytes = 0;
    let accountReceived = false;
    let limitsReceived = false;
    let accountResult: unknown;
    let rateLimitsResult: unknown;

    const timer = setTimeout(() => {
      finishWithError(new ProcessTimeoutError());
    }, options.timeoutMilliseconds);

    function cleanup(): void {
      clearTimeout(timer);
      lines.close();
      child.stdin.end();
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
    }

    function finishWithError(error: Error): void {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    }

    function finishWithSuccess(): void {
      if (settled || !accountReceived || !limitsReceived) {
        return;
      }
      settled = true;
      cleanup();
      resolve({ accountResult, rateLimitsResult });
    }

    child.stdout.on("data", (chunk: Buffer) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > MAX_OUTPUT_BYTES) {
        finishWithError(new ProcessOutputError());
      }
    });
    child.stderr.resume();

    lines.on("line", (line) => {
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        finishWithError(new CodexProtocolError());
        return;
      }

      const parsed = rpcMessageSchema.safeParse(message);
      if (!parsed.success || parsed.data.id === undefined) {
        return;
      }
      if (parsed.data.error !== undefined) {
        finishWithError(new CodexProtocolError(parsed.data.id));
        return;
      }

      if (parsed.data.id === 1) {
        accountReceived = true;
        accountResult = parsed.data.result;
      } else if (parsed.data.id === 2) {
        limitsReceived = true;
        rateLimitsResult = parsed.data.result;
      }
      finishWithSuccess();
    });

    child.stdin.once("error", () => {
      finishWithError(new CodexProtocolError());
    });
    child.once("error", (error: NodeJS.ErrnoException) => {
      finishWithError(new ProcessSpawnError(error));
    });
    child.once("close", () => {
      if (!settled) {
        finishWithError(new CodexProtocolError());
      }
    });

    const messages = [
      {
        method: "initialize",
        id: 0,
        params: {
          clientInfo: {
            name: "seat_monitor",
            title: "Seat Monitor",
            version: "0.1.0",
          },
        },
      },
      { method: "initialized", params: {} },
      { method: "account/read", id: 1, params: { refreshToken: false } },
      { method: "account/rateLimits/read", id: 2 },
    ];

    for (const message of messages) {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    }
  });
