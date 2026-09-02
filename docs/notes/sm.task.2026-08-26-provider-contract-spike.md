---
id: c0439a296a2c9dec2fb78ae2
title: 2026 08 26 Provider Contract Spike
desc: Evidence and implementation baseline for Claude and Codex quota collection
status: COMPLETED
updated: 1788365763239
created: 1787789951052
---

# Provider Contract Spike

## Decision

Phase 0 is complete. The website-root endpoints in the draft are rejected. Version 1 will use supported local product interfaces where available and will represent unsupported metrics explicitly.

| Provider/account type                                | V1 source                                                                                  | Decision                                                                                                |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| Codex, ChatGPT Business or Enterprise                | Codex App Server over stdio, authenticated by a persistent profile or `CODEX_ACCESS_TOKEN` | Implement                                                                                               |
| Codex, personal Free/Go/Plus/Pro                     | Codex App Server over stdio with an isolated persistent `CODEX_HOME` profile               | Implement after one interactive `codex login` per account                                               |
| Claude Pro/Max/Team/Enterprise with persistent login | `claude auth status --json` plus `claude -p "/usage"` in an isolated `CLAUDE_CONFIG_DIR`   | Implement plan, session, weekly-all-models, and weekly-Fable windows                                    |
| Claude Pro/Max/Team/Enterprise with setup token      | `claude auth status --json` with `CLAUDE_CODE_OAUTH_TOKEN`                                 | Retain as optional auth-only mode; quota windows remain unsupported                                     |
| Claude Enterprise admin analytics                    | Admin usage/spend APIs                                                                     | Defer; these are organization analytics/spend contracts, not the requested subscription-window contract |
| OpenAI or Anthropic API organizations                | Admin usage/rate-limit APIs                                                                | Defer; this is a different product target from ChatGPT/Codex and Claude subscription seats              |

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

`claude auth status --json` exposes authentication state and `subscriptionType`. Local comparison on Claude Code 2.1.251 established that `claude -p "/usage"` emits account quota without model tokens for a stored browser login, while a setup token emits only invocation statistics. The stored-login output is plain text rather than a versioned JSON schema, so the adapter uses strict, fixture-backed parsing and fails closed if the shape changes.

| Claude CLI field             | Normalized field             |
| ---------------------------- | ---------------------------- |
| `loggedIn`                   | success/error decision       |
| `subscriptionType`           | `plan`                       |
| `Current session`            | `base.session` quota window  |
| `Current week (all models)`  | `base.weekly` quota window   |
| `Current week (Fable)`       | `fable.weekly` quota window  |
| `resets ... (IANA timezone)` | canonical ISO-8601 `resetAt` |

Do not parse terminal control sequences, inspect browser traffic, call private Claude endpoints, or make an inference request merely to discover limits. The print-mode command reports zero input/output tokens.

## Authentication configuration

Personal Claude and Codex account definitions name isolated, non-secret profiles. Environment-variable token modes remain optional for integrations that deliberately inject credentials.

```ts
export const accounts = [
  {
    accountAlias: "Anthropic_Personal",
    platform: "Claude",
    auth: {
      type: "claude_profile",
      profile: "anthropic-personal",
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

A personal Claude child receives its dedicated `CLAUDE_CONFIG_DIR`; a personal Codex child receives its dedicated `CODEX_HOME`. Optional token-mode children receive only the selected provider token. Parent secrets are not inherited wholesale.

## Fixture policy

- Codex fixtures are derived from the public App Server examples and contain no account data.
- Claude fixtures cover the `auth status` shape and sanitized `/usage` text.
- No live account response, email, organization ID, token, or real usage percentage is checked in.

## Re-baselined V1 acceptance

- Codex personal profile and Business/Enterprise access-token accounts report plan and all App Server quota windows.
- Claude persistent-profile accounts report plan, Base session/weekly, and weekly Fable quota/reset windows.
- Claude setup-token accounts remain explicit auth-only results with unsupported Base and Fable metrics.
- Unsupported account types remain visible as structured results and never trigger undocumented fallbacks.
- Adding a future supported Claude quota source requires only a new provider adapter and fixtures; interfaces retain the same public DTO.

## Live Pro profile verification

Verified both configured Codex Pro profiles on 2026-08-29. Each isolated App Server process authenticated as `pro` and returned the primary Codex quota plus separate primary/secondary model windows. Profile directories were mode `0700` and both `auth.json` files were mode `0600`.

No authentication payload, email returned by the provider, live usage percentage, or reset timestamp was persisted in this note or a fixture.

An end-to-end `op run` smoke test on the same date confirmed that the configured Claude setup token and both Codex profiles succeed through the CLI and `GET /api/quota`. The dashboard HTML returned `200` with the expected Content Security Policy. Three other enabled Claude accounts correctly remained visible as `missing_credential` errors while their 1Password references were commented out.

## Claude print-mode discovery

On 2026-08-29, the exact `claude -p "/usage"` command was compared under stored-login and setup-token authentication. Stored login returned current-session, weekly-all-models, and weekly-Fable percentage/reset lines with zero model tokens; setup-token authentication returned only invocation cost statistics. This finding supersedes the earlier assumption that Claude subscription quota was interactive-only.

A configured isolated Claude profile was then verified end to end as a Max account with all three normalized windows. Testing also established that `DISABLE_TELEMETRY=1` makes Claude omit the Fable line from `/usage`; the profile adapter therefore leaves that flag unset while retaining credential isolation, disabled auto-update, and disabled error reporting. No live account identifier, percentage, or reset timestamp is persisted here.

Additional Max profiles established that Claude omits the reset suffix for a window at zero percent usage. The parser accepts this as an available zero-used window with `resetAt: null`; nonzero examples continue to require and parse the provider's reset timestamp.

## Claude headless reliability

On 2026-08-30, the `claude-account-one` profile intermittently failed the eight-second process deadline while the same `/usage` call completed successfully in isolation. A diagnostic call returned valid auth JSON and all three usage rows, but took 7.51 seconds—too close to the deadline for reliable concurrent scans. The profile and credentials were healthy.

Quota reads initially added Claude Code's `--safe-mode` flag. Authentication remained profile-backed, while project customizations, plugins, hooks, MCP servers, and other unrelated startup work were disabled. A later recurrence on two healthy profiles established that eight seconds still leaves too little margin for transient provider latency. Claude subprocesses therefore use a sixteen-second deadline while Codex retains eight seconds. Accounts continue to scan in parallel with concurrency eight, and provider output parsing still fails closed.

On 2026-09-01, Claude Code 2.1.252 returned only the subscription header under `--safe-mode` for two healthy Max profiles, omitting every quota window while exiting successfully. The same profiles returned complete quota output without safe mode. The quota command now uses `--setting-sources "" --strict-mcp-config` instead: user, project, and local settings plus configured MCP servers remain isolated, and all four tested profiles returned complete quota output in 0.8–1.3 seconds.

Enterprise `managed-mcp.json` files have exclusive control over MCP servers, and Claude Code refuses `--strict-mcp-config` when one is present. The monitor checks the documented system path on macOS, Linux/WSL, and Windows and omits strict mode on managed hosts. Empty setting sources still isolate user, project, and local settings, while the administrator's MCP policy remains authoritative.
