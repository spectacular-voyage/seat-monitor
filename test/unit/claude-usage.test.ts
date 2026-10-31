import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  ClaudeUsageUnavailableError,
  parseClaudeResetAt,
  parseClaudeUsageOutput,
} from "../../src/services/claude-usage.js";

describe("Claude usage parser", () => {
  it("normalizes session, weekly, and Fable windows", async () => {
    const output = await readFile(
      new URL("../fixtures/claude-usage.txt", import.meta.url),
      "utf8",
    );
    const limits = parseClaudeUsageOutput(
      output,
      Date.parse("2026-08-30T00:30:00.000Z"),
    );

    expect(limits).toEqual([
      expect.objectContaining({
        key: "base.session",
        usedPercent: 8,
        resetAt: "2026-08-30T02:40:00.000Z",
      }),
      expect.objectContaining({
        key: "base.weekly",
        usedPercent: 89,
        resetAt: "2026-09-03T17:00:00.000Z",
      }),
      expect.objectContaining({
        key: "fable.weekly",
        usedPercent: 94,
        resetAt: "2026-09-03T17:00:00.000Z",
      }),
    ]);
  });

  it("rolls a January reset into the next year", () => {
    expect(
      parseClaudeResetAt(
        "Jan 2, 10am (America/Los_Angeles)",
        Date.parse("2026-12-30T18:00:00.000Z"),
      ),
    ).toBe("2027-01-02T18:00:00.000Z");
  });

  it("accepts zero-used windows that omit reset times", () => {
    const limits = parseClaudeUsageOutput(
      [
        "Current session: 0% used",
        "Current week (all models): 0% used",
        "Current week (Fable): 0% used",
      ].join("\n"),
      Date.parse("2026-08-30T00:30:00.000Z"),
    );

    expect(limits).toHaveLength(3);
    expect(
      limits.every(
        (limit) => limit.usedPercent === 0 && limit.resetAt === null,
      ),
    ).toBe(true);
  });

  it.each([
    "claude-usage-advice-only.txt",
    "claude-usage-insights-only-2.1.312.txt",
  ])("reports %s as unavailable, never as a quota reading", async (fixture) => {
    const output = await readFile(
      new URL(`../fixtures/${fixture}`, import.meta.url),
      "utf8",
    );
    expect(() =>
      parseClaudeUsageOutput(output, Date.parse("2026-08-30T00:30:00.000Z")),
    ).toThrow(ClaudeUsageUnavailableError);
  });

  it("reports empty or cost-only output as unavailable", () => {
    for (const output of ["", "Total cost: $0.0000"]) {
      expect(() =>
        parseClaudeUsageOutput(output, Date.parse("2026-08-30T00:30:00.000Z")),
      ).toThrow(ClaudeUsageUnavailableError);
    }
  });

  it("returns the weekly windows with the session explicitly unknown when /usage omits the session line", async () => {
    const output = await readFile(
      new URL("../fixtures/claude-usage-weekly-only.txt", import.meta.url),
      "utf8",
    );
    const limits = parseClaudeUsageOutput(
      output,
      Date.parse("2026-08-30T00:30:00.000Z"),
    );

    expect(limits).toEqual([
      {
        key: "base.session",
        label: "Current Session",
        scope: "window",
        availability: "available",
        usedPercent: null,
        windowDurationMinutes: null,
        resetAt: null,
      },
      expect.objectContaining({
        key: "base.weekly",
        availability: "available",
        usedPercent: 61,
        resetAt: "2026-09-03T17:00:00.000Z",
      }),
      expect.objectContaining({
        key: "fable.weekly",
        availability: "available",
        usedPercent: 72,
        resetAt: "2026-09-03T17:00:00.000Z",
      }),
    ]);
    expect(
      limits.find((limit) => limit.key === "base.session")?.usedPercent,
    ).toBeNull();
  });

  it("keeps a full report unchanged, with a real session reading and no unknown window", async () => {
    const output = await readFile(
      new URL("../fixtures/claude-usage.txt", import.meta.url),
      "utf8",
    );
    const limits = parseClaudeUsageOutput(
      output,
      Date.parse("2026-08-30T00:30:00.000Z"),
    );
    expect(limits.map((limit) => limit.key)).toEqual([
      "base.session",
      "base.weekly",
      "fable.weekly",
    ]);
    expect(limits[0]).toMatchObject({
      availability: "available",
      usedPercent: 8,
      label: "Current Session",
    });
    expect(JSON.stringify(limits)).not.toContain("unknown");
  });

  it("still fails on output with no recognizable window", () => {
    for (const output of [
      "",
      "Total cost: $0.0000",
      "\u0000garbage \ufffd not a usage report",
    ]) {
      expect(() =>
        parseClaudeUsageOutput(output, Date.parse("2026-08-30T00:30:00.000Z")),
      ).toThrow(ClaudeUsageUnavailableError);
    }
  });
});
