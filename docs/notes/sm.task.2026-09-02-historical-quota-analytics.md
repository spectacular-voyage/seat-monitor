---
id: 7bdb5783b2c14d75b6dcad4e
title: 2026 09 02 Historical Quota Analytics
desc: Local snapshot history, projections, retention, Fable strategy, and dashboard cards
status: COMPLETED
updated: 1788420923000
created: 1788377021465
---

# Historical Quota Analytics

## Status

Implemented on 2026-09-02. The repository review, architecture gate, storage and analytics work, additive APIs, dashboard redesign, and automated verification are complete.

## Objective

Persist normalized Claude and Codex scan snapshots locally, expose bounded historical and analytics APIs, and replace the quota table with account cards containing usage graphs. Add reset markers, usage-rate and exhaustion projections, tiered retention, and Fable-aware strategy without changing existing CLI output or the `GET /api/quota` contract.

## Baseline

- The normalized snapshot and public DTO contracts are runtime validated with Zod.
- CLI JSON and `GET /api/quota` share the same public array DTO.
- The server coalesces scans and keeps a 30-second in-memory freshness cache.
- The CLI calls the scanner directly.
- The dashboard is dependency-free HTML, CSS, and browser JavaScript.
- `USE` requires at least 20% effective headroom and ranks viable groups by soonest reset.
- `WATCH` ranks account-wide consumption and excludes nested Fable and ignored Spark limits.
- Fable is a child sub-cap of Claude's shared weekly pool. Its provider percentage is not converted into a share of weekly allowance.
- The service is single-user and loopback-only. Account aliases, plans, quota values, and reset times are protected local data.

The pre-change quality gate passes 15 test files and 80 tests, along with type checking, linting, formatting, release-note validation, and production build.

## Decisions

### Runtime

Use Node.js 24, the latest LTS line at the decision date. Set the package engine floor to `>=24.0.0` and run the primary CI/package smoke lane on Node 24.

### Database

Use SQLite through the built-in `node:sqlite` module.

Reasons:

- The workload is local, append-oriented telemetry with low write concurrency.
- SQLite provides a compact, inspectable database file and atomic transactions.
- WAL mode supports simultaneous local readers and one serialized writer, covering a running server plus occasional CLI scans.
- `node:sqlite` adds no runtime package, native addon, install script, or PostgreSQL WASM/data-directory footprint.
- PGlite's PostgreSQL compatibility is not useful while remote multi-user service remains out of scope.

Hide the binding behind a small history-store interface so a future storage implementation does not affect scanner, API, analytics, or presentation contracts.

### Compatibility

- Keep `seat-monitor`, its flags, stdout formats, stderr discipline, and exit codes unchanged.
- Keep `GET /api/quota` as the existing runtime-validated array.
- Keep the 30-second scan cache and refresh/coalescing behavior.
- Add routes; do not version or wrap the existing route.
- Historical recording failure must not suppress a valid current scan or contaminate JSON stdout.
- Keep legacy `USE` and `WATCH` results unchanged. Historical strategy is additive.

### Account identity

Persist an opaque account key separately from the display alias. The first implementation may derive it from platform plus the case-folded alias and must never persist credentials or raw auth material. An alias rename may begin a new series unless a later explicit stable configuration ID is introduced.

## Data flow

```text
provider adapters
      |
existing scanner
      |
recording scanner -----------------> SQLite history store
      |                                      |
SnapshotCache                               history queries
      |                                      |
GET /api/quota                         analytics engine
                                             |
                           GET /api/history/scans
                           GET /api/history/analytics
                                             |
                                      card dashboard
```

The recording wrapper is inside `SnapshotCache`, so only actual provider scans are recorded. Cache hits do not create duplicate history. CLI scans use the same wrapper without changing presentation.

## Storage design

### Location and permissions

- Default: `$XDG_STATE_HOME/seat-monitor/history.sqlite3`.
- Fallback: `~/.local/state/seat-monitor/history.sqlite3`.
- Override: absolute `SEAT_MONITOR_HISTORY_PATH`.
- Create the Seat Monitor state directory with mode `0700` and the database with mode `0600` where the operating system supports POSIX modes.
- Never create the database inside the repository by default.

### SQLite settings

- `PRAGMA journal_mode = WAL`
- `PRAGMA foreign_keys = ON`
- `PRAGMA busy_timeout = 5000`
- Bounded `BEGIN IMMEDIATE` write transactions
- Periodic WAL checkpoint and `PRAGMA optimize` during maintenance

### Tables

`scan_runs`

- integer primary key
- source: `cli` or `server`
- completion instant
- account count and error count

`account_snapshots`

- scan-run foreign key
- opaque account key
- display alias at observation time
- platform, observed instant, status, and plan
- stable redacted error code and message for failures

`limit_snapshots`

- account-snapshot foreign key
- normalized key, label, scope, and availability
- used percentage, window duration, and absolute reset instant

`reset_events`

- account and limit identity
- reset instant and event kind
- first observation instant
- unique constraint to prevent duplicate provider markers

`hourly_limit_rollups`

- account, plan, and limit metadata
- UTC hour bucket
- first, last, minimum, maximum, and average used percentage
- sample count, last reset instant, and last window duration

`history_metadata`

- schema version and last-maintenance instant

Do not persist raw provider responses, credentials, credential environment values, browser state, or profile contents.

## Retention

Defaults:

- Raw scan batches: 30 days.
- Hourly rollups and reset events: 365 days.
- Maintenance: at startup and at most once per 24 hours after a recorded scan.

Configuration:

- `SEAT_MONITOR_HISTORY_RAW_DAYS`
- `SEAT_MONITOR_HISTORY_RETENTION_DAYS`

Both values are positive bounded integers, and raw retention cannot exceed total retention. Maintenance first creates idempotent hourly rollups and retains reset events, then deletes expired raw runs transactionally. Old rollups and reset events are deleted at the total-retention boundary.

## Historical APIs

All new routes inherit the current Host, Origin, `Sec-Fetch-Site`, CSP, redaction, and loopback restrictions. Responses use `Cache-Control: no-store`.

### `GET /api/history/scans`

Purpose: exact retained normalized scan batches.

Query:

- `from` and `to`: ISO instants with a bounded range
- `limit`: bounded page size
- `before`: opaque/integer cursor for descending pagination

Response:

- generated instant
- retained range metadata
- scan source and completion instant
- exact normalized account snapshots
- next cursor when another page exists

### `GET /api/history/analytics`

Purpose: chart-ready usage series and decisions.

Query:

- `from` and `to`: ISO instants
- `resolution`: `auto`, `raw`, or `hour`
- `periods`: optional `1`, `2`, `5`, or `10` multiplier applied independently to each quota window
- optional account alias filter

Response:

- history health and effective resolution
- selected period multiplier
- latest completed scan, configured scan interval, and per-account latest observed activity
- latest persisted snapshot batch
- per-account/per-limit series
- reset markers
- usage rate and exhaustion projection
- general, watch, and Fable strategy recommendations

Requests are bounded by maximum date ranges, page sizes, and returned point counts. Invalid queries return the existing redacted `invalid_request` shape.

## Analytics rules

### Window segmentation

- Partition observations by account and limit key.
- Treat equal non-null `resetAt` values as one quota epoch.
- A changed reset instant starts a new epoch.
- A material downward usage jump with no usable reset timestamp may start an inferred epoch.
- Never fit a rate across an epoch boundary.

### Usage rate

- Use only the latest epoch.
- Require at least three distinct observations spanning at least 15 minutes.
- Require a measurable usage change rather than treating rounding noise as consumption.
- Estimate percentage points per hour with the median of pairwise slopes.
- A non-positive or invalid slope yields no exhaustion projection.
- Return sample count and observation span so the UI can label the estimate honestly.

### Exhaustion projection

- Project from the most recent observed percentage at the estimated rate.
- Compare the projected 100% instant with the canonical reset instant.
- Distinguish `exhausts_before_reset`, `reset_before_exhaustion`, `already_exhausted`, `not_consuming`, and `insufficient_history`.
- Do not present more timestamp precision than the underlying samples justify.

### Reset markers

- Emit solid provider markers only when a previously reported fixed boundary is crossed and the provider advances the window.
- Suppress rolling reset forecasts whose reset and observation timestamps advance in lockstep, along with small timestamp jitter.
- Emit a distinct provider-adjustment marker when a reset moves significantly out of step before its boundary; this retains provider generosity and unexplained changes without turning forecasts into events.
- Emit dashed inferred markers only for a material drop without a usable provider boundary.
- Label inferred markers as approximate.
- Fable uses its weekly parent clock for presentation so one shared reset is not drawn twice.

## Strategy

### General

Preserve existing `USE`: every applicable account-wide window must have at least 20% headroom, then viable groups are ranked by soonest reset with stable tie-breaking.

Historical projection augments the dashboard explanation but does not silently alter the CLI recommendation. An account predicted to exhaust before reset is labelled at risk.

### Watch

Preserve existing `WATCH`: rank measured account-wide limits by consumption, exclude nested sub-caps and ignored Spark limits, and retain current elapsed-position tie-breaking.

### Fable

A Fable task is viable only when all available constraints have meaningful headroom:

- Claude session
- shared weekly all-models pool
- Fable weekly sub-cap

Fable strategy uses the tightest current headroom and earliest projected constraint. If the Fable sub-cap is at risk while shared Base capacity remains healthy, recommend another Claude account or non-Fable work rather than declaring the whole account exhausted.

The provider-reported Fable percentage remains a percentage of its own sub-cap. The documented Max-plan 50% ceiling remains provenance/context and is never multiplied into a fabricated share of weekly allowance.

## Dashboard

Replace the account/limit table with responsive account cards.

Each card includes:

- account alias, platform, plan, status, and observation age
- current used percentage and reset countdown per limit
- dependency-free SVG history graph with a fixed 0–100% axis
- solid provider reset markers and dashed inferred markers
- dotted forecast segment where projection is valid
- rate, projected exhaustion/reset-first result, and sample basis
- general and Fable-aware strategy copy

The masthead warning region reports projected exhaustion for active account limits and reports stale collection when the latest completed scan is older than two configured server intervals. There is no persistent manual scan button; a contextual `Refresh now` action appears only with the stale warning. Accounts are ordered by their latest observed usage increase, followed by observation time and stable alias tie-breaks. Recommendation cards and fleet diagnostic counts are secondary information below the complete history list.

Claude weekly and Fable remain visually hierarchical. Fable is indented or dashed beneath the shared weekly pool and does not receive an independent reset clock. Codex windows remain grouped by provider limit ID.

Range controls support 1×, 2×, 5×, and 10× quota periods. Each graph uses its own effective window duration plus 5% context: five hours for Session, seven days for weekly limits, and the provider-reported duration when available. The client requests `auto` resolution. Empty, first-scan, partial-error, total-error, insufficient-history, and unavailable-history states must be explicit.

Continue assigning provider-controlled strings through DOM `textContent`; do not introduce `innerHTML`, external chart scripts, CDN assets, or inline scripts that weaken CSP.

## Failure behavior

- Current scans remain availability-critical; history is secondary.
- A database open or write failure does not change a valid `/api/quota` payload or CLI JSON payload.
- Historical routes return a redacted unavailable/degraded status or `503` without exposing filesystem paths or SQLite errors.
- Database corruption, lock exhaustion, and invalid migration state are covered by tests.
- A failed account snapshot is retained as a normalized redacted failure during the raw-retention period.

## Implementation phases

### Phase 1: runtime and storage foundation

- Set Node 24 engine and CI baseline.
- Add history configuration and path validation.
- Implement the history-store interface, SQLite adapter, migrations, permissions, and in-memory test mode.
- Add exact snapshot transaction/round-trip tests.

Exit: a scan batch survives close/reopen and reconstructs to the normalized domain schema.

### Phase 2: recording and retention

- Add the recording-scanner decorator.
- Compose it inside the server cache and around default CLI scans.
- Add WAL/busy behavior, reset-event insertion, hourly rollup, pruning, and daily maintenance.
- Prove cache hits do not create duplicate runs.

Exit: real scans from both entry points persist once while legacy output and failure semantics remain unchanged.

### Phase 3: analytics and strategy

- Implement pure series grouping, epoch segmentation, reset detection, robust rate estimation, and projection.
- Reuse current quota-report hierarchy and decision policy.
- Add Fable-specific strategy without percentage conversion.

Exit: deterministic fixture tests cover resets, plateaus, rounding noise, sparse history, exhaustion before reset, reset before exhaustion, Fable scarcity, and unsupported Fable.

### Phase 4: historical APIs

- Add strict query and response schemas.
- Add exact scan pagination and bounded analytics series routes.
- Apply existing local request controls and `no-store`.
- Add API compatibility and redaction integration tests.

Exit: `/api/quota` still validates against its existing schema; new APIs expose only normalized local data.

### Phase 5: dashboard cards

- Replace the table with responsive account cards.
- Implement SVG series, reset markers, forecast treatment, range controls, and accessible textual equivalents.
- Preserve refresh coalescing and countdown updates.

Exit: the dashboard supports healthy, partial, failed, empty, and insufficient-history fleets at desktop and mobile widths.

### Phase 6: hardening and release readiness

- Update README, security review, release notes, configuration examples, and package smoke checks.
- Verify file permissions, retention bounds, migrations, graceful close/checkpoint, and absence of stored secrets.
- Run typecheck, lint, formatting, tests, coverage, release checks, build, and packed-artifact smoke tests.

Exit: a clean Node 24 installation records local history, serves analytics on loopback, and passes the complete release gate.

## Acceptance criteria

- Node 24 is the declared and tested runtime floor.
- SQLite is the only history engine and adds no npm runtime dependency.
- Every actual default CLI/server scan is recorded at most once.
- Current CLI formats, flags, stdout shape, and exit codes remain compatible.
- `GET /api/quota` retains its existing array contract.
- Historical routes are loopback-only, bounded, validated, redacted, and `no-store`.
- Raw history and hourly retention follow configured bounds.
- Projections never cross reset epochs or appear with insufficient evidence.
- Provider and inferred reset markers are visually and structurally distinct.
- General and `WATCH` policy remain compatible with the current CLI.
- Fable strategy honors session, shared weekly, and nested sub-cap constraints without inventing quota.
- Spark visibility is configurable for dashboard analytics; disabling it leaves raw quota and CLI behavior unchanged and expands a lone Codex primary graph across the history row.
- The dashboard uses account cards and accessible local SVG graphs without weakening CSP.
- History failures do not suppress fresh quota data or leak filesystem/database details.
- No credentials or raw upstream payloads enter the database, API, logs, fixtures, or package.

## Out of scope

- Remote or multi-user service deployment
- Authentication or TLS for non-loopback listeners
- Alerts, notifications, or external integrations
- Provider API-organization spend analytics
- Editing account configuration in the browser
- Importing historical data from provider dashboards
- Treating an inferred reset or projection as a provider fact

## Implementation outcome

- Raised the runtime and primary CI lane to Node.js 24 LTS.
- Added a zero-dependency `node:sqlite` history store with private path handling, forward-only schema version checks, WAL, exact normalized scan reconstruction, provider reset events, hourly rollups, and tiered pruning.
- Added failure-tolerant scan recording around default CLI scans and inside the server's existing coalescing cache.
- Added pure reset-epoch segmentation, median pairwise usage rate, exhaustion/reset comparison, inferred markers, and Fable-aware strategy while reusing the existing general `USE` and `WATCH` policy.
- Added `GET /api/history/scans` and `GET /api/history/analytics` with strict queries, runtime-validated responses, pagination/range bounds, `no-store`, and the existing loopback security controls.
- Replaced the quota table with a compact CLI-inspired fleet-capacity overview plus responsive activity-sorted account cards, masthead exhaustion/staleness warnings, local SVG charts, three-column quota-window history, period-normalized range controls, current/reset/rate/outlook text, evidence-based fixed/adjusted/inferred reset markers, and visually nested Fable treatment. Reset-first projections no longer create an empty forecast extension. Secondary recommendations and diagnostic counts sit below history.
- Documented storage location, environment configuration, retention, API behavior, projection limits, and Fable semantics in the README.

Verification on 2026-09-02:

- Node 24.20.0 type checking and all 100 tests pass.
- Coverage passes the repository floors: 83.81% statements, 74.52% branches, 86.56% functions, and 83.71% lines.
- Lint, changed-file formatting, `git diff --check`, browser-JavaScript syntax, release-note validation, production build, and packed-package smoke tests pass.
- `npm audit --audit-level=high` reports zero vulnerabilities; registry signatures and attestations verify.
- The complete repository-wide formatting wrapper is currently obstructed by an unrelated untracked `docs/notes/sm.product-ideas.md`; this implementation does not modify that file.
- Automated browser payload/static-asset coverage passes. Live visual QA could not run because the available browser extension blocks loopback URLs and no in-app browser was connected; responsive visual inspection remains the only manual follow-up.
