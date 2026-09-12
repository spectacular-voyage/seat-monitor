---
id: sm-release-notes-v0-1-8
title: Release Notes v0.1.8
desc: Accurate fleet burn, supervisor-aware status, and resilient half-period graphs
updated: 1789171049000
created: 1789171049000
---

# Seat Monitor v0.1.8

This release makes fleet throughput reflect total quota burn, recognizes servers supervised by systemd, and keeps narrow history views useful before their reset-anchored range reaches the present.

## Added

- `seat-monitor --forecast` reports total Claude Session and Codex primary fleet burn in text, Markdown, and JSON. Each `fleetBurn` JSON entry includes `totalRatePercentPerHour`, the measurable-account count, observation time, slope window, and smoothing window.
- `seat-monitor-server status` identity-probes the configured loopback endpoint when no internally managed background state exists, so foreground servers supervised by systemd or another process manager report as running.

## Changed

- Vendor burn graphs sum measurable per-account slopes instead of averaging them. Values are displayed as account-quota percentage points per hour (`pp/h`) and can exceed 100.
- Fleet-rate calculation uses a nondecreasing envelope for small provider percentage regressions while continuing to split on material drops and provider-confirmed reset boundaries.
- A future reset anchors a narrow graph only when the selected range contains measured history. A future-only ½× range now falls back to the most recent half-period ending now.
- Systemd guidance explicitly keeps `seat-monitor-server` in foreground mode so systemd remains the sole process supervisor. Built-in `stop` and `restart` remain scoped to internally managed background processes.

## Compatibility

- Default CLI output and `GET /api/quota` are unchanged.
- Forecast JSON adds the top-level `fleetBurn` array.
- `GET /api/history/analytics` retains its existing shape; `fleetThroughput.vendors[].points[].ratePercentPerHour` now represents summed fleet burn rather than a per-account mean.
- Existing foreground and built-in background server launch commands remain supported.

## Install

With npm:

```sh
npm install --global seat-monitor@0.1.8
```

With pnpm:

```sh
pnpm add --global seat-monitor@0.1.8
```
