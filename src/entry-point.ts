import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function isMainModule(moduleUrl: string): boolean {
  const entryPoint = process.argv[1];
  if (entryPoint === undefined) {
    return false;
  }
  try {
    return moduleUrl === pathToFileURL(realpathSync(entryPoint)).href;
  } catch {
    return false;
  }
}
