/**
 * Pairs card snapshot (plan Task 6, AC1).
 *
 * A pure overlay on the groups the coordinator already publishes
 * (`getAllGroupsForBootstrap`): status, dead role and degraded reason come
 * straight from the state machine (AP-2) — nothing here re-derives them.
 * Per half it adds the launcher's process facts and the adapter's last
 * inbound-frame time (Claude stamps stdout frames, Codex stamps inbound
 * notifications); a half with no frame yet reports `null`, never an age from
 * epoch.
 */

import type { BrowserGroupRecord } from "../session-types.js";
import type { PairHalfView, PairView } from "./diagnostics-types.js";

export interface PairsSnapshotDeps {
  groups: () => BrowserGroupRecord[];
  session: (sessionId: string) =>
    | { backendType?: string; state?: string; pid?: number; exitCode?: number | null; cwd?: string }
    | undefined;
  /** Epoch ms of the last CLI frame, 0 / undefined when none yet. */
  lastFrameAt: (sessionId: string) => number | undefined;
  lastCheckpointAt: (sessionGroupId: string) => number | null;
  /** Wake sentinel time for the group in the orchestrator's workspace. */
  lastWakeAt: (sessionGroupId: string, cwd: string) => number | null;
}

export function buildPairsSnapshot(deps: PairsSnapshotDeps): PairView[] {
  return deps.groups().map((g) => {
    const half = (sessionId: string, role: PairHalfView["role"]): PairHalfView => {
      const info = deps.session(sessionId);
      const frame = deps.lastFrameAt(sessionId);
      return {
        sessionId,
        role,
        backendType: info?.backendType ?? "unknown",
        state: info?.state ?? null,
        pid: typeof info?.pid === "number" ? info.pid : null,
        exitCode: typeof info?.exitCode === "number" ? info.exitCode : null,
        lastInboundFrameAt: typeof frame === "number" && frame > 0 ? frame : null,
      };
    };
    const cwd = deps.session(g.primarySessionId)?.cwd;
    return {
      sessionGroupId: g.sessionGroupId,
      status: g.status,
      ...(g.deadRole ? { deadRole: g.deadRole } : {}),
      ...(g.degradedReason ? { degradedReason: g.degradedReason } : {}),
      pairing: g.pairing,
      lastCheckpointAt: deps.lastCheckpointAt(g.sessionGroupId),
      lastWakeAt: cwd ? deps.lastWakeAt(g.sessionGroupId, cwd) : null,
      halves: [half(g.primarySessionId, "orchestrator"), half(g.observerSessionId, "observer")],
    };
  });
}
