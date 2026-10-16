import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import type { LoadedAccount } from "../config/accounts.js";

const usageResponseSchema = z.object({
  cedar_ember: z
    .object({
      grants: z
        .array(
          z.object({
            label: z.string().default("Limit reset"),
            resets_left: z.number().int().nonnegative(),
            starts_at: z.iso.datetime({ offset: true }).nullable().optional(),
            ends_at: z.iso.datetime({ offset: true }).nullable().optional(),
            paused: z.boolean().optional(),
          }),
        )
        .optional(),
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
  status: "ok" | "rate_limited" | "unavailable";
  offers: ClaudeResetOffer[];
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
      "https://api.anthropic.com/api/oauth/usage?at_wall=1&skip_spend=1",
      {
        headers: {
          Authorization: `Bearer ${credentials.claudeAiOauth.accessToken}`,
          "anthropic-beta": "oauth-2025-04-20",
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(5_000),
      },
    );
    if (response.status === 429) {
      return { ...unavailable, status: "rate_limited" };
    }
    if (!response.ok) {
      return unavailable;
    }
    const usage = usageResponseSchema.parse(await response.json());
    if (usage.cedar_ember === undefined || usage.cedar_ember === null) {
      return unavailable;
    }
    const nowMilliseconds = (options.now ?? (() => new Date()))().getTime();
    const offers = (usage.cedar_ember.grants ?? [])
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
