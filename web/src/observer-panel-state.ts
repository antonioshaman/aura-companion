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
 *   1. `degraded`         — one half of the pair is dead.
 *   2. `blocker-found`    — at least one undismissed STOP finding for this group.
 *   3. `reviewing`        — group received a checkpoint but no review yet.
 *   4. `sleeping`         — at least one checkpoint completed, no live STOPs.
 *   5. `never-checkpointed-yet` — group exists, no checkpoint observed.
 *
 * Returns `null` only when no group is supplied at all — callers render
 * "Council Mode off" UI in that case.
 */
export function deriveObserverPanelState(args: {
  group: GroupRecord | undefined;
  findings: readonly ObserverFinding[];
  /** STOP findings the user has dismissed. */
  dismissedStopIds: ReadonlySet<string>;
}): ObserverPanelState | null {
  const { group, findings, dismissedStopIds } = args;
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

  if (group.observerReviewing === true && typeof group.lastCheckpointAt === "number" && typeof group.lastPhase === "string") {
    return {
      name: "reviewing",
      reviewingSince: group.lastCheckpointAt,
      phase: group.lastPhase,
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
