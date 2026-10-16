import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

import { z } from "zod";

import type { LoadedAccount } from "../config/accounts.js";
import {
  readClaudeAccountResets,
  type ClaudeAccountResets,
  type ClaudeResetOffer,
} from "./claude-resets.js";

export const CLAUDE_RESET_CHECK_INTERVAL_MILLISECONDS = 20 * 60_000;

const instantSchema = z.iso.datetime({ offset: true });
const entrySchema = z.object({
  identity: z.string(),
  lastAttemptAt: instantSchema,
  lastConfirmedAt: instantSchema.nullable(),
  status: z.enum(["ok", "rate_limited", "unavailable"]),
  offers: z.array(
    z.object({
      label: z.string(),
      count: z.number().int().nonnegative(),
      expiresAt: instantSchema.nullable(),
    }),
  ),
});
const fileSchema = z.object({
  version: z.literal(1),
  accounts: z.record(z.string(), entrySchema),
});
type CacheEntry = z.infer<typeof entrySchema>;

export type CachedClaudeAccountResets = ClaudeAccountResets & {
  lastConfirmedAt: string | null;
};

export function defaultClaudeResetCachePath(
  environment: NodeJS.ProcessEnv = process.env,
  homeDirectory = homedir(),
): string {
  const root =
    environment.XDG_STATE_HOME ?? join(homeDirectory, ".local", "state");
  if (!isAbsolute(root)) {
    throw new TypeError("The reset cache root must be an absolute path.");
  }
  return join(root, "seat-monitor", "claude-resets.json");
}

function identity(account: LoadedAccount): string {
  return account.auth.type === "claude_profile"
    ? `${account.auth.profile}\n${account.auth.expectedEmail.toLocaleLowerCase("en-US")}`
    : "";
}

function visible(
  accountAlias: string,
  entry: CacheEntry,
  nowMilliseconds: number,
): CachedClaudeAccountResets {
  return {
    accountAlias,
    status: entry.status,
    lastConfirmedAt: entry.lastConfirmedAt,
    offers: entry.offers.filter(
      (offer) =>
        offer.expiresAt === null ||
        Date.parse(offer.expiresAt) > nowMilliseconds,
    ),
  };
}

export function createClaudeResetReader(options: {
  accounts: readonly LoadedAccount[];
  verifiedAliases: () => Promise<ReadonlySet<string>>;
  now?: () => Date;
  filePath?: string;
  readOffer?: (account: LoadedAccount) => Promise<ClaudeAccountResets>;
}): () => Promise<CachedClaudeAccountResets[]> {
  const now = options.now ?? (() => new Date());
  const filePath = options.filePath ?? defaultClaudeResetCachePath();
  const readOffer =
    options.readOffer ??
    ((account: LoadedAccount) => readClaudeAccountResets(account, { now }));
  let entries: Record<string, CacheEntry> | null = null;
  let inFlight: Promise<CachedClaudeAccountResets[]> | null = null;

  async function load(): Promise<Record<string, CacheEntry>> {
    if (entries !== null) return entries;
    try {
      const parsed = fileSchema.parse(
        JSON.parse(await readFile(filePath, "utf8")) as unknown,
      );
      entries = parsed.accounts;
    } catch {
      entries = {};
    }
    return entries;
  }

  async function save(current: Record<string, CacheEntry>): Promise<void> {
    await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
    const temporary = `${filePath}.${String(process.pid)}.tmp`;
    await writeFile(
      temporary,
      `${JSON.stringify({ version: 1, accounts: current })}\n`,
      { mode: 0o600 },
    );
    await rename(temporary, filePath);
  }

  async function read(): Promise<CachedClaudeAccountResets[]> {
    const current = await load();
    const verified = await options.verifiedAliases();
    const nowMilliseconds = now().getTime();
    const attempted = new Set<string>();
    const output = await Promise.all(
      options.accounts
        .filter((account) => account.platform === "Claude")
        .map(async (account): Promise<CachedClaudeAccountResets> => {
          const accountAlias = account.accountAlias;
          if (!verified.has(accountAlias)) {
            return {
              accountAlias,
              status: "unavailable",
              offers: [],
              lastConfirmedAt: null,
            };
          }
          const accountIdentity = identity(account);
          const prior = current[accountAlias];
          if (
            prior?.identity === accountIdentity &&
            nowMilliseconds - Date.parse(prior.lastAttemptAt) <
              CLAUDE_RESET_CHECK_INTERVAL_MILLISECONDS
          ) {
            return visible(accountAlias, prior, nowMilliseconds);
          }

          const result = await readOffer(account);
          const lastConfirmedAt =
            result.status === "ok"
              ? new Date(nowMilliseconds).toISOString()
              : prior?.identity === accountIdentity
                ? (prior.lastConfirmedAt ?? null)
                : null;
          const offers: ClaudeResetOffer[] =
            result.status === "ok"
              ? result.offers
              : prior?.identity === accountIdentity
                ? prior.offers
                : [];
          const updated: CacheEntry = {
            identity: accountIdentity,
            lastAttemptAt: new Date(nowMilliseconds).toISOString(),
            lastConfirmedAt,
            status: result.status,
            offers,
          };
          current[accountAlias] = updated;
          attempted.add(accountAlias);
          return visible(accountAlias, updated, nowMilliseconds);
        }),
    );
    if (attempted.size > 0) await save(current);
    return output;
  }

  return () => {
    inFlight ??= read().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };
}
