---
id: smtask20260908-cli-usage-rate-exhaustion
title: 2026 09 08 CLI Usage Rate and Exhaustion
desc: Versioned CLI forecasts and soonest-first exhaustion risk from retained history
status: COMPLETED
updated: 1788885510000
created: 1788884643000
---

# CLI Usage Rate and Exhaustion

## Objective

Close the highest-priority Stagecraft parity gap: after a fresh CLI scan is recorded, answer **who exhausts next, and when** using Seat Monitor's existing retained-history analytics.

The consumer contract is `stagecraft-lab/notes/sc.task.2026-09-03_2240-seat-monitor-consumer-contract.md`. This task implements its first priority only. Launcher verdicts and distinct gate exit codes remain the next task; account identity remains Stagecraft-owned, so this task does not add `whoami`.

## Compatibility boundary

- Bare `seat-monitor`, `--format text`, `--format md`, `--json`, and `--format json` retain their current output and exit codes.
- The existing JSON top-level array remains unchanged.
- `--forecast` is explicit and composes with text, Markdown, and JSON formats.
- `--forecast --json` is a separate, versioned object contract. It is deliberately lean and excludes history chart points, fleet-throughput series, and dashboard recommendations.
- Exit codes continue to describe scan/configuration success only. Forecast status does not alter them.

## Forecast contract

The version 1 machine result contains generation time, history health, accounts, and a soonest-first risk ranking. Each account limit carries:

- current consumed percentage;
- percent-per-hour rate and its evidence basis;
- explicit projection status;
- projected exhaustion timestamp and later uncertainty bound;
- minutes to the first projected exhaustion instant when derivable;
- effective reset timestamp and `provider | expected | null` provenance;
- sample count and observation span.

The ranking includes limits whose existing analytics establish `already_exhausted`, `exhausts_before_reset`, or `exhaustion_projected`. Other limits stay in the account detail with `insufficient_history`, `not_consuming`, or `reset_before_exhaustion`; they receive no invented ranking timestamp.

## Ownership and lifecycle

The CLI continues to wrap its scanner with `createRecordingScanner`. Forecast mode keeps the CLI-owned history service open after the scan, reads the just-recorded series and retained reset events, invokes `buildHistoryAnalytics`, reduces that result to the CLI contract, and only then closes the service. History-read failure degrades health but still yields current account data with explicit no-answer states.

Tests use injected scanners and in-memory SQLite history. Development and verification must not invoke live providers.

## Verification

- Unit coverage for unchanged legacy JSON, explicit text/Markdown mode, versioned lean JSON, ranking, uncertainty and minute derivation, every projection state, scan exit-code compatibility, history-read degradation, and read-before-close ownership.
- `npm run check`.
- `npm run package:check`.
- Independent read-only review, preferably Claude Code, with substantive findings resolved and recorded here.

## Review

Local Claude Code 2.1.263 was attempted first, but its OAuth session had expired and could not refresh. An independent read-only agent reviewed the complete dirty worktree and consumer contract instead.

The initial review found one substantive edge case and two documentation/coverage issues:

- A fresh 100% reading became `insufficient_history` when retained series were unavailable. The fix is in the shared analytics engine: current exhaustion evidence participates in projection without being inserted into chart points. Unavailable and unreadable-store regression fixtures cover it.
- README wording incorrectly implied `reset_before_exhaustion` never retains a hypothetical projected time. It now distinguishes account detail from risk-ranking eligibility.
- The promised thrown-history-read coverage was missing from the review snapshot. A closed-store test now proves degraded history health, preserved current output, and no fabricated time.

The independent follow-up verified all dispositions and returned **APPROVE**.

## Completion

Completed on 2026-09-08. `seat-monitor --forecast` records a fresh scan, reads retained history before closing CLI-owned storage, reuses `buildHistoryAnalytics`, and emits explicit text, Markdown, or a lean versioned JSON result with soonest-first exhaustion risk. Legacy output and exit codes remain unchanged. Final verification passed `npm run check` with 24 files and 158 tests, plus `npm run package:check`.
