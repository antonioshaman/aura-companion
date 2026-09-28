import type { IdleTimerManager } from "./idle-timer-manager.js";
import type { IdleTimerEnactor } from "./session-group-coordinator.js";
import {
  buildNoopIdleTimerManager,
  runAutoProceedBootReconcile,
  type OrchestratorGroupMetaForRehydrate,
  type OrchestratorWatcherForRehydrate,
} from "./auto-proceed-orchestrator-bindings.js";
import type { GroupEvent } from "./group-state-machine.js";
import type { BrowserObserverFinding } from "./session-types.js";
import { AUTO_PROCEED_MAX_ITERATIONS_CEILING } from "./auto-proceed-types.js";
import { matchDispute } from "./observer-disputes.js";
import {
  MAX_FINDING_ID_LEN,
  addStopResolution,
  readStopResolutions,
} from "./auto-proceed-stop-resolutions.js";
import { addIgnoredRestoreGap } from "./auto-proceed-restore-gaps.js";
import { log } from "./logger.js";

/** Validated per-session opt-in (routes.ts boundary parser output). */
export interface AutoProceedOnIdleConfig {
  readonly idleMs: number;
  readonly maxIterations: number;
}

/**
 * A STOP that should hold auto-proceed: the same predicate the browser uses
 * for its blocker banner — live STOP severity, not weakly grounded (B2), not
 * matching an earlier human dispute (B2b). Downgraded findings are already
 * NOTE by severity.
 */
export function isBlockingStopFinding(finding: BrowserObserverFinding): boolean {
  return finding.severity === "STOP" && !finding.weakEvidence && !finding.disputed;
}

/**
 * FIX-AP-2 restore predicate: a finding holds after a restart when it blocks
 * by its (frozen or re-grounded) verdict, or when it was a raw STOP whose
 * verdict was never frozen and no human disputed it.
 */
function holdsOnRestore(finding: BrowserObserverFinding, unfrozenRawStopIds: ReadonlySet<string>): boolean {
  return isBlockingStopFinding(finding) || (unfrozenRawStopIds.has(finding.id) && !finding.disputed);
}

/**
 * Auto-proceed (AFK idle-timeout) controller (aura-meta-diet P4/C1c).
 *
 * Owns the orchestrator's handle on the {@link IdleTimerManager} and every
 * call site that drives it: the cross-tab user-frame gate, the sticky-token
 * clear on session exit / archive, the API-limit pause, the boot reconcile of
 * on-disk traces, and the enactor the coordinator drains idle-timer effects
 * into (AP-2 — the state machine stays the sole mutator).
 *
 * Extracted verbatim from `session-orchestrator.ts`. The orchestrator owns the
 * council watcher/meta maps and hands them in (AP-1 DI). Every method reads
 * the CURRENT manager, so the late `setManager` swap `index.ts` performs to
 * break the construct cycle reaches listeners wired before it.
 *
 * Lifecycle of the manager itself:
 *  - Boot reconcile: {@link rehydrateTraces}, run from `initialize()` after
 *    `reconcileCouncilGroups`, scans each active group's `.council/state/` for
 *    trace JSON and rehydrates the per-session iteration counter.
 *  - SIGTERM drain: `disposeAll()` is the FIRST step in `group-shutdown.ts`,
 *    called BEFORE kill propagation (EC-2 extends naturally — timers cleared
 *    before kills fire to children).
 * Null-object when DI omits it so test paths and existing tests don't crash;
 * production always wires the real manager from `index.ts`.
 */

export interface CouncilAutoProceedControllerDeps {
  /** Optional initial manager; defaults to the inert null-object manager. */
  manager?: IdleTimerManager;
  /** Orchestrator-owned group maps — the boot reconcile reads them. */
  groupMeta: ReadonlyMap<string, OrchestratorGroupMetaForRehydrate>;
  watchers: ReadonlyMap<string, OrchestratorWatcherForRehydrate>;
  /**
   * aura-meta-diet C3 — auto-proceed layer gate. Consulted on every `arm`;
   * `false` refuses the arm (logged). Omitted → always allowed (prod default).
   */
  isAutoProceedAllowed?: (sessionId: string) => boolean;
  /**
   * AP-WIRE — the orchestrator-half's persisted `autoProceedOnIdle` opt-in
   * (launcher info). `undefined` → the session never arms. Omitted → nothing
   * arms (tests / non-council wiring).
   */
  getAutoProceedConfig?: (sessionId: string) => AutoProceedOnIdleConfig | undefined;
  /** AP-WIRE — Companion sessionId → council group id (reverse index). */
  getGroupIdForSession?: (sessionId: string) => string | undefined;
  /** AP-WIRE — routes auto-proceed events through `coordinator.applyEvent`
   *  (AP-2: the state machine stays the sole decider of arm/cancel). */
  applyGroupEvent?: (sessionGroupId: string, event: GroupEvent) => void;
  /** AP-WIRE — `COMPANION_ORCH_AUTO_PROCEED_MAX_ITERATIONS_CEILING`, already
   *  resolved; clamps the per-session `maxIterations`. Defaults to the hard cap. */
  iterationCeiling?: number;
  /**
   * FIX-AP-1/FIX-AP-2 — restores the unresolved-STOP hold after a server
   * restart from the group's findings as the blocker banner sees them after a
   * reload (verdicts frozen at review time, disputes applied — no
   * re-grounding). `null` → the group is unknown (restore incomplete).
   * Omitted → nothing to restore (tests / non-council wiring).
   */
  loadGroupStopHoldView?: (sessionGroupId: string) => Promise<GroupStopHoldView | null>;
}

/** What the hold restore reads from disk (FIX-AP-2). */
export interface GroupStopHoldView {
  findings: readonly BrowserObserverFinding[];
  /** Raw STOPs whose grounding verdict was never frozen: they hold as STOP
   *  unless disputed (fail-closed; never re-grounded into a release). */
  unfrozenRawStopIds: readonly string[];
  /** Why the view may be incomplete (unreadable review / verdicts file, …).
   *  Any gap keeps the restore incomplete, so auto-proceed stays held. */
  gaps: readonly string[];
}

/**
 * Per-group mirror of the blocker banner (FIX-AP-1). A blocking STOP stays
 * here until a human dismisses or disputes it; a later clean review does not
 * release it, because the banner keeps showing it too.
 */
interface GroupStopHold {
  /** `undefined` → not restored from disk yet; `pending` → restore in flight. */
  restore: "pending" | "done" | undefined;
  unresolved: Map<string, BrowserObserverFinding>;
  /** Finding ids a human dismissed (persisted in `<group>-resolved-stops.json`). */
  resolved: Set<string>;
  /** An idle edge arrived while restoring; re-tried when the restore lands. */
  idleWaiting: boolean;
}

export type IgnoreRestoreGapResult =
  | { ok: true; added: boolean }
  | { ok: false; reason: "unknown_group" | "invalid_input" | "write_failed" };

export type ResolveStopResult =
  | { ok: true; released: boolean; persisted: boolean }
  | { ok: false; reason: "unknown_group" | "invalid_input" };

/** The subscription points {@link CouncilAutoProceedController.wire} needs. */
export interface AutoProceedWiring {
  onUserFrameObserved(callback: (sessionId: string) => void): unknown;
  onSessionExited(callback: (sessionId: string) => void): unknown;
  /** AP-WIRE — `orchestrator:turn-done` (in-flight → awaiting-input edge). */
  onOrchestratorTurnDone?(callback: (sessionId: string, blockedByStop: boolean) => void): unknown;
  /** AP-WIRE — `group:review` (grounded findings for one checkpoint). */
  onGroupReview?(callback: (sessionGroupId: string, findings: readonly BrowserObserverFinding[]) => void): unknown;
}

export class CouncilAutoProceedController {
  private manager: IdleTimerManager;
  private readonly groupMeta: ReadonlyMap<string, OrchestratorGroupMetaForRehydrate>;
  private readonly watchers: ReadonlyMap<string, OrchestratorWatcherForRehydrate>;
  private readonly isAutoProceedAllowed?: (sessionId: string) => boolean;
  private readonly getAutoProceedConfig?: (sessionId: string) => AutoProceedOnIdleConfig | undefined;
  private readonly getGroupIdForSession?: (sessionId: string) => string | undefined;
  private readonly applyGroupEvent?: (sessionGroupId: string, event: GroupEvent) => void;
  private readonly iterationCeiling: number;
  private readonly loadGroupStopHoldView?: (sessionGroupId: string) => Promise<GroupStopHoldView | null>;
  /**
   * Unresolved blocking STOPs per group (FIX-AP-1). The adapter's own
   * `blockedByStop` axis is reset on every turn edge, so it cannot hold this.
   */
  private readonly holds = new Map<string, GroupStopHold>();
  /** Orchestrators whose cap refusal was already logged this episode. */
  private readonly capLogged = new Set<string>();

  /**
   * PLAN Task 8: route applyEvent's auto-proceed idle-timer descriptors into
   * the real IdleTimerManager. AP-2 — the state machine is the sole mutator;
   * this seam is the enactor that drains its effects.
   */
  readonly enactor: IdleTimerEnactor = {
    arm: (sessionId, options) => {
      const sessionGroupId = this.getGroupIdForSession?.(sessionId);
      if (this.isAutoProceedAllowed && !this.isAutoProceedAllowed(sessionId)) {
        log.info("auto-proceed", "arm refused: autoProceed layer disabled", {
          event: "auto-proceed.layer-disabled",
          sessionGroupId,
          sessionId,
          role: "orchestrator",
        });
        return;
      }
      // EC-9: the manager's verdict is logged, not dropped (FIX-AP-1).
      const result = this.manager.arm(sessionId, options);
      if (result?.kind === "armed") {
        log.info("auto-proceed", "idle timer armed", {
          event: "auto-proceed.armed",
          sessionGroupId,
          sessionId,
          role: "orchestrator",
          idleMs: options.idleMs,
          maxIterations: options.maxIterations,
        });
      } else {
        log.info("auto-proceed", "arm refused", {
          event: "auto-proceed.arm-refused",
          sessionGroupId,
          sessionId,
          role: "orchestrator",
          reason: result?.kind === "refused" ? result.reason : "unknown",
        });
      }
    },
    cancel: (sessionId) => this.manager.cancel(sessionId),
    noteUserMessage: (sessionId) => this.manager.noteUserMessage(sessionId),
  };

  constructor(deps: CouncilAutoProceedControllerDeps) {
    // Null-object default when DI omits the manager. Disposing a null
    // manager is a no-op; rehydrate is a no-op; arm/cancel/note are no-ops.
    // Production wires the real manager from `index.ts` so the boot
    // reconcile path actually rehydrates traces.
    this.manager = deps.manager ?? buildNoopIdleTimerManager();
    this.groupMeta = deps.groupMeta;
    this.watchers = deps.watchers;
    this.isAutoProceedAllowed = deps.isAutoProceedAllowed;
    this.getAutoProceedConfig = deps.getAutoProceedConfig;
    this.getGroupIdForSession = deps.getGroupIdForSession;
    this.applyGroupEvent = deps.applyGroupEvent;
    this.iterationCeiling = Math.min(
      deps.iterationCeiling ?? AUTO_PROCEED_MAX_ITERATIONS_CEILING,
      AUTO_PROCEED_MAX_ITERATIONS_CEILING,
    );
    this.loadGroupStopHoldView = deps.loadGroupStopHoldView;
  }

  getManager(): IdleTimerManager {
    return this.manager;
  }

  setManager(manager: IdleTimerManager): void {
    this.manager = manager;
  }

  /** Registers the two event-driven call sites. Called once from `initialize()`. */
  wire(wiring: AutoProceedWiring): void {
    // Task 11.6 — cross-tab single-firer wiring for the auto-proceed
    // turn-token. The bridge fires `onUserFrameObserved` once per
    // browser→server `user_message` frame regardless of tab count.
    // Forwarding to `idleTimerManager.noteUserMessage` advances the
    // per-session monotonic turn-token, which cancels any pending
    // synthetic-fire and invalidates an in-flight fire callback (the
    // re-read inside `fire()` is the actual single-firer gate; this
    // wiring is the observability path that drives it).
    //
    // Production caller for `IdleTimerManager.noteUserMessage` — closes
    // the call-site gap from Task 11.1 foundation work where the method
    // shipped with unit tests but no production wiring.
    wiring.onUserFrameObserved((sessionId) => {
      this.manager.noteUserMessage(sessionId);
      // FIX-AP-1: a human message ends the unattended episode, so the
      // iteration budget starts again. Only browser-typed frames reach here.
      if (this.getAutoProceedConfig?.(sessionId)) {
        this.manager.resetIterationCount(sessionId);
        this.capLogged.delete(sessionId);
      }
    });

    // Task 11.8 — clear the pending-synthetic-turn sticky token on every
    // session exit. Without this, a session that died mid-synthetic-turn
    // (CLI crash before result-frame, container teardown, manual kill)
    // would leave the sticky token armed in the manager; if the same
    // sessionId were later re-used (--resume), the next can_use_tool
    // check would falsely treat the resumed session as auto-proceed-
    // driven. `clearPendingSyntheticTurn` is idempotent on never-armed
    // sessions, so firing it on every exit is safe regardless of
    // whether auto-proceed was actually in play.
    wiring.onSessionExited((sessionId) => {
      this.manager.clearPendingSyntheticTurn(sessionId);
    });

    // AP-WIRE — the producer of `orchestrator_turn_idle` (ASK #9: before
    // this, nothing emitted it and auto-proceed never armed in prod). Each
    // in-flight → awaiting-input edge of an opted-in orchestrator arms the
    // idle timer; the synthetic fire flips the session back to in-flight and
    // its `result` re-arms here until the iteration cap trips in the manager.
    wiring.onOrchestratorTurnDone?.((sessionId, blockedByStop) => {
      this.noteOrchestratorIdle(sessionId, blockedByStop);
    });

    // AP-WIRE — the producer of `stop_finding_raised`. A blocking STOP
    // cancels the pending timer and holds re-arming until a human dismisses
    // or disputes it (FIX-AP-1: same lifetime as the blocker banner).
    wiring.onGroupReview?.((sessionGroupId, findings) => {
      this.noteGroupReview(sessionGroupId, findings);
    });
  }

  /** Arms the idle timer for an opted-in orchestrator that just went idle. */
  noteOrchestratorIdle(sessionId: string, blockedByStop: boolean): void {
    const config = this.getAutoProceedConfig?.(sessionId);
    if (!config) return; // not opted in (or layer off at create) — nothing arms
    if (blockedByStop) return;
    const sessionGroupId = this.getGroupIdForSession?.(sessionId);
    if (!sessionGroupId) return;
    const hold = this.holdFor(sessionGroupId);
    if (!this.ensureRestored(sessionGroupId, sessionId)) {
      // Fail closed until the persisted STOPs are known.
      hold.idleWaiting = true;
      this.logHold(sessionGroupId, sessionId, "restoring", []);
      return;
    }
    if (hold.unresolved.size > 0) {
      this.logHold(sessionGroupId, sessionId, "unresolved_stop", [...hold.unresolved.keys()]);
      return;
    }
    const maxIterations = Math.min(config.maxIterations, this.iterationCeiling);
    // FIX-AP-1: past the cap there is nothing to arm. The manager would only
    // refuse at fire time and log `fire-cap-reached` on every idle edge.
    const iteration = this.manager.getIterationCount(sessionId);
    if (iteration >= maxIterations) {
      if (!this.capLogged.has(sessionId)) {
        this.capLogged.add(sessionId);
        log.info("auto-proceed", "not arming: iteration cap reached", {
          event: "auto-proceed.cap-reached",
          sessionGroupId,
          sessionId,
          role: "orchestrator",
          iteration,
          maxIterations,
        });
      }
      return;
    }
    this.applyGroupEvent?.(sessionGroupId, {
      type: "orchestrator_turn_idle",
      sessionId,
      idleMs: config.idleMs,
      maxIterations,
    });
  }

  /**
   * Adds each blocking STOP of a processed review to the group's hold. A
   * review without one releases nothing: the banner still shows the earlier
   * STOP (FIX-AP-1 — "STOP in A, NOTE in B" must not fire).
   */
  noteGroupReview(sessionGroupId: string, findings: readonly BrowserObserverFinding[]): void {
    const primary = this.groupMeta.get(sessionGroupId)?.primarySessionId;
    if (!primary || !this.getAutoProceedConfig?.(primary)) return;
    const hold = this.holdFor(sessionGroupId);
    this.ensureRestored(sessionGroupId, primary);
    const added: string[] = [];
    for (const f of findings) {
      if (!isBlockingStopFinding(f) || hold.resolved.has(f.id) || hold.unresolved.has(f.id)) continue;
      hold.unresolved.set(f.id, f);
      added.push(f.id);
    }
    if (added.length === 0) return;
    log.info("auto-proceed", "observer STOP holds auto-proceed", {
      event: "auto-proceed.stop-held",
      sessionGroupId,
      sessionId: primary,
      role: "orchestrator",
      findingIds: added,
      unresolvedStops: hold.unresolved.size,
    });
    this.applyGroupEvent?.(sessionGroupId, { type: "stop_finding_raised", sessionId: primary });
  }

  /**
   * A human dismissed a STOP ("Dismiss for now"). Persists the resolution so
   * a restart does not re-hold on it, then releases the hold for that id.
   * The in-memory release happens even when the write fails: the human's
   * decision is known now; only its survival across a restart is lost.
   */
  resolveStop(sessionGroupId: string, findingId: string): ResolveStopResult {
    if (typeof findingId !== "string" || findingId.length === 0 || findingId.length > MAX_FINDING_ID_LEN) {
      return { ok: false, reason: "invalid_input" };
    }
    const primary = this.groupMeta.get(sessionGroupId)?.primarySessionId;
    const cwd = this.watchers.get(sessionGroupId)?.cwd;
    if (!primary || !cwd) return { ok: false, reason: "unknown_group" };
    const written = addStopResolution(cwd, sessionGroupId, findingId);
    if (!written.ok) {
      log.warn("auto-proceed", "STOP resolution not persisted", {
        event: "auto-proceed.resolution-persist-failed",
        sessionGroupId,
        sessionId: primary,
        role: "orchestrator",
        findingId,
        reason: written.reason,
      });
    }
    this.holds.get(sessionGroupId)?.resolved.add(findingId);
    const released = this.release(sessionGroupId, primary, [findingId], "dismissed");
    return { ok: true, released, persisted: written.ok };
  }

  /**
   * A human disputed a STOP (B2b). Releases that finding and every held STOP
   * the dispute now matches — the same ones the banner stops showing.
   */
  noteDispute(sessionGroupId: string, input: { claim: string; evidencePath: string; findingId?: string }): void {
    const hold = this.holds.get(sessionGroupId);
    const primary = this.groupMeta.get(sessionGroupId)?.primarySessionId;
    if (!hold || !primary) return;
    const record = { claim: input.claim, evidencePath: input.evidencePath, source: "browser_dispute" as const, disputedAt: "" };
    const ids = [...hold.unresolved.values()]
      .filter((f) => f.id === input.findingId || matchDispute([record], f.claim, f.evidence_path) !== null)
      .map((f) => f.id);
    this.release(sessionGroupId, primary, ids, "disputed");
  }

  /**
   * The pair is being archived: cancel any pending timer explicitly and drop
   * the group's hold state. Unarchive re-restores from disk on the next edge.
   */
  noteArchived(sessionId: string): void {
    if (!this.getAutoProceedConfig?.(sessionId)) return;
    const sessionGroupId = this.getGroupIdForSession?.(sessionId);
    this.manager.cancel(sessionId);
    if (sessionGroupId) this.holds.delete(sessionGroupId);
    this.capLogged.delete(sessionId);
    log.info("auto-proceed", "timer cancelled on archive", {
      event: "auto-proceed.archived",
      sessionGroupId,
      sessionId,
      role: "orchestrator",
    });
  }

  /**
   * FIX-AP-3 — the findings of a bootstrap view that hold (or will hold once
   * restored) the group's auto-proceed but that the blocker banner would hide
   * on its own predicate (an unfrozen raw STOP re-grounded to NOTE / weak).
   * The bootstrap flags them so every hold has a visible, dismissable STOP.
   * Empty when the orchestrator never opted in or its layer is off (nothing
   * arms, so nothing is held). Dismissals — in memory or on disk — are out.
   */
  invisibleHeldStopIds(sessionGroupId: string, view: Omit<GroupStopHoldView, "gaps">): Set<string> {
    const out = new Set<string>();
    const primary = this.groupMeta.get(sessionGroupId)?.primarySessionId;
    if (!primary || !this.getAutoProceedConfig?.(primary)) return out;
    if (this.isAutoProceedAllowed && !this.isAutoProceedAllowed(primary)) return out;
    const hold = this.holds.get(sessionGroupId);
    const resolved = this.resolvedStopIds(sessionGroupId);
    const unfrozen = new Set(view.unfrozenRawStopIds);
    for (const f of view.findings) {
      if (isBlockingStopFinding(f) || resolved.has(f.id)) continue;
      if (holdsOnRestore(f, unfrozen) || hold?.unresolved.has(f.id)) out.add(f.id);
    }
    return out;
  }

  /**
   * FIX-AP-4 — true when the group's orchestrator opted in with the layer on:
   * only then does an incomplete restore hold anything, so only then does the
   * REST bootstrap report the restore gaps to the ObserverPanel.
   */
  autoProceedHoldApplies(sessionGroupId: string): boolean {
    const primary = this.groupMeta.get(sessionGroupId)?.primarySessionId;
    if (!primary || !this.getAutoProceedConfig?.(primary)) return false;
    return !this.isAutoProceedAllowed || this.isAutoProceedAllowed(primary);
  }

  /**
   * FIX-AP-4 — a human chose "ignore this file" for a review file that keeps
   * the hold restore incomplete. Persists the decision (file + fingerprint of
   * the content the human saw), then re-runs the restore so a waiting idle
   * edge can arm. Unlike a STOP dismissal, an unpersisted ignore changes
   * nothing: the restore reads the decision from disk.
   */
  ignoreRestoreGap(sessionGroupId: string, file: string, fingerprint: string): IgnoreRestoreGapResult {
    const primary = this.groupMeta.get(sessionGroupId)?.primarySessionId;
    const cwd = this.watchers.get(sessionGroupId)?.cwd;
    if (!primary || !cwd) return { ok: false, reason: "unknown_group" };
    const written = addIgnoredRestoreGap(cwd, sessionGroupId, { file, fingerprint });
    if (!written.ok) {
      if (written.reason === "invalid-input") return { ok: false, reason: "invalid_input" };
      log.warn("auto-proceed", "restore gap ignore not persisted", {
        event: "auto-proceed.restore-gap-ignore-failed",
        sessionGroupId,
        sessionId: primary,
        role: "orchestrator",
        file,
        reason: written.reason,
      });
      return { ok: false, reason: "write_failed" };
    }
    log.info("auto-proceed", "restore gap ignored by a human", {
      event: "auto-proceed.restore-gap-ignored",
      sessionGroupId,
      sessionId: primary,
      role: "orchestrator",
      file,
    });
    const hold = this.holds.get(sessionGroupId);
    // An in-flight restore re-tries on the next event; an incomplete one
    // (restore undefined) re-runs now and re-tries a waiting idle edge.
    if (hold && hold.restore === undefined && this.autoProceedHoldApplies(sessionGroupId)) {
      this.ensureRestored(sessionGroupId, primary);
    }
    return { ok: true, added: written.added };
  }

  /**
   * BANNER-RESOLVED — every STOP a human released with "Dismiss for now":
   * the persisted resolutions plus the in-memory ones (a failed write still
   * released the hold in this process). Independent of the auto-proceed
   * opt-in: the REST bootstrap marks these findings `dismissed` so a reload
   * does not raise the banner again for a STOP the human already let go.
   */
  resolvedStopIds(sessionGroupId: string): Set<string> {
    const resolved = new Set(this.holds.get(sessionGroupId)?.resolved ?? []);
    const cwd = this.watchers.get(sessionGroupId)?.cwd;
    if (cwd) {
      const read = readStopResolutions(cwd, sessionGroupId);
      if (read.ok) for (const id of read.findingIds) resolved.add(id);
    }
    return resolved;
  }

  /** Test / diagnostics: the finding ids currently holding the group. */
  getUnresolvedStopIds(sessionGroupId: string): string[] {
    return [...(this.holds.get(sessionGroupId)?.unresolved.keys() ?? [])];
  }

  private holdFor(sessionGroupId: string): GroupStopHold {
    let hold = this.holds.get(sessionGroupId);
    if (!hold) {
      hold = { restore: undefined, unresolved: new Map(), resolved: new Set(), idleWaiting: false };
      this.holds.set(sessionGroupId, hold);
    }
    return hold;
  }

  /**
   * Restores the hold from what is on disk (reviews as the banner sees them,
   * minus persisted dismissals) once per group. Returns true when the hold is
   * complete; false while the restore is in flight or incomplete.
   *
   * Fail-closed (FIX-AP-2): an unknown group, a missing workspace, an
   * unreadable review / verdicts file or a thrown load leaves the restore
   * incomplete — every STOP it did find still holds, nothing arms, and the
   * restore is re-tried on the next event. Unreadable dismissals are not a
   * gap: they only ever release, so holding on every STOP is the safe side.
   */
  private ensureRestored(sessionGroupId: string, primary: string): boolean {
    const hold = this.holdFor(sessionGroupId);
    if (hold.restore === "done") return true;
    if (hold.restore === "pending") return false;
    const load = this.loadGroupStopHoldView;
    if (!load) {
      hold.restore = "done";
      return true;
    }
    hold.restore = "pending";
    const cwd = this.watchers.get(sessionGroupId)?.cwd;
    void (async () => {
      try {
        const view = await load(sessionGroupId);
        if (this.holds.get(sessionGroupId) !== hold) return; // archived meanwhile
        const gaps: string[] = [];
        if (!view) gaps.push("group_unknown");
        if (!cwd) gaps.push("no_workspace");
        if (view) gaps.push(...view.gaps);
        if (cwd) {
          const read = readStopResolutions(cwd, sessionGroupId);
          if (read.ok) {
            for (const id of read.findingIds) hold.resolved.add(id);
          } else {
            log.warn("auto-proceed", "STOP resolutions unreadable; holding on every STOP", {
              event: "auto-proceed.resolutions-unreadable",
              sessionGroupId,
              sessionId: primary,
              role: "orchestrator",
              reason: read.reason,
            });
          }
        }
        const unfrozen = new Set(view?.unfrozenRawStopIds ?? []);
        for (const f of view?.findings ?? []) {
          if (hold.unresolved.has(f.id)) continue;
          if (holdsOnRestore(f, unfrozen)) hold.unresolved.set(f.id, f);
        }
        for (const id of hold.resolved) hold.unresolved.delete(id);
        if (gaps.length > 0) {
          hold.restore = undefined;
          log.warn("auto-proceed", "STOP hold restore incomplete; holding", {
            event: "auto-proceed.hold-restore-incomplete",
            sessionGroupId,
            sessionId: primary,
            role: "orchestrator",
            gaps,
            unresolvedStops: hold.unresolved.size,
          });
          if (hold.unresolved.size > 0) {
            this.applyGroupEvent?.(sessionGroupId, { type: "stop_finding_raised", sessionId: primary });
          }
          return;
        }
        hold.restore = "done";
        log.info("auto-proceed", "STOP hold restored", {
          event: "auto-proceed.hold-restored",
          sessionGroupId,
          sessionId: primary,
          role: "orchestrator",
          unresolvedStops: hold.unresolved.size,
          ...(unfrozen.size > 0 ? { unfrozenRawStops: unfrozen.size } : {}),
        });
        const waiting = hold.idleWaiting;
        hold.idleWaiting = false;
        if (hold.unresolved.size > 0) {
          this.applyGroupEvent?.(sessionGroupId, { type: "stop_finding_raised", sessionId: primary });
        } else if (waiting) {
          this.noteOrchestratorIdle(primary, false);
        }
      } catch (err) {
        hold.restore = undefined;
        log.warn("auto-proceed", "STOP hold restore failed; holding", {
          event: "auto-proceed.hold-restore-failed",
          sessionGroupId,
          sessionId: primary,
          role: "orchestrator",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();
    return false;
  }

  /** Removes ids from the hold; the last one out re-tries the arm. */
  private release(sessionGroupId: string, primary: string, ids: readonly string[], via: "dismissed" | "disputed"): boolean {
    const hold = this.holds.get(sessionGroupId);
    if (!hold) return false;
    const removed = ids.filter((id) => hold.unresolved.delete(id));
    if (removed.length === 0) return false;
    log.info("auto-proceed", "observer STOP released by a human", {
      event: "auto-proceed.stop-released",
      sessionGroupId,
      sessionId: primary,
      role: "orchestrator",
      findingIds: removed,
      via,
      unresolvedStops: hold.unresolved.size,
    });
    if (hold.unresolved.size > 0) return true;
    this.applyGroupEvent?.(sessionGroupId, { type: "stop_finding_resolved", sessionId: primary });
    // The manager's gate refuses if the orchestrator is mid-turn.
    if (hold.restore === "done") this.noteOrchestratorIdle(primary, false);
    return true;
  }

  private logHold(sessionGroupId: string, sessionId: string, reason: "restoring" | "unresolved_stop", findingIds: string[]): void {
    log.info("auto-proceed", "not arming: held", {
      event: "auto-proceed.hold",
      sessionGroupId,
      sessionId,
      role: "orchestrator",
      reason,
      ...(findingIds.length > 0 ? { findingIds } : {}),
    });
  }

  /**
   * PLAN-aura-orchestrator-idle-auto-proceed Task 9: boot reconcile.
   *
   * Walks each active council group's `.council/state/` directory looking
   * for `<group-id>-auto-proceed-trace.json` files. For each parseable
   * trace whose `sessionGroupId` matches a reconciled group, calls
   * {@link IdleTimerManager.rehydrate} with the orchestrator-half session
   * id so the in-memory iteration counter resumes from disk rather than
   * starting at zero.
   *
   * Logic lives in the dependency-injected `reconcileAutoProceedTraces`
   * reducer so the unit test exercises the real filesystem + real manager
   * without standing up the orchestrator's full event-bus harness. This
   * method is just the concrete-bindings adapter.
   *
   * Idempotency: re-running with no on-disk changes is a no-op. Errors
   * are caught + logged inside the reducer; this method never throws so
   * `initialize()` always completes.
   */
  rehydrateTraces(): void {
    runAutoProceedBootReconcile(
      this.groupMeta,
      this.watchers,
      this.manager,
      (entry) =>
        log.info("session-orchestrator", "auto-proceed reconcile", entry as unknown as Record<string, unknown>),
    );
  }

  /** Read by the checkpoint pipeline: no observer wakes while the account is limited. */
  isApiLimitReached(sessionId: string): boolean {
    return this.manager.isApiLimitReached(sessionId);
  }

  /** Rate-limit / out-of-credits fallback: pause AFK auto-proceed for the session. */
  noteApiLimitReached(sessionId: string): void {
    this.manager.noteApiLimitReached(sessionId);
  }

  /** Idempotent on never-armed sessions. */
  clearPendingSyntheticTurn(sessionId: string): void {
    this.manager.clearPendingSyntheticTurn(sessionId);
  }
}
