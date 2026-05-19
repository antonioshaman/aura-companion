import type { SessionGroupCoordinator } from "./session-group-coordinator.js";

/**
 * Graceful tear-down of all active Council Mode groups. Called from the
 * server's shutdown hook (SIGTERM/SIGINT) before the parent process exits,
 * so both halves of every group are reaped rather than orphaned attached
 * to PID 1.
 *
 * Strategy: archive every known group in parallel with a bounded total
 * timeout. The coordinator's own `archiveGroup` already handles the
 * sequential kill-of-both-halves and the state machine; this is the
 * fan-out wrapper.
 *
 * Pure: takes the coordinator + an optional `now` clock for testability.
 * Returns a summary the shutdown caller can log before exit.
 */

/**
 * Narrow surface for the optional idle-timer drain step. Mirrors the
 * shape of {@link IdleTimerManager.disposeAll}; takes `void` (every armed
 * timer is cancelled in one pass — no per-session loop). Caller passes
 * either the real manager or any object satisfying this method.
 */
export interface IdleTimerDrainer {
  disposeAll(): void;
}

export interface ShutdownOptions {
  /** Total budget for the shutdown. Groups not archived within this window
   *  are counted as `timed_out`; caller decides whether to SIGKILL on top. */
  timeoutMs: number;
  /** Optional clock for tests. Defaults to Date.now. */
  now?: () => number;
  /**
   * PLAN-aura-orchestrator-idle-auto-proceed Task 9: cancel every armed
   * idle timer BEFORE kill propagation. EC-2 invariant extends naturally
   * — timers cleared before kills fire to the CLI children, so a fire
   * callback racing the kill cannot land an `attempted-send-to-dying-CLI`
   * EC-9 log entry that confuses the shutdown summary. Optional so legacy
   * call sites and unit tests that don't exercise auto-proceed are not
   * forced to thread a stub.
   */
  idleTimerManager?: IdleTimerDrainer;
}

export interface ShutdownSummary {
  total: number;
  archived: number;
  failed: number;
  timedOut: number;
  durationMs: number;
}

export async function shutdownAllGroups(
  coordinator: SessionGroupCoordinator,
  groupIds: readonly string[],
  opts: ShutdownOptions,
): Promise<ShutdownSummary> {
  const now = opts.now ?? Date.now;
  const start = now();

  // PLAN Task 9: dispose all auto-proceed idle timers FIRST, BEFORE any
  // kill propagation. EC-2 invariant — cancelling here ensures a pending
  // fire callback cannot land mid-archive and emit a confused
  // `synthetic-frame-to-dying-CLI` log line. Synchronous: `disposeAll`
  // walks the manager's in-memory map and calls `cancel()` on each timer
  // handle. Idempotent — safe to call when the manager holds zero armed
  // timers, and safe to call when the same shutdown loop fires twice
  // (e.g. SIGTERM followed by SIGINT).
  if (opts.idleTimerManager) {
    try {
      opts.idleTimerManager.disposeAll();
    } catch (err) {
      // `disposeAll` is documented as not-throwing, but a future change
      // that adds I/O (flush trace, etc.) could surface here. Swallow +
      // continue so the shutdown loop still reaps every group; the
      // coordinator's `cancelAllReconnectTimers` already runs in
      // `gracefulShutdown` ahead of this — the kill cascade is still
      // bounded by `timeoutMs` regardless.
      console.warn("[group-shutdown] idleTimerManager.disposeAll failed:", err);
    }
  }

  if (groupIds.length === 0) {
    return { total: 0, archived: 0, failed: 0, timedOut: 0, durationMs: 0 };
  }

  let archived = 0;
  let failed = 0;
  let timedOut = 0;

  // Each archive races against the shared budget. Promise.race against a
  // timeout sentinel rather than aborting the archive itself — the
  // coordinator's kill calls are already best-effort and reporting via
  // CoordinatorErrorSink, so we just measure outcomes.
  const sentinel = Symbol("timeout");
  const timeoutPromise = new Promise<typeof sentinel>((resolve) => {
    setTimeout(() => resolve(sentinel), opts.timeoutMs);
  });

  const tasks = groupIds.map(async (groupId) => {
    try {
      const result = await Promise.race([coordinator.archiveGroup(groupId), timeoutPromise]);
      if (result === sentinel) {
        timedOut++;
      } else if (result === true) {
        archived++;
      } else {
        failed++;
      }
    } catch {
      // archiveGroup itself doesn't throw under current implementation, but
      // future contract changes could — count as failure rather than
      // crashing the shutdown loop.
      failed++;
    }
  });

  await Promise.allSettled(tasks);

  return {
    total: groupIds.length,
    archived,
    failed,
    timedOut,
    durationMs: now() - start,
  };
}
