import { classifyFetchError, usageLimitsUpstream } from "./diagnostics/upstream-status.js";
import { readClaudeOAuthSecret } from "./auth-status/credential-locator.js";
import { requestClaudeUsage, CLAUDE_USAGE_TIMEOUT_MS } from "./auth-status/claude-usage-request.js";
import type { UsageLimitsReason } from "./auth-status/auth-types.js";
import { hasNonEmptyEnvVar } from "./provider-auth-env.js";
import { getSettings, type CompanionSettings } from "./settings-manager.js";

/**
 * Claude subscription usage windows for the usage-limits panel.
 *
 * READ-ONLY with respect to credentials (owner default (a), LLM-auth phase 1
 * task 6): this module never refreshes the OAuth token and never writes the
 * credential file. Refreshing here raced live CLIs for the single-use
 * refresh token (rotation could invalidate every session's sign-in) and left
 * the file root-owned when the server ran as root. An expired or rejected
 * token is now reported as `reason: "auth_invalid"`; the CLI itself refreshes
 * on its next real turn.
 */

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
  /**
   * Why the windows are empty. Absent when data is present, so older clients
   * that only read the three window fields keep working.
   */
  reason?: UsageLimitsReason;
}

// In-memory cache (60s TTL)
const CACHE_DURATION_MS = 60 * 1000;
let cache: { data: UsageLimits; timestamp: number } | null = null;

/** Bound for the usage fetch (review D-1). */
export const USAGE_FETCH_TIMEOUT_MS = CLAUDE_USAGE_TIMEOUT_MS;

/** Treat a token expiring within this margin as expired (no request is made). */
const EXPIRY_BUFFER_MS = 5 * 60 * 1000;

export function getCredentials(): string | null {
  return readClaudeOAuthSecret()?.accessToken ?? null;
}

type UsageFetchResult = { limits: UsageLimits } | { reason: UsageLimitsReason };

async function fetchUsage(token: string): Promise<UsageFetchResult> {
  const outcome = await requestClaudeUsage(token);
  switch (outcome.kind) {
    case "ok": {
      const data = outcome.body as Record<string, unknown>;
      usageLimitsUpstream.recordOk();
      return {
        limits: {
          five_hour: (data.five_hour as UsageLimits["five_hour"]) || null,
          seven_day: (data.seven_day as UsageLimits["seven_day"]) || null,
          extra_usage: (data.extra_usage as UsageLimits["extra_usage"]) || null,
        },
      };
    }
    case "rejected":
      usageLimitsUpstream.recordFailure(outcome.status === 401 ? "oauth-expired" : "http", outcome.status);
      return { reason: "auth_invalid" };
    case "http":
      usageLimitsUpstream.recordFailure("http", outcome.status);
      return { reason: "unknown" };
    case "network":
      // Review D-1: a hung upstream settles as a recorded timeout via the abort signal.
      usageLimitsUpstream.recordFailure(classifyFetchError(outcome.error));
      return { reason: "network" };
  }
}

export async function fetchUsageLimits(token: string): Promise<UsageLimits | null> {
  const result = await fetchUsage(token);
  return "limits" in result ? result.limits : null;
}

/** API-key sign-ins have no subscription windows (S4-AC2). */
function isApiKeyLogin(env: NodeJS.ProcessEnv, settings: Pick<CompanionSettings, "anthropicApiKey">): boolean {
  return hasNonEmptyEnvVar(env, "ANTHROPIC_API_KEY") || settings.anthropicApiKey.trim().length > 0;
}

export async function getUsageLimits(
  opts: { env?: NodeJS.ProcessEnv; settings?: Pick<CompanionSettings, "anthropicApiKey">; now?: number } = {},
): Promise<UsageLimits> {
  const empty = (reason: UsageLimitsReason): UsageLimits => ({
    five_hour: null,
    seven_day: null,
    extra_usage: null,
    reason,
  });
  try {
    const now = opts.now ?? Date.now();
    // EC-38 anomaly form: a cache stamped in the future (clock went back) is a miss.
    if (cache && now >= cache.timestamp && now - cache.timestamp < CACHE_DURATION_MS) {
      return cache.data;
    }

    const env = opts.env ?? process.env;
    const secret = readClaudeOAuthSecret(env);
    if (!secret) {
      usageLimitsUpstream.recordFailure("no-credentials");
      return empty(isApiKeyLogin(env, opts.settings ?? getSettings()) ? "api_key_login" : "no_credentials");
    }
    // Only a token that is not expired locally is used; never refreshed here.
    if (secret.expiresAt === null || now >= secret.expiresAt - EXPIRY_BUFFER_MS) {
      usageLimitsUpstream.recordFailure("oauth-expired");
      return empty("auth_invalid");
    }

    const result = await fetchUsage(secret.accessToken);
    if ("reason" in result) return empty(result.reason);

    cache = { data: result.limits, timestamp: Date.now() };
    return result.limits;
  } catch {
    return empty("unknown");
  }
}
