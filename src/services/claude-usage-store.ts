import { mkdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { z } from "zod";

import { quotaLimitSchema, type QuotaLimit } from "../domain/quota.js";
import { readJsonFile } from "./provider-http.js";

/**
 * The last successful Claude quota reading per profile, kept on disk so a
 * restarted server can answer an Anthropic 429 with it instead of failing the
 * account. Only normalized limits are stored: no tokens, emails or paths (each
 * entry is keyed by a hash of the profile directory and expected email).
 */
export type ClaudeUsageStoreEntry = {
  observedAt: string;
  ultraPlan: boolean;
  limits: QuotaLimit[];
};

export type ClaudeUsageStore = {
  load: () => Promise<Map<string, ClaudeUsageStoreEntry>>;
  save: (entries: ReadonlyMap<string, ClaudeUsageStoreEntry>) => Promise<void>;
};

// A reading older than the longest Claude window describes no current window.
const MAXIMUM_RESTORED_AGE_MILLISECONDS = 7 * 86_400_000;

const fileSchema = z.object({
  version: z.literal(1),
  accounts: z.record(
    z.string().regex(/^[0-9a-f]{64}$/u),
    z.object({
      observedAt: z.iso.datetime({ offset: true }),
      ultraPlan: z.boolean(),
      limits: z.array(quotaLimitSchema).min(1),
    }),
  ),
});

export const DEFAULT_CLAUDE_USAGE_STORE_PATH = join(
  homedir(),
  ".local",
  "state",
  "seat-monitor",
  "claude-usage.json",
);

export function createClaudeUsageFileStore(
  options: { filePath?: string; now?: () => Date } = {},
): ClaudeUsageStore {
  const filePath = options.filePath ?? DEFAULT_CLAUDE_USAGE_STORE_PATH;
  const now = options.now ?? (() => new Date());
  return {
    async load() {
      const entries = new Map<string, ClaudeUsageStoreEntry>();
      let parsed: z.infer<typeof fileSchema>;
      try {
        parsed = fileSchema.parse(await readJsonFile(filePath));
      } catch {
        // Missing, oversized or malformed: start empty, as before restarts.
        return entries;
      }
      const nowMilliseconds = now().getTime();
      for (const [key, entry] of Object.entries(parsed.accounts)) {
        const age = nowMilliseconds - Date.parse(entry.observedAt);
        if (age >= 0 && age <= MAXIMUM_RESTORED_AGE_MILLISECONDS) {
          entries.set(key, entry);
        }
      }
      return entries;
    },
    async save(entries) {
      await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
      const temporary = `${filePath}.${String(process.pid)}.tmp`;
      await writeFile(
        temporary,
        `${JSON.stringify({ version: 1, accounts: Object.fromEntries(entries) })}\n`,
        { mode: 0o600 },
      );
      await rename(temporary, filePath);
    },
  };
}
