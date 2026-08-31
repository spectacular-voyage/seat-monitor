---
id: f1d7a429b18c9c0da11d5310
title: 2026 08 30 Public Release Security Review
desc: Release-readiness assessment, threat model, evidence, blockers, and publication runbook
updated: 1788136729458
created: 1788130408282
---

# Public Release Security Review

## Decision

**Current source, npm artifact, and rewritten Git history: GO for public visibility. npm publication remains gated on the bootstrap controls below.**

The release candidate is suitable for public distribution under its stated local-only threat model. No resolved credential or high-confidence token pattern was found. The original repository contained personal account aliases and 1Password vault/item reference metadata in historical commits; it is retained as a private archived repository and offline bundle. The replacement repository was built from rewritten history and independently cloned back from GitHub for verification.

This is an engineering security review, not an independent penetration test, legal opinion, provider-terms approval, or bug bounty audit.

## Scope and threat model

Protected assets:

- Claude `.credentials.json` and Codex `auth.json` OAuth profiles;
- optional environment-provided setup/access tokens;
- account aliases, plan tiers, quota measurements, and reset times; and
- integrity of the installed npm package and provider subprocess results.

Security boundary:

- The CLI and web server run for one local operating-system user.
- The dashboard binds only to loopback and is not a remotely authenticated service.
- Locally installed `claude`, `codex`, and `node` executables are trusted dependencies.
- Another process running as the same OS user, a compromised provider CLI, or a compromised npm dependency is outside the isolation guarantee and may already be able to read the user's credential profiles.
- Provider output is untrusted and must remain bounded, validated, and redacted.

## Findings

| Severity        | Finding                                                                                      | Disposition                                                                                                                                     |
| --------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Release blocker | The npm package does not yet exist, so trusted publishing cannot be attached.                | Bootstrap the unscoped `seat-monitor` package once with maintainer 2FA, then configure OIDC and disallow token publishing.                      |
| Resolved        | GitHub security features were disabled while the repository was private.                     | The replacement is public; security reporting is enabled and the initial CI, CodeQL, OSV, and Codecov runs succeeded.                           |
| Resolved        | Historical commits contained private account/vault metadata.                                 | Rewrote every reachable ref, retained the original as a private archive, and verified the replacement from a new GitHub clone.                  |
| Resolved        | Tracked source contained real account aliases; tracked `.env.op` exposed reference metadata. | Account declarations moved to external `accounts.json` mode `0600`; `.env.op` is ignored; only generic examples ship.                           |
| Resolved        | The default npm tarball included source, tests, Dendron notes, and `.env.op`.                | A package allowlist now ships only compiled runtime, license, README, and generic examples; off-tree install smoke testing enforces it.         |
| Resolved        | Installed npm bin shims exited silently because entry-point checks did not resolve symlinks. | Main-module detection resolves the npm shim; package smoke tests execute all user-facing CLI help paths.                                        |
| Resolved        | Child-process timeout/output/protocol boundaries had weak direct coverage.                   | Direct tests now exercise success, nonzero exit, spawn failure, timeout kill, output cap, malformed JSON, and JSON-RPC error paths.             |
| Accepted        | Provider executables are selected from `PATH`.                                               | Document as a trusted local dependency; subprocess arguments are arrays rather than shell strings.                                              |
| Accepted        | The Claude quota contract is strict parsing of unversioned CLI text.                         | Fail closed on format changes; never fall back to scraping, private endpoints, or raw-response logging. This is primarily an availability risk. |
| Accepted        | Loopback API exposes aliases and quota data to other local processes.                        | The product is explicitly single-user/local-only; remote binding remains refused until authentication and TLS are designed.                     |
| Accepted        | `SEAT_MONITOR_CONFIG` intentionally accepts an absolute same-user filesystem path.           | CodeQL's three path-injection alerts were reviewed and dismissed as false positives under the local-only threat model; creation is exclusive.   |

## Positive controls verified

- Credential profiles are outside the repository; login helpers enforce directory mode `0700` and credential-file mode `0600`.
- Provider children receive an allowlisted environment rather than the parent's complete environment.
- Provider processes have an eight-second deadline and a 1 MB combined per-stream capture bound.
- Account, provider, and public DTO inputs are runtime-validated with strict Zod schemas.
- Upstream errors and raw bodies are not returned by CLI/API failure messages.
- The server enforces loopback binding, a Host allowlist, Origin and `Sec-Fetch-Site` checks, `Cache-Control: no-store`, CSP, and redacted framework failures.
- Browser rendering uses DOM `textContent`; provider-controlled values are not assigned through `innerHTML`.
- Package dependencies resolve from the npm registry; production dependencies have no install scripts.
- Apache-2.0 matches the adjacent Kato release convention; dependency licenses are MIT, Apache-2.0, MPL-2.0, ISC, BSD, or BlueOak.

## Verification evidence

Checked 2026-08-30:

- 15 test files and 73 tests pass.
- Coverage: 83.56% statements, 76.79% branches, 85.88% functions, and 83.45% lines; CI floors each metric at 70%.
- `npm audit` reports zero production and zero full-tree vulnerabilities.
- `npm audit signatures` verifies 202 registry signatures and 65 attestations.
- Semgrep runs 338 TypeScript/Node/security-audit rules across 61 tracked files with zero findings.
- A high-confidence credential-pattern scan finds zero matches across all commits.
- The replacement GitHub repository contains only sanitized `main`: 20 commits, no tags or pull refs, no historical `.env.op`, and zero private-identifier matches.
- The npm artifact installs off-tree, contains 112 allowlisted files, excludes source/tests/notes/local config, and runs the three public CLI help paths.
- Live configuration migration preserves all six local accounts with zero scan errors; the private external configuration is mode `0600`.

## Mandatory pre-publication runbook

### 1. Rewrite private history — completed 2026-08-30

The rewrite followed [GitHub's sensitive-data removal procedure](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository) with `git-filter-repo` 2.47.0.

1. Created and verified a complete mode-`0600` Git bundle outside the repository.
2. Removed `.env.op` from every historical ref and replaced all known personal email, profile, environment-variable, and 1Password item identifiers from an external mode-`0600` manifest.
3. Retained the original GitHub repository, including its bot PR refs, under a renamed private archive rather than deleting it.
4. Created the replacement `spectacular-voyage/seat-monitor` privately and pushed only rewritten `main`.
5. Cloned the replacement back from GitHub and verified Git object integrity, 20 commits, one branch, no tags/pull refs, no `.env.op` history, zero private-identifier matches, and zero high-confidence credential-pattern matches.
6. Re-ran the full checks, coverage suite, package smoke test, npm audits/signature verification, and Semgrep against the rewritten clone.
7. Replaced the developer working copy with a fresh clone while preserving the ignored local `.env.op` at mode `0600` and the external account configuration at mode `0600`.

No credential rotation is indicated because both the original-history audit and rewritten-history verification found no resolved credential.

### 2. Make GitHub security controls active — completed 2026-08-30

The replacement repository is public. Activation results:

1. Dependabot alerts and security updates, secret scanning, push protection, and private vulnerability reporting are enabled and verified through GitHub's API.
2. `CI`, `CodeQL`, and `OSV-Scanner` completed successfully against public `main`; coverage also uploaded successfully to Codecov using OIDC.
3. Dependabot and secret scanning report zero alerts. OSV reports no vulnerable lockfile dependencies.
4. CodeQL's security-extended suite reported three high-severity path-injection candidates for the configurable account-file path. All three are intentional same-user local CLI behavior: the process is not privileged, reads are strict-JSON validated, raw file contents are not returned, and initialization uses exclusive `wx` creation rather than overwriting. The alerts are dismissed as documented false positives.
5. The `npm-publish` environment requires maintainer review and permits deployment from `main` only.
6. Public dependency review passed on the activation pull request. `main` now requires pull requests, strict up-to-date CI/coverage/dependency-review/CodeQL/OSV checks, linear history, resolved conversations, and admin enforcement; force-pushes and deletion are disabled.

CodeQL and dependency review are available without GitHub Code Security charges for this public repository.

### 3. Bootstrap secure npm publishing

The scoped package name is currently unclaimed. npm trusted publishing requires an existing package configuration, npm CLI 11.5.1+, Node 22.14+, and a public repository for provenance.

1. Confirm that the publishing maintainer belongs to the `@spectacular-voyage` npm organization and has 2FA enabled.
2. Completed: the protected `Release npm` workflow passed in `dry-run` mode after manual environment approval, including audit, signature, test, build, package-install, unpublished-version, and registry dry-run gates.
3. Perform the first `npm publish --access public` interactively with maintainer 2FA to create version `0.1.0`.
4. In npm package settings, configure the GitHub Actions trusted publisher as:
   - organization: `spectacular-voyage`
   - repository: `seat-monitor`
   - workflow filename: `release-npm.yml`
   - environment: `npm-publish`
   - allowed action: `npm publish`
5. The GitHub `npm-publish` environment is already configured with required maintainer approval and a `main`-only deployment policy.
6. In npm publishing access, require 2FA and disallow tokens; revoke any obsolete automation token.
7. Bump the package version before each later release and publish only through `Release npm`. OIDC publication will generate npm provenance automatically for the public package/repository.

References: [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/), [scoped public packages](https://docs.npmjs.com/creating-and-publishing-scoped-public-packages/), [GitHub dependency review](https://docs.github.com/en/code-security/concepts/supply-chain-security/dependency-review), and [GitHub secret scanning](https://docs.github.com/en/code-security/concepts/secret-security/about-alerts).

## Release gate

The history and GitHub activation gates are complete. The only remaining blocker is npm proof-of-presence: this machine has no npm login, so a maintainer must authenticate and perform the interactive first publish before trusted publishing can be attached. After the bootstrap and trusted-publisher steps, the remaining accepted risks are explicit consequences of a local CLI that delegates authentication and quota access to installed provider CLIs, not undisclosed release blockers.
