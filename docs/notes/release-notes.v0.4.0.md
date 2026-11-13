---
id: sm-release-notes-v0-4-0
title: Release Notes v0.4.0
desc: Account details page, Max 5x versus Ultra, much lighter Codex scans and dashboard analytics, a 70 MB history shrunk to 15 MB, and restart-safe Claude 429 fallbacks
updated: 1794545877562
created: 1794545877562
---

# Seat Monitor v0.4.0

This release adds an **Account details** page that shows each seat's tier, next billing date and renewal state, and it tells Claude Max 5x from Ultra. It also cuts Seat Monitor's own disk use:

- Codex quota no longer launches the Codex App Server on every scan.
- The dashboard's history analytics are built once per scan and served from memory.
- The history database stores one reset event per reset, not one per scan.

On one 18-account fleet these changes removed about 500 MB/min of reads and shrank `history.sqlite3` from 70.6 MB to 15.3 MB.

## Added

- An **Account details** page at `/accounts`, linked from the dashboard's page navigation, served by `GET /api/accounts` (`apiVersion` 1).
  - **Per account:** tier, next billing date, whether the seat auto-renews or is set to expire, and subscription status. Every value says whether it came from the provider, was declared, or was estimated.
  - **Summary:** seats by tier, the next billing date, renewals due within seven days, and seats set to expire.
  - **Billing checks:** run in the background, one request per persistent profile using that profile's own credentials, at most every six hours.
  - **Cache:** a private file at `~/.local/state/seat-monitor/account-billing.json` (mode `0600`). It never stores tokens, email addresses, or account or organization IDs.
- Dashboard tier pills (_Ultra_, _Max 5x_, _Pro_) on at-a-glance rows and account cards.
- Claude Max 5x is told from Ultra: a profile whose identity-checked `.claude.json` names the plan `Ultra` counts as Ultra when Claude Code reports `max`.
- An optional per-account `billing` declaration in `accounts.json`, `{"renewalDay": 1-31, "autoRenew": boolean}`, fills dates the provider does not report and never overrides provider data.
- A **Show session** checkbox beside the per-account history controls removes Session charts from every card. It is checked by default and remembered per browser.

## Changed

- Persistent Codex profiles read quota from the two small HTTP endpoints the Codex App Server itself calls, instead of starting `codex app-server` on every scan.
  - **Why:** each launch read the profile's whole thread-state database, 79–156 MB per profile and about 580 MB per fleet scan.
  - **Fallback:** any HTTP failure falls back to the App Server and logs `codex-usage-fallback`.
  - **Unchanged:** token-injected Codex accounts keep using the App Server.
- `GET /api/history/analytics` builds each live range once per recorded scan and serves it from memory to every tab and refresh until the next scan. A live range is at least an hour long, ends after the newest scan, and ends within two minutes of the server clock. The history connection also uses a 16 MiB SQLite page cache.
  - **Before:** each refresh re-read about 110 MB of the history database per open tab.
  - **After:** a cached refresh takes milliseconds and reads nothing from disk.
- The dashboard server saves its last successful Claude reading per profile at most once a minute to `~/.local/state/seat-monitor/claude-usage.json` (mode `0600`).
  - **Why:** after a restart, it can answer an Anthropic 429 with the saved reading, marked **STALE** with its original time, instead of failing the account for its first scans.
  - **Privacy:** entries are keyed by a hash and hold no tokens, email addresses or paths.
  - **Removal:** an authorization error removes the profile's entry immediately.
- History stores one reset event per provider reset.
  - **Merging:** a reset time that jitters, or that rolls forward while a window has not started, updates the limit's latest event instead of adding a row every scan.
  - **Existing histories:** maintenance compacts events written one per scan by earlier releases, then returns the freed space with `VACUUM`.
  - **Reads:** answers are unchanged, because they only ever used each limit's latest event.
- Every per-account history chart is drawn at the same height, so Claude cards with and without a Session chart line up, and Codex cards match them.

## Compatibility

- No configuration changes are required. `billing` in `accounts.json` is optional.
- `GET /api/accounts` is new. Existing CLI JSON and `/api/quota` fields are unchanged.
- The history database keeps schema version 2. Its first maintenance after upgrading compacts reset events (about two seconds on a 70 MB history) and then shrinks the file. Earlier releases can still open it, so rolling back needs no migration.
- A live `/api/history/analytics` answer's `generatedAt` can trail the request by up to one scan interval.
- Node.js 24 or later is still required.

## Install

With npm:

```sh
npm install --global seat-monitor@0.4.0
```

With pnpm:

```sh
pnpm add --global seat-monitor@0.4.0
```
