---
id: c0439a296a2c9dec2fb78ae2
title: 2026 08 26 Provider Contract Spike
desc: Evidence and implementation baseline for Claude and Codex quota collection
updated: 1788050836683
created: 1787789951052
---

# Provider Contract Spike

## Decision

Phase 0 is complete. The website-root endpoints in the draft are rejected. Version 1 will use supported local product interfaces where available and will represent unsupported metrics explicitly.

| Provider/account type                           | V1 source                                                                                  | Decision                                                                                                |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| Codex, ChatGPT Business or Enterprise           | Codex App Server over stdio, authenticated by a persistent profile or `CODEX_ACCESS_TOKEN` | Implement                                                                                               |
| Codex, personal Free/Go/Plus/Pro                | Codex App Server over stdio with an isolated persistent `CODEX_HOME` profile               | Implement after one interactive `codex login` per account                                               |
| Claude Pro/Max/Team/Enterprise with setup token | `claude auth status --json` with `CLAUDE_CODE_OAUTH_TOKEN`                                 | Implement plan/auth discovery; quota windows remain unsupported                                         |
| Claude Enterprise admin analytics               | Admin usage/spend APIs                                                                     | Defer; these are organization analytics/spend contracts, not the requested subscription-window contract |
| OpenAI or Anthropic API organizations           | Admin usage/rate-limit APIs                                                                | Defer; this is a different product target from ChatGPT/Codex and Claude subscription seats              |

The domain remains multi-window and provider-neutral. A status-only Claude result can be healthy while its `base` and `fable` metrics are explicitly unavailable; failure to authenticate remains an account error.

## Codex evidence and mapping

Official sources:

- [Codex App Server](https://learn.chatgpt.com/docs/app-server) documents the stdio JSONL transport, initialization handshake, `account/read`, and `account/rateLimits/read`.
- [Codex access tokens](https://learn.chatgpt.com/docs/enterprise/access-tokens) documents `CODEX_ACCESS_TOKEN` for trusted non-interactive Codex CLI and App Server workflows. It is currently limited to ChatGPT Business and Enterprise workspaces.
- [Codex authentication](https://learn.chatgpt.com/docs/auth) documents ChatGPT browser login, automatic token refresh, and file-backed `auth.json` storage under `CODEX_HOME`.
- [Codex pricing and usage](https://learn.chatgpt.com/docs/pricing) documents five-hour and possible weekly windows and the interactive `/status` view.
- [OpenAI Usage API](https://developers.openai.com/api/reference/resources/admin/subresources/organization/subresources/usage) is organization API activity, not ChatGPT subscription quota.

App Server mapping:

| App Server field                        | Normalized field               |
| --------------------------------------- | ------------------------------ |
| `account.planType` or bucket `planType` | `plan`                         |
| `rateLimitsByLimitId[*].limitId`        | limit key prefix               |
| `primary` / `secondary`                 | stable suffix and window scope |
| `usedPercent`                           | `usedPercent`                  |
| `windowDurationMins`                    | `windowDurationMinutes`        |
| `resetsAt` (Unix seconds)               | `resetAt` (ISO-8601)           |

Use the multi-bucket map when present and fall back to the backward-compatible single-bucket field. Start a separate App Server process per account. A personal subscription child receives only its persistent profile path; a managed-workspace access-token child receives only that account's token and an ephemeral profile. Kill the process after the two reads or on the eight-second deadline.

Do not use the experimental external ChatGPT-token login flow for production. Persistent Codex profiles live outside the repository with directory mode `0700` and `auth.json` mode `0600`.

## Claude evidence and mapping

Official sources:

- [Claude Code authentication](https://code.claude.com/docs/en/authentication) documents one-year setup tokens in `CLAUDE_CODE_OAUTH_TOKEN` for scripts.
- [Claude Code cheatsheet](https://support.claude.com/en/articles/14553413-claude-code-cheatsheet) documents `/usage` as an interactive command that shows plan usage and current rate-limit status.
- [Claude Code usage report](https://platform.claude.com/docs/en/api/http/admin/usage_report/retrieve_claude_code) documents daily organization analytics, not remaining subscription allowance.
- [Anthropic Rate Limits API](https://platform.claude.com/docs/en/manage-claude/rate-limits-api) documents configured Claude API organization limits and explicitly excludes individual accounts.
- [Anthropic Spend Limits API](https://platform.claude.com/docs/en/manage-claude/spend-limits-api) is Enterprise-only and reports monthly member spend against configured spend caps.

`claude auth status --json` is locally verified to expose authentication state and `subscriptionType`, but not quota windows. The documented `/usage` view has no verified machine-readable, non-interactive contract. Version 1 therefore maps:

| Claude CLI field   | Normalized field           |
| ------------------ | -------------------------- |
| `loggedIn`         | success/error decision     |
| `subscriptionType` | `plan`                     |
| base quota         | metric-level `unsupported` |
| Fable quota        | metric-level `unsupported` |
| reset time         | `null`                     |

Do not parse terminal control sequences, inspect browser traffic, call private Claude endpoints, or make an inference request merely to discover limits.

## Authentication configuration

Each Claude account definition names an environment variable; it never contains the credential itself. A personal Codex account names an isolated non-secret profile, while Business/Enterprise can optionally name an access-token environment variable.

```ts
export const accounts = [
  {
    accountAlias: "Anthropic_Personal",
    platform: "Claude",
    auth: {
      type: "claude_setup_token",
      credentialEnv: "CLAUDE_TOKEN_PERSONAL",
    },
  },
  {
    accountAlias: "Codex_Work",
    platform: "Codex",
    auth: {
      type: "codex_profile",
      profile: "codex-work",
    },
  },
] as const;
```

The Claude child receives the selected value as `CLAUDE_CODE_OAUTH_TOKEN`. A personal Codex child receives its dedicated `CODEX_HOME`; an optional managed-workspace token child receives `CODEX_ACCESS_TOKEN`. Parent secrets are not inherited wholesale by provider children.

## Fixture policy

- Codex fixtures are derived from the public App Server examples and contain no account data.
- Claude fixtures cover the documented `auth status` shape only.
- No live account response, email, organization ID, token, or real usage percentage is checked in.

## Re-baselined V1 acceptance

- Codex personal profile and Business/Enterprise access-token accounts report plan and all App Server quota windows.
- Claude setup-token accounts report plan plus explicit unsupported Base and Fable metrics.
- Unsupported account types remain visible as structured results and never trigger undocumented fallbacks.
- Adding a future supported Claude quota source requires only a new provider adapter and fixtures; interfaces retain the same public DTO.

## Live Pro profile verification

Verified both configured Codex Pro profiles on 2026-08-29. Each isolated App Server process authenticated as `pro` and returned the primary Codex quota plus separate primary/secondary model windows. Profile directories were mode `0700` and both `auth.json` files were mode `0600`.

No authentication payload, email returned by the provider, live usage percentage, or reset timestamp was persisted in this note or a fixture.
