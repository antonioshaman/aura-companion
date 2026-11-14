import type { ProviderId, TurnFailure } from "./auth-status/auth-types.js";
import { REQUIRED_CLI_VERSIONS } from "./auth-status/doctor-checks.js";
import {
  claudeLimitWindow,
  codexWindowByDuration,
  isClaudeUsageLimitText,
  resolveClaudeUsageLimit,
  resolveCodexUsageLimit,
  type ClaudeOverageInfo,
  type ClaudeRateLimitInfo,
  type CodexRateLimitSnapshot,
} from "./usage-limit-parse.js";

/**
 * Turn-failure classifier (LLM auth phase 1, task 10). One pure function per
 * provider, called by the adapters on a failed turn. Input is PROTOCOL FRAMES
 * only: Claude's error `result` (+ the preceding synthetic assistant `error`
 * tag, `rate_limit_event`, `api_retry`), Codex's JSON-RPC errors and
 * `account/rateLimits`. Assistant text and tool output never reach it, so a
 * model or a Bash command printing "401 unauthorized" cannot fake a
 * "sign in again" card.
 *
 * Order: network before auth (a dead link is not a dead sign-in), then CLI
 * version, auth, limits. Anything else is `unclassified` and keeps today's
 * rendering; unknown frame shapes stay protocol drift in the adapters.
 */

export type TurnClassification =
  | { kind: "classified"; failure: TurnFailure }
  | { kind: "unclassified"; providerMessage: string };

/**
 * Whether the session's credentials are an older generation than the primary
 * sign-in (task 11). `renewed` = primary changed after the session took its
 * copy → stale session; `same` = the session uses the current primary;
 * `incomparable` = metadata unavailable.
 */
export type CredentialGenerationVerdict = "renewed" | "same" | "incomparable";

const PROVIDER_MESSAGE_MAX = 500;

function clip(text: string): string {
  const t = text.trim();
  return t.length > PROVIDER_MESSAGE_MAX ? `${t.slice(0, PROVIDER_MESSAGE_MAX)}…` : t;
}

function classified(failure: TurnFailure): TurnClassification {
  return { kind: "classified", failure: { ...failure, providerMessage: clip(failure.providerMessage) } };
}

function authFailure(provider: ProviderId, providerMessage: string, generation: CredentialGenerationVerdict): TurnClassification {
  if (generation === "renewed") {
    return classified({ kind: "stale_session_credentials", provider, providerMessage });
  }
  return classified({ kind: "auth_rejected", provider, providerMessage, credentialsCompared: generation === "same" });
}

// ─── Claude ───────────────────────────────────────────────────────────────────

/**
 * Claude CLI (2.1.283) closed enum on the synthetic assistant frame's `error`
 * field (`SDKAssistantMessageError`). Only the sign-in members are listed.
 */
const CLAUDE_AUTH_ERRORS = new Set(["authentication_failed", "oauth_org_not_allowed", "account_on_hold", "verification_required"]);

/** Transport-level failures the CLI reports with no HTTP status. */
const NETWORK_TEXT_RE =
  /\b(?:connection error|request timed out|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|socket hang up|fetch failed|unable to connect to api)\b/i;

const VERSION_REQUIRED_RE = /version\s+v?(\d+\.\d+\.\d+)\s+or\s+newer\s+is\s+required/i;
const NEWER_VERSION_RE = /requires?\s+(?:a\s+)?newer\s+version\s+of\s+claude\s+code|please\s+update\s+claude\s+code/i;

export interface ClaudeTurnSignal {
  /** `result.api_error_status`, null when absent. */
  apiErrorStatus: number | null;
  /** `result.result` of an `is_error` result (CLI-synthesised API error text). */
  resultText: string;
  errors: readonly string[];
  /** `error` tag of the synthetic assistant frame that preceded the result. */
  assistantError: string | null;
  /** Latest `rate_limit_event` of the turn (any status). */
  rateLimit: (ClaudeRateLimitInfo & ClaudeOverageInfo) | null;
  /** Latest `system/api_retry` of the turn. */
  lastRetry: { errorStatus: number | null } | null;
}

/** Claude sessions read the primary credentials file directly — never a stale copy. */
export function classifyClaudeTurnFailure(sig: ClaudeTurnSignal, now: number): TurnClassification {
  const text = [sig.resultText, ...sig.errors].filter((t) => t && t.trim()).join("\n");
  const providerMessage = text || "Claude reported an error without a message.";
  const status = sig.apiErrorStatus;

  if (status === null && (NETWORK_TEXT_RE.test(text) || (sig.lastRetry !== null && sig.lastRetry.errorStatus === null && !sig.assistantError))) {
    return classified({ kind: "network", provider: "claude", providerMessage });
  }

  const versionMatch = VERSION_REQUIRED_RE.exec(text);
  if (versionMatch || NEWER_VERSION_RE.test(text)) {
    return classified({
      kind: "cli_outdated",
      provider: "claude",
      providerMessage,
      requiredVersion: versionMatch?.[1] ?? REQUIRED_CLI_VERSIONS.claude,
    });
  }

  if (
    status === 401
    || (sig.assistantError !== null && CLAUDE_AUTH_ERRORS.has(sig.assistantError))
    // 403 is also the model-access refusal; that one stays with the model-fallback path.
    || (status === 403 && sig.assistantError !== "model_not_found" && !/\bmodel\b/i.test(text))
  ) {
    return authFailure("claude", providerMessage, "same");
  }

  const rl = sig.rateLimit;
  const rejected = rl?.rejected === true;
  if (rejected || isClaudeUsageLimitText(text)) {
    const window = claudeLimitWindow(rejected ? rl.limitType : null, rl?.isUsingOverage === true, text);
    const resolved = resolveClaudeUsageLimit({
      text,
      apiErrorStatus: status,
      lastRejected: rejected ? rl : null,
      now,
    });
    // Only a reset the frames actually stated; never the 5h guess.
    const resetAt = resolved && resolved.resetSource !== "fallback" ? resolved.resetAt : null;
    if (window === "extra_usage") {
      const roomLeft = (u: number | null) => u !== null && u < 1;
      const likely = rl !== null && roomLeft(rl.fiveHourUtilization) && roomLeft(rl.sevenDayUtilization);
      return classified({
        kind: "extra_usage_exhausted",
        provider: "claude",
        providerMessage,
        window,
        resetAt,
        ...(likely ? { likelyCause: "model_outside_plan" as const } : {}),
      });
    }
    return classified({ kind: "limit_window", provider: "claude", providerMessage, window, resetAt });
  }

  return { kind: "unclassified", providerMessage };
}

// ─── Codex ────────────────────────────────────────────────────────────────────

/** `CodexErrorInfo` members (codex 0.162.1) that mean "the request never got through". */
const CODEX_NETWORK_INFOS = new Set(["httpConnectionFailed", "responseStreamConnectionFailed", "responseStreamDisconnected"]);

const CODEX_AUTH_TEXT_RE = /\bunauthori[sz]ed\b|\brefresh token\b|\bsign in again\b|\blog in again\b|\b401\b/i;

export type CodexTurnSignal =
  /** JSON-RPC error with no request id (e.g. expired auth before any turn). */
  | { source: "idless_error"; code: number | string | null; message: string }
  /** v2 `error` notification. */
  | { source: "error_notification"; message: string; codexErrorInfo: unknown; willRetry: boolean };

function codexInfo(info: unknown): { name: string | null; httpStatus: number | null } {
  if (typeof info === "string") return { name: info, httpStatus: null };
  if (info && typeof info === "object" && !Array.isArray(info)) {
    const [name] = Object.keys(info as Record<string, unknown>);
    if (!name) return { name: null, httpStatus: null };
    const body = (info as Record<string, unknown>)[name];
    const status = body && typeof body === "object" ? (body as Record<string, unknown>).httpStatusCode : null;
    return { name, httpStatus: typeof status === "number" ? status : null };
  }
  return { name: null, httpStatus: null };
}

export interface CodexClassifyContext {
  rateLimits: CodexRateLimitSnapshot | null;
  /** Credential generation of this session vs the primary auth.json (task 11). */
  credentialGeneration: () => CredentialGenerationVerdict;
  now: number;
}

/**
 * Codex has no "version X required" frame and no extra-usage wallet signal in
 * 0.162.1 — `cli_outdated` / `extra_usage_exhausted` are never produced here
 * (pinned by tests) rather than guessed from text.
 */
export function classifyCodexTurnFailure(sig: CodexTurnSignal, ctx: CodexClassifyContext): TurnClassification {
  const providerMessage = sig.message.trim() || "Codex reported an error without a message.";

  if (sig.source === "idless_error") {
    if (sig.code === 401 || CODEX_AUTH_TEXT_RE.test(sig.message)) {
      return authFailure("codex", providerMessage, ctx.credentialGeneration());
    }
    return { kind: "unclassified", providerMessage };
  }

  // A retried error is not the end of the turn.
  if (sig.willRetry) return { kind: "unclassified", providerMessage };

  const { name, httpStatus } = codexInfo(sig.codexErrorInfo);
  if (name === "unauthorized" || httpStatus === 401) {
    return authFailure("codex", providerMessage, ctx.credentialGeneration());
  }
  if (name !== null && CODEX_NETWORK_INFOS.has(name) && httpStatus === null) {
    return classified({ kind: "network", provider: "codex", providerMessage });
  }

  const resolved = resolveCodexUsageLimit({
    message: sig.message,
    codexErrorInfo: sig.codexErrorInfo,
    rateLimits: ctx.rateLimits,
    now: ctx.now,
  });
  if (resolved) {
    const slot = resolved.limitType === "primary" || resolved.limitType === "secondary" ? ctx.rateLimits?.[resolved.limitType] : null;
    return classified({
      kind: "limit_window",
      provider: "codex",
      providerMessage,
      window: slot ? codexWindowByDuration(slot.windowDurationMins) : "unknown_window",
      resetAt: resolved.resetSource === "fallback" ? null : resolved.resetAt,
    });
  }

  return { kind: "unclassified", providerMessage };
}
