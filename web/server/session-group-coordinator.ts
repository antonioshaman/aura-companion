import { randomBytes } from "node:crypto";
import { isSupportedPairing } from "./backend-provider.js";
import { type GroupEvent, type GroupStatus, transition } from "./group-state-machine.js";
import type { BackendType, SessionGroupRole } from "./session-types.js";

/**
 * Cryptographically random group ID. ≥128 bits of entropy from
 * `randomBytes(16)` so IDs cannot be guessed by enumeration — the
 * authorisation check (Task 7) still verifies host-token ownership,
 * but unguessable IDs raise the cost of any cross-group attack.
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
}

/**
 * Owns the lifecycle of Council Mode session pairs. Composes the existing
 * SessionOrchestrator via injected `spawn`/`kill` rather than branching
 * inside it (Fowler P6 — boundaries earn their existence).
 *
 * Scope deliberately narrow: spawn-with-rollback, group state-machine
 * application, archive. The watcher and event-bus wiring are owned by
 * later tasks; this class is purely the coordination boundary.
 */
export class SessionGroupCoordinator {
  private groups = new Map<string, GroupRecord>();

  constructor(private deps: SessionGroupCoordinatorDeps) {}

  /**
   * Spawn both halves of a Council Mode pair sharing one sessionGroupId
   * and one workspace. **Atomic**: if the second spawn fails after the
   * first is live, the first is killed before the error propagates so
   * no orphan subprocess survives outside the UI's awareness.
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
        } catch {
          // Rollback failure is best-effort — the original error is what
          // the caller cares about; swallowing here preserves it.
        }
      }
      throw err;
    }
  }

  /** Apply a state-machine event to a group. Returns the resulting status,
   *  or null if the group is unknown. */
  applyEvent(sessionGroupId: string, event: GroupEvent): GroupStatus | null {
    const g = this.groups.get(sessionGroupId);
    if (!g) return null;
    g.status = transition(g.status, event);
    return g.status;
  }

  /**
   * Tear down the pair atomically. Both halves are marked intentional-kill
   * by transitioning to `archived` BEFORE either kill call runs, so an
   * exit event from the first kill cannot trigger a respawn racing the
   * second kill.
   */
  async archiveGroup(sessionGroupId: string): Promise<boolean> {
    const g = this.groups.get(sessionGroupId);
    if (!g) return false;
    g.status = transition(g.status, { type: "user_archived" });
    // Best-effort sequential kill — both must be attempted even if one fails.
    try {
      await this.deps.kill(g.primary.sessionId);
    } catch {
      /* swallow */
    }
    try {
      await this.deps.kill(g.observer.sessionId);
    } catch {
      /* swallow */
    }
    return true;
  }

  get(sessionGroupId: string): GroupRecord | undefined {
    return this.groups.get(sessionGroupId);
  }

  /** Locate the group that contains the given session id, if any. */
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
