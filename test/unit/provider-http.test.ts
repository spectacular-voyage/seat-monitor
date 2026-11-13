import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  codexRequestHeaders,
  readCodexTokens,
  readJsonFile,
  requestJson,
} from "../../src/services/provider-http.js";

const URL = "https://provider.example/api";

describe("requestJson", () => {
  it("sends the client headers and rejects redirects", async () => {
    let init: RequestInit | undefined;
    const response = await requestJson(
      (_input, options) => {
        init = options;
        return Promise.resolve(Response.json({ ok: true }));
      },
      URL,
      { Authorization: "Bearer value" },
    );
    expect(response).toEqual({
      kind: "ok",
      status: 200,
      payload: { ok: true },
    });
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer value");
    expect(headers.get("accept")).toBe("application/json");
    expect(headers.get("user-agent")).toMatch(/^seat-monitor\/\d+\.\d+\.\d+/u);
    expect(init?.redirect).toBe("error");
  });

  it("reports HTTP errors with their status", async () => {
    await expect(
      requestJson(
        () => Promise.resolve(new Response("busy", { status: 429 })),
        URL,
        {},
      ),
    ).resolves.toEqual({ kind: "http_error", status: 429 });
  });

  it("rejects missing, oversized and non-JSON bodies", async () => {
    await expect(
      requestJson(
        () => Promise.resolve(new Response(null, { status: 200 })),
        URL,
        {},
      ),
    ).resolves.toEqual({ kind: "invalid_response", status: 200 });
    await expect(
      requestJson(
        () => Promise.resolve(new Response("x".repeat(1_000_001))),
        URL,
        {},
      ),
    ).resolves.toEqual({ kind: "invalid_response", status: 200 });
    await expect(
      requestJson(() => Promise.resolve(new Response("not json")), URL, {}),
    ).resolves.toEqual({ kind: "invalid_response", status: 200 });
  });

  it("aborts a request that outlives its deadline", async () => {
    const response = await requestJson(
      (_input, options) =>
        new Promise<Response>((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => {
            reject(new Error("aborted"));
          });
        }),
      URL,
      {},
      5,
    );
    expect(response).toEqual({ kind: "network_error" });
  });
});

describe("profile files", () => {
  const directories: string[] = [];
  afterEach(async () => {
    await Promise.all(
      directories
        .splice(0)
        .map((directory) => rm(directory, { force: true, recursive: true })),
    );
  });

  async function directory(): Promise<string> {
    const created = await mkdtemp(join(tmpdir(), "seat-monitor-provider-"));
    directories.push(created);
    return created;
  }

  it("refuses an oversized profile file", async () => {
    const path = join(await directory(), "large.json");
    await writeFile(path, `"${"x".repeat(1_000_001)}"`);
    await expect(readJsonFile(path)).rejects.toBeInstanceOf(RangeError);
  });

  it("reads Codex tokens and builds the request headers", async () => {
    const codexHome = await directory();
    await writeFile(
      join(codexHome, "auth.json"),
      JSON.stringify({
        tokens: { access_token: "access", account_id: "workspace" },
      }),
    );
    expect(codexRequestHeaders(await readCodexTokens(codexHome))).toEqual({
      Authorization: "Bearer access",
      "chatgpt-account-id": "workspace",
    });
  });
});
