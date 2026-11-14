import { describe, expect, it } from "vitest";
import {
  describeAuthState,
  describeDoctorFinding,
  describeNotVerified,
  describeTurnFailure,
  describeUsageLimitsReason,
  formatAction,
  formatKnown,
} from "./auth-catalog.js";
import {
  DOCTOR_FINDING_KINDS,
  NOT_VERIFIED_REASONS,
  PROVIDER_AUTH_STATES,
  PROVIDER_IDS,
  TURN_FAILURE_KINDS,
  USAGE_LIMITS_REASONS,
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
});
