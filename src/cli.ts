#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parseArgs } from "node:util";

import {
  AccountConfigurationError,
  defaultAccountsConfigPath,
} from "./config/accounts.js";
import { isMainModule } from "./entry-point.js";
import { createRecordingScanner } from "./history/recording-scanner.js";
import {
  createDefaultHistoryService,
  type HistoryService,
} from "./history/service.js";
import { toPublicSnapshots } from "./presentation/public-dto.js";
import { buildQuotaReport } from "./presentation/quota-report.js";
import { renderMarkdownReport } from "./presentation/table.js";
import { renderTextReport } from "./presentation/text-report.js";
import {
  createDefaultScanner,
  type Scanner,
} from "./services/scan-accounts.js";

const usage = `Usage: seat-monitor [--format text|md|json] [--json]
       seat-monitor --init-config

Options:
  --format text|md|json  Select output format (default: text)
  --json                 Alias for --format json
  --init-config          Create a private example accounts.json
  --help                 Show this help
`;

export type CliDependencies = {
  scan?: Scanner;
  now?: () => Date;
  timeZone?: string;
  stdout?: { write: (value: string) => unknown };
  stderr?: { write: (value: string) => unknown };
  initializeConfig?: () => Promise<string>;
  history?: HistoryService;
};

type OutputFormat = "text" | "md" | "json";

function parseFormat(
  arguments_: readonly string[],
):
  | { help: true }
  | { help: false; format: OutputFormat; initializeConfig: boolean } {
  const parsed = parseArgs({
    args: [...arguments_],
    allowPositionals: false,
    strict: true,
    options: {
      format: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
      "init-config": { type: "boolean", default: false },
      json: { type: "boolean", default: false },
    },
  });

  if (parsed.values.help) {
    return { help: true };
  }
  if (parsed.values.json && parsed.values.format !== undefined) {
    throw new TypeError("--json cannot be combined with --format.");
  }
  if (
    parsed.values["init-config"] &&
    (parsed.values.json || parsed.values.format !== undefined)
  ) {
    throw new TypeError("--init-config cannot be combined with output flags.");
  }

  const format = parsed.values.json ? "json" : (parsed.values.format ?? "text");
  if (format === "table") {
    return {
      help: false,
      format: "md",
      initializeConfig: parsed.values["init-config"],
    };
  }
  if (format !== "text" && format !== "md" && format !== "json") {
    throw new TypeError("--format must be text, md, or json.");
  }
  return {
    help: false,
    format,
    initializeConfig: parsed.values["init-config"],
  };
}

async function initializeAccountConfig(): Promise<string> {
  const filePath = defaultAccountsConfigPath();
  const example = await readFile(
    new URL("../accounts.example.json", import.meta.url),
  );
  await mkdir(dirname(filePath), { mode: 0o700, recursive: true });
  await writeFile(filePath, example, { flag: "wx", mode: 0o600 });
  return filePath;
}

export async function runCli(
  arguments_: readonly string[],
  dependencies: CliDependencies = {},
): Promise<number> {
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;

  let selection: ReturnType<typeof parseFormat>;
  try {
    selection = parseFormat(arguments_);
  } catch {
    stderr.write(usage);
    return 2;
  }

  if (selection.help) {
    stdout.write(usage);
    return 0;
  }

  if (selection.initializeConfig) {
    try {
      const filePath = await (
        dependencies.initializeConfig ?? initializeAccountConfig
      )();
      stdout.write(`Created account configuration at ${filePath}.\n`);
      return 0;
    } catch {
      stderr.write(
        "Account configuration could not be created; it may already exist.\n",
      );
      return 2;
    }
  }

  let scan: Scanner;
  let ownedHistory: HistoryService | null = null;
  try {
    const baseScan = dependencies.scan ?? createDefaultScanner();
    const history =
      dependencies.history ??
      (dependencies.scan === undefined
        ? (ownedHistory = createDefaultHistoryService(
            process.env,
            dependencies.now,
          ))
        : null);
    scan =
      history === null
        ? baseScan
        : createRecordingScanner({
            scan: baseScan,
            history,
            source: "cli",
            ...(dependencies.now === undefined
              ? {}
              : { now: dependencies.now }),
          });
  } catch (error) {
    const message =
      error instanceof AccountConfigurationError
        ? error.message
        : "Account configuration is invalid.";
    stderr.write(`${message}\n`);
    return 2;
  }

  let snapshots;
  try {
    snapshots = await scan();
  } catch {
    stderr.write("Quota scan failed before producing account results.\n");
    ownedHistory?.close();
    return 2;
  }
  ownedHistory?.close();

  const now = (dependencies.now ?? (() => new Date()))();
  const output = toPublicSnapshots(snapshots, now.getTime());
  if (selection.format === "json") {
    stdout.write(`${JSON.stringify(output)}\n`);
  } else {
    const report = buildQuotaReport(output, {
      nowMilliseconds: now.getTime(),
      timeZone:
        dependencies.timeZone ??
        Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
    stdout.write(
      selection.format === "md"
        ? renderMarkdownReport(report)
        : renderTextReport(report),
    );
  }

  return snapshots.some((snapshot) => snapshot.status === "error") ? 1 : 0;
}

async function main(): Promise<void> {
  process.exitCode = await runCli(process.argv.slice(2));
}

if (isMainModule(import.meta.url)) {
  await main();
}
