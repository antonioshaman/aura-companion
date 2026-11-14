import {
  assertNever,
  type AuthAction,
  type CatalogEntry,
  type DoctorCheck,
  type DoctorFindingKind,
  type DoctorPlaceClass,
  type DoctorUncheckedReason,
  type EffectiveAuthMethod,
  type Known,
  type LoginAttemptState,
  type LoginFailureReason,
  type PlanCheck,
  type NotVerifiedReason,
  type ProviderAuthState,
  type ProviderId,
  type TurnFailure,
  type TurnFailureKind,
  type UsageLimitsReason,
  type UsageWindow,
  type VerifiedBy,
} from "./auth-types.js";

/**
 * The one "kind → text + action" catalog for LLM-auth surfaces. The server
 * status payload, the offline CLI and the React client render from these
 * functions, so UI and CLI wording is identical by construction (spec
 * Boundaries "Тексты ошибок и статусов одинаковы в UI и CLI").
 *
 * Pure: no Node / DOM imports, safe for the browser bundle. Every switch is
 * exhaustive — adding a kind to `auth-types.ts` without text here fails tsc.
 */

/** Manual sign-in instruction: the CLI fallback when the server is down, and Claude on macOS (D6). */
export const RELOGIN_DOC_REF = "docs/deploy/vps-systemd.mdx#prerequisites";

export function providerLabel(provider: ProviderId): string {
  switch (provider) {
    case "claude": return "Claude";
    case "codex": return "Codex";
    default: return assertNever(provider);
  }
}

export function reloginAction(provider: ProviderId): AuthAction {
  return { kind: "sign_in", provider };
}

/** The official CLI command that signs the service user in by hand. */
export function manualSignInCommand(provider: ProviderId): string {
  switch (provider) {
    case "claude": return "claude auth login";
    case "codex": return "codex login --device-auth";
    default: return assertNever(provider);
  }
}

function manualSignInLine(provider: ProviderId): string {
  return `Sign in again as the service user: \`${manualSignInCommand(provider)}\` (see ${RELOGIN_DOC_REF})`;
}

/** The manual instruction as a catalog entry (CLI fallback when the server is unreachable; macOS, D6). */
export function describeManualSignIn(provider: ProviderId): CatalogEntry {
  return {
    title: `Sign in to ${providerLabel(provider)} manually`,
    detail: manualSignInLine(provider),
    action: { kind: "none" },
  };
}

/**
 * Which steps the sign-in window shows. Claude prints a link and reads a reply
 * code from stdin; Codex prints a link plus a one-time device code and polls
 * the provider itself — no reply code (Verified CLI behaviour 2026-11-14).
 */
export function signInSteps(provider: ProviderId): { replyCode: boolean; deviceCode: boolean } {
  switch (provider) {
    case "claude": return { replyCode: true, deviceCode: false };
    case "codex": return { replyCode: false, deviceCode: true };
    default: return assertNever(provider);
  }
}

function updateCliAction(provider: ProviderId): AuthAction {
  switch (provider) {
    case "claude": return { kind: "update_cli", command: "claude update" };
    case "codex": return { kind: "update_cli", command: "npm install -g @openai/codex@latest" };
    default: return assertNever(provider);
  }
}

/** Renders a `Known<T>` field; unknown is the literal word, never blank. */
export function formatKnown<T>(field: Known<T>, format: (value: T) => string = String): string {
  return field.known ? format(field.value) : "unknown";
}

export function describeAuthState(
  state: ProviderAuthState,
  provider: ProviderId,
  reason: NotVerifiedReason | null = null,
): CatalogEntry {
  const name = providerLabel(provider);
  switch (state) {
    case "working":
      return { title: `${name}: working`, detail: "The provider accepted the credentials.", action: { kind: "none" } };
    case "invalid":
      return {
        title: `${name}: credentials invalid`,
        detail: "Credentials are present but the provider rejects them (expired refresh token or revoked access).",
        action: reloginAction(provider),
      };
    case "no_network":
      return {
        title: `${name}: no connection`,
        detail: "The provider did not answer. This is not a credential problem; the last successful check still stands.",
        action: { kind: "retry" },
      };
    case "not_verified":
      return describeNotVerified(reason ?? "probe_inconclusive", provider);
    case "not_signed_in":
      return { title: `${name}: not signed in`, detail: "No credentials were found for the service user.", action: reloginAction(provider) };
    default:
      return assertNever(state);
  }
}

export function describeNotVerified(reason: NotVerifiedReason, provider: ProviderId): CatalogEntry {
  const name = providerLabel(provider);
  const title = `${name}: not verified with the provider`;
  switch (reason) {
    case "cli_version_unproven":
      return {
        title,
        detail: "This CLI version is not proven to leave credentials untouched during a status check, so the check was skipped. Local status only.",
        action: { kind: "none" },
      };
    case "token_expired_locally":
      return {
        title: `${name}: token expired locally`,
        detail: "The local access token has expired. The status check was skipped so it cannot rotate the token under running sessions.",
        action: reloginAction(provider),
      };
    case "cli_missing":
      return { title, detail: `The ${name} CLI was not found on the service PATH.`, action: updateCliAction(provider) };
    case "probe_inconclusive":
      return { title, detail: "The CLI status output was not understood. Local status only.", action: { kind: "retry" } };
    case "rotation_detected":
      return {
        title,
        detail: "A status check changed the credential file, so provider checks are disabled until the server restarts.",
        action: { kind: "none" },
      };
    case "wrong_user":
      return {
        title,
        detail: "Status was computed as a different OS user than the service user; run it as the service user.",
        action: { kind: "run_as_service_user" },
      };
    case "no_provider_check":
      return { title, detail: "The provider offers no token-free check for this sign-in method. Local status only.", action: { kind: "none" } };
    default:
      return assertNever(reason);
  }
}

export function describeDoctorFinding(kind: DoctorFindingKind, provider: ProviderId): CatalogEntry {
  const name = providerLabel(provider);
  switch (kind) {
    case "binary_divergence":
      return {
        title: `${name}: service runs a different CLI`,
        detail: "The service launches a different CLI path or version than the one installed for the service user.",
        action: updateCliAction(provider),
      };
    case "cli_outdated":
      return { title: `${name}: outdated CLI`, detail: "The CLI that runs sessions is older than required.", action: updateCliAction(provider) };
    case "credential_copy":
      return {
        title: `${name}: independent credential copy`,
        detail: "Another copy of rotating credentials exists. When either copy refreshes, the other sign-in can be invalidated.",
        action: { kind: "none" },
      };
    case "credential_foreign_owner":
      return {
        title: `${name}: credentials owned by another user`,
        detail: "The credential file is not owned by the service user.",
        action: { kind: "run_as_service_user" },
      };
    case "credential_unreadable":
      return {
        title: `${name}: credentials unreadable`,
        detail: "The service user cannot read the credential file.",
        action: { kind: "run_as_service_user" },
      };
    default:
      return assertNever(kind);
  }
}

export function describeDoctorClear(provider: ProviderId): CatalogEntry {
  return { title: `${providerLabel(provider)}: no problems found`, detail: "All doctor checks passed.", action: { kind: "none" } };
}

function doctorCheckLabel(check: DoctorCheck): string {
  switch (check) {
    case "binary": return "CLI binary";
    case "cli_version": return "CLI version";
    case "credential_copies": return "credential copies";
    case "credential_access": return "credential owner and permissions";
    default: return assertNever(check);
  }
}

/** A check that did not run. Never phrased as "nothing found" (fail-closed). */
export function describeDoctorUnchecked(check: DoctorCheck, reason: DoctorUncheckedReason, provider: ProviderId): CatalogEntry {
  const title = `${providerLabel(provider)}: ${doctorCheckLabel(check)} not checked`;
  switch (reason) {
    case "permission_denied":
      return {
        title,
        detail: "Permission denied for this location, so it was not checked. This is not the same as \"nothing found\".",
        action: { kind: "run_as_root", command: "sudo aura-companion doctor --offline" },
      };
    case "version_unknown":
      return {
        title,
        detail: "The CLI version could not be read from its install path, and running another user's binary is not allowed.",
        action: { kind: "run_as_service_user" },
      };
    case "io_error":
      return { title, detail: "The location could not be read.", action: { kind: "retry" } };
    default:
      return assertNever(reason);
  }
}

export function doctorPlaceLabel(place: DoctorPlaceClass): string {
  switch (place) {
    case "service_home": return "service user's home";
    case "codex_session_home": return "Codex session home";
    case "root_home": return "root's home";
    case "other_user_home": return "another user's home";
    case "system": return "system path";
    default: return assertNever(place);
  }
}

export function describeTurnFailure(kind: TurnFailureKind, provider: ProviderId): CatalogEntry {
  const name = providerLabel(provider);
  switch (kind) {
    case "auth_rejected":
      return { title: `${name} rejected the sign-in`, detail: "The provider rejected this session's credentials.", action: reloginAction(provider) };
    case "limit_window":
      return { title: `${name} usage limit reached`, detail: "A subscription usage window is exhausted.", action: { kind: "none" } };
    case "extra_usage_exhausted":
      return {
        title: `${name} extra usage exhausted`,
        detail: "The turn ran on extra usage and that balance is empty or disabled — this is not the subscription window.",
        action: { kind: "none" },
      };
    case "network":
      return { title: `No connection to ${name}`, detail: "The provider could not be reached. This is not a sign-in problem.", action: { kind: "retry" } };
    case "cli_outdated":
      return { title: `${name} CLI is outdated`, detail: "The CLI running this session is older than the model requires.", action: updateCliAction(provider) };
    case "stale_session_credentials":
      return {
        title: "Session uses outdated credentials",
        detail: "This session holds an old copy of the credentials while the main sign-in was renewed.",
        action: { kind: "restart_session" },
      };
    default:
      return assertNever(kind);
  }
}

export function usageWindowLabel(window: UsageWindow): string {
  switch (window) {
    case "five_hour": return "5-hour window";
    case "seven_day": return "7-day window";
    case "extra_usage": return "extra usage";
    case "unknown_window": return "unknown window";
    default: return assertNever(window);
  }
}

/**
 * The secondary lines of a turn-failure card (task 14): which window and when
 * it resets, the likely cause, an uncompared credential generation, the
 * required CLI version. `formatTime` renders an epoch-ms instant (the UI uses
 * the browser locale, the CLI ISO). Empty when the kind carries no facts.
 */
export function turnFailureFacts(failure: TurnFailure, formatTime: (ms: number) => string): string[] {
  const facts: string[] = [];
  if (failure.window) {
    const reset = failure.resetAt == null ? "reset time unknown" : `resets ${formatTime(failure.resetAt)}`;
    facts.push(`Window: ${usageWindowLabel(failure.window)} · ${reset}`);
  }
  if (failure.likelyCause === "model_outside_plan") facts.push("Likely cause: the selected model is not included in the plan.");
  if (failure.credentialsCompared === false) facts.push("Could not compare this session's credentials with the main sign-in.");
  if (failure.kind === "cli_outdated") {
    facts.push(`Required CLI version: ${failure.requiredVersion ? `${failure.requiredVersion} or newer` : "unknown"}`);
  }
  return facts;
}

/**
 * The limits panel before any window data exists. Claude's panel normally
 * carries a `UsageLimitsReason` instead; Codex reports its windows only with a
 * turn's `account/rateLimits/*`, so a fresh Codex session has none yet.
 */
export function describeLimitsPending(provider: ProviderId): CatalogEntry {
  switch (provider) {
    case "claude":
      return { title: "No data yet", detail: "Waiting for the first usage answer from Claude.", action: { kind: "none" } };
    case "codex":
      return { title: "No data yet", detail: "Codex reports its usage windows with its first response in this session.", action: { kind: "none" } };
    default:
      return assertNever(provider);
  }
}

export function describeUsageLimitsReason(reason: UsageLimitsReason): CatalogEntry {
  switch (reason) {
    case "auth_invalid":
      return { title: "No data: Claude sign-in is invalid", detail: "The usage request was rejected or the token has expired.", action: { kind: "open_status" } };
    case "api_key_login":
      return {
        title: "Subscription windows do not apply",
        detail: "Claude is signed in with an API key, which has no 5-hour / 7-day subscription windows.",
        action: { kind: "none" },
      };
    case "network":
      return { title: "No data: usage service unreachable", detail: "The usage request did not get an answer.", action: { kind: "retry" } };
    case "no_credentials":
      return { title: "No data: Claude is not signed in", detail: "No Claude credentials were found for the service user.", action: { kind: "open_status" } };
    case "unknown":
      return { title: "No data", detail: "Usage limits are unavailable for an unrecognised reason.", action: { kind: "retry" } };
    default:
      return assertNever(reason);
  }
}

export function verifiedByLabel(verifiedBy: VerifiedBy): string {
  switch (verifiedBy) {
    case "provider": return "with the provider";
    case "local": return "local only";
    case "login": return "by sign-in";
    default: return assertNever(verifiedBy);
  }
}

// ─── Sign-in (phase 2) ────────────────────────────────────────────────────────

export function describeLoginAttempt(state: LoginAttemptState, provider: ProviderId): CatalogEntry {
  const name = providerLabel(provider);
  switch (state) {
    case "starting":
      return { title: `Signing in to ${name}…`, detail: `Starting the official ${name} CLI sign-in.`, action: { kind: "none" } };
    case "awaiting_user":
      return {
        title: `Sign in to ${name} in your browser`,
        detail: signInSteps(provider).replyCode
          ? "Open the link, confirm the sign-in, then paste the code the page shows here."
          : "Open the link, sign in, and enter the code shown here. This window updates by itself.",
        action: { kind: "none" },
      };
    case "verifying":
      return { title: `Checking the new ${name} sign-in…`, detail: "Verifying the account and plan before using the new credentials.", action: { kind: "none" } };
    case "succeeded":
      return { title: `Signed in to ${name}`, detail: "The new credentials are in place for the service user.", action: { kind: "none" } };
    case "failed":
      return { title: `${name} sign-in failed`, detail: "The previous credentials were left unchanged.", action: reloginAction(provider) };
    case "cancelled":
      return { title: `${name} sign-in cancelled`, detail: "Nothing was changed.", action: reloginAction(provider) };
    case "expired":
      return { title: `${name} sign-in expired`, detail: "The attempt ran out of time. Nothing was changed.", action: reloginAction(provider) };
    default:
      return assertNever(state);
  }
}

export function describeLoginFailure(reason: LoginFailureReason, provider: ProviderId): CatalogEntry {
  const name = providerLabel(provider);
  const unchanged = "The previous credentials were left unchanged.";
  const invalid = `${name}: the code is invalid or expired`;
  switch (reason) {
    case "code_rejected":
      return { title: invalid, detail: `${name} did not accept the code. ${unchanged}`, action: reloginAction(provider) };
    case "code_format":
      return { title: invalid, detail: `That does not look like a ${name} sign-in code. Copy the whole code from the page.`, action: reloginAction(provider) };
    case "attempt_mismatch":
      return { title: invalid, detail: "The code belongs to a different sign-in attempt. Start again and use the new link.", action: reloginAction(provider) };
    case "expired":
      return { title: invalid, detail: `The sign-in attempt ran out of time. ${unchanged}`, action: reloginAction(provider) };
    case "network":
      return { title: `${name}: sign-in could not reach the provider`, detail: `Check the server's connection and start again. ${unchanged}`, action: reloginAction(provider) };
    case "cli_output_unrecognised":
      return {
        title: `${name}: sign-in output not recognised`,
        detail: `The ${name} CLI printed something this version of Aura does not understand, so the sign-in was stopped. ${unchanged}`,
        action: reloginAction(provider),
      };
    case "cli_missing":
      return { title: `${name}: CLI not found`, detail: `The ${name} CLI was not found on the service PATH.`, action: updateCliAction(provider) };
    case "wrong_service_user":
      return {
        title: `${name}: sign-in must run as the service user`,
        detail: "The server is not running as the service user, so the sign-in was not started.",
        action: { kind: "run_as_service_user" },
      };
    case "unsupported_platform":
      return {
        title: `${name}: sign-in from the browser is not available on this system`,
        detail: `Sign in in the server's Terminal instead: ${manualSignInLine(provider)}`,
        action: { kind: "none" },
      };
    case "promotion_failed":
      return {
        title: `${name}: new sign-in could not be put in place`,
        detail: `The sign-in finished, but the new credentials could not be verified or moved in place. ${unchanged}`,
        action: reloginAction(provider),
      };
    default:
      return assertNever(reason);
  }
}

/** `expected` is the owner's setting (null = not set); `actual` the plan the provider reported. */
export function describePlanCheck(check: PlanCheck, provider: ProviderId, expected: string | null, actual: Known<string>): CatalogEntry {
  const name = providerLabel(provider);
  switch (check) {
    case "unset":
      return { title: `${name} plan: ${formatKnown(actual)}`, detail: "No expected plan is set.", action: { kind: "none" } };
    case "match":
      return { title: `${name} plan as expected`, detail: `Plan: ${formatKnown(actual)} (expected ${expected ?? "unknown"}).`, action: { kind: "none" } };
    case "mismatch":
      return {
        title: `${name}: signed in with a different plan`,
        detail: `Expected ${expected ?? "unknown"}, signed in with ${formatKnown(actual)}. Sign in with another account to change it.`,
        action: reloginAction(provider),
      };
    case "unknown":
      return {
        title: `${name}: plan not determined`,
        detail: `The provider did not report the plan, so it cannot be compared with the expected ${expected ?? "plan"}.`,
        action: { kind: "none" },
      };
    default:
      return assertNever(check);
  }
}

/** Which credentials sessions really use. Names a variable, never its value. */
export function describeEffectiveMethod(effective: EffectiveAuthMethod, provider: ProviderId): CatalogEntry {
  const name = providerLabel(provider);
  const variable = effective.variable ?? "a credential";
  switch (effective.source) {
    case "sign_in":
      return { title: `${name} sessions use the stored sign-in`, detail: "Sessions use the service user's sign-in.", action: { kind: "none" } };
    case "environment":
      return {
        title: `${name} sessions use ${variable} instead of the sign-in`,
        detail: `${variable} is set in the service environment and takes priority over the sign-in.`,
        action: { kind: "none" },
      };
    case "settings":
      return {
        title: `${name} sessions use ${variable} instead of the sign-in`,
        detail: `${variable} is set in the settings and takes priority over the sign-in.`,
        action: { kind: "none" },
      };
    default:
      return assertNever(effective.source);
  }
}

/** One-line plain-text rendering of an action, shared by CLI and UI tooltips. */
export function formatAction(action: AuthAction): string {
  switch (action.kind) {
    // Until the sign-in panel ships (phase 2c) the action renders as the manual instruction.
    case "sign_in": return manualSignInLine(action.provider);
    case "retry": return "Retry";
    case "restart_session": return "Restart the session";
    case "update_cli": return `Update the CLI: \`${action.command}\``;
    case "run_as_service_user": return "Run as the service user";
    case "run_as_root": return `Re-run as root to include it: \`${action.command}\``;
    case "open_status": return "Open provider status";
    case "none": return "";
    default: return assertNever(action);
  }
}
