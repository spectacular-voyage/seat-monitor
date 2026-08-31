import { readFile } from "node:fs/promises";

const packageMetadata = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);
const versionOptionIndex = process.argv.indexOf("--version");
const requestedVersion =
  versionOptionIndex === -1 ? undefined : process.argv[versionOptionIndex + 1];
if (versionOptionIndex !== -1 && requestedVersion === undefined) {
  throw new TypeError("--version requires a value.");
}
const version = requestedVersion ?? packageMetadata.version;
if (
  typeof version !== "string" ||
  !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)
) {
  throw new TypeError("package.json contains an invalid release version.");
}

const noteUrl = new URL(
  `../docs/notes/release-notes.v${version}.md`,
  import.meta.url,
);
const source = await readFile(noteUrl, "utf8");
if (!source.startsWith("---\n")) {
  throw new TypeError("Release notes must contain Dendron frontmatter.");
}
const frontmatterEnd = source.indexOf("\n---\n", 4);
if (frontmatterEnd === -1) {
  throw new TypeError("Release-note frontmatter is not terminated.");
}
const body = source.slice(frontmatterEnd + 5).trim();
if (!body.startsWith(`# Seat Monitor v${version}\n`)) {
  throw new TypeError(
    `Release notes must start with # Seat Monitor v${version}.`,
  );
}

if (process.argv.includes("--body")) {
  process.stdout.write(`${body}\n`);
} else {
  process.stdout.write(`Release notes verified: ${noteUrl.pathname}\n`);
}
