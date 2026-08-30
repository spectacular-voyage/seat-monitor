import type { LoadedAccount } from "../config/accounts.js";
import type { QuotaSnapshot } from "../domain/quota.js";

export type ScanContext = {
  now: () => Date;
  timeoutMilliseconds: number;
};

export type QuotaProvider = {
  scan: (
    account: LoadedAccount,
    context: ScanContext,
  ) => Promise<QuotaSnapshot>;
};
