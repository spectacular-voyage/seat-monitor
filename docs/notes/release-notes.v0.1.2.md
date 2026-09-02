---
id: c2e3e5d1e86610bc594c54b0
title: Release Notes v0.1.2
desc: Claude quota reliability and actionable login recovery
updated: 1788365103018
created: 1788365103018
---

# Seat Monitor v0.1.2

This patch release restores quota reads for Claude profiles affected by a Claude Code safe-mode regression and makes missing-profile errors directly actionable.

## Fixed

- Claude quota reads now use empty setting sources and strict MCP isolation instead of `--safe-mode`. Claude Code 2.1.252 could return only the subscription header under safe mode for healthy profiles, causing `invalid_response` errors despite successful authentication.
- User, project, and local settings plus configured MCP servers remain excluded from zero-token quota checks.
- Missing Claude and Codex profile errors now include the exact `seat-monitor-claude-login '<accountAlias>'` or `seat-monitor-codex-login '<accountAlias>'` command to run.
- Provider command-contract and missing-profile tests cover the corrected behavior.

## Install

With npm:

```sh
npm install --global seat-monitor@0.1.2
```

With pnpm:

```sh
pnpm add --global seat-monitor@0.1.2
```
