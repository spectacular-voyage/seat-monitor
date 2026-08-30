import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import {
  loadConfiguredAccounts,
  type LoadedCodexProfileAccount,
} from "./config/accounts.js";
import { loginCodexProfile } from "./services/codex-login.js";

const usage = `Usage: npm run codex:login -- <accountAlias>
       npm run codex:login -- --list

Create or refresh the isolated ChatGPT login used by one Codex account.
`;

function profileAccounts(): LoadedCodexProfileAccount[] {
  return loadConfiguredAccounts().filter(
    (account): account is LoadedCodexProfileAccount =>
      account.platform === "Codex" && account.auth.type === "codex_profile",
  );
}

export async function runCodexLoginCli(
  arguments_: readonly string[],
  writers: {
    stdout?: { write: (value: string) => unknown };
    stderr?: { write: (value: string) => unknown };
  } = {},
): Promise<number> {
  const stdout = writers.stdout ?? process.stdout;
  const stderr = writers.stderr ?? process.stderr;

  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: [...arguments_],
      allowPositionals: true,
      strict: true,
      options: {
        help: { type: "boolean", short: "h", default: false },
        list: { type: "boolean", default: false },
      },
    });
  } catch {
    stderr.write(usage);
    return 2;
  }

  if (parsed.values.help) {
    stdout.write(usage);
    return 0;
  }

  let accounts: LoadedCodexProfileAccount[];
  try {
    accounts = profileAccounts();
  } catch {
    stderr.write("Account configuration is invalid.\n");
    return 2;
  }

  if (parsed.values.list) {
    for (const account of accounts) {
      stdout.write(`${account.accountAlias}\t${account.auth.codexHome}\n`);
    }
    return 0;
  }

  const alias = parsed.positionals[0];
  if (alias === undefined || parsed.positionals.length !== 1) {
    stderr.write(usage);
    return 2;
  }

  const account = accounts.find(
    (candidate) => candidate.accountAlias === alias,
  );
  if (account === undefined) {
    stderr.write(`No enabled Codex profile account matches ${alias}.\n`);
    return 2;
  }

  stdout.write(
    `Signing in ${account.accountAlias}. Confirm the intended ChatGPT account in the browser.\n`,
  );
  try {
    const authPath = await loginCodexProfile(account);
    stdout.write(`Codex profile ready at ${authPath}.\n`);
    return 0;
  } catch {
    stderr.write("Codex profile login failed.\n");
    return 1;
  }
}

async function main(): Promise<void> {
  process.exitCode = await runCodexLoginCli(process.argv.slice(2));
}

const entryPoint = process.argv[1];
if (
  entryPoint !== undefined &&
  import.meta.url === pathToFileURL(entryPoint).href
) {
  await main();
}
