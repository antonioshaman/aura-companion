import type { GroupRecord, SessionGroupCoordinator } from "./session-group-coordinator.js";

/**
 * Canonical group-id format pattern. The producer (`generateGroupId` in the
 * coordinator) and every consumer reach for this single constant so prefix
 * or entropy changes happen in one place. Fowler F2.
 */
export const GROUP_ID_PATTERN = /^grp_[a-f0-9]{32}$/;

/**
 * Aura Companion authenticates requests by host token (`verifyToken` in
 * `routes.ts`). Once the token is verified, this helper performs the
 * second-layer check: that the requested `sessionGroupId` matches the
 * canonical format AND is known to the coordinator.
 *
 * Returns `null` on either failure — callers should map that to HTTP 404
 * (do not leak whether the ID is malformed or simply absent).
 */
export function authorizeGroupAccess(
  coordinator: SessionGroupCoordinator,
  sessionGroupId: unknown,
): GroupRecord | null {
  if (!isWellFormedGroupId(sessionGroupId)) return null;
  return coordinator.get(sessionGroupId) ?? null;
}

/**
 * Validate that `v` is a well-formed group id. The regex is anchored —
 * the previous redundant `length === 36` check is dropped: the regex is
 * the single source of truth, and removing it lets the producer evolve
 * (e.g. wider entropy, longer prefix) without a hidden length tripwire.
 */
export function isWellFormedGroupId(v: unknown): v is string {
  return typeof v === "string" && GROUP_ID_PATTERN.test(v);
}

/**
 * Resolve a per-session operation to its containing group, if any.
 * Returns null for single sessions — callers should fall through to
 * the existing per-session authorisation path.
 */
export function resolveSessionGroup(
  coordinator: SessionGroupCoordinator,
  sessionId: string,
): GroupRecord | null {
  if (typeof sessionId !== "string" || sessionId.length === 0) return null;
  return coordinator.findBySessionId(sessionId) ?? null;
}
