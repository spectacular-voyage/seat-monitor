import { describe, expect, it } from "vitest";

import {
  HistoryConfigurationError,
  readHistoryConfiguration,
} from "../../src/history/config.js";

describe("history configuration", () => {
  it("uses XDG state storage with bounded defaults", () => {
    expect(readHistoryConfiguration({ XDG_STATE_HOME: "/state" })).toEqual({
      filePath: "/state/seat-monitor/history.sqlite3",
      rawRetentionHours: 6,
      hourlyRetentionDays: 30,
      retentionDays: 365,
    });
  });

  it("accepts an absolute override and custom retention", () => {
    expect(
      readHistoryConfiguration({
        SEAT_MONITOR_HISTORY_PATH: "/private/history.db",
        SEAT_MONITOR_HISTORY_RAW_HOURS: "12",
        SEAT_MONITOR_HISTORY_HOURLY_DAYS: "7",
        SEAT_MONITOR_HISTORY_RETENTION_DAYS: "90",
      }),
    ).toEqual({
      filePath: "/private/history.db",
      rawRetentionHours: 12,
      hourlyRetentionDays: 7,
      retentionDays: 90,
    });
  });

  it("uses settings-file retention defaults below environment overrides", () => {
    expect(
      readHistoryConfiguration(
        {
          XDG_STATE_HOME: "/state",
          SEAT_MONITOR_HISTORY_RAW_HOURS: "12",
        },
        {
          rawRetentionHours: 7,
          hourlyRetentionDays: 14,
          retentionDays: 180,
        },
      ),
    ).toEqual({
      filePath: "/state/seat-monitor/history.sqlite3",
      rawRetentionHours: 12,
      hourlyRetentionDays: 14,
      retentionDays: 180,
    });
  });

  it("rejects relative paths and inverted retention", () => {
    expect(() =>
      readHistoryConfiguration({ SEAT_MONITOR_HISTORY_PATH: "history.db" }),
    ).toThrow(HistoryConfigurationError);
    expect(() =>
      readHistoryConfiguration({
        XDG_STATE_HOME: "/state",
        SEAT_MONITOR_HISTORY_RAW_HOURS: "49",
        SEAT_MONITOR_HISTORY_HOURLY_DAYS: "2",
      }),
    ).toThrow("cannot exceed");
  });

  it("retains the legacy raw-days environment override", () => {
    expect(
      readHistoryConfiguration({ SEAT_MONITOR_HISTORY_RAW_DAYS: "1" }),
    ).toEqual(
      expect.objectContaining({
        rawRetentionHours: 24,
        hourlyRetentionDays: 30,
      }),
    );
  });

  it("gives the preferred hours override precedence over legacy days", () => {
    expect(
      readHistoryConfiguration({
        SEAT_MONITOR_HISTORY_RAW_HOURS: "8",
        SEAT_MONITOR_HISTORY_RAW_DAYS: "invalid",
      }).rawRetentionHours,
    ).toBe(8);
  });
});
