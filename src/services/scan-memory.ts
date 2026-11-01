import { readdirSync, readFileSync } from "node:fs";
import type { Scanner } from "./scan-accounts.js";

// Decimal MB, deliberately stricter than 500 MiB. This is an acceptance budget,
// not a heap cap: provider output and account coverage are never truncated.
export const SCAN_MEMORY_BUDGET_BYTES = 500_000_000;
export const MEMORY_SAMPLE_INTERVAL_MS = 10;

type ProcessReading = {
  pid: number;
  parentPid: number;
  startTime: string;
  role: string;
  rssBytes: number;
  highWaterBytes: number;
};
export type ScanMemoryReport = {
  supported: boolean;
  sampleIntervalMs: number;
  samples: number;
  peakRssBytes: number;
  maxChildren: number;
  peakCgroupBytes: number | null;
  cgroupAtPeak: {
    anonymousBytes: number;
    fileBytes: number;
    kernelBytes: number;
  } | null;
  peakProcesses: ProcessReading[];
  processes: (ProcessReading & { peakRssBytes: number })[];
  remainingChildren: number[];
};

function readProcess(pid: number, rootPid: number): ProcessReading | null {
  try {
    const stat = readFileSync(`/proc/${String(pid)}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    if (fields[0] === "Z") return null;
    const status = readFileSync(`/proc/${String(pid)}/status`, "utf8");
    const argv = readFileSync(`/proc/${String(pid)}/cmdline`, "utf8");
    const role =
      pid === rootPid
        ? "server"
        : argv.includes("/usage")
          ? "claude-usage"
          : argv.includes("auth\0status")
            ? "claude-auth"
            : argv.includes("app-server")
              ? "codex-app-server"
              : argv.includes("login")
                ? "login"
                : "helper";
    const bytes = (key: string) =>
      Number(new RegExp(`^${key}:\\s+(\\d+)`, "mu").exec(status)?.[1] ?? 0) *
      1024;
    return {
      pid,
      parentPid: Number(fields[1]),
      startTime: fields[19] ?? "",
      role,
      rssBytes: bytes("VmRSS"),
      highWaterBytes: bytes("VmHWM"),
    };
  } catch {
    return null; // Normal race with process exit.
  }
}

/** Sample the whole descendant tree, retaining known PIDs after reparenting.
 * argv is classified locally; no command lines, identities or credentials leave here.
 * RSS sums shared pages conservatively. Shorter-than-interval processes may be missed.
 */
export function startProcessMemoryMonitor(rootPid = process.pid): {
  stop: () => ScanMemoryReport;
} {
  const report: ScanMemoryReport = {
    supported: process.platform === "linux",
    sampleIntervalMs: MEMORY_SAMPLE_INTERVAL_MS,
    samples: 0,
    peakRssBytes: 0,
    maxChildren: 0,
    peakCgroupBytes: null,
    cgroupAtPeak: null,
    peakProcesses: [],
    processes: [],
    remainingChildren: [],
  };
  const records = new Map<string, ProcessReading & { peakRssBytes: number }>();
  let living: ProcessReading[] = [];
  let cgroupDirectory: string | null = null;
  try {
    const path = readFileSync(`/proc/${String(rootPid)}/cgroup`, "utf8")
      .split("\n")
      .find((line) => line.startsWith("0::"))
      ?.slice(3);
    if (path?.startsWith("/") && !path.split("/").includes(".."))
      cgroupDirectory = `/sys/fs/cgroup${path}`;
  } catch {
    /* Not cgroup v2. */
  }
  function sample(): void {
    if (!report.supported) return;
    const queue = [rootPid, ...living.map((row) => row.pid)];
    const visited = new Set<number>();
    const current: ProcessReading[] = [];
    for (const pid of queue) {
      if (visited.has(pid)) continue;
      visited.add(pid);
      const reading = readProcess(pid, rootPid);
      if (reading === null) continue;
      const priorLiving = living.find((row) => row.pid === pid);
      if (
        priorLiving !== undefined &&
        priorLiving.startTime !== reading.startTime
      )
        continue;
      current.push(reading);
      const key = `${String(pid)}:${reading.startTime}`;
      const prior = records.get(key);
      records.set(key, {
        ...reading,
        role:
          reading.role === "helper"
            ? (prior?.role ?? reading.role)
            : reading.role,
        peakRssBytes: Math.max(prior?.peakRssBytes ?? 0, reading.rssBytes),
        highWaterBytes: Math.max(
          prior?.highWaterBytes ?? 0,
          reading.highWaterBytes,
        ),
      });
      try {
        // Native providers can spawn children from any thread, not only the
        // thread-group leader (notably Codex's runtime worker threads).
        for (const tid of readdirSync(`/proc/${String(pid)}/task`)) {
          try {
            const children = readFileSync(
              `/proc/${String(pid)}/task/${tid}/children`,
              "utf8",
            ).trim();
            if (children) queue.push(...children.split(/\s+/u).map(Number));
          } catch {
            /* Thread exited. */
          }
        }
      } catch {
        /* Exited during sample. */
      }
    }
    if (cgroupDirectory !== null) {
      try {
        // Do not attribute a shared login session's memory to this server.
        const members = readFileSync(`${cgroupDirectory}/cgroup.procs`, "utf8")
          .trim()
          .split(/\s+/u)
          .map(Number);
        if (
          members.includes(rootPid) &&
          members.every((pid) => visited.has(pid))
        ) {
          const bytes = Number(
            readFileSync(`${cgroupDirectory}/memory.current`, "utf8"),
          );
          if (bytes > (report.peakCgroupBytes ?? 0)) {
            report.peakCgroupBytes = bytes;
            const stat = readFileSync(`${cgroupDirectory}/memory.stat`, "utf8");
            const value = (key: string) =>
              Number(new RegExp(`^${key} (\\d+)$`, "mu").exec(stat)?.[1] ?? 0);
            report.cgroupAtPeak = {
              anonymousBytes: value("anon"),
              fileBytes: value("file"),
              kernelBytes: value("kernel"),
            };
          }
        }
      } catch {
        /* No readable dedicated cgroup. */
      }
    }
    living = current;
    report.samples += 1;
    const rss = current.reduce((sum, row) => sum + row.rssBytes, 0);
    if (rss > report.peakRssBytes) {
      report.peakRssBytes = rss;
      report.peakProcesses = current;
    }
    report.maxChildren = Math.max(
      report.maxChildren,
      current.filter((row) => row.pid !== rootPid).length,
    );
  }
  sample();
  const timer = setInterval(sample, MEMORY_SAMPLE_INTERVAL_MS);
  timer.unref();
  return {
    stop() {
      clearInterval(timer);
      sample();
      report.processes = [...records.values()];
      report.remainingChildren = living
        .filter((row) => row.pid !== rootPid)
        .map((row) => row.pid);
      return report;
    },
  };
}

export function assertScanMemoryBudget(
  report: ScanMemoryReport,
  budgetBytes = SCAN_MEMORY_BUDGET_BYTES,
): void {
  if (!report.supported || report.samples === 0 || report.peakRssBytes === 0)
    throw new Error(
      "Process-tree memory measurement is unavailable (Linux /proc required).",
    );
  if (report.peakRssBytes > budgetBytes)
    throw new Error(
      `Full scan peak ${String(report.peakRssBytes)} bytes exceeds budget ${String(budgetBytes)} bytes.`,
    );
  if (report.remainingChildren.length > 0)
    throw new Error("Provider children remain after the full scan.");
}

export function withScanMemoryLog(scan: Scanner): Scanner {
  return async () => {
    const monitor = startProcessMemoryMonitor();
    let accounts = 0;
    try {
      const snapshots = await scan();
      accounts = snapshots.length;
      return snapshots;
    } finally {
      const memory = monitor.stop();
      process.stderr.write(
        `${JSON.stringify({ event: "scan-memory", accounts, budgetBytes: SCAN_MEMORY_BUDGET_BYTES, overBudget: memory.peakRssBytes > SCAN_MEMORY_BUDGET_BYTES, ...memory })}\n`,
      );
    }
  };
}
