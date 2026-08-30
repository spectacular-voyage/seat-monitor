import { loadAccounts, type LoadedAccount } from "../config/accounts.js";
import {
  quotaSnapshotSchema,
  type Platform,
  type QuotaSnapshot,
} from "../domain/quota.js";
import { createClaudeProvider } from "./claude.js";
import { createCodexProvider } from "./codex.js";
import { createFailureSnapshot } from "./failure.js";
import type { QuotaProvider } from "./provider.js";

export const DEFAULT_CONCURRENCY = 8;
export const DEFAULT_TIMEOUT_MILLISECONDS = 8_000;

export type Scanner = () => Promise<QuotaSnapshot[]>;

export type ScannerOptions = {
  accounts: readonly LoadedAccount[];
  providers: Readonly<Record<Platform, QuotaProvider>>;
  concurrency?: number;
  timeoutMilliseconds?: number;
  now?: () => Date;
};

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError("Concurrency must be a positive integer.");
  }

  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      const item = items[index];
      if (item === undefined) {
        throw new RangeError("Account index is out of range.");
      }
      results[index] = await mapper(item, index);
    }
  }

  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
}

export function createScanner(options: ScannerOptions): Scanner {
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  const timeoutMilliseconds =
    options.timeoutMilliseconds ?? DEFAULT_TIMEOUT_MILLISECONDS;
  const now = options.now ?? (() => new Date());

  return async () =>
    mapWithConcurrency(options.accounts, concurrency, async (account) => {
      if (
        account.auth.type !== "codex_profile" &&
        (account.auth.credential === undefined ||
          account.auth.credential.length === 0)
      ) {
        return createFailureSnapshot(
          account,
          "missing_credential",
          `Credential environment variable ${account.auth.credentialEnv} is missing.`,
          now().toISOString(),
        );
      }

      try {
        const snapshot = quotaSnapshotSchema.parse(
          await options.providers[account.platform].scan(account, {
            now,
            timeoutMilliseconds,
          }),
        );
        if (
          snapshot.accountAlias !== account.accountAlias ||
          snapshot.platform !== account.platform
        ) {
          throw new TypeError(
            "Provider returned an account identity mismatch.",
          );
        }
        return snapshot;
      } catch {
        return createFailureSnapshot(
          account,
          "invalid_response",
          "Provider adapter failed to produce a valid account snapshot.",
          now().toISOString(),
        );
      }
    });
}

export function createDefaultScanner(): Scanner {
  return createScanner({
    accounts: loadAccounts(),
    providers: {
      Claude: createClaudeProvider(),
      Codex: createCodexProvider(),
    },
  });
}
