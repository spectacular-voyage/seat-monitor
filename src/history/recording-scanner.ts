import type { Scanner } from "../services/scan-accounts.js";
import { HistoryService } from "./service.js";
import type { ScanSource } from "./types.js";

export function createRecordingScanner(options: {
  scan: Scanner;
  history: HistoryService;
  source: ScanSource;
  now?: () => Date;
}): Scanner {
  const now = options.now ?? (() => new Date());
  return async () => {
    const snapshots = await options.scan();
    options.history.recordScan(options.source, snapshots, now());
    return snapshots;
  };
}
