// Intl formatters retain native ICU allocations beyond their small JS wrappers.
// Reuse the fixed date-parts format, with a bounded cache for provider time zones.
const formatters = new Map<string, Intl.DateTimeFormat>();
const MAX_TIME_ZONES = 32;

export function zonedFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = formatters.get(timeZone);
  if (cached !== undefined) return cached;
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  if (formatters.size >= MAX_TIME_ZONES) {
    const oldest = formatters.keys().next().value;
    if (oldest !== undefined) formatters.delete(oldest);
  }
  formatters.set(timeZone, formatter);
  return formatter;
}
