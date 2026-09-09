---
id: 8d8f6fc3e63142efbb42eaf1
title: 2026 09 03 Expected Reset From History
desc: Carry a missing provider reset forward from the last known reset cadence
status: COMPLETED
updated: 1788503950000
created: 1788502382000
---

# Expected Reset From History

## Objective

When a current provider scan omits a reset timestamp, retain the most recently observed provider reset and, where the window is demonstrably periodic, calculate the next future reset. Present a carried or derived value as **expected**, never as a current provider fact.

The motivating case is `claude-ops@spectacular.voyage`: current session and weekly readings omit reset timestamps, while retained provider reset events establish a prior session anchor and weekly cadence.

## Decisions

- The current scan's reset timestamp always wins and keeps the `provider` provenance.
- Otherwise, use the most recently seen provider reset event for the same normalized account and limit identity.
- A still-future last-known reset may be carried as expected for any limit.
- An elapsed reset may be advanced only for Claude's shared weekly limit, whose seven-day period is supported by the existing local constant. Claude Session re-anchors after idle and must remain unknown once its last anchor has elapsed. Codex windows are not extrapolated without a separately established cadence.
- Advance the weekly reset by one calendar week in the configured display timezone, preserving local wall-clock time across DST. Refuse to extrapolate an anchor older than one weekly period or a result that is not strictly in the future.
- A derived reset has `expected` provenance. The dashboard renders `expected reset in …`; it must not render the provider-fact wording `resets in …`.
- The weekly derivation explicitly relies on the local seven-day Claude constant because Claude does not report `windowDurationMinutes`. `expected` therefore covers both the historical anchor and the locally known period.
- Fable continues to share its weekly parent's effective reset and provenance. It does not render a second reset label.
- Expected reset timestamps are display context only. They do not change projection status, warning eligibility, health tone, graph endpoints, recommendations, or provider reset markers.
- The live quota snapshot and `GET /api/quota` contracts remain unchanged. The provenance field is additive on history analytics only.
- History analytics API version 1 permits additive response fields. `resetSource` accepts a missing field as `null` for compatibility with stored or synthetic v1 objects.
- Failure to read retained reset events degrades history health but does not fail the analytics response.

## Implementation

- Preserve reset-event `lastSeenAt` provenance and update it whenever the provider repeats a known reset.
- Supply retained reset events to the analytics builder independently of the selected chart range, with a bounded retention-backed query rather than the chart's time axis.
- Add `resetSource: provider | expected | null` to each analytics limit.
- Carry a future timestamp or derive one bounded weekly calendar advance in the analytics layer.
- Render provider, expected, and unknown reset states distinctly in both overview and history cards.
- Preserve the shared two-row weekly/Fable reset layout and standalone Session typography.
- Keep expected resets out of provider-marker synthesis and projection inputs.

## Verification

- Unit coverage for current-provider precedence, future last-known carry-forward, one-week advancement, elapsed Session refusal, stale-anchor refusal, DST wall-clock preservation, and Fable inheritance.
- Store coverage for reset-event last-seen updates and schema migration.
- Dashboard asset coverage for the expected wording.
- Integration coverage that the server supplies retained events outside the selected chart range and survives an unavailable event read.
- Regression coverage that expected resets do not alter projections or become provider markers.
- Full `npm run check`.
- Independent review, preferably with Claude Code, with findings recorded below and resolved before completion.

## Review

Claude Code Opus reviewed the initial task read-only before implementation. Its verdict was **not sound as written**. The accepted findings were:

- Claude Session is re-anchored, not a fixed five-hour cadence; periodic extrapolation is now weekly-only.
- Claude durations are local constants rather than provider fields; that second inference is now explicit.
- Expected resets would have silently changed projection states, warnings, tones, endpoints, and marker provenance; they are now display-only.
- Fable inheritance must use its parent's resolved context rather than depend on row order.
- Reset-event lookup must not use the chart range or the reset timestamp as its observation axis; durable `lastSeenAt` is now required.
- Indefinite rollover, DST drift, live-fallback omission, additive-v1 compatibility, event-read failure, and account-key normalization all needed explicit handling and tests.

Claude Code Opus then reviewed the completed diff and requested two substantive changes: refuse nonexistent DST wall-clock targets instead of failing analytics, and preserve the pre-existing historical projection boundary when a current scan errors. It also identified the unbounded event lookup and nullable migration column as lower-severity corrections. All four were implemented with regression coverage.

Claude Code Sonnet performed a read-only follow-up review after those corrections, verified each disposition against the implementation and tests, found no regressions, and returned **APPROVE**. Its only non-blocking nit was a case-sensitive dashboard source assertion that could pass vacuously; that assertion was replaced with a check scoped to `createCapacityLimit`.

## Completion

Completed on 2026-09-03. The final implementation preserves current provider reset facts, uses retained `lastSeenAt` provenance for expected display values, advances only one recent Claude weekly calendar period, keeps elapsed Session anchors unknown, and isolates expected resets from projections, warnings, recommendations, and provider markers. The shared weekly/Fable countdown remains one larger two-row value.
