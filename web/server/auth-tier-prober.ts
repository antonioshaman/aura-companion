// ─── Claude tier verification probe (PLAN Task 7) ─────────────────────────
//
// Anthropic does NOT publish a single canonical "what tier is this token?"
// endpoint. The Claude Code OAuth token (`claudeCodeOAuthToken`) and the
// direct API key (`anthropicApiKey`) both work against `api.anthropic.com`
// but the introspection surface is partially documented.
//
// User-confirmed strategy (HANDOFF-evening 2026-05-14): probe a chain of
// candidate endpoints — first one that returns a 200 with a parseable
// shape wins. After the first real production response lands, narrow the
// chain to the one that actually answered.
//
// Pure functions over an injected `fetcher` so tests inject a mock
// `Response`-shaped reply per candidate. Cache + route live in sibling
// modules so this stays a vendor-protocol concern only.

import { log } from "./logger.js";

/** Anthropic-canonical tier labels we care about distinguishing. */
export type ClaudeTier =
  | "max_20x"       // Claude MAX 20x — the user-driver feature ask
  | "max"           // legacy / non-20x MAX
  | "pro"           // Claude Pro
  | "team"          // Team plan
  | "enterprise"    // Enterprise
  | "free"          // Free tier
  | "api"           // API-only account (no plan)
  | "unknown";      // probe failed OR response shape unrecognised

export interface ClaudeTierResult {
  tier: ClaudeTier;
  /** Marketing-label plan name when the probe surfaced one (e.g. "Claude Max 20x"). Useful for UI verbatim display. */
  plan?: string;
  /** Daily message limit if the probe reported one. */
  dailyLimit?: number;
  /** Probe latency ms — observability. */
  latencyMs: number;
  /** Which endpoint actually answered (for the narrow-down step after first real response). */
  probedEndpoint?: string;
  /** Raw response excerpt for debugging when tier === "unknown" — capped at 512 chars. */
  rawExcerpt?: string;
}

/**
 * Candidate endpoint list — ordered by best guess. First 200 OK wins.
 *
 * Authentication header: each endpoint receives the OAuth token as
 * `Authorization: Bearer <token>` (Anthropic's documented OAuth pattern).
 *
 * Organisation-specific endpoints (`/v1/organizations/<id>`) are appended
 * to the chain when `organizationId` is configured. The user-provided
 * org ID lives in `CompanionSettings.anthropicOrganizationId` so prod
 * deploys with different org IDs don't share a hard-coded value.
 */
interface ProbeCandidate {
  url: string;
  /** Optional override — defaults to `Authorization: Bearer <token>`. */
  buildHeaders?: (token: string) => Record<string, string>;
  /** Pure response → tier extractor. Returns null when the shape is unrecognised; caller falls through to next candidate. */
  parse: (json: unknown) => Partial<ClaudeTierResult> | null;
}

function defaultHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    // Some Anthropic endpoints require this header even on GET.
    "anthropic-version": "2023-06-01",
  };
}

function asObject(x: unknown): Record<string, unknown> | null {
  return x && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : null;
}

function asString(x: unknown): string | null {
  return typeof x === "string" ? x : null;
}

function asNumber(x: unknown): number | null {
  return typeof x === "number" && Number.isFinite(x) ? x : null;
}

/**
 * Tier label inference from a plan name string. The probe responses tend
 * to carry a marketing-style label (`"Claude Max 20x"`) rather than a
 * machine-stable tier slug, so we normalise here. Case-insensitive
 * substring matching — durable against minor casing/spacing drift.
 */
export function inferTierFromPlanName(planName: string | null | undefined): ClaudeTier {
  if (!planName) return "unknown";
  const lower = planName.toLowerCase();
  // Order matters: "max 20x" must beat "max" alone.
  if (lower.includes("max") && (lower.includes("20x") || lower.includes("20 x"))) return "max_20x";
  if (lower.includes("max")) return "max";
  if (lower.includes("team")) return "team";
  if (lower.includes("enterprise")) return "enterprise";
  if (lower.includes("pro")) return "pro";
  if (lower.includes("free")) return "free";
  if (lower.includes("api")) return "api";
  return "unknown";
}

/**
 * The probe chain. Each candidate has its own parser because the
 * underlying surface varies (`/v1/me` shape ≠ `/oauth/userinfo` shape).
 * When one starts answering in production, drop the rest in a follow-up PR.
 */
/**
 * Build the org-specific candidate. Kept out of the static list so the
 * URL interpolation only runs when an org ID is actually configured —
 * keeps the static chain cheap and lets the chain order place this
 * candidate first (most specific) when present.
 */
function buildOrgCandidate(organizationId: string): ProbeCandidate {
  // Strict slug — UUID-shape only. Defensive against accidental newline
  // or path-traversal char leakage into the URL even though the input
  // flows through a Zod validator at the route boundary.
  const safeId = organizationId.replace(/[^a-zA-Z0-9-]/g, "");
  return {
    url: `https://api.anthropic.com/v1/organizations/${safeId}`,
    parse: (json) => {
      const obj = asObject(json);
      if (!obj) return null;
      const planRaw =
        asString(obj.plan) ??
        asString(obj.tier) ??
        asString((asObject(obj.subscription))?.plan) ??
        asString((asObject(obj.subscription))?.plan_name);
      if (!planRaw) return null;
      const dailyLimit =
        asNumber((asObject(obj.usage_limits))?.daily) ??
        asNumber(obj.daily_message_limit);
      return {
        tier: inferTierFromPlanName(planRaw),
        plan: planRaw,
        dailyLimit: dailyLimit ?? undefined,
      };
    },
  };
}

const PROBE_CANDIDATES: ProbeCandidate[] = [
  {
    // Best guess #1: OAuth-style userinfo. Standard for OIDC providers.
    url: "https://api.anthropic.com/api/oauth/userinfo",
    parse: (json) => {
      const obj = asObject(json);
      if (!obj) return null;
      // Common OIDC shape: { sub, email, ..., plan: "Claude Max 20x" }
      const planRaw =
        asString(obj.plan) ??
        asString((asObject(obj.subscription))?.plan_name) ??
        asString((asObject(obj.organization))?.plan);
      if (!planRaw) return null;
      const tier = inferTierFromPlanName(planRaw);
      const dailyLimit =
        asNumber((asObject(obj.usage_limits))?.daily) ??
        asNumber(obj.daily_message_limit);
      return { tier, plan: planRaw, dailyLimit: dailyLimit ?? undefined };
    },
  },
  {
    // Best guess #2: REST-style `/v1/me` (GitHub convention).
    url: "https://api.anthropic.com/v1/me",
    parse: (json) => {
      const obj = asObject(json);
      if (!obj) return null;
      const planRaw =
        asString(obj.plan) ??
        asString((asObject(obj.account))?.plan) ??
        asString((asObject(obj.account))?.tier);
      if (!planRaw) return null;
      const tier = inferTierFromPlanName(planRaw);
      return { tier, plan: planRaw };
    },
  },
  {
    // Best guess #3: organisation listing (admin-scoped tokens).
    url: "https://api.anthropic.com/v1/organizations",
    parse: (json) => {
      const obj = asObject(json);
      if (!obj) return null;
      const data = obj.data;
      if (!Array.isArray(data) || data.length === 0) return null;
      const first = asObject(data[0]);
      if (!first) return null;
      const planRaw = asString(first.plan) ?? asString(first.tier);
      if (!planRaw) return null;
      return { tier: inferTierFromPlanName(planRaw), plan: planRaw };
    },
  },
];

export interface FetchLike {
  (url: string, init: { method: string; headers: Record<string, string> }): Promise<{
    ok: boolean;
    status: number;
    text: () => Promise<string>;
  }>;
}

/**
 * Probe the candidate chain in order. Returns the first 200 OK that
 * parsed into a recognised tier. If every candidate fails or returns a
 * non-parseable shape, returns `{ tier: "unknown", rawExcerpt }` where
 * `rawExcerpt` carries the last response body for debugging.
 *
 * Network errors per-candidate are caught and treated as "try the next
 * one" — the probe must not crash the route on a transient connectivity
 * failure.
 */
export async function probeClaudeTier(
  token: string,
  organizationId: string | undefined,
  fetcher: FetchLike,
  nowMs: () => number = () => Date.now(),
): Promise<ClaudeTierResult> {
  const startedAt = nowMs();

  if (!token || token.trim().length === 0) {
    return {
      tier: "unknown",
      latencyMs: nowMs() - startedAt,
      rawExcerpt: "no token configured",
    };
  }

  // Build the effective chain: org-specific candidate FIRST when
  // configured (most specific, highest chance of carrying the plan
  // field), then the static guesses.
  const chain: ProbeCandidate[] =
    organizationId && organizationId.trim().length > 0
      ? [buildOrgCandidate(organizationId), ...PROBE_CANDIDATES]
      : [...PROBE_CANDIDATES];

  let lastRawExcerpt: string | undefined;
  let lastProbedEndpoint: string | undefined;

  for (const candidate of chain) {
    lastProbedEndpoint = candidate.url;
    const headers = (candidate.buildHeaders ?? defaultHeaders)(token);

    let response: Awaited<ReturnType<FetchLike>>;
    try {
      response = await fetcher(candidate.url, { method: "GET", headers });
    } catch (err) {
      log.warn("auth-tier-prober", "probe candidate threw", {
        url: candidate.url,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    if (!response.ok) {
      // 401/403 → token doesn't have this endpoint scoped; try next.
      // 404 → endpoint doesn't exist for this token; try next.
      // 5xx → upstream blip; try next (gives the chain a chance to find a
      // working endpoint even when one is degraded).
      log.warn("auth-tier-prober", "probe candidate non-ok", {
        url: candidate.url,
        status: response.status,
      });
      continue;
    }

    let body: string;
    try {
      body = await response.text();
    } catch (err) {
      log.warn("auth-tier-prober", "probe candidate body read failed", {
        url: candidate.url,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    let json: unknown;
    try {
      json = JSON.parse(body);
    } catch {
      lastRawExcerpt = body.slice(0, 512);
      log.warn("auth-tier-prober", "probe candidate non-json", { url: candidate.url });
      continue;
    }

    const parsed = candidate.parse(json);
    if (!parsed || parsed.tier === undefined || parsed.tier === "unknown") {
      lastRawExcerpt = body.slice(0, 512);
      continue;
    }

    return {
      tier: parsed.tier,
      plan: parsed.plan,
      dailyLimit: parsed.dailyLimit,
      latencyMs: nowMs() - startedAt,
      probedEndpoint: candidate.url,
    };
  }

  // Every candidate exhausted. Return unknown with last-seen body for
  // debugging — operator looks at this once, then a follow-up PR
  // narrows the chain to the endpoint that actually answers.
  return {
    tier: "unknown",
    latencyMs: nowMs() - startedAt,
    probedEndpoint: lastProbedEndpoint,
    rawExcerpt: lastRawExcerpt,
  };
}

/** Exposed for tests — lets the suite assert against the canonical list. */
export const PROBE_CANDIDATE_URLS: readonly string[] = PROBE_CANDIDATES.map((c) => c.url);
