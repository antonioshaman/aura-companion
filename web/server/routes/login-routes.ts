import type { Context, Hono, MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { PROVIDER_IDS, isTerminalLoginState, type ProviderId } from "../auth-status/auth-types.js";
import { signInSteps, type SessionRenewalCounts } from "../auth-status/auth-catalog.js";
import { verifyToken } from "../auth-manager.js";
import { log } from "../logger.js";
import { isOriginAllowed } from "../middleware/origin-allowlist.js";
import {
  ATTEMPT_ID_PATTERN,
  MAX_REPLY_CODE_LENGTH,
  type LoginAttempt,
  type LoginAttempts,
} from "../llm-login/login-attempt.js";

/**
 * Sign-in REST (phase 2 plan task 8, D4/D9). State is polled over REST, never
 * pushed over WS: browser WS frames are recorded and fanned out to every tab.
 *
 *   POST /llm-auth/login/:provider                     start, or the running one (201 / 200 existing)
 *   GET  /llm-auth/login/:provider                     read only — never starts anything
 *   POST /llm-auth/login/:provider/:attemptId/code     Claude reply code (Codex → 400 no_code_step)
 *   POST /llm-auth/login/:provider/:attemptId/cancel
 *
 * Guard on every route, on top of the shared `/api` middleware:
 *  - the Aura token is REQUIRED even from localhost (D9, review 201 STOP): the
 *    shared localhost bypass would let any local process start a sign-in,
 *    read the link/code and swap the service account;
 *  - a present foreign `Origin` or `Origin: null` → 403; no Origin (the CLI,
 *    same-origin GET) passes — browsers always send Origin cross-site;
 *  - POST bodies only as `application/json` (a `text/plain` form POST is a
 *    "simple" cross-site request without preflight);
 *  - `Cache-Control: no-store` on every response.
 * A provider refusing the sign-in is `200` + `state: "failed"`, never 401/403
 * (the browser reads those as "Aura login expired").
 */

/** A finished attempt stays readable (without secrets) this long, then GET returns null. */
export const LOGIN_RESULT_VISIBLE_MS = 2 * 60_000;

export type LoginRegistry = Pick<LoginAttempts, "start" | "current" | "submitCode" | "cancel" | "endedAt">;

export interface LoginRoutesDeps {
  attempts: () => LoginRegistry;
  /** Startup recovery (promotion journal → orphan sweep) must finish before a start. */
  ready?: () => Promise<void>;
  /** Override for tests; production checks the Bearer header or the `companion_auth` cookie. */
  hasAuraToken?: (c: Context) => boolean;
  /** Override for tests; production reads `COMPANION_ALLOWED_ORIGIN`. */
  allowedOrigins?: ReadonlySet<string>;
  now?: () => number;
  /** Live sessions vs this sign-in (phase 2d): barrier waits, relaunches, Retry. Null = no renewal wired. */
  renewalSummary?: (provider: ProviderId) => SessionRenewalCounts | null;
}

/** REST shape of an attempt. Built in ONE place: secrets only while `awaiting_user`. */
export interface RestLoginAttempt {
  id: string;
  provider: ProviderId;
  state: LoginAttempt["state"];
  version: number;
  startedAt: number;
  expiresAt: number;
  failure: LoginAttempt["failure"];
  codeError: LoginAttempt["codeError"];
  submitting: boolean;
  submissionsLeft: number;
  steps: { replyCode: boolean; deviceCode: boolean };
  /** Link (and Codex device code) — present only while `awaiting_user`. */
  prompt?: { url: string; userCode?: string; expiresInMinutes?: number };
  result: LoginAttempt["result"];
  /** While verifying / after success: what the live sessions do (counts only). */
  renewal?: SessionRenewalCounts;
}

export function toRestLoginAttempt(a: LoginAttempt, maxSubmissions: number): RestLoginAttempt {
  const view: RestLoginAttempt = {
    id: a.id,
    provider: a.provider,
    state: a.state,
    version: a.version,
    startedAt: a.startedAt,
    expiresAt: a.expiresAt,
    failure: a.failure,
    codeError: a.codeError,
    submitting: a.submitting,
    submissionsLeft: Math.max(0, maxSubmissions - a.submissions),
    steps: signInSteps(a.provider),
    result: a.result,
  };
  if (a.state === "awaiting_user" && a.prompt) {
    // Whitelist the fields: the Claude `state` nonce lives in the URL already
    // and is never echoed on its own.
    view.prompt = a.prompt.provider === "codex"
      ? { url: a.prompt.url, userCode: a.prompt.userCode, expiresInMinutes: a.prompt.expiresInMinutes }
      : { url: a.prompt.url };
  }
  return view;
}

function isProviderId(value: string): value is ProviderId {
  return (PROVIDER_IDS as readonly string[]).includes(value);
}

function defaultHasAuraToken(c: Context): boolean {
  const header = c.req.header("Authorization");
  const bearer = header?.startsWith("Bearer ") ? header.slice(7) : null;
  return verifyToken(bearer) || verifyToken(getCookie(c, "companion_auth") ?? null);
}

/**
 * Origin rule for the sign-in routes: absent → allowed (CLI, same-origin GET);
 * `null` → refused; the request's own origin (e.g. a tab on
 * `http://localhost:3456`), the dev frontend and `COMPANION_ALLOWED_ORIGIN` →
 * allowed; anything else → refused.
 */
export function loginOriginAllowed(origin: string | undefined, requestUrl: string, allowed?: ReadonlySet<string>): boolean {
  if (origin === undefined) return true;
  if (origin === "null") return false;
  let own: string | null = null;
  try {
    own = new URL(requestUrl).origin;
  } catch {
    own = null;
  }
  if (own !== null && origin === own) return true;
  return isOriginAllowed({ origin, localhost: false, allowedOriginsOverride: allowed });
}

function isJsonContentType(value: string | undefined): boolean {
  return (value ?? "").split(";")[0].trim().toLowerCase() === "application/json";
}

function loginGuard(deps: LoginRoutesDeps): MiddlewareHandler {
  const hasToken = deps.hasAuraToken ?? defaultHasAuraToken;
  return async (c, next) => {
    c.header("Cache-Control", "no-store");
    if (!hasToken(c)) {
      logRoute("refused", { why: "token" });
      return c.json({ error: "unauthorized" }, 401);
    }
    if (!loginOriginAllowed(c.req.header("Origin"), c.req.url, deps.allowedOrigins)) {
      logRoute("refused", { why: "origin" });
      return c.json({ error: "origin_not_allowed" }, 403);
    }
    if (c.req.method === "POST" && !isJsonContentType(c.req.header("Content-Type"))) {
      logRoute("refused", { why: "content_type" });
      return c.json({ error: "json_required" }, 415);
    }
    await next();
    c.header("Cache-Control", "no-store");
  };
}

/** Structured, secret-free (EC-23): provider, 8 chars of the id, state, reason. */
function logRoute(action: string, fields: Record<string, string | number | undefined>): void {
  const event = `llm_auth.login.${action}`;
  log.info("llm-login", event, { event, ...fields });
}

function attemptFields(a: LoginAttempt | null | undefined): Record<string, string | undefined> {
  return a ? { provider: a.provider, attempt: a.id.slice(0, 8), state: a.state, reason: a.failure ?? undefined } : {};
}

async function readJson(c: Context): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await c.req.json();
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function registerLoginRoutes(api: Hono, deps: LoginRoutesDeps, maxSubmissions: number): void {
  const now = deps.now ?? Date.now;
  const view = (a: LoginAttempt): RestLoginAttempt => {
    const v = toRestLoginAttempt(a, maxSubmissions);
    if (a.state === "verifying" || a.state === "succeeded") {
      const renewal = deps.renewalSummary?.(a.provider) ?? null;
      if (renewal) v.renewal = renewal;
    }
    return v;
  };

  /** The attempt GET shows: the running one, or a finished one for LOGIN_RESULT_VISIBLE_MS. */
  const visible = (provider: ProviderId): LoginAttempt | null => {
    const a = deps.attempts().current(provider);
    if (!a || !isTerminalLoginState(a.state)) return a;
    const ended = deps.attempts().endedAt(a.id);
    return ended !== null && now() - ended > LOGIN_RESULT_VISIBLE_MS ? null : a;
  };

  api.use("/llm-auth/login/*", loginGuard(deps));

  api.post("/llm-auth/login/:provider", async (c) => {
    const provider = c.req.param("provider");
    if (!isProviderId(provider)) return c.json({ error: "unknown provider" }, 400);
    await deps.ready?.();
    const result = await deps.attempts().start(provider);
    logRoute("start", { ...attemptFields("attempt" in result ? result.attempt : null), provider, result: result.kind });
    switch (result.kind) {
      case "started":
        return c.json({ attempt: view(result.attempt), existing: false }, 201);
      case "existing":
        return c.json({ attempt: view(result.attempt), existing: true }, 200);
      case "refused":
        return c.json({ attempt: view(result.attempt), existing: false }, 200);
      case "cooldown":
        c.header("Retry-After", String(Math.ceil(result.retryAfterMs / 1000)));
        return c.json({ error: "cooldown", retryAfterMs: result.retryAfterMs, attempt: result.attempt ? view(result.attempt) : null }, 429);
      default: {
        const never: never = result;
        return never;
      }
    }
  });

  api.get("/llm-auth/login/:provider", (c) => {
    const provider = c.req.param("provider");
    if (!isProviderId(provider)) return c.json({ error: "unknown provider" }, 400);
    const a = visible(provider);
    return c.json({ attempt: a ? view(a) : null });
  });

  /** Resolves `:provider/:attemptId` to the provider's current attempt, or an error response. */
  const target = (c: Context): { provider: ProviderId; attemptId: string } | Response => {
    const provider = c.req.param("provider") ?? "";
    const attemptId = c.req.param("attemptId") ?? "";
    if (!isProviderId(provider)) return c.json({ error: "unknown provider" }, 400);
    if (!ATTEMPT_ID_PATTERN.test(attemptId)) return c.json({ error: "invalid attempt id" }, 400);
    const current = deps.attempts().current(provider);
    if (!current || current.id !== attemptId) {
      logRoute("stale_attempt", { provider, attempt: attemptId.slice(0, 8) });
      return c.json({ error: "attempt_mismatch", attempt: current ? view(current) : null }, 409);
    }
    return { provider, attemptId };
  };

  api.post("/llm-auth/login/:provider/:attemptId/code", async (c) => {
    const t = target(c);
    if (t instanceof Response) return t;
    if (!signInSteps(t.provider).replyCode) return c.json({ error: "no_code_step" }, 400);
    const body = await readJson(c);
    const code = body?.code;
    if (typeof code !== "string" || code.length === 0 || code.length > MAX_REPLY_CODE_LENGTH) {
      return c.json({ error: "code must be a non-empty string" }, 400);
    }
    const result = await deps.attempts().submitCode(t.provider, t.attemptId, code);
    logRoute("code", { ...attemptFields("attempt" in result ? result.attempt : null), provider: t.provider, result: result.kind });
    switch (result.kind) {
      case "submitted":
        return c.json({ attempt: view(result.attempt) });
      case "refused":
        // The attempt goes on; the window shows `codeError`.
        return c.json({ attempt: view(result.attempt), refused: result.reason });
      case "not_applicable":
        return c.json({ error: "no_code_step" }, 400);
      case "not_awaiting":
        return c.json({ error: "not_awaiting", attempt: result.attempt ? view(result.attempt) : null }, 409);
      case "busy":
        return c.json({ error: "busy", attempt: view(result.attempt) }, 409);
      case "limit":
        return c.json({ error: "limit", attempt: view(result.attempt) }, 429);
      default: {
        const never: never = result;
        return never;
      }
    }
  });

  api.post("/llm-auth/login/:provider/:attemptId/cancel", async (c) => {
    const t = target(c);
    if (t instanceof Response) return t;
    const a = await deps.attempts().cancel(t.provider, t.attemptId);
    logRoute("cancel", { ...attemptFields(a), provider: t.provider });
    return c.json({ attempt: a ? view(a) : null });
  });
}
