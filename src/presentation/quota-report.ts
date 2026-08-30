import type { Platform, PublicQuotaSnapshot } from "../domain/quota.js";
import {
  MINIMUM_USABLE_HEADROOM_PERCENT,
  QUOTA_LOCAL_CONSTANTS,
  type LocalConstant,
} from "./quota-constants.js";

export type WindowDurationSource = "api" | "constant" | null;

export type QuotaReportRow = {
  key: string;
  label: string;
  depth: 0 | 1;
  parentKey: string | null;
  support: "available" | "unsupported";
  consumedPercent: number | null;
  headroomPercent: number | null;
  resetAt: string | null;
  timeRemainingMinutes: number | null;
  windowDurationMinutes: number | null;
  windowDurationSource: WindowDurationSource;
  windowConstant: LocalConstant | null;
  elapsedMinutes: number | null;
  elapsedPercent: number | null;
  subCapFraction: number | null;
  subCapConstant: LocalConstant | null;
  constantSuspect: boolean;
};

export type QuotaReportAccount = {
  accountAlias: string;
  displayAccount: string;
  platform: Platform;
  plan: string | null;
  status: "ok" | "error";
  rows: QuotaReportRow[];
  error: { code: string; message: string } | null;
  soonestUsableResetMilliseconds: number | null;
};

export type UseRecommendation = {
  accountAlias: string;
  displayAccount: string;
  platform: Platform;
  limitLabel: string;
  headroomPercent: number;
  resetAt: string;
  timeRemainingMinutes: number;
};

export type WatchRecommendation = {
  accountAlias: string;
  displayAccount: string;
  platform: Platform;
  row: QuotaReportRow;
  elapsedPercent: number | null;
  elapsedUsesConstant: boolean;
  resetAt: string | null;
  timeRemainingMinutes: number | null;
  constantSuspect: boolean;
};

export type QuotaReport = {
  generatedAt: string;
  nowMilliseconds: number;
  timeZone: string;
  accounts: QuotaReportAccount[];
  use: UseRecommendation | null;
  watch: WatchRecommendation | null;
  usesLocalConstants: boolean;
};

type CapacityCandidate = UseRecommendation & {
  groupKey: string;
  resetMilliseconds: number;
};

function displayAccount(alias: string, platform: Platform): string {
  const prefix = platform === "Claude" ? "claude-" : "codex-";
  return alias.toLocaleLowerCase("en-US").startsWith(prefix)
    ? alias.slice(prefix.length)
    : alias;
}

function displayLimitLabel(
  platform: Platform,
  key: string,
  label: string,
): string {
  if (platform === "Claude") {
    if (key === "base.session") {
      return "Session";
    }
    if (key === "base.weekly") {
      return "Week / all models";
    }
    if (key.startsWith("fable")) {
      return "Fable sub-cap";
    }
  }

  return label
    .replace(/^GPT-[\d.]+-Codex-/u, "")
    .replace(/\bPrimary\b/gu, "primary")
    .replace(/\bSecondary\b/gu, "secondary");
}

function localWindowConstant(
  platform: Platform,
  key: string,
): LocalConstant | null {
  if (platform === "Claude" && key === "base.session") {
    return QUOTA_LOCAL_CONSTANTS.windowMinutes.claudeSession;
  }
  if (platform === "Claude" && key === "base.weekly") {
    return QUOTA_LOCAL_CONSTANTS.windowMinutes.claudeWeekly;
  }
  if (
    platform === "Codex" &&
    (key === "codex.primary" || key === "codex_bengalfox.secondary")
  ) {
    return QUOTA_LOCAL_CONSTANTS.windowMinutes.codexWeeklyFallback;
  }
  return null;
}

function subCapConstant(plan: string | null): LocalConstant | null {
  if (plan === null) {
    return null;
  }
  const normalized = plan.toLocaleLowerCase("en-US");
  return normalized === "max"
    ? QUOTA_LOCAL_CONSTANTS.subCapFractionsByPlan.max
    : null;
}

function deriveTopLevelRow(
  snapshot: Extract<PublicQuotaSnapshot, { status: "ok" }>,
  limit: Extract<PublicQuotaSnapshot, { status: "ok" }>["limits"][number],
  nowMilliseconds: number,
): QuotaReportRow {
  const consumedPercent = limit.usedPercent;
  const headroomPercent =
    consumedPercent === null ? null : 100 - consumedPercent;
  const resetMilliseconds =
    limit.resetAt === null ? null : Date.parse(limit.resetAt);
  const timeRemainingMinutes =
    resetMilliseconds === null
      ? null
      : Math.ceil((resetMilliseconds - nowMilliseconds) / 60_000);
  const fallbackConstant = localWindowConstant(snapshot.platform, limit.key);
  const windowDurationMinutes =
    limit.windowDurationMinutes ?? fallbackConstant?.value ?? null;
  const windowDurationSource: WindowDurationSource =
    limit.windowDurationMinutes !== null
      ? "api"
      : fallbackConstant === null
        ? null
        : "constant";

  let elapsedMinutes: number | null = null;
  let elapsedPercent: number | null = null;
  let constantSuspect = false;
  if (timeRemainingMinutes !== null && windowDurationMinutes !== null) {
    const elapsed = windowDurationMinutes - timeRemainingMinutes;
    const candidateElapsedPercent = (elapsed / windowDurationMinutes) * 100;
    const elapsedIsInvalid =
      timeRemainingMinutes > windowDurationMinutes ||
      candidateElapsedPercent < 0 ||
      candidateElapsedPercent > 100;
    constantSuspect = elapsedIsInvalid && windowDurationSource === "constant";
    if (!elapsedIsInvalid) {
      elapsedMinutes = elapsed;
      elapsedPercent = candidateElapsedPercent;
    }
  }

  return {
    key: limit.key,
    label: displayLimitLabel(snapshot.platform, limit.key, limit.label),
    depth: 0,
    parentKey: null,
    support: limit.availability,
    consumedPercent,
    headroomPercent,
    resetAt: limit.resetAt,
    timeRemainingMinutes,
    windowDurationMinutes,
    windowDurationSource,
    windowConstant:
      windowDurationSource === "constant" ? fallbackConstant : null,
    elapsedMinutes,
    elapsedPercent,
    subCapFraction: null,
    subCapConstant: null,
    constantSuspect,
  };
}

function deriveRows(
  snapshot: Extract<PublicQuotaSnapshot, { status: "ok" }>,
  nowMilliseconds: number,
): QuotaReportRow[] {
  const hasWeeklyParent = snapshot.limits.some(
    (limit) => limit.key === "base.weekly",
  );
  const fractionConstant = subCapConstant(snapshot.plan);

  return snapshot.limits.map((limit) => {
    const isFableSubCap =
      snapshot.platform === "Claude" &&
      hasWeeklyParent &&
      limit.key.startsWith("fable");
    if (!isFableSubCap) {
      return deriveTopLevelRow(snapshot, limit, nowMilliseconds);
    }

    const consumedPercent = limit.usedPercent;
    const fraction = fractionConstant?.value ?? null;
    return {
      key: limit.key,
      label: "Fable sub-cap",
      depth: 1,
      parentKey: "base.weekly",
      support: limit.availability,
      consumedPercent,
      headroomPercent: consumedPercent === null ? null : 100 - consumedPercent,
      resetAt: null,
      timeRemainingMinutes: null,
      windowDurationMinutes: null,
      windowDurationSource: null,
      windowConstant: null,
      elapsedMinutes: null,
      elapsedPercent: null,
      subCapFraction: fraction,
      subCapConstant: fractionConstant,
      constantSuspect: false,
    };
  });
}

function rowSortKey(row: QuotaReportRow): string {
  if (row.key === "base.weekly") {
    return "00";
  }
  if (row.parentKey === "base.weekly") {
    return "00.1";
  }
  if (row.key === "base.session") {
    return "01";
  }
  return `10.${row.key}`;
}

function groupKey(platform: Platform, row: QuotaReportRow): string | null {
  if (row.depth === 1 || row.support !== "available") {
    return null;
  }
  if (platform === "Claude") {
    return row.key.startsWith("base.") ? "base" : row.key;
  }
  return row.key.replace(/\.(primary|secondary)$/u, "");
}

function capacityCandidates(account: QuotaReportAccount): CapacityCandidate[] {
  if (account.status === "error") {
    return [];
  }

  const groups = new Map<string, QuotaReportRow[]>();
  for (const row of account.rows) {
    const key = groupKey(account.platform, row);
    if (key !== null) {
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }
  }

  const candidates: CapacityCandidate[] = [];
  for (const [key, rows] of groups) {
    if (
      rows.length === 0 ||
      rows.some(
        (row) =>
          row.headroomPercent === null ||
          row.headroomPercent < MINIMUM_USABLE_HEADROOM_PERCENT,
      )
    ) {
      continue;
    }
    const resetRows = rows
      .filter(
        (
          row,
        ): row is QuotaReportRow & {
          resetAt: string;
          timeRemainingMinutes: number;
        } => row.resetAt !== null && row.timeRemainingMinutes !== null,
      )
      .sort(
        (left, right) =>
          Date.parse(left.resetAt) - Date.parse(right.resetAt) ||
          left.key.localeCompare(right.key),
      );
    const resetRow = resetRows[0];
    if (resetRow === undefined) {
      continue;
    }
    const effectiveHeadroom = Math.min(
      ...rows.map((row) => row.headroomPercent ?? Number.NEGATIVE_INFINITY),
    );
    candidates.push({
      accountAlias: account.accountAlias,
      displayAccount: account.displayAccount,
      platform: account.platform,
      groupKey: key,
      limitLabel: resetRow.label,
      headroomPercent: effectiveHeadroom,
      resetAt: resetRow.resetAt,
      resetMilliseconds: Date.parse(resetRow.resetAt),
      timeRemainingMinutes: resetRow.timeRemainingMinutes,
    });
  }
  return candidates;
}

function compareCandidates(
  left: CapacityCandidate,
  right: CapacityCandidate,
): number {
  return (
    left.resetMilliseconds - right.resetMilliseconds ||
    left.accountAlias.localeCompare(right.accountAlias) ||
    left.groupKey.localeCompare(right.groupKey)
  );
}

function watchForAccountRows(
  account: QuotaReportAccount,
): WatchRecommendation[] {
  const byKey = new Map(account.rows.map((row) => [row.key, row]));
  return account.rows.flatMap((row): WatchRecommendation[] => {
    if (row.support !== "available" || row.consumedPercent === null) {
      return [];
    }
    const clockRow = row.parentKey === null ? row : byKey.get(row.parentKey);
    return [
      {
        accountAlias: account.accountAlias,
        displayAccount: account.displayAccount,
        platform: account.platform,
        row,
        elapsedPercent: clockRow?.elapsedPercent ?? null,
        elapsedUsesConstant: clockRow?.windowDurationSource === "constant",
        resetAt: clockRow?.resetAt ?? null,
        timeRemainingMinutes: clockRow?.timeRemainingMinutes ?? null,
        constantSuspect: clockRow?.constantSuspect ?? false,
      },
    ];
  });
}

function compareWatch(
  left: WatchRecommendation,
  right: WatchRecommendation,
): number {
  const consumedDifference =
    (right.row.consumedPercent ?? Number.NEGATIVE_INFINITY) -
    (left.row.consumedPercent ?? Number.NEGATIVE_INFINITY);
  if (consumedDifference !== 0) {
    return consumedDifference;
  }
  const leftElapsed = left.elapsedPercent ?? Number.POSITIVE_INFINITY;
  const rightElapsed = right.elapsedPercent ?? Number.POSITIVE_INFINITY;
  return (
    leftElapsed - rightElapsed ||
    left.accountAlias.localeCompare(right.accountAlias) ||
    left.row.key.localeCompare(right.row.key)
  );
}

function compareAccounts(
  left: QuotaReportAccount,
  right: QuotaReportAccount,
): number {
  return (
    left.platform.localeCompare(right.platform) ||
    (left.soonestUsableResetMilliseconds ?? Number.POSITIVE_INFINITY) -
      (right.soonestUsableResetMilliseconds ?? Number.POSITIVE_INFINITY) ||
    left.accountAlias.localeCompare(right.accountAlias)
  );
}

export function buildQuotaReport(
  snapshots: readonly PublicQuotaSnapshot[],
  options: { nowMilliseconds: number; timeZone: string },
): QuotaReport {
  const accounts = snapshots.map((snapshot): QuotaReportAccount => {
    if (snapshot.status === "error") {
      return {
        accountAlias: snapshot.accountAlias,
        displayAccount: displayAccount(
          snapshot.accountAlias,
          snapshot.platform,
        ),
        platform: snapshot.platform,
        plan: null,
        status: "error",
        rows: [],
        error: snapshot.error,
        soonestUsableResetMilliseconds: null,
      };
    }

    const account: QuotaReportAccount = {
      accountAlias: snapshot.accountAlias,
      displayAccount: displayAccount(snapshot.accountAlias, snapshot.platform),
      platform: snapshot.platform,
      plan: snapshot.plan,
      status: "ok",
      rows: deriveRows(snapshot, options.nowMilliseconds).sort((left, right) =>
        rowSortKey(left).localeCompare(rowSortKey(right)),
      ),
      error: null,
      soonestUsableResetMilliseconds: null,
    };
    account.soonestUsableResetMilliseconds =
      capacityCandidates(account).sort(compareCandidates)[0]
        ?.resetMilliseconds ?? null;
    return account;
  });

  accounts.sort(compareAccounts);
  const candidates = accounts
    .flatMap(capacityCandidates)
    .sort(compareCandidates);
  const watchCandidates = accounts
    .flatMap(watchForAccountRows)
    .sort(compareWatch);
  const useCandidate = candidates[0];

  return {
    generatedAt: new Date(options.nowMilliseconds).toISOString(),
    nowMilliseconds: options.nowMilliseconds,
    timeZone: options.timeZone,
    accounts,
    use:
      useCandidate === undefined
        ? null
        : {
            accountAlias: useCandidate.accountAlias,
            displayAccount: useCandidate.displayAccount,
            platform: useCandidate.platform,
            limitLabel: useCandidate.limitLabel,
            headroomPercent: useCandidate.headroomPercent,
            resetAt: useCandidate.resetAt,
            timeRemainingMinutes: useCandidate.timeRemainingMinutes,
          },
    watch: watchCandidates[0] ?? null,
    usesLocalConstants: accounts.some((account) =>
      account.rows.some(
        (row) =>
          row.windowDurationSource === "constant" ||
          row.subCapConstant !== null,
      ),
    ),
  };
}
