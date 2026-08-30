import { describe, expect, it } from "vitest";

import {
  claudeSnapshot,
  codexSnapshot,
  codexSnapshotWithSpark,
  report,
  resetAfter,
} from "../helpers/quota-fixtures.js";

describe("quota report derivation", () => {
  it("chooses soonest-resetting meaningful headroom without a composite score", () => {
    const result = report([claudeSnapshot(), codexSnapshot()]);

    expect(result.use).toEqual(
      expect.objectContaining({
        accountAlias: "codex-next@example.com",
        limitLabel: "Codex primary",
        headroomPercent: 100,
        timeRemainingMinutes: 300,
      }),
    );
  });

  it("watches the tightest account-wide limit instead of a nested sub-cap", () => {
    const result = report([claudeSnapshot(), codexSnapshot()]);

    expect(result.watch?.accountAlias).toBe("claude-ops@example.com");
    expect(result.watch?.row.key).toBe("base.weekly");
    expect(result.watch?.row.consumedPercent).toBe(89);
    expect(
      result.accounts[0]?.rows.find((row) => row.key === "base.weekly")
        ?.elapsedMinutes,
    ).toBe(3_380);
    expect(result.watch?.elapsedPercent).toBeCloseTo(33.5, 1);
    expect(result.watch?.resetAt).toBe(resetAfter(6_700));
  });

  it("keeps Spark visible but excludes it from USE and WATCH", () => {
    const result = report([codexSnapshotWithSpark()]);

    expect(result.accounts[0]?.rows.map((row) => row.label)).toContain(
      "Spark primary",
    );
    expect(result.use).toEqual(
      expect.objectContaining({
        limitLabel: "Codex primary",
        timeRemainingMinutes: 300,
      }),
    );
    expect(result.watch?.row.key).toBe("codex.primary");
  });

  it("nests Fable under weekly without inventing a second position", () => {
    const result = report([claudeSnapshot()]);
    const account = result.accounts[0];

    expect(account?.rows.map((row) => row.key)).toEqual([
      "base.weekly",
      "fable.weekly",
      "base.session",
    ]);
    const fable = account?.rows[1];
    expect(fable).toEqual(
      expect.objectContaining({
        depth: 1,
        parentKey: "base.weekly",
        elapsedMinutes: null,
        elapsedPercent: null,
        subCapFraction: 0.5,
      }),
    );
  });

  it("leaves derived position empty when reset input is missing", () => {
    const result = report([
      claudeSnapshot({ sessionUsed: 0, sessionRemainingMinutes: null }),
    ]);
    const session = result.accounts[0]?.rows.find(
      (row) => row.key === "base.session",
    );

    expect(session?.consumedPercent).toBe(0);
    expect(session?.timeRemainingMinutes).toBeNull();
    expect(session?.elapsedMinutes).toBeNull();
    expect(session?.elapsedPercent).toBeNull();
  });

  it("marks a stale local window constant instead of emitting impossible elapsed", () => {
    const result = report([claudeSnapshot({ weeklyRemainingMinutes: 11_000 })]);
    const weekly = result.accounts[0]?.rows.find(
      (row) => row.key === "base.weekly",
    );

    expect(weekly?.timeRemainingMinutes).toBe(11_000);
    expect(weekly?.windowDurationMinutes).toBe(10_080);
    expect(weekly?.constantSuspect).toBe(true);
    expect(weekly?.elapsedMinutes).toBeNull();
    expect(weekly?.elapsedPercent).toBeNull();
  });

  it("uses stable account-name tiebreaks after vendor and reset", () => {
    const result = report([
      codexSnapshot("codex-z@example.com"),
      codexSnapshot("codex-a@example.com"),
    ]);

    expect(result.accounts.map((account) => account.accountAlias)).toEqual([
      "codex-a@example.com",
      "codex-z@example.com",
    ]);
    expect(result.use?.accountAlias).toBe("codex-a@example.com");
  });

  it("groups by vendor even when the cross-vendor USE winner resets earlier", () => {
    const result = report([
      codexSnapshot("codex-first@example.com", 30),
      claudeSnapshot({
        alias: "claude-later@example.com",
        weeklyUsed: 0,
        weeklyRemainingMinutes: 600,
        sessionUsed: 0,
        sessionRemainingMinutes: 120,
      }),
    ]);

    expect(result.use?.accountAlias).toBe("codex-first@example.com");
    expect(result.accounts.map((account) => account.platform)).toEqual([
      "Claude",
      "Codex",
    ]);
  });
});
