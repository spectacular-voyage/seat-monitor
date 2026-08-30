import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

import { z } from "zod";

import type { Platform } from "../domain/quota.js";

const accountAliasSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.@+-]*$/);
const credentialEnvironmentSchema = z.string().regex(/^[A-Z][A-Z0-9_]*$/);
const profileNameSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]*$/);

const commonShape = {
  accountAlias: accountAliasSchema,
  enabled: z.boolean().optional().default(true),
} as const;

const claudeSetupTokenDefinitionSchema = z
  .object({
    ...commonShape,
    platform: z.literal("Claude"),
    auth: z
      .object({
        type: z.literal("claude_setup_token"),
        credentialEnv: credentialEnvironmentSchema,
      })
      .strict(),
  })
  .strict();

const claudeProfileDefinitionSchema = z
  .object({
    ...commonShape,
    platform: z.literal("Claude"),
    auth: z
      .object({
        type: z.literal("claude_profile"),
        profile: profileNameSchema,
      })
      .strict(),
  })
  .strict();

const codexProfileDefinitionSchema = z
  .object({
    ...commonShape,
    platform: z.literal("Codex"),
    auth: z
      .object({
        type: z.literal("codex_profile"),
        profile: profileNameSchema,
      })
      .strict(),
  })
  .strict();

const codexAccessTokenDefinitionSchema = z
  .object({
    ...commonShape,
    platform: z.literal("Codex"),
    auth: z
      .object({
        type: z.literal("codex_access_token"),
        credentialEnv: credentialEnvironmentSchema,
      })
      .strict(),
  })
  .strict();

export const accountDefinitionSchema = z.union([
  claudeSetupTokenDefinitionSchema,
  claudeProfileDefinitionSchema,
  codexProfileDefinitionSchema,
  codexAccessTokenDefinitionSchema,
]);

export type AccountDefinition = z.input<typeof accountDefinitionSchema>;

type LoadedAccountBase = {
  accountAlias: string;
  platform: Platform;
};

export type LoadedClaudeSetupTokenAccount = LoadedAccountBase & {
  platform: "Claude";
  auth: {
    type: "claude_setup_token";
    credentialEnv: string;
    credential: string | undefined;
  };
};

export type LoadedClaudeProfileAccount = LoadedAccountBase & {
  platform: "Claude";
  auth: {
    type: "claude_profile";
    profile: string;
    claudeConfigDir: string;
  };
};

export type LoadedCodexProfileAccount = LoadedAccountBase & {
  platform: "Codex";
  auth: {
    type: "codex_profile";
    profile: string;
    codexHome: string;
  };
};

export type LoadedCodexAccessTokenAccount = LoadedAccountBase & {
  platform: "Codex";
  auth: {
    type: "codex_access_token";
    credentialEnv: string;
    credential: string | undefined;
  };
};

export type LoadedAccount =
  | LoadedClaudeSetupTokenAccount
  | LoadedClaudeProfileAccount
  | LoadedCodexProfileAccount
  | LoadedCodexAccessTokenAccount;

export class AccountConfigurationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "AccountConfigurationError";
  }
}

export function defaultCodexProfilesRoot(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const configured = environment.SEAT_MONITOR_CODEX_PROFILES_DIR;
  if (configured !== undefined) {
    if (!isAbsolute(configured)) {
      throw new AccountConfigurationError(
        "SEAT_MONITOR_CODEX_PROFILES_DIR must be an absolute path.",
      );
    }
    return configured;
  }

  return join(homedir(), ".local", "share", "seat-monitor", "codex");
}

export function defaultClaudeProfilesRoot(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const configured = environment.SEAT_MONITOR_CLAUDE_PROFILES_DIR;
  if (configured !== undefined) {
    if (!isAbsolute(configured)) {
      throw new AccountConfigurationError(
        "SEAT_MONITOR_CLAUDE_PROFILES_DIR must be an absolute path.",
      );
    }
    return configured;
  }

  return join(homedir(), ".local", "share", "seat-monitor", "claude");
}

/**
 * Edit this non-secret map to declare accounts. Personal Claude and Codex
 * subscriptions use isolated persistent profiles created by their provider
 * login commands. Setup/access-token modes remain available for automation
 * environments that deliberately inject credentials.
 */
export const accountDefinitions = [
  {
    accountAlias: "claude-account-one@example.com",
    platform: "Claude",
    auth: {
      type: "claude_profile",
      profile: "claude-account-one",
    },
    enabled: true,
  },
  {
    accountAlias: "claude-account-two@example.com",
    platform: "Claude",
    auth: {
      type: "claude_profile",
      profile: "account-two",
    },
    enabled: true,
  },
  {
    accountAlias: "claude-account-four@example.com",
    platform: "Claude",
    auth: {
      type: "claude_profile",
      profile: "codex-account-four",
    },
    enabled: true,
  },
  {
    accountAlias: "claude-account-five@example.com",
    platform: "Claude",
    auth: {
      type: "claude_profile",
      profile: "claude-account-five",
    },
    enabled: true,
  },
  {
    accountAlias: "codex-account-four@example.com",
    platform: "Codex",
    auth: {
      type: "codex_profile",
      profile: "codex-account-four",
    },
    enabled: true,
  },
  {
    accountAlias: "codex-account-six@example.com",
    platform: "Codex",
    auth: {
      type: "codex_profile",
      profile: "codex-account-six",
    },
    enabled: true,
  },
] as const satisfies readonly AccountDefinition[];

export function loadAccounts(
  definitions: readonly AccountDefinition[] = accountDefinitions,
  environment: NodeJS.ProcessEnv = process.env,
  codexProfilesRoot = defaultCodexProfilesRoot(environment),
  claudeProfilesRoot = defaultClaudeProfilesRoot(environment),
): LoadedAccount[] {
  if (!isAbsolute(codexProfilesRoot)) {
    throw new AccountConfigurationError(
      "Codex profiles root must be an absolute path.",
    );
  }
  if (!isAbsolute(claudeProfilesRoot)) {
    throw new AccountConfigurationError(
      "Claude profiles root must be an absolute path.",
    );
  }

  const parsed = definitions.map((definition, index) => {
    const result = accountDefinitionSchema.safeParse(definition);
    if (!result.success) {
      throw new AccountConfigurationError(
        `Account definition ${String(index + 1)} is invalid.`,
      );
    }
    return result.data;
  });

  const enabled = parsed.filter((definition) => definition.enabled);
  const aliases = new Set<string>();

  for (const definition of enabled) {
    const normalizedAlias = definition.accountAlias.toLocaleLowerCase("en-US");
    if (aliases.has(normalizedAlias)) {
      throw new AccountConfigurationError(
        `Duplicate account alias: ${definition.accountAlias}`,
      );
    }
    aliases.add(normalizedAlias);
  }

  return enabled.map((definition): LoadedAccount => {
    if (definition.auth.type === "claude_profile") {
      return {
        accountAlias: definition.accountAlias,
        platform: "Claude",
        auth: {
          type: "claude_profile",
          profile: definition.auth.profile,
          claudeConfigDir: join(claudeProfilesRoot, definition.auth.profile),
        },
      };
    }

    if (definition.auth.type === "codex_profile") {
      return {
        accountAlias: definition.accountAlias,
        platform: "Codex",
        auth: {
          type: "codex_profile",
          profile: definition.auth.profile,
          codexHome: join(codexProfilesRoot, definition.auth.profile),
        },
      };
    }

    if (definition.auth.type === "claude_setup_token") {
      return {
        accountAlias: definition.accountAlias,
        platform: "Claude",
        auth: {
          type: "claude_setup_token",
          credentialEnv: definition.auth.credentialEnv,
          credential: environment[definition.auth.credentialEnv],
        },
      };
    }

    return {
      accountAlias: definition.accountAlias,
      platform: "Codex",
      auth: {
        type: "codex_access_token",
        credentialEnv: definition.auth.credentialEnv,
        credential: environment[definition.auth.credentialEnv],
      },
    };
  });
}
