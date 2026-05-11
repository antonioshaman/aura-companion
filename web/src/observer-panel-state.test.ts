import { describe, expect, it } from "vitest";
import {
  countUnresolvedStopsAcrossGroups,
  deriveObserverPanelState,
  findUnresolvedStops,
} from "./observer-panel-state.js";
import type { GroupRecord, ObserverFinding } from "./types.js";

function group(overrides: Partial<GroupRecord> = {}): GroupRecord {
  return {
    sessionGroupId: "grp_test",
    primarySessionId: "sess_orch",
    observerSessionId: "sess_obs",
    status: "active",
    pairing: "claude+claude",
    ...overrides,
  };
}

function finding(overrides: Partial<ObserverFinding> = {}): ObserverFinding {
  return {
    id: "fnd_1",
    severity: "NOTE",
    claim: "test",
    evidence_path: "src/foo.ts",
    receivedAt: 1_000,
    checkpointId: "chk_1",
    phase: "council-plan",
    observerModel: "claude-opus-4-7",
    observerProvider: "claude",
    ...overrides,
  };
}

// ── findUnresolvedStops ─────────────────────────────────────────────────────

describe("findUnresolvedStops", () => {
  // Beck F4 — happy path with mixed severities. Only undismissed,
  // non-downgraded STOPs make the cut.
  it("returns only undismissed non-downgraded STOPs", () => {
    const all = [
      finding({ id: "f1", severity: "STOP" }),
      finding({ id: "f2", severity: "NOTE" }),
      finding({ id: "f3", severity: "STOP", wasDowngraded: true, downgradeReason: "evidence_missing_on_disk" }),
      finding({ id: "f4", severity: "STOP" }),
      finding({ id: "f5", severity: "WARN" }),
    ];
    const out = findUnresolvedStops(all, new Set(["f4"]));
    expect(out.map((f) => f.id)).toEqual(["f1"]);
  });

  // Beck F4 — empty case (early-return branch).
  it("returns an empty array when findings list is empty", () => {
    expect(findUnresolvedStops([], new Set())).toEqual([]);
  });

  it("returns an empty array when no findings are STOP", () => {
    expect(findUnresolvedStops([finding({ severity: "NOTE" }), finding({ severity: "INFO" })], new Set())).toEqual([]);
  });

  it("returns an empty array when every STOP is dismissed", () => {
    const f1 = finding({ id: "a", severity: "STOP" });
    const f2 = finding({ id: "b", severity: "STOP" });
    expect(findUnresolvedStops([f1, f2], new Set(["a", "b"]))).toEqual([]);
  });

  it("returns an empty array when every STOP was server-downgraded", () => {
    const f = finding({ id: "a", severity: "STOP", wasDowngraded: true, downgradeReason: "evidence_not_in_modified_set" });
    expect(findUnresolvedStops([f], new Set())).toEqual([]);
  });
});

// ── deriveObserverPanelState ───────────────────────────────────────────────

describe("deriveObserverPanelState", () => {
  // No group → null. UI renders "Council Mode off" affordance instead.
  it("returns null when no group is provided", () => {
    expect(deriveObserverPanelState({ group: undefined, findings: [], dismissedStopIds: new Set() })).toBeNull();
  });

  // Highest-priority branch: degraded wins over everything else, even
  // a still-pending blocker. UI must show "respawn observer" affordance
  // before chasing findings (PLAN watchpoint Friedman + Saarinen).
  it("returns 'degraded' when status is degraded, regardless of findings", () => {
    const g = group({ status: "degraded", deadRole: "observer" });
    const live = finding({ id: "blocker", severity: "STOP" });
    const out = deriveObserverPanelState({ group: g, findings: [live], dismissedStopIds: new Set() });
    expect(out).toEqual({ name: "degraded", deadRole: "observer" });
  });

  // Defensive default: a malformed degraded payload missing deadRole
  // should still degrade the UI rather than fall through to "sleeping"
  // (which would hide the problem).
  it("falls back to 'observer' deadRole on a degraded payload with no deadRole field", () => {
    const out = deriveObserverPanelState({ group: group({ status: "degraded" }), findings: [], dismissedStopIds: new Set() });
    expect(out).toEqual({ name: "degraded", deadRole: "observer" });
  });

  // Second-priority branch: an undismissed STOP forces blocker-found.
  it("returns 'blocker-found' when at least one undismissed STOP exists", () => {
    const g = group({
      status: "active",
      lastCheckpointAt: 1_000,
      lastCheckpointSeq: 0,
      lastPhase: "council-plan",
    });
    const findings = [
      finding({ id: "f1", severity: "STOP", receivedAt: 500 }),
      finding({ id: "f2", severity: "STOP", receivedAt: 1_500 }),
    ];
    const out = deriveObserverPanelState({ group: g, findings, dismissedStopIds: new Set() });
    expect(out).toEqual({ name: "blocker-found", unresolvedStops: 2, lastBlockerAt: 1_500 });
  });

  // Dismissed STOPs collapse panel back to whatever the next-priority state is.
  it("collapses to 'sleeping' when every STOP is dismissed and a checkpoint exists", () => {
    const g = group({
      status: "active",
      lastCheckpointAt: 1_000,
      lastCheckpointSeq: 1,
      lastPhase: "council-plan",
    });
    const findings = [finding({ id: "f1", severity: "STOP", receivedAt: 1_500 })];
    const out = deriveObserverPanelState({ group: g, findings, dismissedStopIds: new Set(["f1"]) });
    expect(out).toEqual({ name: "sleeping", lastCheckpointAt: 1_000, lastPhase: "council-plan" });
  });

  // Third-priority branch: observerReviewing flag → reviewing.
  it("returns 'reviewing' when observerReviewing is true and a checkpoint is recorded", () => {
    const g = group({
      status: "active",
      lastCheckpointAt: 2_000,
      lastCheckpointSeq: 1,
      lastPhase: "council-implement",
      observerReviewing: true,
    });
    const out = deriveObserverPanelState({ group: g, findings: [], dismissedStopIds: new Set() });
    expect(out).toEqual({ name: "reviewing", reviewingSince: 2_000, phase: "council-implement" });
  });

  // observerReviewing without a checkpoint shouldn't paint 'reviewing'
  // — there's no phase to display. Falls back to 'never-checkpointed-yet'.
  it("falls back to 'never-checkpointed-yet' when observerReviewing is true but no checkpoint recorded", () => {
    const out = deriveObserverPanelState({
      group: group({ observerReviewing: true }),
      findings: [],
      dismissedStopIds: new Set(),
    });
    expect(out).toEqual({ name: "never-checkpointed-yet" });
  });

  // Fourth-priority branch: at-rest after at least one checkpoint.
  it("returns 'sleeping' when a checkpoint exists, no live STOPs, observer not reviewing", () => {
    const g = group({
      status: "active",
      lastCheckpointAt: 3_000,
      lastCheckpointSeq: 2,
      lastPhase: "council-review",
    });
    const out = deriveObserverPanelState({ group: g, findings: [], dismissedStopIds: new Set() });
    expect(out).toEqual({ name: "sleeping", lastCheckpointAt: 3_000, lastPhase: "council-review" });
  });

  // Fifth-priority / default: pair just created, no activity yet.
  it("returns 'never-checkpointed-yet' for a fresh group with no checkpoint", () => {
    const out = deriveObserverPanelState({
      group: group({ status: "pairing" }),
      findings: [],
      dismissedStopIds: new Set(),
    });
    expect(out).toEqual({ name: "never-checkpointed-yet" });
  });

  // archived groups don't render a panel header at all (caller checks
  // status first); but if asked, they fall through to never-checkpointed
  // rather than throw.
  it("does not throw on an archived group with no checkpoint", () => {
    const out = deriveObserverPanelState({
      group: group({ status: "archived" }),
      findings: [],
      dismissedStopIds: new Set(),
    });
    expect(out).toEqual({ name: "never-checkpointed-yet" });
  });
});

// ── countUnresolvedStopsAcrossGroups ───────────────────────────────────────

describe("countUnresolvedStopsAcrossGroups", () => {
  // Beck F4 — empty input branch.
  it("returns 0 for an empty group map", () => {
    expect(countUnresolvedStopsAcrossGroups(new Map(), new Set())).toBe(0);
  });

  // Multi-group sum — the whole point of the helper. Each group
  // contributes its undismissed non-downgraded STOPs to the total.
  it("sums undismissed STOPs across multiple groups", () => {
    const map = new Map<string, ObserverFinding[]>([
      ["grp_a", [
        finding({ id: "a1", severity: "STOP" }),
        finding({ id: "a2", severity: "STOP" }),
        finding({ id: "a3", severity: "NOTE" }),
      ]],
      ["grp_b", [
        finding({ id: "b1", severity: "STOP" }),
        finding({ id: "b2", severity: "STOP", wasDowngraded: true, downgradeReason: "evidence_missing_on_disk" }),
      ]],
      ["grp_c", []],
    ]);
    // Total live STOPs across all groups: a1, a2, b1 → 3. b2 was server-downgraded.
    expect(countUnresolvedStopsAcrossGroups(map, new Set())).toBe(3);
  });

  it("excludes dismissed STOPs from the global count", () => {
    const map = new Map<string, ObserverFinding[]>([
      ["grp_a", [finding({ id: "a1", severity: "STOP" })]],
      ["grp_b", [finding({ id: "b1", severity: "STOP" })]],
    ]);
    expect(countUnresolvedStopsAcrossGroups(map, new Set(["a1"]))).toBe(1);
  });

  it("returns 0 when every group has only NOTE/WARN/INFO findings", () => {
    const map = new Map<string, ObserverFinding[]>([
      ["grp_a", [finding({ severity: "NOTE" }), finding({ severity: "WARN" })]],
      ["grp_b", [finding({ severity: "INFO" })]],
    ]);
    expect(countUnresolvedStopsAcrossGroups(map, new Set())).toBe(0);
  });
});
