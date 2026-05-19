/**
 * Convergence tracker — bidirectional pipeline Story 4.1.
 *
 * Folds the `group:review` event stream into a per-group clean-cycle
 * counter. Three transitions:
 *
 *   - `cycle-progress`   counter incremented (still below threshold)
 *   - `converged`        counter reached threshold (default 3)
 *   - `revoked`          a STOP arrived after convergence; counter ← 0
 *
 * Pure-function core (`nextStateAfterReview`) makes the state-machine
 * transitions trivially table-driven from tests. The live wiring
 * subscribes to `companionBus.on("group:review", ...)`, applies the
 * pure update, and emits `companionBus.emit("group:convergence", ...)`
 * — no other side effects (atomic-write of the converged checkpoint
 * is the orchestrator's responsibility, downstream of the bus event).
 *
 * Counter freeze under degraded state is deferred to the wiring layer
 * (caller passes `frozen: true` derived from `GroupRecord.status`);
 * the pure core only handles review→counter mechanics.
 */

import { companionBus } from "./event-bus.js";
import type { BrowserObserverFinding } from "./session-types.js";

export const DEFAULT_CONVERGENCE_THRESHOLD = 3;
export const MIN_CONVERGENCE_THRESHOLD = 2;
export const MAX_CONVERGENCE_THRESHOLD = 5;

export type ConvergenceState = "in-progress" | "converged" | "revoked";

export interface ConvergenceGroupState {
  cleanCycleCount: number;
  convergenceState: ConvergenceState;
  threshold: number;
}

export interface ConvergenceTransitionResult {
  next: ConvergenceGroupState;
  emit: "cycle-progress" | "converged" | "revoked" | "noop";
}

export function initialConvergenceState(
  threshold: number = DEFAULT_CONVERGENCE_THRESHOLD,
): ConvergenceGroupState {
  return {
    cleanCycleCount: 0,
    convergenceState: "in-progress",
    threshold: clampThreshold(threshold),
  };
}

export function clampThreshold(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_CONVERGENCE_THRESHOLD;
  const i = Math.trunc(n);
  if (i < MIN_CONVERGENCE_THRESHOLD) return MIN_CONVERGENCE_THRESHOLD;
  if (i > MAX_CONVERGENCE_THRESHOLD) return MAX_CONVERGENCE_THRESHOLD;
  return i;
}

/**
 * Pure folder: given the prior state and a review's STOP-presence,
 * return the next state + which transition (if any) the caller
 * should emit on the bus.
 *
 * Rules:
 *   - hasStop AND state === "converged"  →  revoked, counter ← 0
 *   - hasStop AND state !== "converged"  →  noop (reset to 0; no emit
 *                                            unless counter was non-zero,
 *                                            in which case emit cycle-progress
 *                                            with the new 0 — UI updates)
 *   - !hasStop AND counter+1 < threshold →  cycle-progress
 *   - !hasStop AND counter+1 >= threshold →  converged
 *   - frozen === true                    →  noop, state unchanged
 *
 * `frozen` is the degraded-state freeze gate from Story 4.1.5.
 */
export function nextStateAfterReview(
  prev: ConvergenceGroupState,
  hasStop: boolean,
  frozen: boolean = false,
): ConvergenceTransitionResult {
  if (frozen) {
    return { next: prev, emit: "noop" };
  }
  if (hasStop) {
    if (prev.convergenceState === "converged") {
      return {
        next: { ...prev, cleanCycleCount: 0, convergenceState: "revoked" },
        emit: "revoked",
      };
    }
    // STOP before convergence — reset counter; only emit if it was non-zero
    // so the UI knows the progress bar dropped back to 0.
    if (prev.cleanCycleCount > 0) {
      return {
        next: { ...prev, cleanCycleCount: 0, convergenceState: "in-progress" },
        emit: "cycle-progress",
      };
    }
    return { next: { ...prev, convergenceState: "in-progress" }, emit: "noop" };
  }
  // Clean review (no STOPs)
  const nextCount = prev.cleanCycleCount + 1;
  if (nextCount >= prev.threshold) {
    return {
      next: {
        ...prev,
        cleanCycleCount: nextCount,
        convergenceState: "converged",
      },
      emit: "converged",
    };
  }
  return {
    next: {
      ...prev,
      cleanCycleCount: nextCount,
      convergenceState: "in-progress",
    },
    emit: "cycle-progress",
  };
}

/**
 * Inspect a finding list and decide whether it contains a blocking STOP.
 * Severity "STOP" is the gate; WARN/NOTE/INFO are clean from convergence's
 * point of view. Matches the spec's "0 P1 findings" semantic — STOP is the
 * council's P1 analogue.
 */
export function reviewHasStop(findings: readonly BrowserObserverFinding[]): boolean {
  for (const f of findings) {
    if (f.severity === "STOP") return true;
  }
  return false;
}

/**
 * Live wiring: bind a per-group state map to the companion bus.
 * Caller provides a getter for the current `frozen` flag (e.g.,
 * `() => coordinator.getGroupStatus(sid) === "degraded"`) so the
 * tracker stays decoupled from the state machine (AP-1).
 */
export interface ConvergenceTrackerOptions {
  /** Pure-state map keyed by sessionGroupId. */
  states?: Map<string, ConvergenceGroupState>;
  /** Per-group frozen check (degraded freezes the counter, Story 4.1.5). */
  isFrozen: (sessionGroupId: string) => boolean;
  /** Per-group threshold override (env var COMPANION_CONVERGENCE_THRESHOLD
   *  or per-pair form field; default DEFAULT_CONVERGENCE_THRESHOLD). */
  getThreshold?: (sessionGroupId: string) => number;
}

export class ConvergenceTracker {
  private readonly states: Map<string, ConvergenceGroupState>;
  private readonly isFrozen: (sid: string) => boolean;
  private readonly getThreshold: (sid: string) => number;
  private unsubscribe: (() => void) | null = null;

  constructor(opts: ConvergenceTrackerOptions) {
    this.states = opts.states ?? new Map();
    this.isFrozen = opts.isFrozen;
    this.getThreshold = opts.getThreshold ?? (() => DEFAULT_CONVERGENCE_THRESHOLD);
  }

  /** Attach to the companion bus. Idempotent — calling twice is a no-op. */
  attach(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = companionBus.on("group:review", (payload) => {
      this.handleReview(payload.sessionGroupId, payload.findings);
    });
  }

  detach(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }

  /** Drop the per-group state — call on `group:exited`. */
  forgetGroup(sessionGroupId: string): void {
    this.states.delete(sessionGroupId);
  }

  /** Read-only state inspection — for tests + the broadcast layer. */
  getState(sessionGroupId: string): ConvergenceGroupState | undefined {
    return this.states.get(sessionGroupId);
  }

  private handleReview(
    sessionGroupId: string,
    findings: readonly BrowserObserverFinding[],
  ): void {
    const prev = this.states.get(sessionGroupId)
      ?? initialConvergenceState(this.getThreshold(sessionGroupId));
    const hasStop = reviewHasStop(findings);
    const frozen = this.isFrozen(sessionGroupId);
    const { next, emit } = nextStateAfterReview(prev, hasStop, frozen);
    this.states.set(sessionGroupId, next);
    if (emit !== "noop") {
      companionBus.emit("group:convergence", {
        sessionGroupId,
        transition: emit,
        cycleNumber: next.cleanCycleCount,
        convergenceThreshold: next.threshold,
      });
    }
  }
}
