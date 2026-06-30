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
