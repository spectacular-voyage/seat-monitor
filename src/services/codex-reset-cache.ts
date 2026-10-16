import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { z } from "zod";

import type { LoadedAccount } from "../config/accounts.js";
import { resetOfferSchema, type QuotaSnapshot } from "../domain/quota.js";

const entrySchema = z.object({
  identity: z.string(),
  lastConfirmedAt: z.iso.datetime({ offset: true }),
  offers: z.array(resetOfferSchema),
});
const fileSchema = z.object({
  version: z.literal(1),
  accounts: z.record(z.string(), entrySchema),
});
type Entry = z.infer<typeof entrySchema>;
type Store = {
  load: () => Promise<Record<string, Entry>>;
  save: (entries: Record<string, Entry>) => Promise<void>;
};

const cacheFilePath = join(
  homedir(),
  ".local",
  "state",
  "seat-monitor",
  "codex-resets.json",
);

const fileStore: Store = {
  async load() {
    try {
      return fileSchema.parse(
        JSON.parse(await readFile(cacheFilePath, "utf8")) as unknown,
      ).accounts;
    } catch {
      return {};
    }
  },
  async save(entries) {
    await mkdir(dirname(cacheFilePath), { recursive: true, mode: 0o700 });
    const temporary = `${cacheFilePath}.${String(process.pid)}.tmp`;
    await writeFile(
      temporary,
      `${JSON.stringify({ version: 1, accounts: entries })}\n`,
      { mode: 0o600 },
    );
    await rename(temporary, cacheFilePath);
  },
};

export type CachedCodexResetOffers = {
  accountAlias: string;
  status: "ok" | "unavailable";
  offers: Entry["offers"];
  lastConfirmedAt: string | null;
};

function identity(account: LoadedAccount): string {
  return account.auth.type === "codex_profile"
    ? `profile\n${account.auth.profile}`
    : account.auth.type === "codex_access_token"
      ? `token\n${account.auth.credentialEnv}`
      : "";
}

export function createCodexResetReader(options: {
  accounts: readonly LoadedAccount[];
  snapshots: () => Promise<readonly QuotaSnapshot[]>;
  now?: () => Date;
  storage?: Store;
}): () => Promise<CachedCodexResetOffers[]> {
  const now = options.now ?? (() => new Date());
  const storage = options.storage ?? fileStore;
  let entries: Record<string, Entry> | null = null;
  let inFlight: Promise<CachedCodexResetOffers[]> | null = null;

  async function read(): Promise<CachedCodexResetOffers[]> {
    entries ??= await storage.load();
    const current = entries;
    const snapshots = new Map(
      (await options.snapshots()).map((snapshot) => [
        snapshot.accountAlias,
        snapshot,
      ]),
    );
    const nowMilliseconds = now().getTime();
    const changed = new Set<string>();
    const result = options.accounts
      .filter((account) => account.platform === "Codex")
      .map((account): CachedCodexResetOffers => {
        const accountAlias = account.accountAlias;
        const accountIdentity = identity(account);
        const prior = current[accountAlias];
        const snapshot = snapshots.get(accountAlias);
        const offers =
          snapshot?.platform === "Codex" && snapshot.status === "ok"
            ? snapshot.resetOffers
            : null;
        const confirmed = offers !== undefined && offers !== null;
        if (
          snapshot !== undefined &&
          confirmed &&
          (prior?.identity !== accountIdentity ||
            Date.parse(snapshot.observedAt) > Date.parse(prior.lastConfirmedAt))
        ) {
          current[accountAlias] = {
            identity: accountIdentity,
            lastConfirmedAt: snapshot.observedAt,
            offers,
          };
          changed.add(accountAlias);
        }
        const latest = current[accountAlias];
        const known = latest?.identity === accountIdentity ? latest : undefined;
        return {
          accountAlias,
          status: confirmed ? "ok" : "unavailable",
          lastConfirmedAt: known?.lastConfirmedAt ?? null,
          offers:
            known?.offers.filter(
              (offer) =>
                offer.expiresAt === null ||
                Date.parse(offer.expiresAt) > nowMilliseconds,
            ) ?? [],
        };
      });
    if (changed.size > 0) await storage.save(current);
    return result;
  }

  return () => {
    inFlight ??= read().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };
}
