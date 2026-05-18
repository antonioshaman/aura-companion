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

export interface BrowserGroupRecordParts {
  sessionGroupId: string;
  primary: { sessionId: string; backendType: BackendType };
  observer: { sessionId: string; backendType: BackendType };
  status: BrowserGroupRecord["status"];
}

/**
 * Build a `BrowserGroupRecord` from already-resolved parts. The three
 * producer sites compose the input from whichever data source they have
 * at hand (launcher, coordinator GroupRecord, ws-bridge session map);
 * the OUTPUT shape is mechanically identical because there's only one
 * field-assembly site. Drift between push and REST bootstrap — the
 * specific gap PR #68 closes — becomes impossible by construction.
 */
export function buildBrowserGroupRecord(parts: BrowserGroupRecordParts): BrowserGroupRecord {
  return {
    sessionGroupId: parts.sessionGroupId,
    primarySessionId: parts.primary.sessionId,
    observerSessionId: parts.observer.sessionId,
    pairing: `${parts.primary.backendType}+${parts.observer.backendType}`,
    status: parts.status,
    wakeTimeoutMs: OBSERVER_WAKE_TIMEOUT_MS,
  };
}
