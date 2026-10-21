import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import type { LoadedAccount } from "../config/accounts.js";

const usageResponseSchema = z.object({
  cedar_ember: z
    .object({
      eligible: z.boolean(),
      grants: z.array(
        z.object({
          label: z.string().default("Limit reset"),
          resets_left: z.number().int().nonnegative(),
          starts_at: z.iso.datetime({ offset: true }).nullable().optional(),
          ends_at: z.iso.datetime({ offset: true }).nullable().optional(),
          paused: z.boolean().optional(),
        }),
      ),
    })
    .nullable()
    .optional(),
});

const credentialsSchema = z.object({
  claudeAiOauth: z.object({ accessToken: z.string().min(1) }),
});

export type ClaudeResetOffer = {
  label: string;
  count: number;
  expiresAt: string | null;
};

export type ClaudeAccountResets = {
  accountAlias: string;
  status: "ok" | "rate_limited" | "overloaded" | "unavailable";
  offers: ClaudeResetOffer[];
  httpStatus?: number;
};

export async function readClaudeAccountResets(
  account: LoadedAccount,
  options: { now?: () => Date; fetch?: typeof fetch } = {},
): Promise<ClaudeAccountResets> {
  const unavailable: ClaudeAccountResets = {
    accountAlias: account.accountAlias,
    status: "unavailable",
    offers: [],
  };
  if (account.auth.type !== "claude_profile") {
    return unavailable;
  }

  try {
    const credentials = credentialsSchema.parse(
      JSON.parse(
        await readFile(
          join(account.auth.claudeConfigDir, ".credentials.json"),
          "utf8",
        ),
      ) as unknown,
    );
    const response = await (options.fetch ?? fetch)(
      "https://api.anthropic.com/api/oauth/usage?cedar_ember=1&skip_spend=1",
      {
        headers: {
          Authorization: `Bearer ${credentials.claudeAiOauth.accessToken}`,
          "anthropic-beta": "oauth-2025-04-20",
          "User-Agent": "claude-cli/2.1.296 (external, cli)",
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(5_000),
      },
    );
    if (response.status === 429) {
      return { ...unavailable, status: "rate_limited", httpStatus: 429 };
    }
    if (response.status === 529) {
      return { ...unavailable, status: "overloaded", httpStatus: 529 };
    }
    if (!response.ok) {
      return { ...unavailable, httpStatus: response.status };
    }
    const usage = usageResponseSchema.parse(await response.json());
    if (usage.cedar_ember?.eligible !== true) {
      return unavailable;
    }
    const nowMilliseconds = (options.now ?? (() => new Date()))().getTime();
    const offers = usage.cedar_ember.grants
      .filter(
        (grant) =>
          grant.resets_left > 0 &&
          grant.paused !== true &&
          (grant.starts_at === null ||
            grant.starts_at === undefined ||
            Date.parse(grant.starts_at) <= nowMilliseconds) &&
          (grant.ends_at === null ||
            grant.ends_at === undefined ||
            Date.parse(grant.ends_at) > nowMilliseconds),
      )
      .map((grant) => ({
        label: grant.label,
        count: grant.resets_left,
        expiresAt: grant.ends_at ?? null,
      }));
    return { accountAlias: account.accountAlias, status: "ok", offers };
  } catch {
    return unavailable;
  }
}
