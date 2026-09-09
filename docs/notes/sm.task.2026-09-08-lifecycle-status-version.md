---
id: smtask20260908-lifecycle-status-version
title: 2026 09 08 Lifecycle Status and Version
desc: Bounded detached startup, truthful status, and observable package identity
status: COMPLETED
updated: 1788908157000
created: 1788907591000
---

# Lifecycle Status and Version

## Problem

`seat-monitor-server start` appeared to hang. The resolved global executable was Seat Monitor `0.1.1`, whose server command predates lifecycle subcommands and treats every invocation as a foreground server. The process therefore listened on port 3000 under the literal `start` argument without writing managed runtime state; `/api/server/status` returned 404.

This matters beyond dashboard availability. Stagecraft's launcher treats the Seat Monitor SQLite file as a live prerequisite: its default read policy rejects evidence older than 138 seconds, requires eight current-epoch samples, and derives reservation timeout from 13 cadence gaps. A scanner interruption therefore blocks seating within roughly two and a half minutes and needs several successful scans to recover.

## Decisions

- Add `seat-monitor-server status` with identity-verified states: running is exit 0; absent, dead-stale, or unverified state is exit 1.
- Keep `start` readiness-gated and bounded. Print immediate progress and allow up to 60 seconds for first-start migration/listen acknowledgement; failure still terminates the spawned child and returns nonzero.
- Add `--version` to both `seat-monitor` and `seat-monitor-server` without scanning or starting a server.
- Add the package version to `/api/server/status` and render it in the dashboard footer.
- Extend the packed-install smoke test to execute server help and both executable version probes. This specifically prevents another release whose installed server silently lacks documented lifecycle commands.

## Stagecraft compatibility audit

`stagecraft-lab/tools/seat-launch-account.mjs` does not invoke a Seat Monitor CLI or HTTP route. It opens `~/.local/state/seat-monitor/history.sqlite3` read-only and requires SQLite `user_version = 2`. It reads the latest 14 scan runs for cadence and requires at least eight successful current-epoch samples for Claude Session and weekly limits.

Tiered compaction therefore keeps six hours of raw scans—well above Stagecraft's 14-gap/eight-sample requirement—and retains SQLite version 2. The daily rollup table is an additive idempotent extension. No Stagecraft launcher source update is required for these Seat Monitor changes. A future switch from direct database coupling to the versioned forecast/verdict CLI is a separate cross-repository contract change.

The globally installed package was `0.1.1`, not the repository's `0.1.5` package. Operational verification must install the checked package before exercising lifecycle commands.

## Verification

- Unit coverage for running, stopped, dead-stale, and unverified status.
- CLI routing coverage for `status`, `--version`, and no foreground/provider activity.
- API and dashboard coverage for package version display.
- Packed-install smoke coverage for server help and executable versions.
- Install the checked local package, start it through the managed lifecycle, query status, and verify new scan rows accumulate without manually invoking a provider scan.
- `npm run check` and `npm run package:check`.

## Review

The installed-path diagnosis was reproduced rather than inferred: global Seat Monitor `0.1.1` ran `seat-monitor-server start` as a foreground process, exposed no status route, wrote no managed runtime state, and held the invoking terminal. Packed-install coverage now exercises the server help surface that the prior smoke test omitted.

CodeQL's security-extended query reported same-user path-injection candidates at the configurable private runtime directory and its injected temporary-test equivalent. They were reviewed under the repository's established local-only threat model and dismissed: the process is unprivileged, the directory must be absolute, state is runtime-schema validated, files are private, and tests use `mkdtemp` paths.

The Stagecraft read path was then driven against fresh post-migration scans. SQLite remained at consumer version 2, cadence evidence was present, and `claude-ops` progressed from four to the required eight Session samples under the normal scheduler. No Stagecraft change is needed for Seat Monitor version or tiered compaction compatibility.

The final Stagecraft `show jimbo` probe still refused on a separate existing policy inconsistency: `claude-drichardson-kthunk` has usable zero-consumption Session evidence but no provider Session reset. Stagecraft's evidence builder labels that account usable, while its replay completeness predicate requires every limit reset timestamp to be a safe integer. Seat Monitor must not fabricate that provider reset; disposition belongs to Stagecraft's policy owner.

## Completion

Completed on 2026-09-08. The checked local package replaced global `0.1.1`; both executables now report `0.1.5`. A pre-migration database backup was written to `/home/djradon/.local/state/seat-monitor/history.pre-tier-20260908T224845Z.sqlite3`. The managed server is identity-verified on `http://127.0.0.1:3000/`, writes clean six-account scans, and reports its version through the API and dashboard. The duplicate unmanaged old server was terminated.
