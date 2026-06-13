import type { StateCreator } from "zustand";
import type { AppState } from "./index.js";
import type {
  BrowserObserverDowngrade,
  BrowserObserverFinding,
  GroupRecord,
  ObserverFinding,
  SessionGroupStatus,
  SessionRole,
} from "../types.js";
import { clearAnnouncerScope } from "../components/council/FindingsLog.js";

// ── Persistence keys & bounds ───────────────────────────────────────────────

export const COUNCIL_PANEL_OPEN_KEY = "aura-council-panel-open";
export const COUNCIL_PANEL_WIDTH_KEY = "aura-council-panel-width";
export const COUNCIL_FIRST_RUN_DISMISSED_KEY = "aura-council-first-run-dismissed";

// Internal aliases keep the inner code readable without re-introducing
// duplicate string literals; the exported constants are the surface other
// slices reach for (e.g. sessions-slice cleanup re-persisting after delete).
const PANEL_OPEN_KEY = COUNCIL_PANEL_OPEN_KEY;
const PANEL_WIDTH_KEY = COUNCIL_PANEL_WIDTH_KEY;
const FIRST_RUN_DISMISSED_KEY = COUNCIL_FIRST_RUN_DISMISSED_KEY;

/** Width bounds chosen to match TaskPanel rail density (Saarinen P8). */
export const MIN_OBSERVER_PANEL_WIDTH_PX = 240;
export const MAX_OBSERVER_PANEL_WIDTH_PX = 720;
export const DEFAULT_OBSERVER_PANEL_WIDTH_PX = 360;

function safeLocalStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function loadMapFromStorage<V>(key: string, parseValue: (v: unknown) => V | null): Map<string, V> {
  const ls = safeLocalStorage();
  if (!ls) return new Map();
  try {
    const raw = ls.getItem(key);
    if (!raw) return new Map();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Map();
    const out = new Map<string, V>();
    for (const entry of parsed) {
      if (!Array.isArray(entry) || entry.length !== 2) continue;
      const [k, v] = entry;
      if (typeof k !== "string" || k.length === 0) continue;
      const value = parseValue(v);
      if (value !== null) out.set(k, value);
    }
    return out;
  } catch {
    return new Map();
  }
}

function persistMap<V>(key: string, map: Map<string, V>): void {
  const ls = safeLocalStorage();
  if (!ls) return;
  try {
    ls.setItem(key, JSON.stringify(Array.from(map.entries())));
  } catch {
    /* quota / serialization failure — silent; not load-bearing */
  }
}

function getInitialPanelOpen(): Map<string, boolean> {
  return loadMapFromStorage(PANEL_OPEN_KEY, (v) => (typeof v === "boolean" ? v : null));
}

function getInitialPanelWidth(): Map<string, number> {
  return loadMapFromStorage(PANEL_WIDTH_KEY, (v) => {
    if (typeof v !== "number" || !Number.isFinite(v)) return null;
    return clampWidth(v);
  });
}

function getInitialFirstRunDismissed(): boolean {
  const ls = safeLocalStorage();
  if (!ls) return false;
  try {
    return ls.getItem(FIRST_RUN_DISMISSED_KEY) === "true";
  } catch {
    return false;
  }
}

/**
 * Pure: clamp a panel width into the [MIN, MAX] range. Exposed for the
 * slice and for unit tests so the clamp branch (passed-through valid value
 * vs each clamp boundary) is independently exercised.
 */
export function clampWidth(widthPx: number): number {
  if (!Number.isFinite(widthPx)) return DEFAULT_OBSERVER_PANEL_WIDTH_PX;
  if (widthPx < MIN_OBSERVER_PANEL_WIDTH_PX) return MIN_OBSERVER_PANEL_WIDTH_PX;
  if (widthPx > MAX_OBSERVER_PANEL_WIDTH_PX) return MAX_OBSERVER_PANEL_WIDTH_PX;
  return Math.floor(widthPx);
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Pure: hydrate a wire-shape `BrowserObserverFinding` into the client-side
 * `ObserverFinding` by adding browser-time bookkeeping fields. Exported
 * so the slice and tests use the same transform.
 */
export function hydrateObserverFinding(
  wire: BrowserObserverFinding,
  context: { receivedAt: number; checkpointId: string; phase: string; observerModel: string; observerProvider: string },
): ObserverFinding {
  return {
    id: wire.id,
    severity: wire.severity,
    claim: wire.claim,
    evidence_path: wire.evidence_path,
    ...(wire.evidence_lines !== undefined ? { evidence_lines: wire.evidence_lines } : {}),
    ...(wire.confidence !== undefined ? { confidence: wire.confidence } : {}),
    receivedAt: context.receivedAt,
    checkpointId: context.checkpointId,
    phase: context.phase,
    ...(wire.wasDowngraded === true ? { wasDowngraded: true } : {}),
    ...(wire.downgradeReason !== undefined ? { downgradeReason: wire.downgradeReason } : {}),
    observerModel: context.observerModel,
    observerProvider: context.observerProvider,
  };
}

// ── Slice ───────────────────────────────────────────────────────────────────

export interface CouncilSlice {
  /** Active groups keyed by `sessionGroupId`. */
  groups: Map<string, GroupRecord>;
  /**
   * Reverse index: any session id (orchestrator OR observer) → its group id.
   * Built and maintained by `upsertGroup` / `removeGroup` — never mutated
   * directly by consumers. Cheaper than scanning `groups` per render.
   */
  groupBySessionId: Map<string, string>;
  /** Findings keyed by `sessionGroupId`. Append-only within a group's lifetime. */
  findings: Map<string, ObserverFinding[]>;
  /**
   * Server-reported grounding downgrades keyed by `sessionGroupId`. Used
   * by the FindingsLog to show "this STOP was downgraded because…" annotations.
   */
  groundingDowngrades: Map<string, BrowserObserverDowngrade[]>;
  /** Open/closed state of the Observer panel keyed by orchestrator sessionId. Persisted. */
  observerPanelOpen: Map<string, boolean>;
  /** Width (px) of the Observer panel keyed by orchestrator sessionId. Persisted. */
  observerPanelWidth: Map<string, number>;
  /** True once the user has dismissed the first-run microcopy. Per-user, persisted. */
  firstRunHintDismissed: boolean;
  /** STOP finding ids the user has dismissed from the blocker banner. Per-process; not persisted. */
  dismissedStopIds: Set<string>;

  // Actions — group lifecycle
  upsertGroup: (group: GroupRecord) => void;
  /**
   * PR #68 — REST bootstrap dispatch for `GET /api/groups`. Hydrates the
   * `groups` + `groupBySessionId` maps from the server snapshot WITHOUT
   * overwriting groups already present in live state. Idempotency contract:
   *
   *   - if `sessionGroupId` not present → insert (full record)
   *   - if `sessionGroupId` already present → leave as-is (live WS wins)
   *
   * The asymmetry matters because WS-arrived records carry mutable runtime
   * fields (`lastCheckpointAt`, `observerReviewing`, `recentlySupersededCheckpointIds`,
   * `convergenceState`, etc.) that the REST snapshot does NOT include.
   * Re-overwriting from REST would clobber those fields and the panel
   * state would visibly regress for a tab that was already in sync.
   */
  hydrateGroups: (groups: GroupRecord[]) => void;
  removeGroup: (sessionGroupId: string) => void;
  setGroupStatus: (
    sessionGroupId: string,
    status: SessionGroupStatus,
    opts?: { deadRole?: SessionRole; reason?: "observer_exited" | "wake_send_failed" | "reconnect_failed" },
  ) => void;
  recordCheckpoint: (args: {
    sessionGroupId: string;
    checkpointId: string;
    phase: string;
    sequence: number;
    timestamp: number;
  }) => void;
  appendObserverReview: (args: {
    sessionGroupId: string;
    checkpointId: string;
    phase: string;
    findings: BrowserObserverFinding[];
    downgrades: BrowserObserverDowngrade[];
    observerModel: string;
    observerProvider: string;
    timestamp: number;
    /** Task 9/11: server-reported checkpoint ids dropped by the mid-turn
     *  newest-wins queue between the previous review and this one. */
    supersededCheckpointIds?: string[];
  }) => void;

  /**
   * Bidirectional pipeline Story 4.1 — server-published convergence
   * state. Apply atomically to the GroupRecord; never derived client-side.
   */
  applyConvergence: (args: {
    sessionGroupId: string;
    cycleNumber: number;
    convergenceThreshold: number;
    convergenceState: "in-progress" | "converged" | "revoked";
  }) => void;

  // Actions — panel state
  setObserverPanelOpen: (sessionId: string, open: boolean) => void;
  toggleObserverPanel: (sessionId: string) => void;
  setObserverPanelWidth: (sessionId: string, widthPx: number) => void;
  dismissFirstRunHint: () => void;
  dismissStop: (findingId: string) => void;
  // Council slice cross-slice cleanup is canonically performed inline
  // inside `sessions-slice.removeSession` (single write path; React
  // council review #12 — eliminating the parallel `cleanupCouncilForSession`
  // export the prior commit shipped unused).
}

export const createCouncilSlice: StateCreator<AppState, [], [], CouncilSlice> = (set) => ({
  groups: new Map(),
  groupBySessionId: new Map(),
  findings: new Map(),
  groundingDowngrades: new Map(),
  observerPanelOpen: getInitialPanelOpen(),
  observerPanelWidth: getInitialPanelWidth(),
  firstRunHintDismissed: getInitialFirstRunDismissed(),
  dismissedStopIds: new Set(),

  upsertGroup: (group) =>
    set((s) => {
      const groups = new Map(s.groups);
      groups.set(group.sessionGroupId, group);
      const groupBySessionId = new Map(s.groupBySessionId);
      groupBySessionId.set(group.primarySessionId, group.sessionGroupId);
      groupBySessionId.set(group.observerSessionId, group.sessionGroupId);
      // Initialize findings/downgrades buckets so consumers don't need to
      // guard on undefined.
      const findings = new Map(s.findings);
      if (!findings.has(group.sessionGroupId)) findings.set(group.sessionGroupId, []);
      const groundingDowngrades = new Map(s.groundingDowngrades);
      if (!groundingDowngrades.has(group.sessionGroupId)) groundingDowngrades.set(group.sessionGroupId, []);
      return { groups, groupBySessionId, findings, groundingDowngrades };
    }),

  hydrateGroups: (incoming) =>
    set((s) => {
      // Fast no-op path: empty REST response → no state mutation, no
      // re-render. Common in fresh-install / server-cold-start.
      if (incoming.length === 0) return {};
      const groups = new Map(s.groups);
      const groupBySessionId = new Map(s.groupBySessionId);
      const findings = new Map(s.findings);
      const groundingDowngrades = new Map(s.groundingDowngrades);
      let mutated = false;
      for (const g of incoming) {
        // Idempotent: only insert if absent — live WS wins for any group
        // already in the store. This protects mutable runtime fields
        // (lastCheckpointAt, observerReviewing, recentlySupersededCheckpointIds,
        // convergenceState) that REST does NOT carry.
        if (groups.has(g.sessionGroupId)) continue;
        groups.set(g.sessionGroupId, g);
        groupBySessionId.set(g.primarySessionId, g.sessionGroupId);
        groupBySessionId.set(g.observerSessionId, g.sessionGroupId);
        if (!findings.has(g.sessionGroupId)) findings.set(g.sessionGroupId, []);
        if (!groundingDowngrades.has(g.sessionGroupId)) groundingDowngrades.set(g.sessionGroupId, []);
        mutated = true;
      }
      // No-mutation short-circuit: every incoming group was already
      // present. Returning the same map references avoids a spurious
      // re-render that would fan out to every FindingsLog announcer /
      // Sidebar selector subscribed to council state.
      if (!mutated) return {};
      return { groups, groupBySessionId, findings, groundingDowngrades };
    }),

  removeGroup: (sessionGroupId) =>
    set((s) => {
      const existing = s.groups.get(sessionGroupId);
      const groups = new Map(s.groups);
      groups.delete(sessionGroupId);
      const groupBySessionId = new Map(s.groupBySessionId);
      if (existing) {
        groupBySessionId.delete(existing.primarySessionId);
        groupBySessionId.delete(existing.observerSessionId);
      }
      const findings = new Map(s.findings);
      findings.delete(sessionGroupId);
      const groundingDowngrades = new Map(s.groundingDowngrades);
      groundingDowngrades.delete(sessionGroupId);
      // Council Review 2026-05-13-0150 React × Fowler #15: clear the
      // FindingsLog announcer-coalescer state for this group so an
      // exited-then-recreated group doesn't inherit stale "already
      // announced" ids.
      clearAnnouncerScope(sessionGroupId);
      return { groups, groupBySessionId, findings, groundingDowngrades };
    }),

  setGroupStatus: (sessionGroupId, status, opts) =>
    set((s) => {
      const existing = s.groups.get(sessionGroupId);
      if (!existing) return {};
      const groups = new Map(s.groups);
      const next: GroupRecord = { ...existing, status };
      if (status === "degraded" && opts?.deadRole) {
        next.deadRole = opts.deadRole;
        next.degradedReason = opts.reason;
      } else if (status !== "degraded") {
        delete next.deadRole;
        delete next.degradedReason;
      }
      groups.set(sessionGroupId, next);
      return { groups };
    }),

  recordCheckpoint: ({ sessionGroupId, phase, sequence, timestamp }) =>
    set((s) => {
      const existing = s.groups.get(sessionGroupId);
      if (!existing) return {};
      // Drop out-of-order or duplicate checkpoint events — the server is
      // the seq authority; the client never advances past server sequence.
      if (typeof existing.lastCheckpointSeq === "number" && sequence <= existing.lastCheckpointSeq) {
        return {};
      }
      const groups = new Map(s.groups);
      groups.set(sessionGroupId, {
        ...existing,
        lastCheckpointAt: timestamp,
        lastCheckpointSeq: sequence,
        lastPhase: phase,
        observerReviewing: true,
      });
      return { groups };
    }),

  appendObserverReview: ({ sessionGroupId, checkpointId, phase, findings: wireFindings, downgrades, observerModel, observerProvider, timestamp, supersededCheckpointIds }) =>
    set((s) => {
      const existing = s.groups.get(sessionGroupId);
      if (!existing) return {};
      const groups = new Map(s.groups);
      // Task 11: update recentlySupersededCheckpointIds from this review.
      // Non-empty = the panel shows `queued-dropped` until the next review.
      // Omitted/empty = clear; the deriver falls through to sleeping.
      const next: GroupRecord = {
        ...existing,
        observerReviewing: false,
        ...(Array.isArray(supersededCheckpointIds) && supersededCheckpointIds.length > 0
          ? { recentlySupersededCheckpointIds: supersededCheckpointIds }
          : { recentlySupersededCheckpointIds: [] }),
      };
      groups.set(sessionGroupId, next);
      const findings = new Map(s.findings);
      const prior = findings.get(sessionGroupId) ?? [];
      const seenIds = new Set(prior.map((f) => f.id));
      const newOnes: ObserverFinding[] = [];
      for (const wire of wireFindings) {
        if (seenIds.has(wire.id)) continue; // server may re-emit on reconnect; dedup
        newOnes.push(hydrateObserverFinding(wire, { receivedAt: timestamp, checkpointId, phase, observerModel, observerProvider }));
      }
      // Council Review 2026-05-13 React #24: only write a fresh array
      // reference when there's actually new content. Server may re-emit
      // a review on reconnect (dedupe filters everything out); writing
      // a same-content fresh array forces every selector subscribed to
      // findings to re-render, including the FindingsLog summary
      // announcer's effect.
      if (newOnes.length > 0) {
        findings.set(sessionGroupId, [...prior, ...newOnes]);
      }
      const groundingDowngrades = new Map(s.groundingDowngrades);
      const priorDowngrades = groundingDowngrades.get(sessionGroupId) ?? [];
      const seenDowngradeIds = new Set(priorDowngrades.map((d) => d.id));
      const newDowngrades = downgrades.filter((d) => !seenDowngradeIds.has(d.id));
      groundingDowngrades.set(sessionGroupId, [...priorDowngrades, ...newDowngrades]);
      return { groups, findings, groundingDowngrades };
    }),

  applyConvergence: ({ sessionGroupId, cycleNumber, convergenceThreshold, convergenceState }) =>
    set((s) => {
      const existing = s.groups.get(sessionGroupId);
      if (!existing) return {};
      const groups = new Map(s.groups);
      groups.set(sessionGroupId, {
        ...existing,
        cycleNumber,
        convergenceThreshold,
        convergenceState,
      });
      return { groups };
    }),

  setObserverPanelOpen: (sessionId, open) =>
    set((s) => {
      const observerPanelOpen = new Map(s.observerPanelOpen);
      observerPanelOpen.set(sessionId, open);
      persistMap(PANEL_OPEN_KEY, observerPanelOpen);
      return { observerPanelOpen };
    }),

  toggleObserverPanel: (sessionId) =>
    set((s) => {
      const observerPanelOpen = new Map(s.observerPanelOpen);
      const current = observerPanelOpen.get(sessionId) ?? true;
      observerPanelOpen.set(sessionId, !current);
      persistMap(PANEL_OPEN_KEY, observerPanelOpen);
      return { observerPanelOpen };
    }),

  setObserverPanelWidth: (sessionId, widthPx) =>
    set((s) => {
      const observerPanelWidth = new Map(s.observerPanelWidth);
      observerPanelWidth.set(sessionId, clampWidth(widthPx));
      persistMap(PANEL_WIDTH_KEY, observerPanelWidth);
      return { observerPanelWidth };
    }),

  dismissFirstRunHint: () =>
    set(() => {
      const ls = safeLocalStorage();
      try {
        ls?.setItem(FIRST_RUN_DISMISSED_KEY, "true");
      } catch {
        /* quota — fine */
      }
      return { firstRunHintDismissed: true };
    }),

  dismissStop: (findingId) =>
    set((s) => {
      if (s.dismissedStopIds.has(findingId)) return {};
      const dismissedStopIds = new Set(s.dismissedStopIds);
      dismissedStopIds.add(findingId);
      return { dismissedStopIds };
    }),
});
