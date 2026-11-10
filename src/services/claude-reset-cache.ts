import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { z } from "zod";

import type { LoadedAccount } from "../config/accounts.js";
import {
  claudeResetIneligibleReasonSchema,
  readClaudeAccountResets,
  type ClaudeAccountResets,
} from "./claude-resets.js";

export const CLAUDE_RESET_CHECK_INTERVAL_MILLISECONDS = 20 * 60_000;
export const CLAUDE_RESET_FLEET_GAP_MILLISECONDS = 60_000;
export const CLAUDE_RESET_RATE_LIMITED_GAP_MILLISECONDS = 60 * 60_000;
export const CLAUDE_RESET_QUIET_PROBE_MILLISECONDS = 15 * 60_000;

const instantSchema = z.iso.datetime({ offset: true });
const entrySchema = z.object({
  identity: z.string(),
  lastAttemptAt: instantSchema,
  lastConfirmedAt: instantSchema.nullable(),
  status: z.enum(["ok", "rate_limited", "overloaded", "unavailable"]),
  httpStatus: z.number().int().min(100).max(599).nullable().optional(),
  ineligibleReason: claudeResetIneligibleReasonSchema.nullable().optional(),
  reason: z
    .enum([
      "surface",
      "cli_version",
      "ineligible",
      "missing_reset_block",
      "invalid_response",
      "credential_unavailable",
      "network_error",
    ])
    .nullable()
    .optional(),
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
type CacheStore = {
  load: () => Promise<Record<string, CacheEntry>>;
  save: (entries: Record<string, CacheEntry>) => Promise<void>;
};

export type CachedClaudeAccountResets = Omit<ClaudeAccountResets, "status"> & {
  status: ClaudeAccountResets["status"] | "pending";
  lastConfirmedAt: string | null;
  quietUntil?: string;
};

const cacheFilePath = join(
  homedir(),
  ".local",
  "state",
  "seat-monitor",
  "claude-resets.json",
);

const fileStore: CacheStore = {
  async load() {
    try {
      const parsed = fileSchema.parse(
        JSON.parse(await readFile(cacheFilePath, "utf8")) as unknown,
      );
      return parsed.accounts;
    } catch {
      return {};
    }
  },
  async save(current) {
    await mkdir(dirname(cacheFilePath), { recursive: true, mode: 0o700 });
    const temporary = `${cacheFilePath}.${String(process.pid)}.tmp`;
    await writeFile(
      temporary,
      `${JSON.stringify({ version: 1, accounts: current })}\n`,
      { mode: 0o600 },
    );
    await rename(temporary, cacheFilePath);
  },
};

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
    ...(entry.httpStatus === undefined || entry.httpStatus === null
      ? {}
      : { httpStatus: entry.httpStatus }),
    ...(entry.reason === undefined || entry.reason === null
      ? {}
      : { reason: entry.reason }),
    ...(entry.ineligibleReason === undefined
      ? {}
      : { ineligibleReason: entry.ineligibleReason }),
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
  storage?: CacheStore;
  readOffer?: (account: LoadedAccount) => Promise<ClaudeAccountResets>;
  quietProbeAccountAlias?: string;
  onQuietAccountChange?: (accountAlias: string | null) => void;
}): () => Promise<CachedClaudeAccountResets[]> {
  if (
    options.quietProbeAccountAlias !== undefined &&
    !options.accounts.some(
      (account) =>
        account.accountAlias === options.quietProbeAccountAlias &&
        account.auth.type === "claude_profile",
    )
  ) {
    throw new RangeError("Claude reset quiet probe account is not configured.");
  }
  const now = options.now ?? (() => new Date());
  const storage = options.storage ?? fileStore;
  const readOffer =
    options.readOffer ??
    ((account: LoadedAccount) => readClaudeAccountResets(account, { now }));
  let entries: Record<string, CacheEntry> | null = null;
  let inFlight: Promise<CachedClaudeAccountResets[]> | null = null;
  let quietStartedAt: number | null = null;
  let quietProbeCompleted = false;
  let quietTimer: NodeJS.Timeout | null = null;

  function finishQuietProbe(): void {
    if (quietTimer !== null) {
      clearTimeout(quietTimer);
      quietTimer = null;
    }
    quietStartedAt = null;
    quietProbeCompleted = true;
    options.onQuietAccountChange?.(null);
  }

  function armQuietTimer(delayMilliseconds: number): void {
    quietTimer = setTimeout(() => {
      quietTimer = null;
      void readPublic().catch(() => {
        finishQuietProbe();
      });
    }, delayMilliseconds);
    quietTimer.unref();
  }

  async function load(): Promise<Record<string, CacheEntry>> {
    if (entries !== null) return entries;
    entries = await storage.load();
    return entries;
  }

  async function read(): Promise<CachedClaudeAccountResets[]> {
    const current = await load();
    const verified = await options.verifiedAliases();
    const nowMilliseconds = now().getTime();
    const accounts = options.accounts.filter(
      (account) => account.platform === "Claude",
    );
    const tracked = accounts.filter(
      (account) => account.auth.type === "claude_profile",
    );
    const eligible = tracked.filter((account) =>
      verified.has(account.accountAlias),
    );
    const priorFor = (account: LoadedAccount): CacheEntry | undefined => {
      const prior = current[account.accountAlias];
      return prior?.identity === identity(account) ? prior : undefined;
    };
    const rateLimited = tracked.some(
      (account) =>
        priorFor(account)?.status === "rate_limited" ||
        priorFor(account)?.status === "overloaded",
    );
    const latestFleetAttempt = Math.max(
      0,
      ...tracked
        .map((account) => priorFor(account)?.lastAttemptAt ?? null)
        .filter((attempt): attempt is string => attempt !== null)
        .map((attempt) => Date.parse(attempt)),
    );
    const due = eligible
      .filter((account) => {
        const prior = priorFor(account);
        return (
          prior === undefined ||
          nowMilliseconds - Date.parse(prior.lastAttemptAt) >=
            CLAUDE_RESET_CHECK_INTERVAL_MILLISECONDS
        );
      })
      .sort((left, right) => {
        const leftAttempt = priorFor(left);
        const rightAttempt = priorFor(right);
        return (
          (leftAttempt === undefined
            ? Number.NEGATIVE_INFINITY
            : Date.parse(leftAttempt.lastAttemptAt)) -
          (rightAttempt === undefined
            ? Number.NEGATIVE_INFINITY
            : Date.parse(rightAttempt.lastAttemptAt))
        );
      });
    const quietAccount =
      options.quietProbeAccountAlias === undefined
        ? undefined
        : due.find(
            (account) =>
              account.accountAlias === options.quietProbeAccountAlias,
          );
    const fleetGap = rateLimited
      ? CLAUDE_RESET_RATE_LIMITED_GAP_MILLISECONDS
      : CLAUDE_RESET_FLEET_GAP_MILLISECONDS;
    const selected =
      nowMilliseconds - latestFleetAttempt >= fleetGap
        ? quietAccount !== undefined && !quietProbeCompleted
          ? quietAccount
          : due[0]
        : undefined;
    if (quietStartedAt !== null && selected === undefined) {
      finishQuietProbe();
    }
    const visibleAccounts = (): CachedClaudeAccountResets[] =>
      accounts.map((account): CachedClaudeAccountResets => {
        const accountAlias = account.accountAlias;
        if (
          !verified.has(accountAlias) ||
          account.auth.type !== "claude_profile"
        ) {
          return {
            accountAlias,
            status: "unavailable",
            offers: [],
            lastConfirmedAt: null,
          };
        }
        const prior = current[accountAlias];
        const result =
          prior?.identity === identity(account)
            ? visible(accountAlias, prior, nowMilliseconds)
            : {
                accountAlias,
                status: "pending" as const,
                offers: [],
                lastConfirmedAt: null,
              };
        return quietStartedAt !== null &&
          accountAlias === options.quietProbeAccountAlias
          ? {
              ...result,
              quietUntil: new Date(
                quietStartedAt + CLAUDE_RESET_QUIET_PROBE_MILLISECONDS,
              ).toISOString(),
            }
          : result;
      });
    if (selected !== undefined) {
      if (
        selected.accountAlias === options.quietProbeAccountAlias &&
        !quietProbeCompleted
      ) {
        if (quietStartedAt === null) {
          quietStartedAt = nowMilliseconds;
          options.onQuietAccountChange?.(selected.accountAlias);
          armQuietTimer(CLAUDE_RESET_QUIET_PROBE_MILLISECONDS);
        }
        if (
          nowMilliseconds - quietStartedAt <
          CLAUDE_RESET_QUIET_PROBE_MILLISECONDS
        ) {
          if (quietTimer === null) {
            armQuietTimer(
              CLAUDE_RESET_QUIET_PROBE_MILLISECONDS -
                (nowMilliseconds - quietStartedAt),
            );
          }
          return visibleAccounts();
        }
      }
      const accountAlias = selected.accountAlias;
      const accountIdentity = identity(selected);
      const prior = current[accountAlias];
      let result: ClaudeAccountResets;
      try {
        result = await readOffer(selected);
      } finally {
        if (quietStartedAt !== null) {
          finishQuietProbe();
        }
      }
      current[accountAlias] = {
        identity: accountIdentity,
        lastAttemptAt: new Date(nowMilliseconds).toISOString(),
        lastConfirmedAt:
          result.status === "ok"
            ? new Date(nowMilliseconds).toISOString()
            : prior?.identity === accountIdentity
              ? (prior.lastConfirmedAt ?? null)
              : null,
        status: result.status,
        httpStatus: result.httpStatus ?? null,
        reason: result.reason ?? null,
        ...(result.ineligibleReason === undefined
          ? {}
          : { ineligibleReason: result.ineligibleReason }),
        offers:
          result.status === "ok"
            ? result.offers
            : prior?.identity === accountIdentity
              ? prior.offers
              : [],
      };
      await storage.save(current);
    }
    return visibleAccounts();
  }

  const readPublic = () => {
    inFlight ??= read().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };
  return readPublic;
}
