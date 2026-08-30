---
id: 2135ee1511100d0aa8923d2d
title: 2026 08 29 CLI Output Rework
desc: Decision-first quota ranking, hierarchy, provenance, and rendering rules
updated: 1788056147952
created: 1788055981286
---

# CLI Output Rework

## Primary decision

The human CLI answers “which account should I use next?” before it reports fleet risk. Headroom that resets soonest is spent first because it is cheapest to consume. A separate `WATCH` line identifies the limit most likely to interrupt an in-flight task.

No composite score is calculated.

## Field provenance

| Kind                 | Fields                                                                                                       | Rule                                                                                            |
| -------------------- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| Provider observation | account, plan, limit name, consumed percentage, reset/remaining time, and Codex window duration when present | Preserve as measured values.                                                                    |
| Local constant       | Claude session/weekly window lengths, Codex weekly fallback, Max Fable sub-cap fraction                      | Keep in one named table with source and checked date. Mark every derived display that uses one. |
| Derived              | headroom, elapsed time/percentage, Fable share of weekly allowance                                           | Render only when every required input exists. Missing inputs stay empty.                        |

The named constants live in `src/presentation/quota-constants.ts`:

- Claude session: 5 hours. Source: [Anthropic Pro plan](https://support.claude.com/en/articles/8325606-what-is-the-pro-plan), checked 2026-08-29.
- Claude weekly: 7 days. Source: the all-model weekly contract plus observed `/usage` windows, checked 2026-08-29.
- Codex weekly fallback: 7 days. Source: observed App Server duration, checked 2026-08-29. The measured App Server duration takes precedence.
- Fable sub-cap on Max: 50% of the shared weekly allowance. Source: [Anthropic Fable plan behavior](https://support.claude.com/en/articles/15424964-claude-fable-5-on-your-plan), checked 2026-08-29.

## Hierarchy

Claude session and weekly-all-models windows jointly constrain the account. Fable is a sub-cap of the weekly pool, not a sibling allowance:

```text
Claude account
├── Session
└── Week / all models
    └── Fable sub-cap
```

Fable shows consumed percentage of its sub-cap and, when the plan-specific fraction is known, its derived percentage of the weekly allowance. It does not show a second elapsed clock. `WATCH` may use the parent weekly elapsed/reset when Fable is tightest.

Codex primary/secondary windows are grouped by App Server `limitId`. All windows in a group must have meaningful headroom for that group to be a `USE` candidate.

## Selection

The meaningful-headroom threshold is the named product policy constant `MINIMUM_USABLE_HEADROOM_PERCENT`, currently 20%.

For each capacity group:

1. Require known headroom at or above the threshold for every applicable window.
2. Select the earliest known reset inside that viable group.
3. Rank groups across the fleet by reset instant.
4. Break exact ties by account alias and then group key.

Claude Base eligibility therefore uses the smaller headroom across session and shared weekly windows. A nearly empty weekly pool cannot be hidden by a fresh session window.

`WATCH` ranks measured limits by consumed percentage. An exact consumed tie prefers the lower elapsed percentage because the same consumption earlier in a window is riskier, then uses stable account/key tiebreaks.

## Consistency and missing data

Elapsed position is computed only when reset/remaining time and a window length both exist. If remaining time exceeds a local constant, or derived elapsed percentage falls outside 0–100, elapsed stays empty and the row shows raw remaining time plus `CONSTANT-SUSPECT`.

An unsupported provider capability renders as `unsupported`. A field omitted by a provider is unknown and renders empty. Neither case renders as zero or the ambiguous `N/A`.

## Output formats

- Default: aligned plain text with `QUOTA`, standalone `USE`/`WATCH` lines, then vendor/account groups.
- `--format md`: the same report semantics in Markdown.
- `--format json` or `--json`: unchanged minified raw snapshot array for programmatic consumers.
- `--format table`: backward-compatible alias for Markdown.

If the two lead lines are removed in a future design, the grouped body must be replaced by a flat fleet ranking because the cross-cutting decision would otherwise disappear.
