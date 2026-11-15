import { getSettings, type CompanionSettings } from "./settings-manager.js";
import { locateClaudeOAuth, locateCodexAuth } from "./auth-status/credential-locator.js";
import { CLAUDE_AUTH_ENV_VARS, effectiveSessionAuthMethod } from "./provider-auth-env.js";

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
  // One precedence for the badge and the provider status (AP-19, phase 2 task 7).
  const effective = effectiveSessionAuthMethod("claude", { ...settings, openaiApiKey: "" }, env, null);
  if (effective.source === "environment") return { authState: "authorized", authMethod: "env" };
  if (effective.source === "settings") {
    return { authState: "authorized", authMethod: effective.method === "api_key" ? "api_key" : "settings_token" };
  }

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
 * reliable expiry field we read). A stored ChatGPT sign-in wins: codex 0.162.1
 * keeps using it even with OPENAI_API_KEY set (`codex doctor` → "auth mode
 * chatgpt"), and Aura injects the settings key as that env var — the same
 * precedence as the provider status probe (LLM auth 1c). Otherwise an env
 * var or the companion key wins over an API-key / unreadable file.
 */
export function getCodexAuthStatus(
  env: NodeJS.ProcessEnv = process.env,
  settings: Pick<CompanionSettings, "openaiApiKey"> = getSettings(),
): BackendAuthStatus {
  const file = locateCodexAuth(env);
  const effective = effectiveSessionAuthMethod(
    "codex", { claudeCodeOAuthToken: "", anthropicApiKey: "", openaiApiKey: settings.openaiApiKey }, env, file?.authMode ?? null,
  );
  if (file?.authMode === "chatgpt") return { authState: "authorized", authMethod: "oauth" };
  if (effective.source === "environment") return { authState: "authorized", authMethod: "env" };
  if (effective.source === "settings") return { authState: "authorized", authMethod: "api_key" };
  if (file) {
    return { authState: "authorized", authMethod: file.authMode === "api_key" ? "api_key" : "oauth" };
  }
  return { authState: "unauthorized" };
}

/** Exposed for a future UI copy switch; the two getters are the real surface. */
export const CLAUDE_AUTH_ENV_VAR_NAMES = CLAUDE_AUTH_ENV_VARS;
