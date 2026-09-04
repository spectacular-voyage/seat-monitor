import { describe, expect, it, vi } from "vitest";

import {
  publicQuotaArraySchema,
  quotaSuccessSchema,
} from "../../src/domain/quota.js";
import {
  historyAnalyticsSchema,
  historyScansSchema,
} from "../../src/domain/history.js";
import { HistoryService } from "../../src/history/service.js";
import { openSqliteHistoryStore } from "../../src/history/sqlite-store.js";
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

function history(now: string): HistoryService {
  return new HistoryService(
    openSqliteHistoryStore(
      { filePath: ":memory:", rawRetentionDays: 30, retentionDays: 365 },
      { now: () => new Date(now) },
    ),
  );
}

describe("HTTP server", () => {
  it("reloads dashboard assets per request in source development", async () => {
    let currentAssets = {
      html: "<!doctype html><title>Version 1</title>",
      javascript: "window.version = 1;",
      css: "body { --version: 1; }",
    };
    const dashboardAssetLoader = vi.fn(() => Promise.resolve(currentAssets));
    const server = await buildServer({
      dashboardAssetLoader,
      reloadDashboardAssets: true,
      scan: () => Promise.resolve([]),
    });

    const first = await Promise.all(
      ["/", "/app.js", "/styles.css"].map((url) =>
        server.inject({ method: "GET", url, headers: allowedHeaders }),
      ),
    );
    currentAssets = {
      html: "<!doctype html><title>Version 2</title>",
      javascript: "window.version = 2;",
      css: "body { --version: 2; }",
    };
    const second = await Promise.all(
      ["/", "/app.js", "/styles.css"].map((url) =>
        server.inject({ method: "GET", url, headers: allowedHeaders }),
      ),
    );
    await server.close();

    expect(first.map((response) => response.body)).toEqual([
      "<!doctype html><title>Version 1</title>",
      "window.version = 1;",
      "body { --version: 1; }",
    ]);
    expect(second.map((response) => response.body)).toEqual([
      "<!doctype html><title>Version 2</title>",
      "window.version = 2;",
      "body { --version: 2; }",
    ]);
    expect(
      second.every(
        (response) => response.headers["cache-control"] === "no-store",
      ),
    ).toBe(true);
    expect(dashboardAssetLoader).toHaveBeenCalledTimes(6);
  });

  it("keeps supplied packaged dashboard assets cached", async () => {
    const server = await buildServer({
      assets,
      scan: () => Promise.resolve([]),
    });

    const responses = await Promise.all(
      ["/", "/app.js", "/styles.css"].map((url) =>
        server.inject({ method: "GET", url, headers: allowedHeaders }),
      ),
    );
    await server.close();

    expect(responses.map((response) => response.body)).toEqual([
      assets.html,
      assets.javascript,
      assets.css,
    ]);
    expect(
      responses.every(
        (response) => response.headers["cache-control"] === undefined,
      ),
    ).toBe(true);
  });

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

  it("starts scheduled scans without an HTTP client", async () => {
    const scan = vi.fn(() => Promise.resolve([snapshot()]));
    const server = await buildServer({
      assets,
      scan,
      scheduler: {
        intervalMilliseconds: 60_000,
        scanOnStartup: true,
      },
    });

    await vi.waitFor(() => {
      expect(scan).toHaveBeenCalledOnce();
    });
    await server.close();
  });

  it("uses scheduled cache reads instead of creating a dashboard polling loop", async () => {
    let now = new Date("2026-08-26T18:00:00.000Z");
    const scan = vi.fn(() => Promise.resolve([snapshot()]));
    const server = await buildServer({
      assets,
      scan,
      now: () => now,
      scheduler: {
        intervalMilliseconds: 60_000,
        scanOnStartup: false,
      },
    });

    const initial = await server.inject({
      method: "GET",
      url: "/api/quota",
      headers: allowedHeaders,
    });
    now = new Date("2026-08-26T18:00:31.000Z");
    const staleButScheduled = await server.inject({
      method: "GET",
      url: "/api/quota",
      headers: allowedHeaders,
    });
    const manual = await server.inject({
      method: "GET",
      url: "/api/quota?refresh=true",
      headers: allowedHeaders,
    });
    await server.close();

    expect([
      initial.statusCode,
      staleButScheduled.statusCode,
      manual.statusCode,
    ]).toEqual([200, 200, 200]);
    expect(scan).toHaveBeenCalledTimes(2);
  });

  it("records actual scans and exposes validated historical APIs", async () => {
    const now = "2026-08-26T18:00:01.000Z";
    const historyService = history(now);
    const server = await buildServer({
      assets,
      scan: () => Promise.resolve([snapshot()]),
      history: historyService,
      now: () => new Date(now),
      scheduler: {
        intervalMilliseconds: 60_000,
        scanOnStartup: false,
      },
    });

    const quota = await server.inject({
      method: "GET",
      url: "/api/quota",
      headers: allowedHeaders,
    });
    const cachedQuota = await server.inject({
      method: "GET",
      url: "/api/quota",
      headers: allowedHeaders,
    });
    const scans = await server.inject({
      method: "GET",
      url: "/api/history/scans",
      headers: allowedHeaders,
    });
    const analytics = await server.inject({
      method: "GET",
      url: "/api/history/analytics",
      headers: allowedHeaders,
    });
    const halfPeriodAnalytics = await server.inject({
      method: "GET",
      url: "/api/history/analytics?periods=0.5",
      headers: allowedHeaders,
    });

    expect(quota.statusCode).toBe(200);
    expect(cachedQuota.statusCode).toBe(200);
    expect(scans.statusCode).toBe(200);
    expect(scans.headers["cache-control"]).toBe("no-store");
    expect(historyScansSchema.parse(scans.json()).runs).toHaveLength(1);
    const analyticsPayload = historyAnalyticsSchema.parse(analytics.json());
    const halfPeriodPayload = historyAnalyticsSchema.parse(
      halfPeriodAnalytics.json(),
    );
    expect(analyticsPayload.periodMultiplier).toBeNull();
    expect(halfPeriodPayload.periodMultiplier).toBe(0.5);
    expect(analyticsPayload.lastScanAt).toBe(now);
    expect(analyticsPayload.scanIntervalSeconds).toBe(60);
    expect(analyticsPayload.accounts[0]).toEqual(
      expect.objectContaining({
        accountAlias: "Codex_Work",
        platform: "Codex",
      }),
    );
    expect(analyticsPayload.accounts[0]?.limits[0]?.projection.status).toBe(
      "insufficient_history",
    );
    await server.close();
  });

  it("bounds historical queries and redacts unavailable history", async () => {
    const unavailableServer = await buildServer({
      assets,
      scan: () => Promise.resolve([]),
    });
    const unavailable = await unavailableServer.inject({
      method: "GET",
      url: "/api/history/analytics",
      headers: allowedHeaders,
    });
    await unavailableServer.close();

    const boundedServer = await buildServer({
      assets,
      scan: () => Promise.resolve([]),
      history: history("2026-01-01T00:00:00.000Z"),
    });
    const invalid = await boundedServer.inject({
      method: "GET",
      url: "/api/history/scans?from=2025-01-01T00%3A00%3A00.000Z&to=2026-01-01T00%3A00%3A00.000Z",
      headers: allowedHeaders,
    });
    await boundedServer.close();

    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.json()).toEqual({
      error: {
        code: "history_unavailable",
        message: "Historical quota data is unavailable.",
      },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toEqual({
      error: {
        code: "invalid_request",
        message: "Request parameters are invalid.",
      },
    });
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
