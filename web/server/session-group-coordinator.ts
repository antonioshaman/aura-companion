import { randomBytes } from "node:crypto";
import { isSupportedPairing } from "./backend-provider.js";
import { GROUP_ID_PATTERN } from "./group-authorization.js";
import {
  deriveSideEffects,
  type GroupBusSideEffect,
  type GroupEvent,
  type GroupIdleTimerEffect,
  type GroupLogEntry,
  type GroupStatus,
  transition,
} from "./group-state-machine.js";
import type { BackendType, SessionGroupRole } from "./session-types.js";
import { companionBus } from "./event-bus.js";
import { log } from "./logger.js";

/**
 * Cryptographically random group ID. ≥128 bits of entropy from
 * `randomBytes(16)` so IDs cannot be guessed by enumeration. Format
 * matches {@link GROUP_ID_PATTERN} from group-authorization.ts; both
 * sides use the same constant to avoid drift (Fowler F2).
 */
function generateGroupId(): string {
  return `grp_${randomBytes(16).toString("hex")}`;
}

export interface CreateGroupRequest {
  /** Shared workspace cwd for both halves of the pair. */
  cwd: string;
  /** The primary (orchestrator) backend. */
  primary: BackendType;
  /** The observer backend. */
  observer: BackendType;
  /** Optional — forwarded to the underlying session spawner. */
  model?: string;
  /** Optional — forwarded to the underlying session spawner. */
  permissionMode?: string;
  /**
   * Opaque per-call context plumbed through to the `SessionSpawner`'s opts
   * argument as-is. Caller defines the shape (typed at the call site via a
   * cast inside the spawner closure). Replaces the prior `pendingCouncilCall`
   * instance-field side channel on `SessionOrchestrator` that two concurrent
   * `createCouncilGroup` invocations could race and cross-contaminate.
   *
   * Closure-captured local context in the spawner is the structurally safe
   * pattern (each `createGroup` call brings its own context object; spawn
   * callbacks read from `opts.spawnContext`, not from shared mutable state).
   * PLAN-aura-consolidated-refactor.md Task 2.
   */
  spawnContext?: unknown;
}

/** What the injected spawner must return for the coordinator to record the pair. */
export interface SpawnedSession {
  sessionId: string;
}

/**
 * Narrow injectable spawn surface. Real callers wire this to the existing
 * SessionOrchestrator.createSession so the coordinator never reaches into
 * orchestrator internals — composition over modification (Fowler P6).
 */
export type SessionSpawner = (opts: {
  cwd: string;
  backendType: BackendType;
  model?: string;
  permissionMode?: string;
  sessionGroupId: string;
  sessionGroupRole: SessionGroupRole;
  /**
   * Per-call context forwarded verbatim from `CreateGroupRequest.spawnContext`.
   * The spawner casts to its expected shape — type safety is the caller's
   * responsibility since the coordinator never inspects this field.
   */
  spawnContext?: unknown;
}) => Promise<SpawnedSession>;

export type SessionKiller = (sessionId: string) => Promise<void>;

/** Optional log/telemetry sink for kill failures so they are not silently swallowed. */
export type CoordinatorErrorSink = (event: {
  op: "rollback_kill" | "archive_kill";
  sessionGroupId: string;
  sessionId: string;
  error: unknown;
}) => void;

export interface GroupMember {
  sessionId: string;
  backendType: BackendType;
}

export interface GroupRecord {
  sessionGroupId: string;
  primary: GroupMember;
  observer: GroupMember;
  status: GroupStatus;
  createdAt: number;
  /** Bidirectional pipeline Story 4.1: clean-cycle counter, server-authoritative.
   *  Absent on solo (non-Council) sessions and on freshly-created pairs that
   *  have not yet had any review processed. */
  cycleNumber?: number;
  convergenceThreshold?: number;
  convergenceState?: "in-progress" | "converged" | "revoked";
}

export interface SessionGroupCoordinatorDeps {
  spawn: SessionSpawner;
  kill: SessionKiller;
  /** Optional sink for kill-failure telemetry. Defaults to a console.warn fallback. */
  onError?: CoordinatorErrorSink;
  /** Injectable clock for deterministic latency measurements in tests.
   *  Defaults to `Date.now`. Bun/Hono Backend P5: never read `Date.now` in
   *  hot paths that tests need to pin without `vi.useFakeTimers()`. */
  now?: () => number;
  /** Group-level reconnect grace window in ms (PLAN Task 2). Optional with
   *  a 45s default; the orchestrator resolves `COMPANION_GROUP_RECONNECT_GRACE_MS`
   *  at module load and passes it here so the coordinator never reads env in
   *  hot paths. */
  graceMs?: number;
  /** Enacts idle-timer side-effect descriptors emitted by `applyEvent` for
   *  auto-proceed events (PLAN Task 8). Optional with a no-op default so
   *  existing unit tests that don't exercise auto-proceed don't need to
   *  thread a stub. Production wires this to {@link IdleTimerManager}'s
   *  `arm` / `cancel` / `noteUserMessage` methods through a thin adapter. */
  idleTimerEnactor?: IdleTimerEnactor;
}

/**
 * Narrow surface the coordinator calls into when draining
 * {@link GroupIdleTimerEffect} descriptors. Mirrors the public method
 * set of {@link IdleTimerManager} so production wiring is a one-line
 * pass-through; tests substitute a recording fake.
 */
export interface IdleTimerEnactor {
  arm(sessionId: string, options: { idleMs: number; maxIterations: number }): void;
  cancel(sessionId: string): void;
  noteUserMessage(sessionId: string): void;
}

/** No-op default — used when {@link SessionGroupCoordinatorDeps.idleTimerEnactor}
 *  is omitted. Exists so the coordinator never branches on `undefined` in
 *  the hot path of `applyEvent`. */
const NOOP_IDLE_TIMER_ENACTOR: IdleTimerEnactor = {
  arm: () => undefined,
  cancel: () => undefined,
  noteUserMessage: () => undefined,
};

/**
 * Per-group reconnect bookkeeping. Coordinator-private — never exposed on
 * `GroupRecord`, which would tempt parallel-status fields and violate AP-2.
 * The `status` on the record is the only lifecycle truth; this context is
 * just the metadata the coordinator needs to time the grace window and bind
 * `reconnect_ok` to the half that actually disconnected.
 *
 * `survivingRole` is the alive half (the one whose ws frames will reach
 * the browser); `deadRole` is the half we're waiting on. `snapshotSessionId`
 * binds `reconnect_ok` to the exact `sessionId` that disconnected — see
 * Hunt recommendation in PLAN: a different process race-handshaking on the
 * same group cannot claim the slot.
 */
export interface ReconnectContext {
  sessionGroupId: string;
  survivingRole: SessionGroupRole;
  deadRole: SessionGroupRole;
  snapshotSessionId: string;
  startedAtMs: number;
  deadlineMs: number;
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * Owns the lifecycle of Council Mode session pairs. Composes the existing
 * SessionOrchestrator via injected `spawn`/`kill` rather than branching
 * inside it.
 *
 * Scope deliberately narrow: spawn-with-rollback, group state-machine
 * application, archive.
 */
export class SessionGroupCoordinator {
  private groups = new Map<string, GroupRecord>();
  private reconnectContexts = new Map<string, ReconnectContext>();
  private readonly onError: CoordinatorErrorSink;
  private readonly now: () => number;
  private readonly graceMs: number;
  private readonly idleTimerEnactor: IdleTimerEnactor;

  constructor(private deps: SessionGroupCoordinatorDeps) {
    this.onError =
      deps.onError ??
      ((event) =>
        console.warn(
          `[session-group-coordinator] ${event.op} failed for ${event.sessionId} (group ${event.sessionGroupId}):`,
          event.error,
        ));
    this.now = deps.now ?? (() => Date.now());
    this.graceMs = deps.graceMs ?? 45_000;
    this.idleTimerEnactor = deps.idleTimerEnactor ?? NOOP_IDLE_TIMER_ENACTOR;
  }

  /**
   * Spawn both halves of a Council Mode pair sharing one sessionGroupId
   * and one workspace. **Atomic**: if the second spawn fails after the
   * first is live, the first is killed before the error propagates so
   * no orphan subprocess survives outside the UI's awareness. Rollback
   * kill failures are reported through {@link CoordinatorErrorSink}.
   */
  async createGroup(req: CreateGroupRequest): Promise<GroupRecord> {
    if (!isSupportedPairing(req.primary, req.observer)) {
      throw new Error(`unsupported pairing: ${req.primary}+${req.observer}`);
    }
    const sessionGroupId = generateGroupId();
    let primarySpawn: SpawnedSession | null = null;
    try {
      primarySpawn = await this.deps.spawn({
        cwd: req.cwd,
        backendType: req.primary,
        model: req.model,
        permissionMode: req.permissionMode,
        sessionGroupId,
        sessionGroupRole: "orchestrator",
        spawnContext: req.spawnContext,
      });
      const observerSpawn = await this.deps.spawn({
        cwd: req.cwd,
        backendType: req.observer,
        model: req.model,
        permissionMode: req.permissionMode,
        sessionGroupId,
        sessionGroupRole: "observer",
        spawnContext: req.spawnContext,
      });
      const record: GroupRecord = {
        sessionGroupId,
        primary: { sessionId: primarySpawn.sessionId, backendType: req.primary },
        observer: { sessionId: observerSpawn.sessionId, backendType: req.observer },
        status: transition("pairing", { type: "both_ready" }),
        createdAt: Date.now(),
      };
      this.groups.set(sessionGroupId, record);
      return record;
    } catch (err) {
      if (primarySpawn) {
        try {
          await this.deps.kill(primarySpawn.sessionId);
        } catch (killErr) {
          this.onError({
            op: "rollback_kill",
            sessionGroupId,
            sessionId: primarySpawn.sessionId,
            error: killErr,
          });
        }
      }
      throw err;
    }
  }

  /**
   * Apply a state-machine event to a group. Returns the resulting status,
   * or null if the group is unknown.
   *
   * **Sole lifecycle mutator** (PLAN Task 1 keystone, AP-2 enforced): every
   * bus emit on `group:*` and every EC-9 log entry for a transition flows
   * through this method. Callers do not need to remember a paired
   * `bus.emit` or `log.info` — the pure `deriveSideEffects` function
   * decides what fires, this method drains it. Adding a new event arm is
   * one change to the state machine + side-effect table; the rest is
   * automatic.
   */
  applyEvent(sessionGroupId: string, event: GroupEvent): GroupStatus | null {
    const g = this.groups.get(sessionGroupId);
    if (!g) return null;
    const prevStatus = g.status;
    const nextStatus = transition(prevStatus, event);
    g.status = nextStatus;
    const { busEvents, logEntries, idleTimerEffects } = deriveSideEffects(
      prevStatus,
      nextStatus,
      event,
    );
    for (const e of busEvents) this.enactBusEvent(sessionGroupId, e);
    for (const entry of logEntries) this.enactLogEntry(sessionGroupId, entry);
    for (const eff of idleTimerEffects) this.enactIdleTimerEffect(eff);
    return nextStatus;
  }

  /**
   * Translate a side-effect descriptor into a bus emit. The shapes of the
   * existing `group:*` events are fixed by `event-bus-types.ts`; the
   * descriptor types in `group-state-machine.ts` are a parallel narrower
   * view that this method bridges. `reconnecting` and `reconnected` do not
   * yet have their own bus events — they are emitted as orchestrator-side
   * `group:degraded` / restored-status fanout (PLAN Task 7 introduces
   * the `group_reconnecting` wire variant; PLAN Task 7 also recycles
   * `group_created` hydration for the reconnected case).
   */
  private enactBusEvent(sessionGroupId: string, e: GroupBusSideEffect): void {
    if (e.kind === "degraded") {
      companionBus.emit("group:degraded", { sessionGroupId, deadRole: e.deadRole });
      return;
    }
    if (e.kind === "exited") {
      companionBus.emit("group:exited", { sessionGroupId, reason: e.reason });
      return;
    }
    if (e.kind === "reconnecting") {
      // PLAN Task 7: surfaces the bounded grace window to browsers. The
      // orchestrator's `group:reconnecting` listener fans the wire variant
      // out via `broadcastToGroup`. `deadlineMs` is absolute wallclock —
      // robust to in-flight latency, sleeping tabs, and replay.
      companionBus.emit("group:reconnecting", {
        sessionGroupId,
        survivingRole: e.survivingRole,
        deadlineMs: e.deadlineMs,
      });
      return;
    }
    if (e.kind === "reconnected") {
      // PLAN Task 7 (Realtime expert recommendation): recycle the existing
      // `group:created` channel as the idempotent "you may now treat the
      // pair as healthy" surface. The orchestrator's existing
      // `group:created` listener replays `group_created` on the wire; the
      // browser slice's idempotent `upsertGroup` flips status back to
      // `active`. No new variant minted; one less wire shape to drift.
      const g = this.groups.get(sessionGroupId);
      if (!g) return;
      companionBus.emit("group:created", {
        sessionGroupId,
        primarySessionId: g.primary.sessionId,
        observerSessionId: g.observer.sessionId,
      });
      return;
    }
  }

  /**
   * EC-9 structured log entry. Content is bounded to `event` +
   * `sessionGroupId` + optional `role` + `attempts` + (auto-proceed-only)
   * `sessionId` + `iteration` (PLAN Task 7 Hunt recommendation: never
   * include cliSessionId / observerPromptSha256 / workspace absolute
   * path in operational logs — recordings carry that).
   */
  private enactLogEntry(sessionGroupId: string, entry: GroupLogEntry): void {
    log.info("session-group-coordinator", "group lifecycle event", {
      event: entry.event,
      sessionGroupId,
      ...(entry.role ? { role: entry.role } : {}),
      ...(entry.attempts !== undefined ? { attempts: entry.attempts } : {}),
      ...(entry.sessionId !== undefined ? { sessionId: entry.sessionId } : {}),
      ...(entry.iteration !== undefined ? { iteration: entry.iteration } : {}),
    });
  }

  /**
   * Translate an idle-timer descriptor into a call on the injected
   * {@link IdleTimerEnactor}. Single choke point — AP-2 keystone — so a
   * future fourth effect kind is one switch arm here, not a parallel
   * mutator elsewhere. Production wires this to {@link IdleTimerManager};
   * tests substitute a recording stub.
   */
  private enactIdleTimerEffect(effect: GroupIdleTimerEffect): void {
    switch (effect.kind) {
      case "arm-idle-timer":
        this.idleTimerEnactor.arm(effect.sessionId, {
          idleMs: effect.idleMs,
          maxIterations: effect.maxIterations,
        });
        return;
      case "cancel-idle-timer":
        this.idleTimerEnactor.cancel(effect.sessionId);
        return;
      case "note-user-message":
        this.idleTimerEnactor.noteUserMessage(effect.sessionId);
        return;
    }
  }

  /**
   * Arm a reconnect grace timer. Called by the orchestrator's
   * `session:exited` listener when a council-tracked half drops without
   * `intentionalKills`. The timer fires `reconnect_failed → degraded`
   * if not cancelled by `cancelReconnectTimer` (resolution path:
   * `session:cli-id-received` for the recovered half, or explicit
   * `session:relaunch-failed`).
   *
   * Returns the deadline wallclock so the caller can broadcast it to
   * browsers verbatim (absolute deadlines survive in-flight latency,
   * sleeping tabs, replay — PLAN Task 7).
   */
  armReconnect(opts: {
    sessionGroupId: string;
    deadRole: SessionGroupRole;
    snapshotSessionId: string;
    /** Override the coordinator's default `graceMs` (configured at
     *  construction from `COMPANION_GROUP_RECONNECT_GRACE_MS`). Tests pin
     *  short windows; production callers leave undefined. */
    graceMs?: number;
  }): { deadlineMs: number; survivingRole: SessionGroupRole } | null {
    const g = this.groups.get(opts.sessionGroupId);
    if (!g) return null;
    if (this.reconnectContexts.has(opts.sessionGroupId)) {
      // Already in a reconnect cycle — Hunt P7 hard counter: one cycle per
      // active episode. Re-entry is a no-op-with-log, never a re-arm.
      log.warn("session-group-coordinator", "reconnect already armed; ignoring re-entry", {
        event: "group.reconnect_started",
        sessionGroupId: opts.sessionGroupId,
        role: opts.deadRole,
      });
      return null;
    }
    const graceMs = opts.graceMs ?? this.graceMs;
    const survivingRole: SessionGroupRole = opts.deadRole === "orchestrator" ? "observer" : "orchestrator";
    const startedAtMs = this.now();
    const deadlineMs = startedAtMs + graceMs;
    const timer = setTimeout(() => {
      // Coordinator-internal expiry: drive the state machine through
      // `reconnect_failed`, which derives `group:degraded` via the same
      // side-effect channel as a direct half_died.
      const ctx = this.reconnectContexts.get(opts.sessionGroupId);
      if (!ctx) return;
      this.reconnectContexts.delete(opts.sessionGroupId);
      this.applyEvent(opts.sessionGroupId, { type: "reconnect_failed", role: ctx.deadRole });
    }, graceMs);
    this.reconnectContexts.set(opts.sessionGroupId, {
      sessionGroupId: opts.sessionGroupId,
      survivingRole,
      deadRole: opts.deadRole,
      snapshotSessionId: opts.snapshotSessionId,
      startedAtMs,
      deadlineMs,
      timer,
    });
    // Drive the state machine through `reconnect_started`. Side effects
    // (the `reconnecting` bus event + EC-9 log) drain through applyEvent.
    this.applyEvent(opts.sessionGroupId, {
      type: "reconnect_started",
      survivingRole,
      deadlineMs,
    });
    return { deadlineMs, survivingRole };
  }

  /**
   * Cancel an armed reconnect timer. Idempotent. The caller is responsible
   * for driving the state machine through `reconnect_ok` / `reconnect_failed`
   * separately (this method only clears the timer + map entry).
   */
  cancelReconnectTimer(sessionGroupId: string, _reason: string): void {
    const ctx = this.reconnectContexts.get(sessionGroupId);
    if (!ctx) return;
    if (ctx.timer) clearTimeout(ctx.timer);
    this.reconnectContexts.delete(sessionGroupId);
  }

  /** Read access for handlers that need to validate an incoming
   *  `session:cli-id-received` against the disconnect snapshot. */
  getReconnectContext(sessionGroupId: string): ReconnectContext | undefined {
    return this.reconnectContexts.get(sessionGroupId);
  }

  /**
   * Register a group whose halves are already alive — used by the
   * orchestrator's `reconcileCouncilGroups()` on server restart to
   * re-populate the coordinator's `groups` map for pairs that came back
   * via `--resume` rather than via `createGroup`. Idempotent: a second
   * call with the same id is a no-op so reconcile re-entry is safe.
   */
  registerExternalGroup(record: GroupRecord): void {
    if (this.groups.has(record.sessionGroupId)) return;
    this.groups.set(record.sessionGroupId, record);
  }

  /** Cancel all reconnect timers — called from gracefulShutdown so no
   *  timer fires mid-archive (PLAN Task 11). */
  cancelAllReconnectTimers(): void {
    for (const [groupId] of this.reconnectContexts) {
      this.cancelReconnectTimer(groupId, "shutdown");
    }
  }

  /** Enumerate live group ids — used by gracefulShutdown to call
   *  `shutdownAllGroups` (PLAN Task 11). Snapshot at call time. */
  listGroupIds(): string[] {
    return Array.from(this.groups.keys());
  }

  /**
   * Snapshot of all GroupRecords currently tracked by this coordinator.
   * Each call returns a fresh array so the caller can iterate without
   * observing later mutations. Used by REST bootstrap
   * ({@link SessionOrchestrator.getAllGroupsForBootstrap}) so a browser
   * connecting / reloading AFTER the `group:created` event was emitted can
   * still discover live pairs and render the Sidebar glyph + ObserverPanel
   * pair context.
   *
   * Returns `archived` groups too — the caller decides whether to filter
   * them out. The coordinator is the lifecycle authority; consumers express
   * their own visibility policy.
   */
  listAll(): GroupRecord[] {
    return Array.from(this.groups.values());
  }

  /**
   * Tear down the pair. Both halves are marked archived in the state
   * machine BEFORE either kill call runs, so an exit event from the
   * first kill cannot trigger a respawn racing the second kill.
   *
   * Idempotent at the state level — re-archiving an already-archived
   * group is a no-op AND does not fire further kill calls (Subprocess P2-1).
   *
   * PLAN Task 1: routes through `applyEvent` so the `group:exited` bus
   * event + EC-9 log come from the same side-effect channel as every
   * other lifecycle transition (AP-2). Cancel any in-flight reconnect
   * timer first — a user-driven archive bypasses the reconnect path
   * entirely (Hunt: `intentionalKills` as absorbing state).
   */
  async archiveGroup(sessionGroupId: string): Promise<boolean> {
    const g = this.groups.get(sessionGroupId);
    if (!g) return false;
    if (g.status === "archived") return true;
    this.cancelReconnectTimer(sessionGroupId, "user_archived");
    // Drive the state machine through applyEvent; `deriveSideEffects`
    // produces the `group:exited` bus event + log entry. Emit BEFORE
    // kills so the browser cleans its store while the kills proceed.
    this.applyEvent(sessionGroupId, { type: "user_archived" });
    // Best-effort sequential kill — both must be attempted even if one fails.
    // Failures are reported through onError, never swallowed silently.
    try {
      await this.deps.kill(g.primary.sessionId);
    } catch (err) {
      this.onError({
        op: "archive_kill",
        sessionGroupId,
        sessionId: g.primary.sessionId,
        error: err,
      });
    }
    try {
      await this.deps.kill(g.observer.sessionId);
    } catch (err) {
      this.onError({
        op: "archive_kill",
        sessionGroupId,
        sessionId: g.observer.sessionId,
        error: err,
      });
    }
    return true;
  }

  get(sessionGroupId: string): GroupRecord | undefined {
    return this.groups.get(sessionGroupId);
  }

  /** Locate the group that contains the given session id, if any. O(n) — fine
   *  at current scale; a reverse index can be added if measurement demands it. */
  findBySessionId(sessionId: string): GroupRecord | undefined {
    for (const g of this.groups.values()) {
      if (g.primary.sessionId === sessionId || g.observer.sessionId === sessionId) {
        return g;
      }
    }
    return undefined;
  }

  /** Test-only teardown helper. */
  clear(): void {
    this.groups.clear();
  }
}

// Re-export the canonical pattern for callers that want to validate ids
// without depending on group-authorization.ts. Single source of truth.
export { GROUP_ID_PATTERN };
