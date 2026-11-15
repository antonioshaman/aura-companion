import { describe, expect, it } from "vitest";
import {
  describeSessionRenewal,
  describeSessionReconnecting,
  describeSessionReconnectFailed,
  describeAuthState,
  describeDoctorClear,
  describeDoctorFinding,
  describeDoctorUnchecked,
  doctorPlaceLabel,
  describeNotVerified,
  describeTurnFailure,
  describeUsageLimitsReason,
  describeLimitsPending,
  describeEffectiveMethod,
  describeLoginAttempt,
  describeLoginFailure,
  describeManualSignIn,
  describePlanCheck,
  formatAction,
  formatKnown,
  providerLabel,
  signInSteps,
  verifiedByLabel,
  turnFailureFacts,
  usageWindowLabel,
} from "./auth-catalog.js";
import {
  DOCTOR_FINDING_KINDS,
  DOCTOR_PLACE_CLASSES,
  DOCTOR_UNCHECKED_REASONS,
  EFFECTIVE_AUTH_SOURCES,
  LOGIN_ATTEMPT_STATES,
  LOGIN_FAILURE_REASONS,
  PLAN_CHECKS,
  NOT_VERIFIED_REASONS,
  PROVIDER_AUTH_STATES,
  PROVIDER_IDS,
  TURN_FAILURE_KINDS,
  USAGE_LIMITS_REASONS,
  USAGE_WINDOWS,
  knownField,
  unknownField,
} from "./auth-types.js";

// The catalog is the single text source for UI and CLI. Exhaustiveness is a
// compile-time guarantee (assertNever); these tests add the runtime half:
// every vocabulary value of every union yields non-empty text for BOTH
// providers (Codex parity), and the actions that the spec demands are wired.

describe("auth catalog", () => {
  it("has non-empty text for every state × reason × provider", () => {
    for (const provider of PROVIDER_IDS) {
      for (const state of PROVIDER_AUTH_STATES) {
        const entry = describeAuthState(state, provider);
        expect(entry.title.length).toBeGreaterThan(0);
        expect(entry.detail.length).toBeGreaterThan(0);
      }
      for (const reason of NOT_VERIFIED_REASONS) {
        expect(describeNotVerified(reason, provider).detail.length).toBeGreaterThan(0);
      }
      for (const kind of DOCTOR_FINDING_KINDS) {
        expect(describeDoctorFinding(kind, provider).title.length).toBeGreaterThan(0);
      }
      for (const kind of TURN_FAILURE_KINDS) {
        expect(describeTurnFailure(kind, provider).title.length).toBeGreaterThan(0);
      }
    }
    for (const reason of USAGE_LIMITS_REASONS) {
      expect(describeUsageLimitsReason(reason).title.length).toBeGreaterThan(0);
    }
  });

  it("S1-AC2: invalid credentials carry a sign-in action for the same provider", () => {
    const claude = describeAuthState("invalid", "claude");
    expect(claude.action).toEqual({ kind: "sign_in", provider: "claude" });
    expect(formatAction(claude.action)).toContain("docs/deploy/vps-systemd.mdx");
    expect(describeAuthState("invalid", "codex").action).toEqual({ kind: "sign_in", provider: "codex" });
  });

  it("S1-AC3: no_network is a retry, never a relogin (not 'expired')", () => {
    const entry = describeAuthState("no_network", "claude");
    expect(entry.action.kind).toBe("retry");
    expect(entry.title).not.toMatch(/expired|invalid/i);
  });

  it("not_verified text follows its reason", () => {
    expect(describeAuthState("not_verified", "codex", "token_expired_locally").title).toMatch(/expired locally/);
    expect(describeAuthState("not_verified", "claude", "cli_version_unproven").detail).toMatch(/not proven/);
  });

  it("S4: usage reasons name auth / api-key cases distinctly", () => {
    expect(describeUsageLimitsReason("auth_invalid").title).toMatch(/sign-in is invalid/);
    // Phase 2c: the limits panel offers the sign-in window directly (same action as the turn-failure card).
    expect(describeUsageLimitsReason("auth_invalid").action).toEqual({ kind: "sign_in", provider: "claude" });
    expect(describeUsageLimitsReason("no_credentials").action).toEqual({ kind: "sign_in", provider: "claude" });
    expect(describeUsageLimitsReason("api_key_login").detail).toMatch(/API key/);
  });

  it("renders unknown fields as the word 'unknown', never blank", () => {
    expect(formatKnown(unknownField)).toBe("unknown");
    expect(formatKnown(knownField("max"))).toBe("max");
    expect(formatKnown(knownField(0), (n) => `t=${n}`)).toBe("t=0");
  });

  it("has doctor text for every unchecked reason × check × provider, every place, and the all-clear line", () => {
    // Doctor output (CLI + Diagnostics) renders only through these; "not checked"
    // must never read like "nothing found" (EC-17 fail-closed wording).
    for (const provider of PROVIDER_IDS) {
      expect(describeDoctorClear(provider).title).toContain("no problems found");
      for (const reason of DOCTOR_UNCHECKED_REASONS) {
        for (const check of ["binary", "cli_version", "credential_copies", "credential_access"] as const) {
          const entry = describeDoctorUnchecked(check, reason, provider);
          expect(entry.title).toContain("not checked");
          expect(entry.detail.length).toBeGreaterThan(0);
        }
      }
    }
    for (const place of DOCTOR_PLACE_CLASSES) expect(doctorPlaceLabel(place).length).toBeGreaterThan(0);
  });

  // Task 14: the turn-failure card's secondary lines come from the catalog
  // too, so the card has no free-text of its own (one text source for UI/CLI).
  it("has a label for every usage window", () => {
    for (const w of USAGE_WINDOWS) expect(usageWindowLabel(w).length).toBeGreaterThan(0);
  });

  it("turnFailureFacts names the window + reset, likely cause, uncompared credentials and required version", () => {
    const at = (ms: number) => `T${ms}`;
    expect(
      turnFailureFacts({ kind: "limit_window", provider: "claude", providerMessage: "x", window: "five_hour", resetAt: 42 }, at),
    ).toEqual(["Window: 5-hour window · resets T42"]);
    // A limit failure without a known reset says so instead of going blank.
    expect(
      turnFailureFacts({ kind: "limit_window", provider: "codex", providerMessage: "x", window: "seven_day", resetAt: null }, at),
    ).toEqual(["Window: 7-day window · reset time unknown"]);
    expect(
      turnFailureFacts(
        { kind: "extra_usage_exhausted", provider: "claude", providerMessage: "x", window: "extra_usage", resetAt: 7, likelyCause: "model_outside_plan" },
        at,
      ),
    ).toEqual(["Window: extra usage · resets T7", "Likely cause: the selected model is not included in the plan."]);
    expect(
      turnFailureFacts({ kind: "auth_rejected", provider: "codex", providerMessage: "x", credentialsCompared: false }, at),
    ).toEqual(["Could not compare this session's credentials with the main sign-in."]);
    expect(turnFailureFacts({ kind: "cli_outdated", provider: "claude", providerMessage: "x", requiredVersion: "2.1.280" }, at)).toEqual([
      "Required CLI version: 2.1.280 or newer",
    ]);
    expect(turnFailureFacts({ kind: "cli_outdated", provider: "claude", providerMessage: "x", requiredVersion: null }, at)).toEqual([
      "Required CLI version: unknown",
    ]);
    // Network / compared auth failures carry no extra facts.
    expect(turnFailureFacts({ kind: "network", provider: "codex", providerMessage: "x" }, at)).toEqual([]);
    expect(turnFailureFacts({ kind: "auth_rejected", provider: "claude", providerMessage: "x", credentialsCompared: true }, at)).toEqual([]);
  });

  it("names the 'no limit data yet' state for both providers (Codex parity for the limits panel)", () => {
    for (const provider of PROVIDER_IDS) {
      const entry = describeLimitsPending(provider);
      expect(entry.title).toMatch(/^No data yet/);
      expect(entry.detail.length).toBeGreaterThan(0);
    }
  });
});

describe("formatAction", () => {
  // Every action kind renders to the exact CLI/UI line — UI and CLI both go through
  // this one function (S1-AC5 "same texts"), so each branch is pinned here. "none"
  // renders empty so callers can omit the action row instead of printing a blank hint.
  it("renders each action kind", () => {
    // Until the in-UI sign-in panel ships (phase 2c), a sign_in action renders the
    // manual instruction — the same text the CLI fallback and macOS (D6) print.
    expect(formatAction({ kind: "sign_in", provider: "claude" })).toBe(
      "Sign in again as the service user: `claude auth login` (see docs/deploy/vps-systemd.mdx#prerequisites)",
    );
    expect(formatAction({ kind: "sign_in", provider: "codex" })).toBe(
      "Sign in again as the service user: `codex login --device-auth` (see docs/deploy/vps-systemd.mdx#prerequisites)",
    );
    // Phase 2b: the CLI surface points at the server sign-in command instead.
    expect(formatAction({ kind: "sign_in", provider: "claude" }, "cli")).toBe("Sign in again: `aura-companion auth login claude`");
    expect(formatAction({ kind: "sign_in", provider: "codex" }, "cli")).toBe("Sign in again: `aura-companion auth login codex`");
    expect(formatAction({ kind: "retry" }, "cli")).toBe("Retry");
    expect(formatAction({ kind: "retry" })).toBe("Retry");
    expect(formatAction({ kind: "restart_session" })).toBe("Restart the session");
    expect(formatAction({ kind: "update_cli", command: "claude update" })).toBe("Update the CLI: `claude update`");
    expect(formatAction({ kind: "run_as_service_user" })).toBe("Run as the service user");
    expect(formatAction({ kind: "open_status" })).toBe("Open provider status");
    expect(formatAction({ kind: "none" })).toBe("");
  });

  it("formats every catalog action without throwing, for both providers", () => {
    // Sweep: every entry the catalog can produce must format (no unhandled action
    // kind), and actionable entries must yield a non-empty hint.
    for (const provider of PROVIDER_IDS) {
      const entries = [
        ...PROVIDER_AUTH_STATES.map((s) => describeAuthState(s, provider)),
        ...NOT_VERIFIED_REASONS.map((r) => describeNotVerified(r, provider)),
        ...DOCTOR_FINDING_KINDS.map((k) => describeDoctorFinding(k, provider)),
        ...TURN_FAILURE_KINDS.map((k) => describeTurnFailure(k, provider)),
        ...USAGE_LIMITS_REASONS.map((r) => describeUsageLimitsReason(r)),
      ];
      for (const entry of entries) {
        const line = formatAction(entry.action);
        expect(entry.action.kind === "none" ? line === "" : line.length > 0).toBe(true);
      }
    }
  });
});

// ─── Phase 2: sign-in vocabulary (plan task 2) ───────────────────────────────
// Every attempt state, failure reason, plan-check verdict and effective-method
// source yields non-empty text for BOTH providers (Codex parity). The reply-code
// step exists only for Claude; Codex shows a device code instead — the catalog
// is the one place that says so, and the UI/CLI read it from here.
describe("sign-in catalog", () => {
  it("has non-empty text for every attempt state × failure reason × provider", () => {
    for (const provider of PROVIDER_IDS) {
      for (const state of LOGIN_ATTEMPT_STATES) {
        const entry = describeLoginAttempt(state, provider);
        expect(entry.title.length, `${provider}/${state}`).toBeGreaterThan(0);
        expect(entry.detail.length, `${provider}/${state}`).toBeGreaterThan(0);
        expect(entry.title).toContain(providerLabel(provider));
      }
      for (const reason of LOGIN_FAILURE_REASONS) {
        const entry = describeLoginFailure(reason, provider);
        expect(entry.title.length, `${provider}/${reason}`).toBeGreaterThan(0);
        expect(entry.detail.length, `${provider}/${reason}`).toBeGreaterThan(0);
        expect(formatAction(entry.action).length >= 0).toBe(true);
      }
      for (const check of PLAN_CHECKS) {
        expect(describePlanCheck(check, provider, "Max", knownField("pro")).title.length).toBeGreaterThan(0);
      }
      for (const source of EFFECTIVE_AUTH_SOURCES) {
        const entry = describeEffectiveMethod({ method: "subscription", source, variable: "SOME_VAR" }, provider);
        expect(entry.title.length, `${provider}/${source}`).toBeGreaterThan(0);
      }
      expect(describeManualSignIn(provider).detail).toContain(provider === "claude" ? "claude auth login" : "codex login --device-auth");
    }
  });

  it("S1-AC1: only Claude asks for a reply code; only Codex shows a device code", () => {
    expect(signInSteps("claude")).toEqual({ replyCode: true, deviceCode: false });
    expect(signInSteps("codex")).toEqual({ replyCode: false, deviceCode: true });
    // The awaiting-user text follows the same split.
    expect(describeLoginAttempt("awaiting_user", "claude").detail).toMatch(/paste the code/i);
    expect(describeLoginAttempt("awaiting_user", "codex").detail).toMatch(/enter the code/i);
    expect(describeLoginAttempt("awaiting_user", "codex").detail).not.toMatch(/paste/i);
  });

  it("S1-AC3: rejected, malformed, foreign and expired codes all say 'invalid or expired' and offer to start again", () => {
    for (const provider of PROVIDER_IDS) {
      for (const reason of ["code_rejected", "code_format", "attempt_mismatch", "expired"] as const) {
        const entry = describeLoginFailure(reason, provider);
        expect(entry.title, reason).toMatch(/invalid or expired/i);
        expect(entry.action).toEqual({ kind: "sign_in", provider });
      }
    }
  });

  it("failures that a new attempt cannot fix carry their own action, never a sign-in loop", () => {
    expect(describeLoginFailure("cli_missing", "codex").action.kind).toBe("update_cli");
    expect(describeLoginFailure("wrong_service_user", "claude").action.kind).toBe("run_as_service_user");
    // macOS (D6): the UI cannot sign Claude in — the manual Terminal command is the way out.
    const mac = describeLoginFailure("unsupported_platform", "claude");
    expect(mac.action.kind).toBe("none");
    expect(mac.detail).toContain("claude auth login");
  });

  it("S2-AC1/AC3: mismatch shows both values; unknown never reads as a match", () => {
    const mismatch = describePlanCheck("mismatch", "claude", "Max", knownField("pro"));
    expect(mismatch.detail).toContain("Max");
    expect(mismatch.detail).toContain("pro");
    expect(mismatch.action).toEqual({ kind: "sign_in", provider: "claude" });
    const unknown = describePlanCheck("unknown", "codex", "Plus", unknownField);
    expect(unknown.title).toMatch(/not determined/i);
    expect(unknown.title).not.toMatch(/match/i);
    // S2-AC2: no expectation set → no warning, no action.
    const unset = describePlanCheck("unset", "claude", null, knownField("max"));
    expect(unset.action.kind).toBe("none");
    expect(unset.title).not.toMatch(/mismatch|warning/i);
  });

  it("S2-AC4: an overriding env/settings source names the variable and where it is set, never a value", () => {
    const env = describeEffectiveMethod({ method: "env_token", source: "environment", variable: "CLAUDE_CODE_OAUTH_TOKEN" }, "claude");
    expect(env.detail).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(env.detail).toMatch(/environment/i);
    const signIn = describeEffectiveMethod({ method: "subscription", source: "sign_in" }, "codex");
    expect(signIn.action.kind).toBe("none");
  });

  it("D5: Codex with a ChatGPT sign-in AND a key set → a neutral note that the sign-in is used, not an override", () => {
    const note = describeEffectiveMethod(
      { method: "subscription", source: "sign_in", alsoSet: { source: "settings", variable: "OPENAI_API_KEY" } },
      "codex",
    );
    expect(note.title).toMatch(/use the stored sign-in/i);
    expect(note.title).not.toMatch(/instead of/i);
    expect(note.detail).toContain("OPENAI_API_KEY");
    expect(note.detail).toMatch(/settings/i);
    expect(note.detail).toMatch(/sign-in is used/i);
  });

  it("verifiedBy labels cover provider, local and login", () => {
    expect(verifiedByLabel("provider")).toBe("with the provider");
    expect(verifiedByLabel("local")).toBe("local only");
    expect(verifiedByLabel("login")).toBe("by sign-in");
  });
});

describe("session renewal texts (phase 2d)", () => {
  // The sign-in window and the in-session notice. Counts only; singular /
  // plural agree; nothing to say → no line (no empty list).
  const none = { waitingForTurn: 0, reconnecting: 0, busyAtPromotion: 0, awaitingRetry: 0, credentialsReplaced: false };

  it("verifying: only the barrier wait, with the 10-minute bound", () => {
    expect(describeSessionRenewal("claude", none, "verifying")).toEqual([]);
    expect(describeSessionRenewal("claude", { ...none, waitingForTurn: 1 }, "verifying")[0].text).toBe(
      "Waiting for 1 session to finish the current turn before switching Claude to the new sign-in (at most 10 minutes).",
    );
  });

  it("succeeded: moves + Retry in one line, warnings separate and flagged", () => {
    expect(describeSessionRenewal("codex", none, "succeeded")).toEqual([]);
    const lines = describeSessionRenewal("codex", { ...none, reconnecting: 1, awaitingRetry: 2, busyAtPromotion: 1, credentialsReplaced: true }, "succeeded");
    expect(lines.map((l) => l.warning)).toEqual([false, true, true]);
    expect(lines[0].text).toBe("1 session will move to the new sign-in; 2 sessions wait for Retry.");
    expect(lines[1].text).toBe("1 session was still busy; the sign-in is switched after the turn ends.");
  });

  it("in-session notices name the provider and promise no automatic re-send", () => {
    for (const p of ["claude", "codex"] as const) {
      expect(describeSessionReconnecting(p).detail).toContain("Nothing is re-sent on its own");
      expect(describeSessionReconnectFailed(p).title).toBe("Could not reconnect with the new sign-in");
    }
  });
});
