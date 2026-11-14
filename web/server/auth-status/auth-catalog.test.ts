import { describe, expect, it } from "vitest";
import {
  describeAuthState,
  describeDoctorClear,
  describeDoctorFinding,
  describeDoctorUnchecked,
  doctorPlaceLabel,
  describeNotVerified,
  describeTurnFailure,
  describeUsageLimitsReason,
  describeLimitsPending,
  formatAction,
  formatKnown,
  turnFailureFacts,
  usageWindowLabel,
} from "./auth-catalog.js";
import {
  DOCTOR_FINDING_KINDS,
  DOCTOR_PLACE_CLASSES,
  DOCTOR_UNCHECKED_REASONS,
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

  it("S1-AC2: invalid credentials carry a relogin action with the manual instruction", () => {
    const claude = describeAuthState("invalid", "claude");
    expect(claude.action).toMatchObject({ kind: "relogin", command: "claude auth login" });
    expect(formatAction(claude.action)).toContain("docs/deploy/vps-systemd.mdx");
    expect(describeAuthState("invalid", "codex").action).toMatchObject({ kind: "relogin" });
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
    expect(describeUsageLimitsReason("auth_invalid").action.kind).toBe("open_status");
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
    expect(formatAction({ kind: "relogin", command: "claude auth login", docRef: "docs/x.mdx" })).toBe(
      "Sign in again as the service user: `claude auth login` (see docs/x.mdx)",
    );
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
