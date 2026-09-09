---
id: smtask20260908-tiered-history-compaction
title: 2026 09 08 Tiered History Compaction
desc: Continuously compact raw quota observations into bounded hourly and daily history
status: COMPLETED
updated: 1788906533000
created: 1788906190000
---

# Tiered History Compaction

## Problem

The initial retention policy kept one-minute raw scans for 30 days and ran maintenance once daily. `buildHistoryAnalytics` downsampled only after calculating its robust pairwise rate, so a seven-day request could pass thousands of points per limit into an O(n²) estimator. On the retained production history, the primary dashboard analytics request took approximately 51 seconds and kept the Node process CPU-bound. A failed refresh then exposed the dashboard's live-only fallback and replaced populated graphs with empty series.

## Decision

Use three physical storage levels:

- **Raw:** six hours. This preserves every observation across the supported 30-minute, one-hour, and three-hour recent-rate windows and the complete five-hour Session graph.
- **Hourly:** 30 days. Completed raw UTC hours are summarized before their source scan batches are deleted.
- **Daily:** 365 days by default. Completed hourly UTC days are summarized before their source hourly rows are deleted.

Compaction is checked every five minutes after scan recording and at service startup. Cutoffs align to completed UTC buckets, so a bucket is never repeatedly replaced from partial source data. Raw-to-hourly and hourly-to-daily writes and their corresponding deletes share one transaction. Each rollup preserves first/last/minimum/maximum usage, latest reset/window metadata, and the total underlying sample count.

`auto` history reads combine daily, hourly, and raw data without overlapping tier boundaries. Explicit `raw` reads remain exact and therefore cover only retained raw scan batches. Existing `hour` reads return the best retained detail, including daily points after hourly source expiration.

## Configuration

New defaults and preferred controls:

- `rawRetentionHours: 6` / `SEAT_MONITOR_HISTORY_RAW_HOURS`
- `hourlyRetentionDays: 30` / `SEAT_MONITOR_HISTORY_HOURLY_DAYS`
- `retentionDays: 365` / `SEAT_MONITOR_HISTORY_RETENTION_DAYS`

The pre-tier `rawRetentionDays` settings field and `SEAT_MONITOR_HISTORY_RAW_DAYS` environment variable remain compatibility aliases and convert days to hours. New hour-based configuration takes precedence.

## Migration and failure behavior

The `daily_limit_rollups` table is an additive extension to schema version 2. Existing version 1 databases first receive reset-event observation provenance and then the daily tier; version 2 databases create the optional table idempotently. `PRAGMA user_version` remains 2 because Stagecraft's current read-only launcher explicitly consumes that version. Existing hourly rows remain readable and become eligible for daily compaction.

History remains secondary to current quota. A compaction failure rolls back aggregate writes and source deletion together, degrades history health through the existing service boundary, and never suppresses a valid current snapshot.

## Verification

- Migration coverage from existing schema versions and rejection of newer versions.
- Tier-boundary coverage proving raw, hourly, and daily results in one `auto` query.
- Sample-count preservation and bounded point-count coverage across dense one-minute fixtures.
- Existing analytics, reset, CLI, server, and dashboard regression suites.
- Benchmark against a copied retained database; never mutate production history for performance testing.
- `npm run check` and `npm run package:check`.

## Benchmark

On a SQLite backup containing more than 8,400 six-account scans, first migration and compaction took 11.9 seconds. It retained 334 raw scan batches and 2,524 hourly limit rows. The same eight-day primary analytics request then completed in 314 ms with populated history for every current limit, versus approximately 51 seconds before compaction. The one-time migration cost occurs before normal five-minute incremental maintenance.

## Review

Local Claude Code was invoked for a read-only review, but its OAuth session had expired and could not refresh. The final manual audit tightened the transaction boundary so source reads, aggregate writes, and source deletion all occur under one `BEGIN IMMEDIATE` transaction. It also added explicit version 1 and version 2 migration assertions and ensured the preferred hour-based environment setting takes precedence without evaluating an invalid legacy days value.

## Completion

Completed on 2026-09-08. Dense raw history is now continuously reduced through bounded raw, hourly, and daily tiers. The copied-database benchmark reduced the primary analytics response from approximately 51 seconds to 314 ms without empty limit series. Final verification passed `npm run check`, `npm run package:check`, and `git diff --check`.
