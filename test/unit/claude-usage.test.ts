import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
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

  it("rejects output without a session window", () => {
    expect(() =>
      parseClaudeUsageOutput(
        "Total cost: $0.0000",
        Date.parse("2026-08-30T00:30:00.000Z"),
      ),
    ).toThrow("session window");
  });
});
