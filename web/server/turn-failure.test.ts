/**
 * Unit tests for the turn-failure classifier (LLM auth phase 1, task 10).
 *
 * The classifier only sees protocol-frame fields. These tests pin the
 * ordering (network before auth, version before auth, auth before limits),
 * the structured-first window mapping, Codex parity, and the negative space:
 * plain 5xx / transient 429 / unknown errors stay `unclassified` so the
 * model-fallback path keeps owning them. The end-to-end replay through the
 * real adapters lives in `session-failure.replay.test.ts`.
 */
import { describe, expect, it } from "vitest";
import {
  classifyClaudeTurnFailure,
  classifyCodexTurnFailure,
  type ClaudeTurnSignal,
  type CodexClassifyContext,
} from "./turn-failure.js";

const NOW = Date.UTC(2026, 10, 14, 12, 0, 0);

function claude(partial: Partial<ClaudeTurnSignal>): ClaudeTurnSignal {
  return { apiErrorStatus: null, resultText: "", errors: [], assistantError: null, rateLimit: null, lastRetry: null, ...partial };
}

function rateLimit(over: Partial<NonNullable<ClaudeTurnSignal["rateLimit"]>>): NonNullable<ClaudeTurnSignal["rateLimit"]> {
  return {
    rejected: true, resetAt: NOW + 3_600_000, limitType: "five_hour",
    isUsingOverage: false, overageRejected: false, fiveHourUtilization: 1, sevenDayUtilization: 0.2, ...over,
  };
}

const ctx = (over: Partial<CodexClassifyContext> = {}): CodexClassifyContext => ({
  rateLimits: null, credentialGeneration: () => "same", now: NOW, ...over,
});

describe("classifyClaudeTurnFailure", () => {
  it("401 → auth_rejected with the provider's text", () => {
    const r = classifyClaudeTurnFailure(claude({ apiErrorStatus: 401, resultText: "API Error: 401 invalid x-api-key", assistantError: "authentication_failed" }), NOW);
    expect(r).toEqual({ kind: "classified", failure: expect.objectContaining({ kind: "auth_rejected", provider: "claude", providerMessage: "API Error: 401 invalid x-api-key" }) });
  });

  it("403 org-disabled (no model wording) → auth_rejected; Claude never reports a stale copy", () => {
    const r = classifyClaudeTurnFailure(claude({ apiErrorStatus: 403, resultText: "Your organization has disabled Claude subscription access for Claude Code", assistantError: "oauth_org_not_allowed" }), NOW);
    expect(r.kind === "classified" && r.failure.kind).toBe("auth_rejected");
    expect(r.kind === "classified" && r.failure.credentialsCompared).toBe(true);
  });

  it("403 about a model stays unclassified (model-fallback path owns it)", () => {
    const r = classifyClaudeTurnFailure(claude({ apiErrorStatus: 403, resultText: "Your plan does not include access to model claude-x", assistantError: "model_not_found" }), NOW);
    expect(r.kind).toBe("unclassified");
  });

  it("'version X or newer is required' → cli_outdated with that version", () => {
    const r = classifyClaudeTurnFailure(claude({ apiErrorStatus: 400, resultText: "API Error: 400 claude-code 2.1.278 does not support this model; version 2.1.280 or newer is required" }), NOW);
    expect(r).toEqual({ kind: "classified", failure: expect.objectContaining({ kind: "cli_outdated", requiredVersion: "2.1.280" }) });
  });

  it("network: no status + connection error text → network, checked before auth", () => {
    const r = classifyClaudeTurnFailure(claude({ resultText: "API Error: Connection error.", assistantError: "unknown" }), NOW);
    expect(r.kind === "classified" && r.failure.kind).toBe("network");
  });

  it("network: no status, last api_retry had no status and no error tag", () => {
    const r = classifyClaudeTurnFailure(claude({ resultText: "API Error", lastRetry: { errorStatus: null } }), NOW);
    expect(r.kind === "classified" && r.failure.kind).toBe("network");
  });

  it("rejected five_hour rate_limit_event → limit_window five_hour with the structured reset", () => {
    const r = classifyClaudeTurnFailure(claude({ apiErrorStatus: 429, resultText: "You've hit your session limit · resets 1pm (UTC)", assistantError: "rate_limit", rateLimit: rateLimit({}) }), NOW);
    expect(r).toEqual({ kind: "classified", failure: expect.objectContaining({ kind: "limit_window", window: "five_hour", resetAt: NOW + 3_600_000 }) });
  });

  it("seven_day_* types map to seven_day", () => {
    const r = classifyClaudeTurnFailure(claude({ apiErrorStatus: 429, resultText: "You've hit your weekly limit", rateLimit: rateLimit({ limitType: "seven_day_opus" }) }), NOW);
    expect(r.kind === "classified" && r.failure.window).toBe("seven_day");
  });

  it("overage type with windows not exhausted → extra_usage_exhausted + model_outside_plan", () => {
    const r = classifyClaudeTurnFailure(claude({
      apiErrorStatus: 429, resultText: "You're out of extra usage · resets Nov 20",
      rateLimit: rateLimit({ limitType: "seven_day_overage_included", fiveHourUtilization: 0.03, sevenDayUtilization: 0.4, overageRejected: true }),
    }), NOW);
    expect(r).toEqual({ kind: "classified", failure: expect.objectContaining({ kind: "extra_usage_exhausted", window: "extra_usage", likelyCause: "model_outside_plan" }) });
  });

  it("extra usage with an exhausted window does not blame the model", () => {
    const r = classifyClaudeTurnFailure(claude({ apiErrorStatus: 429, resultText: "You're out of extra usage", rateLimit: rateLimit({ limitType: "overage", fiveHourUtilization: 1 }) }), NOW);
    expect(r.kind === "classified" && r.failure.likelyCause).toBeUndefined();
  });

  it("limit text without any reset → resetAt null (no guessed fallback)", () => {
    const r = classifyClaudeTurnFailure(claude({ apiErrorStatus: 429, resultText: "You've hit your usage limit" }), NOW);
    expect(r.kind === "classified" && r.failure.resetAt).toBeNull();
  });

  it("transient 429 / 5xx with no limit signal → unclassified", () => {
    // A throttle with no rejected window and no limit wording is transient, not a window.
    expect(classifyClaudeTurnFailure(claude({ apiErrorStatus: 429, resultText: "API Error: 429 Too Many Requests", assistantError: "rate_limit" }), NOW).kind).toBe("unclassified");
    expect(classifyClaudeTurnFailure(claude({ apiErrorStatus: 529, resultText: "API Error: Overloaded", assistantError: "overloaded" }), NOW).kind).toBe("unclassified");
    expect(classifyClaudeTurnFailure(claude({ apiErrorStatus: 500, resultText: "API Error: 500 Internal server error" }), NOW).kind).toBe("unclassified");
  });

  it("provider text is clipped to 500 chars", () => {
    const r = classifyClaudeTurnFailure(claude({ apiErrorStatus: 401, resultText: "x".repeat(2000) }), NOW);
    expect(r.kind === "classified" && r.failure.providerMessage.length).toBe(501);
  });
});

describe("classifyCodexTurnFailure", () => {
  it("id-less JSON-RPC 401 → auth_rejected", () => {
    const r = classifyCodexTurnFailure({ source: "idless_error", code: 401, message: "Unauthorized" }, ctx());
    expect(r.kind === "classified" && r.failure).toMatchObject({ kind: "auth_rejected", provider: "codex", credentialsCompared: true });
  });

  it("codexErrorInfo unauthorized + renewed primary → stale_session_credentials", () => {
    const r = classifyCodexTurnFailure(
      { source: "error_notification", message: "refresh token was already used", codexErrorInfo: "unauthorized", willRetry: false },
      ctx({ credentialGeneration: () => "renewed" }),
    );
    expect(r.kind === "classified" && r.failure.kind).toBe("stale_session_credentials");
  });

  it("generation not comparable → auth_rejected marked credentialsCompared:false", () => {
    const r = classifyCodexTurnFailure(
      { source: "error_notification", message: "x", codexErrorInfo: "unauthorized", willRetry: false },
      ctx({ credentialGeneration: () => "incomparable" }),
    );
    expect(r.kind === "classified" && r.failure).toMatchObject({ kind: "auth_rejected", credentialsCompared: false });
  });

  it("httpConnectionFailed without a status → network; with 401 → auth", () => {
    const net = classifyCodexTurnFailure({ source: "error_notification", message: "stream error", codexErrorInfo: { httpConnectionFailed: { httpStatusCode: null } }, willRetry: false }, ctx());
    expect(net.kind === "classified" && net.failure.kind).toBe("network");
    const auth = classifyCodexTurnFailure({ source: "error_notification", message: "x", codexErrorInfo: { responseStreamConnectionFailed: { httpStatusCode: 401 } }, willRetry: false }, ctx());
    expect(auth.kind === "classified" && auth.failure.kind).toBe("auth_rejected");
  });

  it("usageLimitExceeded with an exhausted 300-min primary → limit_window five_hour", () => {
    const r = classifyCodexTurnFailure(
      { source: "error_notification", message: "You've hit your usage limit.", codexErrorInfo: "usageLimitExceeded", willRetry: false },
      ctx({ rateLimits: { primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: NOW + 60_000 }, secondary: { usedPercent: 10, windowDurationMins: 10080, resetsAt: NOW + 9e8 } } }),
    );
    expect(r.kind === "classified" && r.failure).toMatchObject({ kind: "limit_window", window: "five_hour", resetAt: NOW + 60_000 });
  });

  it("a retried error is not classified", () => {
    const r = classifyCodexTurnFailure({ source: "error_notification", message: "x", codexErrorInfo: "unauthorized", willRetry: true }, ctx());
    expect(r.kind).toBe("unclassified");
  });

  it("Codex never yields cli_outdated / extra_usage_exhausted (no such frame in 0.162.1)", () => {
    const r = classifyCodexTurnFailure({ source: "error_notification", message: "requires a newer version; out of extra usage", codexErrorInfo: "badRequest", willRetry: false }, ctx());
    expect(r.kind).toBe("unclassified");
  });

  it("an id-less error that is not about auth stays unclassified", () => {
    expect(classifyCodexTurnFailure({ source: "idless_error", code: -32600, message: "Not initialized" }, ctx()).kind).toBe("unclassified");
  });
});
