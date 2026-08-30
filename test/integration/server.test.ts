import { describe, expect, it, vi } from "vitest";

import {
  publicQuotaArraySchema,
  quotaSuccessSchema,
} from "../../src/domain/quota.js";
import { buildServer } from "../../src/server.js";

const assets = {
  html: "<!doctype html><title>Test</title>",
  javascript: "void 0;",
  css: "body {}",
};

function snapshot() {
  return quotaSuccessSchema.parse({
    accountAlias: "Codex_Work",
    platform: "Codex",
    status: "ok",
    plan: "business",
    limits: [
      {
        key: "codex.primary",
        label: "Codex Primary",
        scope: "window",
        availability: "available",
        usedPercent: 42,
        windowDurationMinutes: 300,
        resetAt: "2026-08-26T18:00:30.000Z",
      },
    ],
    observedAt: "2026-08-26T18:00:00.000Z",
  });
}

const allowedHeaders = { host: "127.0.0.1:3000" };

describe("HTTP server", () => {
  it("serves the shared public DTO with fresh countdowns and no-store", async () => {
    const server = await buildServer({
      assets,
      scan: () => Promise.resolve([snapshot()]),
      now: () => new Date("2026-08-26T18:00:00.001Z"),
    });

    const response = await server.inject({
      method: "GET",
      url: "/api/quota",
      headers: allowedHeaders,
    });
    await server.close();

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    const payload = publicQuotaArraySchema.parse(response.json());
    const firstSnapshot = payload[0];
    expect(firstSnapshot?.status).toBe("ok");
    if (firstSnapshot?.status !== "ok") {
      throw new TypeError("Expected a successful public snapshot.");
    }
    expect(firstSnapshot.limits[0]?.minutesUntilReset).toBe(1);
  });

  it("coalesces simultaneous forced refresh requests", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const scan = vi.fn(async () => {
      await gate;
      return [snapshot()];
    });
    const server = await buildServer({ assets, scan });

    const first = server.inject({
      method: "GET",
      url: "/api/quota?refresh=true",
      headers: allowedHeaders,
    });
    const second = server.inject({
      method: "GET",
      url: "/api/quota?refresh=true",
      headers: allowedHeaders,
    });
    release?.();
    const responses = await Promise.all([first, second]);
    await server.close();

    expect(responses.map((response) => response.statusCode)).toEqual([
      200, 200,
    ]);
    expect(scan).toHaveBeenCalledOnce();
  });

  it("rejects invalid hosts and cross-site browser requests", async () => {
    const scan = vi.fn(() => Promise.resolve([]));
    const server = await buildServer({
      assets,
      scan,
    });
    const invalidHost = await server.inject({
      method: "GET",
      url: "/api/quota",
      headers: { host: "attacker.example" },
    });
    const crossSite = await server.inject({
      method: "GET",
      url: "/api/quota",
      headers: {
        ...allowedHeaders,
        origin: "https://attacker.example",
        "sec-fetch-site": "cross-site",
      },
    });
    await server.close();

    expect(invalidHost.statusCode).toBe(403);
    expect(crossSite.statusCode).toBe(403);
    expect(scan).not.toHaveBeenCalled();
  });

  it("returns redacted client errors for invalid queries and missing routes", async () => {
    const server = await buildServer({
      assets,
      scan: () => Promise.resolve([]),
    });
    const invalidQuery = await server.inject({
      method: "GET",
      url: "/api/quota?refresh=false",
      headers: allowedHeaders,
    });
    const missingRoute = await server.inject({
      method: "GET",
      url: "/missing",
      headers: allowedHeaders,
    });
    await server.close();

    expect(invalidQuery.statusCode).toBe(400);
    expect(invalidQuery.json()).toEqual({
      error: {
        code: "invalid_request",
        message: "Request parameters are invalid.",
      },
    });
    expect(missingRoute.statusCode).toBe(404);
    expect(missingRoute.json()).toEqual({
      error: { code: "not_found", message: "Route not found." },
    });
  });

  it("redacts unexpected scan failures", async () => {
    const server = await buildServer({
      assets,
      scan: () => Promise.reject(new Error("secret upstream body")),
    });
    const response = await server.inject({
      method: "GET",
      url: "/api/quota",
      headers: allowedHeaders,
    });
    await server.close();

    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain("secret upstream body");
    expect(response.json()).toEqual({
      error: { code: "internal_error", message: "Request failed." },
    });
  });

  it("refuses non-loopback listeners", async () => {
    await expect(
      buildServer({
        assets,
        host: "0.0.0.0",
        scan: () => Promise.resolve([]),
      }),
    ).rejects.toThrow("loopback");
  });
});
