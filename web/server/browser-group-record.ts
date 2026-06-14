// Shared producer of the `BrowserGroupRecord` wire shape used by all
// three Council Mode group-creation paths:
//
//   1. `session-orchestrator.ts` — live `group:created` bus listener that
//      fans out via `wsBridge.broadcastToGroup` after `createCouncilGroup`
//      or after a `reconnected` re-emit from the coordinator.
//   2. `session-orchestrator.ts` — REST bootstrap (`getAllGroupsForBootstrap`)
//      that snapshots all live groups for browser app-mount hydration.
//   3. `ws-bridge.ts` — synthetic `group_created` payload re-sent to a
//      single browser when it opens a WS for a session that is part of an
//      already-established pair (PR #61 reload bootstrap).
//
// Centralising the mapping closes the PICKUP §"shared mapper" invariant:
// the four wire fields (`sessionGroupId`, `primarySessionId`,
// `observerSessionId`, `pairing`) and `wakeTimeoutMs` cannot diverge across
// the three producers because there is only one construction site.
//
// `status` is supplied per-call because the three paths legitimately carry
// different information at emit time:
//   - The live push and the WS synthetic hydration both happen when the
//     group is `active` (post-spawn or post-reconnect), so they pass
//     `"active"` literally.
//   - The REST bootstrap surfaces the coordinator's current status — a
//     reload during a `degraded` or `reconnecting` pair MUST receive the
//     true status so the panel header pill doesn't lie.
//
// `wakeTimeoutMs` is the server's `OBSERVER_WAKE_TIMEOUT_MS` constant —
// imported here so all three call sites emit the same bound and the
// frontend deriver's `reviewing` interval is identical whether the group
// surfaced via REST or live push.

import { OBSERVER_WAKE_TIMEOUT_MS } from "./council-types.js";
import type { BackendType, BrowserGroupRecord } from "./session-types.js";

/**
 * Default backend type used when a producer cannot resolve one for a
 * pair half — covers launcher-propagation-lag where `SdkSessionInfo.backendType`
 * is briefly absent right after spawn, before the launcher's setup
 * callback finishes wiring backend metadata. The coordinator's
 * `GroupRecord` always carries a resolved `backendType`, so REST
 * bootstrap callers pass concrete values; live push + ws-bridge
 * synthetic hydration callers may pass `undefined` and rely on this
 * default.
 *
 * Keeping the default INSIDE the helper (rather than at each call site)
 * is the load-bearing structural decision: a fourth producer added in
 * the future cannot accidentally pass `undefined` cast as `BackendType`
 * and emit `pairing: "undefined+undefined"`. The type-system contract is
 * `BackendType | undefined` for input; the OUTPUT is always a well-formed
 * pairing string.
 */
const DEFAULT_BACKEND_TYPE: BackendType = "claude";

export interface BrowserGroupRecordParts {
  sessionGroupId: string;
  /**
   * Pair half identity. `backendType` is optional because the live-push
   * and ws-bridge synthetic hydration call sites source it from the
   * launcher map (where it may be briefly undefined post-spawn), while
   * the REST bootstrap path sources it from the coordinator's
   * `GroupRecord` (where it is always defined). The helper applies the
   * `DEFAULT_BACKEND_TYPE` fallback once, internally.
   */
  primary: { sessionId: string; backendType: BackendType | undefined };
  observer: { sessionId: string; backendType: BackendType | undefined };
  status: BrowserGroupRecord["status"];
  deadRole?: BrowserGroupRecord["deadRole"];
  degradedReason?: BrowserGroupRecord["degradedReason"];
}

/**
 * Build a `BrowserGroupRecord` from already-resolved parts. The three
 * producer sites compose the input from whichever data source they have
 * at hand (launcher, coordinator GroupRecord, ws-bridge session map);
 * the OUTPUT shape is mechanically identical because there's only one
 * field-assembly site. Drift between push and REST bootstrap — the
 * specific gap PR #68 closes — becomes impossible by construction.
 *
 * The `backendType` fallback is now internal — callers MUST NOT pre-apply
 * `?? "claude"` at the call site. Doing so re-introduces the bug class
 * the helper was extracted to prevent (Fowler P2 finding on PR #68
 * review).
 */
export function buildBrowserGroupRecord(parts: BrowserGroupRecordParts): BrowserGroupRecord {
  const primaryBackend = parts.primary.backendType ?? DEFAULT_BACKEND_TYPE;
  const observerBackend = parts.observer.backendType ?? DEFAULT_BACKEND_TYPE;
  return {
    sessionGroupId: parts.sessionGroupId,
    primarySessionId: parts.primary.sessionId,
    observerSessionId: parts.observer.sessionId,
    pairing: `${primaryBackend}+${observerBackend}`,
    status: parts.status,
    ...(parts.deadRole ? { deadRole: parts.deadRole } : {}),
    ...(parts.degradedReason ? { degradedReason: parts.degradedReason } : {}),
    wakeTimeoutMs: OBSERVER_WAKE_TIMEOUT_MS,
  };
}
