---
id: mo67eop5dzh45hkmnw1t6xf
title: 2026 08 26 Initial Plan
desc: Initial delivery plan for the multi-account Claude and Codex quota monitor
updated: 1788190690722
created: 1787759817972
---

# Multi-Account AI Quota Monitor: Initial Plan

## Status

- Stage: implementation complete; public-release hardening in progress
- Runtime: Node.js on an active LTS release
- Language: TypeScript 5.x in strict mode
- Primary interfaces: CLI and a local web dashboard
- Credential source: isolated persistent Claude and Codex login profiles
- External review: Claude Code 2.1.246, approved after revision on 2026-08-26
- Provider evidence: [[sm.task.2026-08-26-provider-contract-spike]]
- CLI output design: [[sm.task.2026-08-29-cli-output-rework]]

## Outcome

Build a small service that checks multiple Claude and Codex accounts concurrently, normalizes each provider's quota response, and exposes the same result through:

1. a CLI that emits an aligned decision-first text report, Markdown on request, or machine-safe JSON; and
2. a local HTTP API and single-page dashboard with automatic and manual refresh.

An unavailable or malformed account must produce an account-level error result without preventing healthy accounts from being reported.

## Discovery gate: verify the provider contracts first

The draft URLs, `https://anthropic.com` and `https://openai.com`, are website roots rather than complete authenticated quota API contracts. The proposed field names also need to be verified against real responses. Before building provider adapters:

- Identify the supported endpoint and authentication method for each provider and account type.
- Confirm that the credentials supplied through 1Password are API keys or other tokens permitted for programmatic quota inspection. Do not automate browser sessions, scrape web dashboards, or copy browser cookies unless that becomes an explicit, separately reviewed requirement.
- Capture sanitized example responses or JSON fixtures for success, authentication failure, throttling, and missing optional fields.
- Verify the exact source and meaning of Claude `plan`, base usage, `model_caps.fable`, and `time_to_reset_seconds`.
- Verify the exact source and meaning of Codex `plan`, usage percentage, and `reset_at`.
- Determine whether usage is account-wide, workspace-scoped, model-scoped, or window-specific. If more than one reset window exists, choose and document a deterministic representation.
- Confirm that the intended endpoints and token use comply with the providers' terms and are stable enough for this service.

Timebox this discovery spike to one working day. Implementation of an adapter is blocked until its contract has a sanitized fixture and an explicit mapping to the normalized model. If a required metric is not exposed by a supported API, report it as unsupported rather than estimating or inventing it.

Acceptable Phase 0 outcomes are:

1. implement a provider using a supported, fixture-backed contract;
2. descope that provider and surface an explicit unsupported result;
3. change the product target, for example from subscription allowance to API-organization usage; or
4. propose a separately reviewed local telemetry source that does not scrape a dashboard or reuse browser credentials.

Outcomes 2–4 require a product decision. Re-baseline the later phases and acceptance criteria after the spike; do not proceed as though both original adapters are guaranteed to ship.

## Proposed architecture

Use a dependency-light Node.js application with native `fetch`, `AbortSignal.timeout(8_000)`, and a small HTTP framework such as Fastify. Core collection and normalization remain independent of both interfaces.

```text
Configuration -> Account scanner -> Provider adapters -> Normalized results
                       |                                     |
                       +----------------+--------------------+
                                        |
                                  CLI / HTTP API
                                              |
                                         Dashboard
```

Suggested project layout:

```text
src/
  config/
    accounts.ts          # validate external account config and resolve profiles/env
  domain/
    quota.ts             # normalized result and error types
  services/
    scan-accounts.ts     # bounded parallel orchestration
    anthropic.ts         # provider request and response mapping
    codex.ts             # provider request and response mapping
    time.ts              # reset parsing and clamped minute calculations
  presentation/
    table.ts             # deterministic Markdown rendering
  public/
    index.html
    app.js
    styles.css
  cli.ts
  server.ts
test/
  fixtures/              # sanitized provider responses
  unit/
  integration/
```

The provider adapters should accept injected `fetch` and clock dependencies. This keeps time calculations and all HTTP outcomes deterministic in tests. Use one shared runtime schema library to validate untrusted provider payloads and the public CLI/API DTOs; TypeScript types alone do not validate JSON at runtime.

## Configuration and secret handling

Keep account metadata, profile names, and optional environment-variable _names_ in the user's external `accounts.json`, not version control. Keep personal Claude and Codex OAuth caches outside the repository in dedicated profiles. Resolve optional managed-workspace tokens only when the process starts.

```json
{
  "accounts": [
    {
      "accountAlias": "claude-personal@example.com",
      "platform": "Claude",
      "auth": { "type": "claude_profile", "profile": "claude-personal" }
    }
  ]
}
```

Operational rules:

- Run the default personal-account flow directly after its one-time provider logins; no runtime secret injection is required.
- For optional environment-token modes, launch with `op run --env-file=.env.op -- ...` and prefer a read-only service account scoped to a dedicated non-built-in vault.
- Keep `.env.op` ignored and local. Commit only the neutral `.env.op.example`; never commit resolved credentials, private vault/item names, or a conventional `.env` file.
- Add `.env`, resolved secret outputs, logs, and local artifacts to `.gitignore`.
- Validate aliases, duplicate aliases, and required environment variables before scanning.
- Never include tokens, authorization headers, or raw provider response bodies in logs, errors, CLI output, or API responses.
- Use generic account-scoped error messages; keep optional debug diagnostics on `stderr`, redacted, and disabled by default.
- Document that optional `op run` mode resolves secrets into the child process environment at startup. A long-running server retains those values after the 1Password session expires and must be restarted to pick up credential rotation.
- Create personal Claude and Codex profiles through provider login commands, keep them outside the repository, isolate them per account, and restrict profile directories to `0700` and credential files to `0600`.

## Normalized domain contract

Keep numeric fields numeric so agents and the browser do not need to parse display strings. Formatting such as `%`, explicit `unsupported`, empty unknown fields, and countdown labels belongs at the presentation layer. Model provider limits as a list because one account can have multiple quota windows or model-scoped caps.

```ts
type QuotaLimit = {
  key: string;
  label: string;
  scope: "global" | "model" | "window";
  availability: "available" | "unsupported";
  usedPercent: number | null;
  resetAt: string | null;
};

type SnapshotBase = {
  accountAlias: string;
  platform: "Claude" | "Codex";
  observedAt: string;
};

type QuotaSuccess = SnapshotBase & {
  status: "ok";
  plan: string | null;
  limits: readonly QuotaLimit[];
};

type QuotaFailure = SnapshotBase & {
  status: "error";
  plan: null;
  limits: readonly [];
  error: {
    code:
      | "missing_credential"
      | "unauthorized"
      | "forbidden"
      | "rate_limited"
      | "timeout"
      | "network"
      | "invalid_response"
      | "unsupported";
    message: string;
  };
};

type QuotaSnapshot = QuotaSuccess | QuotaFailure;
```

Contract rules:

- Percentages are numbers in the inclusive range `0..100`, or `null` when unavailable.
- When the verified contract exposes them, use stable semantic keys such as `base` and `fable`; do not make an unverified provider property part of the core type.
- A missing provider-level contract is an account error with code `unsupported`. A model metric that the provider does not expose is a limit with `availability: "unsupported"`, not an account failure. Codex does not define a Fable metric, so it emits no synthetic Fable limit or table row.
- Capture `observedAt` from the injected clock immediately after the provider response is received, never at request start. Convert Claude reset seconds to an absolute `resetAt` using that instant.
- Parse Codex `reset_at` as an ISO-8601 instant. Reject invalid dates.
- Treat `resetAt` as canonical. Calculate `minutesUntilReset` as `max(0, ceil((resetAt - renderTime) / 60_000))` when creating CLI or API output, so cached snapshots do not carry stale countdowns. The shared public DTO adds this derived field to each limit with a reset.
- Preserve a stable output order matching configuration order even though requests run concurrently.
- The API and `--json` return the same runtime-validated public DTO. The table may emit one row per limit window while retaining the account alias, plan, Base, and Fable presentation required by the draft.
- If compatibility with the draft's flat, string-valued blueprint is required, add a versioned presentation DTO rather than weakening the core type.

## Collection and failure behavior

- Schedule all configured account checks immediately, execute at most eight concurrently, and collect them with `Promise.allSettled` or an equivalent account-safe wrapper.
- Apply an independent 8,000 ms timeout to every outbound request.
- Bound concurrency to eight requests by default. Define the scan budget as `ceil(enabledAccounts / 8) * 8 seconds + 1 second` of orchestration overhead and test it with an injected timeout.
- Treat non-2xx responses and schema-validation failures as account errors.
- Map provider status codes to stable internal error codes without exposing response bodies.
- Do not retry in v1, including `429` responses; classify them as `rate_limited`. If retries are later added for transient failures, keep the total wall-clock budget bounded and honor `Retry-After`.
- Return a snapshot for every configured account, including missing-credential accounts.

## CLI interface

Proposed commands:

```sh
npm run quota -- --format table
npm run quota -- --format text
npm run quota -- --format md
npm run quota -- --format json
npm run quota -- --json
```

Behavior:

- Make `--format text|md|json` canonical, default to text, retain `table` as a backward-compatible Markdown alias, and treat `--json` as an alias for `--format json`.
- Both formats keep `stdout` free of logs, banners, and spinners. JSON writes exactly one minified array plus a trailing newline.
- Send diagnostics only to `stderr`; keep them disabled in JSON mode unless explicitly requested.
- Lead human output with independent `USE` and `WATCH` decisions, then render vendor/account groups with consumed and elapsed positions adjacent. Keep Fable nested under Claude weekly usage.
- Reject unknown or conflicting flags with usage text on `stderr` and exit `2`.
- Use exit `0` when all accounts succeed, `1` when a valid scan contains one or more account failures, and `2` for invalid flags or fatal static configuration errors such as duplicate aliases. A missing credential is an account failure, so a complete snapshot is still printed with exit `1`.

## HTTP API and dashboard

Server behavior:

- `GET /api/quota` performs or retrieves a recent scan and returns the shared public JSON DTO with countdown fields recomputed at response serialization time.
- Add `Cache-Control: no-store`; do not expose secrets or raw upstream payloads.
- Coalesce simultaneous refresh requests so a browser refresh does not start duplicate provider scans.
- Use a 30-second in-memory freshness window to reduce provider load and include `observedAt` in every result.
- Serve static dashboard assets from `GET /`.
- Bind to `127.0.0.1` by default. Requiring an explicit host override reduces accidental network exposure.
- Validate the `Host` header against the configured listener and reject browser requests with a cross-site `Origin` or `Sec-Fetch-Site: cross-site` value. A non-loopback bind requires explicit configuration and a later authentication/TLS review.
- Replace framework-default error responses with a custom redacting error handler, and apply a restrictive Content Security Policy to the dashboard.
- Provide a small health endpoint only if deployment needs one; it must not perform provider calls or reveal configuration.

Dashboard behavior:

- Render the same columns as the CLI table with accessible semantic HTML.
- Include loading, empty, partial-error, and total-error states.
- Provide a Refresh button that is disabled while a scan is in progress.
- Auto-refresh quota data every 60 seconds and prevent overlapping requests.
- Update visible countdowns locally once per minute from `resetAt`; a countdown reaching zero does not imply that a new upstream scan has completed.
- Avoid a Tailwind CDN dependency for a production build; use small checked-in CSS unless a CSS build pipeline is deliberately added.

## Verification strategy

Unit tests:

- Provider fixture mapping, including Fable present, absent, and malformed.
- Reset conversion at boundaries: zero, partial minute, expired time, invalid ISO value, and clock skew.
- Percentage validation and nullable unsupported fields.
- Error classification and redaction.
- Stable configuration-order output from out-of-order completions.
- Markdown escaping plus distinct empty-unknown and explicit-unsupported rendering.
- CLI JSON purity: stdout parses with `JSON.parse` and contains no extra text.
- Table stdout purity: stdout contains only the table, while diagnostics are isolated to `stderr`.

Integration tests with an injected fake HTTP server:

- Multiple accounts succeeding in parallel.
- One timeout, one authentication error, and one success in the same scan.
- A `429` response with `Retry-After`, verifying classification, redaction, and no v1 retry.
- The 8-second abort behavior using fake timers or a shorter injected timeout.
- One shared runtime contract validates both `/api/quota` and `--format json` outputs.
- `/api/quota` response schema, render-time countdown recomputation, `no-store` header, 30-second freshness, scan coalescing, and static dashboard delivery.
- Default loopback binding, Host/Origin rejection, redacting error responses, and graceful shutdown.

Quality gates:

- `tsc --noEmit`
- formatter and linter
- unit and integration test suites
- production build
- smoke tests for both CLI formats and the local dashboard
- a secret scan or explicit repository search confirming no resolved credentials are tracked

## Delivery sequence

### Phase 0: provider-contract spike

- Timebox the spike to one working day.
- Resolve the endpoint, authentication, terms, scopes, and response semantics for both providers.
- Save sanitized fixtures and record the field mapping.
- Choose one of the documented supported, descope, retarget, or separately reviewed telemetry outcomes for each provider.

Exit criterion: each provider has a supported contract and fixture or an explicit product decision. Re-baseline Phases 1–5 against the discovered provider and limit-window shapes before implementation.

### Phase 1: project foundation and domain

- Initialize Node, TypeScript strict mode, scripts, formatting, linting, and tests.
- Add account configuration loading and validation.
- Define normalized success/error contracts and reset-time helpers.

Exit criterion: quality scripts pass and configuration/time behavior is unit tested.

### Phase 2: provider adapters and scanner

- Implement the fixture-driven provider adapters approved by Phase 0.
- Add independent timeouts, response validation, redacted error mapping, bounded concurrency, and stable ordering.

Exit criterion: mixed-success scans are deterministic and one failed account cannot crash the scan.

### Phase 3: CLI

- Implement flag parsing, minified JSON output, Markdown rendering, and exit-code semantics.
- Add subprocess tests that separately assert `stdout`, `stderr`, and exit status.

Exit criterion: agent mode is directly parseable and human mode is scannable.

### Phase 4: server and dashboard

- Add the quota route, static dashboard, scan coalescing, refresh controls, and client-side countdowns.
- Add API integration tests and browser smoke coverage for the main states.

Exit criterion: the dashboard reflects fresh and partially failed results without leaking internal details.

### Phase 5: operational hardening

- Document provider-profile setup, optional 1Password launch commands, configuration, troubleshooting, and endpoint limitations.
- Verify local-only binding, graceful shutdown, no secret leakage, and production start scripts.

Exit criterion: a clean checkout can be configured with isolated provider profiles, tested, built, and operated from the README.

## Initial acceptance criteria

These criteria apply to the provider scope approved at the Phase 0 gate.

- TypeScript strict mode passes with no implicit `any` and no unchecked provider payloads.
- Provider and public payloads are checked by shared runtime schemas at trust boundaries.
- All account requests execute with concurrency eight. Codex subprocesses use an eight-second deadline; Claude subprocesses use sixteen seconds after live headless CLI latency exceeded the original bound.
- Each configured account always has one normalized result.
- Claude reports base and Fable usage when the verified API supplies them.
- Codex reports every provider quota window without adding a synthetic Fable metric.
- Every reported limit window has a valid absolute reset instant or an explicit unsupported value; public DTO countdowns are recomputed from that instant and are nonnegative whole minutes.
- `--json` emits only minified, parseable JSON to `stdout`.
- The default CLI emits only a readable aligned text report to `stdout`; Markdown is explicit through `--format md`.
- CLI exits are deterministic: `0` all healthy, `1` one or more account failures, and `2` invalid invocation or fatal static configuration.
- `/api/quota` exposes the same normalized contract and the dashboard supports automatic and manual refresh.
- The server defaults to loopback, rejects invalid Host/cross-site browser requests, redacts error responses, coalesces scans, and shuts down gracefully.
- Missing credentials, timeouts, authentication failures, and malformed responses are isolated and redacted.
- No resolved credential is stored in source, fixtures, logs, client assets, or API output.

## Phase 0 decisions

1. Codex means a ChatGPT/Codex subscription seat. V1 uses the official Codex App Server with isolated persistent profiles for personal plans and optional environment-provided access tokens for Business/Enterprise.
2. Claude stored-login profiles support plan discovery plus zero-token print-mode `/usage` output for session, weekly-all-models, and weekly-Fable windows. Setup tokens remain auth-only because their `/usage` output contains invocation statistics instead.
3. Fable is not treated as a stable provider response key. It remains a semantic presentation key and is never inferred.
4. Every provider window is preserved with a stable provider limit ID plus `primary` or `secondary`; the interfaces can display multiple rows per account.
5. V1 is local-only. The server refuses non-loopback listeners until authentication and TLS are designed.

## Out of scope for the first release

- Persisted usage history, trends, forecasting, and alerting.
- Editing or rotating credentials.
- Remote multi-user deployment and its authentication layer.
- Scraping consumer dashboards or depending on undocumented browser-session endpoints.
- Inventing quota values when a supported provider contract does not expose them.

## Implementation outcome

Completed on 2026-08-26:

- Strict TypeScript project with Zod validation at provider and public-output boundaries.
- Isolated Claude CLI and Codex App Server adapters with per-account state, allowlisted child environments, provider-specific deadlines (Claude sixteen seconds, Codex eight), capped process output, and redacted failures. Personal Claude and Codex login profiles persist outside the repository so refreshed OAuth credentials survive; optional token-mode state is temporary.
- Stable-order scanner with concurrency eight and account-level failure isolation.
- Pure Markdown/JSON CLI with documented `0`, `1`, and `2` exit codes.
- Loopback Fastify API with Host/Origin checks, CSP, redacted errors, 30-second cache freshness, and scan coalescing.
- Dependency-free dashboard with manual refresh, 60-second auto-refresh, accessible quota rows, and live reset countdowns.
- 47 unit/integration tests before the final profile smoke test, strict typecheck, lint, formatting check, production build, compiled CLI/server smoke tests, dependency audit, and credential-pattern scan.

Account entries are enabled selectively in the external user configuration. No live account identifier, credential, or usage fixture is stored in the release tree. Personal Claude and Codex entries each require one provider login command per account; the resulting credential profiles stay outside the repository.

The original `429` HTTP-fixture requirement became inapplicable after Phase 0 selected local CLI/App Server contracts instead of direct provider HTTP endpoints. V1 performs no retries; provider protocol and timeout failures remain isolated and redacted.

An optional post-implementation Claude audit was attempted. The default Fable reviewer was quota-limited, and a Sonnet retry stalled without producing output and was stopped. No approval or findings are claimed from that attempt; the earlier plan review below remains the completed external review.

## Claude CLI review record

Claude Code 2.1.246 reviewed this note on 2026-08-26 through a non-interactive, read-only command-line invocation. Its initial verdict was “conditionally sound”: the engineering skeleton was approved, but it warned that supported subscription-quota APIs may not exist and that the original plan assumed a single reset window. After the changes below, a second read-only CLI review returned `APPROVED` with no material planning blockers.

Disposition of its findings:

- Accepted: timebox Phase 0, define pivot outcomes, and re-baseline later phases after contract discovery.
- Accepted: model multiple limit windows, use a discriminated success/error union, distinguish metric-level unsupported values from account-level unsupported providers, and validate public payloads at runtime.
- Accepted with adaptation: keep `resetAt` canonical and compute the user-required `minutesUntilReset` at CLI/API render time instead of storing a stale value in the domain snapshot.
- Accepted: define exact CLI flag and exit behavior, keep both stdout modes log-free, harden the loopback server, and quantify refresh, cache, concurrency, and timeout defaults.
- Accepted: strengthen tests for `429`, shared DTO validation, stdout isolation, local binding, redacted server errors, countdown freshness, and shutdown.
- Not treated as verified fact: the reviewer's claims about current provider API availability still require the Phase 0 evidence gate.
