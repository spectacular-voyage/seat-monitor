import type { LoadedAccount } from "../config/accounts.js";
import {
  quotaFailureSchema,
  type QuotaErrorCode,
  type QuotaSnapshot,
} from "../domain/quota.js";

export function createFailureSnapshot(
  account: Pick<LoadedAccount, "accountAlias" | "platform">,
  code: QuotaErrorCode,
  message: string,
  observedAt: string,
): QuotaSnapshot {
  return quotaFailureSchema.parse({
    accountAlias: account.accountAlias,
    platform: account.platform,
    status: "error",
    plan: null,
    limits: [],
    observedAt,
    error: { code, message },
  });
}
