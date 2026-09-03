import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const html = readFileSync(
  new URL("../../src/public/index.html", import.meta.url),
  "utf8",
);
const javascript = readFileSync(
  new URL("../../src/public/app.js", import.meta.url),
  "utf8",
);
const css = readFileSync(
  new URL("../../src/public/styles.css", import.meta.url),
  "utf8",
);

describe("dashboard assets", () => {
  it("uses account cards and local SVG charts instead of the quota table", () => {
    expect(html).toContain('id="account-cards"');
    expect(html).toContain('id="range-controls"');
    expect(html).toContain('data-periods="10"');
    expect(html).not.toContain("data-range-hours");
    expect(html).toContain('id="fleet-capacity"');
    expect(html).toContain('id="top-warnings"');
    expect(html).not.toContain('id="refresh"');
    expect(html.indexOf('id="fleet-capacity"')).toBeLessThan(
      html.indexOf('class="summary"'),
    );
    expect(html.indexOf('id="account-cards"')).toBeLessThan(
      html.indexOf('class="summary"'),
    );
    expect(html).not.toContain("<table");
    expect(javascript).toContain("createElementNS(SVG_NAMESPACE, name)");
    expect(javascript).toContain("/api/history/analytics");
    expect(javascript).toContain('return "session-panel"');
    expect(javascript).toContain('return "weekly-panel"');
    expect(javascript).toContain("file:// preview");
    expect(javascript).toContain("createCapacityMeter");
    expect(javascript).toContain("PERIOD_CONTEXT_MULTIPLIER = 1.05");
    expect(javascript).toContain("periods: String(periodMultiplier)");
    expect(javascript).toContain("Scheduled scans are stale");
    expect(javascript).toContain('{ label: "Refresh now"');
    expect(javascript).toContain(
      'projection.status === "exhausts_before_reset"',
    );
    expect(javascript).toContain("lastActivityAt");
    expect(javascript).toContain("projectedExhaustionRangeEndAt");
    expect(javascript).toContain("recent 30m");
    expect(javascript).toContain(
      'limit.projection.status === "exhausts_before_reset"',
    );
    expect(css).toContain("grid-template-columns: repeat(3, minmax(0, 1fr))");
    expect(css).toContain(".window-grid.single-panel .window-panel");
    expect(css).toContain("font-size: clamp(1.2rem, 2.3vw, 1.875rem)");
  });

  it("keeps provider-controlled rendering on textContent", () => {
    expect(javascript).toContain("value.textContent = text");
    expect(javascript).not.toContain("innerHTML");
  });
});
