# Seat Monitor

Seat Monitor is a strict TypeScript service that presents multi-account Claude and Codex quota data through a JSON/Markdown CLI and a local web dashboard.

## Provider support

The original draft named website roots rather than authenticated quota endpoints. The implemented provider boundary follows the supported contracts found during the Phase 0 spike:

| Account type                                          | V1 behavior                                                                                                                  |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Codex on personal ChatGPT plans, including Pro        | Reads plan and all quota windows from an isolated, persistent `CODEX_HOME` profile created with `codex login`                |
| Codex on ChatGPT Business or Enterprise               | Supports the same profile mode or an environment-provided `CODEX_ACCESS_TOKEN`                                               |
| Claude subscription with a `claude setup-token` token | Reads plan/authentication through `claude auth status --json`; Base and Fable quota fields are explicit `unsupported` values |
| API-organization usage and spend                      | Out of scope for V1 because it is a different billing product from subscription seats                                        |

Seat Monitor does not scrape dashboards, parse terminal control sequences, reuse browser cookies, or call private provider endpoints. See [the provider-contract spike](docs/notes/sm.task.2026-08-26-provider-contract-spike.md) for sources and mapping decisions.

## Prerequisites

- Node.js 22 or newer
- 1Password CLI (`op`)
- Claude Code CLI for enabled Claude accounts
- Codex CLI with App Server support for enabled Codex accounts

Install dependencies:

```sh
npm ci
```

## Configure accounts

Edit the non-secret map in `src/config/accounts.ts`. Set `enabled: true` only for accounts you want to scan, and give each account a unique environment-variable name:

```ts
export const accountDefinitions = [
  {
    accountAlias: "Anthropic_Personal",
    platform: "Claude",
    auth: {
      type: "claude_setup_token",
      credentialEnv: "CLAUDE_TOKEN_PERSONAL",
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

Add matching 1Password references to the tracked `.env.op` file:

```dotenv
CLAUDE_TOKEN_PERSONAL=op://Private/seat-monitor-claude-personal/password
```

Only `op://` references belong in `.env.op`. Never paste a resolved token into the repository.

For Claude, generate a subscription token with `claude setup-token`, save it directly in 1Password, and reference that field. Each Claude child process receives only its selected credential plus a small allowlist of required process variables.

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

## CLI

Markdown table output is the default:

```sh
op run --env-file=.env.op -- npm run quota
op run --env-file=.env.op -- npm run quota -- --format table
```

Agent-safe JSON output is minified and contains no banners or logs on `stdout`:

```sh
op run --env-file=.env.op -- npm run quota -- --json
op run --env-file=.env.op -- npm run quota -- --format json
```

Exit codes:

- `0`: every enabled account succeeded
- `1`: a valid snapshot contains at least one account error
- `2`: invalid flags, fatal configuration, or a failure before snapshots could be produced

Quota percentages are numbers, unavailable values are `null`, and reset countdowns are derived from canonical ISO-8601 `resetAt` values at serialization time.

## Dashboard and API

Start the local server:

```sh
op run --env-file=.env.op -- npm run dev
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
