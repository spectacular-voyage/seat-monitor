import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export const DEFAULT_RAW_RETENTION_HOURS = 6;
export const DEFAULT_HOURLY_RETENTION_DAYS = 30;
export const DEFAULT_HISTORY_RETENTION_DAYS = 365;

export type HistoryConfiguration = {
  filePath: string;
  rawRetentionHours: number;
  hourlyRetentionDays: number;
  retentionDays: number;
};

export class HistoryConfigurationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "HistoryConfigurationError";
  }
}

function positiveInteger(
  value: string | undefined,
  fallback: number,
  name: string,
  maximum = 3_650,
): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new HistoryConfigurationError(
      `${name} must be an integer from 1 to ${String(maximum)}.`,
    );
  }
  return parsed;
}

export function defaultHistoryDatabasePath(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const configured = environment.SEAT_MONITOR_HISTORY_PATH;
  if (configured !== undefined) {
    if (!isAbsolute(configured)) {
      throw new HistoryConfigurationError(
        "SEAT_MONITOR_HISTORY_PATH must be an absolute path.",
      );
    }
    return configured;
  }

  const stateRoot =
    environment.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
  if (!isAbsolute(stateRoot)) {
    throw new HistoryConfigurationError(
      "XDG_STATE_HOME must be an absolute path.",
    );
  }
  return join(stateRoot, "seat-monitor", "history.sqlite3");
}

export function readHistoryConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
  defaults: {
    rawRetentionHours?: number;
    hourlyRetentionDays?: number;
    retentionDays?: number;
  } = {},
): HistoryConfiguration {
  const legacyRawDays = environment.SEAT_MONITOR_HISTORY_RAW_DAYS;
  const configuredRawHours = environment.SEAT_MONITOR_HISTORY_RAW_HOURS;
  const rawRetentionHours =
    configuredRawHours !== undefined
      ? positiveInteger(
          configuredRawHours,
          DEFAULT_RAW_RETENTION_HOURS,
          "SEAT_MONITOR_HISTORY_RAW_HOURS",
          87_600,
        )
      : legacyRawDays !== undefined
        ? positiveInteger(legacyRawDays, 1, "SEAT_MONITOR_HISTORY_RAW_DAYS") *
          24
        : (defaults.rawRetentionHours ?? DEFAULT_RAW_RETENTION_HOURS);
  const hourlyRetentionDays = positiveInteger(
    environment.SEAT_MONITOR_HISTORY_HOURLY_DAYS,
    defaults.hourlyRetentionDays ?? DEFAULT_HOURLY_RETENTION_DAYS,
    "SEAT_MONITOR_HISTORY_HOURLY_DAYS",
  );
  const retentionDays = positiveInteger(
    environment.SEAT_MONITOR_HISTORY_RETENTION_DAYS,
    defaults.retentionDays ?? DEFAULT_HISTORY_RETENTION_DAYS,
    "SEAT_MONITOR_HISTORY_RETENTION_DAYS",
  );
  if (rawRetentionHours > hourlyRetentionDays * 24) {
    throw new HistoryConfigurationError(
      "Raw history retention cannot exceed hourly history retention.",
    );
  }
  if (hourlyRetentionDays > retentionDays) {
    throw new HistoryConfigurationError(
      "Hourly history retention cannot exceed total history retention.",
    );
  }
  return {
    filePath: defaultHistoryDatabasePath(environment),
    rawRetentionHours,
    hourlyRetentionDays,
    retentionDays,
  };
}
