import { getSettings, type CompanionSettings } from "./settings-manager.js";
import { locateClaudeOAuth, locateCodexAuth } from "./auth-status/credential-locator.js";
import { CLAUDE_AUTH_ENV_VARS, hasAnyClaudeAuthEnv, hasNonEmptyEnvVar } from "./provider-auth-env.js";

/**
 * Best-effort "is the coding CLI signed in on THIS host" detection, for the
 * New Session auth badge. It is purely LOCAL — credential files, auth env
 * vars, and companion-managed provider settings. No network call is made
 * (that would be slow and rate-limited); "authorized" means a credential the
 * CLI would use is present, not that it is known-valid against the API.
 *
 * The one exception is Claude OAuth: `~/.claude/.credentials.json` carries an
 * `expiresAt`, so an expired-but-present token is reported as `"expired"`
 * rather than `"authorized"` — this is a recurring real-world failure on
 * headless boxes where the refresh token can't be used interactively.
 */

export type AuthState = "authorized" | "expired" | "unauthorized";
export type AuthMethod = "env" | "oauth" | "api_key" | "settings_token";

export interface BackendAuthStatus {
  authState: AuthState;
  /** How we concluded "authorized"/"expired"; absent when unauthorized. */
  authMethod?: AuthMethod;
}

/**
 * Claude auth status. Precedence mirrors the CLI's own: an auth env var (or a
 * companion-managed key, which the spawn path injects as one) wins over the
 * OAuth file, so an expired OAuth file next to a live env key is still
 * "authorized". `now` is injectable for tests.
 */
export function getClaudeAuthStatus(
  env: NodeJS.ProcessEnv = process.env,
  settings: Pick<CompanionSettings, "claudeCodeOAuthToken" | "anthropicApiKey"> = getSettings(),
  now: number = Date.now(),
): BackendAuthStatus {
  if (hasAnyClaudeAuthEnv(env)) return { authState: "authorized", authMethod: "env" };
  if (settings.claudeCodeOAuthToken.trim()) return { authState: "authorized", authMethod: "settings_token" };
  if (settings.anthropicApiKey.trim()) return { authState: "authorized", authMethod: "api_key" };

  // macOS Keychain is not probed (see credential-locator.ts): the server
  // target is Linux and env/settings credentials are detected first anyway.
  const oauth = locateClaudeOAuth(env);
  if (oauth) {
    if (oauth.expiresAt !== null && oauth.expiresAt <= now) {
      return { authState: "expired", authMethod: "oauth" };
    }
    return { authState: "authorized", authMethod: "oauth" };
  }
  return { authState: "unauthorized" };
}

/**
 * Codex auth status. No expiry state (the `~/.codex/auth.json` schema has no
 * reliable expiry field we read); env var and companion key win over the file.
 */
export function getCodexAuthStatus(
  env: NodeJS.ProcessEnv = process.env,
  settings: Pick<CompanionSettings, "openaiApiKey"> = getSettings(),
): BackendAuthStatus {
  if (hasNonEmptyEnvVar(env, "OPENAI_API_KEY") || hasNonEmptyEnvVar(env, "CODEX_API_KEY")) {
    return { authState: "authorized", authMethod: "env" };
  }
  if (settings.openaiApiKey.trim()) return { authState: "authorized", authMethod: "api_key" };
  if (locateCodexAuth(env)) {
    return { authState: "authorized", authMethod: "oauth" };
  }
  return { authState: "unauthorized" };
}

/** Exposed for a future UI copy switch; the two getters are the real surface. */
export const CLAUDE_AUTH_ENV_VAR_NAMES = CLAUDE_AUTH_ENV_VARS;
