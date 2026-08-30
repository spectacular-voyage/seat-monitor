import { describe, expect, it } from "vitest";

import { quotaSuccessSchema } from "../../src/domain/quota.js";
import { renderMarkdownReport } from "../../src/presentation/table.js";
import { renderTextReport } from "../../src/presentation/text-report.js";
import {
  claudeSnapshot,
  codexSnapshot,
  report,
} from "../helpers/quota-fixtures.js";

describe("quota report rendering", () => {
  it("renders standalone USE/WATCH lines and nested aligned text", () => {
    const output = renderTextReport(
      report([claudeSnapshot(), codexSnapshot()]),
    );

    expect(output).toContain("QUOTA — 2026-08-29 18:57 PDT");
    expect(output).toContain(
      "USE:   codex-next@example.com — Codex primary 100% free",
    );
    expect(output).toContain(
      "WATCH: claude-ops@example.com — Fable 94% of its 50% sub-cap*",
    );
    expect(output).toContain("└ Fable sub-cap");
    expect(output).toContain("47% of weekly allowance*");
    expect(output).not.toContain("| Account |");
    expect(output).toContain(
      "Claude session 5h; Claude weekly 7d; Fable sub-cap 50%",
    );
    expect(output).not.toContain("Codex weekly fallback 7d");
  });

  it("renders a visible constant-suspect marker with raw remaining time", () => {
    const output = renderTextReport(
      report([claudeSnapshot({ weeklyRemainingMinutes: 11_000 })]),
    );

    expect(output).toContain("remaining 183h 20m");
    expect(output).toContain("CONSTANT-SUSPECT");
    expect(output).not.toContain("-9.1% elapsed");
  });

  it("renders Markdown only when selected", () => {
    const output = renderMarkdownReport(
      report([claudeSnapshot(), codexSnapshot()]),
    );

    expect(output).toContain("| Limit | Consumed | Level |");
    expect(output).toContain("| ↳ Fable sub-cap | 94% |");
  });

  it("distinguishes unsupported limits from unknown fields", () => {
    const unsupported = quotaSuccessSchema.parse({
      accountAlias: "claude-token@example.com",
      platform: "Claude",
      status: "ok",
      plan: null,
      limits: [
        {
          key: "base",
          label: "Base",
          scope: "global",
          availability: "unsupported",
          usedPercent: null,
          windowDurationMinutes: null,
          resetAt: null,
        },
      ],
      observedAt: "2026-08-30T01:57:00.000Z",
    });
    const unknown = quotaSuccessSchema.parse({
      accountAlias: "codex-missing@example.com",
      platform: "Codex",
      status: "ok",
      plan: "pro",
      limits: [
        {
          key: "codex.primary",
          label: "Codex Primary",
          scope: "window",
          availability: "available",
          usedPercent: null,
          windowDurationMinutes: 10_080,
          resetAt: null,
        },
      ],
      observedAt: "2026-08-30T01:57:00.000Z",
    });

    const output = renderTextReport(report([unsupported, unknown]));
    expect(output).toContain("Base");
    expect(output).toContain("unsupported");
    expect(output).toContain("Codex primary");
    expect(output).not.toContain("N/A");
    expect(output).not.toContain("unknown");
  });
});
