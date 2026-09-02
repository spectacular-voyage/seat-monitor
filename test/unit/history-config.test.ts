import { describe, expect, it } from "vitest";

import {
  HistoryConfigurationError,
  readHistoryConfiguration,
} from "../../src/history/config.js";

describe("history configuration", () => {
  it("uses XDG state storage with bounded defaults", () => {
    expect(readHistoryConfiguration({ XDG_STATE_HOME: "/state" })).toEqual({
      filePath: "/state/seat-monitor/history.sqlite3",
      rawRetentionDays: 30,
      retentionDays: 365,
    });
  });

  it("accepts an absolute override and custom retention", () => {
    expect(
      readHistoryConfiguration({
        SEAT_MONITOR_HISTORY_PATH: "/private/history.db",
        SEAT_MONITOR_HISTORY_RAW_DAYS: "7",
        SEAT_MONITOR_HISTORY_RETENTION_DAYS: "90",
      }),
    ).toEqual({
      filePath: "/private/history.db",
      rawRetentionDays: 7,
      retentionDays: 90,
    });
  });

  it("rejects relative paths and inverted retention", () => {
    expect(() =>
      readHistoryConfiguration({ SEAT_MONITOR_HISTORY_PATH: "history.db" }),
    ).toThrow(HistoryConfigurationError);
    expect(() =>
      readHistoryConfiguration({
        XDG_STATE_HOME: "/state",
        SEAT_MONITOR_HISTORY_RAW_DAYS: "91",
        SEAT_MONITOR_HISTORY_RETENTION_DAYS: "90",
      }),
    ).toThrow("cannot exceed");
  });
});
