# Seat Monitor

Seat Monitor is a strict TypeScript service that presents multi-account Claude and Codex quota data through a JSON/Markdown CLI and a local web dashboard.

## Provider support

The original draft named website roots rather than authenticated quota endpoints. The implemented provider boundary follows the supported contracts found during the Phase 0 spike:

| Account type                                   | V1 behavior                                                                                                   |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Claude subscription with persistent login      | Reads plan plus session, weekly-all-models, and weekly-Fable quota/reset windows from `claude -p "/usage"`    |
| Claude subscription with `claude setup-token`  | Optional auth-only mode; Base and Fable quota remain explicit `unsupported` values                            |
| Codex on personal ChatGPT plans, including Pro | Reads plan and all quota windows from an isolated, persistent `CODEX_HOME` profile created with `codex login` |
| Codex on ChatGPT Business or Enterprise        | Supports the same profile mode or an environment-provided `CODEX_ACCESS_TOKEN`                                |
| API-organization usage and spend               | Out of scope for V1 because it is a different billing product from subscription seats                         |

Seat Monitor does not scrape dashboards, parse terminal control sequences, reuse browser cookies, or call private provider endpoints. See [the provider-contract spike](docs/notes/sm.task.2026-08-26-provider-contract-spike.md) for sources and mapping decisions.

## Prerequisites

- Node.js 22 or newer
- 1Password CLI (`op`) only when using optional environment-token modes
- Claude Code CLI for enabled Claude accounts
- Codex CLI with App Server support for enabled Codex accounts

Install dependencies:

```sh
npm ci
```

## Configure accounts

Edit the non-secret map in `src/config/accounts.ts`. Set `enabled: true` only for accounts you want to scan and give each account a unique profile name:

```ts
export const accountDefinitions = [
  {
    accountAlias: "Anthropic_Personal",
    platform: "Claude",
    auth: {
      type: "claude_profile",
      profile: "anthropic-personal",
    },
    enabled: true,
  },
  {
    accountAlias: "Codex_Work",
    platform: "Codex",
    auth: {
      type: "codex_profile",
      profile: "codex-work",
    },
    enabled: true,
  },
] as const;
```

### Set up Claude profiles

List the configured Claude accounts and profile locations:

```sh
npm run claude:login -- --list
```

Log into each account once, confirming the intended Claude identity in the browser:

```sh
npm run claude:login -- 'claude-account-three@example.com'
```

The command creates an isolated `CLAUDE_CONFIG_DIR` with mode `0700` and restricts `.credentials.json` to mode `0600`. Profiles default to `~/.local/share/seat-monitor/claude/<profile>`. Set `SEAT_MONITOR_CLAUDE_PROFILES_DIR` to an absolute path to use another location.

The monitor combines `claude auth status --json` with zero-token `claude --safe-mode -p "/usage"` output. Safe mode retains profile authentication while skipping project customizations, plugins, hooks, and MCP startup that are irrelevant to a quota read. Treat `.credentials.json` like a password and never place a profile inside the repository.

### Set up Codex Pro profiles

List the configured personal Codex accounts and their isolated profile locations:

```sh
npm run codex:login -- --list
```

Log into each account once, confirming the intended ChatGPT identity in the browser:

```sh
npm run codex:login -- 'codex-account-four@example.com'
npm run codex:login -- 'codex-account-six@example.com'
```

The command forces file-backed Codex authentication, creates the profile directory with mode `0700`, and restricts `auth.json` to mode `0600`. Profiles default to `~/.local/share/seat-monitor/codex/<profile>`. Set `SEAT_MONITOR_CODEX_PROFILES_DIR` to an absolute path to use another location.

Codex refreshes ChatGPT credentials in the persistent profile during use. Treat every profile's `auth.json` like a password: do not commit, copy into the repository, paste into logs, or put it in `.env.op`.

Business and Enterprise installations may instead use:

```ts
auth: {
  type: "codex_access_token",
  credentialEnv: "CODEX_TOKEN_WORK",
}
```

That optional mode resolves `CODEX_TOKEN_WORK` through 1Password and injects it as `CODEX_ACCESS_TOKEN` into an ephemeral Codex profile.

### Optional 1Password token mode

Claude setup-token and Codex managed-workspace access-token modes remain supported for environments that intentionally inject credentials. Claude setup-token mode verifies authentication but cannot retrieve subscription quota.

Only `op://` references belong in the tracked `.env.op`; never paste a resolved token into the repository. For unattended `op run`, use a narrowly scoped 1Password service account and `OP_SERVICE_ACCOUNT_TOKEN`. Service accounts cannot access built-in Personal, Private, Employee, or default Shared vaults, so create a dedicated read-only vault for monitor items.

## CLI

The default is an aligned terminal report led by two independent decisions:

- `USE`: the account/model group with at least 20% effective headroom whose usable window resets soonest.
- `WATCH`: the most-consumed limit in the fleet, with its position in the window.

`USE` ranks directly by reset time—there is no composite score. Claude account eligibility considers both session and shared weekly constraints. Fable remains nested under the shared weekly pool and shows the provider-reported percentage of its sub-cap without converting that percentage into a share of weekly allowance.

The local lead-line policy lives in `src/presentation/quota-policy.ts`. Spark is visible in account detail but excluded from `USE` and `WATCH`; `WATCH` considers account-wide limits and excludes nested model sub-caps such as Fable.

Claude session resets use clock-only timestamps. Seven-day windows always include weekday and date, so their resets remain unambiguous throughout the week.

```sh
npm run quota
npm run quota -- --format text
```

Markdown is available explicitly for documents:

```sh
npm run quota -- --format md
```

Agent-safe raw JSON remains minified and contains no banners or logs on `stdout`:

```sh
npm run quota -- --json
npm run quota -- --format json
```

Exit codes:

- `0`: every enabled account succeeded
- `1`: a valid snapshot contains at least one account error
- `2`: invalid flags, fatal configuration, or a failure before snapshots could be produced

Quota percentages are numbers, unavailable values are `null`, and reset countdowns are derived from canonical ISO-8601 `resetAt` values at serialization time.

Elapsed percentages marked `*` use the dated local constants in `src/presentation/quota-constants.ts`. If a provider's remaining time exceeds a local window constant, the row prints `CONSTANT-SUSPECT` with raw remaining time instead of an impossible elapsed percentage. Empty measured fields stay empty; `unsupported` is reserved for capabilities the provider does not define.

## Dashboard and API

Start the local server:

```sh
npm run dev
```

Open <http://127.0.0.1:3000>. The dashboard refreshes every 60 seconds and has a manual refresh control. `GET /api/quota` returns the same runtime-validated array as CLI JSON mode.

The server:

- binds to loopback only;
- validates Host, Origin, and cross-site browser headers;
- applies a restrictive Content Security Policy;
- coalesces simultaneous scans and caches snapshots for 30 seconds;
- recomputes reset countdowns when each API response is serialized; and
- redacts framework and provider errors.

`SEAT_MONITOR_PORT` can select another local port. V1 intentionally refuses non-loopback hosts because it does not implement remote authentication or TLS.

## Development

```sh
npm run typecheck
npm run lint
npm run format:check
npm test
npm run build
```

Run the complete quality gate with:

```sh
npm run check
```

Provider adapters accept injected clocks and process clients. Fixtures are derived from public provider examples and contain no live account identifiers, credentials, or usage values.
