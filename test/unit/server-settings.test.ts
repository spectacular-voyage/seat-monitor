import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  defaultServerSettingsPath,
  readServerSettings,
  ServerSettingsError,
} from "../../src/config/server-settings.js";

const temporaryDirectories: string[] = [];

function directory(): string {
  const value = mkdtempSync(join(tmpdir(), "seat-monitor-settings-test-"));
  temporaryDirectories.push(value);
  return value;
}

afterEach(() => {
  for (const value of temporaryDirectories.splice(0)) {
    rmSync(value, { force: true, recursive: true });
  }
});

describe("server settings", () => {
  it("uses defaults when the optional settings file is missing", () => {
    const filePath = join(directory(), "missing.json");

    expect(readServerSettings({}, filePath)).toEqual({
      scanIntervalSeconds: 60,
      scanOnStartup: true,
      port: 3_000,
      useDefaultPortFallback: true,
      history: {
        rawRetentionHours: 6,
        hourlyRetentionDays: 30,
        retentionDays: 365,
      },
      dashboard: { showSpark: true },
    });
  });

  it("reads strict file settings and applies environment overrides", () => {
    const filePath = join(directory(), "settings.json");
    writeFileSync(
      filePath,
      JSON.stringify({
        scanIntervalSeconds: 300,
        scanOnStartup: false,
        port: 3_001,
        history: {
          rawRetentionHours: 12,
          hourlyRetentionDays: 14,
          retentionDays: 180,
        },
        dashboard: { showSpark: false },
      }),
    );

    expect(
      readServerSettings(
        {
          SEAT_MONITOR_SCAN_INTERVAL_SECONDS: "120",
          SEAT_MONITOR_SCAN_ON_STARTUP: "true",
          SEAT_MONITOR_PORT: "4000",
          SEAT_MONITOR_HISTORY_RAW_HOURS: "8",
          SEAT_MONITOR_HISTORY_HOURLY_DAYS: "7",
          SEAT_MONITOR_SHOW_SPARK: "true",
        },
        filePath,
      ),
    ).toEqual({
      scanIntervalSeconds: 120,
      scanOnStartup: true,
      port: 4_000,
      useDefaultPortFallback: false,
      history: {
        rawRetentionHours: 8,
        hourlyRetentionDays: 7,
        retentionDays: 180,
      },
      dashboard: { showSpark: true },
    });
  });

  it("does not enable fallback for an explicitly configured default port", () => {
    const filePath = join(directory(), "settings.json");
    writeFileSync(filePath, JSON.stringify({ port: 3_000 }));

    expect(readServerSettings({}, filePath).useDefaultPortFallback).toBe(false);
  });

  it("resolves the XDG path and requires absolute overrides", () => {
    expect(defaultServerSettingsPath({ XDG_CONFIG_HOME: "/config" })).toBe(
      "/config/seat-monitor/settings.json",
    );
    expect(() =>
      defaultServerSettingsPath({ SEAT_MONITOR_SETTINGS: "settings.json" }),
    ).toThrow(ServerSettingsError);
  });

  it("rejects malformed files, unknown fields, and invalid overrides", () => {
    const malformed = join(directory(), "malformed.json");
    writeFileSync(malformed, "{");
    expect(() => readServerSettings({}, malformed)).toThrow("not valid JSON");

    const unknown = join(directory(), "unknown.json");
    writeFileSync(unknown, JSON.stringify({ pollingSeconds: 60 }));
    expect(() => readServerSettings({}, unknown)).toThrow("invalid structure");

    expect(() =>
      readServerSettings(
        { SEAT_MONITOR_SCAN_INTERVAL_SECONDS: "10" },
        join(directory(), "missing.json"),
      ),
    ).toThrow("30 to 3600");
    expect(() =>
      readServerSettings(
        { SEAT_MONITOR_SCAN_ON_STARTUP: "yes" },
        join(directory(), "missing.json"),
      ),
    ).toThrow("true or false");
  });

  it("rejects retention inversion across file and environment values", () => {
    const filePath = join(directory(), "settings.json");
    writeFileSync(
      filePath,
      JSON.stringify({
        history: { hourlyRetentionDays: 90, retentionDays: 180 },
      }),
    );

    expect(() =>
      readServerSettings(
        { SEAT_MONITOR_HISTORY_RETENTION_DAYS: "30" },
        filePath,
      ),
    ).toThrow("cannot exceed");
  });

  it("maps legacy raw-retention days to hours", () => {
    const filePath = join(directory(), "settings.json");
    writeFileSync(
      filePath,
      JSON.stringify({ history: { rawRetentionDays: 1 } }),
    );

    expect(readServerSettings({}, filePath).history.rawRetentionHours).toBe(24);
  });

  it("gives the preferred hours override precedence over legacy days", () => {
    const filePath = join(directory(), "missing.json");

    expect(
      readServerSettings(
        {
          SEAT_MONITOR_HISTORY_RAW_HOURS: "8",
          SEAT_MONITOR_HISTORY_RAW_DAYS: "invalid",
        },
        filePath,
      ).history.rawRetentionHours,
    ).toBe(8);
  });
});
