import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { LoadedClaudeProfileAccount } from "../../src/config/accounts.js";
import {
  createClaudeHttpUsageReader,
  parseClaudeHttpUsage,
} from "../../src/services/claude-usage-http.js";
import {
  createClaudeUsageFileStore,
  type ClaudeUsageStore,
  type ClaudeUsageStoreEntry,
} from "../../src/services/claude-usage-store.js";

const fixture = JSON.parse(
  readFileSync(
    new URL("../fixtures/claude-usage-http.json", import.meta.url),
    "utf8",
  ),
) as unknown;
const account: LoadedClaudeProfileAccount = {
  accountAlias: "synthetic",
  platform: "Claude",
  auth: {
    type: "claude_profile",
    profile: "synthetic",
    expectedEmail: "synthetic@example.com",
    claudeConfigDir: "/synthetic",
  },
};
const now = () => new Date("2026-08-30T00:30:00Z");
const options = {
  account,
  ultraPlan: false,
  cliVersion: "2.1.314",
  timeoutMilliseconds: 1_000,
  now,
};
const KEY = "a".repeat(64);

function entry(observedAt: string): ClaudeUsageStoreEntry {
  return {
    observedAt,
    ultraPlan: false,
    limits: parseClaudeHttpUsage(fixture, false),
  };
}

const directories: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

async function storePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "seat-monitor-usage-"));
  directories.push(directory);
  return join(directory, "state", "claude-usage.json");
}

describe("Claude usage file store", () => {
  it("round-trips readings in a private file without identities", async () => {
    const filePath = await storePath();
    const store = createClaudeUsageFileStore({ filePath, now });
    await store.save(new Map([[KEY, entry("2026-08-30T00:20:00.000Z")]]));

    expect(await store.load()).toEqual(
      new Map([[KEY, entry("2026-08-30T00:20:00.000Z")]]),
    );
    expect((await stat(filePath)).mode & 0o777).toBe(0o600);
    expect(await readFile(filePath, "utf8")).not.toContain("synthetic");
  });

  it("drops readings from the future or older than a week", async () => {
    const filePath = await storePath();
    const store = createClaudeUsageFileStore({ filePath, now });
    await store.save(
      new Map([
        [KEY, entry("2026-08-23T00:29:00.000Z")],
        ["b".repeat(64), entry("2026-08-30T00:31:00.000Z")],
        ["c".repeat(64), entry("2026-08-29T00:30:00.000Z")],
      ]),
    );
    expect([...(await store.load()).keys()]).toEqual(["c".repeat(64)]);
  });

  it("starts empty when the file is missing or malformed", async () => {
    const filePath = await storePath();
    const store = createClaudeUsageFileStore({ filePath, now });
    expect((await store.load()).size).toBe(0);
    await store.save(new Map());
    await writeFile(filePath, JSON.stringify({ version: 2, accounts: {} }));
    expect((await store.load()).size).toBe(0);
    await writeFile(filePath, "not json");
    expect((await store.load()).size).toBe(0);
  });
});

function memoryStore(initial: [string, ClaudeUsageStoreEntry][] = []) {
  let saved = new Map(initial);
  const save = vi.fn((entries: ReadonlyMap<string, ClaudeUsageStoreEntry>) => {
    saved = new Map(entries);
    return Promise.resolve();
  });
  const store: ClaudeUsageStore = {
    load: () => Promise.resolve(new Map(saved)),
    save,
  };
  return { store, save, saved: () => saved };
}

function reader(store: ClaudeUsageStore, status: () => number) {
  return createClaudeHttpUsageReader({
    store,
    saveDelayMilliseconds: 1_000,
    accessToken: () => Promise.resolve("token"),
    nativeCache: () => Promise.reject(new Error("no native cache")),
    fetch: () =>
      Promise.resolve(
        status() === 200
          ? Response.json(fixture)
          : new Response(null, { status: status() }),
      ),
  });
}

describe("restart-safe throttling fallback", () => {
  it("answers a 429 after a restart with the saved reading", async () => {
    vi.useFakeTimers({ now: now() });
    const memory = memoryStore();
    let status = 200;
    const first = reader(memory.store, () => status);
    const fresh = await first(options);
    await first(options);
    expect(memory.save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    // Two readings in one save window are written once.
    expect(memory.save).toHaveBeenCalledTimes(1);
    expect([...memory.saved().values()]).toEqual([
      { observedAt: fresh.observedAt, ultraPlan: false, limits: fresh.limits },
    ]);

    status = 429;
    const restarted = reader(memory.store, () => status);
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      expect(await restarted(options)).toEqual({ ...fresh, source: "cache" });
      // A reading saved for the other plan is never relabelled.
      await expect(
        restarted({ ...options, ultraPlan: true }),
      ).rejects.toMatchObject({ status: 429 });
    } finally {
      stderr.mockRestore();
    }
  });

  it("keeps restored readings for other profiles when it saves", async () => {
    vi.useFakeTimers({ now: now() });
    const memory = memoryStore([[KEY, entry("2026-08-30T00:20:00.000Z")]]);
    const read = reader(memory.store, () => 200);
    await read(options);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(memory.saved().size).toBe(2);
    expect(memory.saved().get(KEY)).toEqual(entry("2026-08-30T00:20:00.000Z"));
  });

  it("forgets and saves a profile whose bearer is rejected", async () => {
    vi.useFakeTimers({ now: now() });
    const memory = memoryStore();
    let status = 200;
    const read = reader(memory.store, () => status);
    await read(options);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(memory.saved().size).toBe(1);

    status = 401;
    await expect(read(options)).rejects.toMatchObject({ status: 401 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(memory.saved().size).toBe(0);
    status = 429;
    await expect(read(options)).rejects.toMatchObject({ status: 429 });
  });

  it("keeps reading when the store cannot be loaded or saved", async () => {
    vi.useFakeTimers({ now: now() });
    const read = reader(
      {
        load: () => Promise.reject(new Error("unreadable")),
        save: () => Promise.reject(new Error("read-only")),
      },
      () => 200,
    );
    await expect(read(options)).resolves.toMatchObject({ source: "http" });
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(read(options)).resolves.toMatchObject({ source: "http" });
  });
});
