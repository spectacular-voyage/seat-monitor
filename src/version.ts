import { readFileSync } from "node:fs";

type PackageMetadata = { version?: unknown };

const metadata = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as PackageMetadata;

if (
  typeof metadata.version !== "string" ||
  !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(metadata.version)
) {
  throw new TypeError("package.json contains an invalid package version.");
}

export const PACKAGE_VERSION = metadata.version;
