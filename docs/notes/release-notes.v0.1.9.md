---
id: sm-release-notes-v0-1-9
title: Release Notes v0.1.9
desc: Direct account navigation, stable history ordering, and accurate flat-usage status
updated: 1789247121879
created: 1789247121879
---

# Seat Monitor v0.1.9

This release makes account history easier to navigate and keeps its cards in a stable order. It also recognizes flat usage once enough observations are available.

## Added

- Every At a glance row links directly to its corresponding per-account history card. The full row supports mouse and keyboard navigation, with visible hover, focus, and destination highlights.

## Changed

- Per-account history cards stay in alphabetical order by account alias as usage changes. At a glance continues to put the most recent observed usage increase first.

## Fixed

- Limits with enough samples and observation time, but no measurable usage change, report "Usage is currently flat" instead of "Projection needs more history." They return a zero measured rate with no projected exhaustion time or range endpoint. Sparse or short histories still report insufficient history.

## Compatibility

- CLI and HTTP response shapes are unchanged. Flat observations with sufficient history now use the existing `not_consuming` status instead of `insufficient_history`.
- No configuration or database migration is required.

## Install

With npm:

```sh
npm install --global seat-monitor@0.1.9
```

With pnpm:

```sh
pnpm add --global seat-monitor@0.1.9
```
