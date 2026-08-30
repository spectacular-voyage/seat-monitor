import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { AccountConfigurationError } from "./config/accounts.js";
import { toPublicSnapshots } from "./presentation/public-dto.js";
import { renderMarkdownTable } from "./presentation/table.js";
import {
  createDefaultScanner,
  type Scanner,
} from "./services/scan-accounts.js";

const usage = `Usage: seat-monitor [--format table|json] [--json]

Options:
  --format table|json  Select output format (default: table)
  --json               Alias for --format json
  --help               Show this help
`;

export type CliDependencies = {
  scan?: Scanner;
  now?: () => Date;
  stdout?: { write: (value: string) => unknown };
  stderr?: { write: (value: string) => unknown };
};

type OutputFormat = "table" | "json";

function parseFormat(
  arguments_: readonly string[],
): { help: true } | { help: false; format: OutputFormat } {
  const parsed = parseArgs({
    args: [...arguments_],
    allowPositionals: false,
    strict: true,
    options: {
      format: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
      json: { type: "boolean", default: false },
    },
  });

  if (parsed.values.help) {
    return { help: true };
  }
  if (parsed.values.json && parsed.values.format !== undefined) {
    throw new TypeError("--json cannot be combined with --format.");
  }

  const format = parsed.values.json
    ? "json"
    : (parsed.values.format ?? "table");
  if (format !== "table" && format !== "json") {
    throw new TypeError("--format must be table or json.");
  }
  return { help: false, format };
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

  let scan: Scanner;
  try {
    scan = dependencies.scan ?? createDefaultScanner();
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
    return 2;
  }

  const now = dependencies.now ?? (() => new Date());
  const output = toPublicSnapshots(snapshots, now().getTime());
  if (selection.format === "json") {
    stdout.write(`${JSON.stringify(output)}\n`);
  } else {
    stdout.write(renderMarkdownTable(output));
  }

  return snapshots.some((snapshot) => snapshot.status === "error") ? 1 : 0;
}

async function main(): Promise<void> {
  process.exitCode = await runCli(process.argv.slice(2));
}

const entryPoint = process.argv[1];
if (
  entryPoint !== undefined &&
  import.meta.url === pathToFileURL(entryPoint).href
) {
  await main();
}
