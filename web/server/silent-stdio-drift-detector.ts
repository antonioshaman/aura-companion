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
import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { join } from "node:path";

/** Per-session state maintained across ticks. */
export interface DriftDetectorSessionState {
  readonly sessionId: string;
  /**
   * Wall-clock ms at the last CLI frame this bun instance received from
   * the CLI's stdout. **Not** the transcript file mtime — bun writes to
   * the transcript on many non-CLI events (browser subscribe/disconnect,
   * session state field mutations, protocol-recording flushes), which
   * masked real stdio-pipe-death in the 2026-09-19/20 aura-companion
   * incident: transcript mtime stayed fresh via browser polling even
   * while zero CLI frames were landing on bun's stdio. Read directly
   * from the adapter's in-memory `getLastCliFrameReceivedMs()`.
   * A value of 0 signals "adapter has never received a frame yet" —
   * detector skips such sessions to avoid false positives during boot.
   */
  readonly bunLastFrameMs: number;
  /**
   * Claude CLI's own jsonl file path
   * (`~/.claude/projects/<proj-slug>/<cliSessionId>.jsonl`).
   * Nullable — the caller may not know the cliSessionId yet on a
   * fresh session; the detector skips such sessions until the caller
   * refreshes state with a resolved path.
   */
  readonly jsonlPath: string | null;
  /**
   * The CLI's per-session sibling directory
   * (`~/.claude/projects/<proj-slug>/<cliSessionId>/`) that holds the
   * `subagents/` and `tool-results/` subtrees. On current Claude CLIs a Task
   * fan-out writes its subagent output HERE, not into the flat main jsonl —
   * so fresh mtimes under this dir prove the CLI is alive and productively
   * working even while the main stdout stream is quiet (a long council /
   * multi-subagent turn). Nullable like {@link jsonlPath}; the detector skips
   * the liveness check when it is absent.
   */
  readonly sessionDir?: string | null;
}

/**
 * A drift verdict. `drifted=false` also carries the numbers so the
 * caller can log them at debug level for observability.
 */
export interface DriftVerdict {
  readonly sessionId: string;
  readonly drifted: boolean;
  /**
   * ms by which jsonl mtime is ahead of bun's last-frame-received timestamp
   * (negative if bun received something newer than the jsonl mtime).
   */
  readonly mtimeDeltaMs: number;
  /**
   * bun's last-frame-received timestamp (echoed from input for observability).
   * Zero if the adapter has not attached a transport yet.
   */
  readonly bunLastFrameMs: number;
  /** jsonl mtime in ms (0 if missing). */
  readonly jsonlMtimeMs: number;
  /**
   * `assistant` records in the jsonl newer than `bunLastFrameMs` and at
   * least {@link UNDELIVERED_OUTPUT_MIN_AGE_MS} old — model output the CLI
   * produced that never reached bun. `null` when the evidence check did not
   * run (no `undeliveredOutput` dep, or lag under tolerance).
   */
  readonly undeliveredAssistantRecords: number | null;
  /**
   * Set when the lag crossed the tolerance but the kill was withheld:
   * - `no_undelivered_output` = the jsonl grew (queued prompt, attachment,
   *   pr-link…) but holds no model output bun missed, so there is no evidence
   *   the stdout channel is dead — typically an idle session that just got
   *   input, whose last frame is the previous turn's result.
   * - `live_subagent_activity` = there IS undelivered main-stream output, but
   *   the CLI's `subagents/`/`tool-results/` tree has fresh writes since bun's
   *   last frame, proving the process is alive mid Task fan-out (a council /
   *   long multi-subagent turn). Killing here destroys in-flight subagents; the
   *   quiet stdout is expected, not a dead pipe.
   */
  readonly suppressedReason: "no_undelivered_output" | "live_subagent_activity" | null;
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
  /**
   * Evidence check run once the lag crosses the tolerance: returns how many
   * `assistant` records in the jsonl have `sinceMs < timestamp <= untilMs`.
   * When given, drift requires at least one.
   */
  readonly undeliveredOutput?: (jsonlPath: string, sinceMs: number, untilMs: number) => number;
  /**
   * Liveness check run only after the undelivered-output evidence is positive:
   * returns true if any file under `<sessionDir>/subagents/` or
   * `<sessionDir>/tool-results/` has an mtime newer than `sinceMs` (bun's last
   * frame). Fresh activity means the CLI is alive mid Task fan-out, so the
   * quiet stdout is expected and the kill is withheld. When given, a positive
   * result suppresses the kill as `live_subagent_activity`.
   */
  readonly subagentActivitySince?: (sessionDir: string, sinceMs: number) => boolean;
}

/**
 * Minimum age of an undelivered `assistant` record before it counts as
 * evidence. A healthy CLI writes the record and emits the frame at the same
 * moment; the age keeps a tick that lands between the two from killing.
 */
export const UNDELIVERED_OUTPUT_MIN_AGE_MS = 10_000;

/**
 * Count `assistant` records with `sinceMs < timestamp <= untilMs` in a chunk
 * of Claude CLI jsonl. Lines that do not parse (the chunk may start
 * mid-record) are skipped.
 */
export function countAssistantRecordsBetween(jsonlChunk: string, sinceMs: number, untilMs: number): number {
  let count = 0;
  for (const line of jsonlChunk.split("\n")) {
    if (!line.includes('"assistant"')) continue;
    let rec: { type?: unknown; timestamp?: unknown; isSidechain?: unknown; parentToolUseID?: unknown };
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (rec.type !== "assistant" || typeof rec.timestamp !== "string") continue;
    // Belt-and-braces: never count subagent (Task-tool) output as "undelivered
    // main-stream output". On current CLIs these live in the sibling
    // `<cliSid>/subagents/` tree (not this flat jsonl), but an older/mixed
    // layout interleaves them here flagged `isSidechain:true` /
    // `parentToolUseID:<id>`. The history renderer already excludes them
    // (claude-session-history.ts). A missing/false field means main-chain → counted.
    if (rec.isSidechain === true) continue;
    if (typeof rec.parentToolUseID === "string") continue;
    const t = Date.parse(rec.timestamp);
    if (Number.isFinite(t) && t > sinceMs && t <= untilMs) count++;
  }
  return count;
}

/** Tail window read by {@link countUndeliveredAssistantRecords}. */
export const UNDELIVERED_OUTPUT_TAIL_BYTES = 1024 * 1024;

/**
 * Default evidence check: reads the last {@link UNDELIVERED_OUTPUT_TAIL_BYTES}
 * of the jsonl and counts `assistant` records in `(sinceMs, untilMs]`.
 * Runs only when the lag already crossed the tolerance, so the read is rare.
 * Returns 0 on any read error (no evidence → no kill).
 */
export function countUndeliveredAssistantRecords(jsonlPath: string, sinceMs: number, untilMs: number): number {
  let fd: number | null = null;
  try {
    fd = openSync(jsonlPath, "r");
    const size = statSync(jsonlPath).size;
    const len = Math.min(size, UNDELIVERED_OUTPUT_TAIL_BYTES);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    return countAssistantRecordsBetween(buf.toString("utf-8"), sinceMs, untilMs);
  } catch {
    return 0;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/** Default lag tolerance — 90s (see rationale on the field). */
export const DEFAULT_LAG_TOLERANCE_MS = 90_000;
/** Default jsonl-idle threshold — 120s. */
export const DEFAULT_JSONL_IDLE_THRESHOLD_MS = 120_000;

/**
 * Lag tolerance when the caller supplies the undelivered-output evidence
 * check. The 90 s default was sized for a timing-only detector; with the
 * evidence gate (an `assistant` record bun never received, at least
 * {@link UNDELIVERED_OUTPUT_MIN_AGE_MS} old) a short lag is enough to look.
 *
 * Prod 2026-10-09 (Rapesha_shop_bot): bun's last frame 18:14:43, prompt
 * 18:14:52, the CLI wrote its whole 24 s answer to the jsonl by 18:15:16 and
 * emitted nothing on stdout. Lag 33 s < 90 s, so the detector never fired;
 * the user waited 12 min and had to ask again. Other stalls were caught only
 * after 111–138 s.
 */
export const EVIDENCE_LAG_TOLERANCE_MS = UNDELIVERED_OUTPUT_MIN_AGE_MS;

/**
 * jsonl-idle window when the evidence check is supplied. A short answer that
 * stalls stops writing the jsonl at once; the 120 s idle cutoff then hid it
 * for good (same 2026-10-09 case: from 18:17:16 on every tick returned
 * "idle"). Undelivered model output is evidence however old the write is;
 * the window only bounds how long a quiet session keeps being checked.
 */
export const EVIDENCE_JSONL_IDLE_WINDOW_MS = 30 * 60_000;

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

/** Subdirectories under a session dir that a live Task fan-out writes to. */
const SUBAGENT_ACTIVITY_SUBDIRS = ["subagents", "tool-results"] as const;

/**
 * Default liveness check: true if any file directly under
 * `<sessionDir>/subagents/` or `<sessionDir>/tool-results/` has an mtime newer
 * than `sinceMs`. Runs only after the undelivered-output evidence is already
 * positive (rare), so the per-file stat loop is off the hot path. Returns false
 * on any read error — absence of evidence must not suppress a genuine kill.
 */
export function defaultSubagentActivitySince(sessionDir: string, sinceMs: number): boolean {
  for (const sub of SUBAGENT_ACTIVITY_SUBDIRS) {
    const dir = join(sessionDir, sub);
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue; // subdir absent (no fan-out of this kind) — not an error
    }
    for (const name of entries) {
      try {
        if (statSync(join(dir, name)).mtimeMs > sinceMs) return true;
      } catch {
        // entry vanished between readdir and stat — ignore
      }
    }
  }
  return false;
}

/**
 * Evaluate one session for drift. Pure function of the inputs — no side
 * effects. Returns a verdict the caller can log + optionally act on.
 *
 * Drift conditions (ALL must be met):
 *   1. jsonl exists AND was modified recently (within
 *      `jsonlIdleThresholdMs`; 120 s, or 30 min with the evidence
 *      check). An idle jsonl is not evidence of anything.
 *   2. bun's `bunLastFrameMs` is non-zero — a session that has not
 *      yet received its first CLI frame is booting, not drifting.
 *   3. jsonl's mtime is more than `lagToleranceMs` newer than
 *      `bunLastFrameMs` (90 s, or 10 s with the evidence check).
 *   4. with `deps.undeliveredOutput`: the jsonl holds at least one
 *      `assistant` record newer than `bunLastFrameMs` and at least
 *      {@link UNDELIVERED_OUTPUT_MIN_AGE_MS} old.
 *
 * Conditions 3+4 are the tell: CLI is writing model output to its own
 * jsonl, bun has NOT received a frame in a while. That is the
 * two-writer-path divergence pattern, in the act.
 *
 * `bunLastFrameMs` replaced the previous transcript-file-mtime signal
 * on 2026-09-20 (aura-companion prod incident): the transcript is
 * touched by many non-CLI events (browser subscribe/disconnect, state
 * mutations, recording flushes), which kept transcript mtime fresh
 * while zero CLI frames were arriving. The detector never fired on
 * real stdio-pipe-death for that reason. See
 * `feedback_aura_transcript_mtime_not_a_bun_freshness_signal.md`.
 */
export function checkDrift(
  state: DriftDetectorSessionState,
  deps: DriftDetectorDeps = {},
): DriftVerdict {
  const statFile = deps.statFile ?? defaultStatFile;
  const now = (deps.now ?? Date.now)();
  // With the undelivered-output evidence check the timing heuristics no
  // longer have to carry the decision alone, so they shrink to the evidence
  // windows (see EVIDENCE_LAG_TOLERANCE_MS / EVIDENCE_JSONL_IDLE_WINDOW_MS).
  const hasEvidenceCheck = deps.undeliveredOutput !== undefined;
  const lagTolerance =
    deps.lagToleranceMs ?? (hasEvidenceCheck ? EVIDENCE_LAG_TOLERANCE_MS : DEFAULT_LAG_TOLERANCE_MS);
  const jsonlIdleThreshold =
    deps.jsonlIdleThresholdMs ?? (hasEvidenceCheck ? EVIDENCE_JSONL_IDLE_WINDOW_MS : DEFAULT_JSONL_IDLE_THRESHOLD_MS);

  // No jsonl path known → nothing to compare. Session hasn't produced
  // its cliSessionId yet (fresh spawn pre-init) OR the caller hasn't
  // resolved the path. Skip.
  if (!state.jsonlPath) {
    return {
      sessionId: state.sessionId,
      drifted: false,
      mtimeDeltaMs: 0,
      bunLastFrameMs: state.bunLastFrameMs,
      jsonlMtimeMs: 0,
      undeliveredAssistantRecords: null,
      suppressedReason: null,
      reason: null,
    };
  }

  const jsonlStat = statFile(state.jsonlPath);
  const jsonlMtimeMs = jsonlStat?.mtimeMs ?? 0;

  if (!jsonlStat) {
    // jsonl not present — CLI hasn't written anything yet. Not drift.
    return {
      sessionId: state.sessionId,
      drifted: false,
      mtimeDeltaMs: 0,
      bunLastFrameMs: state.bunLastFrameMs,
      jsonlMtimeMs,
      undeliveredAssistantRecords: null,
      suppressedReason: null,
      reason: null,
    };
  }

  const mtimeDeltaMs = jsonlMtimeMs - state.bunLastFrameMs;
  const jsonlAgeMs = now - jsonlMtimeMs;

  // Condition 1: jsonl must be recent. An idle jsonl (last written
  // more than jsonlIdleThreshold ago) means the CLI is not doing
  // anything right now — no active drift, regardless of the delta.
  if (jsonlAgeMs > jsonlIdleThreshold) {
    return {
      sessionId: state.sessionId,
      drifted: false,
      mtimeDeltaMs,
      bunLastFrameMs: state.bunLastFrameMs,
      jsonlMtimeMs,
      undeliveredAssistantRecords: null,
      suppressedReason: null,
      reason: null,
    };
  }

  // Condition 2: baseline must exist — an adapter that has never seen a
  // CLI frame is booting, not drifting. `bunLastFrameMs === 0` means
  // `attachTransport` has not yet run. Skip cleanly.
  if (state.bunLastFrameMs === 0) {
    return {
      sessionId: state.sessionId,
      drifted: false,
      mtimeDeltaMs,
      bunLastFrameMs: state.bunLastFrameMs,
      jsonlMtimeMs,
      undeliveredAssistantRecords: null,
      suppressedReason: null,
      reason: null,
    };
  }

  // Condition 3: jsonl mtime is more than lag-tolerance newer than
  // bun's last-received-frame timestamp.
  if (mtimeDeltaMs <= lagTolerance) {
    return {
      sessionId: state.sessionId,
      drifted: false,
      mtimeDeltaMs,
      bunLastFrameMs: state.bunLastFrameMs,
      jsonlMtimeMs,
      undeliveredAssistantRecords: null,
      suppressedReason: null,
      reason: null,
    };
  }

  // Condition 4 (only with an `undeliveredOutput` dep): the jsonl must hold
  // model output bun never received. Condition 3 alone fires on any idle
  // session the moment it gets input: bun's last frame is the previous
  // turn's result (minutes or hours old) and the CLI writes the queued
  // prompt to jsonl within ms. P7/FIX-DRIFT-FALSE-KILLS (prod 2026-09-28 →
  // 10-02): 17/69 kills were that shape, 2–14 s into a fresh turn with no
  // model output yet; the other 52 had `assistant` records bun never got.
  const undelivered = deps.undeliveredOutput
    ? deps.undeliveredOutput(state.jsonlPath, state.bunLastFrameMs, now - UNDELIVERED_OUTPUT_MIN_AGE_MS)
    : null;
  if (undelivered === 0) {
    return {
      sessionId: state.sessionId,
      drifted: false,
      mtimeDeltaMs,
      bunLastFrameMs: state.bunLastFrameMs,
      jsonlMtimeMs,
      undeliveredAssistantRecords: 0,
      suppressedReason: "no_undelivered_output",
      reason: null,
    };
  }

  // Liveness gate (only with a `subagentActivitySince` dep): there IS
  // undelivered main-stream output, but if the CLI's subagent/tool-results
  // tree has fresh writes since bun's last frame the process is provably alive
  // mid Task fan-out (a council / long multi-subagent turn). The quiet stdout
  // is expected, not a dead pipe — killing here destroys in-flight subagents.
  // Withhold; a genuine stdout death leaves the tree idle and still fires.
  if (
    state.sessionDir &&
    deps.subagentActivitySince?.(state.sessionDir, state.bunLastFrameMs)
  ) {
    return {
      sessionId: state.sessionId,
      drifted: false,
      mtimeDeltaMs,
      bunLastFrameMs: state.bunLastFrameMs,
      jsonlMtimeMs,
      undeliveredAssistantRecords: undelivered,
      suppressedReason: "live_subagent_activity",
      reason: null,
    };
  }

  return {
    sessionId: state.sessionId,
    drifted: true,
    mtimeDeltaMs,
    bunLastFrameMs: state.bunLastFrameMs,
    jsonlMtimeMs,
    undeliveredAssistantRecords: undelivered,
    suppressedReason: null,
    reason:
      `jsonl mtime ${Math.round(mtimeDeltaMs / 1000)}s newer than bun's last frame (age ${Math.round(jsonlAgeMs / 1000)}s) while jsonl actively writing` +
      (undelivered === null ? "" : `; ${undelivered} undelivered assistant record(s)`),
  };
}

/**
 * Compute the Claude CLI jsonl path from `(cwd, cliSessionId)`.
 * Mirrors the CLI's own path derivation:
 * `~/.claude/projects/<slug>/<cliSessionId>.jsonl` where
 * `<slug>` is the absolute cwd with **both `/` AND `_` replaced by `-`**,
 * prefixed with a `-`.
 *
 * Example:
 *   cwd = `/root/aura-companion/web`
 *   → slug = `-root-aura-companion-web`
 *   → path = `<claudeHome>/projects/-root-aura-companion-web/<cliSid>.jsonl`
 *
 *   cwd = `/root/Rapesha_shop_bot`      (underscore in dir name)
 *   → slug = `-root-Rapesha-shop-bot`   (dashes only)
 *
 * The underscore→dash conversion was verified live 2026-09-20 on aura-companion
 * prod: sessions whose cwd contained `_` had their drift detector go silent
 * because this helper computed `<slug with underscore>` while the CLI itself
 * writes to `<slug with dash>`. The `stat()` on the wrong path returned null
 * every tick, `checkDrift` short-circuited on "jsonl not present", and the
 * session sat in stdio-pipe-death indefinitely. See
 * `feedback_aura_resolvejsonlpath_underscore_slug_mismatch.md` in memory.
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
  // Mirror the CLI's slug conversion: `/` AND `_` both collapse to `-`.
  // A future refactor that spots more character classes CLI converts
  // (e.g. `.`, spaces) should update this regex in lockstep with a real
  // filesystem test against `~/.claude/projects/` on a live install.
  const slug = cwd.replace(/[/_]/g, "-");
  return `${claudeHome}/projects/${slug}/${cliSessionId}.jsonl`;
}
