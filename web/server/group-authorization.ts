import type { GroupRecord, SessionGroupCoordinator } from "./session-group-coordinator.js";

/**
 * Aura Companion authenticates requests by host token (`verifyToken` in
 * `routes.ts`). Once the token is verified, this helper performs the
 * second-layer check: that the requested `sessionGroupId` is shaped as
 * a server-generated ID *and* is known to the coordinator.
 *
 * Two layers of defence:
 *   - Format validator rejects browser-supplied junk before any map lookup.
 *   - Coordinator lookup rejects unknown / archived-via-restart IDs.
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
 * The format produced by `SessionGroupCoordinator.generateGroupId()`:
 * `grp_` + 32 lowercase hex chars (128 bits of entropy). Anything else
 * is either a typo, an old format, or an enumeration attempt.
 */
const GROUP_ID_PATTERN = /^grp_[a-f0-9]{32}$/;

export function isWellFormedGroupId(v: unknown): v is string {
  return typeof v === "string" && v.length === 36 && GROUP_ID_PATTERN.test(v);
}

/**
 * Resolve a per-session operation (kill/archive/recording control on a
 * specific session id) to its containing group, if any. Returns null
 * for single sessions — callers should then fall through to the
 * existing per-session authorisation path.
 */
export function resolveSessionGroup(
  coordinator: SessionGroupCoordinator,
  sessionId: string,
): GroupRecord | null {
  if (typeof sessionId !== "string" || sessionId.length === 0) return null;
  return coordinator.findBySessionId(sessionId) ?? null;
}
