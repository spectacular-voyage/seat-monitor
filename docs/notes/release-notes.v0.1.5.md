---
id: 50eeb74a6200a5bbc7d9588d
title: Release Notes v0.1.5
desc: Scheduled scans, configurable analytics, and a refined local quota dashboard
updated: 1788489899837
created: 1788489899837
---

# Seat Monitor v0.1.5

This release makes the local dashboard useful as an always-on quota monitor, improves exhaustion projections, and substantially refines history visualization while preserving existing CLI and current-quota API behavior.

## Added

- The server now owns a recurring scan scheduler, so history continues accumulating while the dashboard is closed.
- Private JSON server settings configure the scan interval, startup scan, port, history retention, and Spark visibility, with environment variables retained as overrides.
- A contextual stale-scan warning offers **Refresh now** only when scheduled collection falls behind.
- History controls now support ½×, 1×, 2×, 5×, and 10× quota periods, normalized independently for Session and weekly windows.
- A Fleet throughput section charts Claude Session and Codex primary account lines in separate vendor graphs, followed by the mean active-window slope for each vendor. Independent 1d, 1w, 1m, and 1yr controls apply scale-aware moving averages to suppress quantization spikes.
- `seat-monitor-server start`, `stop`, and `restart` manage an identity-verified detached server with private runtime state, startup acknowledgement, and persistent stdout/stderr logs. Bare invocation remains foreground-compatible.
- `seat-monitor --forecast` brings dashboard usage-rate and exhaustion analytics to text, Markdown, and a lean versioned JSON contract, including soonest-first risk ranking, uncertainty, reset provenance, and evidence counts.
- History now compacts continuously through six-hour raw, 30-day hourly, and long-term daily tiers, bounding analytics work while preserving sample counts and extrema before source deletion.
- `seat-monitor-server status` reports identity-verified managed state, both executables support `--version`, and the dashboard displays its serving package version. Background startup now prints progress and allows bounded time for first-start compaction.
- Graphs now anchor their right edge to the upcoming dashed reset marker, expose local day/time on pointer hover, explain inactive Claude Sessions as starting with the next message, and keep already-exhausted quotas out of persistent masthead warnings.

## Changed

- The dashboard leads with compact fleet capacity and active exhaustion warnings, then separates per-account usage history from fleet-wide throughput trends.
- Claude weekly and Fable history share a two-column graph with labeled percentages, separate metrics, solid actuals, dashed forecasts, and no duplicate rolling-reset markers. Session occupies the adjacent column at a matching graph height.
- Rate and outlook details use an accessible shared table. Claude and Codex account containers use visible burgundy and midnight-blue grouping while their inner panels remain neutral.
- Forecast axes show their endpoint date. Reset-first trends stop at the reset boundary instead of disappearing or projecting across the next quota epoch.
- Codex primary appears before Spark. Spark analytics can be hidden without changing raw quota or CLI output, and a lone primary graph fills the history row.
- The reported-limits diagnostic is now a reported/expected ratio, using retained per-account shape when a current account scan fails.
- When the implicit default port 3000 is occupied, server startup walks upward to the next available port. Explicitly configured ports remain exact.
- Source development rereads uncached dashboard assets on every request, so a browser refresh reflects HTML, CSS, and JavaScript edits without restarting `npm run dev`.

## Projection policy

- Exhaustion warnings use the fastest supported recent pace while retaining the longer-term baseline as a range when useful.
- A monotonic usage envelope prevents small provider regressions from moving projected exhaustion later.
- Projections remain evidence-gated, distinguish reset-before-exhaustion from exhaustion-before-reset, and never cross reset epochs.

## Security and compatibility

- The service remains loopback-only; settings, SQLite history, provider profiles, and credentials stay local.
- Existing CLI invocations, stdout formats, the JSON top-level array, and exit codes are unchanged; forecast output is available only through the additive `--forecast` flag.
- `GET /api/quota` retains its existing array contract. Historical API changes are additive, including the optional `periods=0.5` value.

## Install

With npm:

```sh
npm install --global seat-monitor@0.1.5
```

With pnpm:

```sh
pnpm add --global seat-monitor@0.1.5
```
