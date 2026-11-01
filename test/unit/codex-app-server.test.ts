import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  CodexProtocolError,
  readCodexAppServer,
} from "../../src/services/codex-app-server.js";
import {
  ProcessOutputError,
  ProcessSpawnError,
  ProcessTimeoutError,
} from "../../src/services/process.js";

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

describe.skipIf(process.platform !== "linux")(
  "Codex wrapper descendants",
  () => {
    it.each(["success", "protocol", "timeout"])(
      "waits for descendants on %s",
      async (mode) => {
        const directory = await mkdtemp(
          join(tmpdir(), "seat-monitor-codex-child-"),
        );
        const pidFile = join(directory, "pid");
        const source = `
      const { spawn } = require('node:child_process');
      const { writeFileSync } = require('node:fs');
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });
      writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
      ${mode === "success" ? responder : mode === "protocol" ? 'process.stdout.write("bad\\n");' : "setInterval(() => {}, 1000);"}
    `;
        const fake = await executable(source);
        try {
          const result = readCodexAppServer({
            command: fake.command,
            environment: process.env,
            timeoutMilliseconds: 500,
          });
          if (mode === "success")
            await expect(result).resolves.toHaveProperty("accountResult");
          else
            await expect(result).rejects.toBeInstanceOf(
              mode === "timeout" ? ProcessTimeoutError : CodexProtocolError,
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
          await fake.cleanup();
          await rm(directory, { recursive: true, force: true });
        }
      },
    );
  },
);

describe("Codex transport limits", () => {
  it("rejects a missing executable after close", async () => {
    await expect(
      readCodexAppServer({
        command: "/definitely/missing/codex",
        environment: {},
        timeoutMilliseconds: 1_000,
      }),
    ).rejects.toBeInstanceOf(ProcessSpawnError);
  });
  it("bounds stderr as well as stdout", async () => {
    const fake = await executable(
      'process.stderr.write("x".repeat(1100000)); setInterval(() => {}, 1000);',
    );
    try {
      await expect(
        readCodexAppServer({
          command: fake.command,
          environment: process.env,
          timeoutMilliseconds: 1_000,
        }),
      ).rejects.toBeInstanceOf(ProcessOutputError);
    } finally {
      await fake.cleanup();
    }
  });
});
