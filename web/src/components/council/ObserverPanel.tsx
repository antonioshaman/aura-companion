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

import { useCallback } from "react";
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
      return (
        <div
          data-testid="status-pill"
          data-state={state.name}
          aria-busy="true"
          className="flex items-center gap-2 text-cc-warning"
        >
          <span aria-hidden="true" className="w-3 h-3 rounded-full border-2 border-cc-warning/30 border-t-cc-warning animate-spin" />
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
    case "degraded":
      return (
        <div data-testid="status-pill" data-state={state.name} className="flex items-center gap-2 text-cc-warning">
          <span aria-hidden="true" className="w-2 h-2 rounded-full bg-cc-warning" />
          <span className="text-xs font-medium">{state.deadRole === "observer" ? "Observer offline" : "Orchestrator offline"}</span>
        </div>
      );
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

  // Nothing to render when this session isn't in a Council group.
  if (!group) return null;

  const state = deriveObserverPanelState({ group, findings, dismissedStopIds });
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
        <DegradedBanner deadRole={state.deadRole} onRespawn={handleRespawn} />
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
        />
      </div>
    </aside>
  );
}
