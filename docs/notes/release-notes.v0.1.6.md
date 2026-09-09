---
id: sm-release-notes-v0-1-6
title: Release Notes v0.1.6
desc: CLI exhaustion forecasts, bounded history analytics, and managed server lifecycle
updated: 1788914852000
created: 1788914852000
---

# Seat Monitor v0.1.6

This release answers **who exhausts next, and when** from the CLI, makes retained-history analytics fast enough for continuous dashboard use, and adds an observable managed server lifecycle.

## Added

- `seat-monitor --forecast` exposes dashboard-grade usage analytics in text, Markdown, and lean versioned JSON.
- Each forecast limit includes current consumption, `ratePercentPerHour`, `rateBasis`, projection status and timestamps, uncertainty range, minutes to exhaustion, reset provenance, sample count, and observation span.
- Forecast JSON includes a soonest-first risk ranking while preserving explicit insufficient-history, not-consuming, reset-first, exhaustion-before-reset, and already-exhausted states.
- `seat-monitor-server start`, `stop`, `restart`, and `status` manage an identity-verified detached server with private runtime state and persistent logs.
- `seat-monitor --version`, `seat-monitor-server --version`, `/api/server/status`, and the dashboard footer expose package identity.
- Fleet throughput graphs compare Claude Session and Codex primary consumption and vendor mean rates across day, week, month, and year ranges.

## Changed

- History continuously compacts through six-hour raw, 30-day hourly, and long-term daily tiers. Aggregate writes and source deletion are transactional, and SQLite schema version 2 remains compatible with the Stagecraft read-only consumer.
- On a copied retained database, primary analytics latency fell from approximately 51 seconds to 314 milliseconds after the one-time compaction.
- Background startup reports progress and allows up to 60 seconds for migration and identity-matched readiness acknowledgement.
- The implicit default port walks upward when occupied; explicitly configured ports remain exact.
- Graphs anchor their right edge to the upcoming dashed reset marker and work backward by the selected period. Historical provider resets remain solid.
- Pointer hover displays local day and time along usage and throughput x-axes.
- An inactive Claude Session says that it starts when a message is sent. Already-exhausted quotas remain visible in account detail without persistent masthead duplication.
- Reported-limit diagnostics use a reported/expected ratio and retain historical limit shape across current account errors.

## Compatibility

- Bare CLI text, Markdown, and JSON output remain unchanged. In particular, existing `seat-monitor --json` retains its top-level array contract.
- Existing CLI exit codes remain unchanged; launcher-specific gate exit codes are still a separate task.
- The historical API is additive. Chart point resolution may now identify retained daily rollups.
- `rawRetentionDays` and `SEAT_MONITOR_HISTORY_RAW_DAYS` remain accepted compatibility aliases for the preferred hour-based raw-retention setting.
- Seat Monitor does not add `whoami`; Stagecraft continues to own ambient profile identity.

## Install

With npm:

```sh
npm install --global seat-monitor@0.1.6
```

With pnpm:

```sh
pnpm add --global seat-monitor@0.1.6
```
