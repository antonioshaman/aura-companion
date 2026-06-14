/**
 * ObserverPanel — sibling of ChatView in the App flex/grid layout. Hosts
 * the status pill, optional DegradedBanner, optional first-run microcopy,
 * and the FindingsLog.
 *
 * PLAN T15.2:
 *  - NOT a modal / overlay. Elevation matches TaskPanel.
 *  - Five explicit states driven by `deriveObserverPanelState`:
 *    never-checkpointed-yet | sleeping | reviewing | blocker-found | degraded.
 *  - Status pill rendered from a single discriminated-union enum — never
 *    independent booleans.
 *  - Findings preview = fixed-height row per finding.
 *  - Collapsible without losing alert channel — collapsed rail still
 *    shows unread-findings count.
 *  - Persist open/width in Zustand keyed by sessionId (handled by the
 *    council slice; the panel reads + dispatches actions).
 *
 * Renders nothing when the given session is not part of a Council group.
 */

import { useCallback, useEffect, useState } from "react";
import { useStore } from "../../store.js";
import {
  DEFAULT_OBSERVER_PANEL_WIDTH_PX,
} from "../../store/council-slice.js";
import {
  deriveObserverPanelState,
  findUnresolvedStops,
} from "../../observer-panel-state.js";
import type {
  GroupRecord,
  ObserverFinding,
  ObserverPanelState,
} from "../../types.js";
import { FindingsLog, formatRelativeTime } from "./FindingsLog.js";
import { DegradedBanner } from "./DegradedBanner.js";
import { ProviderBadges } from "./ProviderBadges.js";

export interface ObserverPanelProps {
  /**
   * Orchestrator session id this panel renders for. Returns null UI when
   * the session is not in a Council group (no group, no panel).
   */
  sessionId: string;
  /** Optional callback to respawn the dead half. Wired by the integration layer. */
  onRespawnHalf?: (sessionGroupId: string) => Promise<void> | void;
  /** Optional callback when the user opens evidence for a finding. */
  onOpenEvidence?: (finding: ObserverFinding) => void;
  /** Wallclock (ms) for the status header timestamps. Defaults to Date.now(). */
  nowMs?: number;
}

function StatusPill({ state }: { state: ObserverPanelState }) {
  switch (state.name) {
    case "never-checkpointed-yet":
      return (
        <div data-testid="status-pill" data-state={state.name} className="flex items-center gap-2 text-cc-muted">
          <span aria-hidden="true" className="w-2 h-2 rounded-full bg-cc-muted/40" />
          <span className="text-xs font-medium">Awaiting first checkpoint</span>
        </div>
      );
    case "spawning":
      return (
        <div
          data-testid="status-pill"
          data-state={state.name}
          aria-busy="true"
          className="flex items-center gap-2 text-cc-info"
        >
          <span aria-hidden="true" className="w-3 h-3 rounded-full border-2 border-cc-info/30 border-t-cc-info animate-spin" />
          <span className="text-xs font-medium">Spawning observer…</span>
        </div>
      );
    case "reconnecting":
      // PLAN Task 14 (Saarinen): use `cc-info` (the in-progress / transient
      // token, same family as `spawning`) instead of `cc-warning` (which is
      // also `degraded`). Distinct visual semantics: blue ring spinning =
      // working on it; amber dot static = bad settled state.
      // PLAN Task 13 (a11y): `role="status"` makes the pill a polite live
      // region — a screen reader hears one announcement when the panel
      // transitions into reconnecting and one more when it resolves to
      // active or escalates to degraded. `aria-atomic="true"` so the whole
      // pill text is read, not just the diff. Spinner stays `aria-hidden`.
      return (
        <div
          data-testid="status-pill"
          data-state={state.name}
          role="status"
          aria-busy="true"
          aria-atomic="true"
          className="flex items-center gap-2 text-cc-info"
        >
          <span aria-hidden="true" className="w-3 h-3 rounded-full border-2 border-cc-info/30 border-t-cc-info animate-spin" />
          <span className="text-xs font-medium">Observer reconnecting</span>
        </div>
      );
    case "sleeping":
      return (
        <div data-testid="status-pill" data-state={state.name} className="flex items-center gap-2 text-cc-muted">
          <span aria-hidden="true" className="w-2 h-2 rounded-full bg-cc-muted" />
          <span className="text-xs font-medium">Sleeping</span>
          <span className="text-[10px] font-mono-code">·</span>
          <span className="text-[10px] font-mono-code">{state.lastPhase}</span>
        </div>
      );
    case "reviewing":
      return (
        <div
          data-testid="status-pill"
          data-state={state.name}
          aria-busy="true"
          className="flex items-center gap-2 text-cc-primary"
        >
          <span aria-hidden="true" className="w-2 h-2 rounded-full bg-cc-primary animate-pulse" />
          <span className="text-xs font-medium">Reviewing</span>
          <span className="text-[10px] font-mono-code text-cc-muted">·</span>
          <span className="text-[10px] font-mono-code text-cc-muted">{state.phase}</span>
        </div>
      );
    case "blocker-found":
      return (
        <div data-testid="status-pill" data-state={state.name} className="flex items-center gap-2 text-cc-error">
          <span aria-hidden="true" className="w-2 h-2 rounded-full bg-cc-error" />
          <span className="text-xs font-medium">Blocker found</span>
          <span className="text-[10px] font-mono-code text-cc-muted">·</span>
          <span className="text-[10px] font-mono-code text-cc-muted">
            {state.unresolvedStops} unresolved
          </span>
        </div>
      );
    case "degraded": {
      // #14: add role="status" + aria-atomic="true" matching sibling branches so
      // screen-readers announce the degraded transition.
      // #15: vary the secondary qualifier (·-separated) by degraded reason so the
      // three causes are distinguishable without changing the primary label.
      const degradedSecondary = (() => {
        if (state.reason === "observer_exited") return "exited";
        if (state.reason === "wake_send_failed") return "wake failed";
        if (state.reason === "wake_produced_no_review") return "no review";
        if (state.reason === "reconnect_failed") return "reconnect failed";
        return null;
      })();
      return (
        <div
          data-testid="status-pill"
          data-state={state.name}
          role="status"
          aria-atomic="true"
          className="flex items-center gap-2"
        >
          {/* #14: warning dot keeps amber tint; label text uses cc-fg for WCAG AA contrast */}
          <span aria-hidden="true" className="w-2 h-2 rounded-full bg-cc-warning" />
          <span className="text-xs font-medium text-cc-fg">{state.deadRole === "observer" ? "Observer offline" : "Orchestrator offline"}</span>
          {degradedSecondary && (
            <>
              <span className="text-[10px] font-mono-code text-cc-muted">·</span>
              <span className="text-[10px] font-mono-code text-cc-muted">{degradedSecondary}</span>
            </>
          )}
        </div>
      );
    }
    // Council Review 2026-05-13 Friedman #5 (closes recovery-branch-
    // reachability cluster, convention EC-10): exhaustive case for the
    // two new state variants added in Task 11. The TS `never` check
    // below refuses to compile when a future variant lands without a
    // matching renderer.
    case "reviewing-stalled":
      // Council Review 2026-05-13-0150 Friedman #10: stalled state must
      // offer a next-step action. The pill itself stays declarative;
      // the surrounding `DegradedBanner`-style banner pattern in
      // ObserverPanel exposes a "Relaunch observer" button. The pill
      // copy now hints that user action may be needed.
      return (
        <div
          data-testid="status-pill"
          data-state={state.name}
          role="status"
          aria-atomic="true"
          className="flex items-center gap-2 text-cc-warning"
          title={`Observer wake exceeded its timeout for phase ${state.phase}. The pair may be stuck — consider relaunching the observer.`}
          aria-label={`Observer wake exceeded its timeout for phase ${state.phase}. The pair may be stuck — consider relaunching the observer.`}
        >
          <span aria-hidden="true" className="w-2 h-2 rounded-full bg-cc-warning" />
          <span className="text-xs font-medium">Review stalled — relaunch?</span>
          <span className="text-[10px] font-mono-code text-cc-muted">·</span>
          <span className="text-[10px] font-mono-code text-cc-muted">{state.phase}</span>
        </div>
      );
    case "queued-dropped": {
      // Council Review 2026-05-13-0150 Friedman #9: explicit copy +
      // tooltip drill-down. The user needs to know WHAT was skipped
      // (earlier checkpoints) and that those are deliberate supersedes
      // (newest-wins queue), not a missed review.
      const droppedCount = state.droppedCheckpointIds.length;
      const dropList = state.droppedCheckpointIds.join(", ");
      const tooltip = `Server's mid-turn queue replaced ${droppedCount} earlier checkpoint${droppedCount === 1 ? "" : "s"} with the latest one before review. Superseded: ${dropList}.`;
      return (
        <div
          data-testid="status-pill"
          data-state={state.name}
          role="status"
          aria-atomic="true"
          className="flex items-center gap-2 text-cc-info"
          title={tooltip}
          aria-label={tooltip}
        >
          <span aria-hidden="true" className="w-2 h-2 rounded-full bg-cc-info" />
          <span className="text-xs font-medium">
            Reviewed {state.lastPhase} ({droppedCount} earlier superseded)
          </span>
        </div>
      );
    }
    case "cycle-progress": {
      // Bidirectional pipeline Story 4.1.5: clean-cycle progress badge.
      // Pill copy "Cycle N/T" — emoji `aria-hidden`, accessible text
      // carries the same signal so screen readers don't double-read.
      // role="status" + aria-atomic so each transition is announced
      // exactly once (WCAG 4.1.3 status messages).
      const accessibleLabel = `Cycle ${state.cycleNumber} of ${state.threshold}`;
      return (
        <div
          data-testid="status-pill"
          data-state={state.name}
          role="status"
          aria-atomic="true"
          aria-label={accessibleLabel}
          className="flex items-center gap-2 text-cc-info"
        >
          <span aria-hidden="true">🔄</span>
          <span className="text-xs font-medium">
            Cycle {state.cycleNumber}/{state.threshold}
          </span>
        </div>
      );
    }
    case "converged": {
      // Bidirectional pipeline Story 4.1.5: pair has reached threshold.
      // Emerald-500 token (Tailwind's `emerald-500`) signals "ship-ready".
      // Click target is the entire pill so an operator can drill into
      // the final review via the parent ObserverPanel's click handler
      // (popover wiring deferred — pill itself stays declarative).
      const accessibleLabel = `Converged — ready to ship after ${state.cycleNumber} clean cycles`;
      return (
        <div
          data-testid="status-pill"
          data-state={state.name}
          role="status"
          aria-atomic="true"
          aria-label={accessibleLabel}
          className="flex items-center gap-2 text-emerald-500"
        >
          <span aria-hidden="true">✅</span>
          <span className="text-xs font-medium">
            Converged — ready to ship
          </span>
          <span className="text-[10px] font-mono-code text-cc-muted">·</span>
          <span className="text-[10px] font-mono-code text-cc-muted">
            {state.cycleNumber}/{state.threshold}
          </span>
        </div>
      );
    }
    default: {
      // EC-10: TypeScript exhaustiveness check. Adding a new
      // ObserverPanelState variant without extending this switch is a
      // compile-time error rather than a silent empty-pill render.
      const _exhaustive: never = state;
      void _exhaustive;
      return null;
    }
  }
}

function CollapsedRail({
  unresolvedCount,
  onExpand,
}: {
  unresolvedCount: number;
  onExpand: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onExpand}
      aria-label={
        unresolvedCount > 0
          ? `Expand observer panel — ${unresolvedCount} unresolved blocker${unresolvedCount === 1 ? "" : "s"}`
          : "Expand observer panel"
      }
      data-testid="observer-panel-rail"
      className="h-full flex flex-col items-center justify-center gap-2 px-2 border-l border-cc-border bg-cc-card text-cc-muted hover:text-cc-fg transition-colors cursor-pointer"
    >
      <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5" aria-hidden="true">
        <path d="M3 2.5A1.5 1.5 0 014.5 1h7A1.5 1.5 0 0113 2.5v11a1.5 1.5 0 01-1.5 1.5h-7A1.5 1.5 0 013 13.5v-11zm2 .5v10h6V3H5z" />
      </svg>
      {unresolvedCount > 0 && (
        <span
          data-testid="observer-panel-rail-counter"
          className="text-[10px] font-semibold leading-none px-1 py-0.5 rounded bg-cc-error/15 text-cc-error border border-cc-error/25 min-w-[18px] text-center"
        >
          {unresolvedCount}
        </span>
      )}
      <span className="[writing-mode:vertical-rl] rotate-180 tracking-wide text-[11px]">Observer</span>
    </button>
  );
}

export function ObserverPanel({
  sessionId,
  onRespawnHalf,
  onOpenEvidence,
  nowMs,
}: ObserverPanelProps) {
  // Read store state — selectors keep re-renders narrow.
  const groupId = useStore((s) => s.groupBySessionId.get(sessionId));
  const group: GroupRecord | undefined = useStore((s) => (groupId ? s.groups.get(groupId) : undefined));
  const findings = useStore((s) => (groupId ? s.findings.get(groupId) : undefined)) ?? [];
  const dismissedStopIds = useStore((s) => s.dismissedStopIds);
  const open = useStore((s) => s.observerPanelOpen.get(sessionId) ?? true);
  const width = useStore((s) => s.observerPanelWidth.get(sessionId) ?? DEFAULT_OBSERVER_PANEL_WIDTH_PX);
  const firstRunDismissed = useStore((s) => s.firstRunHintDismissed);
  const setOpen = useStore((s) => s.setObserverPanelOpen);
  const dismissStop = useStore((s) => s.dismissStop);
  const dismissFirstRunHint = useStore((s) => s.dismissFirstRunHint);

  const handleExpand = useCallback(() => setOpen(sessionId, true), [sessionId, setOpen]);
  const handleCollapse = useCallback(() => setOpen(sessionId, false), [sessionId, setOpen]);
  const handleRespawn = useCallback(async () => {
    if (group && onRespawnHalf) await onRespawnHalf(group.sessionGroupId);
  }, [group, onRespawnHalf]);

  // Council Review 2026-05-13 React/Web UI #4 (closes recovery-branch-
  // reachability cluster, convention EC-11): the deriver's
  // `reviewing → reviewing-stalled` transition is wallclock-anchored on
  // `lastCheckpointAt + wakeTimeoutMs`. Pure derivation re-runs only on
  // state changes; without an explicit clock-tick subscription, the
  // transition would only fire coincidentally after an unrelated event.
  //
  // While the panel sits in `reviewing` (server says observer is mid-
  // turn), tick once per second so the deriver gets a chance to flip
  // to `reviewing-stalled` past the deadline. Cleared when the panel
  // leaves `reviewing`. Test paths supply `nowMs` explicitly so the
  // interval is harmless there.
  const [clockTick, setClockTick] = useState(0);
  const isReviewingNow = group?.observerReviewing === true && typeof group?.lastCheckpointAt === "number";
  useEffect(() => {
    if (!isReviewingNow) return;
    const handle = setInterval(() => setClockTick((t) => t + 1), 1000);
    return () => clearInterval(handle);
  }, [isReviewingNow]);
  // Reference clockTick so the linter/runtime acknowledge the dep; the
  // re-render itself is the point — value unused otherwise.
  void clockTick;

  // Nothing to render when this session isn't in a Council group.
  if (!group) return null;

  // Task 11: forward `nowMs` to the deriver so the `reviewing` →
  // `reviewing-stalled` transition is deterministic — the wakeTimeoutMs
  // bound is wallclock-anchored on `lastCheckpointAt`, and callers that
  // need deterministic snapshots (tests, replay tooling) must control
  // the same clock reference the deriver consumes.
  const state = deriveObserverPanelState({ group, findings, dismissedStopIds, nowMs });
  if (!state) return null;

  const unresolvedCount = findUnresolvedStops(findings, dismissedStopIds).length;

  if (!open) {
    return <CollapsedRail unresolvedCount={unresolvedCount} onExpand={handleExpand} />;
  }

  return (
    <aside
      data-testid="observer-panel"
      data-state={state.name}
      aria-label="Observer panel"
      style={{ width: `${width}px` }}
      className="h-full flex flex-col border-l border-cc-border bg-cc-card"
    >
      {/* Header */}
      <div className="shrink-0 px-3 py-2.5 border-b border-cc-border bg-cc-card flex items-center gap-2">
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <span className="text-[10px] uppercase tracking-wider font-mono-code text-cc-muted">Observer</span>
          <ProviderBadges pairing={group.pairing} size="compact" />
        </div>
        <button
          type="button"
          onClick={handleCollapse}
          aria-label="Collapse observer panel"
          className="text-cc-muted hover:text-cc-fg p-1 rounded cursor-pointer"
        >
          <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5" aria-hidden="true">
            <path d="M11 3.5L7 8l4 4.5V3.5z" />
          </svg>
        </button>
      </div>

      {/* Status row + last-checkpoint timestamp */}
      <div className="shrink-0 px-3 py-2 border-b border-cc-border flex items-center justify-between gap-2">
        <StatusPill state={state} />
        {(state.name === "sleeping" || state.name === "reviewing") && (
          <span className="text-[10px] text-cc-muted font-mono-code" data-testid="header-timestamp">
            {formatRelativeTime(
              state.name === "sleeping" ? state.lastCheckpointAt : state.reviewingSince,
              typeof nowMs === "number" ? nowMs : Date.now(),
            )}
          </span>
        )}
      </div>

      {/* Degraded banner — lives in the header, NOT in the composer slot. */}
      {state.name === "degraded" && onRespawnHalf && (
        <DegradedBanner deadRole={state.deadRole} reason={state.reason} onRespawn={handleRespawn} />
      )}

      {/* Council Review 2026-05-13-0150 Friedman #10: stalled state next-
          step affordance. Mirrors DegradedBanner shape — same Relaunch
          action target. The user landed here after waiting >wakeTimeoutMs
          (default 5 min); offer the recovery path explicitly. */}
      {state.name === "reviewing-stalled" && onRespawnHalf && (
        <div
          data-testid="reviewing-stalled-banner"
          className="shrink-0 px-3 py-2.5 border-b border-cc-warning/25 bg-cc-warning/10 flex items-center gap-3"
        >
          <div className="flex-1 text-xs text-cc-fg leading-snug">
            <div className="font-medium">Review stalled</div>
            <div className="text-cc-muted">
              No review for phase {state.phase} in the expected window. Observer may be stuck.
            </div>
          </div>
          {/* #14/#15: button text uses text-cc-fg (not text-cc-warning) to meet WCAG AA contrast;
              warning tint stays on the background so the warning identity is preserved. */}
          <button
            type="button"
            onClick={handleRespawn}
            data-council-stalled-primary=""
            className="text-xs font-medium px-3 py-1.5 rounded-md bg-cc-warning/20 hover:bg-cc-warning/30 text-cc-fg border border-cc-warning/30 transition-colors cursor-pointer"
          >
            Relaunch observer
          </button>
        </div>
      )}

      {/* First-run microcopy (dismissable, per-user) */}
      {!firstRunDismissed && (
        <div className="shrink-0 px-3 py-2.5 border-b border-cc-border bg-cc-info/5">
          <p className="text-xs text-cc-fg leading-snug">
            This panel shows a second AI reviewing the orchestrator&apos;s work. It only interrupts you for blockers.
          </p>
          <button
            type="button"
            onClick={dismissFirstRunHint}
            className="mt-2 text-xs text-cc-info hover:text-cc-fg cursor-pointer font-medium"
          >
            Got it
          </button>
        </div>
      )}

      {/* Findings */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        <FindingsLog
          findings={findings}
          nowMs={nowMs}
          onSelect={onOpenEvidence}
          onDismissStop={dismissStop}
          dismissedStopIds={dismissedStopIds}
          announcerScope={group.sessionGroupId}
        />
      </div>
    </aside>
  );
}
