---
id: 149ad593504803f3d1ef9eb3
title: Release Notes v0.1.1
desc: Claude timeout reliability and GitHub Release automation
updated: 1788190768861
created: 1788190768861
---

# Seat Monitor v0.1.1

This reliability release gives Claude Code quota reads more time to tolerate transient provider latency and adds a versioned GitHub Release process.

## Changed

- Claude subprocesses now have a sixteen-second deadline, doubled from eight seconds after healthy accounts intermittently timed out.
- Codex subprocesses retain the original strict eight-second deadline.
- Account checks still run in parallel with a default concurrency of eight.
- Claude authentication and `/usage` remain sequential within each individual account.

## Release process

- Every package version now requires a matching `docs/notes/release-notes.vX.Y.Z.md` file.
- The protected release workflow independently supports npm dry-run/publish and GitHub draft/publish modes.
- GitHub Release bodies are rendered from the versioned Dendron note without its frontmatter.

## Install

With npm:

```sh
npm install --global seat-monitor@0.1.1
```

With pnpm:

```sh
pnpm add --global seat-monitor@0.1.1
```
