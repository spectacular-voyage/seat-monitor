import { open } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { PACKAGE_VERSION } from "../version.js";

/** Bounded provider HTTP and profile-file reads shared by direct readers. */
const MAX_BYTES = 1_000_000;
const DEFAULT_TIMEOUT_MILLISECONDS = 10_000;
const USER_AGENT = `seat-monitor/${PACKAGE_VERSION}`;

export async function readJsonFile(path: string): Promise<unknown> {
  const file = await open(path, "r");
  try {
    if ((await file.stat()).size > MAX_BYTES) {
      throw new RangeError("Profile file is too large.");
    }
    return JSON.parse(await file.readFile("utf8")) as unknown;
  } finally {
    await file.close();
  }
}

export type JsonResponse =
  | { kind: "ok"; status: number; payload: unknown }
  | { kind: "http_error"; status: number }
  | { kind: "invalid_response"; status: number }
  | { kind: "network_error" };

export async function requestJson(
  fetchImplementation: typeof fetch,
  url: string,
  headers: Record<string, string>,
  timeoutMilliseconds = DEFAULT_TIMEOUT_MILLISECONDS,
): Promise<JsonResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMilliseconds);
  try {
    const response = await fetchImplementation(url, {
      headers: {
        ...headers,
        Accept: "application/json",
        "User-Agent": USER_AGENT,
      },
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      return { kind: "http_error", status: response.status };
    }
    if (response.body === null) {
      return { kind: "invalid_response", status: response.status };
    }
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for await (const chunk of response.body) {
      if (!(chunk instanceof Uint8Array)) {
        return { kind: "invalid_response", status: response.status };
      }
      bytes += chunk.byteLength;
      if (bytes > MAX_BYTES) {
        controller.abort();
        return { kind: "invalid_response", status: response.status };
      }
      chunks.push(chunk);
    }
    try {
      return {
        kind: "ok",
        status: response.status,
        payload: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
      };
    } catch {
      return { kind: "invalid_response", status: response.status };
    }
  } catch {
    return { kind: "network_error" };
  } finally {
    clearTimeout(timer);
  }
}

const codexAuthSchema = z.object({
  tokens: z.object({
    access_token: z.string().min(1).max(16_384),
    account_id: z.string().min(1).max(256),
  }),
});

export type CodexTokens = z.infer<typeof codexAuthSchema>["tokens"];

/** The ChatGPT bearer a Codex profile stores; throws when it has none. */
export async function readCodexTokens(codexHome: string): Promise<CodexTokens> {
  return codexAuthSchema.parse(await readJsonFile(join(codexHome, "auth.json")))
    .tokens;
}

export function codexRequestHeaders(
  tokens: CodexTokens,
): Record<string, string> {
  return {
    Authorization: `Bearer ${tokens.access_token}`,
    "chatgpt-account-id": tokens.account_id,
  };
}
