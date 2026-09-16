---
id: sm-release-notes-v0-1-10
title: Release Notes v0.1.10
desc: Trusted LAN access, Claude identity pinning, and weekly-reset ordering
updated: 1789581299000
created: 1789581299000
---

# Seat Monitor v0.1.10

This release adds opt-in trusted-LAN access, pins Claude profiles to their expected authenticated identities, and makes weekly reset timing the primary At a glance ordering.

## Added

- The server can listen on a trusted IPv4 LAN when `host` is `0.0.0.0` and `allowedHosts` names every accepted server address. Loopback remains the default. Host, Origin, and cross-site request validation continue to protect browser access, but the server still has no authentication or TLS and must not be exposed to an untrusted network.
- Claude profile configuration now requires `expectedEmail`. Before reading quota, Seat Monitor compares it case-insensitively with `claude auth status --json`; a different authenticated account returns `identity_mismatch` with a targeted login command.

## Changed

- At a glance account cards are ordered by the soonest measured weekly reset. Accounts without a usable weekly reset appear last, with stable provider and alias tie-breaks. Per-account history remains alphabetical.

## Fixed

- An account with zero effective Fable headroom is no longer recommended for Fable work. The dashboard reports that no viable account has positive headroom across the shared constraints.

## Compatibility

- Existing Claude profile entries must add `auth.expectedEmail` before upgrading. `accounts.example.json` and the README show the required field.
- LAN listening is opt-in. Existing settings retain loopback-only behavior, and no database migration is required.
- CLI and HTTP response shapes are unchanged. `identity_mismatch` is added to the existing quota error-code vocabulary.

## Install

With npm:

```sh
npm install --global seat-monitor@0.1.10
```

With pnpm:

```sh
pnpm add --global seat-monitor@0.1.10
```
