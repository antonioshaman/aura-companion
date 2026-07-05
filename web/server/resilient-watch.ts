import { log } from "./logger.js";

/**
 * Self-restarting wrapper around a filesystem watch loop (Issue #86).
 *
 * The council pipeline's only live IPC channel between orchestrator and
 * observer is `fs.watch` on `.council/`. Both {@link watchCheckpoints} and
 * {@link watchReviews} model a watcher as a promise that only *resolves* on
 * abort and *rejects* on an unexpected `fs.watch` error. Before this wrapper
 * a rejection propagated to a `.catch()` that logged a WARN and did nothing —
 * the watcher was gone for the rest of the server's uptime and the pair
 * looked alive but was functionally dead (no checkpoint→wake, no review
 * fan-out) until a full server restart.
 *
 * `runResilientWatch` keeps re-invoking `start` whenever it settles while the
 * signal is NOT aborted, with a bounded backoff so a persistently-failing
 * watch (e.g. the watched directory was removed) does not hot-loop. Every
 * death is surfaced as a structured ERROR log (not a silent WARN), and the
 * caller's {@link ResilientWatchOptions.onDeath} hook can trigger a catch-up
 * scan — `fs.watch` is event-only and never replays files written while the
 * watcher was down, so re-arming alone would miss a checkpoint that landed in
 * the gap.
 *
 * The returned promise resolves only once the signal aborts, so callers may
 * `void` it (fire-and-forget) exactly like the raw watch promise.
 */
export interface ResilientWatchDeath {
  /** `threw` — `start` rejected; `ended` — `start` resolved without an abort. */
  kind: "threw" | "ended";
  /** Present only for `kind === "threw"`. */
  error?: unknown;
}

export interface ResilientWatchOptions {
  /** Stable label for logs, e.g. `checkpoint` / `review`. */
  kind: string;
  /** Extra fields merged into every structured log line (e.g. sessionGroupId). */
  logContext?: Record<string, unknown>;
  /** Aborting stops the loop and resolves the returned promise. */
  signal: AbortSignal;
  /** Launch one watch generation. Resolves on abort, rejects on watch error. */
  start: () => Promise<void>;
  /**
   * Called on every unexpected death (before the backoff). The caller
   * typically logs nothing here (this module already logs ERROR) and instead
   * schedules a catch-up scan for files missed during the downtime.
   */
  onDeath?: (death: ResilientWatchDeath) => void;
  /** Backoff before re-arming. Defaults to {@link DEFAULT_REARM_DELAY_MS}. */
  rearmDelayMs?: number;
  /**
   * Injectable delay (test seam). Must resolve early if the signal aborts.
   * Defaults to a real timer that also resolves on abort.
   */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export const DEFAULT_REARM_DELAY_MS = 1_000;

/** Real-timer sleep that resolves early when the signal aborts. */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export async function runResilientWatch(opts: ResilientWatchOptions): Promise<void> {
  const rearmDelayMs = opts.rearmDelayMs ?? DEFAULT_REARM_DELAY_MS;
  const sleep = opts.sleep ?? abortableSleep;
  const base = { event: "council.watcher.died", kind: opts.kind, ...opts.logContext };

  while (!opts.signal.aborted) {
    let death: ResilientWatchDeath | null = null;
    try {
      await opts.start();
      // Resolved. A clean abort exits the loop below; a resolve WITHOUT an
      // abort means the fs.watch async-iterator ended on its own (platform
      // quirk, watched dir removed+recreated) — treat as an unexpected death.
      if (!opts.signal.aborted) death = { kind: "ended" };
    } catch (err) {
      if (!opts.signal.aborted) death = { kind: "threw", error: err };
    }

    if (opts.signal.aborted) return;
    if (!death) return;

    log.error("resilient-watch", "council watcher died — re-arming", {
      ...base,
      deathKind: death.kind,
      error: death.error instanceof Error ? death.error.message : death.error != null ? String(death.error) : undefined,
      rearmDelayMs,
    });
    try {
      opts.onDeath?.(death);
    } catch (hookErr) {
      log.error("resilient-watch", "council watcher onDeath hook threw", {
        ...base,
        error: hookErr instanceof Error ? hookErr.message : String(hookErr),
      });
    }

    await sleep(rearmDelayMs, opts.signal);
  }
}
