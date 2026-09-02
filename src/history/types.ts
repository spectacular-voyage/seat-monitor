import type { Platform, QuotaLimit, QuotaSnapshot } from "../domain/quota.js";

export type ScanSource = "cli" | "server";

export type StoredScanRun = {
  id: number;
  source: ScanSource;
  completedAt: string;
  snapshots: QuotaSnapshot[];
};

export type HistoryResolution = "raw" | "hour" | "auto";

export type HistorySeriesPoint = {
  observedAt: string;
  usedPercent: number | null;
  minimumUsedPercent: number | null;
  maximumUsedPercent: number | null;
  resetAt: string | null;
  windowDurationMinutes: number | null;
  sampleCount: number;
  resolution: Exclude<HistoryResolution, "auto">;
};

export type HistoryLimitSeries = {
  accountAlias: string;
  platform: Platform;
  plan: string | null;
  limit: Pick<QuotaLimit, "key" | "label" | "scope" | "availability">;
  points: HistorySeriesPoint[];
};

export type HistoryResetEvent = {
  accountAlias: string;
  platform: Platform;
  limitKey: string;
  resetAt: string;
  kind: "provider";
};

export type ScanHistoryQuery = {
  fromMilliseconds: number;
  toMilliseconds: number;
  limit: number;
  beforeId?: number;
};

export type SeriesHistoryQuery = {
  fromMilliseconds: number;
  toMilliseconds: number;
  resolution: HistoryResolution;
  accountAlias?: string;
};
