import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import {
  loadConfiguredAccounts,
  type LoadedClaudeProfileAccount,
} from "./config/accounts.js";
import { loginClaudeProfile } from "./services/claude-login.js";

const usage = `Usage: npm run claude:login -- <accountAlias>
       npm run claude:login -- --list

Create or refresh the isolated Claude subscription login used by one account.
`;

function profileAccounts(): LoadedClaudeProfileAccount[] {
  return loadConfiguredAccounts().filter(
    (account): account is LoadedClaudeProfileAccount =>
      account.platform === "Claude" && account.auth.type === "claude_profile",
  );
}

export async function runClaudeLoginCli(
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

  let accounts: LoadedClaudeProfileAccount[];
  try {
    accounts = profileAccounts();
  } catch {
    stderr.write("Account configuration is invalid.\n");
    return 2;
  }

  if (parsed.values.list) {
    for (const account of accounts) {
      stdout.write(
        `${account.accountAlias}\t${account.auth.claudeConfigDir}\n`,
      );
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
    stderr.write(`No enabled Claude profile account matches ${alias}.\n`);
    return 2;
  }

  stdout.write(
    `Signing in ${account.accountAlias}. Confirm the intended Claude account in the browser.\n`,
  );
  try {
    const credentialsPath = await loginClaudeProfile(account);
    stdout.write(`Claude profile ready at ${credentialsPath}.\n`);
    return 0;
  } catch {
    stderr.write("Claude profile login failed.\n");
    return 1;
  }
}

async function main(): Promise<void> {
  process.exitCode = await runClaudeLoginCli(process.argv.slice(2));
}

const entryPoint = process.argv[1];
if (
  entryPoint !== undefined &&
  import.meta.url === pathToFileURL(entryPoint).href
) {
  await main();
}
