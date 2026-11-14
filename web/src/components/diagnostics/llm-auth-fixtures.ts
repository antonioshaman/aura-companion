import type { StatusSnapshot } from "../../../server/auth-status/status-core.js";
import {
  knownField,
  unknownField,
  type DoctorBinary,
  type DoctorReport,
  type ProviderAuthStatus,
} from "../../../server/auth-status/auth-types.js";

/**
 * Synthetic LLM-auth payloads in the REST shape (home-relative paths, no
 * absPath, no secrets) for the LlmAuthCard tests and the Playground.
 */

export const LLM_AUTH_NOW = Date.UTC(2026, 10, 14, 12, 0);

export function providerStatus(over: Partial<ProviderAuthStatus> & Pick<ProviderAuthStatus, "provider">): ProviderAuthStatus {
  return {
    state: "working",
    reason: null,
    account: knownField("owner@example.com"),
    plan: knownField("max"),
    method: knownField("subscription"),
    tokenExpiresAt: knownField(LLM_AUTH_NOW + 3_600_000),
    lastSuccessAt: LLM_AUTH_NOW - 60_000,
    checkedAt: LLM_AUTH_NOW - 60_000,
    verifiedBy: "provider",
    cli: { path: knownField("~/.local/bin/claude"), version: knownField("2.1.283") },
    ...over,
  };
}

export function statusSnapshot(claude: Partial<ProviderAuthStatus> = {}, codex: Partial<ProviderAuthStatus> = {}): StatusSnapshot {
  return {
    computedBy: "service",
    providers: {
      claude: providerStatus({ provider: "claude", ...claude }),
      codex: providerStatus({
        provider: "codex",
        plan: unknownField,
        tokenExpiresAt: unknownField,
        cli: { path: knownField("~/.npm-global/bin/codex"), version: knownField("0.162.1") },
        ...codex,
      }),
    },
  };
}

const binary = (relPath: string, version: string): DoctorBinary => ({
  location: { place: "service_home", homeUser: "auracomp", relPath, owner: "auracomp", mode: 0o755 },
  target: { place: "service_home", homeUser: "auracomp", relPath, owner: "auracomp", mode: 0o755 },
  version: knownField(version),
  versionSource: "path",
});

export function doctorReport(withFindings = true): DoctorReport {
  return {
    checkedAt: LLM_AUTH_NOW - 120_000,
    computedBy: "service",
    serviceUser: "auracomp",
    providers: {
      claude: {
        provider: "claude",
        launched: binary(".local/bin/claude", "2.1.120"),
        requiredVersion: knownField("2.1.280"),
        findings: withFindings
          ? [
              { kind: "cli_outdated", provider: "claude", launched: binary(".local/bin/claude", "2.1.120"), required: "2.1.280" },
              {
                kind: "credential_copy",
                provider: "claude",
                copy: { place: "root_home", homeUser: "root", relPath: ".claude/.credentials.json", owner: "root", mode: 0o600 },
              },
            ]
          : [],
        unchecked: withFindings ? [{ provider: "claude", check: "credential_copies", reason: "permission_denied", place: { place: "other_user_home", homeUser: "bob", relPath: "" } }] : [],
      },
      codex: {
        provider: "codex",
        launched: binary(".npm-global/bin/codex", "0.162.1"),
        requiredVersion: unknownField,
        findings: [],
        unchecked: [],
      },
    },
  };
}
