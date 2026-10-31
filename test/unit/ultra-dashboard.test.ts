import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

import { describe, expect, it } from "vitest";

import { toPublicSnapshots } from "../../src/presentation/public-dto.js";
import { parseClaudeUsageOutput } from "../../src/services/claude-usage.js";

const javascript = readFileSync(
  new URL("../../src/public/app.js", import.meta.url),
  "utf8",
);
const usage = readFileSync(
  new URL("../fixtures/claude-usage-ultra.txt", import.meta.url),
  "utf8",
);
const now = Date.parse("2026-08-30T00:30:00.000Z");

// Execute the dashboard's real rendering functions with a minimal DOM. No
// fetch, browser timer, native provider or live server runs in these tests.
function dashboardFunction(name: string): string {
  const start = javascript.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`Missing dashboard function: ${name}`);
  const end = javascript.indexOf("\nfunction ", start + 1);
  return javascript.slice(start, end < 0 ? undefined : end);
}

class Element {
  className = "";
  textContent = "";
  children: Element[] = [];
  constructor(public tagName: string) {}
  append(...children: Element[]) {
    this.children.push(...children);
  }
}

function ui(ultra: boolean) {
  const snapshots = toPublicSnapshots(
    [
      {
        accountAlias: "claude-synthetic@example.com",
        platform: "Claude",
        status: "ok",
        plan: "ultra",
        observedAt: new Date(now).toISOString(),
        limits: parseClaudeUsageOutput(usage, now, ultra),
      },
    ],
    now,
  );
  return runInNewContext(
    [
      ...[
        "element",
        "fallbackLimit",
        "createLimit",
        "createCapacityLimit",
        "projectionText",
      ].map(dashboardFunction),
      "const limit = fallbackLimit(raw, null);",
      "({ limit, detail: limit.applicability ? createLimit(limit, 0, 1) : null, capacity: limit.applicability ? createCapacityLimit(limit) : null })",
    ].join("\n"),
    {
      raw: snapshots[0]?.limits[0],
      DEFAULT_USAGE_CHART_HEIGHT: 176,
      document: { createElement: (name: string) => new Element(name) },
    },
  ) as {
    limit: { applicability?: string; projection: { status: string } };
    detail: Element | null;
    capacity: Element | null;
  };
}

function treeText(node: Element | null): string {
  return node === null
    ? ""
    : [
        node.tagName,
        node.className,
        node.textContent,
        ...node.children.map(treeText),
      ].join(" ");
}

describe("Ultra dashboard rendering", () => {
  it("renders explicit N/A in capacity and detail even with history offline, without a session meter or reset", () => {
    const result = ui(true);
    expect(result.limit).toMatchObject({
      applicability: "not_applicable",
      projection: { status: "not_applicable" },
    });
    expect(treeText(result.detail)).toContain(
      "N/A: verified Ultra has no five-hour session limit. Weekly limits still apply.",
    );
    expect(treeText(result.capacity)).toContain("N/A");
    expect(treeText(result.capacity) + treeText(result.detail)).not.toMatch(
      /0%|Starts when|capacity-meter|svg/u,
    );
  });

  it("keeps the paired legacy Max omission unknown in the same fallback path", () => {
    expect(ui(true).limit.applicability).toBe("not_applicable");
    const unknown = ui(false);
    expect(unknown.limit).not.toHaveProperty("applicability");
    expect(unknown.limit.projection.status).toBe("insufficient_history");
  });
});
