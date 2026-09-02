import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(fileURLToPath(new URL("../", import.meta.url)));
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const temporaryDirectory = mkdtempSync(join(tmpdir(), "seat-monitor-package-"));
let tarballPath;

function run(command, arguments_, options = {}) {
  return execFileSync(command, arguments_, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    ...options,
  });
}

try {
  const packResult = JSON.parse(
    run(npmCommand, ["pack", "--json", "--silent"], { cwd: projectRoot }),
  );
  const packageResult = packResult[0];
  if (packageResult === undefined) {
    throw new Error("npm pack did not produce a package.");
  }
  tarballPath = join(projectRoot, packageResult.filename);

  const paths = packageResult.files.map((file) => file.path);
  const forbiddenPrefixes = ["src/", "test/", "docs/", ".github/"];
  const forbiddenFiles = [".env.op", "package-lock.json", "tsconfig.json"];
  const forbidden = paths.filter(
    (path) =>
      forbiddenPrefixes.some((prefix) => path.startsWith(prefix)) ||
      forbiddenFiles.includes(path),
  );
  if (forbidden.length > 0) {
    throw new Error(
      `Package contains forbidden files: ${forbidden.join(", ")}`,
    );
  }

  const required = [
    "dist/cli.js",
    "dist/server.js",
    "dist/public/index.html",
    "accounts.example.json",
    "settings.example.json",
    ".env.op.example",
    "README.md",
    "LICENSE",
  ];
  for (const requiredPath of required) {
    if (!paths.includes(requiredPath)) {
      throw new Error(`Package is missing ${requiredPath}.`);
    }
  }

  run(
    npmCommand,
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--prefix",
      temporaryDirectory,
      tarballPath,
    ],
    { cwd: temporaryDirectory },
  );

  const packageName = JSON.parse(
    readFileSync(join(projectRoot, "package.json"), "utf8"),
  ).name;
  const executableSuffix = process.platform === "win32" ? ".cmd" : "";
  for (const executable of [
    "seat-monitor",
    "seat-monitor-claude-login",
    "seat-monitor-codex-login",
  ]) {
    const output = run(
      join(
        temporaryDirectory,
        "node_modules",
        ".bin",
        `${executable}${executableSuffix}`,
      ),
      ["--help"],
    );
    if (!output.includes("Usage:")) {
      throw new Error(`${executable} did not produce help output.`);
    }
  }

  const initializedConfigPath = join(
    temporaryDirectory,
    "config",
    "accounts.json",
  );
  run(
    join(
      temporaryDirectory,
      "node_modules",
      ".bin",
      `seat-monitor${executableSuffix}`,
    ),
    ["--init-config"],
    {
      env: {
        ...process.env,
        SEAT_MONITOR_CONFIG: initializedConfigPath,
      },
    },
  );
  const initializedConfig = JSON.parse(
    readFileSync(initializedConfigPath, "utf8"),
  );
  if (!Array.isArray(initializedConfig.accounts)) {
    throw new Error("Installed CLI did not initialize account configuration.");
  }

  process.stdout.write(
    `Package smoke test passed: ${packageName} (${String(paths.length)} files, ${basename(tarballPath)}).\n`,
  );
} finally {
  if (tarballPath !== undefined) {
    rmSync(tarballPath, { force: true });
  }
  rmSync(temporaryDirectory, { force: true, recursive: true });
}
