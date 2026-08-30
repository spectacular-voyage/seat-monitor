import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";

import type { LoadedCodexProfileAccount } from "../config/accounts.js";
import { minimalChildEnvironment, ProcessSpawnError } from "./process.js";

export type RunInteractiveCommand = (options: {
  command: string;
  args: readonly string[];
  environment: NodeJS.ProcessEnv;
}) => Promise<number | null>;

export const runInteractiveCommand: RunInteractiveCommand = async (options) =>
  new Promise<number | null>((resolve, reject) => {
    const child = spawn(options.command, [...options.args], {
      env: options.environment,
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", (error: NodeJS.ErrnoException) => {
      reject(new ProcessSpawnError(error));
    });
    child.once("close", resolve);
  });

export async function loginCodexProfile(
  account: LoadedCodexProfileAccount,
  options: {
    command?: string;
    run?: RunInteractiveCommand;
  } = {},
): Promise<string> {
  await mkdir(account.auth.codexHome, { mode: 0o700, recursive: true });
  await chmod(account.auth.codexHome, 0o700);

  const exitCode = await (options.run ?? runInteractiveCommand)({
    command: options.command ?? "codex",
    args: ["-c", 'cli_auth_credentials_store="file"', "login"],
    environment: minimalChildEnvironment({
      CODEX_HOME: account.auth.codexHome,
    }),
  });
  if (exitCode !== 0) {
    throw new Error("Codex login did not complete successfully.");
  }

  const authPath = join(account.auth.codexHome, "auth.json");
  await access(authPath, constants.R_OK | constants.W_OK);
  await chmod(authPath, 0o600);
  return authPath;
}
