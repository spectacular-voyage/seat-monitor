export type LocalConstant = {
  value: number;
  source: string;
  checkedOn: string;
};

export const QUOTA_LOCAL_CONSTANTS = {
  windowMinutes: {
    // Source: Anthropic Help Center, "What is the Pro plan?"; checked 2026-08-29.
    claudeSession: {
      value: 300,
      source:
        "Anthropic Help Center — Pro session limit resets every five hours",
      checkedOn: "2026-08-29",
    },
    // Source: Anthropic Help Center, weekly all-model limit plus observed /usage reset; checked 2026-08-29.
    claudeWeekly: {
      value: 10_080,
      source: "Anthropic Help Center and observed Claude /usage — seven days",
      checkedOn: "2026-08-29",
    },
    // Source: observed Codex App Server weekly windowDurationMins; checked 2026-08-29.
    codexWeeklyFallback: {
      value: 10_080,
      source: "Observed Codex App Server weekly window — seven days",
      checkedOn: "2026-08-29",
    },
  },
  subCapFractionsByPlan: {
    // Source: Anthropic Help Center, "Claude Fable 5 on your plan"; checked 2026-08-29.
    max: {
      value: 0.5,
      source:
        "Anthropic Help Center — Fable uses up to 50% of the Max weekly limit",
      checkedOn: "2026-08-29",
    },
  },
} as const satisfies {
  windowMinutes: Record<string, LocalConstant>;
  subCapFractionsByPlan: Record<string, LocalConstant>;
};

/** Product policy: smaller residual capacity is too narrow for deliberate task placement. */
export const MINIMUM_USABLE_HEADROOM_PERCENT = 20;
