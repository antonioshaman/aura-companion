/**
 * Convergence tracker — pure-function + live-wiring coverage.
 *
 * Bidirectional pipeline Story 4.1 acceptance criteria:
 *   - 3 consecutive 0-STOP reviews → `converged` checkpoint emitted
 *   - ANY STOP after convergence → `revoked` + counter reset
 *   - `degraded` group status freezes the counter (no advance, no reset)
 *
 * Verifier methodology anchors:
 *   - feedback_verify_test_bodies_not_just_names — assert exact call
 *     counts AND payload, not just `toHaveBeenCalled`.
 *   - feedback_parallel_test_fakes_keyed_by_input — fake state is keyed
 *     by sessionGroupId, not a counter, so re-ordering doesn't flake.
 *   - feedback_recovery_branch_reachability — every transition in the
 *     pure-function table is exercised, including the no-op cases.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  ConvergenceTracker,
  DEFAULT_CONVERGENCE_THRESHOLD,
  MAX_CONVERGENCE_THRESHOLD,
  MIN_CONVERGENCE_THRESHOLD,
  clampThreshold,
  initialConvergenceState,
  nextStateAfterReview,
  reviewHasStop,
  reviewNotCountedReason,
} from "./convergence-tracker.js";
import { companionBus } from "./event-bus.js";
import type { BrowserObserverFinding } from "./session-types.js";

function findings(severity: "STOP" | "WARN" | "NOTE" | "INFO" | "CLEAN"): BrowserObserverFinding[] {
  if (severity === "CLEAN") return [];
  return [{
    id: "fnd_test",
    severity: severity as "STOP" | "WARN" | "NOTE" | "INFO",
    claim: "test finding",
    evidence_path: "web/server/x.ts",
  }];
}

describe("clampThreshold", () => {
  it("snaps to default for non-finite input", () => {
    expect(clampThreshold(Number.NaN)).toBe(DEFAULT_CONVERGENCE_THRESHOLD);
    expect(clampThreshold(Number.POSITIVE_INFINITY)).toBe(DEFAULT_CONVERGENCE_THRESHOLD);
  });
  it("rejects below MIN and above MAX", () => {
    expect(clampThreshold(0)).toBe(MIN_CONVERGENCE_THRESHOLD);
    expect(clampThreshold(1)).toBe(MIN_CONVERGENCE_THRESHOLD);
    expect(clampThreshold(99)).toBe(MAX_CONVERGENCE_THRESHOLD);
  });
  it("truncates fractional input", () => {
    expect(clampThreshold(3.9)).toBe(3);
  });
  it("preserves valid range", () => {
    expect(clampThreshold(2)).toBe(2);
    expect(clampThreshold(3)).toBe(3);
    expect(clampThreshold(5)).toBe(5);
  });
});

describe("reviewHasStop", () => {
  it("returns true when any finding is STOP", () => {
    expect(reviewHasStop(findings("STOP"))).toBe(true);
  });
  it("returns false for WARN/NOTE/INFO/empty", () => {
    expect(reviewHasStop(findings("WARN"))).toBe(false);
    expect(reviewHasStop(findings("NOTE"))).toBe(false);
    expect(reviewHasStop(findings("INFO"))).toBe(false);
    expect(reviewHasStop(findings("CLEAN"))).toBe(false);
  });
});

describe("nextStateAfterReview — pure transitions", () => {
  it("clean review increments counter and emits cycle-progress (1/3)", () => {
    const prev = initialConvergenceState();
    const { next, emit } = nextStateAfterReview(prev, /*hasStop*/ false);
    expect(emit).toBe("cycle-progress");
    expect(next.cleanCycleCount).toBe(1);
    expect(next.convergenceState).toBe("in-progress");
  });

  it("reaches converged at threshold", () => {
    let s = initialConvergenceState(3);
    const emits: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = nextStateAfterReview(s, false);
      s = r.next;
      emits.push(r.emit);
    }
    expect(emits).toEqual(["cycle-progress", "cycle-progress", "converged"]);
    expect(s.cleanCycleCount).toBe(3);
    expect(s.convergenceState).toBe("converged");
  });

  it("STOP after converged emits revoked and resets to 0", () => {
    const converged = { ...initialConvergenceState(3), cleanCycleCount: 3, convergenceState: "converged" as const };
    const { next, emit } = nextStateAfterReview(converged, true);
    expect(emit).toBe("revoked");
    expect(next.cleanCycleCount).toBe(0);
    expect(next.convergenceState).toBe("revoked");
  });

  it("STOP mid-cycle (counter > 0) emits cycle-progress with new 0", () => {
    const partway = { ...initialConvergenceState(3), cleanCycleCount: 2 };
    const { next, emit } = nextStateAfterReview(partway, true);
    expect(emit).toBe("cycle-progress");
    expect(next.cleanCycleCount).toBe(0);
    expect(next.convergenceState).toBe("in-progress");
  });

  it("STOP at counter 0 emits noop (no UI change)", () => {
    const fresh = initialConvergenceState(3);
    const { next, emit } = nextStateAfterReview(fresh, true);
    expect(emit).toBe("noop");
    expect(next.cleanCycleCount).toBe(0);
  });

  it("frozen=true blocks ALL transitions (counter freeze under degraded)", () => {
    const prev = { ...initialConvergenceState(3), cleanCycleCount: 1 };
    // Clean review while frozen: counter does NOT advance
    const r1 = nextStateAfterReview(prev, false, /*frozen*/ true);
    expect(r1.emit).toBe("noop");
    expect(r1.next.cleanCycleCount).toBe(1);
    // STOP while frozen: counter does NOT reset
    const r2 = nextStateAfterReview(prev, true, /*frozen*/ true);
    expect(r2.emit).toBe("noop");
    expect(r2.next.cleanCycleCount).toBe(1);
  });

  it("respects custom threshold (2 — minimum)", () => {
    let s = initialConvergenceState(2);
    const r1 = nextStateAfterReview(s, false);
    s = r1.next;
    expect(r1.emit).toBe("cycle-progress");
    const r2 = nextStateAfterReview(s, false);
    expect(r2.emit).toBe("converged");
    expect(r2.next.cleanCycleCount).toBe(2);
  });
});

describe("ConvergenceTracker — live bus wiring", () => {
  beforeEach(() => {
    // Per-test bus isolation — `attach()` adds to companionBus directly,
    // and we don't want a stale listener from a prior test seeing this
    // test's payloads.
    companionBus.clear();
  });

  it("emits group:convergence on each clean review until threshold, then converged", () => {
    // Keyed-by-input fake: capture emits by sessionGroupId so a future
    // multi-group flow doesn't flake on call-counter ordering
    // (feedback_parallel_test_fakes_keyed_by_input).
    const seen: Array<{ sid: string; transition: string; cycleNumber: number }> = [];
    companionBus.on("group:convergence", (p) => {
      seen.push({ sid: p.sessionGroupId, transition: p.transition, cycleNumber: p.cycleNumber });
    });

    const tracker = new ConvergenceTracker({ isFrozen: () => false });
    tracker.attach();

    for (let i = 0; i < 3; i++) {
      companionBus.emit("group:review", {
        sessionGroupId: "grp-A",
        checkpointId: `cp-${i}`,
        phase: "council-implement",
        findings: [],
        downgrades: [],
        observerModel: "test",
        observerProvider: "claude",
        artifactsChanged: 1,
        artifactsRead: 1,
      });
    }

    // 3 clean reviews → cycle-progress, cycle-progress, converged
    expect(seen).toHaveLength(3);
    expect(seen[0]).toEqual({ sid: "grp-A", transition: "cycle-progress", cycleNumber: 1 });
    expect(seen[1]).toEqual({ sid: "grp-A", transition: "cycle-progress", cycleNumber: 2 });
    expect(seen[2]).toEqual({ sid: "grp-A", transition: "converged", cycleNumber: 3 });

    tracker.detach();
  });

  it("a STOP after convergence emits revoked + resets counter; next clean cycle starts at 1", () => {
    const seen: Array<{ transition: string; cycleNumber: number }> = [];
    companionBus.on("group:convergence", (p) => {
      seen.push({ transition: p.transition, cycleNumber: p.cycleNumber });
    });

    const tracker = new ConvergenceTracker({ isFrozen: () => false });
    tracker.attach();

    // Force a converged state by driving 3 clean reviews
    for (let i = 0; i < 3; i++) {
      companionBus.emit("group:review", {
        sessionGroupId: "grp-B",
        checkpointId: `cp-${i}`,
        phase: "council-implement",
        findings: [],
        downgrades: [],
        observerModel: "test",
        observerProvider: "claude",
        artifactsChanged: 1,
        artifactsRead: 1,
      });
    }

    // Then a 4th review carrying a STOP — must trigger revoked
    companionBus.emit("group:review", {
      sessionGroupId: "grp-B",
      checkpointId: "cp-3",
      phase: "council-review",
      findings: findings("STOP"),
      downgrades: [],
      observerModel: "test",
      observerProvider: "claude",
      artifactsChanged: 1,
      artifactsRead: 1,
    });

    // 5th review clean — counter must be back at 1, NOT 4
    companionBus.emit("group:review", {
      sessionGroupId: "grp-B",
      checkpointId: "cp-4",
      phase: "council-implement",
      findings: [],
      downgrades: [],
      observerModel: "test",
      observerProvider: "claude",
      artifactsChanged: 1,
      artifactsRead: 1,
    });

    expect(seen.map((s) => s.transition)).toEqual([
      "cycle-progress",
      "cycle-progress",
      "converged",
      "revoked",
      "cycle-progress",
    ]);
    expect(seen[3]!.cycleNumber).toBe(0);
    expect(seen[4]!.cycleNumber).toBe(1);

    tracker.detach();
  });

  it("freezes counter when isFrozen returns true (Story 4.1.5 degraded freeze)", () => {
    const seen: Array<{ transition: string; cycleNumber: number }> = [];
    companionBus.on("group:convergence", (p) => {
      seen.push({ transition: p.transition, cycleNumber: p.cycleNumber });
    });

    let frozen = false;
    const tracker = new ConvergenceTracker({ isFrozen: () => frozen });
    tracker.attach();

    // 2 clean reviews to set counter at 2
    for (let i = 0; i < 2; i++) {
      companionBus.emit("group:review", {
        sessionGroupId: "grp-C",
        checkpointId: `cp-${i}`,
        phase: "council-implement",
        findings: [],
        downgrades: [],
        observerModel: "test",
        observerProvider: "claude",
        artifactsChanged: 1,
        artifactsRead: 1,
      });
    }
    expect(seen.map((s) => s.cycleNumber)).toEqual([1, 2]);

    // Group falls into degraded — next clean review must NOT advance
    frozen = true;
    companionBus.emit("group:review", {
      sessionGroupId: "grp-C",
      checkpointId: "cp-2",
      phase: "council-implement",
      findings: [],
      downgrades: [],
      observerModel: "test",
      observerProvider: "claude",
      artifactsChanged: 1,
      artifactsRead: 1,
    });
    expect(seen).toHaveLength(2);  // no new emit

    // Group recovers — next clean review goes to 3 + converged
    frozen = false;
    companionBus.emit("group:review", {
      sessionGroupId: "grp-C",
      checkpointId: "cp-3",
      phase: "council-implement",
      findings: [],
      downgrades: [],
      observerModel: "test",
      observerProvider: "claude",
      artifactsChanged: 1,
      artifactsRead: 1,
    });
    expect(seen[2]).toEqual({ transition: "converged", cycleNumber: 3 });

    tracker.detach();
  });

  it("forgetGroup drops per-group state — recreate starts fresh", () => {
    const tracker = new ConvergenceTracker({ isFrozen: () => false });
    tracker.attach();

    companionBus.emit("group:review", {
      sessionGroupId: "grp-D",
      checkpointId: "cp-0",
      phase: "council-implement",
      findings: [],
      downgrades: [],
      observerModel: "test",
      observerProvider: "claude",
      artifactsChanged: 1,
      artifactsRead: 1,
    });
    expect(tracker.getState("grp-D")?.cleanCycleCount).toBe(1);

    tracker.forgetGroup("grp-D");
    expect(tracker.getState("grp-D")).toBeUndefined();

    tracker.detach();
  });

  // ── got-045: restart catch-up must not fabricate clean cycles ─────────────
  // The restart catch-up dispatcher replays `council.wake.restart_catchup`
  // against the same stale checkpoint; the observer rewrites an (empty) review
  // and re-emits `group:review` with the SAME checkpointId + provider. Without
  // a dedup guard each replay counts as a fresh clean cycle and can fake a
  // "converged" pair that reviewed nothing. These pin the guard.

  it("does NOT re-count a replayed review for the same (checkpoint, provider)", () => {
    const seen: Array<{ transition: string; cycleNumber: number }> = [];
    companionBus.on("group:convergence", (p) => {
      seen.push({ transition: p.transition, cycleNumber: p.cycleNumber });
    });

    const tracker = new ConvergenceTracker({ isFrozen: () => false });
    tracker.attach();

    // One real clean review for cp-0 → counter 1.
    // Then two replays of the exact same checkpoint+provider (restart
    // catch-up signature) — both must be dropped, counter stays at 1.
    for (let i = 0; i < 3; i++) {
      companionBus.emit("group:review", {
        sessionGroupId: "grp-replay",
        checkpointId: "cp-0",
        phase: "council-implement",
        findings: [],
        downgrades: [],
        observerModel: "test",
        observerProvider: "claude",
        artifactsChanged: 1,
        artifactsRead: 1,
      });
    }

    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({ transition: "cycle-progress", cycleNumber: 1 });
    expect(tracker.getState("grp-replay")?.cleanCycleCount).toBe(1);
    expect(tracker.getState("grp-replay")?.convergenceState).toBe("in-progress");

    tracker.detach();
  });

  it("a stale spawn-checkpoint replayed 3× can NOT reach converged (got-045 core)", () => {
    const seen: string[] = [];
    companionBus.on("group:convergence", (p) => { seen.push(p.transition); });

    const tracker = new ConvergenceTracker({ isFrozen: () => false });
    tracker.attach();

    // Simulate three server restarts, each replaying the SAME spawn checkpoint
    // with an empty (clean) review. Pre-fix this reached converged at the 3rd.
    for (let restart = 0; restart < 3; restart++) {
      companionBus.emit("group:review", {
        sessionGroupId: "grp-spawn",
        checkpointId: "cp-spawn",
        phase: "council-bootstrap",
        findings: [],
        downgrades: [],
        observerModel: "test",
        observerProvider: "claude",
        artifactsChanged: 1,
        artifactsRead: 1,
      });
    }

    // Only the first fold counts; never converges on replays alone.
    expect(seen).toEqual(["cycle-progress"]);
    expect(tracker.getState("grp-spawn")?.convergenceState).toBe("in-progress");

    tracker.detach();
  });

  it("counts distinct providers of the same checkpoint separately (claude+codex)", () => {
    // The dedup key includes the provider, so a two-provider pair reviewing the
    // same checkpoint still folds both — only exact (checkpoint, provider)
    // replays are dropped.
    const seen: number[] = [];
    companionBus.on("group:convergence", (p) => { seen.push(p.cycleNumber); });

    const tracker = new ConvergenceTracker({ isFrozen: () => false });
    tracker.attach();

    for (const provider of ["claude", "codex"]) {
      companionBus.emit("group:review", {
        sessionGroupId: "grp-two",
        checkpointId: "cp-0",
        phase: "council-implement",
        findings: [],
        downgrades: [],
        observerModel: "test",
        observerProvider: provider,
        artifactsChanged: 1,
        artifactsRead: 1,
      });
    }

    expect(seen).toEqual([1, 2]);

    tracker.detach();
  });

  it("forgetGroup clears the dedup ledger so a re-created group re-counts", () => {
    const seen: number[] = [];
    companionBus.on("group:convergence", (p) => { seen.push(p.cycleNumber); });

    const tracker = new ConvergenceTracker({ isFrozen: () => false });
    tracker.attach();

    const emitCp0 = () =>
      companionBus.emit("group:review", {
        sessionGroupId: "grp-recycle",
        checkpointId: "cp-0",
        phase: "council-implement",
        findings: [],
        downgrades: [],
        observerModel: "test",
        observerProvider: "claude",
        artifactsChanged: 1,
        artifactsRead: 1,
      });

    emitCp0();
    emitCp0(); // replay dropped
    expect(seen).toEqual([1]);

    // Group torn down + recreated — the ledger must reset so cp-0 counts again.
    tracker.forgetGroup("grp-recycle");
    emitCp0();
    expect(seen).toEqual([1, 1]);

    tracker.detach();
  });

  it("does NOT consume the dedup slot for a frozen review (countable after recovery)", () => {
    // A degraded (frozen) review folds to a no-op. It must not mark the
    // checkpoint as seen, otherwise the post-recovery re-review of that same
    // checkpoint would be wrongly dropped and never counted.
    const seen: number[] = [];
    companionBus.on("group:convergence", (p) => { seen.push(p.cycleNumber); });

    let frozen = true;
    const tracker = new ConvergenceTracker({ isFrozen: () => frozen });
    tracker.attach();

    const emitCp = () =>
      companionBus.emit("group:review", {
        sessionGroupId: "grp-thaw",
        checkpointId: "cp-0",
        phase: "council-implement",
        findings: [],
        downgrades: [],
        observerModel: "test",
        observerProvider: "claude",
        artifactsChanged: 1,
        artifactsRead: 1,
      });

    emitCp(); // frozen → no-op, must NOT consume the slot
    expect(seen).toHaveLength(0);

    frozen = false;
    emitCp(); // recovered → the same checkpoint now counts
    expect(seen).toEqual([1]);

    tracker.detach();
  });

  it("attach + detach is idempotent", () => {
    const tracker = new ConvergenceTracker({ isFrozen: () => false });
    tracker.attach();
    tracker.attach();  // no-op
    tracker.detach();
    tracker.detach();  // no-op
    expect(() => tracker.attach()).not.toThrow();
    tracker.detach();
  });
});

// P3/CONV-HONEST (human decision 2026-09-28): three "clean" reviews of a
// spawn checkpoint / of reviews where the observer opened nothing flipped a
// pair to "ready to ship". Only reviews in which the HOST saw the observer
// read ≥1 changed file of the checkpoint may advance the counter. Threshold
// and its 2–5 range are unchanged.
describe("reviewNotCountedReason (CONV-HONEST)", () => {
  it("empty/spawn checkpoint → no_changed_files (even if something was 'read')", () => {
    expect(reviewNotCountedReason(0, 0)).toBe("no_changed_files");
    expect(reviewNotCountedReason(0, 3)).toBe("no_changed_files");
  });
  it("changed files but none read → no_files_read", () => {
    expect(reviewNotCountedReason(4, 0)).toBe("no_files_read");
  });
  it("≥1 changed file read → countable", () => {
    expect(reviewNotCountedReason(4, 1)).toBeNull();
  });
});

describe("ConvergenceTracker — reviews that reviewed nothing (CONV-HONEST)", () => {
  beforeEach(() => {
    companionBus.clear();
  });

  type Seen = { transition: string; cycleNumber: number; state: string; reason?: string };
  function record(): Seen[] {
    const seen: Seen[] = [];
    companionBus.on("group:convergence", (p) => {
      seen.push({
        transition: p.transition,
        cycleNumber: p.cycleNumber,
        state: p.convergenceState,
        ...(p.notCountedReason ? { reason: p.notCountedReason } : {}),
      });
    });
    return seen;
  }
  function review(
    group: string,
    checkpointId: string,
    artifactsChanged: number,
    artifactsRead: number,
    findingList: BrowserObserverFinding[] = [],
  ) {
    companionBus.emit("group:review", {
      sessionGroupId: group,
      checkpointId,
      phase: "council-implement",
      findings: findingList,
      downgrades: [],
      observerModel: "test",
      observerProvider: "claude",
      artifactsChanged,
      artifactsRead,
    });
  }

  it("three clean reviews that read nothing never converge", () => {
    const seen = record();
    const tracker = new ConvergenceTracker({ isFrozen: () => false });
    tracker.attach();

    review("grp-empty", "cp-spawn", 0, 0); // spawn checkpoint
    review("grp-empty", "cp-1", 3, 0);     // observer opened no changed file
    review("grp-empty", "cp-2", 2, 0);

    expect(seen).toEqual([
      { transition: "not-counted", cycleNumber: 0, state: "in-progress", reason: "no_changed_files" },
      { transition: "not-counted", cycleNumber: 0, state: "in-progress", reason: "no_files_read" },
      { transition: "not-counted", cycleNumber: 0, state: "in-progress", reason: "no_files_read" },
    ]);
    expect(tracker.getState("grp-empty")?.convergenceState).toBe("in-progress");
    tracker.detach();
  });

  it("an uncounted review neither advances nor resets the counter", () => {
    const seen = record();
    const tracker = new ConvergenceTracker({ isFrozen: () => false });
    tracker.attach();

    review("grp-mix", "cp-1", 1, 1);
    review("grp-mix", "cp-2", 1, 0); // not counted
    review("grp-mix", "cp-3", 2, 1);

    expect(seen.map((s) => [s.transition, s.cycleNumber])).toEqual([
      ["cycle-progress", 1],
      ["not-counted", 1],
      ["cycle-progress", 2],
    ]);
    tracker.detach();
  });

  it("after convergence an uncounted review keeps the converged state (reported, not flipped)", () => {
    const seen = record();
    const tracker = new ConvergenceTracker({ isFrozen: () => false });
    tracker.attach();
    for (let i = 0; i < 3; i++) review("grp-conv", `cp-${i}`, 1, 1);
    review("grp-conv", "cp-3", 1, 0);
    expect(seen.at(-1)).toEqual({ transition: "not-counted", cycleNumber: 3, state: "converged", reason: "no_files_read" });
    tracker.detach();
  });

  it("a STOP still resets even when the observer read nothing (blockers are never ignored)", () => {
    const seen = record();
    const tracker = new ConvergenceTracker({ isFrozen: () => false });
    tracker.attach();
    review("grp-stop", "cp-1", 1, 1);
    review("grp-stop", "cp-2", 1, 0, findings("STOP"));
    expect(seen.map((s) => [s.transition, s.cycleNumber])).toEqual([
      ["cycle-progress", 1],
      ["cycle-progress", 0],
    ]);
    tracker.detach();
  });

  it("an uncounted review does not consume the dedup slot — a later real review of it counts once", () => {
    const seen = record();
    const tracker = new ConvergenceTracker({ isFrozen: () => false });
    tracker.attach();
    review("grp-retry", "cp-1", 2, 0); // not counted
    review("grp-retry", "cp-1", 2, 2); // same checkpoint, now actually read
    review("grp-retry", "cp-1", 2, 2); // replay — dropped (got-045)
    expect(seen.map((s) => [s.transition, s.cycleNumber])).toEqual([
      ["not-counted", 0],
      ["cycle-progress", 1],
    ]);
    tracker.detach();
  });

  it("frozen (degraded) groups emit nothing, not even not-counted", () => {
    const seen = record();
    const tracker = new ConvergenceTracker({ isFrozen: () => true });
    tracker.attach();
    review("grp-frozen", "cp-1", 0, 0);
    expect(seen).toEqual([]);
    tracker.detach();
  });
});
