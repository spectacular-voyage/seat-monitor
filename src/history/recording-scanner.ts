import type { Scanner } from "../services/scan-accounts.js";
import { HistoryService } from "./service.js";
import type { ScanSource } from "./types.js";

export function createRecordingScanner(options: {
  scan: Scanner;
  history: HistoryService;
  source: ScanSource;
  now?: () => Date;
  excludedAccountAlias?: () => string | null;
}): Scanner {
  const now = options.now ?? (() => new Date());
  return async () => {
    const excludedAccountAlias = options.excludedAccountAlias?.() ?? null;
    const snapshots = await options.scan();
    options.history.recordScan(
      options.source,
      excludedAccountAlias === null
        ? snapshots
        : snapshots.filter(
            (snapshot) => snapshot.accountAlias !== excludedAccountAlias,
          ),
      now(),
    );
    return snapshots;
  };
}
