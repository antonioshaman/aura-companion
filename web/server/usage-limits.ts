import { classifyFetchError, usageLimitsUpstream } from "./diagnostics/upstream-status.js";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";
import { writeAtomicJson } from "./atomic-write.js";
import { log } from "./logger.js";
import { readClaudeOAuthSecret, type ClaudeOAuthSecret } from "./auth-status/credential-locator.js";

export interface UsageLimits {
  five_hour: { utilization: number; resets_at: string | null } | null;
  seven_day: { utilization: number; resets_at: string | null } | null;
  extra_usage: {
    is_enabled: boolean;
    monthly_limit: number;
    used_credits: number;
    utilization: number | null;
    disabled_reason?: string | null;
  } | null;
}

const OAUTH_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

// In-memory cache (60s TTL)
const CACHE_DURATION_MS = 60 * 1000;
let cache: { data: UsageLimits; timestamp: number } | null = null;

function readRawCredentials(): ClaudeOAuthSecret | null {
  return readClaudeOAuthSecret();
}

function writeCredentials(creds: Record<string, unknown>, sourcePath?: string): void {
  try {
    if (process.platform === "darwin") {
      const json = JSON.stringify(creds);
      execFileSync(
        "security",
        ["add-generic-password", "-U", "-s", "Claude Code-credentials", "-a", "Claude Code", "-w", json],
        { timeout: 5000, stdio: ["pipe", "pipe", "pipe"] },
      );
      return;
    }
    // Write back to the same file that was read, or default to .credentials.json.
    // Atomic (tmp+fsync+rename) so a crash or concurrent read never leaves a
    // truncated .credentials.json — a torn creds file fails to parse and breaks
    // both the usage panel AND the CLI's own auth. No size cap: credentials are
    // small and auth-critical, so a cap must never silently drop the writeback.
    const credPath = sourcePath ?? join(
      process.env.USERPROFILE || process.env.HOME || homedir() || "",
      ".claude",
      ".credentials.json",
    );
    writeAtomicJson(credPath, creds, { maxBytes: Number.POSITIVE_INFINITY });
  } catch (e) {
    // Surface the failure: silently losing a just-refreshed token forces a
    // re-refresh next call, and single-use refresh tokens can rotate out from
    // under us, permanently breaking refresh.
    log.warn("usage-limits", "Failed to persist refreshed OAuth credentials", {
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

/** Bound for the usage and OAuth-refresh fetches (review D-1). */
export const USAGE_FETCH_TIMEOUT_MS = 10_000;

async function refreshAccessToken(refreshToken: string): Promise<{
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
} | null> {
  try {
    const res = await fetch(OAUTH_TOKEN_URL, {
      signal: AbortSignal.timeout(USAGE_FETCH_TIMEOUT_MS),
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: OAUTH_CLIENT_ID,
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresIn: data.expires_in,
    };
  } catch {
    return null;
  }
}

export function getCredentials(): string | null {
  const creds = readRawCredentials();
  return creds?.accessToken ?? null;
}

async function getValidAccessToken(): Promise<string | null> {
  const creds = readRawCredentials();
  if (!creds) return null;

  // Token still valid (with 5min buffer)
  if (creds.expiresAt && Date.now() < creds.expiresAt - 5 * 60 * 1000) {
    return creds.accessToken;
  }

  // Token expired - try to refresh
  if (!creds.refreshToken) return null;

  const refreshed = await refreshAccessToken(creds.refreshToken);
  if (!refreshed) return null;

  // Update stored credentials
  creds.parsed.claudeAiOauth = {
    ...(creds.parsed.claudeAiOauth as Record<string, unknown>),
    accessToken: refreshed.accessToken,
    refreshToken: refreshed.refreshToken,
    expiresAt: Date.now() + refreshed.expiresIn * 1000,
  };
  writeCredentials(creds.parsed, creds.sourcePath);

  return refreshed.accessToken;
}

export async function fetchUsageLimits(
  token: string,
): Promise<UsageLimits | null> {
  try {
    const response = await fetch("https://api.anthropic.com/api/oauth/usage", {
      // Review D-1: a hung upstream must settle as a recorded timeout, not
      // leave the Diagnostics card saying "OK" forever.
      signal: AbortSignal.timeout(USAGE_FETCH_TIMEOUT_MS),
      method: "GET",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": "claude-code/2.1.39",
        Authorization: `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20",
      },
    });

    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      usageLimitsUpstream.recordFailure(response.status === 401 ? "oauth-expired" : "http", response.status);
      return null;
    }

    const data = await response.json();
    usageLimitsUpstream.recordOk();
    return {
      five_hour: data.five_hour || null,
      seven_day: data.seven_day || null,
      extra_usage: data.extra_usage || null,
    };
  } catch (err) {
    usageLimitsUpstream.recordFailure(classifyFetchError(err));
    return null;
  }
}

export async function getUsageLimits(): Promise<UsageLimits> {
  const empty: UsageLimits = {
    five_hour: null,
    seven_day: null,
    extra_usage: null,
  };
  try {
    if (cache && Date.now() - cache.timestamp < CACHE_DURATION_MS) {
      return cache.data;
    }

    const token = await getValidAccessToken();
    if (!token) {
      // Diagnostics: no credentials file at all vs an expired / unrefreshable token.
      usageLimitsUpstream.recordFailure(readRawCredentials() ? "oauth-expired" : "no-credentials");
      return empty;
    }

    const limits = await fetchUsageLimits(token);
    if (!limits) return empty;

    cache = { data: limits, timestamp: Date.now() };
    return limits;
  } catch {
    return empty;
  }
}
