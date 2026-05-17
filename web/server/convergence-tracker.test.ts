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
    });
    expect(tracker.getState("grp-D")?.cleanCycleCount).toBe(1);

    tracker.forgetGroup("grp-D");
    expect(tracker.getState("grp-D")).toBeUndefined();

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
