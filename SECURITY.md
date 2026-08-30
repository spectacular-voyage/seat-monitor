# Security Policy

## Supported versions

Seat Monitor supports security fixes for the current minor release line only.

| Release line                  | Supported        |
| ----------------------------- | ---------------- |
| Current minor release line    | Yes              |
| Older minor release lines     | No               |
| Unreleased builds from `main` | Best effort only |

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability.

Use GitHub's [private vulnerability reporting](https://github.com/spectacular-voyage/seat-monitor/security/advisories/new). If that link is unavailable, contact the maintainer privately before sharing details publicly.

Useful reports include:

- the affected Seat Monitor version and installation source;
- operating system and Node.js version;
- whether the issue affects the CLI, loopback dashboard, account configuration, or provider subprocess boundary;
- a clear impact statement and minimal reproduction; and
- logs with credentials, account aliases, organization IDs, quota values, and local paths redacted.

Seat Monitor launches locally installed provider CLIs and reads credential profiles outside its package directory. Never include real `.credentials.json`, `auth.json`, OAuth tokens, 1Password references, or raw provider responses in a report.

Reports generated only by automated scanners, without demonstrated Seat Monitor impact, may be closed without detailed response. Seat Monitor does not currently operate a bug bounty program.

## Response expectations

The maintainer will try to acknowledge valid-looking reports within seven days. Accepted vulnerabilities will be investigated privately, fixed on the supported release line, and disclosed after a patched release is available.
