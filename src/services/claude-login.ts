import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";

import type { LoadedClaudeProfileAccount } from "../config/accounts.js";
import { minimalChildEnvironment, ProcessSpawnError } from "./process.js";

export type RunInteractiveClaudeCommand = (options: {
  command: string;
  args: readonly string[];
  environment: NodeJS.ProcessEnv;
}) => Promise<number | null>;

export const runInteractiveClaudeCommand: RunInteractiveClaudeCommand = async (
  options,
) =>
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

export async function loginClaudeProfile(
  account: LoadedClaudeProfileAccount,
  options: {
    command?: string;
    run?: RunInteractiveClaudeCommand;
  } = {},
): Promise<string> {
  await mkdir(account.auth.claudeConfigDir, { mode: 0o700, recursive: true });
  await chmod(account.auth.claudeConfigDir, 0o700);

  const exitCode = await (options.run ?? runInteractiveClaudeCommand)({
    command: options.command ?? "claude",
    args: ["auth", "login", "--claudeai"],
    environment: minimalChildEnvironment({
      CLAUDE_CONFIG_DIR: account.auth.claudeConfigDir,
      DISABLE_AUTOUPDATER: "1",
    }),
  });
  if (exitCode !== 0) {
    throw new Error("Claude login did not complete successfully.");
  }

  const credentialsPath = join(
    account.auth.claudeConfigDir,
    ".credentials.json",
  );
  await access(credentialsPath, constants.R_OK | constants.W_OK);
  await chmod(credentialsPath, 0o600);
  return credentialsPath;
}
