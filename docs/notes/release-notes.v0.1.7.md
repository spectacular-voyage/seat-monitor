---
id: sm-release-notes-v0-1-7
title: Release Notes v0.1.7
desc: Consistent CLI JSON and vendor shading across the dashboard
updated: 1789020660090
created: 1789020660090
---

# Seat Monitor v0.1.7

This release unifies the CLI JSON envelope and percentage naming, and makes vendor shading consistent across the dashboard.

## Changed

- Both `seat-monitor --json` and `seat-monitor --forecast --json` return an object with `apiVersion`, `generatedAt`, `historyHealth`, and `accounts`. `--format json` follows the same contract.
- Both JSON modes use `usedPercent` for current quota consumption. `riskRanking` and per-limit forecast fields are absent unless `--forecast` is passed.
- At a glance rows share the Claude burgundy and Codex blue shading of the per-account history cards. Claude burgundy is slightly darker in both sections.
- Fleet throughput axis and hover labels are larger and easier to read.

## Breaking JSON changes

- Plain JSON consumers must read `payload.accounts` instead of treating `payload` as an array.
- Forecast JSON consumers must read `usedPercent` instead of `currentConsumedPercent`.
- Text and Markdown output, CLI exit codes, and the HTTP quota API retain their existing behavior.

## Install

With npm:

```sh
npm install --global seat-monitor@0.1.7
```

With pnpm:

```sh
pnpm add --global seat-monitor@0.1.7
```
