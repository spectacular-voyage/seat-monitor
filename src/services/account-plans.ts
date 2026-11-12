import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { z } from "zod";

import type { LoadedAccount } from "../config/accounts.js";
import {
  accountPlansResponseSchema,
  type AccountPlan,
  type AccountPlansResponse,
} from "../domain/account-plans.js";
import type { QuotaSnapshot } from "../domain/quota.js";
import {
  createAccountBillingFetcher,
  type FetchAccountBilling,
  type ProviderBilling,
} from "./account-billing.js";
import {
  isUltraDisplayName,
  readClaudeProfileState,
  type ClaudeProfileState,
  type ReadClaudeProfileState,
} from "./claude-profile-state.js";
import { calendarDateInTimeZone } from "./time.js";

// Billing facts change rarely; one provider request per account every six
// hours is ample, and failures back off instead of retrying every page load.
export const BILLING_CHECK_INTERVAL_MILLISECONDS = 6 * 60 * 60_000;
export const BILLING_RETRY_MILLISECONDS = 30 * 60_000;
export const BILLING_RATE_LIMITED_RETRY_MILLISECONDS = 2 * 60 * 60_000;
export const BILLING_REQUEST_GAP_MILLISECONDS = 1_000;

const instantSchema = z.iso.datetime({ offset: true });
const billingSchema = z.object({
  plan: z.string().nullable(),
  planDisplayName: z.string().nullable(),
  rateLimitTier: z.string().nullable(),
  subscriptionStatus: z.string().nullable(),
  billingPeriod: z.string().nullable(),
  subscribedAt: instantSchema.nullable(),
  renewsAt: instantSchema.nullable(),
  endsAt: instantSchema.nullable(),
  willRenew: z.boolean().nullable(),
});
const entrySchema = z.object({
  identity: z.string(),
  attemptedAt: instantSchema,
  checkedAt: instantSchema.nullable(),
  status: z.enum(["ok", "unavailable"]),
  httpStatus: z.number().int().min(100).max(599).nullable(),
  billing: billingSchema.nullable(),
});
const fileSchema = z.object({
  version: z.literal(1),
  accounts: z.record(z.string(), entrySchema),
});
type Entry = z.infer<typeof entrySchema>;
export type AccountBillingStore = {
  load: () => Promise<Record<string, Entry>>;
  save: (entries: Record<string, Entry>) => Promise<void>;
};

const cacheFilePath = join(
  homedir(),
  ".local",
  "state",
  "seat-monitor",
  "account-billing.json",
);

const fileStore: AccountBillingStore = {
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

function identity(account: LoadedAccount): string | null {
  if (account.auth.type === "claude_profile") {
    return `claude\n${account.auth.profile}\n${account.auth.expectedEmail.toLowerCase()}`;
  }
  if (account.auth.type === "codex_profile") {
    return `codex\n${account.auth.profile}`;
  }
  return null;
}

function titleCase(value: string): string {
  return value
    .split(/[-_\s]+/u)
    .filter((part) => part.length > 0)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

/** Anthropic names Ultra directly. Max carries its multiplier only in the
 * rate-limit tier, for example `default_claude_max_5x`. */
export function claudeTierLabel(options: {
  plan: string | null;
  planDisplayName: string | null;
  rateLimitTier: string | null;
}): string | null {
  const multiplier = /max_(\d+)x/u.exec(options.rateLimitTier ?? "")?.[1];
  const displayName = options.planDisplayName;
  if (displayName !== null && !/^max$/iu.test(displayName)) {
    return displayName;
  }
  if (options.plan === "ultra") return "Ultra";
  if (multiplier !== undefined) return `Max ${multiplier}x`;
  return options.plan === null ? displayName : titleCase(options.plan);
}

function daysInUtcMonth(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

/** The anchor's monthly anniversary `months` later, clamped to short months
 * the way card subscriptions bill (Jan 31 → Feb 28 → Mar 31). */
function addMonthsClamped(anchor: Date, months: number): number {
  const year = anchor.getUTCFullYear();
  const monthIndex = anchor.getUTCMonth() + months;
  const first = new Date(
    Date.UTC(
      year,
      monthIndex,
      1,
      anchor.getUTCHours(),
      anchor.getUTCMinutes(),
      anchor.getUTCSeconds(),
      anchor.getUTCMilliseconds(),
    ),
  );
  first.setUTCDate(
    Math.min(
      anchor.getUTCDate(),
      daysInUtcMonth(first.getUTCFullYear(), first.getUTCMonth()),
    ),
  );
  return first.getTime();
}

/** First monthly anniversary of `anchorMilliseconds` strictly after now. */
export function nextMonthlyAnniversary(
  anchorMilliseconds: number,
  nowMilliseconds: number,
): number {
  const anchor = new Date(anchorMilliseconds);
  const now = new Date(nowMilliseconds);
  let months = Math.max(
    1,
    (now.getUTCFullYear() - anchor.getUTCFullYear()) * 12 +
      now.getUTCMonth() -
      anchor.getUTCMonth() -
      1,
  );
  let candidate = addMonthsClamped(anchor, months);
  while (candidate <= nowMilliseconds) {
    months += 1;
    candidate = addMonthsClamped(anchor, months);
  }
  return candidate;
}

/** The next calendar date (today or later) on a declared monthly billing
 * day, clamped to the month's length. */
export function nextDeclaredBillingDate(
  renewalDay: number,
  nowMilliseconds: number,
  timeZone: string,
): string {
  const [year, month, day] = calendarDateInTimeZone(nowMilliseconds, timeZone)
    .split("-")
    .map(Number) as [number, number, number];
  const clampedDay = (targetYear: number, monthIndex: number) =>
    Math.min(renewalDay, daysInUtcMonth(targetYear, monthIndex));
  let target = new Date(Date.UTC(year, month - 1, clampedDay(year, month - 1)));
  if (target.getUTCDate() < day) {
    const next = new Date(Date.UTC(year, month, 1));
    target = new Date(
      Date.UTC(
        next.getUTCFullYear(),
        next.getUTCMonth(),
        clampedDay(next.getUTCFullYear(), next.getUTCMonth()),
      ),
    );
  }
  return target.toISOString().slice(0, 10);
}

type RenewalInputs = {
  account: LoadedAccount;
  billing: ProviderBilling | null;
  subscribedAt: string | null;
  nowMilliseconds: number;
  timeZone: string;
};

/** Provider dates win, then an operator declaration, then a monthly estimate
 * from the subscription start. Past provider dates are never presented. */
export function resolveRenewal(inputs: RenewalInputs): AccountPlan["renewal"] {
  const { account, billing, nowMilliseconds, timeZone } = inputs;
  const declared = account.billing;
  const providerRenewal =
    billing?.willRenew !== null && billing?.willRenew !== undefined
      ? { value: billing.willRenew, source: "provider" as const }
      : null;
  const declaredRenewal =
    declared?.autoRenew === undefined
      ? null
      : { value: declared.autoRenew, source: "declared" as const };
  const autoRenew = providerRenewal ?? declaredRenewal;
  const renewalFields = {
    autoRenew: autoRenew?.value ?? null,
    autoRenewSource: autoRenew?.source ?? null,
  };
  const providerAt = billing?.endsAt ?? billing?.renewsAt ?? null;
  if (providerAt !== null && Date.parse(providerAt) > nowMilliseconds) {
    return {
      date: calendarDateInTimeZone(Date.parse(providerAt), timeZone),
      at: providerAt,
      dateSource: "provider",
      ...renewalFields,
    };
  }
  if (declared?.renewalDay !== undefined) {
    return {
      date: nextDeclaredBillingDate(
        declared.renewalDay,
        nowMilliseconds,
        timeZone,
      ),
      at: null,
      dateSource: "declared",
      ...renewalFields,
    };
  }
  const anchor = providerAt ?? inputs.subscribedAt;
  const monthly =
    billing?.billingPeriod === null ||
    billing?.billingPeriod === undefined ||
    billing.billingPeriod === "monthly";
  if (
    anchor !== null &&
    monthly &&
    billing?.subscriptionStatus !== "inactive"
  ) {
    return {
      date: calendarDateInTimeZone(
        nextMonthlyAnniversary(Date.parse(anchor), nowMilliseconds),
        timeZone,
      ),
      at: null,
      dateSource: "estimated",
      ...renewalFields,
    };
  }
  return { date: null, at: null, dateSource: null, ...renewalFields };
}

function scanFields(snapshot: QuotaSnapshot | undefined): AccountPlan["scan"] {
  if (snapshot === undefined) {
    return { status: "pending", errorCode: null, observedAt: null };
  }
  return {
    status: snapshot.status,
    errorCode: snapshot.status === "error" ? snapshot.error.code : null,
    observedAt: snapshot.observedAt,
  };
}

export function buildAccountPlan(options: {
  account: LoadedAccount;
  snapshot: QuotaSnapshot | undefined;
  entry: Entry | undefined;
  localState: ClaudeProfileState | null;
  nowMilliseconds: number;
  timeZone: string;
}): AccountPlan {
  const { account, snapshot, localState } = options;
  const accountIdentity = identity(account);
  const entry =
    accountIdentity !== null && options.entry?.identity === accountIdentity
      ? options.entry
      : undefined;
  const billing = entry?.billing ?? null;
  const scannedPlan = snapshot?.status === "ok" ? snapshot.plan : null;
  let plan = scannedPlan ?? billing?.plan ?? null;
  let tier: string | null;
  let tierSource: AccountPlan["tierSource"];
  if (account.platform === "Claude") {
    const planDisplayName =
      billing?.planDisplayName ?? localState?.planDisplayName ?? null;
    const declaredPlan = "plan" in account ? account.plan : undefined;
    const declaredUltra = declaredPlan === "ultra";
    if (plan === null && declaredUltra) plan = "ultra";
    tier = claudeTierLabel({
      plan,
      planDisplayName,
      rateLimitTier:
        billing?.rateLimitTier ?? localState?.rateLimitTier ?? null,
    });
    const providerUltra =
      isUltraDisplayName(planDisplayName) ||
      (scannedPlan === "ultra" && !declaredUltra);
    tierSource =
      tier === null
        ? null
        : tier === "Ultra" && declaredUltra && !providerUltra
          ? "declared"
          : "provider";
  } else {
    tier = plan === null ? null : titleCase(plan);
    tierSource = tier === null ? null : "provider";
  }
  const subscribedAt =
    billing?.subscribedAt ?? localState?.subscriptionCreatedAt ?? null;
  return {
    accountAlias: account.accountAlias,
    platform: account.platform,
    scan: scanFields(snapshot),
    plan,
    tier,
    tierSource,
    subscriptionStatus: billing?.subscriptionStatus ?? null,
    billingPeriod: billing?.billingPeriod ?? null,
    subscribedAt,
    renewal: resolveRenewal({
      account,
      billing,
      subscribedAt,
      nowMilliseconds: options.nowMilliseconds,
      timeZone: options.timeZone,
    }),
    billingCheck:
      accountIdentity === null
        ? { status: "unsupported", checkedAt: null, httpStatus: null }
        : entry === undefined
          ? { status: "pending", checkedAt: null, httpStatus: null }
          : {
              status: entry.status,
              checkedAt: entry.checkedAt,
              httpStatus: entry.httpStatus,
            },
  };
}

function retryAfter(entry: Entry): number {
  if (entry.status === "ok") return BILLING_CHECK_INTERVAL_MILLISECONDS;
  return entry.httpStatus === 429 || entry.httpStatus === 529
    ? BILLING_RATE_LIMITED_RETRY_MILLISECONDS
    : BILLING_RETRY_MILLISECONDS;
}

export type AccountPlanReader = {
  /** Current rows from cached provider facts; starts due checks in the background. */
  read: () => Promise<AccountPlansResponse>;
  /** Checks every due account, one request at a time. Resolves when done. */
  refreshDue: () => Promise<void>;
};

export function createAccountPlanReader(options: {
  accounts: readonly LoadedAccount[];
  snapshots: () => readonly QuotaSnapshot[] | null;
  now?: () => Date;
  timeZone?: string;
  storage?: AccountBillingStore;
  fetchBilling?: FetchAccountBilling;
  readProfileState?: ReadClaudeProfileState;
  requestGapMilliseconds?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}): AccountPlanReader {
  const now = options.now ?? (() => new Date());
  const timeZone =
    options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const storage = options.storage ?? fileStore;
  const fetchBilling = options.fetchBilling ?? createAccountBillingFetcher();
  const readProfileState = options.readProfileState ?? readClaudeProfileState;
  const gap =
    options.requestGapMilliseconds ?? BILLING_REQUEST_GAP_MILLISECONDS;
  const sleep =
    options.sleep ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, milliseconds);
      }));
  let entries: Record<string, Entry> | null = null;
  let refreshing: Promise<void> | null = null;

  async function load(): Promise<Record<string, Entry>> {
    entries ??= await storage.load();
    return entries;
  }

  function isDue(account: LoadedAccount, nowMilliseconds: number): boolean {
    const accountIdentity = identity(account);
    if (accountIdentity === null) return false;
    const entry = entries?.[account.accountAlias];
    return (
      entry?.identity !== accountIdentity ||
      nowMilliseconds - Date.parse(entry.attemptedAt) >= retryAfter(entry)
    );
  }

  async function refresh(): Promise<void> {
    const current = await load();
    let first = true;
    for (const account of options.accounts) {
      if (!isDue(account, now().getTime())) continue;
      if (!first) await sleep(gap);
      first = false;
      const accountIdentity = identity(account);
      const result = await fetchBilling(account);
      if (result === null || accountIdentity === null) continue;
      const prior = current[account.accountAlias];
      const known = prior?.identity === accountIdentity ? prior : undefined;
      const attemptedAt = now().toISOString();
      current[account.accountAlias] =
        result.status === "ok"
          ? {
              identity: accountIdentity,
              attemptedAt,
              checkedAt: attemptedAt,
              status: "ok",
              httpStatus: result.httpStatus,
              billing: result.billing,
            }
          : {
              identity: accountIdentity,
              attemptedAt,
              checkedAt: known?.checkedAt ?? null,
              status: "unavailable",
              httpStatus: result.httpStatus,
              // A different identity must never inherit another account's
              // billing; a transient failure keeps the last confirmed facts.
              billing:
                result.reason === "identity_mismatch"
                  ? null
                  : (known?.billing ?? null),
            };
      await storage.save(current);
    }
  }

  function refreshDue(): Promise<void> {
    refreshing ??= refresh()
      .catch(() => {
        /* A failed save or read retries on the next page load. */
      })
      .finally(() => {
        refreshing = null;
      });
    return refreshing;
  }

  async function read(): Promise<AccountPlansResponse> {
    const current = await load();
    const nowMilliseconds = now().getTime();
    if (options.accounts.some((account) => isDue(account, nowMilliseconds))) {
      void refreshDue();
    }
    const snapshots = new Map(
      (options.snapshots() ?? []).map((snapshot) => [
        `${snapshot.platform}\0${snapshot.accountAlias}`,
        snapshot,
      ]),
    );
    const accounts = await Promise.all(
      options.accounts.map(async (account) =>
        buildAccountPlan({
          account,
          snapshot: snapshots.get(
            `${account.platform}\0${account.accountAlias}`,
          ),
          entry: current[account.accountAlias],
          localState:
            account.platform === "Claude" &&
            account.auth.type === "claude_profile"
              ? await readProfileState({ ...account, auth: account.auth })
              : null,
          nowMilliseconds,
          timeZone,
        }),
      ),
    );
    return accountPlansResponseSchema.parse({
      apiVersion: 1,
      generatedAt: new Date(nowMilliseconds).toISOString(),
      timeZone,
      accounts,
    });
  }

  return { read, refreshDue };
}
