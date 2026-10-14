import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getSettings, type CompanionSettings } from "./settings-manager.js";
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

/** Credential-file candidates under `~/.claude` — mirrors usage-limits.ts. */
const CLAUDE_CREDENTIAL_FILES = [
  ".credentials.json",
  "auth.json",
  ".auth.json",
  "credentials.json",
];

function resolveHome(env: NodeJS.ProcessEnv): string {
  return env.USERPROFILE || env.HOME || homedir() || "";
}

interface ClaudeOAuth {
  accessToken: string;
  /** Epoch ms the access token expires; absent/0 ⇒ treat as non-expiring here. */
  expiresAt?: number;
}

/**
 * Read the Claude OAuth token from `~/.claude/*` credential files. NOTE: on
 * macOS the token lives in the login Keychain (see usage-limits.ts), which we
 * deliberately do NOT probe here — the server target is Linux, and env/settings
 * credentials are detected first anyway, so the only gap is a macOS dev box
 * that signed in with `claude` and set no env/settings key.
 */
function readClaudeOAuth(env: NodeJS.ProcessEnv): ClaudeOAuth | null {
  const dir = join(resolveHome(env), ".claude");
  for (const fileName of CLAUDE_CREDENTIAL_FILES) {
    const path = join(dir, fileName);
    if (!existsSync(path)) continue;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf-8")) as {
        claudeAiOauth?: { accessToken?: unknown; expiresAt?: unknown };
      };
      const oauth = parsed?.claudeAiOauth;
      if (typeof oauth?.accessToken === "string" && oauth.accessToken.length > 0) {
        return {
          accessToken: oauth.accessToken,
          expiresAt: typeof oauth.expiresAt === "number" ? oauth.expiresAt : undefined,
        };
      }
    } catch {
      // Unreadable / malformed file — try the next candidate.
    }
  }
  return null;
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

  const oauth = readClaudeOAuth(env);
  if (oauth) {
    if (typeof oauth.expiresAt === "number" && oauth.expiresAt > 0 && oauth.expiresAt <= now) {
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
  if (existsSync(join(resolveHome(env), ".codex", "auth.json"))) {
    return { authState: "authorized", authMethod: "oauth" };
  }
  return { authState: "unauthorized" };
}

/** Exposed for a future UI copy switch; the two getters are the real surface. */
export const CLAUDE_AUTH_ENV_VAR_NAMES = CLAUDE_AUTH_ENV_VARS;
