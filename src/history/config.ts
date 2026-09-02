import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export const DEFAULT_RAW_RETENTION_DAYS = 30;
export const DEFAULT_HISTORY_RETENTION_DAYS = 365;

export type HistoryConfiguration = {
  filePath: string;
  rawRetentionDays: number;
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
): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 3_650) {
    throw new HistoryConfigurationError(
      `${name} must be an integer from 1 to 3650.`,
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
    rawRetentionDays?: number;
    retentionDays?: number;
  } = {},
): HistoryConfiguration {
  const rawRetentionDays = positiveInteger(
    environment.SEAT_MONITOR_HISTORY_RAW_DAYS,
    defaults.rawRetentionDays ?? DEFAULT_RAW_RETENTION_DAYS,
    "SEAT_MONITOR_HISTORY_RAW_DAYS",
  );
  const retentionDays = positiveInteger(
    environment.SEAT_MONITOR_HISTORY_RETENTION_DAYS,
    defaults.retentionDays ?? DEFAULT_HISTORY_RETENTION_DAYS,
    "SEAT_MONITOR_HISTORY_RETENTION_DAYS",
  );
  if (rawRetentionDays > retentionDays) {
    throw new HistoryConfigurationError(
      "Raw history retention cannot exceed total history retention.",
    );
  }
  return {
    filePath: defaultHistoryDatabasePath(environment),
    rawRetentionDays,
    retentionDays,
  };
}
