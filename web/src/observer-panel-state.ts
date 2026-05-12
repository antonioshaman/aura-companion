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
 *   4. `reviewing`            — group received a checkpoint but no review yet.
 *   5. `spawning`             — pair is still being created (no checkpoints yet).
 *   6. `sleeping`             — at least one checkpoint completed, no live STOPs.
 *   7. `never-checkpointed-yet` — group is active but no checkpoint observed yet.
 *
 * Returns `null` only when no group is supplied at all — callers render
 * "Council Mode off" UI in that case.
 *
 * Friedman council review #11 (P2#11): `spawning` and `reconnecting`
 * were added so the 10-30s pair-creation window and any WS flap don't
 * collapse silently into the idle pill.
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

  if (group.status === "degraded") {
    // The spec requires `deadRole` whenever status === "degraded". If a
    // malformed payload reached us without it, fall back to "observer"
    // (the more common death mode) rather than crash the panel — but
    // still surface degraded so the user takes action.
    return { name: "degraded", deadRole: group.deadRole ?? "observer" };
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
    return {
      name: "reviewing",
      reviewingSince: group.lastCheckpointAt,
      phase: group.lastPhase,
    };
  }

  if (group.status === "pairing") {
    return {
      name: "spawning",
      sinceMs: typeof nowMs === "number" ? nowMs : Date.now(),
      pairing: group.pairing,
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
