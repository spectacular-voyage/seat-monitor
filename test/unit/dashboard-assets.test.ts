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
    expect(html).toContain('data-periods="0.5"');
    expect(html).toContain('data-periods="10"');
    expect(html).not.toContain("data-range-hours");
    expect(html).not.toContain("Capacity now");
    expect(html).not.toContain("Burndown history");
    expect(html).not.toContain("Each graph uses its own quota period");
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
    expect(javascript).toContain("createChartLegend");
    expect(javascript).toContain("createLimitMetrics");
    expect(javascript).toContain('element("table", "limit-metrics")');
    expect(javascript).toContain(
      'element("th", "metric-column-heading", "Usage rate")',
    );
    expect(javascript).toContain(
      'element("th", "metric-column-heading", "Outlook")',
    );
    expect(javascript).toContain('"All models"');
    expect(javascript).toContain('"Fable"');
    expect(javascript).toContain("entry.overlays");
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
    expect(javascript).toContain(
      'limit.projection.status !== "reset_before_exhaustion"',
    );
    expect(javascript).toContain("projectionLineEndAt");
    expect(javascript).toContain("formatAxisDateTime(chartEnd)");
    expect(javascript).toContain('entry.limit.key === "base.session"');
    expect(javascript).toContain("!stackedHistoryMedia.matches");
    expect(javascript).toContain(
      'stackedHistoryMedia.addEventListener("change"',
    );
    expect(javascript).toContain("usage-overlay-value");
    expect(javascript).toContain('"usage-series-label", " all"');
    expect(javascript).toContain('"usage-series-label", " fable"');
    expect(javascript).toContain("entry.measured.length > 0");
    expect(css).toContain("grid-template-columns: repeat(3, minmax(0, 1fr))");
    expect(css).toContain(".window-grid.single-panel .window-panel");
    expect(css).toContain(".combined-panel");
    expect(css).toContain("grid-column: span 2");
    expect(css).toContain("background: #181c19");
    expect(css).toContain("stroke: #3b463e");
    expect(css).toContain(".account-card.claude-history");
    expect(css).toContain("--history-card-background: #2b171e");
    expect(css).toContain(".account-card.codex-history");
    expect(css).toContain("--history-card-background: #152039");
    expect(css).not.toContain("--history-panel-background");
    expect(css).not.toContain("--history-chart-background");
    expect(css).toContain("table-layout: fixed");
    expect(css).toContain("align-items: stretch");
    expect(css).toContain(".usage-series-label");
    expect(css).not.toContain("stroke-dasharray: 5 4");
    expect(css).not.toContain("border-top: 2px dashed #d8ac76");
    expect(css).toContain("font-size: clamp(1.2rem, 2.3vw, 1.875rem)");
  });

  it("keeps provider-controlled rendering on textContent", () => {
    expect(javascript).toContain("value.textContent = text");
    expect(javascript).not.toContain("innerHTML");
  });
});
