import type { ChildProcess } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

export const isolatedProcessGroup = process.platform !== "win32";
const active = new Set<ChildProcess>();

/** Never include argv or environment in lifecycle diagnostics. */
export function killProcessGroup(child: ChildProcess): void {
  if (child.pid === undefined) return;
  try {
    if (isolatedProcessGroup) process.kill(-child.pid, "SIGKILL");
    else child.kill("SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
      process.stderr.write(
        `seat-monitor: process group cleanup failed pid=${String(child.pid)}\n`,
      );
    }
  }
}

function groupMembers(group: number): number[] {
  if (process.platform !== "linux") return [];
  const members: number[] = [];
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/u.test(name)) continue;
    try {
      const stat = readFileSync(`/proc/${name}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      // Zombies no longer hold resident memory and must be reaped by their parent.
      if (Number(fields[2]) === group && fields[0] !== "Z") {
        members.push(Number(name));
      }
    } catch {
      // A process can exit between directory enumeration and reading stat.
    }
  }
  return members;
}

/** Keep the concurrency slot until descendants have released their memory. */
export async function reapProcessGroup(child: ChildProcess): Promise<void> {
  killProcessGroup(child);
  if (child.pid === undefined) return;
  const deadline = Date.now() + 1_000;
  let members = groupMembers(child.pid);
  if (members.length > 0) {
    process.stderr.write(
      `seat-monitor: cleaning remaining process group pid=${String(child.pid)} members=${members.join(",")}\n`,
    );
  }
  while (members.length > 0 && Date.now() < deadline) {
    await delay(10);
    members = groupMembers(child.pid);
  }
  if (members.length > 0) {
    process.stderr.write(
      `seat-monitor: orphan processes remain pids=${members.join(",")}\n`,
    );
    throw new Error("Provider process group did not exit.");
  }
}

export function trackProcessGroup(child: ChildProcess): void {
  active.add(child);
  // Also clean up descendants when a wrapper exits normally or fails early.
  let drainTimer: NodeJS.Timeout | undefined;
  child.once("exit", () => {
    killProcessGroup(child);
    // An escaped descendant can retain inherited pipes even after the leader
    // and its group are gone. Do not let that defeat the command deadline.
    drainTimer = setTimeout(() => {
      process.stderr.write(
        `seat-monitor: orphan may hold provider pipes pid=${String(child.pid)}\n`,
      );
      child.stdin?.destroy();
      child.stdout?.destroy();
      child.stderr?.destroy();
    }, 1_000);
    drainTimer.unref();
  });
  child.once("close", () => {
    clearTimeout(drainTimer);
    active.delete(child);
  });
}

process.once("exit", () => {
  for (const child of active) killProcessGroup(child);
});

// Detached groups no longer receive the parent's terminal/supervisor signals.
// Preserve the server's own graceful-shutdown handlers and default CLI exits.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  const forward = () => {
    for (const child of active) killProcessGroup(child);
    if (process.listenerCount(signal) === 1) {
      process.removeListener(signal, forward);
      process.kill(process.pid, signal);
    }
  };
  process.on(signal, forward);
}
