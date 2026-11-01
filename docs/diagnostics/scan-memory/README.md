# Galactica scan memory investigation — 2026-11-01

**The HTTP-first implementation passes the 500,000,000-byte combined process RSS
budget across six full scans; the maximum is 410.2 MB.** All 18 accounts returned
valid snapshots. No heavyweight Claude `/usage` process ran and no provider child
remained. The worst scan is 84.1% below the reproduced installed RSS peak.
The first three scans had no observations older than five minutes; after a server
restart, 2 / 2 / 1 observations were correctly marked stale when HTTP throttling
required the native persisted cache.

This is not a claim that systemd `MemoryCurrent` is below 500 MB. The measured
cgroup still charged roughly 0.96–1.26 GB, predominantly filesystem cache, and
native compatibility fallback can also exceed the RSS budget. These distinctions
are exposed in the logs and acceptance report, not hidden by a heap cap.

All MB/GB below are decimal. The local machine is Galactica. Its installed
publication was `08083449699fcd68b2534d05e090e1c3cdeb52c4`, using concurrency **8**.
The repository baseline was `1bd73d2` (default concurrency 4). The existing
`MemoryHigh=2.5G` and `MemoryMax=3G` were not changed. Historical systemd
`MemoryPeak` was **11,591,196,672 B**; that historical peak was not reproduced
under the current caps.

## Complete fleet measurements

The fleet has 13 Claude profiles and 5 Codex profiles. Every recorded scan
returned all 18 successfully. Claude identity verification and both Codex account
and rate-limit RPCs remain. No quota windows, accounts or deadlines were removed.

| Run                                      | Combined sampled RSS peak | Maximum concurrent children |                     Duration |
| ---------------------------------------- | ------------------------: | --------------------------: | ---------------------------: |
| Installed, concurrency 8                 |           2,575,908,864 B |                          19 | 12.411 s including idle wait |
| Serial native-only candidate, worst of 3 |             702,115,840 B |                           5 |           approximately 53 s |
| HTTP-first, scan 1                       |             241,524,736 B |                           5 |                      9.151 s |
| HTTP-first, scan 2                       |             345,616,384 B |                           6 |                      8.834 s |
| HTTP-first, scan 3                       |             337,629,184 B |                           5 |                      7.098 s |

The first cohort's maximum consists of a 207,581,184 B server and one 138,035,200 B
Claude authentication probe. The restart cohort's maximum was 410,210,304 B. Only one account is admitted at once; short-lived
native helpers account for the higher child count. The CLI version is read once
per provider instance, not once per account. Subsequent scans retain no provider
processes. Authentication probes peak around 130–140 MB and Codex app-servers
around 125–140 MB, versus roughly 316–427 MB for the removed normal-path Claude
usage probes. History responses can still temporarily raise the server footprint:
a separate analytics request returned about 4.75 MB of JSON and raised server
RSS to 232.6 MB.

[before.json](before.json) contains baseline per-PID peaks and simultaneous peak
composition. [serial-only.jsonl](serial-only.jsonl) records the intermediate
candidate that **failed** the budget. [after.jsonl](after.jsonl) contains the
three passing HTTP-first scans, including cgroup breakdown, observation ages and
process attribution. [after-restart.jsonl](after-restart.jsonl) records three more
passing scans in a fresh diagnostic unit, including the explicitly stale readings.
These artifacts contain no account identities, credentials
or command lines.

## Why serializing alone was insufficient

The installed full scan's sampled cgroup peak was 2,686,754,816 B. Eight overlapping
Claude usage probes dominated live memory; up to 19 children were observed,
including `bwrap`, shells, `lsb_release`, `uname`, `cut`, `tr` and `getopt`.

Serial native scans still reached 534,065,152 / 702,115,840 / 578,109,440 B. A
single heavyweight usage probe plus server history work exceeded 500 MB.
A temporary Claude safe-mode experiment did not reliably help and was reverted.
The user then authorized investigation of an HTTP reader, accepting the
undocumented-provider-contract risk.

The earlier native runs reported all accounts as successful, but that does not
prove fresh provider responses. Debugging showed the CLI receiving HTTP 429,
remembering that denial for 300 seconds, and displaying its persisted quota cache.
Those cached readings were already about 9–12 minutes old while seat-monitor
stamped native output with the scan time. The lightweight reader preserves the
same quota fallback without launching `/usage`, and retains the actual observation
time so the existing STALE indicator works. In the passing three-scan cohort,
13 of 39 Claude observations used the latest in-process HTTP success during
throttling; all remained less than five minutes old. Restarting can expose older
native cached observations until a new HTTP read succeeds; their age is explicit.

## Provider behavior and bounded state

- Each Claude profile still runs `claude auth status --json` and compares the
  authenticated email with the configured expected identity before requesting
  quota. Setup-token behavior is unchanged.
- The HTTP reader uses the existing OAuth usage endpoint investigated for manual
  resets, with the currently installed CLI version in its User-Agent. It rejects
  redirects, bounds credentials/response reads, and applies the provider timeout.
- It maps normalized `limits` entries for session, weekly-all and Fable. A scoped
  share of the weekly total is **not** Fable utilization. Unknown/duplicate schemas
  are refused. Ultra N/A still requires independently verified Ultra identity and
  a complete weekly/Fable observation; omission alone remains unknown.
- HTTP 429/529 can reuse a bounded 64-profile last-success map or the native
  `.claude.json` usage cache. The native cache must match both expected email and
  the current profile's account UUID; future-dated or malformed records are
  rejected. The original observation timestamp is never advanced. HTTP 401/403
  do not use that cached result.
- Native `/usage` remains the compatibility fallback for unsupported schemas or
  unavailable lightweight results, including credential-refresh behavior. This
  fallback is logged and can exceed 500 MB; it is not a hard memory guarantee for
  every future provider failure or CLI release.
- Probes own isolated POSIX groups. Completion, timeout, output overflow,
  protocol failure and parent termination clean up the group. Slots wait for
  child close and Linux group exit. Surviving groups/pipes are logged without argv
  or secrets. Windows retains direct-child cleanup; Linux is the verified target.
- Output buffers stop at the existing bound, including Codex stderr. Private
  Claude probe working directories avoid project context. A 32-zone formatter
  cache avoids repeated native ICU allocation.

Snapshot caching retains one fleet result and coalesces in-flight scans. The
scanner's previous-snapshot map is bounded by configured accounts. History stays
in SQLite with existing retention/compaction; there was no evidence of an
unbounded in-memory history cache. Interactive `claude-login` is not called by
fleet scans; no login or account switch was performed. No retained app-server pool
was found; Codex's lifecycle defect was resolving before close and killing only
the immediate child.

## Measurement and verification

The baseline observer sampled the dedicated service's `cgroup.procs` every 10 ms,
starting a forced scan after current work finished. The candidate checker samples
externally every 10 ms, including children spawned by native worker threads and
known descendants after reparenting. RSS sums shared mappings conservatively;
sub-interval processes/spikes can be missed. Kernel per-PID high-water marks are
reported separately and are not summed. The server's high-water mark is lifetime,
not scan-local.

A temporary systemd unit ran the built checkout using the same profiles, Node
v26.7.0, executable PATH, history database and dashboard port. Startup scanning
was disabled and the automatic interval set to 3600 seconds so the checker could
force full scans. The repeated HTTP checks waited the normal 60-second interval
after completion, rather than hammering the quota endpoint. Dashboard access and
history work remained enabled.

```sh
npm run check:scan-memory -- --scans 3 --interval-seconds 60
```

The gate requires every configured account to return a valid successful snapshot,
no remaining children, and peak combined RSS at or below 500,000,000 B. It reports
stale observations separately. `--interval-seconds 0` explicitly tests immediate
manual refreshes. The server logs `scan-memory` after each scan and distinguishes
`claude-usage-cached` from heavyweight `claude-usage-fallback`.

The final cgroup's first peak contained 116,285,440 B anonymous, 837,308,416 B file
and 5,152,768 B kernel memory. Native executable/file cache still counts toward
systemd accounting even when it is not mapped into any live process. A lower
systemd ceiling is an Ops policy decision requiring separate pressure testing;
this PR does not claim to have validated that ceiling or modify service caps.
A second, fresh diagnostic cgroup also reached 1,256,501,248 B, including
947,580,928 B file cache: this was not only accounting left over from earlier
heavyweight experiments.

Tests cover real descendant cleanup, retained pipes, failed cleanup, native
worker-thread descendants, the failing memory-budget path, native/HTTP quota
parity, bounded bodies, timeout, identity mismatch, Ultra/Fable semantics,
cache identity/age, and rejected authorization. Existing history, CLI and dashboard
tests remain. The original installed service is restored after diagnosis; Ops
retains package and service deployment ownership.
