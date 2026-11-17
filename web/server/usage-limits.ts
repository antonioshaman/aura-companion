import { classifyFetchError, usageLimitsUpstream } from "./diagnostics/upstream-status.js";
import { log } from "./logger.js";
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

let reportedShapeMismatch = false;

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * The provider-internal usage endpoint is reshaped from time to time; a cast
 * passed a string or a 0–1 fraction straight to the gauge (willison #7).
 * null = not understood (the panel then says so instead of a wrong number).
 */
export function parseUsageBody(body: unknown): Omit<UsageLimits, "reason"> | null {
  if (!body || typeof body !== "object") return null;
  const data = body as Record<string, unknown>;
  const window = (v: unknown): UsageLimits["five_hour"] | undefined => {
    if (v === null || v === undefined) return null;
    if (typeof v !== "object") return undefined;
    const w = v as Record<string, unknown>;
    if (!finite(w.utilization) || w.utilization < 0) return undefined;
    if (w.resets_at !== null && w.resets_at !== undefined && typeof w.resets_at !== "string") return undefined;
    return { utilization: w.utilization, resets_at: typeof w.resets_at === "string" ? w.resets_at : null };
  };
  const five = window(data.five_hour);
  const seven = window(data.seven_day);
  if (five === undefined || seven === undefined) return null;
  let extra: UsageLimits["extra_usage"] = null;
  if (data.extra_usage !== null && data.extra_usage !== undefined) {
    const e = data.extra_usage as Record<string, unknown>;
    if (typeof e !== "object" || typeof e.is_enabled !== "boolean") return null;
    if (e.monthly_limit !== null && e.monthly_limit !== undefined && !finite(e.monthly_limit)) return null;
    if (e.used_credits !== null && e.used_credits !== undefined && !finite(e.used_credits)) return null;
    if (e.utilization !== null && e.utilization !== undefined && !finite(e.utilization)) return null;
    extra = e as unknown as UsageLimits["extra_usage"];
  }
  return { five_hour: five, seven_day: seven, extra_usage: extra };
}

type UsageFetchResult = { limits: UsageLimits } | { reason: UsageLimitsReason };

async function fetchUsage(token: string): Promise<UsageFetchResult> {
  const outcome = await requestClaudeUsage(token);
  switch (outcome.kind) {
    case "ok": {
      usageLimitsUpstream.recordOk();
      const limits = parseUsageBody(outcome.body);
      if (!limits) {
        if (!reportedShapeMismatch) {
          reportedShapeMismatch = true;
          log.warn("usage-limits", "usage body not understood — showing no gauge instead of a wrong one", { event: "usage_limits.shape_mismatch" });
        }
        return { reason: "unknown" };
      }
      return { limits };
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

/**
 * Is an API key the EFFECTIVE Claude sign-in? Mirrors the CLI / spawn
 * precedence (provider-auth-env.ts, host-auth-status.ts): an `ANTHROPIC_API_KEY`
 * env var beats every OAuth source; a companion-managed API key beats the OAuth
 * file but loses to a companion-managed OAuth token. Checked BEFORE the OAuth
 * file, so a stale leftover file never masks an active API-key login (S4-AC2).
 */
function isApiKeyLogin(
  env: NodeJS.ProcessEnv,
  settings: Pick<CompanionSettings, "anthropicApiKey" | "claudeCodeOAuthToken">,
): boolean {
  if (hasNonEmptyEnvVar(env, "ANTHROPIC_API_KEY")) return true;
  return settings.anthropicApiKey.trim().length > 0 && !settings.claudeCodeOAuthToken.trim();
}

export async function getUsageLimits(
  opts: {
    env?: NodeJS.ProcessEnv;
    settings?: Pick<CompanionSettings, "anthropicApiKey" | "claudeCodeOAuthToken">;
    now?: number;
  } = {},
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
    if (isApiKeyLogin(env, opts.settings ?? getSettings())) {
      // Not an upstream failure: there are simply no subscription windows.
      return empty("api_key_login");
    }
    const secret = readClaudeOAuthSecret(env);
    if (!secret) {
      usageLimitsUpstream.recordFailure("no-credentials");
      return empty("no_credentials");
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
