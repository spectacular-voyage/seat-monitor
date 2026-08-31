---
id: dbc49dd735c6d7535f1d2e99
title: Release Notes v0.1.0
desc: First public release of Seat Monitor
updated: 1788190482811
created: 1788190482811
---

# Seat Monitor v0.1.0

The first public release of Seat Monitor answers two questions across multiple Claude and Codex accounts: which account should be used next, and which account-wide limit is most at risk.

## Highlights

- Decision-first terminal report with standalone `USE` and `WATCH` recommendations.
- Parallel, isolated account checks with per-account failure handling.
- Claude session, weekly all-models, and nested Fable sub-cap reporting.
- Codex quota windows from isolated App Server profiles.
- Plain text, Markdown, and minified agent-safe JSON output.
- Loopback-only dashboard and validated `/api/quota` endpoint.
- External mode-`0600` account configuration and isolated provider credential profiles.

## Install

With npm:

```sh
npm install --global seat-monitor
```

With pnpm:

```sh
pnpm add --global seat-monitor
```

Then create the account configuration:

```sh
seat-monitor --init-config
```

## Security and delivery

- Published under Apache-2.0 from a sanitized public Git history.
- GitHub CI covers Node.js 22 and 24, dependency review, CodeQL, OSV, and coverage.
- npm publishing uses a protected GitHub environment and trusted OIDC publisher.
- npm publishing requires 2FA and disallows bypass-2FA tokens.

## Known constraints

- The service is local-only and intentionally refuses non-loopback server bindings.
- Claude quota collection strictly parses Claude Code CLI `/usage` output and fails closed if that format changes.
- Provider CLIs and their authenticated profile stores remain trusted local dependencies.
