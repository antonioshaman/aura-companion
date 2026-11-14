/**
 * Shared, closed vocabulary for LLM-auth status, doctor findings and turn
 * failures (phase 1, `specs/llm-auth-phase1-status-and-errors.md`).
 *
 * Pure types + tiny helpers, no runtime imports: the server, the offline
 * `aura-companion` CLI and the React client (type-only) all import from here,
 * so writer and reader cannot drift (AP-3). Every union is closed; consumers
 * switch exhaustively via `assertNever` so a new kind without handling — or
 * without catalog text in `auth-catalog.ts` — does not compile.
 */

export type ProviderId = "claude" | "codex";
export const PROVIDER_IDS: readonly ProviderId[] = ["claude", "codex"];

/** A field the provider may not report. Rendered as "unknown", never blank. */
export type Known<T> = { known: true; value: T } | { known: false };
export const unknownField = { known: false } as const;
export function knownField<T>(value: T): Known<T> {
  return { known: true, value };
}

// ─── Provider status ──────────────────────────────────────────────────────────

export type ProviderAuthState =
  /** The provider accepted the credentials on the last check. */
  | "working"
  /** Credentials exist but the provider rejected them (dead refresh, revoked). */
  | "invalid"
  /** The provider could not be reached; NOT evidence the credentials are bad. */
  | "no_network"
  /** Only local facts are known — see `NotVerifiedReason`. */
  | "not_verified"
  /** No credential source at all. */
  | "not_signed_in";

export const PROVIDER_AUTH_STATES: readonly ProviderAuthState[] = [
  "working", "invalid", "no_network", "not_verified", "not_signed_in",
];

/** Why a status is `not_verified` (the probe was skipped or inconclusive). */
export type NotVerifiedReason =
  /** The installed CLI version is not on the proven-safe list (rotation guard). */
  | "cli_version_unproven"
  /** The local access token is expired / about to expire; probing could rotate it. */
  | "token_expired_locally"
  /** The CLI binary was not found. */
  | "cli_missing"
  /** The probe ran but its output was not understood (format drift, non-zero exit). */
  | "probe_inconclusive"
  /** The probe would change credential files; disabled until restart. */
  | "rotation_detected"
  /** Computed as a different OS user than the service user. */
  | "wrong_user"
  /** The provider exposes no token-free check for this login method. */
  | "no_provider_check";

export const NOT_VERIFIED_REASONS: readonly NotVerifiedReason[] = [
  "cli_version_unproven", "token_expired_locally", "cli_missing", "probe_inconclusive",
  "rotation_detected", "wrong_user", "no_provider_check",
];

export type AuthLoginMethod = "subscription" | "api_key" | "env_token";

export interface ProviderAuthStatus {
  provider: ProviderId;
  state: ProviderAuthState;
  /** Non-null exactly when `state === "not_verified"`. */
  reason: NotVerifiedReason | null;
  account: Known<string>;
  plan: Known<string>;
  method: Known<AuthLoginMethod>;
  /** Epoch ms the local access token expires. */
  tokenExpiresAt: Known<number>;
  /** Epoch ms of the last check that ended `working`; survives later failures. */
  lastSuccessAt: number | null;
  /** Epoch ms of this result's check. */
  checkedAt: number;
  /** "provider" = asked the provider; "local" = files/env only. */
  verifiedBy: "provider" | "local";
  /** CLI that produced (or would produce) the result. Unknown when not run. */
  cli: { path: Known<string>; version: Known<string> };
  /** For `wrong_user`: the service user the status must be computed as. */
  serviceUser?: string;
}

// ─── Doctor findings (rendered in 1b; vocabulary fixed here) ──────────────────

export type DoctorFindingKind =
  | "binary_divergence"
  | "cli_outdated"
  | "credential_copy"
  | "credential_foreign_owner"
  | "credential_unreadable";

export const DOCTOR_FINDING_KINDS: readonly DoctorFindingKind[] = [
  "binary_divergence", "cli_outdated", "credential_copy", "credential_foreign_owner", "credential_unreadable",
];

// ─── Turn failures (classified in 1c; vocabulary fixed here) ──────────────────

export type TurnFailureKind =
  | "auth_rejected"
  | "limit_window"
  | "extra_usage_exhausted"
  | "network"
  | "cli_outdated"
  | "stale_session_credentials";

export const TURN_FAILURE_KINDS: readonly TurnFailureKind[] = [
  "auth_rejected", "limit_window", "extra_usage_exhausted", "network", "cli_outdated", "stale_session_credentials",
];

// ─── Usage-limits panel reason (task 6) ───────────────────────────────────────

/** Why `/api/usage-limits` carries no windows. Absent when data is present. */
export type UsageLimitsReason =
  | "auth_invalid"
  | "api_key_login"
  | "network"
  | "no_credentials"
  | "unknown";

export const USAGE_LIMITS_REASONS: readonly UsageLimitsReason[] = [
  "auth_invalid", "api_key_login", "network", "no_credentials", "unknown",
];

// ─── Catalog shape ────────────────────────────────────────────────────────────

/** One action per message. `docRef` points at the current manual instruction (phase 2 replaces it). */
export type AuthAction =
  | { kind: "relogin"; command: string; docRef: string }
  | { kind: "retry" }
  | { kind: "restart_session" }
  | { kind: "update_cli"; command: string }
  | { kind: "run_as_service_user" }
  | { kind: "open_status" }
  | { kind: "none" };

export interface CatalogEntry {
  title: string;
  detail: string;
  action: AuthAction;
}

export function assertNever(value: never): never {
  throw new Error(`unhandled auth vocabulary value: ${String(value)}`);
}
