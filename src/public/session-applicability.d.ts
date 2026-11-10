import type { AnalyticsLimit } from "../domain/history.js";
import type { PublicQuotaSnapshot } from "../domain/quota.js";

type RawLimit = Extract<
  PublicQuotaSnapshot,
  { status: "ok" }
>["limits"][number];

export function fallbackLimit(
  limit: RawLimit,
  weeklyLimit?: RawLimit | null,
): AnalyticsLimit;

export function createNotApplicableSession<
  T extends { append(...children: T[]): void },
>(
  limit: Pick<AnalyticsLimit, "label" | "applicability">,
  element: (name: string, className: string, text?: string) => T,
  compact?: boolean,
): T | null;
