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

export interface ShutdownOptions {
  /** Total budget for the shutdown. Groups not archived within this window
   *  are counted as `timed_out`; caller decides whether to SIGKILL on top. */
  timeoutMs: number;
  /** Optional clock for tests. Defaults to Date.now. */
  now?: () => number;
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
