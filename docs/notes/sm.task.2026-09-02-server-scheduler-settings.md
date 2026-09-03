---
id: 0da223a15c5746e09f55065a
title: 2026 09 02 Server Scheduler Settings
desc: Server-owned background scans and file-backed operational configuration
status: COMPLETED
updated: 1788420923000
created: 1788382897000
---

# Server Scheduler and Settings

## Objective

Continue collecting quota history whenever `seat-monitor-server` is running, even when no dashboard is open. Make the scan cadence and related operational defaults configurable through a private JSON settings file while preserving existing environment variables, CLI/API contracts, cache coalescing, and loopback-only behavior.

## Decisions

- The scheduler is an in-process component owned by `seat-monitor-server`, not an operating-system scheduler.
- An optional future systemd user service, launchd agent, or Windows service may keep the server process running across logins or reboots.
- Canonical user settings live in a private JSON file, not SQLite.
- SQLite stores quota observations and scheduler results, not desired configuration.
- The first settings phase is file/read-only from the application's perspective. A web settings editor remains a separate product task because it adds a mutating API and atomic-write/reload semantics.

## Configuration

Default path:

- `$XDG_CONFIG_HOME/seat-monitor/settings.json`
- fallback `~/.config/seat-monitor/settings.json`
- override with absolute `SEAT_MONITOR_SETTINGS`

Initial shape:

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

Precedence is environment variables, then settings file, then built-in defaults. Existing environment variables remain supported. Add `SEAT_MONITOR_SCAN_INTERVAL_SECONDS`, `SEAT_MONITOR_SCAN_ON_STARTUP`, and `SEAT_MONITOR_SHOW_SPARK`.

The scan interval is bounded from 30 to 3600 seconds. History retention remains bounded from 1 to 3650 days, with raw retention no greater than total retention. Host is not exposed in the settings file; the existing loopback-only validation remains authoritative.

## Scheduling behavior

1. Optionally scan immediately when the server starts.
2. Wait for the scan to finish.
3. Start the configured delay only after completion.
4. Run the next scan through the existing coalescing snapshot cache.
5. Continue until graceful server shutdown.

Completion-based scheduling prevents overlap and avoids accumulating delayed work when provider subprocesses are slow. A manual refresh coalesces with an in-flight scheduled scan and restarts the interval from that observation. Ordinary dashboard reads return the latest cached result instead of independently initiating another periodic scan.

If the server is stopped, scans stop. The scheduler does not backfill missed wall-clock intervals; startup scanning restores a current observation after restart or sleep.

## Compatibility

- Keep `GET /api/quota` and its response DTO unchanged.
- Keep `?refresh=true` as a forced/manual refresh.
- Keep `SnapshotCache` freshness behavior for callers that do not enable scheduling.
- Keep exported server test composition scheduler-free unless scheduler options are explicitly supplied.
- Keep CLI scanning behavior unchanged.
- Keep every listener on loopback.

## Delivery

### Phase 1: settings

- Add strict runtime schemas, default-path resolution, missing-file defaults, and environment overrides.
- Add a generic `settings.example.json` to the npm package.

### Phase 2: scheduler

- Add completion-based scheduling, start/stop, interval restart after manual refresh, error isolation, and graceful close.
- Add latest-cache reads so dashboard polling does not duplicate provider scans.

### Phase 3: composition and documentation

- Wire effective settings into server port, history retention, and scheduler options.
- Document server-owned polling and the distinction from optional OS service management.

## Acceptance criteria

- A server with no HTTP clients continues scanning at the configured cadence.
- At most one provider scan is in flight through the shared cache.
- Scheduled timing begins after scan completion.
- Manual refresh restarts the next scheduled interval.
- Dashboard reads do not create a second polling cadence.
- Missing settings files preserve current defaults.
- Invalid files or environment overrides fail closed with a redacted startup error.
- Existing server injection tests remain deterministic unless scheduling is explicitly enabled.
- Node 24 type checking, tests, coverage, build, and package smoke pass.

## Implementation outcome

Completed on 2026-09-02:

- Added strict optional `settings.json` loading with file defaults and environment precedence.
- Added a completion-based in-process scheduler with startup scanning, failure isolation, countdown restart, and graceful shutdown.
- Added latest-snapshot cache reads so periodic dashboard requests do not become a second provider polling loop.
- Kept manual `?refresh=true` scans coalesced and restarted the scheduled interval from their completion.
- Applied settings-file retention defaults to the server history store without adding a new CLI failure dependency.
- Added `settings.example.json` to the published-package contract.
- Added a compatibility-default-on `dashboard.showSpark` setting so installations can omit Spark from dashboard analytics without changing raw quota or CLI output.
- Documented application scheduling versus optional OS process supervision.
- Added focused configuration, scheduler, cache, and no-HTTP-client server tests.

Verification:

- Node 24 type checking and all 113 tests pass.
- Coverage passes the repository floors at 84.20% statements, 75.47% branches, 86.85% functions, and 84.17% lines.
- Formatting, lint, build, release-note validation, packed-package smoke, dependency audit, registry signatures, and attestations pass.
