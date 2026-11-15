import { api } from "../../api.js";
import { useStore } from "../../store.js";
import { PROVIDER_IDS, type ProviderId, type TurnFailure, type TurnFailureKind } from "../../../server/auth-status/auth-types.js";
import type { StatusSnapshot } from "../../../server/auth-status/status-core.js";

/**
 * "Sign-in restored" (LLM auth phase 2c, task 12; spec S3-AC1/AC4/AC5). A
 * selector over facts the browser already has — the failure card's own time
 * and the provider's last successful promotion — never a rewrite of the
 * stored failure: a failed or cancelled sign-in moves no promotion time, so
 * the cards stay exactly as they were.
 *
 * `promotedAt` comes from the status `lastPromotedAt` today; phase 2d's
 * "sign-in renewed" signal (task 14) feeds the same store field, the
 * selector stays as is.
 */

/** Failures a new sign-in fixes. Limits, network and outdated CLIs are not sign-in problems. */
const SIGN_IN_FAILURES: ReadonlySet<TurnFailureKind> = new Set<TurnFailureKind>(["auth_rejected", "stale_session_credentials"]);

export function isSignInRestored(failure: TurnFailure, firedAt: number, promotedAt: Partial<Record<ProviderId, number>>): boolean {
  const at = promotedAt[failure.provider];
  return SIGN_IN_FAILURES.has(failure.kind) && at !== undefined && firedAt < at;
}

/**
 * Which variant the failure card shows (phase 2d, task 14; S3-AC1/AC3):
 * - `restored`: a sign-in failure that happened BEFORE the last promotion —
 *   the new sign-in fixes it, Retry resends once;
 * - `retry_needed`: a stale-credentials failure AT or AFTER the promotion — the
 *   turn ran on the old sign-in while it changed (the server tags a failure
 *   of a session still on the old epoch `stale_session_credentials`); the
 *   session moves to the new sign-in and the turn has to be repeated;
 * - `none`: everything else, exactly as classified.
 */
export function turnFailureRecovery(
  failure: TurnFailure,
  firedAt: number,
  promotedAt: Partial<Record<ProviderId, number>>,
): "none" | "restored" | "retry_needed" {
  if (isSignInRestored(failure, firedAt, promotedAt)) return "restored";
  const at = promotedAt[failure.provider];
  if (failure.kind === "stale_session_credentials" && at !== undefined && firedAt >= at) return "retry_needed";
  return "none";
}

/** The session's renewal record carries the promotion time: feed the same store field (task 14). */
export function notePromotedFromRenewal(record: { provider: ProviderId; promotedAt: number } | null | undefined): void {
  if (!record) return;
  useStore.getState().noteLlmAuthPromotedAt(record.provider, record.promotedAt);
}

/** Copies each provider's `lastPromotedAt` from a status read into the store. */
export function notePromotedFromStatus(snapshot: StatusSnapshot | null | undefined): void {
  if (!snapshot) return;
  const note = useStore.getState().noteLlmAuthPromotedAt;
  for (const id of PROVIDER_IDS) note(id, snapshot.providers[id]?.lastPromotedAt);
}

let loaded: Promise<void> | null = null;

/**
 * One status read per page load for chats that show a sign-in failure card
 * (the Diagnostics card and the sign-in window refresh it on their own). A
 * failed read is retried on the next call.
 */
export function ensurePromotedAtLoaded(): Promise<void> {
  if (!loaded) {
    loaded = api.llmAuthStatus().then(
      (r) => notePromotedFromStatus(r.status),
      () => {
        loaded = null;
      },
    );
  }
  return loaded;
}

/** Test hook: forget the one-per-page read. */
export function _resetPromotedAtLoaderForTest(): void {
  loaded = null;
}
