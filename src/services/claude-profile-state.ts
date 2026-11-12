import { open } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import type { LoadedClaudeProfileAccount } from "../config/accounts.js";

// A dedicated monitor profile's .claude.json is ~100 KB; refuse anything far larger.
const MAX_PROFILE_STATE_BYTES = 4_000_000;

const shortText = z.string().trim().min(1).max(64);
const instant = z
  .string()
  .max(64)
  .refine((value) => Number.isFinite(Date.parse(value)))
  .transform((value) => new Date(Date.parse(value)).toISOString());

const profileStateSchema = z.object({
  oauthAccount: z.object({
    emailAddress: z.email(),
    planDisplayName: shortText.nullable().optional().catch(null),
    organizationRateLimitTier: shortText.nullable().optional().catch(null),
    subscriptionCreatedAt: instant.nullable().optional().catch(null),
  }),
});

/** Plan facts Claude Code caches from its profile fetch. Identity-bound: absent
 * unless the cached account is the profile's pinned expected email. */
export type ClaudeProfileState = {
  planDisplayName: string | null;
  rateLimitTier: string | null;
  subscriptionCreatedAt: string | null;
};

export function parseClaudeProfileState(
  payload: unknown,
  expectedEmail: string,
): ClaudeProfileState | null {
  const parsed = profileStateSchema.safeParse(payload);
  if (
    !parsed.success ||
    parsed.data.oauthAccount.emailAddress.toLowerCase() !==
      expectedEmail.toLowerCase()
  ) {
    return null;
  }
  const account = parsed.data.oauthAccount;
  return {
    planDisplayName: account.planDisplayName ?? null,
    rateLimitTier: account.organizationRateLimitTier ?? null,
    subscriptionCreatedAt: account.subscriptionCreatedAt ?? null,
  };
}

export type ReadClaudeProfileState = (
  account: LoadedClaudeProfileAccount,
) => Promise<ClaudeProfileState | null>;

/** Missing, oversized, malformed, or wrong-identity state is never used. */
export const readClaudeProfileState: ReadClaudeProfileState = async (
  account,
) => {
  try {
    const file = await open(
      join(account.auth.claudeConfigDir, ".claude.json"),
      "r",
    );
    try {
      if ((await file.stat()).size > MAX_PROFILE_STATE_BYTES) return null;
      return parseClaudeProfileState(
        JSON.parse(await file.readFile("utf8")) as unknown,
        account.auth.expectedEmail,
      );
    } finally {
      await file.close();
    }
  } catch {
    return null;
  }
};

export function isUltraDisplayName(planDisplayName: string | null): boolean {
  return planDisplayName?.toLowerCase() === "ultra";
}
