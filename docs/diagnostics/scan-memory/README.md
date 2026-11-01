# Galactica scan memory investigation — 2026-11-01

**The 500 MB target is not met.** The patch reduces concurrent provider memory
substantially and supplies a failing acceptance gate; it must not be described as
a validated sub-500 MB deployment.

All MB/GB below are decimal. The local machine is Galactica. Its installed
publication was `08083449699fcd68b2534d05e090e1c3cdeb52c4`, using concurrency **8**.
The repository baseline was `1bd73d2` (default concurrency 4). The service already
had `MemoryHigh=2.5G` and `MemoryMax=3G`; these caps were not changed. Its historical
systemd `MemoryPeak` was **11,591,196,672 bytes**, not a reproducible scan peak under
the current caps.

## Complete fleet measurements

The fleet has 18 enabled accounts: 13 Claude profiles and 5 Codex profiles. Each
recorded scan returned all 18 successfully. Every Claude profile still performs
identity verification followed by `/usage`; every Codex profile still performs
both account and rate-limit RPCs. No quota windows, deadlines, accounts or
provider output were removed to achieve the reduction.

| Run                       | Combined sampled RSS peak | Maximum concurrent children | Server's sampled RSS peak |
| ------------------------- | ------------------------: | --------------------------: | ------------------------: |
| Installed, concurrency 8  |           2,575,908,864 B |                          19 |             144,150,528 B |
| Candidate, serial, scan 1 |             534,065,152 B |                           5 |             108,761,088 B |
| Candidate, serial, scan 2 |             702,115,840 B |                           5 |             299,065,344 B |
| Candidate, serial, scan 3 |             578,109,440 B |                           5 |             162,676,736 B |

The worst of the three candidate runs is 72.7% below the reproduced installed
RSS peak, but is **202.1 MB above budget**. At that peak, the server used
277,708,800 B and one Claude usage probe used 424,407,040 B. The 5-child maximum
includes short-lived native helper commands; only one account probe is admitted
at once. No provider child remained after any completed candidate scan.

The installed full scan's sampled cgroup peak was **2,686,754,816 B**. The temporary
candidate unit also accumulated significant filesystem cache: one observed
`memory.stat` reported 431,427,584 B anonymous, 986,865,664 B file and 24,379,392 B
kernel memory. Thus reducing live process RSS alone does not establish a 500 MB
systemd `MemoryCurrent` limit. Do not substitute the RSS figures for that claim.

The installed full scan took 12.411 seconds including the observer's idle wait.
Serial candidate scans took roughly 50–60 seconds. Scheduling remains
completion-based, so slow scans cannot accumulate scheduled work.

## Attribution and evidence

[before.json](before.json) contains every observed PID, parent, sampled peak and
kernel `VmHWM`, plus the simultaneous peak composition. [after.jsonl](after.jsonl)
contains the corresponding three full candidate scan reports. Neither artifact
contains account identities, credentials or command lines.

The installed scan's Claude usage probes peaked around 316–417 MB each; Claude
auth probes were roughly 129–141 MB. Codex app-server processes were roughly
127–134 MB. The remaining observed processes were native helpers such as
`bwrap`, `sh`, `lsb_release`, `uname`, `cut`, `tr` and `getopt`. Classification can
fall back to `helper` (or the executable name in the baseline) when a process
changes its title. Per-PID rows remain available for attribution.

`services/claude-login.ts` and the interactive login entry point are not invoked
by a fleet scan: `claude auth status --json` is its authentication probe. No
interactive login was started, so accounts were not switched. No long-lived
Codex app-server was found between scans; the defect was incomplete process-group
cleanup and resolving the RPC before its child had exited, not a retained
app-server pool.

Snapshot caching retains one fleet result and coalesces in-flight scans. The
scanner's previous-snapshot map is bounded by the configured account list.
History lives in SQLite with existing retention/compaction. There was no evidence
of an unbounded in-memory history cache. A separate live analytics request
returned about 4.75 MB of JSON and raised server RSS to 232.6 MB, explaining why
server history work must also be included in an operational budget.

## Changes and checks

- Default account concurrency becomes 1 in both CLI and server; explicit settings
  from 1 to 16 remain supported.
- Provider probes own isolated POSIX process groups. Completion, timeout, output
  overflow, protocol error and parent termination kill the group. The next
  account waits for the leader's close and remaining Linux group members to exit.
  Unexpected survivors and inherited pipes are logged without argv or secrets.
- Output buffering stops at the existing limit, and Codex stderr shares its
  bounded output budget. Existing platform fallback on Windows kills the direct
  child; Linux provides the verified process-tree guarantee.
- Claude probes use a private empty working directory while keeping their
  configured profile and all quota-related flags. Date-parts formatters are
  reused in a bounded 32-zone cache to avoid repeated native ICU allocations.
- Server scans emit process-tree measurements; `npm run check:scan-memory`
  checks all configured accounts against 500,000,000 B and fails for errors or
  remaining children. It deliberately failed on the candidate runs above.
- Real-process tests cover successful wrappers with living descendants, timeout,
  output overflow, Codex success/protocol/timeout cleanup, and an intentionally
  undersized memory budget. Existing quota, identity, Fable/Ultra, scheduling,
  history and CLI tests remain in the quality gate.

The baseline observer sampled the dedicated service's `cgroup.procs` at 10 ms,
starting a forced `/api/quota?refresh=true` scan after the current scan finished.
The candidate checker sampled the tree externally at 10 ms, including all native
threads' children. It used the same profiles, executable PATH, Node v26.7.0,
history database and loopback port. A temporary systemd unit ran the candidate
from the checkout with startup scanning disabled and a 3600-second automatic
interval; the checker forced each scan. Dashboard access remained available.
The original installed service was restored afterward. No package was installed,
no service configuration changed, and Ops retains deployment ownership.

A temporary safe-mode experiment did not reliably meet the budget and was
reverted. A direct OAuth usage request returned HTTP 429; no HTTP quota backend
was substituted. Meeting 500 MB comfortably with the current native Claude CLI
remains unresolved; replacing that heavyweight probe requires validating the
provider contract and preserving every quota/identity behavior.
