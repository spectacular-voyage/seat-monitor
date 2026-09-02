import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

import { z } from "zod";

export const DEFAULT_SCAN_INTERVAL_SECONDS = 60;
export const MINIMUM_SCAN_INTERVAL_SECONDS = 30;
export const MAXIMUM_SCAN_INTERVAL_SECONDS = 3_600;
export const DEFAULT_SERVER_PORT = 3_000;

const retentionDaysSchema = z.number().int().min(1).max(3_650);

const settingsFileSchema = z
  .object({
    scanIntervalSeconds: z
      .number()
      .int()
      .min(MINIMUM_SCAN_INTERVAL_SECONDS)
      .max(MAXIMUM_SCAN_INTERVAL_SECONDS)
      .optional(),
    scanOnStartup: z.boolean().optional(),
    port: z.number().int().min(1).max(65_535).optional(),
    history: z
      .object({
        rawRetentionDays: retentionDaysSchema.optional(),
        retentionDays: retentionDaysSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type ServerSettings = {
  scanIntervalSeconds: number;
  scanOnStartup: boolean;
  port: number;
  history: {
    rawRetentionDays: number;
    retentionDays: number;
  };
};

export class ServerSettingsError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ServerSettingsError";
  }
}

function integerEnvironment(
  value: string | undefined,
  fallback: number,
  options: { name: string; minimum: number; maximum: number },
): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  if (
    !Number.isInteger(parsed) ||
    parsed < options.minimum ||
    parsed > options.maximum
  ) {
    throw new ServerSettingsError(
      `${options.name} must be an integer from ${String(options.minimum)} to ${String(options.maximum)}.`,
    );
  }
  return parsed;
}

function booleanEnvironment(
  value: string | undefined,
  fallback: boolean,
  name: string,
): boolean {
  if (value === undefined) {
    return fallback;
  }
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  throw new ServerSettingsError(`${name} must be true or false.`);
}

export function defaultServerSettingsPath(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const configured = environment.SEAT_MONITOR_SETTINGS;
  if (configured !== undefined) {
    if (!isAbsolute(configured)) {
      throw new ServerSettingsError(
        "SEAT_MONITOR_SETTINGS must be an absolute path.",
      );
    }
    return configured;
  }

  const configRoot = environment.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  if (!isAbsolute(configRoot)) {
    throw new ServerSettingsError("XDG_CONFIG_HOME must be an absolute path.");
  }
  return join(configRoot, "seat-monitor", "settings.json");
}

function readSettingsFile(
  filePath: string,
): z.infer<typeof settingsFileSchema> {
  let source: string;
  try {
    source = readFileSync(filePath, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return {};
    }
    throw new ServerSettingsError(
      `Server settings could not be read at ${filePath}.`,
    );
  }

  let payload: unknown;
  try {
    payload = JSON.parse(source);
  } catch {
    throw new ServerSettingsError(
      `Server settings are not valid JSON: ${filePath}.`,
    );
  }
  const parsed = settingsFileSchema.safeParse(payload);
  if (!parsed.success) {
    throw new ServerSettingsError(
      `Server settings have an invalid structure: ${filePath}.`,
    );
  }
  return parsed.data;
}

export function readServerSettings(
  environment: NodeJS.ProcessEnv = process.env,
  filePath = defaultServerSettingsPath(environment),
): ServerSettings {
  if (!isAbsolute(filePath)) {
    throw new ServerSettingsError("The server settings path must be absolute.");
  }
  const file = readSettingsFile(filePath);
  const rawRetentionDays = integerEnvironment(
    environment.SEAT_MONITOR_HISTORY_RAW_DAYS,
    file.history?.rawRetentionDays ?? 30,
    {
      name: "SEAT_MONITOR_HISTORY_RAW_DAYS",
      minimum: 1,
      maximum: 3_650,
    },
  );
  const retentionDays = integerEnvironment(
    environment.SEAT_MONITOR_HISTORY_RETENTION_DAYS,
    file.history?.retentionDays ?? 365,
    {
      name: "SEAT_MONITOR_HISTORY_RETENTION_DAYS",
      minimum: 1,
      maximum: 3_650,
    },
  );
  if (rawRetentionDays > retentionDays) {
    throw new ServerSettingsError(
      "Raw history retention cannot exceed total history retention.",
    );
  }

  return {
    scanIntervalSeconds: integerEnvironment(
      environment.SEAT_MONITOR_SCAN_INTERVAL_SECONDS,
      file.scanIntervalSeconds ?? DEFAULT_SCAN_INTERVAL_SECONDS,
      {
        name: "SEAT_MONITOR_SCAN_INTERVAL_SECONDS",
        minimum: MINIMUM_SCAN_INTERVAL_SECONDS,
        maximum: MAXIMUM_SCAN_INTERVAL_SECONDS,
      },
    ),
    scanOnStartup: booleanEnvironment(
      environment.SEAT_MONITOR_SCAN_ON_STARTUP,
      file.scanOnStartup ?? true,
      "SEAT_MONITOR_SCAN_ON_STARTUP",
    ),
    port: integerEnvironment(
      environment.SEAT_MONITOR_PORT,
      file.port ?? DEFAULT_SERVER_PORT,
      { name: "SEAT_MONITOR_PORT", minimum: 1, maximum: 65_535 },
    ),
    history: { rawRetentionDays, retentionDays },
  };
}
