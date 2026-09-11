---
id: 5r5poivv87zkiq8ivsv5vs9
title: Product Ideas
desc: ""
updated: 1788907591000
created: 1788377843962
---

- Auth and TLS for remote website access
- Local server settings
  - Keep canonical settings in a private JSON file rather than SQLite
  - Configure the server-owned scan interval
  - Add a settings page that validates and atomically updates the file
- Optional OS service definitions to keep `seat-monitor-server` running across reboots
- **Completed 2026-09-11:** identity-verified `status` covers both internally managed background servers and externally supervised foreground servers such as systemd, while CLI/dashboard package-version visibility remains available.
- Preserve the last successful dashboard analytics payload when a refresh fails instead of replacing graphs with a synthetic empty-history fallback.
- Stagecraft launcher consumer contract, ranked by measured incident cost
  - **Completed 2026-09-08 — Who exhausts next, and when:** `seat-monitor --forecast` brings the existing history analytics to the CLI with recent burn rate, minutes to projected exhaustion, and soonest-first account ranking. It preserves explicit insufficient-history and reset-before-exhaustion states instead of fabricating a time.
  - **Machine gate:** provide a launcher-oriented verdict for a selected account and floor, with distinct exit codes for safe, under-floor, and unable-to-answer outcomes. JSON should carry the same verdict and reason rather than requiring callers to recreate policy from display fields.
  - **Measurement resolution:** expose provider/field precision when known and label quantized readings. A flat whole-percent observation must not imply zero consumption below the instrument's resolution.
  - **Explicit non-goal:** do not add `whoami`; Stagecraft already derives Claude account identity from the selected profile's `.claude.json`.
  - **Integration boundary:** keep `seat-monitor` an external Stagecraft dependency with a versioned consumer contract. `seat-monitor` owns quota acquisition, analytics, and verdict semantics; Stagecraft owns profile identity, floor selection, and the launch refusal that consumes the verdict.
