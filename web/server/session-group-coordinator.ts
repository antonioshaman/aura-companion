import { randomBytes } from "node:crypto";
import { isSupportedPairing } from "./backend-provider.js";
import { GROUP_ID_PATTERN } from "./group-authorization.js";
import { type GroupEvent, type GroupStatus, transition } from "./group-state-machine.js";
import type { BackendType, SessionGroupRole } from "./session-types.js";
import { companionBus } from "./event-bus.js";

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
}

export interface SessionGroupCoordinatorDeps {
  spawn: SessionSpawner;
  kill: SessionKiller;
  /** Optional sink for kill-failure telemetry. Defaults to a console.warn fallback. */
  onError?: CoordinatorErrorSink;
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
  private readonly onError: CoordinatorErrorSink;

  constructor(private deps: SessionGroupCoordinatorDeps) {
    this.onError =
      deps.onError ??
      ((event) =>
        console.warn(
          `[session-group-coordinator] ${event.op} failed for ${event.sessionId} (group ${event.sessionGroupId}):`,
          event.error,
        ));
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
      });
      const observerSpawn = await this.deps.spawn({
        cwd: req.cwd,
        backendType: req.observer,
        model: req.model,
        permissionMode: req.permissionMode,
        sessionGroupId,
        sessionGroupRole: "observer",
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

  /** Apply a state-machine event to a group. Returns the resulting status,
   *  or null if the group is unknown.
   *
   *  Emits `group:degraded` / `group:exited` on the companion bus when the
   *  transition crosses a meaningful boundary (Realtime council review #3):
   *  the wire variants `group_degraded` / `group_exited` had been declared
   *  + listened-for but never fired.
   */
  applyEvent(sessionGroupId: string, event: GroupEvent): GroupStatus | null {
    const g = this.groups.get(sessionGroupId);
    if (!g) return null;
    const prevStatus = g.status;
    g.status = transition(g.status, event);
    if (prevStatus !== "degraded" && g.status === "degraded") {
      const deadRole = inferDeadRoleFromEvent(event);
      companionBus.emit("group:degraded", { sessionGroupId, deadRole });
    }
    if (prevStatus !== "archived" && g.status === "archived") {
      const reason = inferExitReasonFromEvent(event);
      companionBus.emit("group:exited", { sessionGroupId, reason });
    }
    return g.status;
  }

  /**
   * Tear down the pair. Both halves are marked archived in the state
   * machine BEFORE either kill call runs, so an exit event from the
   * first kill cannot trigger a respawn racing the second kill.
   *
   * Idempotent at the state level — re-archiving an already-archived
   * group is a no-op AND does not fire further kill calls (Subprocess P2-1).
   */
  async archiveGroup(sessionGroupId: string): Promise<boolean> {
    const g = this.groups.get(sessionGroupId);
    if (!g) return false;
    if (g.status === "archived") return true;
    g.status = transition(g.status, { type: "user_archived" });
    // Realtime council review #3: emit `group:exited` so subscribers
    // (orchestrator's bus listener → broadcastToGroup → browser store
    // `removeGroup`) actually see the teardown. Emit BEFORE the kills
    // so the browser cleans up its store while the kills proceed; the
    // server-side coordinator record stays until the kills complete.
    companionBus.emit("group:exited", { sessionGroupId, reason: "user_archived" });
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

/**
 * Pure: infer the dead-role discriminator for `group:degraded` from the
 * state-machine event that drove the transition. The state machine's
 * `half_died` event carries the role explicitly; other transitions into
 * degraded (e.g. `reconnect_failed`) don't name which half — default to
 * "observer" (the more common death mode in practice).
 */
function inferDeadRoleFromEvent(event: GroupEvent): SessionGroupRole {
  if (event.type === "half_died") return event.role;
  return "observer";
}

/**
 * Pure: infer the `group:exited` reason from the state-machine event.
 * Today only `user_archived` and `user_killed` reach archived;
 * shutdown / both_halves_died are upper-layer concepts the orchestrator
 * may emit directly without going through the state machine.
 */
function inferExitReasonFromEvent(event: GroupEvent): "user_archived" | "shutdown" | "both_halves_died" {
  if (event.type === "user_archived") return "user_archived";
  if (event.type === "user_killed") return "user_archived";
  return "user_archived";
}

// Re-export the canonical pattern for callers that want to validate ids
// without depending on group-authorization.ts. Single source of truth.
export { GROUP_ID_PATTERN };
