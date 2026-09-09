---
id: smtask20260908-reset-anchored-graph-interaction
title: 2026 09 08 Reset Anchored Graph Interaction
desc: Reset-aware graph viewport, hover timestamps, and quieter persistent warnings
status: COMPLETED
updated: 1788909832000
created: 1788909659000
---

# Reset-Anchored Graph Interaction

## Objective

Make quota graphs explain their time axis and upcoming boundary directly. Remove masthead warnings whose condition is already obvious and remains true for days.

## Decisions

- A Claude Session with no reset timestamp says **Starts when a message is sent**. Session windows are re-anchored by activity; `Reset unknown` incorrectly implies missing information about an already-running clock.
- Masthead warnings include projected exhaustion before reset, but not `already_exhausted`. Exhausted state remains visible in current usage, graph, tone, and outlook without a persistent top-of-page duplicate.
- Historical provider reset markers remain solid. The current future reset is a dashed `projected` marker. Expected resets use the same future visual treatment while retaining their expected provenance in the marker title.
- When a limit has a future reset, the graph's right edge is that reset. The selected ½×, 1×, 2×, 5×, or 10× duration is worked backward from the reset, so narrower views may intentionally omit earlier history rather than hide the upcoming boundary.
- Limits without a usable future reset retain the existing now/forecast viewport.
- Usage and fleet-throughput SVGs add a pointer hover guide. Moving across a plotted line region displays the corresponding local month, day, and time along the x-axis.
- A truly empty selected range says **No measured history in this time range**, not that history begins after another scan.

## Verification

- Dashboard source assertions cover warning eligibility, Session wording, reset anchoring, projected marker styling, hover interaction, and honest empty-state copy.
- Existing analytics and reset-marker tests remain unchanged; this task changes presentation, not reset inference or projection policy.
- `npm run check` and `npm run package:check`.

## Review

The final source audit verified that only `exhausts_before_reset` reaches the masthead warning list; `already_exhausted` remains available to account tone and outlook. Future reset synthesis is presentation-only and does not alter analytics projection/reset provenance. The hover target is the final transparent SVG layer, so it receives pointer movement without obscuring lines, markers, or labels.

## Completion

Completed on 2026-09-08. Full verification passed `npm run check` with 24 files and 168 tests, `npm run package:check`, and `git diff --check`. The managed server was rebuilt and restarted at `http://127.0.0.1:3000/`; its served assets contain reset anchoring, hover interaction, Session-start wording, and no exhausted-quota masthead copy.
