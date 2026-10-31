import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  createNotApplicableSession,
  fallbackLimit,
} from "../../src/public/session-applicability.js";
import { toPublicSnapshots } from "../../src/presentation/public-dto.js";
import { parseClaudeUsageOutput } from "../../src/services/claude-usage.js";

const usage = readFileSync(
  new URL("../fixtures/claude-usage-ultra.txt", import.meta.url),
  "utf8",
);
const now = Date.parse("2026-08-30T00:30:00.000Z");

// Execute the dashboard's real rendering functions with a minimal DOM. No
// fetch, browser timer, native provider or live server runs in these tests.
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
  const raw = snapshots[0]?.limits[0];
  if (raw === undefined) throw new Error("Missing synthetic session");
  const limit = fallbackLimit(raw, null);
  const element = (name: string, className: string, text?: string) => {
    const node = new Element(name);
    node.className = className;
    node.textContent = text ?? "";
    return node;
  };
  return {
    limit,
    detail: createNotApplicableSession(limit, element),
    capacity: createNotApplicableSession(limit, element, true),
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
    expect(unknown.detail).toBeNull();
    expect(unknown.capacity).toBeNull();
  });
});
