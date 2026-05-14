import { mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync, existsSync, copyFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import type {
  SessionState,
  BrowserIncomingMessage,
  PermissionRequest,
  BufferedBrowserEvent,
} from "./session-types.js";

// ─── Serializable session shape ─────────────────────────────────────────────

/**
 * Current schema version for the persisted-session record.
 *
 * PLAN Task 12 slice (i) — load-side discriminator that lets a
 * future-version server reject older JSON shapes loudly rather than
 * silently parsing with wrong defaults. Bump when adding/renaming any
 * field on `PersistedSession` or nested `SessionState`. Migrations chain
 * in `migratePersistedSession`.
 *
 * Versions:
 *  - v0 (implicit) — pre-Task-12 records on disk WITHOUT the field.
 *                    Loader treats `undefined` as v0 → no-op migrate to v1.
 *  - v1            — first explicit version. Same shape as v0; adds the
 *                    field. Future v2 means a real shape change.
 */
export const CURRENT_SESSION_SCHEMA_VERSION = 1 as const;

export interface PersistedSession {
  /** PLAN Task 12 (i) — explicit schema version. Optional because legacy
   *  on-disk records lack it; `migratePersistedSession` fills it in. */
  schemaVersion?: number;
  id: string;
  state: SessionState;
  messageHistory: BrowserIncomingMessage[];
  pendingMessages: string[];
  pendingPermissions: [string, PermissionRequest][];
  eventBuffer?: BufferedBrowserEvent[];
  nextEventSeq?: number;
  lastAckSeq?: number;
  processedClientMessageIds?: string[];
  archived?: boolean;
}

/**
 * Apply load-time schema migration to a parsed persisted session.
 *
 * Returns `null` when the on-disk version is from a newer server — caller
 * treats null as "skip this record". Pure, idempotent.
 */
export function migratePersistedSession(
  raw: PersistedSession,
  logger: { warn: (msg: string) => void } = { warn: (msg) => console.warn(msg) },
): PersistedSession | null {
  const version = raw.schemaVersion;

  if (typeof version === "number" && version > CURRENT_SESSION_SCHEMA_VERSION) {
    logger.warn(
      `[session-store] migrate: session ${raw.id} has schemaVersion=${version} ` +
      `(this server understands up to ${CURRENT_SESSION_SCHEMA_VERSION}). Skipping.`,
    );
    return null;
  }

  // v0 (no field) → v1 (no shape change, just stamp the version).
  if (version === undefined) {
    return { ...raw, schemaVersion: CURRENT_SESSION_SCHEMA_VERSION };
  }
  return raw;
}

// ─── Store ──────────────────────────────────────────────────────────────────

// PLAN Task 12 (iii) — durable storage migration.
//
// Sessions previously persisted to `$TMPDIR/vibe-sessions/` which on most
// Linux distros is `/tmp` and gets wiped on reboot
// (`quality-persistence.md` Principle 9). That breaks the partial-pair
// restart durability contract and makes any cross-day session re-mount
// path silently empty after a host reboot. macOS `$TMPDIR` is
// `/var/folders/...` and persists, so the bug only manifests on Linux —
// easy to miss in dev, real for users.
//
// Canonical session dir moves to `~/.companion/sessions/` (same prefix as
// `~/.companion/envs/` / `~/.companion/recordings/`) with a one-shot
// best-effort copy from the legacy `$TMPDIR/vibe-sessions/` on first
// boot. `migrateLegacyTmpdirSessions` is the entrypoint — pure and
// exported so `index.ts` calls it before `new SessionStore()`, tests
// inject custom paths, and a future rollback can re-run the inverse
// direction without touching the runtime.

/** New canonical sessions directory — survives host reboot. */
export const DEFAULT_SESSION_DIR = join(homedir(), ".companion", "sessions");

/** Legacy sessions directory (pre-Task 12) — wiped on Linux host reboot. */
export const LEGACY_TMPDIR_SESSION_DIR = join(tmpdir(), "vibe-sessions");

const DEFAULT_DIR = DEFAULT_SESSION_DIR;

export interface MigrationOutcome {
  /** Whether any work was attempted (source existed AND target was empty / absent). */
  ran: boolean;
  /** Source path inspected. */
  source: string;
  /** Target path written. */
  target: string;
  /** Number of session JSONs successfully copied. */
  copied: number;
  /** Number of source files that existed but could not be copied. */
  failed: number;
  /** Whether the launcher.json sidecar (CLI PID map) was carried across. */
  launcherCopied: boolean;
  /** Reason migration was skipped (only set when `ran` is false). */
  skippedReason?: "no_source" | "target_already_populated";
}

/**
 * One-shot best-effort migration of session JSONs from the legacy
 * `$TMPDIR/vibe-sessions/` directory to the new `~/.companion/sessions/`
 * canonical location.
 *
 * Migration is **idempotent** and **non-destructive**:
 *   - If `source` does not exist or is empty → no-op
 *     (`skippedReason: "no_source"`).
 *   - If `target` already contains session JSONs → no-op
 *     (`skippedReason: "target_already_populated"`). The new dir is
 *     authoritative once it has content; re-running migration must not
 *     overwrite live state with stale tmpdir copies.
 *   - Otherwise → copy every `*.json` and the optional `launcher.json`
 *     sidecar. **Source files are NOT deleted** so a rollback to the
 *     pre-Task-12 binary still loads the original data.
 *
 * Per-file failures are tolerated (counted in `failed`) — a partial copy
 * is strictly better than a hard abort, and the operator log captures
 * the gap.
 */
export function migrateLegacyTmpdirSessions(
  source: string = LEGACY_TMPDIR_SESSION_DIR,
  target: string = DEFAULT_SESSION_DIR,
  logger: { warn: (msg: string) => void; info: (msg: string) => void } = {
    warn: (msg) => console.warn(msg),
    info: (msg) => console.log(msg),
  },
): MigrationOutcome {
  const outcome: MigrationOutcome = {
    ran: false,
    source,
    target,
    copied: 0,
    failed: 0,
    launcherCopied: false,
  };

  if (!existsSync(source)) {
    outcome.skippedReason = "no_source";
    return outcome;
  }

  let sourceFiles: string[] = [];
  try {
    sourceFiles = readdirSync(source).filter((f) => f.endsWith(".json"));
  } catch (err) {
    logger.warn(
      `[session-store] migrate: readdir failed for ${source}: ${err instanceof Error ? err.message : String(err)}`,
    );
    outcome.skippedReason = "no_source";
    return outcome;
  }

  if (sourceFiles.length === 0) {
    outcome.skippedReason = "no_source";
    return outcome;
  }

  // Target-populated check — count `.json` files (except a stray
  // launcher.json alone — that's a CLI PID map, not a session). If real
  // session JSONs exist in target, migration must skip to avoid
  // clobbering live state.
  if (existsSync(target)) {
    try {
      const targetFiles = readdirSync(target).filter(
        (f) => f.endsWith(".json") && f !== "launcher.json",
      );
      if (targetFiles.length > 0) {
        outcome.skippedReason = "target_already_populated";
        return outcome;
      }
    } catch {
      // If target exists but unreadable, fall through and let per-file
      // copy errors surface a clearer message.
    }
  }

  mkdirSync(target, { recursive: true });
  outcome.ran = true;

  for (const file of sourceFiles) {
    const srcPath = join(source, file);
    const dstPath = join(target, file);
    try {
      // Skip non-file entries defensively (symlinks to dirs, etc.).
      const stat = statSync(srcPath);
      if (!stat.isFile()) continue;
      copyFileSync(srcPath, dstPath);
      if (file === "launcher.json") {
        outcome.launcherCopied = true;
      } else {
        outcome.copied += 1;
      }
    } catch (err) {
      outcome.failed += 1;
      logger.warn(
        `[session-store] migrate: failed to copy ${srcPath} → ${dstPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  logger.info(
    `[session-store] migrate: copied ${outcome.copied} session(s)` +
    (outcome.launcherCopied ? " + launcher.json" : "") +
    (outcome.failed > 0 ? `, ${outcome.failed} failed` : "") +
    ` from ${source} → ${target} (source preserved for rollback)`,
  );

  return outcome;
}

export class SessionStore {
  private dir: string;
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(dir?: string) {
    this.dir = dir || DEFAULT_DIR;
    mkdirSync(this.dir, { recursive: true });
  }

  private filePath(sessionId: string): string {
    return join(this.dir, `${sessionId}.json`);
  }

  /** Debounced write — batches rapid changes (e.g. multiple stream events). */
  save(session: PersistedSession): void {
    const existing = this.debounceTimers.get(session.id);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.debounceTimers.delete(session.id);
      this.saveSync(session);
    }, 150);
    this.debounceTimers.set(session.id, timer);
  }

  /** Immediate write — use for critical state changes. */
  saveSync(session: PersistedSession): void {
    try {
      // PLAN Task 12 (i) — always stamp the current schema version on writes
      // so load-side discriminator is uniform across all on-disk records.
      const stamped: PersistedSession = {
        ...session,
        schemaVersion: CURRENT_SESSION_SCHEMA_VERSION,
      };
      writeFileSync(this.filePath(session.id), JSON.stringify(stamped), "utf-8");
    } catch (err) {
      console.error(`[session-store] Failed to save session ${session.id}:`, err);
    }
  }

  /** Load a single session from disk. */
  load(sessionId: string): PersistedSession | null {
    try {
      const raw = readFileSync(this.filePath(sessionId), "utf-8");
      const parsed = JSON.parse(raw) as PersistedSession;
      return migratePersistedSession(parsed);
    } catch {
      return null;
    }
  }

  /** Load all sessions from disk. */
  loadAll(): PersistedSession[] {
    const sessions: PersistedSession[] = [];
    try {
      const files = readdirSync(this.dir).filter((f) => f.endsWith(".json") && f !== "launcher.json");
      for (const file of files) {
        try {
          const raw = readFileSync(join(this.dir, file), "utf-8");
          const parsed = JSON.parse(raw) as PersistedSession;
          const migrated = migratePersistedSession(parsed);
          if (migrated) sessions.push(migrated);
        } catch {
          // Skip corrupt files
        }
      }
    } catch {
      // Dir doesn't exist yet
    }
    return sessions;
  }

  /** Set the archived flag on a persisted session. */
  setArchived(sessionId: string, archived: boolean): boolean {
    const session = this.load(sessionId);
    if (!session) return false;
    session.archived = archived;
    this.saveSync(session);
    return true;
  }

  /** Remove a session file from disk. */
  remove(sessionId: string): void {
    const timer = this.debounceTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.debounceTimers.delete(sessionId);
    }
    try {
      unlinkSync(this.filePath(sessionId));
    } catch {
      // File may not exist
    }
  }

  /** Persist launcher state (separate file). */
  saveLauncher(data: unknown): void {
    try {
      writeFileSync(join(this.dir, "launcher.json"), JSON.stringify(data), "utf-8");
    } catch (err) {
      console.error("[session-store] Failed to save launcher state:", err);
    }
  }

  /** Load launcher state. */
  loadLauncher<T>(): T | null {
    try {
      const raw = readFileSync(join(this.dir, "launcher.json"), "utf-8");
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  /** Cancel all pending debounce timers (for clean test teardown). */
  dispose(): void {
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
  }

  /**
   * PLAN Task 10: flush every pending debounced `save()` to disk
   * synchronously. Required at shutdown — without this, a status flip
   * (or any other state change) that landed in the 150ms debounce
   * window seconds before SIGTERM is lost on next boot. The current
   * dispose() cancels timers without writing; flushAll() writes the
   * pending payload.
   *
   * `pending` accepts a getter for the latest session snapshot so the
   * caller (WsBridge) can map the queued session-id back to its
   * current in-memory `Session` and pass through `toPersisted`. If the
   * snapshot is missing, the timer is cancelled (the session was
   * removed during shutdown — nothing to flush).
   */
  flushAll(pending: (sessionId: string) => PersistedSession | null): void {
    for (const [sessionId, timer] of this.debounceTimers) {
      clearTimeout(timer);
      const snapshot = pending(sessionId);
      if (snapshot) this.saveSync(snapshot);
    }
    this.debounceTimers.clear();
  }

  get directory(): string {
    return this.dir;
  }
}
