import type {
  GroupRecord,
  ObserverFinding,
  ObserverPanelState,
} from "./types.js";

/**
 * Pure derivation of the Observer panel header state. Single source of
 * truth for the status pill — components MUST consume the discriminated
 * union as a unit rather than re-deriving from individual booleans.
 *
 * Priority ladder (highest wins):
 *   1. `degraded`             — one half of the pair is dead.
 *   2. `blocker-found`        — at least one undismissed STOP finding for this group.
 *   3. `reconnecting`         — group is reconnecting after a transient flap.
 *   4. `reviewing-stalled`    — checkpoint > wakeTimeoutMs ago, no review yet (Task 11).
 *   5. `reviewing`            — group received a checkpoint but no review yet.
 *   6. `queued-dropped`       — server's mid-turn queue superseded one+ checkpoint
 *                                between previous review and the most recent (Task 11).
 *   7. `spawning`             — pair is still being created (no checkpoints yet).
 *   8. `sleeping`             — at least one checkpoint completed, no live STOPs.
 *   9. `never-checkpointed-yet` — group is active but no checkpoint observed yet.
 *
 * Returns `null` only when no group is supplied at all — callers render
 * "Council Mode off" UI in that case.
 *
 * Friedman council review #11 (P2#11): `spawning` and `reconnecting`
 * were added so the 10-30s pair-creation window and any WS flap don't
 * collapse silently into the idle pill.
 *
 * Task 11 (Frontend Council Rec): `reviewing` is now bounded by
 * `group.wakeTimeoutMs` (published on `group_created`). Past the deadline
 * without an `observer_review`, the deriver yields `reviewing-stalled`
 * rather than silently reverting to `sleeping` — closes the recovery-
 * branch-reachability failure mode where a stuck wake looked the same
 * as a healthy idle pair. `queued-dropped` surfaces the server's
 * newest-wins mid-turn queue (Task 4) so the user knows skipped
 * checkpoints are deliberate, not silent under-review.
 */
export function deriveObserverPanelState(args: {
  group: GroupRecord | undefined;
  findings: readonly ObserverFinding[];
  /** STOP findings the user has dismissed. */
  dismissedStopIds: ReadonlySet<string>;
  /** Wallclock (ms) — defaults to `Date.now()`. Override for deterministic tests. */
  nowMs?: number;
}): ObserverPanelState | null {
  const { group, findings, dismissedStopIds, nowMs } = args;
  if (!group) return null;
  const now = typeof nowMs === "number" ? nowMs : Date.now();

  if (group.status === "degraded") {
    // The spec requires `deadRole` whenever status === "degraded". If a
    // malformed payload reached us without it, fall back to "observer"
    // (the more common death mode) rather than crash the panel — but
    // still surface degraded so the user takes action.
    return {
      name: "degraded",
      deadRole: group.deadRole ?? "observer",
      ...(group.degradedReason ? { reason: group.degradedReason } : {}),
    };
  }

  const liveStops = findUnresolvedStops(findings, dismissedStopIds);
  if (liveStops.length > 0) {
    return {
      name: "blocker-found",
      unresolvedStops: liveStops.length,
      lastBlockerAt: liveStops[liveStops.length - 1]!.receivedAt,
    };
  }

  if (group.status === "reconnecting") {
    return {
      name: "reconnecting",
      lastCheckpointAt: group.lastCheckpointAt ?? null,
      lastPhase: group.lastPhase ?? null,
    };
  }

  if (group.observerReviewing === true && typeof group.lastCheckpointAt === "number" && typeof group.lastPhase === "string") {
    // Task 11: bound the `reviewing` interval by the server-published
    // wakeTimeoutMs. Past the deadline, fall through to `reviewing-stalled`
    // so the user sees a stuck wake instead of an indefinitely-spinning
    // pill. wakeTimeoutMs falls back to a sane constant if the server
    // didn't publish it (pre-Task-9 server or upgrade race).
    // Frontend fallback constant — must match OBSERVER_WAKE_TIMEOUT_MS
    // on the server (council-types.ts). Used when the server's
    // `group_created` frame didn't carry the field (pre-Task-9 upgrade
    // or event-buffer replay of an older frame).
    const timeoutMs = typeof group.wakeTimeoutMs === "number" ? group.wakeTimeoutMs : 300_000;
    const expiresAt = group.lastCheckpointAt + timeoutMs;
    if (now <= expiresAt) {
      return {
        name: "reviewing",
        reviewingSince: group.lastCheckpointAt,
        phase: group.lastPhase,
        expiresAt,
      };
    }
    return {
      name: "reviewing-stalled",
      reviewingSince: group.lastCheckpointAt,
      phase: group.lastPhase,
      expiredAt: expiresAt,
    };
  }

  // Task 11 `queued-dropped`: when the most recent review came with
  // superseded checkpoint ids (server's mid-turn newest-wins queue
  // dropped one or more between previous review and this one), surface
  // it as its own state. Slots above `sleeping` (it's signal-bearing)
  // and below `reviewing` (an active review is more important than a
  // resolved one's drop note). Cleared when the next review lands clean.
  if (
    Array.isArray(group.recentlySupersededCheckpointIds) &&
    group.recentlySupersededCheckpointIds.length > 0 &&
    typeof group.lastCheckpointAt === "number" &&
    typeof group.lastPhase === "string"
  ) {
    return {
      name: "queued-dropped",
      lastCheckpointAt: group.lastCheckpointAt,
      lastPhase: group.lastPhase,
      droppedCheckpointIds: group.recentlySupersededCheckpointIds,
    };
  }

  if (group.status === "pairing") {
    return {
      name: "spawning",
      sinceMs: now,
      pairing: group.pairing,
    };
  }

  // Bidirectional pipeline Story 4.1 — convergence variants slot ABOVE
  // sleeping (signal-bearing) and BELOW degraded/blocker-found/reconnecting/
  // reviewing (active concerns dominate convergence reporting). The
  // spec's "convergence counter freezes during degraded state" semantic
  // falls out of this ordering with zero extra conditionals: `degraded`
  // already short-circuited at the top of this function.
  if (group.convergenceState === "converged"
    && typeof group.cycleNumber === "number"
    && typeof group.convergenceThreshold === "number"
  ) {
    return {
      name: "converged",
      cycleNumber: group.cycleNumber,
      threshold: group.convergenceThreshold,
    };
  }
  if ((group.convergenceState === "in-progress" || group.convergenceState === "revoked")
    && typeof group.cycleNumber === "number"
    && typeof group.convergenceThreshold === "number"
    && group.cycleNumber > 0
  ) {
    return {
      name: "cycle-progress",
      cycleNumber: group.cycleNumber,
      threshold: group.convergenceThreshold,
    };
  }

  if (typeof group.lastCheckpointAt === "number" && typeof group.lastPhase === "string") {
    return {
      name: "sleeping",
      lastCheckpointAt: group.lastCheckpointAt,
      lastPhase: group.lastPhase,
    };
  }

  return { name: "never-checkpointed-yet" };
}

/**
 * Pure helper: list STOP findings the user hasn't dismissed. Exported
 * separately so the unread-count rail (collapsed panel) and the panel
 * header derive from the same source.
 *
 * Beck F4: both the "no findings" and "some live STOPs" branches are
 * directly testable without spinning up the full state machine.
 */
export function findUnresolvedStops(
  findings: readonly ObserverFinding[],
  dismissedStopIds: ReadonlySet<string>,
): ObserverFinding[] {
  if (findings.length === 0) return [];
  const out: ObserverFinding[] = [];
  for (const f of findings) {
    if (f.severity !== "STOP") continue;
    if (f.wasDowngraded === true) continue;
    if (dismissedStopIds.has(f.id)) continue;
    out.push(f);
  }
  return out;
}

/**
 * Pure helper: total count of unresolved STOPs across EVERY group, used by
 * the browser-title alert and the Sidebar unread-rail badge.
 *
 * `findingsByGroup` is keyed by `sessionGroupId`. Iterating values rather
 * than entries keeps the helper independent of the key shape — callers may
 * pass any `Iterable<readonly ObserverFinding[]>`.
 */
export function countUnresolvedStopsAcrossGroups(
  findingsByGroup: ReadonlyMap<string, readonly ObserverFinding[]>,
  dismissedStopIds: ReadonlySet<string>,
): number {
  let total = 0;
  for (const findings of findingsByGroup.values()) {
    total += findUnresolvedStops(findings, dismissedStopIds).length;
  }
  return total;
}
