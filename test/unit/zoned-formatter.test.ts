import { expect, it } from "vitest";
import { zonedFormatter } from "../../src/services/zoned-formatter.js";

it("bounds retained native formatters without changing timezone results", () => {
  const first = zonedFormatter("UTC");
  expect(zonedFormatter("UTC")).toBe(first);
  for (const zone of Intl.supportedValuesOf("timeZone").slice(0, 40))
    zonedFormatter(zone);
  const replacement = zonedFormatter("UTC");
  expect(replacement).not.toBe(first);
  expect(replacement.formatToParts(0)).toEqual(first.formatToParts(0));
  expect(() => zonedFormatter("invalid-zone")).toThrow(RangeError);
});
