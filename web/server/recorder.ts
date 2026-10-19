import { mkdirSync, readdirSync, appendFileSync, statSync, unlinkSync, realpathSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { BackendType } from "./session-types.js";
import { COMPANION_HOME } from "./paths.js";
import { countFileLines } from "./fs-utils.js";
import {
  REDACTED_PLACEHOLDER,
  REDACTION_POLICY_VERSION,
  mayContainSecret,
  redactSecretsInText,
  redactStructured,
} from "./secret-redaction.js";

const DEFAULT_MAX_LINES = 1_000_000;
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Recording-file header schema version. Bumped when the entry shape
 * gains a discriminant field that replay tooling must branch on.
 *
 * - v1: ts + dir + raw + ch (+ optional event + meta for lifecycle).
 * - v2: adds optional `origin` field on entries to distinguish
 *   server-internal-origin sends (council auto-wake) from
 *   browser-relayed user input. Omitted field defaults to "browser"
 *   for back-compat with historical recordings.
 * - v3: adds `redactionApplied: true` on the header (+ optional
 *   `redactionVersion` since policy v2 — additive, no version bump) — frames that
 *   carried a secret marker (sk-..., Bearer, openai_api_key, ...) are
 *   redacted at write time per Task 11. Inert frames pass through
 *   byte-identical; the flag signals the writer applied the policy
 *   for every entry in the file. Reader/replay tolerates v1+v2 for
 *   forensic access to historical recordings.
 */
export const RECORDING_HEADER_VERSION = 3 as const;

/**
 * Versions readers must accept. Writers always emit
 * {@link RECORDING_HEADER_VERSION}; readers tolerate any version in this
 * set to preserve forensic access to historical recordings across
 * schema bumps. Bump and migrate readers in lockstep when a new schema
 * field becomes load-bearing.
 */
export type RecordingHeaderVersion = 1 | 2 | 3;
export const RECORDING_HEADER_VERSIONS_ACCEPTED: ReadonlySet<RecordingHeaderVersion> = new Set([1, 2, 3]);

export interface RecordingHeader {
  _header: true;
  /** Writer emits {@link RECORDING_HEADER_VERSION}; reader tolerates any
   *  value in {@link RECORDING_HEADER_VERSIONS_ACCEPTED}. */
  version: RecordingHeaderVersion;
  session_id: string;
  backend_type: BackendType;
  started_at: number;
  cwd: string;
  /** Present + true on v3+ headers. Replay tooling can branch on this
   *  to know the writer applied Task 11 redaction policy at write time
   *  (secret-marker frames parsed + sensitive values replaced with
   *  {@link REDACTED_PLACEHOLDER}). Omitted on v1/v2 historical files. */
  redactionApplied?: true;
  /** Redaction policy version the writer applied (see
   *  `REDACTION_POLICY_VERSION` in secret-redaction.ts). Absent on files
   *  written by policy v1, which is known to have leaked npm/Gonka/Telegram
   *  tokens, KEY=value assignments and escape-adjacent sk-/gh tokens — treat
   *  such files as NOT safely redacted. */
  redactionVersion?: number;
}

export type RecordingDirection = "in" | "out";
export type RecordingChannel = "cli" | "browser";

export type RecordingLifecycleEvent =
  | "ws_open"
  | "ws_close"
  | "ws_error"
  | "reconnect_attempt"
  | "reconnect_success";

/**
 * Provenance of a recorded `out` frame.
 *
 * - `"browser"` (default; field omitted for back-compat) — frame
 *   relayed from a browser-originated message via the adapter's
 *   `send()` method.
 * - `"server:council-wake"` — frame synthesised by the server's
 *   Council Mode auto-wake dispatcher (Story 2 AC#1).
 * - `"server:auto-proceed"` — frame synthesised by the orchestrator-side
 *   auto-proceed pipeline (PLAN-aura-orchestrator-idle-auto-proceed
 *   Task 11) on idle-timeout. Distinguishes the auto-proceed synthetic
 *   from the observer-wake synthetic in replay/forensic analysis so
 *   incident triage can tell "idle nudge fired" apart from "observer
 *   was woken".
 *
 * Inbound frames (`dir: "in"`) never carry an origin — provenance is
 * implicit from the CLI subprocess.
 */
export type RecordingOrigin =
  | "browser"
  | "server:council-wake"
  | "server:auto-proceed"
  // Council Review #12 (EC-16) — server-driven `injectUserMessage` paths.
  // Added so the bridge can discriminate provenance on inbound-shaped
  // user_message frames that were synthesised by server code, not typed
  // by a human at a browser tab.
  | "server:cron"
  | "server:agent"
  | "server:rest"
  // Bidirectional pipeline — inter-half coordination frames synthesised by the
  // peer-routing helper. Same userFrameObservers-skip semantic as server: origins.
  | "council:peer";

export interface RecordingEntry {
  ts: number;
  dir: RecordingDirection;
  raw: string;
  ch: RecordingChannel;
  /** Optional connection lifecycle event (for disconnection diagnostics). */
  event?: RecordingLifecycleEvent;
  /** Optional metadata for lifecycle events (e.g. close code, error message). */
  meta?: Record<string, unknown>;
  /** Provenance of `out` frames — omitted for `in` frames and for
   *  legacy "browser" sends to keep on-disk byte size minimal. */
  origin?: RecordingOrigin;
}

export interface RecordingFileMeta {
  filename: string;
  sessionId: string;
  backendType: string;
  startedAt: string;
  /** Number of lines in the file (header + entries). */
  lines: number;
}

// ─── Redaction (Task 11, policy v2) ──────────────────────────────────────────
//
// The rule set lives in `secret-redaction.ts` (shared with the session store
// and the logger). See that module's header for why policy v1 leaked.

export { REDACTED_PLACEHOLDER, REDACTION_POLICY_VERSION };

/**
 * Redact secrets from a raw protocol frame before it lands on disk. Applied
 * to EVERY recorded frame: both directions, both channels (CLI stdout/stdin,
 * Codex JSON-RPC, browser-in `user_message`), plus lifecycle meta.
 *
 * 1. Pre-screen: a frame with no secret-shaped substring and no secret-ish
 *    key word is returned unchanged (byte-identical replay fixtures).
 * 2. Parseable JSON: deep-walk every string value (nested / double-encoded
 *    JSON text included — rules are escape-aware) and every secret-named key,
 *    re-stringify. If nothing was redacted, the ORIGINAL bytes are returned.
 * 3. Non-JSON (multi-line chunks, plain text): apply the text rules directly;
 *    they never touch `"` or `\` so a JSON-ish line stays parseable.
 *
 * Pure + side-effect free; exported for direct unit testing.
 */
export function redactRaw(raw: string): string {
  if (!raw || !mayContainSecret(raw)) return raw;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return redactSecretsInText(raw);
  }
  const redacted = JSON.stringify(redactStructured(parsed));
  return redacted === JSON.stringify(parsed) ? raw : redacted;
}

// ─── SessionRecorder ─────────────────────────────────────────────────────────

/**
 * Writes raw messages for a single session to a JSONL file.
 * First line is a header with session metadata; subsequent lines are entries.
 * Tracks its own line count so the manager can enforce the global limit.
 */
export class SessionRecorder {
  readonly filePath: string;
  private closed = false;
  private _recordWriteErrorLogged = false;
  /** Number of lines written (1 for the header at construction). */
  lineCount = 1;

  constructor(
    sessionId: string,
    backendType: BackendType,
    cwd: string,
    outputDir: string,
  ) {
    const ts = new Date().toISOString().replace(/:/g, "-");
    const suffix = randomBytes(3).toString("hex");
    const filename = `${sessionId}_${backendType}_${ts}_${suffix}.jsonl`;
    this.filePath = join(outputDir, filename);

    const header: RecordingHeader = {
      _header: true,
      version: RECORDING_HEADER_VERSION,
      session_id: sessionId,
      backend_type: backendType,
      started_at: Date.now(),
      cwd,
      redactionApplied: true,
      redactionVersion: REDACTION_POLICY_VERSION,
    };
    // mode 0o600 honoured on file creation only (subsequent appends inherit
    // existing perms). Per Hunt security.md Principle 3: recordings carry
    // raw protocol payloads — restrict to owner-rw to mirror the directory's
    // 0o700 mode set at mkdir.
    appendFileSync(this.filePath, JSON.stringify(header) + "\n", { mode: 0o600 });
  }

  record(
    dir: RecordingDirection,
    raw: string,
    channel: RecordingChannel,
    origin?: RecordingOrigin,
  ): void {
    if (this.closed) return;
    const entry: RecordingEntry = {
      ts: Date.now(),
      dir,
      raw: redactRaw(raw),
      ch: channel,
      ...(origin ? { origin } : {}),
    };
    try {
      appendFileSync(this.filePath, JSON.stringify(entry) + "\n");
      this.lineCount++;
    } catch (err) {
      // Never throw — recording must not disrupt normal operation.
      // But log once so operators can diagnose disk/permission issues.
      if (!this._recordWriteErrorLogged) {
        this._recordWriteErrorLogged = true;
        console.warn(`[recorder] Write failed for ${this.filePath}: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  /** Record a connection lifecycle event (open, close, error, reconnect). */
  recordEvent(
    event: RecordingLifecycleEvent,
    channel: RecordingChannel,
    meta?: Record<string, unknown>,
  ): void {
    if (this.closed) return;
    // Lifecycle meta can carry error.message / close.reason payloads that
    // occasionally echo the request URL with a token query — redact via the
    // same structured walker. raw is intentionally empty for events.
    const redactedMeta = meta ? redactStructured(meta) : undefined;
    const entry: RecordingEntry = {
      ts: Date.now(),
      dir: "in",
      raw: "",
      ch: channel,
      event,
      ...(redactedMeta ? { meta: redactedMeta } : {}),
    };
    try {
      appendFileSync(this.filePath, JSON.stringify(entry) + "\n");
      this.lineCount++;
    } catch (err) {
      if (!this._recordWriteErrorLogged) {
        this._recordWriteErrorLogged = true;
        console.warn(`[recorder] Write failed for ${this.filePath}: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  close(): void {
    this.closed = true;
  }
}

// ─── RecorderManager ─────────────────────────────────────────────────────────

/**
 * Manages recording for all sessions.
 *
 * Always enabled by default. Disable explicitly with COMPANION_RECORD=0.
 *
 * Automatic rotation: when total lines across all recording files exceed
 * maxLines (default 1 000 000, override with COMPANION_RECORDINGS_MAX_LINES),
 * the oldest files are deleted until we're back under the limit.
 */
export class RecorderManager {
  private globalEnabled: boolean;
  private recordingsDir: string;
  private maxLines: number;
  private perSessionEnabled = new Set<string>();
  private perSessionDisabled = new Set<string>();
  private recorders = new Map<string, SessionRecorder>();
  private dirCreated = false;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options?: {
    globalEnabled?: boolean;
    recordingsDir?: string;
    maxLines?: number;
  }) {
    this.globalEnabled = options?.globalEnabled ?? RecorderManager.resolveEnabled();
    this.recordingsDir =
      options?.recordingsDir ??
      process.env.COMPANION_RECORDINGS_DIR ??
      join(COMPANION_HOME, "recordings");
    this.maxLines =
      options?.maxLines ??
      (Number(process.env.COMPANION_RECORDINGS_MAX_LINES) || DEFAULT_MAX_LINES);

    if (this.globalEnabled) {
      // Run cleanup at startup (async, non-blocking) and periodically
      this.cleanup();
      this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
      if (this.cleanupTimer.unref) this.cleanupTimer.unref();
    }
  }

  /**
   * Always on unless explicitly disabled with COMPANION_RECORD=0|false.
   */
  private static resolveEnabled(): boolean {
    const env = process.env.COMPANION_RECORD;
    if (env === "0" || env === "false") return false;
    return true;
  }

  isGloballyEnabled(): boolean {
    return this.globalEnabled;
  }

  getRecordingsDir(): string {
    return this.recordingsDir;
  }

  getMaxLines(): number {
    return this.maxLines;
  }

  isRecording(sessionId: string): boolean {
    if (this.perSessionDisabled.has(sessionId)) return false;
    return this.globalEnabled || this.perSessionEnabled.has(sessionId);
  }

  enableForSession(sessionId: string): void {
    this.perSessionDisabled.delete(sessionId);
    this.perSessionEnabled.add(sessionId);
  }

  disableForSession(sessionId: string): void {
    this.perSessionEnabled.delete(sessionId);
    this.perSessionDisabled.add(sessionId);
    this.stopRecording(sessionId);
  }

  /**
   * Record a raw message. No-op if recording is disabled for this session.
   * Lazily creates the SessionRecorder on first call.
   *
   * `origin` annotates `dir: "out"` frames with their provenance —
   * "browser" for relayed user input (default; field omitted on disk),
   * "server:council-wake" for server-synthesised wake frames from the
   * Council Mode dispatcher. Inbound frames never carry origin; the
   * caller passes `undefined` and the field is dropped.
   */
  record(
    sessionId: string,
    dir: RecordingDirection,
    raw: string,
    channel: RecordingChannel,
    backendType: BackendType,
    cwd: string,
    origin?: RecordingOrigin,
  ): void {
    if (!this.isRecording(sessionId)) return;

    let recorder = this.recorders.get(sessionId);
    if (!recorder) {
      this.ensureDir();
      recorder = new SessionRecorder(sessionId, backendType, cwd, this.recordingsDir);
      this.recorders.set(sessionId, recorder);
    }
    recorder.record(dir, raw, channel, origin);
  }

  /** Record a connection lifecycle event for diagnostics. */
  recordEvent(
    sessionId: string,
    event: RecordingLifecycleEvent,
    channel: RecordingChannel,
    meta?: Record<string, unknown>,
  ): void {
    const recorder = this.recorders.get(sessionId);
    if (recorder) {
      recorder.recordEvent(event, channel, meta);
    }
  }

  stopRecording(sessionId: string): void {
    const recorder = this.recorders.get(sessionId);
    if (recorder) {
      recorder.close();
      this.recorders.delete(sessionId);
    }
  }

  getRecordingStatus(sessionId: string): { filePath?: string } {
    const recorder = this.recorders.get(sessionId);
    return recorder ? { filePath: recorder.filePath } : {};
  }

  /**
   * Absolute paths of every recording file currently being appended to.
   *
   * AURA-LOCAL (PLAN T9 / Persistence R6): the retention sweep consults
   * this set before unlinking or moving any file under the recordings
   * tree. Unlinking an open file on Linux silently loses the recording
   * — the fd stays valid, subsequent appends succeed, but the inode is
   * unreachable on disk after the last writer closes. Skipping
   * currently-open files closes that loss window.
   *
   * Returns a fresh `Set` each call so the caller can mutate it without
   * leaking into our internal map iteration. The set is empty when no
   * sessions are recording (manager disabled OR all per-session
   * overrides flipped off).
   */
  getActiveRecordingPaths(): Set<string> {
    const out = new Set<string>();
    for (const rec of this.recorders.values()) {
      // Canonicalise to match the retention sweeper's resolveCleanupPath
      // output, which realpath's the deepest existing ancestor. A raw path
      // string-mismatches the sweeper's realpath'd entry whenever an ancestor
      // of the recordings dir is a symlink (macOS $TMPDIR→/private/var,
      // containerised bind-mounts), defeating the active-file skip and risking
      // unlink of a live recording — silent data loss. The file is open so
      // realpathSync succeeds; if it raced closed, fall back to the raw path.
      try {
        out.add(realpathSync(rec.filePath));
      } catch {
        out.add(rec.filePath);
      }
    }
    return out;
  }

  listRecordings(): RecordingFileMeta[] {
    try {
      const files = readdirSync(this.recordingsDir);
      return files
        .filter((f) => f.endsWith(".jsonl"))
        .map((filename) => {
          // Format: {sessionId}_{backendType}_{ISO-timestamp}_{suffix}.jsonl
          const withoutExt = filename.replace(/\.jsonl$/, "");
          const firstUnderscore = withoutExt.indexOf("_");
          const secondUnderscore = withoutExt.indexOf("_", firstUnderscore + 1);
          if (firstUnderscore === -1 || secondUnderscore === -1) {
            return { filename, sessionId: "", backendType: "", startedAt: "", lines: 0 };
          }
          // Count lines — fast: just count newlines
          const lines = countFileLines(join(this.recordingsDir, filename));
          return {
            filename,
            sessionId: withoutExt.substring(0, firstUnderscore),
            backendType: withoutExt.substring(firstUnderscore + 1, secondUnderscore),
            startedAt: withoutExt.substring(secondUnderscore + 1),
            lines,
          };
        });
    } catch {
      return [];
    }
  }

  closeAll(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    for (const [, recorder] of this.recorders) {
      recorder.close();
    }
    this.recorders.clear();
  }

  /**
   * Delete oldest recording files until total lines are under maxLines.
   * Skips files that belong to active (currently recording) sessions.
   */
  cleanup(): number {
    try {
      this.ensureDir();
      const files = readdirSync(this.recordingsDir).filter((f) => f.endsWith(".jsonl"));
      if (files.length === 0) return 0;

      // Build list with line counts and mtime, sorted oldest-first
      const activeFiles = new Set<string>();
      for (const rec of this.recorders.values()) {
        activeFiles.add(rec.filePath);
      }

      const entries: { filename: string; path: string; lines: number; mtimeMs: number }[] = [];
      let totalLines = 0;

      for (const filename of files) {
        const fullPath = join(this.recordingsDir, filename);
        const lines = countFileLines(fullPath);
        let mtimeMs = 0;
        try {
          mtimeMs = statSync(fullPath).mtimeMs;
        } catch {
          continue;
        }
        entries.push({ filename, path: fullPath, lines, mtimeMs });
        totalLines += lines;
      }

      if (totalLines <= this.maxLines) return 0;

      // Sort oldest first (lowest mtime = oldest)
      entries.sort((a, b) => a.mtimeMs - b.mtimeMs);

      let deleted = 0;
      for (const entry of entries) {
        if (totalLines <= this.maxLines) break;
        // Don't delete files that are actively being written to
        if (activeFiles.has(entry.path)) continue;
        try {
          unlinkSync(entry.path);
          totalLines -= entry.lines;
          deleted++;
        } catch {
          // File may have been removed concurrently
        }
      }

      if (deleted > 0) {
        console.log(`[recorder] Cleanup: deleted ${deleted} old recording(s), ${totalLines} lines remaining`);
      }
      return deleted;
    } catch {
      return 0;
    }
  }

  private ensureDir(): void {
    if (this.dirCreated) return;
    // mode 0o700 — owner-only. Recordings carry raw protocol payloads
    // (init frames, OAuth tokens before redaction reaches the per-frame
    // writer); the parent directory must not be world- or group-readable.
    mkdirSync(this.recordingsDir, { recursive: true, mode: 0o700 });
    this.dirCreated = true;
  }
}

