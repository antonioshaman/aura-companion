import type { AuthLoginMethod, EffectiveAuthMethod } from "./auth-status/auth-types.js";

/**
 * Single source of truth for provider auth environment variables.
 *
 * Both the create-time spawn default (`session-orchestrator.ts`) and the
 * relaunch-time reconcile (`cli-launcher.ts`) consult these helpers so the set
 * of Claude auth vars cannot drift between the two layers (council review
 * 2026-06-30 P3 #14).
 */

/**
 * Every environment variable Claude Code consults for authentication, in the
 * CLI's own precedence order: an api key beats the OAuth token, so a stale
 * `ANTHROPIC_API_KEY` left in the env will shadow a freshly-set OAuth token.
 */
export const CLAUDE_AUTH_ENV_VARS = [
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_AUTH_TOKEN",
] as const;

export function hasNonEmptyEnvVar(
  env: Record<string, string | undefined> | undefined,
  key: string,
): boolean {
  const value = env?.[key];
  return typeof value === "string" && value.trim().length > 0;
}

export function hasAnyClaudeAuthEnv(
  env: Record<string, string | undefined> | undefined,
): boolean {
  return CLAUDE_AUTH_ENV_VARS.some((key) => hasNonEmptyEnvVar(env, key));
}

export interface ProviderAuthSettings {
  claudeCodeOAuthToken?: string;
  anthropicApiKey?: string;
  openaiApiKey?: string;
}

/**
 * Compute the auth env a session should be relaunched with, treating the global
 * provider settings as authoritative for Claude.
 *
 * Claude: clear every global-managed auth var first, then set exactly the
 * chosen method. The clears are explicit `undefined` (not `delete`) so the
 * spawn-env merge (`{ ...process.env, ...options.env }`) drops them even when
 * the var was inherited from the server's own `process.env` — a plain delete
 * from the per-session copy lets the inherited value resurface in the child
 * (council review 2026-06-30 P1 #1 + P2 #7). When global settings carry no
 * Claude credential at all, every auth var is cleared so the session de-auths.
 *
 * Codex: inject `OPENAI_API_KEY` only when absent (one var, no precedence
 * trap — env-profile keys legitimately win).
 */
export function reconcileProviderAuthForRelaunch(
  env: Record<string, string | undefined> | undefined,
  backendType: "claude" | "codex" | undefined,
  settings: ProviderAuthSettings,
): Record<string, string | undefined> | undefined {
  const baseEnv: Record<string, string | undefined> = env ? { ...env } : {};

  if (backendType === "claude") {
    for (const key of CLAUDE_AUTH_ENV_VARS) baseEnv[key] = undefined;
    if (settings.claudeCodeOAuthToken) {
      baseEnv.CLAUDE_CODE_OAUTH_TOKEN = settings.claudeCodeOAuthToken;
    } else if (settings.anthropicApiKey) {
      baseEnv.ANTHROPIC_API_KEY = settings.anthropicApiKey;
    }
  }

  if (
    backendType === "codex"
    && settings.openaiApiKey
    && !hasNonEmptyEnvVar(baseEnv, "OPENAI_API_KEY")
  ) {
    baseEnv.OPENAI_API_KEY = settings.openaiApiKey;
  }

  return Object.keys(baseEnv).length > 0 ? baseEnv : undefined;
}

/**
 * The service user's stored Codex sign-in mode (`~/.codex/auth.json`), or null
 * when there is none. The caller locates the file — this module stays pure.
 */
export type StoredCodexAuthMode = "chatgpt" | "api_key" | "unknown" | null;

/**
 * Claude auth env vars in the CLI's documented precedence (an explicit auth
 * token, then an API key, then the OAuth tokens). Only the first one present
 * is reported: it is the one sessions use.
 */
const CLAUDE_ENV_PRECEDENCE: ReadonlyArray<{ variable: (typeof CLAUDE_AUTH_ENV_VARS)[number]; method: AuthLoginMethod }> = [
  { variable: "ANTHROPIC_AUTH_TOKEN", method: "env_token" },
  { variable: "ANTHROPIC_API_KEY", method: "api_key" },
  { variable: "CLAUDE_CODE_OAUTH_TOKEN", method: "env_token" },
  { variable: "CLAUDE_CODE_AUTH_TOKEN", method: "env_token" },
];

const CODEX_ENV_KEYS = ["OPENAI_API_KEY", "CODEX_API_KEY"] as const;

/**
 * Which credentials a NEW session of this provider really uses (phase 2 task
 * 7, D5, AP-19) — the one answer to "will the sign-in be used?". Mirrors the
 * spawn path (`session-orchestrator.ts` injects settings credentials as env
 * vars only when the service env has none) and the CLIs' proven precedence:
 *
 * - Claude: any auth env var, then the Aura-settings OAuth token / API key,
 *   override the stored sign-in → reported by name and place.
 * - Codex (0.162.1, proven in phase 1 #459): a stored ChatGPT sign-in wins over
 *   `OPENAI_API_KEY`; a configured key is only noted (`alsoSet`). Without a
 *   ChatGPT sign-in an env key, then the settings key, is used.
 *
 * Returns names only — never a value.
 */
export function effectiveSessionAuthMethod(
  provider: "claude" | "codex",
  settings: Required<ProviderAuthSettings>,
  env: Record<string, string | undefined>,
  codexAuthMode: StoredCodexAuthMode,
): EffectiveAuthMethod {
  if (provider === "claude") {
    const fromEnv = CLAUDE_ENV_PRECEDENCE.find(({ variable }) => hasNonEmptyEnvVar(env, variable));
    if (fromEnv) return { method: fromEnv.method, source: "environment", variable: fromEnv.variable };
    if (settings.claudeCodeOAuthToken.trim()) return { method: "env_token", source: "settings", variable: "CLAUDE_CODE_OAUTH_TOKEN" };
    if (settings.anthropicApiKey.trim()) return { method: "api_key", source: "settings", variable: "ANTHROPIC_API_KEY" };
    return { method: "subscription", source: "sign_in" };
  }

  const envKey = CODEX_ENV_KEYS.find((key) => hasNonEmptyEnvVar(env, key));
  const configured: EffectiveAuthMethod["alsoSet"] = envKey
    ? { source: "environment", variable: envKey }
    : settings.openaiApiKey.trim() ? { source: "settings", variable: "OPENAI_API_KEY" } : undefined;
  if (codexAuthMode === "chatgpt") {
    return configured ? { method: "subscription", source: "sign_in", alsoSet: configured } : { method: "subscription", source: "sign_in" };
  }
  if (configured) return { method: "api_key", source: configured.source, variable: configured.variable };
  return { method: codexAuthMode === "api_key" ? "api_key" : "subscription", source: "sign_in" };
}
