---
id: 7808e74951f04165af5b6238
title: Release Notes v0.1.4
desc: Local quota history, projections, fleet capacity, and Node 24
updated: 1788381560000
created: 1788381560000
---

# Seat Monitor v0.1.4

This release turns Seat Monitor into a local historical quota dashboard while preserving its existing CLI and current-quota API contracts.

## Added

- Normalized Claude and Codex scans are persisted in a private local SQLite database using Node's built-in SQLite module.
- Raw scans are retained for 30 days by default, then compacted into hourly rollups retained for 365 days. Both periods and the database path are configurable through environment variables.
- `GET /api/history/scans` exposes bounded, paginated normalized scan history.
- `GET /api/history/analytics` exposes chart-ready series, provider and inferred reset markers, usage rates, exhaustion projections, and general, fleet-watch, and Fable-aware recommendations.
- The dashboard now leads with a compact CLI-inspired fleet-capacity view and follows with responsive account cards and local SVG burndown graphs.
- Session, shared weekly, and Fable quota graphs can occupy three columns on wide displays. Fable remains identified as a sub-cap of Claude's shared weekly pool.

## Changed

- Node.js 24 LTS is now the minimum supported runtime and the primary CI/release runtime.
- Actual CLI and server scans are recorded once without changing CLI output formats, flags, or exit codes.
- Codex primary quota is shown before Spark limits in human reports and dashboard analytics. Spark remains visible but excluded from `USE` and `WATCH` decisions.
- The dashboard's title, vertical spacing, summary tiles, loading states, and disconnected `file://` preview are more compact and informative.

## Analytics policy

- Usage rates require at least three measured observations spanning 15 minutes and use a robust median pairwise slope.
- Projections never cross a reset epoch and distinguish exhaustion-before-reset, reset-before-exhaustion, flat usage, exhausted quota, and insufficient history.
- Fable strategy jointly considers session, shared weekly, and Fable sub-cap headroom without converting the provider-reported percentage using the contextual Max-plan ceiling.

## Security and compatibility

- The server remains loopback-only and the new historical routes inherit Host, Origin, cross-site request, CSP, redaction, and `no-store` controls.
- No credentials, profile contents, or raw provider responses are stored in SQLite.
- `GET /api/quota` retains its existing runtime-validated array contract.
- History failures do not suppress valid current quota output or contaminate CLI JSON.

## Install

With npm:

```sh
npm install --global seat-monitor@0.1.4
```

With pnpm:

```sh
pnpm add --global seat-monitor@0.1.4
```
