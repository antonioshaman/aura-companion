/**
 * Silent-stdio drift detector — periodic per-session sanity check that
 * the CLI's own jsonl and bun's transcript stay in step.
 *
 * Why this exists (verified pattern across 2026-09-09→11 incidents on
 * aura-companion prod): the Claude CLI in `--print --output-format
 * stream-json` mode has a class of bug where the stdout stream-json
 * emitter silently stops delivering frames to bun, while the CLI's
 * own persistence (`~/.claude/projects/<slug>/<cliSid>.jsonl`) keeps growing.
 * Tokens burn, jsonl grows, transcript stalls, UI shows nothing.
 *
 * PR #175's silent-stdio-watchdog is armed on `handleOutgoingUserMessage`
 * and fires after `SILENT_STDIO_TIMEOUT_MS` of no stdout activity. That
 * catches the failure mode, but:
 *   - Only after a user message is dispatched.
 *   - After up to 300s (default, tuned in PR #180).
 *
 * This detector adds a SECOND, complementary line of defense:
 *   - Runs on a periodic tick independent of user activity.
 *   - Compares the CLI's jsonl file freshness against the bun-managed
 *     transcript for the same session. If the jsonl is significantly
 *     newer than the transcript, we've detected the two-writer
 *     divergence pattern in the act (see
 *     `feedback_two_writer_path_divergence_canary.md`) — no need to
 *     wait for a user message + full silence timeout to confirm.
 *
 * The detector is a pure module. It does NOT touch the process, kill
 * anything, or send any bus events itself — it only OBSERVES and
 * REPORTS via a callback. Wiring (interval + orchestrator listener +
 * kill decision) lives in `session-orchestrator.ts`.
 */

import type { PathLike } from "node:fs";
import { statSync } from "node:fs";

/** Per-session state maintained across ticks. */
export interface DriftDetectorSessionState {
  readonly sessionId: string;
  /** Bun-managed transcript file path (`~/.companion/sessions/<sid>.json`). */
  readonly transcriptPath: string;
  /**
   * Claude CLI's own jsonl file path
   * (`~/.claude/projects/<proj-slug>/<cliSessionId>.jsonl`).
   * Nullable — the caller may not know the cliSessionId yet on a
   * fresh session; the detector skips such sessions until the caller
   * refreshes state with a resolved path.
   */
  readonly jsonlPath: string | null;
}

/**
 * A drift verdict. `drifted=false` also carries the numbers so the
 * caller can log them at debug level for observability.
 */
export interface DriftVerdict {
  readonly sessionId: string;
  readonly drifted: boolean;
  /** ms by which jsonl mtime is ahead of transcript mtime (negative if transcript newer). */
  readonly mtimeDeltaMs: number;
  /** transcript mtime in ms (0 if missing). */
  readonly transcriptMtimeMs: number;
  /** jsonl mtime in ms (0 if missing). */
  readonly jsonlMtimeMs: number;
  /** Human-readable reason if `drifted=true`. */
  readonly reason: string | null;
}

/** Dependency seam for injectable stat + clock (tests). */
export interface DriftDetectorDeps {
  /** Stat wrapper — mirrors `fs.statSync` semantics, returns null on ENOENT. */
  readonly statFile?: (p: PathLike) => { mtimeMs: number } | null;
  /** Clock for `now`, for deterministic tests. */
  readonly now?: () => number;
  /**
   * How much fresher the jsonl is allowed to be over the transcript
   * before we declare drift. In healthy operation the transcript is
   * written by bun's `wsBridge.persistSession` within ~1s of a stdout
   * frame, so any >90s lag while jsonl is actively growing is
   * suspicious. Configurable so the operator can widen in
   * heavy-tool_use environments.
   */
  readonly lagToleranceMs?: number;
  /**
   * How stale the jsonl must be to skip the check entirely. If nobody
   * is writing to jsonl right now the session is idle and drift is
   * meaningless — a mostly-empty transcript against a long-idle
   * jsonl is legitimate history, not a bug.
   */
  readonly jsonlIdleThresholdMs?: number;
}

/** Default lag tolerance — 90s (see rationale on the field). */
export const DEFAULT_LAG_TOLERANCE_MS = 90_000;
/** Default jsonl-idle threshold — 120s. */
export const DEFAULT_JSONL_IDLE_THRESHOLD_MS = 120_000;

/**
 * Default stat wrapper — returns null on ENOENT so the caller does
 * not have to try/catch every stat.
 */
function defaultStatFile(p: PathLike): { mtimeMs: number } | null {
  try {
    const s = statSync(p);
    return { mtimeMs: s.mtimeMs };
  } catch {
    return null;
  }
}

/**
 * Evaluate one session for drift. Pure function of the inputs — no side
 * effects. Returns a verdict the caller can log + optionally act on.
 *
 * Drift conditions (BOTH must be met):
 *   1. jsonl exists AND was modified recently (within
 *      `jsonlIdleThresholdMs`). An idle jsonl is not evidence of
 *      anything.
 *   2. jsonl's mtime is more than `lagToleranceMs` newer than the
 *      transcript's mtime.
 *
 * The second condition is the tell: CLI is writing new records, bun's
 * transcript writer has NOT run in a while. That is the two-writer-
 * path divergence pattern, in the act.
 */
export function checkDrift(
  state: DriftDetectorSessionState,
  deps: DriftDetectorDeps = {},
): DriftVerdict {
  const statFile = deps.statFile ?? defaultStatFile;
  const now = (deps.now ?? Date.now)();
  const lagTolerance = deps.lagToleranceMs ?? DEFAULT_LAG_TOLERANCE_MS;
  const jsonlIdleThreshold = deps.jsonlIdleThresholdMs ?? DEFAULT_JSONL_IDLE_THRESHOLD_MS;

  // No jsonl path known → nothing to compare. Session hasn't produced
  // its cliSessionId yet (fresh spawn pre-init) OR the caller hasn't
  // resolved the path. Skip.
  if (!state.jsonlPath) {
    return {
      sessionId: state.sessionId,
      drifted: false,
      mtimeDeltaMs: 0,
      transcriptMtimeMs: 0,
      jsonlMtimeMs: 0,
      reason: null,
    };
  }

  const jsonlStat = statFile(state.jsonlPath);
  const transcriptStat = statFile(state.transcriptPath);
  const jsonlMtimeMs = jsonlStat?.mtimeMs ?? 0;
  const transcriptMtimeMs = transcriptStat?.mtimeMs ?? 0;

  if (!jsonlStat) {
    // jsonl not present — CLI hasn't written anything yet. Not drift.
    return {
      sessionId: state.sessionId,
      drifted: false,
      mtimeDeltaMs: 0,
      transcriptMtimeMs,
      jsonlMtimeMs,
      reason: null,
    };
  }

  const mtimeDeltaMs = jsonlMtimeMs - transcriptMtimeMs;
  const jsonlAgeMs = now - jsonlMtimeMs;

  // Condition 1: jsonl must be recent. An idle jsonl (last written
  // more than jsonlIdleThreshold ago) means the CLI is not doing
  // anything right now — no active drift, regardless of the delta.
  if (jsonlAgeMs > jsonlIdleThreshold) {
    return {
      sessionId: state.sessionId,
      drifted: false,
      mtimeDeltaMs,
      transcriptMtimeMs,
      jsonlMtimeMs,
      reason: null,
    };
  }

  // Condition 2: jsonl mtime is more than lag-tolerance newer than
  // transcript. That's the divergence signature.
  if (mtimeDeltaMs > lagTolerance) {
    return {
      sessionId: state.sessionId,
      drifted: true,
      mtimeDeltaMs,
      transcriptMtimeMs,
      jsonlMtimeMs,
      reason: `jsonl mtime ${Math.round(mtimeDeltaMs / 1000)}s newer than transcript while jsonl actively writing (age ${Math.round(jsonlAgeMs / 1000)}s)`,
    };
  }

  return {
    sessionId: state.sessionId,
    drifted: false,
    mtimeDeltaMs,
    transcriptMtimeMs,
    jsonlMtimeMs,
    reason: null,
  };
}

/**
 * Compute the Claude CLI jsonl path from `(cwd, cliSessionId)`.
 * Mirrors the CLI's own path derivation:
 * `~/.claude/projects/<slug>/<cliSessionId>.jsonl` where
 * `<slug>` is the absolute cwd with every `/` replaced by `-`,
 * prefixed with a `-`.
 *
 * Example:
 *   cwd = `/root/aura-companion/web`
 *   → slug = `-root-aura-companion-web`
 *   → path = `<claudeHome>/projects/-root-aura-companion-web/<cliSid>.jsonl`
 *
 * `null` if either input is empty — the caller uses that to skip the
 * check until the session has fully initialised.
 */
export function resolveJsonlPath(
  claudeHome: string,
  cwd: string | undefined | null,
  cliSessionId: string | undefined | null,
): string | null {
  if (!cwd || !cliSessionId) return null;
  const slug = cwd.replace(/\//g, "-");
  return `${claudeHome}/projects/${slug}/${cliSessionId}.jsonl`;
}
