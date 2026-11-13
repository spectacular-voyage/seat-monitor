import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { normalizeCodexResult } from "../../src/services/codex.js";
import {
  CODEX_RESET_CREDITS_URL,
  CODEX_USAGE_URL,
  CodexUsageHttpError,
  codexHttpUsageToAppServerResult,
  createCodexHttpUsageReader,
} from "../../src/services/codex-usage-http.js";

const OBSERVED_AT = "2026-11-12T20:00:00.000Z";

// Shaped like a live /wham/usage answer; identifiers are placeholders.
function usagePayload(overrides: Record<string, unknown> = {}) {
  return {
    user_id: "private-user",
    account_id: "private-account",
    email: "person@example.com",
    plan_type: "pro",
    rate_limit: {
      allowed: true,
      limit_reached: false,
      primary_window: {
        used_percent: 98,
        limit_window_seconds: 604_800,
        reset_after_seconds: 161_973,
        reset_at: 1_794_697_094,
      },
      secondary_window: null,
    },
    code_review_rate_limit: null,
    additional_rate_limits: [
      {
        limit_name: "GPT-5.3-Codex-Spark",
        metered_feature: "codex_bengalfox",
        rate_limit: {
          primary_window: {
            used_percent: 12,
            limit_window_seconds: 18_000,
            reset_at: 1_794_540_000,
          },
          secondary_window: {
            used_percent: 30,
            limit_window_seconds: 604_800,
            reset_at: 1_794_697_094,
          },
        },
      },
    ],
    credits: { has_credits: false, unlimited: false, balance: "0" },
    rate_limit_reset_credits: {
      available_count: 2,
      applicable_available_count: 0,
    },
    ...overrides,
  };
}

const creditsPayload = {
  credits: [
    {
      id: "private-credit-1",
      reset_type: "codex_rate_limits",
      status: "available",
      granted_at: "2026-11-01T23:02:14.589717Z",
      expires_at: "2026-12-01T23:02:14.589717Z",
      profile_user_id: "private-user",
      title: "Full reset",
    },
    {
      id: "private-credit-2",
      reset_type: "codex_rate_limits",
      status: "redeemed",
      expires_at: "2026-12-12T22:46:48.977523Z",
      title: "Full reset",
    },
  ],
  available_count: 2,
};

describe("codexHttpUsageToAppServerResult", () => {
  it("normalizes to the same keys and labels as the App Server", () => {
    const snapshot = normalizeCodexResult(
      "codex-personal",
      codexHttpUsageToAppServerResult(usagePayload(), creditsPayload),
      OBSERVED_AT,
    );
    expect(snapshot.status).toBe("ok");
    if (snapshot.status !== "ok") throw new TypeError("Expected quota.");
    expect(snapshot.plan).toBe("pro");
    expect(
      snapshot.limits.map((limit) => [
        limit.key,
        limit.label,
        limit.usedPercent,
        limit.windowDurationMinutes,
        limit.resetAt,
      ]),
    ).toEqual([
      [
        "codex.primary",
        "Codex Primary",
        98,
        10_080,
        "2026-11-14T22:58:14.000Z",
      ],
      [
        "codex_bengalfox.primary",
        "GPT-5.3-Codex-Spark Primary",
        12,
        300,
        "2026-11-13T03:20:00.000Z",
      ],
      [
        "codex_bengalfox.secondary",
        "GPT-5.3-Codex-Spark Secondary",
        30,
        10_080,
        "2026-11-14T22:58:14.000Z",
      ],
    ]);
    // Only available credits become offers; the redeemed one is counted out.
    expect(snapshot.resetOffers).toEqual([
      { label: "Full reset", count: 1, expiresAt: "2026-12-01T23:02:14.000Z" },
      { label: "Reset credit", count: 1, expiresAt: null },
    ]);
    const serialized = JSON.stringify(snapshot);
    for (const secret of ["private-", "person@example.com"]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("keeps the credit count when the credit list is unavailable", () => {
    const snapshot = normalizeCodexResult(
      "codex-personal",
      codexHttpUsageToAppServerResult(usagePayload(), null),
      OBSERVED_AT,
    );
    if (snapshot.status !== "ok") throw new TypeError("Expected quota.");
    expect(snapshot.resetOffers).toEqual([
      { label: "Reset credit", count: 2, expiresAt: null },
    ]);
  });

  it("reports no reset offers when the payload omits credits", () => {
    const snapshot = normalizeCodexResult(
      "codex-personal",
      codexHttpUsageToAppServerResult(
        usagePayload({ rate_limit_reset_credits: null }),
        null,
      ),
      OBSERVED_AT,
    );
    if (snapshot.status !== "ok") throw new TypeError("Expected quota.");
    expect(snapshot.resetOffers).toBeNull();
  });

  it("rejects a payload without a rate_limit field", () => {
    const payload: Record<string, unknown> = usagePayload();
    delete payload.rate_limit;
    expect(() => codexHttpUsageToAppServerResult(payload, null)).toThrow();
  });
});

describe("createCodexHttpUsageReader", () => {
  const homes: string[] = [];
  afterEach(async () => {
    await Promise.all(
      homes.splice(0).map((home) => rm(home, { force: true, recursive: true })),
    );
  });

  async function codexHome(auth: unknown): Promise<string> {
    const home = await mkdtemp(join(tmpdir(), "seat-monitor-codex-http-"));
    homes.push(home);
    await writeFile(join(home, "auth.json"), JSON.stringify(auth), {
      mode: 0o600,
    });
    return home;
  }

  const auth = {
    tokens: { access_token: "access-value", account_id: "workspace-value" },
  };

  function jsonResponse(payload: unknown, status = 200): Response {
    return new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  it("reads usage and the credit list with the profile's bearer", async () => {
    const requests: { url: string; headers: Headers; redirect: string }[] = [];
    const read = createCodexHttpUsageReader({
      fetch: (input, init) => {
        const url = input instanceof Request ? input.url : String(input);
        requests.push({
          url,
          headers: new Headers(init?.headers),
          redirect: init?.redirect ?? "follow",
        });
        return Promise.resolve(
          jsonResponse(
            url === CODEX_USAGE_URL ? usagePayload() : creditsPayload,
          ),
        );
      },
    });

    const result = await read({
      codexHome: await codexHome(auth),
      timeoutMilliseconds: 5_000,
    });
    expect(requests.map((request) => request.url)).toEqual([
      CODEX_USAGE_URL,
      CODEX_RESET_CREDITS_URL,
    ]);
    for (const request of requests) {
      expect(request.headers.get("authorization")).toBe("Bearer access-value");
      expect(request.headers.get("chatgpt-account-id")).toBe("workspace-value");
      expect(request.redirect).toBe("error");
    }
    const snapshot = normalizeCodexResult(
      "codex-personal",
      result,
      OBSERVED_AT,
    );
    if (snapshot.status !== "ok") throw new TypeError("Expected quota.");
    expect(snapshot.resetOffers?.[0]?.label).toBe("Full reset");
  });

  it("skips the credit list when no credits are available", async () => {
    const urls: string[] = [];
    const read = createCodexHttpUsageReader({
      fetch: (input) => {
        urls.push(input instanceof Request ? input.url : String(input));
        return Promise.resolve(
          jsonResponse(
            usagePayload({
              rate_limit_reset_credits: {
                available_count: 0,
                applicable_available_count: 0,
              },
            }),
          ),
        );
      },
    });

    await read({
      codexHome: await codexHome(auth),
      timeoutMilliseconds: 5_000,
    });
    expect(urls).toEqual([CODEX_USAGE_URL]);
  });

  it("rejects a profile without ChatGPT tokens before any request", async () => {
    let fetched = false;
    const read = createCodexHttpUsageReader({
      fetch: () => {
        fetched = true;
        return Promise.resolve(jsonResponse(usagePayload()));
      },
    });

    await expect(
      read({ codexHome: await codexHome({}), timeoutMilliseconds: 5_000 }),
    ).rejects.toMatchObject({ reason: "credential_unavailable", status: null });
    expect(fetched).toBe(false);
  });

  it("reports a rejected bearer with its status", async () => {
    const read = createCodexHttpUsageReader({
      fetch: () => Promise.resolve(jsonResponse({ detail: "expired" }, 401)),
    });

    const failure = read({
      codexHome: await codexHome(auth),
      timeoutMilliseconds: 5_000,
    });
    await expect(failure).rejects.toBeInstanceOf(CodexUsageHttpError);
    await expect(failure).rejects.toMatchObject({
      reason: "http_error",
      status: 401,
    });
  });

  it("reports an unknown payload layout as invalid", async () => {
    const read = createCodexHttpUsageReader({
      fetch: () => Promise.resolve(jsonResponse({ plan_type: "pro" })),
    });

    await expect(
      read({ codexHome: await codexHome(auth), timeoutMilliseconds: 5_000 }),
    ).rejects.toMatchObject({ reason: "invalid_response", status: 200 });
  });
});
