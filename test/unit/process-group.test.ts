import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { reapProcessGroup } from "../../src/services/process-group.js";
import { runCommand } from "../../src/services/process.js";

describe.skipIf(process.platform !== "linux")(
  "process group failure diagnostics",
  () => {
    it("refuses to release a slot when group cleanup leaves a live process", async () => {
      const child = spawn(
        process.execPath,
        ["-e", "setInterval(() => {}, 1000)"],
        { detached: true, stdio: "ignore" },
      );
      await once(child, "spawn");
      const closed = once(child, "close");
      const originalKill = process.kill.bind(process);
      const kill = vi
        .spyOn(process, "kill")
        .mockImplementation((pid, signal) => {
          if (pid === -child.pid!) return true; // Simulate an OS refusing cleanup.
          return originalKill(pid, signal);
        });
      const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
      try {
        await expect(reapProcessGroup(child)).rejects.toThrow("did not exit");
        expect(
          stderr.mock.calls.some(([line]) =>
            String(line).includes("orphan processes remain"),
          ),
        ).toBe(true);
      } finally {
        kill.mockRestore();
        stderr.mockRestore();
        originalKill(-child.pid!, "SIGKILL");
        await closed;
      }
    });

    it("bounds pipe draining and logs a descendant that escaped the group", async () => {
      const directory = await mkdtemp(join(tmpdir(), "seat-monitor-escaped-"));
      const file = join(directory, "pid");
      const source = `
      const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'inherit' });
      require('node:fs').writeFileSync(${JSON.stringify(file)}, String(child.pid));
      process.exit(0);
    `;
      const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
      try {
        await expect(
          runCommand({
            command: process.execPath,
            args: ["-e", source],
            environment: {},
            timeoutMilliseconds: 3_000,
          }),
        ).resolves.toMatchObject({ exitCode: 0 });
        expect(
          stderr.mock.calls.some(([line]) =>
            String(line).includes("orphan may hold provider pipes"),
          ),
        ).toBe(true);
      } finally {
        stderr.mockRestore();
        const pid = Number(await readFile(file, "utf8"));
        if (Number.isSafeInteger(pid) && pid > 0) process.kill(-pid, "SIGKILL");
        await rm(directory, { recursive: true, force: true });
      }
    });
  },
);
