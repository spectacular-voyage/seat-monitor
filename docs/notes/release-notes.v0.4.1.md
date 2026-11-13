---
id: sm-release-notes-v0-4-1
title: Release Notes v0.4.1
desc: Claude identity checks reused between scans instead of starting the Claude CLI every minute
updated: 1794551518461
created: 1794551518461
---

# Seat Monitor v0.4.1

This release stops Seat Monitor from starting the Claude CLI on every scan. Each scan used to run `claude auth status` (a roughly 300 MB binary) once per Claude profile to check its identity, which is 1,440 launches per profile per day with the default 60-second interval. On a memory-starved host each launch re-read the binary from disk, which added up to about 130 MB of reads a minute on one 13-profile fleet. A profile now needs about 27 launches a day.

## Changed

- A Claude profile's successful identity check is reused across scans while the profile's `.credentials.json` is unchanged. The file is compared by a SHA-256 that is kept only in memory.
- The check runs again in four cases:
  - after a restart;
  - as soon as that file changes, because a login as another account rewrites it;
  - at least hourly;
  - within five minutes of the access token's expiry, because the CLI refreshes an expired token while answering. Seat Monitor never refreshes tokens itself.
- A check is held only when the credentials file reads the same before and after it. A check that refreshed the token runs once more against the new file.
- If the HTTP quota read rejects the token behind a reused check (401/403), the check runs again and the read is retried once. Errors from that re-check are reported as `invalid_response` or `timeout`; they never fall back to native `/usage`.
- Failed checks are never reused. Token-injected accounts, and profiles whose credentials file cannot be read, are still checked on every scan.
- The per-scan temporary directory is created only when a Claude CLI command runs.

## Compatibility

- No configuration, API or history changes.
- Node.js 24 or later is still required.

## Install

With npm:

```sh
npm install --global seat-monitor@0.4.1
```

With pnpm:

```sh
pnpm add --global seat-monitor@0.4.1
```
