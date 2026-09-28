import { join } from "node:path";
import { readdirSync, readFileSync, statSync } from "node:fs";
import type { SessionGroupCoordinator } from "./session-group-coordinator.js";
import type { CheckpointPayload } from "./council-types.js";
import { COUNCIL_SCHEMA_VERSION, parseCheckpointPayload } from "./council-types.js";
import { writeAtomicJson } from "./atomic-write.js";
import { buildCheckpointFilename } from "./checkpoint-watcher.js";
import { readCouncilWakeSentinel } from "./council-wake-sentinel.js";
import type { CheckpointLineSnapshots } from "./observer-line-snapshots.js";
import type { CouncilWatcherEntry } from "./council-checkpoint-pipeline.js";
import { log } from "./logger.js";

/**
 * Council Mode observer wake scheduler (aura-meta-diet P4/C1b): the paths
 * that wake the observer outside the live checkpoint watcher — the EC-12
 * missed-checkpoint scan (init / EC-13 failsafe tick / watcher re-arm), the
 * adapter-ready catch-up poll with its deaf-observer escalation, and the
 * spawn-checkpoint handshake poll.
 *
 * Extracted verbatim from `session-orchestrator.ts`. The orchestrator owns
 * the watcher/meta maps and hands them in (AP-1 DI). The wake dispatch and
 * the readiness predicate are injected as callbacks, so the orchestrator's
 * checkpoint pipeline stays the only wake sender.
 */

/**
 * EC-13 observer failsafe tick. `fs.watch` is the live checkpoint→wake
 * channel, but it can silently die (Issue #86) or never fire at all in
 * environments where inotify is unavailable (Docker bind-mounts, NFS/SMB).
 * This recurring tick re-runs {@link CouncilObserverScheduler.scanForMissedObserverWakes}
 * — a direct read of each group's `.council/checkpoints/` — so an unprocessed
 * checkpoint still wakes the observer even when the watcher is gone. The scan
 * is idempotent (Gate 0 sentinel), so a redundant tick is a cheap no-op.
 *
 * Default 5 min; env-overridable, bounded to [10s, 1h] to catch operator
 * typos. Read once at module load (never in a hot path).
 */
export const OBSERVER_FAILSAFE_FALLBACK_MS = 300_000;
export const OBSERVER_FAILSAFE_MIN_MS = 10_000;
export const OBSERVER_FAILSAFE_MAX_MS = 3_600_000;

/**
 * Council review 2026-09-11 P1-1: how many consecutive catch-up wake polls
 * for the SAME checkpoint may time out (`adapter_wait_timed_out`) before the
 * group is escalated to `degraded` instead of retried forever. The EC-13
 * failsafe re-schedules a 30s poll every {@link OBSERVER_FAILSAFE_FALLBACK_MS}
 * (5 min); a genuinely deaf observer therefore produced 120-cycle / multi-hour
 * no-op loops with zero escalation. Once the group degrades, the failsafe scan
 * skips it (status !== active/reconnecting), closing the loop. 3 × ~5 min ≈ a
 * ~15-minute deaf-observer ceiling before we stop retrying and surface the
 * stuck state to the operator. A single slow adapter attach (≤30s) still
 * succeeds within one poll and never counts toward this.
 */
export const OBSERVER_CATCHUP_TIMEOUT_ESCALATION_THRESHOLD = 3;

/**
 * Pure parse of the failsafe-tick env value. Exported so the bounds/clamp/
 * warn-on-invalid branches are testable without reaching through the module
 * IIFE (Council Review 2026-07-05 Beck #3). Returns the fallback for absent,
 * empty, non-finite, or out-of-bounds input; invokes `onInvalid` (log side
 * channel) only for a present-but-invalid value, never for the absent case.
 */
export function parseFailsafeTickMs(
  raw: string | undefined,
  onInvalid?: (raw: string) => void,
): number {
  if (raw === undefined || raw === "") return OBSERVER_FAILSAFE_FALLBACK_MS;
  const parsed = Number.parseInt(raw, 10);
  if (
    !Number.isFinite(parsed) ||
    parsed < OBSERVER_FAILSAFE_MIN_MS ||
    parsed > OBSERVER_FAILSAFE_MAX_MS
  ) {
    onInvalid?.(raw);
    return OBSERVER_FAILSAFE_FALLBACK_MS;
  }
  return parsed;
}

const OBSERVER_FAILSAFE_TICK_MS = parseFailsafeTickMs(
  process.env.COMPANION_OBSERVER_FAILSAFE_MS,
  (raw) => {
    log.warn("session-orchestrator", "invalid COMPANION_OBSERVER_FAILSAFE_MS, using fallback", {
      event: "config.observer_failsafe_ms.invalid",
      raw,
      fallbackMs: OBSERVER_FAILSAFE_FALLBACK_MS,
    });
  },
);

/** The slice of the orchestrator's per-group meta this scheduler reads. */
export interface ObserverSchedulerGroupMeta {
  observerSessionId: string;
}

export interface CouncilObserverSchedulerDeps {
  /** Owned by the orchestrator: started/stopped with the group's watchers. */
  watchers: Map<string, CouncilWatcherEntry>;
  /** Owned by the orchestrator: group lifecycle meta. */
  groupMeta: ReadonlyMap<string, ObserverSchedulerGroupMeta>;
  getCoordinator: () => SessionGroupCoordinator | null;
  lineSnapshots: CheckpointLineSnapshots;
  /** Council-wake send-readiness gate for the observer half's bridge adapter. */
  isObserverReadyForWake: (observerSessionId: string) => boolean;
  /** Drives a wake through the checkpoint pipeline's gated dispatcher. */
  dispatchWake: (sessionGroupId: string, payload: CheckpointPayload) => void;
}

export class CouncilObserverScheduler {
  constructor(private readonly deps: CouncilObserverSchedulerDeps) {}

  /**
   * Council groups whose spawn checkpoint has NOT landed yet (got-050). The
   * fresh-spawn poll in `scheduleSpawnCheckpointWhenObserverReady` gives up
   * after 30s if the observer adapter never becomes send-ready (e.g. codex
   * init died on the `Not initialized` race); the group then lives without
   * its spawn-ack review. A manual/auto relaunch of the observer half
   * consults this set and re-arms the poll so the second spawn gets the
   * checkpoint the first one missed. Cleared on emit + on group teardown.
   */
  readonly spawnCheckpointPending = new Set<string>();
  /**
   * Council review 2026-09-08 #4: groups with a spawn-checkpoint poll
   * currently running its 30s window. `spawnCheckpointPending` answers "has
   * the checkpoint landed yet", NOT "is a poll live" — so repeated relaunches
   * inside the window would each start a concurrent poller (both key off the
   * same observer readiness edge and both emit, waking the observer twice).
   * Mirrors `catchupWakesInFlight`: checked at entry, cleared in `finally`,
   * and re-checked each poll iteration so a group torn down mid-poll stops.
   */
  readonly spawnCheckpointPollsInFlight = new Set<string>();
  /**
   * In-flight catch-up wake dedup keyed `${sessionGroupId}:${checkpointId}`
   * (Council Review 2026-07-05 Subprocess #2). The durable wake sentinel is
   * written only AFTER a poll returns "sent" — up to 30s later — so without a
   * live in-flight lock every scan trigger (init / failsafe every 5 min /
   * watcher-rearm) that runs while the observer adapter is not yet ready would
   * pass the stale sentinel check and stack another 30s poller for the SAME
   * checkpoint, racing a duplicate send. A key is added before launching the
   * poll and cleared in its `finally`.
   */
  private readonly catchupWakesInFlight = new Set<string>();
  /**
   * Council review 2026-09-11 P1-1: consecutive catch-up-poll timeouts per
   * `${sessionGroupId}:${checkpointId}`. Bumped when a poll expires without
   * the observer adapter ever becoming ready; reset to 0 the instant a wake
   * dispatches for that key. When it crosses
   * {@link OBSERVER_CATCHUP_TIMEOUT_ESCALATION_THRESHOLD} the group is degraded
   * (single degrade authority: `coordinator.applyEvent`) rather than retried
   * forever. Cleared on group teardown so it never outlives the group.
   */
  private readonly catchupWakeTimeouts = new Map<string, number>();

  /**
   * Council Mode restart-recovery scan (EC-12 — fs.watch is event-only,
   * needs pre-scan reconcile).
   *
   * For each reconciled council group, enumerate `.council/checkpoints/*.json`,
   * find the highest-sequence valid checkpoint, compare against the
   * persisted wake sentinel. If the highest on-disk checkpoint is newer
   * than the last-woken one (or no sentinel exists), fire one wake.
   *
   * Idempotent: the dispatcher's Gate 0 sentinel check (already in place)
   * absorbs double-invocations. Failures are logged + non-fatal — a
   * bad checkpoint file should not crash initialize().
   */
  scanForMissedObserverWakes(trigger: "init" | "failsafe" | "watcher-rearm" = "init"): void {
    // Council Review 2026-05-13-0150 Backend × Hunt #11: bounded
    // iteration. Without a cap, a hostile or runaway workspace with
    // thousands of .json files in `.council/checkpoints/` blocks
    // initialize() proportionally. 200 is generous — typical workflow
    // produces a few dozen checkpoints across a project's lifetime; an
    // overflow surfaces as a structured WARN log so operators can act.
    const SCAN_MAX_FILES_PER_GROUP = 200;
    for (const [groupId, entry] of this.deps.watchers) {
      try {
        // Council Review 2026-07-05 Subprocess #2: fail fast at scan time for a
        // conceptually-dead group. Without this, a degraded/archived group whose
        // watcher entry is still live passes the checks below and launches a full
        // 30s poll that only discovers `group_not_active` at the very end (Gate 1)
        // — and the failsafe re-does it every 5 min. `reconnecting` legitimately
        // queues, so it is allowed through alongside `active`.
        const status = this.deps.getCoordinator()?.get(groupId)?.status;
        if (status !== undefined && status !== "active" && status !== "reconnecting") {
          continue;
        }
        const checkpointsDir = join(entry.cwd, ".council", "checkpoints");
        let files: string[];
        try {
          files = readdirSync(checkpointsDir).filter(
            (f) => f.endsWith(".json") && !f.startsWith("."),
          );
        } catch {
          // Directory missing is normal — the watcher's mkdirSync will
          // create it on group registration; first run has no files.
          continue;
        }
        if (files.length > SCAN_MAX_FILES_PER_GROUP) {
          log.warn("session-orchestrator", "catchup scan capped by SCAN_MAX_FILES_PER_GROUP", {
            event: "council.wake.restart_catchup_truncated",
            trigger,
            sessionGroupId: groupId,
            totalFiles: files.length,
            cap: SCAN_MAX_FILES_PER_GROUP,
          });
          // Council Review 2026-07-05 Subprocess #4: select survivors by
          // recency (mtime desc), NOT lexical filename. Phase filenames are
          // not zero-padded sequence prefixes (`phase-9.json` sorts after
          // `phase-10.json`), so a name-sort tail can slice away the true
          // highest-sequence checkpoint — silently defeating the exact
          // "watcher died / never fired" case EC-13 exists to cover. mtime
          // is monotonic with emission order; a file we can't stat sinks to
          // the bottom (mtime 0) rather than throwing. The in-loop
          // `sequence > highest.sequence` guard still picks the true highest
          // among survivors.
          const mtimeOf = (f: string): number => {
            try {
              return statSync(join(checkpointsDir, f)).mtimeMs;
            } catch {
              return 0;
            }
          };
          files = files
            .map((f) => ({ f, m: mtimeOf(f) }))
            .sort((a, b) => b.m - a.m)
            .slice(0, SCAN_MAX_FILES_PER_GROUP)
            .map((e) => e.f);
        }
        let highest: CheckpointPayload | null = null;
        for (const file of files) {
          let raw: string;
          try {
            raw = readFileSync(join(checkpointsDir, file), "utf-8");
          } catch {
            continue;
          }
          // Task 13: surface parser rejections during the catchup scan
          // as structured protocol.frame_dropped so a stale/corrupted
          // checkpoint left from a prior run is observable rather than
          // silently skipped.
          let parserReason: string | undefined;
          let parserField: string | undefined;
          const payload = parseCheckpointPayload(raw, (reason, field) => {
            parserReason = reason;
            parserField = field;
          });
          if (!payload) {
            log.warn("session-orchestrator", "protocol.frame_dropped", {
              event: "protocol.frame_dropped",
              backend: "council",
              parser: "checkpoint",
              reason: parserReason ?? "unknown",
              field: parserField,
              file,
              context: "restart-catchup-scan",
            });
            continue;
          }
          if (payload.session_group_id !== groupId) continue;
          if (!highest || payload.sequence > highest.sequence) {
            highest = payload;
          }
        }
        if (!highest) continue;

        const sentinel = readCouncilWakeSentinel(entry.cwd, groupId);
        // Skip when the highest on-disk checkpoint has already been
        // woken for. The dispatcher's Gate 0 would also skip, but
        // surfacing it here keeps the structured log self-contained.
        if (sentinel && sentinel.last_woken_sequence >= highest.sequence) {
          continue;
        }
        log.info("session-orchestrator", "catchup wake fired for missed checkpoint", {
          event: "council.wake.restart_catchup",
          trigger,
          sessionGroupId: groupId,
          checkpointId: highest.checkpoint_id,
          sequence: highest.sequence,
          lastWokenSequence: sentinel?.last_woken_sequence ?? null,
        });
        // Council Review 2026-07-05 Subprocess #2: collapse N concurrent
        // pollers to one. Skip if a catch-up for this exact checkpoint is
        // already in flight (the durable sentinel is only written post-send,
        // so it can't dedup a poll that's mid-wait). The key is cleared in the
        // poll's `finally`.
        const inFlightKey = `${groupId}:${highest.checkpoint_id}`;
        if (this.catchupWakesInFlight.has(inFlightKey)) continue;

        // Drive through the standard dispatcher so all gates apply
        // (sentinel idempotency, group_status, build validation, etc.).
        // Also seed `lastCheckpoint` so subsequent grounding has the
        // manifest context the regular flow would have populated.
        //
        // Council Review 2026-07-05 Subprocess #3: only advance the shared
        // manifest-delta base when the scan is genuinely AHEAD of the live
        // watcher. The live `handleCouncilCheckpoint` writes these same two
        // fields; an unconditional overwrite by a background failsafe tick that
        // re-reads the current `lastCheckpoint` from disk would collapse the
        // delta base to N-vs-N (previous = current), losing the true N-1 and
        // handing the observer an empty/wrong modified-file set → grounded STOPs
        // spuriously downgraded. Advancing only when strictly newer keeps the
        // live-populated base intact.
        if (!entry.lastCheckpoint || highest.sequence > entry.lastCheckpoint.sequence) {
          entry.previousCheckpoint = entry.lastCheckpoint;
          entry.lastCheckpoint = highest;
          this.deps.lineSnapshots.capture(groupId, highest.checkpoint_id, entry.cwd, highest.artifact_paths);
        }
        // Council Review 2026-06-14 (live-test Finding #1 — restart-catchup
        // races the codex adapter attach): the catchup scan runs synchronously
        // inside initialize(), but the codex observer's backend adapter only
        // attaches ~16s later (thread/resume → fallback → initialized). A
        // synchronous dispatch here returns `adapter_missing` and drops with
        // no immediate retry (the EC-13 recurring failsafe — startFailsafe
        // — would eventually re-dispatch, but that is a coarse safety net). Mirror the
        // fresh-spawn path (`scheduleSpawnCheckpointWhenObserverReady`): defer
        // the dispatch behind an adapter-ready poll so the wake lands once the
        // observer transport is up. Fire-and-forget — never block init.
        void this.scheduleCatchupWakeWhenObserverReady(groupId, highest);
      } catch (err) {
        log.warn("session-orchestrator", "catchup scan failed for group", {
          event: "council.wake.restart_catchup_failed",
          trigger,
          sessionGroupId: groupId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /** EC-13 observer failsafe recurring tick handle (see {@link startFailsafe}). */
  private failsafeTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * EC-13: arm the recurring observer failsafe tick. Idempotent — a second
   * call while already armed is a no-op. The interval is `unref`'d so it
   * never keeps the process alive on its own; {@link stopFailsafe} clears it
   * for deterministic teardown in tests. `tick` is the orchestrator's scan
   * entry point, so every trigger (init / failsafe / watcher-rearm) goes
   * through one method.
   */
  startFailsafe(tick: () => void): void {
    if (this.failsafeTimer) return;
    const timer = setInterval(() => {
      try {
        tick();
      } catch (err) {
        log.warn("session-orchestrator", "observer failsafe tick failed", {
          event: "council.wake.failsafe_tick_failed",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }, OBSERVER_FAILSAFE_TICK_MS);
    timer.unref?.();
    this.failsafeTimer = timer;
  }

  stopFailsafe(): void {
    if (this.failsafeTimer) {
      clearInterval(this.failsafeTimer);
      this.failsafeTimer = null;
    }
  }

  /**
   * Drop per-group scheduling state on group teardown: the spawn-checkpoint
   * pending flag and any per-checkpoint catch-up-timeout strike counts.
   */
  forgetGroup(sessionGroupId: string): void {
    this.spawnCheckpointPending.delete(sessionGroupId);
    // P1-1: drop any per-checkpoint catch-up-timeout strike counts for this
    // group (keys are `${sessionGroupId}:${checkpointId}`) so they never
    // outlive the group.
    const groupPrefix = `${sessionGroupId}:`;
    for (const key of this.catchupWakeTimeouts.keys()) {
      if (key.startsWith(groupPrefix)) this.catchupWakeTimeouts.delete(key);
    }
  }


  /**
   * Fire-and-forget poll: wait until the observer's bridge adapter is
   * send-ready (see {@link observerReadyForWake}), then call
   * `emitSpawnCheckpoint`. The naive "emit immediately after group:created"
   * approach races against the observer CLI subprocess's WebSocket
   * handshake — the file lands + watcher fires + `dispatchObserverWake`
   * returns `adapter_missing`/`socket_disconnected` because the bridge
   * session has no (ready) adapter yet — and the wake is dropped silently.
   * Polling on readiness closes that window without coupling to a specific
   * bus event (Claude's adapter is attached by `handleCLIOpen` inside the
   * bridge, not via a fan-out bus emit like Codex's).
   *
   * Bounded by `MAX_WAIT_MS` so a never-arriving adapter (spawn that
   * crashed pre-WS-handshake) does not leak a polling promise. On
   * timeout we log + give up; the next user-driven checkpoint will
   * still wake the observer normally via the regular pipeline.
   */
  async scheduleSpawnCheckpointWhenObserverReady(
    sessionGroupId: string,
    observerSessionId: string,
    workspaceCwd: string,
  ): Promise<void> {
    const MAX_WAIT_MS = 30_000;
    const POLL_INTERVAL_MS = 250;
    // #4: at most one poll per group. A second relaunch inside the window
    // finds the flag set and no-ops rather than stacking a duplicate poller.
    if (this.spawnCheckpointPollsInFlight.has(sessionGroupId)) return;
    this.spawnCheckpointPollsInFlight.add(sessionGroupId);
    this.spawnCheckpointPending.add(sessionGroupId);
    try {
      const deadline = Date.now() + MAX_WAIT_MS;
      while (Date.now() < deadline) {
        // #4: teardown cancellation. `tearDownCouncilGroupTracking` clears
        // `spawnCheckpointPending`; if it's gone the group was archived/
        // deleted mid-poll and must not have a checkpoint written into its
        // (possibly reused, shared) workspace after the fact.
        if (!this.spawnCheckpointPending.has(sessionGroupId)) return;
        if (this.deps.isObserverReadyForWake(observerSessionId)) {
          if (this.spawnCheckpointPending.has(sessionGroupId)) {
            this.emitSpawnCheckpoint(sessionGroupId, workspaceCwd);
          }
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      }
      log.warn("session-orchestrator", "council.spawn_checkpoint.adapter_wait_timed_out", {
        event: "council.spawn_checkpoint.adapter_wait_timed_out",
        sessionGroupId,
        observerSessionId,
        waitedMs: MAX_WAIT_MS,
      });
    } finally {
      this.spawnCheckpointPollsInFlight.delete(sessionGroupId);
    }
  }

  /**
   * Council Review 2026-06-14 (live-test Finding #1): restart-catchup
   * adapter-ready gate. The one-shot `scanForMissedObserverWakes` runs at
   * `initialize()` time, but a reconnecting codex observer attaches its
   * backend adapter only after a `thread/resume` round-trip (~16s observed
   * on prod). Dispatching the catchup wake synchronously at scan time hit
   * `adapter_missing` and dropped with no retry. This mirrors the fresh-
   * spawn `scheduleSpawnCheckpointWhenObserverReady` poll so the missed
   * wake fires the moment the observer transport is ready.
   *
   * Bounded by MAX_WAIT_MS so a never-arriving adapter (half that never
   * re-handshakes) does not leak a polling promise. On timeout we log + give
   * up; the group's reconnect grace / degrade path owns the dead-half case.
   *
   * The readiness gate is {@link observerReadyForWake} (send-readiness, NOT
   * mere adapter presence): a reconnecting codex attaches its backend
   * adapter and even flips `connected` true BEFORE its `thread/resume`
   * round-trip assigns `threadId`, so both a presence-only AND an
   * `isConnected()`-only gate dispatched into a `socket_disconnected` drop
   * (live-test 2026-06-14, observed ~16s into restart-catchup). Polling on
   * `isReadyForServerFrame()` (threadId-aware) closes that window.
   */
  async scheduleCatchupWakeWhenObserverReady(
    sessionGroupId: string,
    payload: CheckpointPayload,
  ): Promise<void> {
    // Council Review 2026-07-05 Subprocess #2: mark this (group, checkpoint) as
    // having a live catch-up in flight so overlapping scan triggers (init /
    // failsafe / watcher-rearm) don't each stack a duplicate 30s poller. Set
    // synchronously at entry (the caller's `.has()` check precedes an
    // await-free `void this.schedule(...)`), cleared in the `finally` that
    // covers every exit including the meta-null early return.
    const inFlightKey = `${sessionGroupId}:${payload.checkpoint_id}`;
    this.catchupWakesInFlight.add(inFlightKey);
    try {
      const meta = this.deps.groupMeta.get(sessionGroupId);
      if (!meta) {
        // Group torn down between scan and poll — dispatchObserverWake would
        // resolve observer_unknown anyway; skip the poll entirely.
        return;
      }
      const observerSessionId = meta.observerSessionId;
      const MAX_WAIT_MS = 30_000;
      const POLL_INTERVAL_MS = 250;
      const deadline = Date.now() + MAX_WAIT_MS;
      // Council Review 2026-07-05 Backend #1: this poll is dispatched
      // fire-and-forget (`void this.scheduleCatchupWakeWhenObserverReady`), so a
      // throw from `dispatchObserverWake` (e.g. a transient FS error reading the
      // wake sentinel, or a backend adapter that throws mid-teardown during the
      // up-to-30s poll) would surface as an UNHANDLED rejection on a later
      // microtask and Bun treats that as fatal, taking down the whole server and
      // every live session. A watcher gap must degrade, never crash: swallow to
      // a structured WARN and give up (the recurring EC-13 failsafe re-attempts
      // on its next tick).
      try {
        while (Date.now() < deadline) {
          if (this.deps.isObserverReadyForWake(observerSessionId)) {
            this.deps.dispatchWake(sessionGroupId, payload);
            // P1-1: a successful wake clears the consecutive-timeout strike
            // count for this checkpoint — the observer is demonstrably alive.
            this.catchupWakeTimeouts.delete(inFlightKey);
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
        }
        // P1-1: the poll expired with the observer adapter never becoming
        // ready. Without escalation the EC-13 failsafe re-schedules this same
        // 30s poll every ~5 min forever (observed: 120-cycle / multi-hour
        // no-op loops). Count consecutive timeouts for THIS checkpoint and, at
        // the threshold, degrade the group through the single degrade authority
        // (`coordinator.applyEvent`). Once degraded, `scanForMissedObserverWakes`
        // skips the group (status !== active/reconnecting), closing the loop.
        const timeoutCount = (this.catchupWakeTimeouts.get(inFlightKey) ?? 0) + 1;
        this.catchupWakeTimeouts.set(inFlightKey, timeoutCount);
        log.warn("session-orchestrator", "council.wake.restart_catchup_adapter_wait_timed_out", {
          event: "council.wake.restart_catchup_adapter_wait_timed_out",
          sessionGroupId,
          observerSessionId,
          checkpointId: payload.checkpoint_id,
          sequence: payload.sequence,
          waitedMs: MAX_WAIT_MS,
          consecutiveTimeouts: timeoutCount,
          escalationThreshold: OBSERVER_CATCHUP_TIMEOUT_ESCALATION_THRESHOLD,
        });
        if (timeoutCount >= OBSERVER_CATCHUP_TIMEOUT_ESCALATION_THRESHOLD) {
          this.catchupWakeTimeouts.delete(inFlightKey);
          const coordinator = this.deps.getCoordinator();
          const stillLive =
            coordinator?.get(sessionGroupId)?.status === "active" ||
            coordinator?.get(sessionGroupId)?.status === "reconnecting";
          if (coordinator && stillLive) {
            log.warn("session-orchestrator", "council.wake.catchup_escalated_to_degraded", {
              event: "council.wake.catchup_escalated_to_degraded",
              sessionGroupId,
              sessionId: observerSessionId,
              role: "observer",
              checkpointId: payload.checkpoint_id,
              sequence: payload.sequence,
              consecutiveTimeouts: timeoutCount,
            });
            // Observer never became reachable to receive the wake — model it
            // as the observer half dying (deadRole=observer). `half_died` from
            // `active`/`reconnecting` derives `group:degraded` via the same
            // side-effect channel a real exit uses. `wake_send_failed` is the
            // closest existing reason: we repeatedly failed to deliver the wake.
            coordinator.applyEvent(sessionGroupId, {
              type: "half_died",
              role: "observer",
              reason: "wake_send_failed",
            });
          }
        }
      } catch (err) {
        log.warn("session-orchestrator", "council.wake.restart_catchup_dispatch_failed", {
          event: "council.wake.restart_catchup_dispatch_failed",
          sessionGroupId,
          observerSessionId,
          checkpointId: payload.checkpoint_id,
          sequence: payload.sequence,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } finally {
      this.catchupWakesInFlight.delete(inFlightKey);
    }
  }

  /**
   * Emit a synthetic `phase: "spawn"` checkpoint at group creation so the
   * observer's first protocol turn happens deterministically, without
   * waiting for a user-driven phase. The Claude `--print --input-format
   * stream-json -p` CLI does not emit `system:init` until it receives its
   * first user message — until then `cliSessionId` stays null, the panel
   * derives `never-checkpointed-yet`, and the pair appears stuck even
   * though both halves are live. Routing a real checkpoint through the
   * normal watcher → wake pipeline solves the handshake gap for free and
   * doubles as a per-spawn smoke test of the full council pipeline.
   *
   * Failure here is non-fatal: the pair is still functional, the next
   * user-driven checkpoint will wake the observer normally. We log and
   * move on.
   */
  emitSpawnCheckpoint(sessionGroupId: string, workspaceCwd: string): void {
    const payload: CheckpointPayload = {
      schema_version: COUNCIL_SCHEMA_VERSION,
      checkpoint_id: `spawn-${sessionGroupId}`,
      phase: "spawn",
      sequence: 0,
      session_group_id: sessionGroupId,
      emitted_at: new Date().toISOString(),
      artifact_paths: [],
    };
    const target = join(workspaceCwd, ".council", "checkpoints", buildCheckpointFilename(payload.phase, sessionGroupId));
    try {
      writeAtomicJson(target, payload);
      this.spawnCheckpointPending.delete(sessionGroupId);
      log.info("session-orchestrator", "council.spawn_checkpoint.emitted", {
        event: "council.spawn_checkpoint.emitted",
        sessionGroupId,
        target,
      });
    } catch (err) {
      log.warn("session-orchestrator", "council.spawn_checkpoint.failed", {
        event: "council.spawn_checkpoint.failed",
        sessionGroupId,
        target,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
