---
id: f1d7a429b18c9c0da11d5310
title: 2026 08 30 Public Release Security Review
desc: Release-readiness assessment, threat model, evidence, blockers, and publication runbook
updated: 1788130408282
created: 1788130408282
---

# Public Release Security Review

## Decision

**Current source and npm artifact: conditional GO. Current Git repository history: NO-GO for public visibility.**

The release candidate is suitable for public distribution under its stated local-only threat model after the mandatory history cleanup and publication controls below. No resolved credential or high-confidence token pattern was found, but 13 historical commits retain personal account aliases and 1Password vault/item reference metadata. The current tree no longer contains that metadata; making the repository public without rewriting history would expose it.

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
| Release blocker | Historical commits contain private account/vault metadata.                                   | Rewrite all repository history and verify from a fresh clone before changing visibility.                                                        |
| Release blocker | The npm package does not yet exist, so trusted publishing cannot be attached.                | Bootstrap `@spectacular-voyage/seat-monitor` once with maintainer 2FA, then configure OIDC and disallow token publishing.                       |
| Release blocker | GitHub security features are disabled while the repository is private.                       | Make public only after history cleanup, then enable/verify the settings listed below and run every security workflow.                           |
| Resolved        | Tracked source contained real account aliases; tracked `.env.op` exposed reference metadata. | Account declarations moved to external `accounts.json` mode `0600`; `.env.op` is ignored; only generic examples ship.                           |
| Resolved        | The default npm tarball included source, tests, Dendron notes, and `.env.op`.                | A package allowlist now ships only compiled runtime, license, README, and generic examples; off-tree install smoke testing enforces it.         |
| Resolved        | Installed npm bin shims exited silently because entry-point checks did not resolve symlinks. | Main-module detection resolves the npm shim; package smoke tests execute all user-facing CLI help paths.                                        |
| Resolved        | Child-process timeout/output/protocol boundaries had weak direct coverage.                   | Direct tests now exercise success, nonzero exit, spawn failure, timeout kill, output cap, malformed JSON, and JSON-RPC error paths.             |
| Accepted        | Provider executables are selected from `PATH`.                                               | Document as a trusted local dependency; subprocess arguments are arrays rather than shell strings.                                              |
| Accepted        | The Claude quota contract is strict parsing of unversioned CLI text.                         | Fail closed on format changes; never fall back to scraping, private endpoints, or raw-response logging. This is primarily an availability risk. |
| Accepted        | Loopback API exposes aliases and quota data to other local processes.                        | The product is explicitly single-user/local-only; remote binding remains refused until authentication and TLS are designed.                     |

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
- Semgrep runs 338 TypeScript/Node/security-audit rules across 60 tracked files with zero findings.
- A high-confidence credential-pattern scan finds zero matches across all commits.
- The npm artifact installs off-tree, contains 112 allowlisted files, excludes source/tests/notes/local config, and runs the three public CLI help paths.
- Live configuration migration preserves all six local accounts with zero scan errors; the private external configuration is mode `0600`.

## Mandatory pre-publication runbook

### 1. Rewrite private history

Follow [GitHub's sensitive-data removal procedure](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository) from a fresh mirror clone using `git-filter-repo` 2.47 or newer.

1. Back up the private repository and pause all pushes.
2. Create a replacement manifest outside the clone containing every historical personal email/profile/item string. Do not commit that manifest.
3. Remove `.env.op` from every ref and replace the private strings in every other historical file, for example:

   ```sh
   git-filter-repo --sensitive-data-removal \
     --invert-paths --path .env.op \
     --replace-text ../seat-monitor-private-replacements.txt
   ```

4. Inspect `.git/filter-repo/changed-refs`, the first changed commits, branches, tags, and pull-request refs. There are currently no tags or pull requests, which reduces coordination cost.
5. Force-push the rewritten mirror only after review, then discard or re-clone every old working copy so old objects cannot be reintroduced.
6. From a new clone, repeat the history credential/metadata scan, `npm run check`, `npm run package:check`, and `npm audit signatures`.

No credential rotation is indicated by this review because no resolved credential was found. Rotate immediately if the replacement audit discovers that a real token was ever committed.

### 2. Make GitHub security controls active

After the rewritten repository becomes public:

1. Enable/verify dependency graph, Dependabot alerts, Dependabot security updates, malware alerts, secret scanning, and push protection.
2. Enable [private vulnerability reporting](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/configure-vulnerability-reporting/configure-for-a-repository); `SECURITY.md` already points reporters to it.
3. Run `CI`, `CodeQL`, and `OSV-Scanner` manually once. CodeQL and dependency review are available without GitHub Code Security charges for public repositories.
4. Authorize the public repository in Codecov for OIDC uploads, or remove the Codecov step before requiring the coverage job.
5. Create a `main` ruleset requiring pull requests, blocking force-push/deletion, and requiring `Node 22`, `Node 24`, `Coverage`, and `Review dependency changes` after those checks have run at least once.
6. Review GitHub's secret-scanning results for the rewritten history before announcing the repository.

The committed public-security workflows intentionally skip while repository visibility is private and begin reporting after it becomes public.

### 3. Bootstrap secure npm publishing

The scoped package name is currently unclaimed. npm trusted publishing requires an existing package configuration, npm CLI 11.5.1+, Node 22.14+, and a public repository for provenance.

1. Confirm that the publishing maintainer belongs to the `@spectacular-voyage` npm organization and has 2FA enabled.
2. From the rewritten public commit, run the release workflow in `dry-run` mode and inspect the package file list.
3. Perform the first `npm publish --access public` interactively with maintainer 2FA to create version `0.1.0`.
4. In npm package settings, configure the GitHub Actions trusted publisher as:
   - organization: `spectacular-voyage`
   - repository: `seat-monitor`
   - workflow filename: `release-npm.yml`
   - environment: `npm-publish`
   - allowed action: `npm publish`
5. In GitHub, configure the `npm-publish` environment with a required maintainer approval.
6. In npm publishing access, require 2FA and disallow tokens; revoke any obsolete automation token.
7. Bump the package version before each later release and publish only through `Release npm`. OIDC publication will generate npm provenance automatically for the public package/repository.

References: [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/), [scoped public packages](https://docs.npmjs.com/creating-and-publishing-scoped-public-packages/), [GitHub dependency review](https://docs.github.com/en/code-security/concepts/supply-chain-security/dependency-review), and [GitHub secret scanning](https://docs.github.com/en/code-security/concepts/secret-security/about-alerts).

## Release gate

Do not change repository visibility or publish the npm package until every mandatory step above is checked off. After those steps, the remaining accepted risks are explicit consequences of a local CLI that delegates authentication and quota access to installed provider CLIs, not undisclosed release blockers.
