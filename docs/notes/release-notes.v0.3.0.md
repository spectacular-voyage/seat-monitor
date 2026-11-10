---
id: sm-release-notes-v0-3-0
title: Release Notes v0.3.0
desc: CLI reads the dashboard server and marks stale quota, Claude and Codex reset offers, fleet forecasts, and lighter scans
updated: 1794336214548
created: 1794336214548
---

# Seat Monitor v0.3.0

This release stops the CLI from presenting stale quota as current. When a dashboard server is running, the CLI now reads that server's latest scan. Every output marks cached and old readings **STALE** with their age. The dashboard gains Claude and Codex reset offers, total fleet quota forecasts, vendor filters and compact history panels. Full scans use much less memory.

This is the first npm release since v0.1.9. v0.2.0 was published only as a GitHub Release, so upgrading from npm v0.1.9 also brings v0.2.0's changes, including its breaking configuration change (see **Upgrading from npm v0.1.9**).

## Added

- When a dashboard server is running for the same user, `seat-monitor` reads its latest scheduled scan from `/api/quota` instead of scanning providers itself. The server is used only if it reports exactly the CLI's configured accounts; otherwise the CLI scans directly and says why on `stderr`. Pass `--scan` to always scan directly. JSON reports `source`, and text and Markdown add a `FROM` line naming the server.
- Each successful account in CLI JSON and `GET /api/quota` reports `ageSeconds`, `stale` and `cachedAt`. A reading is stale when it is a cached fallback used after the provider throttled a live read (for example HTTP 429), or when it is older than 300 seconds. Text, Markdown and forecast output mark a stale account `STALE` with its observation time and age, and the dashboard shows a STALE pill on the account's card and row.
- The dashboard shows Claude limit reset offers, served by `GET /api/claude-resets`. Each account is checked at most every 20 minutes, with checks staggered and rotated across accounts. Checks back off after rate limits, and the last known offer is kept between checks. Explicit no-grant responses are recognized, and provider ineligibility reasons are kept.
- The dashboard shows Codex reset credits and their expiry, served by `GET /api/codex-resets` from the scheduled scan without extra provider requests.
- A total fleet quota graph shows Claude weekly and Codex primary consumption as a share of each provider's combined account quotas. It includes dashed projections up to the next reset or seven days.
- Dashboard vendor filters (Claude / Codex), remembered per browser, and floating section navigation.
- Per-account history can be ordered by Weekly %, alongside Session % and Weekly reset.
- `scanConcurrency` and `SEAT_MONITOR_SCAN_CONCURRENCY` (1 through 16, default 1) bound how many account checks run at once.

## Changed

- Claude quota is read from the provider's usage endpoint, with an identity-bound, timestamped cache fallback, instead of a heavyweight `claude /usage` process for every account. Default scans run one account at a time, and finished provider process groups are reaped. On an 18-account fleet, a full scan's combined process RSS stayed below 500 MB.
- Fleet throughput uses Claude weekly quota, and unknown Session graphs are hidden.
- History panel headings take one line: the reset countdown sits beside the limit name, and the combined weekly/Fable legend replaces the duplicated usage figures. Dashboard cards are more compact.
- A limit whose reset time has passed since the reading is reported as unknown, not as its old percentage.
- A stale account never drives the CLI's `USE` recommendation, and a stale `WATCH` target is flagged. Within a window, a stale percentage is a lower bound.

## Fixed

- The CLI no longer reports week-old cached Claude quota as current when the usage endpoint rate-limits it.
- When Claude `/usage` returns no quota windows, the account reports `quota_unavailable`. Its current reading, headroom and projection are unknown, even after earlier successful scans.
- Claude `/usage` output without a session line keeps its weekly windows, and the session is explicitly unknown rather than 0%.
- An unknown Claude session is not forecast from older history, and an `unauthorized` latest status no longer revives older projections.
- Verified Ultra accounts show their five-hour session limit as not applicable.
- A reset time that has passed with no observed usage drop is `reset_unconfirmed`: no relief is counted until usage is seen to drop.

## Upgrading from npm v0.1.9

These changes came with v0.2.0:

- **Breaking:** every Claude profile entry must include `auth.expectedEmail`. Before reading quota, Seat Monitor compares it case-insensitively with `claude auth status --json`; a different account returns `identity_mismatch` with a targeted login command. `accounts.example.json` and the README show the field.
- The server can listen on a trusted IPv4 LAN when `host` is `0.0.0.0` and `allowedHosts` names every accepted address. Loopback remains the default.

## Compatibility

- CLI JSON (`apiVersion` 1) and `GET /api/quota` add `source`, `ageSeconds`, `stale` and `cachedAt`; existing fields are unchanged.
- `seat-monitor` reads a running dashboard server by default; `--scan` restores a direct scan. A read from the server is not recorded again into local history, because the server already records it.
- Node.js 24 or later is still required. The history database needs no migration.

## Install

With npm:

```sh
npm install --global seat-monitor@0.3.0
```

With pnpm:

```sh
pnpm add --global seat-monitor@0.3.0
```
