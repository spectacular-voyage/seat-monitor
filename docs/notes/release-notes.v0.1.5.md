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

## Changed

- The dashboard leads with compact fleet capacity, active exhaustion warnings, and activity-sorted account cards.
- Claude weekly and Fable history share a two-column graph with labeled percentages, separate metrics, solid actuals, dashed forecasts, and no duplicate rolling-reset markers. Session occupies the adjacent column at a matching graph height.
- Rate and outlook details use an accessible shared table. Claude and Codex account containers use visible burgundy and midnight-blue grouping while their inner panels remain neutral.
- Forecast axes show their endpoint date. Reset-first trends stop at the reset boundary instead of disappearing or projecting across the next quota epoch.
- Codex primary appears before Spark. Spark analytics can be hidden without changing raw quota or CLI output, and a lone primary graph fills the history row.
- Source development rereads uncached dashboard assets on every request, so a browser refresh reflects HTML, CSS, and JavaScript edits without restarting `npm run dev`.

## Projection policy

- Exhaustion warnings use the fastest supported recent pace while retaining the longer-term baseline as a range when useful.
- A monotonic usage envelope prevents small provider regressions from moving projected exhaustion later.
- Projections remain evidence-gated, distinguish reset-before-exhaustion from exhaustion-before-reset, and never cross reset epochs.

## Security and compatibility

- The service remains loopback-only; settings, SQLite history, provider profiles, and credentials stay local.
- Existing CLI formats, flags, stdout behavior, and exit codes are unchanged.
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
