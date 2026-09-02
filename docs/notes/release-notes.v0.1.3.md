---
id: 2b896aaec98113f647afbfad
title: Release Notes v0.1.3
desc: Enterprise-managed MCP compatibility for Claude quota checks
updated: 1788365763239
created: 1788365763239
---

# Seat Monitor v0.1.3

This patch release preserves Claude quota reliability on hosts governed by an enterprise-managed MCP configuration.

## Fixed

- Claude quota checks detect `managed-mcp.json` at Claude Code's documented system path on macOS, Linux/WSL, and Windows.
- Strict MCP isolation remains enabled on ordinary hosts, preventing unrelated configured servers from starting during quota reads.
- On managed hosts, strict mode is omitted because Claude Code requires the enterprise MCP configuration to remain authoritative.
- Provider tests cover both unmanaged and enterprise-managed command paths.

## Included from v0.1.2

- Claude Code 2.1.252 quota reads no longer use `--safe-mode`, which could suppress every quota window for healthy profiles.
- Missing Claude and Codex profile errors include exact account-specific login commands.

## Install

With npm:

```sh
npm install --global seat-monitor@0.1.3
```

With pnpm:

```sh
pnpm add --global seat-monitor@0.1.3
```
