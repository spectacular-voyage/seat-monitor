#!/usr/bin/env node

import { readFile } from "node:fs/promises";

import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import { z } from "zod";

import { toPublicSnapshots } from "./presentation/public-dto.js";
import {
  createDefaultScanner,
  type Scanner,
} from "./services/scan-accounts.js";
import { SnapshotCache } from "./services/snapshot-cache.js";
import { isMainModule } from "./entry-point.js";

export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 3_000;
export const DEFAULT_FRESHNESS_MILLISECONDS = 30_000;

const refreshQuerySchema = z
  .object({
    refresh: z.literal("true").optional(),
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
  const scan = options.scan ?? createDefaultScanner();
  const assets = options.assets ?? (await loadDashboardAssets());
  const cache = new SnapshotCache({
    scan,
    freshnessMilliseconds:
      options.freshnessMilliseconds ?? DEFAULT_FRESHNESS_MILLISECONDS,
    now,
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
      error instanceof z.ZodError ||
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
            : statusCode === 404
              ? "not_found"
              : "internal_error",
        message:
          statusCode === 400
            ? "Request parameters are invalid."
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
    const snapshots = await cache.read(query.refresh === "true");
    reply.header("Cache-Control", "no-store");
    return toPublicSnapshots(snapshots, now().getTime());
  });

  await server.ready();
  return server;
}

function readServerConfiguration(): { host: string; port: number } {
  const host = process.env.SEAT_MONITOR_HOST ?? DEFAULT_HOST;
  const portText = process.env.SEAT_MONITOR_PORT ?? String(DEFAULT_PORT);
  const port = Number(portText);
  if (!Number.isInteger(port)) {
    throw new TypeError("SEAT_MONITOR_PORT must be an integer.");
  }
  return { host, port };
}

async function main(): Promise<void> {
  const configuration = readServerConfiguration();
  const server = await buildServer(configuration);

  const shutdown = async (): Promise<void> => {
    await server.close();
  };
  process.once("SIGINT", () => {
    void shutdown();
  });
  process.once("SIGTERM", () => {
    void shutdown();
  });

  await server.listen(configuration);
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
