import { execSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Single answer to "which credential source does each coding CLI use, where
 * is it, whose is it, and when does it expire" — for Claude and Codex.
 *
 * Everything exported here is METADATA (path, owner, mode, mtime, expiry,
 * booleans). Token bytes never leave this module, with one narrow exception:
 * `readClaudeOAuthSecret`, which exists only so `usage-limits.ts` can call the
 * usage endpoint. Callers that render, log or persist anything must use the
 * metadata functions.
 *
 * Before this module the candidate file list lived in host-auth-status.ts AND
 * usage-limits.ts (and a shell copy in container-manager.ts); a status surface
 * and the limits panel could therefore disagree about which file is in effect.
 */

/** Claude credential-file candidates under `~/.claude`, in lookup order. */
export const CLAUDE_CREDENTIAL_FILE_NAMES = [
  ".credentials.json",
  "auth.json",
  ".auth.json",
  "credentials.json",
] as const;

/** The Codex CLI keeps one credential file: `~/.codex/auth.json`. */
export const CODEX_CREDENTIAL_FILE_NAME = "auth.json";

/** HOME the CLI resolves for the given environment (Windows first, like the CLIs). */
export function resolveAuthHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.USERPROFILE || env.HOME || homedir() || "";
}

/** `stat` facts about a credential file — safe to render (paths subject to EC-23 in logs). */
export interface CredentialFileMeta {
  path: string;
  uid: number;
  gid: number;
  /** Permission bits only (`mode & 0o777`). */
  mode: number;
  size: number;
  mtimeMs: number;
  dev: number;
  ino: number;
}

export interface ClaudeOAuthLocation {
  meta: CredentialFileMeta;
  /** Epoch ms the access token expires; null when the file carries none. */
  expiresAt: number | null;
  /** Epoch ms the refresh token expires, when the CLI records it. */
  refreshTokenExpiresAt: number | null;
  hasRefreshToken: boolean;
  /** e.g. "pro" / "max" — recorded locally by the CLI at login; null when absent. */
  subscriptionType: string | null;
}

export type CodexAuthMode = "chatgpt" | "api_key" | "unknown";

export interface CodexAuthLocation {
  meta: CredentialFileMeta;
  authMode: CodexAuthMode;
  /** Epoch ms of the CLI's last token refresh (`last_refresh`), null when absent/unparsable. */
  lastRefreshAt: number | null;
}

function statMeta(path: string): CredentialFileMeta | null {
  try {
    const st = statSync(path);
    if (!st.isFile()) return null;
    return {
      path,
      uid: st.uid,
      gid: st.gid,
      mode: st.mode & 0o777,
      size: st.size,
      mtimeMs: st.mtimeMs,
      dev: st.dev,
      ino: st.ino,
    };
  } catch {
    return null;
  }
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function claudeOAuthBlock(parsed: Record<string, unknown> | null): Record<string, unknown> | null {
  const oauth = parsed?.claudeAiOauth;
  if (!oauth || typeof oauth !== "object") return null;
  const block = oauth as Record<string, unknown>;
  return typeof block.accessToken === "string" && block.accessToken.length > 0 ? block : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * First `~/.claude/*` credential file carrying a usable `claudeAiOauth` block.
 * Unreadable / malformed candidates are skipped (the CLI does the same).
 * macOS Keychain is deliberately not probed here — the server target is Linux.
 */
export function locateClaudeOAuth(env: NodeJS.ProcessEnv = process.env): ClaudeOAuthLocation | null {
  const dir = join(resolveAuthHome(env), ".claude");
  for (const fileName of CLAUDE_CREDENTIAL_FILE_NAMES) {
    const path = join(dir, fileName);
    if (!existsSync(path)) continue;
    const oauth = claudeOAuthBlock(readJson(path));
    if (!oauth) continue;
    const meta = statMeta(path);
    if (!meta) continue;
    return {
      meta,
      expiresAt: numberOrNull(oauth.expiresAt),
      refreshTokenExpiresAt: numberOrNull(oauth.refreshTokenExpiresAt),
      hasRefreshToken: typeof oauth.refreshToken === "string" && oauth.refreshToken.length > 0,
      subscriptionType: typeof oauth.subscriptionType === "string" && oauth.subscriptionType ? oauth.subscriptionType : null,
    };
  }
  return null;
}

/** Path of `~/.codex/auth.json` for the environment (whether or not it exists). */
export function codexAuthPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveAuthHome(env), ".codex", CODEX_CREDENTIAL_FILE_NAME);
}

/**
 * `~/.codex/auth.json` metadata. Presence alone is what the CLI keys on, so a
 * present-but-unparsable file still locates (authMode "unknown").
 */
export function locateCodexAuth(env: NodeJS.ProcessEnv = process.env): CodexAuthLocation | null {
  const path = codexAuthPath(env);
  if (!existsSync(path)) return null;
  const meta = statMeta(path);
  if (!meta) return null;
  const parsed = readJson(path);
  let authMode: CodexAuthMode = "unknown";
  if (parsed) {
    const tokens = parsed.tokens as Record<string, unknown> | null | undefined;
    if (parsed.auth_mode === "chatgpt" || (tokens && typeof tokens === "object" && typeof tokens.access_token === "string")) {
      authMode = "chatgpt";
    } else if (parsed.auth_mode === "apikey" || parsed.auth_mode === "api_key" || (typeof parsed.OPENAI_API_KEY === "string" && parsed.OPENAI_API_KEY)) {
      authMode = "api_key";
    }
  }
  const lastRefresh = typeof parsed?.last_refresh === "string" ? Date.parse(parsed.last_refresh) : NaN;
  return { meta, authMode, lastRefreshAt: Number.isFinite(lastRefresh) ? lastRefresh : null };
}

/** The ONLY token-bearing shape this module returns; see `readClaudeOAuthSecret`. */
export interface ClaudeOAuthSecret {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number | null;
  /** Full parsed file, kept only for usage-limits' legacy writeback. */
  parsed: Record<string, unknown>;
  /** Source file, or undefined for the macOS Keychain. */
  sourcePath?: string;
}

/**
 * NARROW EXCEPTION: returns the Claude OAuth access token so `usage-limits.ts`
 * can query the usage endpoint. Never log, render or persist the result.
 * macOS reads the login Keychain; everything else reads `~/.claude/*`.
 */
export function readClaudeOAuthSecret(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): ClaudeOAuthSecret | null {
  try {
    if (platform === "darwin") {
      const raw = execSync(
        'security find-generic-password -s "Claude Code-credentials" -w',
        { encoding: "utf-8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"] },
      ).trim();
      const decoded = raw.startsWith("{") ? raw : Buffer.from(raw, "hex").toString("utf-8");
      const parsed: unknown = JSON.parse(decoded);
      const record = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
      const oauth = claudeOAuthBlock(record);
      if (!record || !oauth) return null;
      return toSecret(oauth, record);
    }
    const dir = join(resolveAuthHome(env), ".claude");
    for (const fileName of CLAUDE_CREDENTIAL_FILE_NAMES) {
      const path = join(dir, fileName);
      if (!existsSync(path)) continue;
      const parsed = readJson(path);
      const oauth = claudeOAuthBlock(parsed);
      if (!parsed || !oauth) continue;
      return toSecret(oauth, parsed, path);
    }
    return null;
  } catch {
    return null;
  }
}

function toSecret(
  oauth: Record<string, unknown>,
  parsed: Record<string, unknown>,
  sourcePath?: string,
): ClaudeOAuthSecret {
  return {
    accessToken: oauth.accessToken as string,
    refreshToken: typeof oauth.refreshToken === "string" && oauth.refreshToken ? oauth.refreshToken : null,
    expiresAt: numberOrNull(oauth.expiresAt),
    parsed,
    sourcePath,
  };
}
