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

## Install

With npm:

```sh
npm install --global seat-monitor
```

With pnpm 11 or 12:

```sh
pnpm add --global seat-monitor
```

If pnpm itself is not installed, [pnpm's current installation guide](https://pnpm.io/installation) uses `npx get-pnpm` for pnpm 11 or `npx get-pnpm next-12` for pnpm 12. Although pnpm 12 is stable, npm's `latest` tag still points to pnpm 11 as of 2026-08-30.

Then initialize the account configuration:

```sh
seat-monitor --init-config
```

The package exposes `seat-monitor`, `seat-monitor-server`, `seat-monitor-claude-login`, and `seat-monitor-codex-login` commands.

## Prerequisites

- Node.js 24 LTS or newer
- 1Password CLI (`op`) only when using optional environment-token modes
- Claude Code CLI 2.1.251 or newer for enabled Claude accounts
- Codex CLI with App Server support for enabled Codex accounts

For development from a repository checkout, install dependencies with:

```sh
npm ci
```

## Configure accounts

`seat-monitor --init-config` creates `~/.config/seat-monitor/accounts.json` with mode `0600`. Edit it with the accounts you want to scan and give each account a unique profile name:

```json
{
  "accounts": [
    {
      "accountAlias": "claude-personal@example.com",
      "platform": "Claude",
      "auth": {
        "type": "claude_profile",
        "profile": "claude-personal"
      }
    },
    {
      "accountAlias": "codex-personal@example.com",
      "platform": "Codex",
      "auth": {
        "type": "codex_profile",
        "profile": "codex-personal"
      }
    }
  ]
}
```

Set `SEAT_MONITOR_CONFIG` to an absolute path to use another file. `XDG_CONFIG_HOME` is honored on Unix-like systems. The configuration contains aliases and profile names, not credentials; keep it private if those identifiers are sensitive.

### Set up Claude profiles

List the configured Claude accounts and profile locations:

```sh
seat-monitor-claude-login --list
```

Log into each account once, confirming the intended Claude identity in the browser:

```sh
seat-monitor-claude-login 'claude-personal@example.com'
```

The command creates an isolated `CLAUDE_CONFIG_DIR` with mode `0700` and restricts `.credentials.json` to mode `0600`. Profiles default to `~/.local/share/seat-monitor/claude/<profile>`. Set `SEAT_MONITOR_CLAUDE_PROFILES_DIR` to an absolute path to use another location.

The monitor combines `claude auth status --json` with zero-token `claude --setting-sources "" --strict-mcp-config -p "/usage"` output. Empty setting sources skip user, project, and local settings, while strict MCP mode ignores configured MCP servers. On hosts with an enterprise `managed-mcp.json`, the monitor omits strict mode because Claude Code requires that managed policy to remain authoritative. Treat `.credentials.json` like a password and never place a profile inside the repository.

### Set up Codex Pro profiles

List the configured personal Codex accounts and their isolated profile locations:

```sh
seat-monitor-codex-login --list
```

Log into each account once, confirming the intended ChatGPT identity in the browser:

```sh
seat-monitor-codex-login 'codex-personal@example.com'
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

Copy `.env.op.example` to a local, ignored `.env.op` when token mode is needed. Only `op://` references belong there; never paste a resolved token into the repository. For unattended `op run`, use a narrowly scoped 1Password service account and `OP_SERVICE_ACCOUNT_TOKEN`. Service accounts cannot access built-in Personal, Private, Employee, or default Shared vaults, so create a dedicated read-only vault for monitor items.

## CLI

The default is an aligned terminal report led by two independent decisions:

- `USE`: the account/model group with at least 20% effective headroom whose usable window resets soonest.
- `WATCH`: the most-consumed limit in the fleet, with its position in the window.

`USE` ranks directly by reset time—there is no composite score. Claude account eligibility considers both session and shared weekly constraints. Fable remains nested under the shared weekly pool and shows the provider-reported percentage of its sub-cap without converting that percentage into a share of weekly allowance.

The local lead-line policy lives in `src/presentation/quota-policy.ts`. Spark is visible in account detail but excluded from `USE` and `WATCH`; `WATCH` considers account-wide limits and excludes nested model sub-caps such as Fable.

Claude session resets use clock-only timestamps. Seven-day windows always include weekday and date, so their resets remain unambiguous throughout the week.

```sh
seat-monitor
seat-monitor --format text
```

Markdown is available explicitly for documents:

```sh
seat-monitor --format md
```

Agent-safe raw JSON remains minified and contains no banners or logs on `stdout`:

```sh
seat-monitor --json
seat-monitor --format json
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
seat-monitor-server
```

Open <http://127.0.0.1:3000>. The server scans immediately at startup and continues scanning every 60 seconds by default, even when no dashboard is open. The dashboard reads the latest scheduled result every 60 seconds. Its masthead warns when an active quota is projected to exhaust or when the last completed scan is older than two configured scan intervals; only the stale-scan warning exposes a contextual **Refresh now** action. Fleet rows and history cards are ordered by the most recent observed usage increase. Account cards show current quota, local usage history, provider and inferred reset markers, usage rate, and exhaustion-versus-reset projections. Claude weekly and Fable history share one two-column graph with separate series and metrics, while Session occupies the third column. History controls show 1, 2, 5, or 10 quota periods; each graph uses its own window duration plus 5% context, so a Session period is five hours while a weekly period is seven days. Recommendation cards and diagnostic counts are kept below history.

`GET /api/quota` remains the same runtime-validated array as CLI JSON mode. Historical data is additive:

- `GET /api/history/scans` returns paginated normalized scan batches retained at raw resolution.
- `GET /api/history/analytics` returns bounded chart series, reset markers, projections, and general, fleet-watch, and Fable-aware recommendations. The optional `periods=1|2|5|10` query filters and downsamples every series against its own effective quota duration.

Both historical routes accept validated time ranges and return `Cache-Control: no-store`. They never trigger provider requests themselves; the dashboard reads them after `/api/quota` has completed a current scan.

### Local history

Successful and failed normalized account snapshots are recorded by both the installed CLI and server. The default SQLite database is `$XDG_STATE_HOME/seat-monitor/history.sqlite3`, falling back to `~/.local/state/seat-monitor/history.sqlite3`. It is created outside the repository with private directory/file modes where supported.

Defaults retain raw scans for 30 days and hourly rollups plus reset events for 365 days. Maintenance runs at startup and at most daily. Configure history with:

- `SEAT_MONITOR_HISTORY_PATH`: absolute SQLite database path;
- `SEAT_MONITOR_HISTORY_RAW_DAYS`: raw scan retention, from 1 to 3650 days; and
- `SEAT_MONITOR_HISTORY_RETENTION_DAYS`: total rollup/reset retention, from 1 to 3650 days.

Raw retention cannot exceed total retention. A history database failure does not change valid current quota output; historical routes return a redacted unavailable response instead.

Rates require at least three measured observations over 15 minutes and never cross a reset epoch. Projection uses a nondecreasing usage envelope so small provider regressions cannot move exhaustion later, then compares supported 30-minute, one-hour, three-hour, and full-epoch rates. Warnings use the fastest supported pace and show an early-to-baseline range when it is meaningful. Exhaustion times remain estimates, not provider facts. Fable strategy jointly considers Claude session, shared weekly, and Fable sub-cap headroom. It does not convert the provider-reported Fable percentage using the contextual Max-plan 50% ceiling.

### Server settings and scheduled scans

Server settings are optional. Seat Monitor reads `$XDG_CONFIG_HOME/seat-monitor/settings.json`, falling back to `~/.config/seat-monitor/settings.json`. Set `SEAT_MONITOR_SETTINGS` to another absolute path. A missing file preserves the defaults.

Copy the packaged `settings.example.json` or create a private file with this shape:

```json
{
  "scanIntervalSeconds": 60,
  "scanOnStartup": true,
  "port": 3000,
  "history": {
    "rawRetentionDays": 30,
    "retentionDays": 365
  },
  "dashboard": {
    "showSpark": true
  }
}
```

The scan interval accepts 30 through 3600 seconds. Scheduling is completion-based: Seat Monitor finishes a fleet scan, waits the configured interval, and then starts the next scan. Slow provider checks therefore never accumulate overlapping scheduled work. The stale-scan warning's contextual refresh coalesces with an in-flight scan and restarts the countdown.

Environment variables override the settings file:

- `SEAT_MONITOR_SCAN_INTERVAL_SECONDS`
- `SEAT_MONITOR_SCAN_ON_STARTUP`, as `true` or `false`
- `SEAT_MONITOR_PORT`
- `SEAT_MONITOR_HISTORY_RAW_DAYS`
- `SEAT_MONITOR_HISTORY_RETENTION_DAYS`
- `SEAT_MONITOR_SHOW_SPARK`, as `true` or `false`

Set `dashboard.showSpark` to `false` when Spark limits are not relevant. This hides Spark from dashboard analytics and activity ordering while preserving raw `/api/quota` output and CLI compatibility. A lone Codex primary graph expands across the complete three-column history row.

The settings file cannot enable remote listening. `SEAT_MONITOR_HOST` remains compatibility-only and still accepts only `127.0.0.1` or `localhost`.

The server:

- binds to loopback only;
- validates Host, Origin, and cross-site browser headers;
- applies a restrictive Content Security Policy;
- continues scheduled scans while the server process is running;
- coalesces simultaneous scans and caches snapshots for 30 seconds;
- recomputes reset countdowns when each API response is serialized; and
- redacts framework and provider errors.

Account checks run in parallel with a default concurrency of eight. Codex subprocesses retain the strict eight-second deadline; Claude subprocesses allow sixteen seconds because the headless CLI occasionally exceeds eight seconds even when credentials and quota output are healthy. Within one Claude account, authentication and `/usage` run sequentially.

An operating-system service is not required for scheduling. A future systemd user service, launchd agent, or Windows service may be used to start and keep `seat-monitor-server` running across logins or reboots. The application itself intentionally refuses non-loopback hosts because it does not implement remote authentication or TLS.

## Development

The npm scripts are the repository-development equivalents of the installed commands:

```sh
npm run quota
npm run claude:login -- --list
npm run codex:login -- --list
npm run dev
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

## Security

Report vulnerabilities privately according to [SECURITY.md](SECURITY.md). The [public-release security review](docs/notes/sm.review.2026-08-30-public-release-security.md) records the local-only threat model, audit evidence, accepted risks, and mandatory publication checklist.
