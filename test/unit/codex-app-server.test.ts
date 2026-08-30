import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  CodexProtocolError,
  readCodexAppServer,
} from "../../src/services/codex-app-server.js";
import { ProcessTimeoutError } from "../../src/services/process.js";

async function executable(source: string): Promise<{
  command: string;
  cleanup: () => Promise<void>;
}> {
  const directory = await mkdtemp(join(tmpdir(), "seat-monitor-app-server-"));
  const command = join(directory, "fake-codex");
  await writeFile(command, `#!${process.execPath}\n${source}`, { mode: 0o700 });
  await chmod(command, 0o700);
  return {
    command,
    cleanup: () => rm(directory, { force: true, recursive: true }),
  };
}

const responder = String.raw`
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  const lines = input.split("\n");
  input = lines.pop() ?? "";
  for (const line of lines) {
    if (line.length === 0) continue;
    const message = JSON.parse(line);
    if (message.id === 1) {
      process.stdout.write(JSON.stringify({ id: 1, result: { account: "ok" } }) + "\n");
    }
    if (message.id === 2) {
      process.stdout.write(JSON.stringify({ id: 2, result: { limits: "ok" } }) + "\n");
    }
  }
});
`;

describe("Codex App Server transport", () => {
  it("completes the initialize, account, and rate-limit exchange", async () => {
    const fake = await executable(responder);
    try {
      await expect(
        readCodexAppServer({
          command: fake.command,
          environment: process.env,
          timeoutMilliseconds: 1_000,
        }),
      ).resolves.toEqual({
        accountResult: { account: "ok" },
        rateLimitsResult: { limits: "ok" },
      });
    } finally {
      await fake.cleanup();
    }
  });

  it("rejects malformed JSON from the provider", async () => {
    const fake = await executable('process.stdout.write("not-json\\n");');
    try {
      await expect(
        readCodexAppServer({
          command: fake.command,
          environment: process.env,
          timeoutMilliseconds: 1_000,
        }),
      ).rejects.toBeInstanceOf(CodexProtocolError);
    } finally {
      await fake.cleanup();
    }
  });

  it("rejects JSON-RPC error responses", async () => {
    const fake = await executable(
      'process.stdout.write(JSON.stringify({ id: 2, error: { code: -1 } }) + "\\n");',
    );
    try {
      await expect(
        readCodexAppServer({
          command: fake.command,
          environment: process.env,
          timeoutMilliseconds: 1_000,
        }),
      ).rejects.toMatchObject({ requestId: 2 });
    } finally {
      await fake.cleanup();
    }
  });

  it("kills an unresponsive App Server at the deadline", async () => {
    const fake = await executable("setInterval(() => {}, 1_000);");
    try {
      await expect(
        readCodexAppServer({
          command: fake.command,
          environment: process.env,
          timeoutMilliseconds: 20,
        }),
      ).rejects.toBeInstanceOf(ProcessTimeoutError);
    } finally {
      await fake.cleanup();
    }
  });
});
