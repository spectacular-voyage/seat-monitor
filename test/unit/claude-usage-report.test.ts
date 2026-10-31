import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { quotaSuccessSchema } from "../../src/domain/quota.js";
import { parseClaudeUsageOutput } from "../../src/services/claude-usage.js";
import { renderMarkdownReport } from "../../src/presentation/table.js";
import { renderTextReport } from "../../src/presentation/text-report.js";
import {
  claudeSnapshot,
  codexSnapshot,
  nowMilliseconds,
  report,
} from "../helpers/quota-fixtures.js";

async function parsedSnapshot(fixture: string, alias: string) {
  const output = await readFile(
    new URL(`../fixtures/${fixture}`, import.meta.url),
    "utf8",
  );
  return quotaSuccessSchema.parse({
    accountAlias: alias,
    platform: "Claude",
    status: "ok",
    plan: "max",
    limits: parseClaudeUsageOutput(output, nowMilliseconds),
    observedAt: new Date(nowMilliseconds).toISOString(),
  });
}

describe("unknown Claude session through reports and decisions", () => {
  it("shows the unknown session as unknown, never as zero or unsupported, in the report, text and table", async () => {
    const snapshot = await parsedSnapshot(
      "claude-usage-weekly-only.txt",
      "claude-weekly@example.com",
    );
    const result = report([snapshot]);
    const session = result.accounts[0]?.rows.find(
      (row) => row.key === "base.session",
    );

    expect(session).toEqual(
      expect.objectContaining({
        label: "Session (unknown)",
        support: "available",
        consumedPercent: null,
        headroomPercent: null,
      }),
    );
    const text = renderTextReport(result);
    const sessionLine = text
      .split("\n")
      .find((line) => line.includes("Session (unknown)"));
    expect(sessionLine).toBeDefined();
    expect(sessionLine).toContain("unknown");
    expect(sessionLine).not.toContain("unsupported");
    expect(sessionLine).not.toContain("0%");
    const table = renderMarkdownReport(result);
    const tableLine = table
      .split("\n")
      .find((line) => line.includes("Session (unknown)"));
    expect(tableLine).toContain("unknown");
    expect(tableLine).not.toContain("unsupported");
  });

  it("does not turn the missing session measurement into usable capacity", async () => {
    const weeklyOnly = await parsedSnapshot(
      "claude-usage-weekly-only.txt",
      "claude-weekly@example.com",
    );

    expect(report([weeklyOnly]).use).toBeNull();
    // Positive control: the same weekly figures with a KNOWN session do produce a recommendation.
    const knownSession = report([
      claudeSnapshot({
        alias: "claude-known@example.com",
        weeklyUsed: 61,
        fableUsed: 72,
        sessionUsed: 8,
      }),
    ]);
    expect(knownSession.use).toEqual(
      expect.objectContaining({ accountAlias: "claude-known@example.com" }),
    );
    // The unknown-session account never wins against a known account.
    expect(
      report([
        weeklyOnly,
        claudeSnapshot({
          alias: "claude-known@example.com",
          weeklyUsed: 61,
          fableUsed: 72,
          sessionUsed: 8,
        }),
        codexSnapshot(),
      ]).use?.accountAlias,
    ).not.toBe("claude-weekly@example.com");
  });

  it("leaves a true unsupported Fable placeholder unchanged and still decidable", async () => {
    const noFable = await parsedSnapshot(
      "claude-usage-no-fable.txt",
      "claude-nofable@example.com",
    );
    const result = report([noFable]);
    const fable = result.accounts[0]?.rows.find((row) =>
      row.key.startsWith("fable"),
    );

    expect(fable).toEqual(
      expect.objectContaining({
        support: "unsupported",
        consumedPercent: null,
      }),
    );
    expect(
      renderTextReport(result)
        .split("\n")
        .find((line) => line.includes("Fable sub-cap")),
    ).toContain("unsupported");
    // A known session with an unsupported Fable placeholder is still usable capacity.
    expect(result.use).toEqual(
      expect.objectContaining({ accountAlias: "claude-nofable@example.com" }),
    );
  });
});
