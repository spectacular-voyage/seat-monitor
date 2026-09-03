#!/usr/bin/env node

import { readFile } from "node:fs/promises";

import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import { z } from "zod";

import { historyScansSchema } from "./domain/history.js";
import {
  DEFAULT_SERVER_PORT,
  readServerSettings,
  type ServerSettings,
} from "./config/server-settings.js";
import { buildHistoryAnalytics } from "./history/analytics.js";
import { createRecordingScanner } from "./history/recording-scanner.js";
import {
  createDefaultHistoryService,
  HistoryUnavailableError,
  type HistoryService,
} from "./history/service.js";
import { toPublicSnapshots } from "./presentation/public-dto.js";
import {
  createDefaultScanner,
  type Scanner,
} from "./services/scan-accounts.js";
import { SnapshotCache } from "./services/snapshot-cache.js";
import { ScanScheduler } from "./services/scan-scheduler.js";
import { isMainModule } from "./entry-point.js";

export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = DEFAULT_SERVER_PORT;
export const DEFAULT_FRESHNESS_MILLISECONDS = 30_000;

const refreshQuerySchema = z
  .object({
    refresh: z.literal("true").optional(),
  })
  .strict();

const historyScansQuerySchema = z
  .object({
    from: z.iso.datetime({ offset: true }).optional(),
    to: z.iso.datetime({ offset: true }).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    before: z.coerce.number().int().positive().optional(),
  })
  .strict();

const historyAnalyticsQuerySchema = z
  .object({
    from: z.iso.datetime({ offset: true }).optional(),
    to: z.iso.datetime({ offset: true }).optional(),
    resolution: z.enum(["auto", "raw", "hour"]).default("auto"),
    periods: z
      .enum(["1", "2", "5", "10"])
      .transform((value): 1 | 2 | 5 | 10 => Number(value) as 1 | 2 | 5 | 10)
      .optional(),
    account: z.string().min(1).max(320).optional(),
  })
  .strict();

type DashboardAssets = {
  html: string;
  javascript: string;
  css: string;
};

export type ServerOptions = {
  scan?: Scanner;
  now?: () => Date;
  freshnessMilliseconds?: number;
  host?: string;
  port?: number;
  assets?: DashboardAssets;
  history?: HistoryService;
  scheduler?: {
    intervalMilliseconds: number;
    scanOnStartup: boolean;
  };
};

async function loadDashboardAssets(): Promise<DashboardAssets> {
  const [html, javascript, css] = await Promise.all([
    readFile(new URL("./public/index.html", import.meta.url), "utf8"),
    readFile(new URL("./public/app.js", import.meta.url), "utf8"),
    readFile(new URL("./public/styles.css", import.meta.url), "utf8"),
  ]);
  return { html, javascript, css };
}

function isAllowedAuthority(authority: string, port: number): boolean {
  const normalized = authority.toLocaleLowerCase("en-US");
  return (
    normalized === `127.0.0.1:${String(port)}` ||
    normalized === `localhost:${String(port)}`
  );
}

function requestIsAllowed(request: FastifyRequest, port: number): boolean {
  const authority = request.headers.host;
  if (authority === undefined || !isAllowedAuthority(authority, port)) {
    return false;
  }

  if (request.headers["sec-fetch-site"] === "cross-site") {
    return false;
  }

  const origin = request.headers.origin;
  if (origin === undefined) {
    return true;
  }
  try {
    return isAllowedAuthority(new URL(origin).host, port);
  } catch {
    return false;
  }
}

function sendForbidden(reply: FastifyReply): FastifyReply {
  return reply.code(403).send({
    error: { code: "forbidden", message: "Request origin is not allowed." },
  });
}

function historyRange(options: {
  from: string | undefined;
  to: string | undefined;
  nowMilliseconds: number;
  defaultDurationMilliseconds: number;
  maximumDurationMilliseconds: number;
}): { fromMilliseconds: number; toMilliseconds: number } {
  const toMilliseconds =
    options.to === undefined ? options.nowMilliseconds : Date.parse(options.to);
  const fromMilliseconds =
    options.from === undefined
      ? toMilliseconds - options.defaultDurationMilliseconds
      : Date.parse(options.from);
  z.number()
    .positive()
    .max(options.maximumDurationMilliseconds)
    .parse(toMilliseconds - fromMilliseconds);
  return { fromMilliseconds, toMilliseconds };
}

export async function buildServer(
  options: ServerOptions = {},
): Promise<FastifyInstance> {
  const host = options.host ?? DEFAULT_HOST;
  const port = options.port ?? DEFAULT_PORT;
  if (host !== "127.0.0.1" && host !== "localhost") {
    throw new TypeError("Version 1 only supports a loopback listener.");
  }
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new TypeError("Server port must be an integer from 1 to 65535.");
  }

  const now = options.now ?? (() => new Date());
  const baseScan = options.scan ?? createDefaultScanner();
  const scan =
    options.history === undefined
      ? baseScan
      : createRecordingScanner({
          scan: baseScan,
          history: options.history,
          source: "server",
          now,
        });
  const assets = options.assets ?? (await loadDashboardAssets());
  const cache = new SnapshotCache({
    scan,
    freshnessMilliseconds:
      options.freshnessMilliseconds ?? DEFAULT_FRESHNESS_MILLISECONDS,
    now,
  });
  const scheduler =
    options.scheduler === undefined
      ? null
      : new ScanScheduler({
          refresh: () => cache.read(true),
          ...options.scheduler,
        });
  const server = Fastify({ logger: false });

  server.addHook("onRequest", async (request, reply) => {
    reply.header(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    );
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    if (!requestIsAllowed(request, port)) {
      return sendForbidden(reply);
    }
  });

  server.setErrorHandler((error, _request, reply) => {
    const statusCode =
      error instanceof HistoryUnavailableError
        ? 503
        : error instanceof z.ZodError ||
            (error instanceof Error && "validation" in error)
          ? 400
          : error instanceof Error &&
              "statusCode" in error &&
              error.statusCode === 404
            ? 404
            : 500;
    void reply.code(statusCode).send({
      error: {
        code:
          statusCode === 400
            ? "invalid_request"
            : statusCode === 503
              ? "history_unavailable"
              : statusCode === 404
                ? "not_found"
                : "internal_error",
        message:
          statusCode === 400
            ? "Request parameters are invalid."
            : statusCode === 503
              ? "Historical quota data is unavailable."
              : statusCode === 404
                ? "Route not found."
                : "Request failed.",
      },
    });
  });

  server.setNotFoundHandler((_request, reply) => {
    void reply.code(404).send({
      error: { code: "not_found", message: "Route not found." },
    });
  });

  server.get("/", async (_request, reply) => {
    return reply.type("text/html; charset=utf-8").send(assets.html);
  });
  server.get("/app.js", async (_request, reply) => {
    return reply.type("text/javascript; charset=utf-8").send(assets.javascript);
  });
  server.get("/styles.css", async (_request, reply) => {
    return reply.type("text/css; charset=utf-8").send(assets.css);
  });
  server.get("/api/quota", async (request, reply) => {
    const query = refreshQuerySchema.parse(request.query);
    const forceRefresh = query.refresh === "true";
    const hadSnapshot = cache.hasSnapshot;
    const snapshots = await (forceRefresh
      ? cache.read(true)
      : scheduler === null
        ? cache.read()
        : cache.readLatest());
    if (forceRefresh || (!hadSnapshot && scheduler !== null)) {
      scheduler?.restartCountdown();
    }
    reply.header("Cache-Control", "no-store");
    return toPublicSnapshots(snapshots, now().getTime());
  });
  server.get("/api/history/scans", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    if (options.history === undefined) {
      throw new HistoryUnavailableError();
    }
    const query = historyScansQuerySchema.parse(request.query);
    const nowMilliseconds = now().getTime();
    const range = historyRange({
      from: query.from,
      to: query.to,
      nowMilliseconds,
      defaultDurationMilliseconds: 30 * 86_400_000,
      maximumDurationMilliseconds: 31 * 86_400_000,
    });
    const runs = options.history.listScans({
      ...range,
      limit: query.limit + 1,
      ...(query.before === undefined ? {} : { beforeId: query.before }),
    });
    const hasMore = runs.length > query.limit;
    const page = hasMore ? runs.slice(0, query.limit) : runs;
    return historyScansSchema.parse({
      apiVersion: 1,
      generatedAt: new Date(nowMilliseconds).toISOString(),
      from: new Date(range.fromMilliseconds).toISOString(),
      to: new Date(range.toMilliseconds).toISOString(),
      historyHealth: options.history.health,
      runs: page,
      nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null,
    });
  });
  server.get("/api/history/analytics", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    if (options.history === undefined) {
      throw new HistoryUnavailableError();
    }
    const query = historyAnalyticsQuerySchema.parse(request.query);
    const nowMilliseconds = now().getTime();
    const range = historyRange({
      from: query.from,
      to: query.to,
      nowMilliseconds,
      defaultDurationMilliseconds: 7 * 86_400_000,
      maximumDurationMilliseconds: 366 * 86_400_000,
    });
    const historyQuery = {
      ...range,
      resolution: query.resolution,
      ...(query.account === undefined ? {} : { accountAlias: query.account }),
    };
    const latest = options.history.listScans({
      fromMilliseconds: 0,
      toMilliseconds: nowMilliseconds,
      limit: 1,
    })[0];
    const snapshots =
      latest?.snapshots.filter(
        (snapshot) =>
          query.account === undefined ||
          snapshot.accountAlias.localeCompare(query.account, "en-US", {
            sensitivity: "accent",
          }) === 0,
      ) ?? [];
    return buildHistoryAnalytics({
      snapshots,
      series: options.history.readSeries(historyQuery),
      resetEvents: options.history.listResetEvents(historyQuery),
      historyHealth: options.history.health,
      nowMilliseconds,
      ...range,
      requestedResolution: query.resolution,
      ...(query.periods === undefined
        ? {}
        : { periodMultiplier: query.periods }),
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
  });

  if (options.history !== undefined || scheduler !== null) {
    server.addHook("onClose", async () => {
      await scheduler?.stop();
      options.history?.close();
    });
  }

  await server.ready();
  scheduler?.start();
  return server;
}

function readServerConfiguration(settings: ServerSettings): {
  host: string;
  port: number;
} {
  const host = process.env.SEAT_MONITOR_HOST ?? DEFAULT_HOST;
  return { host, port: settings.port };
}

async function main(): Promise<void> {
  const settings = readServerSettings();
  const configuration = readServerConfiguration(settings);
  const server = await buildServer({
    ...configuration,
    history: createDefaultHistoryService(
      process.env,
      () => new Date(),
      settings.history,
    ),
    scheduler: {
      intervalMilliseconds: settings.scanIntervalSeconds * 1_000,
      scanOnStartup: settings.scanOnStartup,
    },
  });

  const shutdown = async (): Promise<void> => {
    await server.close();
  };
  process.once("SIGINT", () => {
    void shutdown();
  });
  process.once("SIGTERM", () => {
    void shutdown();
  });

  try {
    await server.listen(configuration);
  } catch (error) {
    await server.close();
    throw error;
  }
  process.stderr.write(
    `Seat Monitor listening on http://${configuration.host}:${String(configuration.port)}\n`,
  );
}

if (isMainModule(import.meta.url)) {
  try {
    await main();
  } catch {
    process.stderr.write("Seat Monitor server failed to start.\n");
    process.exitCode = 2;
  }
}
