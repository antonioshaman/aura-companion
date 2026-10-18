/**
 * Context-size suggester — advise the user to run `/compact` before a
 * long session hits the silent-stdio failure mode observed 2026-09-09→11.
 *
 * Empirical pattern from the incident window: subprocess stability
 * correlates with jsonl size. Under CLI 2.1.266, sessions with
 * `<slug>/<cliSid>.jsonl` above ~1.5 MB start hitting silent-stdio
 * flares every ~1-2h. Below that threshold the same models on fresh
 * sessions work fine indefinitely. Compacting the session (`/compact`
 * slash command inside the CLI) reduces the working context and
 * meaningfully lowers the recurrence rate.
 *
 * This module is the pure decision-maker: given the current jsonl
 * size for a session and the last "milestone" we already advised on,
 * return the next milestone the caller should surface (or `null` when
 * the session is still below thresholds / already at ceiling). The
 * caller (drift-detector tick in `session-orchestrator.ts`) broadcasts
 * a browser toast on each new milestone.
 *
 * Milestones are additive: crossing 1.5 MB fires once, crossing 3 MB
 * fires once, etc. Sessions never fire the SAME milestone twice —
 * that would spam the browser on every tick.
 */
import type { ContextAdvisoryRecord, ContextAdvisorySignal } from "./session-types.js";

/**
 * Size milestones in bytes. Ordered ascending. Each milestone fires
 * at most once per session lifetime (the caller tracks
 * `lastFiredMilestoneBytes` per session).
 *
 * Rationale:
 *   - 1.5 MB: first-signal advisory. Session is comfortably past what
 *     comfortable compaction can undo, but still recoverable.
 *   - 3 MB: strong-signal — silent-stdio flares recurring roughly
 *     every hour above this size on 2026-09-11 traces.
 *   - 5 MB: urgent — chain-rotation exhaustion incidents (2026-09-10)
 *     tended to originate from sessions at this size or above.
 *   - 10 MB: last-resort — session at this size should be archived,
 *     compaction alone often insufficient.
 */
export const COMPACTION_MILESTONE_BYTES: readonly number[] = [
  1_500_000,
  3_000_000,
  5_000_000,
  10_000_000,
];

/**
 * User-visible copy for each milestone, keyed by the milestone value.
 * Kept next to the numbers so a single edit updates both.
 */
export const MILESTONE_MESSAGE: Record<number, string> = {
  1_500_000: "Session context is large (~1.5 MB). Consider running `/compact` — long sessions become prone to silent-stdio flares.",
  3_000_000: "Session context is now ~3 MB. Strongly recommend `/compact` — silence flares recur ~hourly above this size.",
  5_000_000: "Session context is ~5 MB. Run `/compact`, or continue in a new session with a handoff of the current task — chain-rotation exhaustion originates here.",
  10_000_000: "Session context is >10 MB. Compaction alone may not be enough — continue in a new session with a handoff of the current task.",
};

/**
 * From this milestone up the advisory is STRUCTURED: besides the legacy text
 * it carries `action: "continue_in_new"`, the server records it on the session
 * state (so it survives a reload), and the browser renders a banner with a
 * one-click "Continue in a new session" (handoff + fresh session). Below it
 * the advice is still just "/compact", rendered as a plain system line.
 *
 * Why 5 MB: at 10 MB the session observed 2026-10 had already stopped
 * answering (Interrupted ×10), so the one-click exit must be on offer
 * BEFORE the session is wedged, not after.
 */
export const HANDOFF_MILESTONE_MIN_BYTES = 5_000_000;

/** What the browser should offer for an advisory. */
export type ContextAdvisoryAction = "compact" | "continue_in_new";

/**
 * One advisory ladder: the thresholds, their copy and the tier from which the
 * offer becomes "continue in a new session". The decision functions below
 * take a ladder and a measured number; they never know where the number came
 * from, which is what keeps them pure and lets Claude (bytes on disk) and
 * Codex (percent of the context window) share one decision path.
 */
export interface ContextLadder {
  readonly signal: ContextAdvisorySignal;
  /** Ascending thresholds in the signal's unit. */
  readonly milestones: readonly number[];
  /** User-visible copy per threshold. A threshold without copy never fires. */
  readonly messages: Readonly<Record<number, string>>;
  /** From this threshold up the action is `continue_in_new`; below it `compact`. */
  readonly handoffMin: number;
}

/** Claude: transcript bytes on disk (the ladder #381 shipped with). */
export const TRANSCRIPT_BYTES_LADDER: ContextLadder = {
  signal: "transcript_bytes",
  milestones: COMPACTION_MILESTONE_BYTES,
  messages: MILESTONE_MESSAGE,
  handoffMin: HANDOFF_MILESTONE_MIN_BYTES,
};

/**
 * Codex: number of times the app-server compacted the MAIN thread's context
 * (`thread/compacted` → `state.codex_compactions`, counted by the adapter).
 * Why not bytes or percent: Codex rollouts on disk are ~30 KB (a byte ladder
 * never fires), and the context-window percent is cyclic — it drops after
 * every compaction — so it cannot drive a fire-once-per-milestone latch and
 * its reachable maximum depends on Codex's own auto-compaction threshold
 * (council review 2026-10-17: dahl D-1, ritchie B-1; max observed percent on
 * prod was 8). A compaction is the one event that literally says "the window
 * overflowed": the first one is normal, repeated ones mean the task has
 * outgrown the thread. No `/compact` tier — Codex compacts by itself.
 * Unverified against live traffic (no compaction has been recorded on prod
 * yet); the rungs are a data change if real sessions say otherwise.
 */
export const CODEX_COMPACTION_LADDER: ContextLadder = {
  signal: "codex_compactions",
  milestones: [2, 5, 10],
  messages: {
    2: "Codex has compacted this thread's context twice — the task is outgrowing the window. Continue in a new session with a handoff of the current task.",
    5: "Codex has compacted this thread's context 5 times. Continue in a new session with a handoff of the current task before the thread degrades further.",
    10: "Codex has compacted this thread's context 10 times — the thread is far past its window. Continue in a new session with a handoff of the current task.",
  },
  handoffMin: 2,
};

/**
 * The ONE reader of a persisted/wire advisory record. Records written before
 * 2026-10-17 carry only `milestoneBytes` and no `signal`; they are bytes.
 * Every server consumer goes through this (the browser has a mirror in
 * `src/utils/context-advisory.ts`) so retiring `milestoneBytes` or adding a
 * signal is a one-place change per runtime.
 */
export function decodeContextAdvisory(
  record: Pick<ContextAdvisoryRecord, "signal" | "milestone" | "milestoneBytes">,
): { signal: ContextAdvisorySignal; milestone: number } {
  return {
    signal: record.signal ?? "transcript_bytes",
    milestone: record.milestone ?? record.milestoneBytes ?? 0,
  };
}

/** Map a milestone to the action the browser offers for it. */
export function advisoryActionFor(
  milestone: number,
  handoffMin: number = HANDOFF_MILESTONE_MIN_BYTES,
): ContextAdvisoryAction {
  return milestone >= handoffMin ? "continue_in_new" : "compact";
}

/** One decision from {@link nextContextMilestone}, in the ladder's unit. */
export interface ContextMilestoneAdvisory {
  readonly signal: ContextAdvisorySignal;
  readonly milestone: number;
  readonly message: string;
  readonly action: ContextAdvisoryAction;
}

/**
 * Ladder-generic form of {@link nextCompactionMilestone}: the next threshold
 * `current` has crossed above `lastFired`, or `null` (below the first rung,
 * already fired this or a higher rung, or a rung without copy). Pure.
 */
export function nextContextMilestone(
  current: number,
  lastFired: number,
  ladder: ContextLadder,
): ContextMilestoneAdvisory | null {
  let crossed = 0;
  for (const m of ladder.milestones) {
    if (current >= m) crossed = m;
    else break; // milestones ordered ascending
  }
  if (crossed === 0) return null;
  if (crossed <= lastFired) return null;
  const message = ladder.messages[crossed];
  if (!message) return null;
  return { signal: ladder.signal, milestone: crossed, message, action: advisoryActionFor(crossed, ladder.handoffMin) };
}

/**
 * One decision from {@link nextCompactionMilestone}: the new milestone
 * that just crossed (in bytes) and its user-visible message, OR
 * `null` when no new milestone applies.
 */
export interface MilestoneAdvisory {
  readonly milestoneBytes: number;
  readonly message: string;
  /** `continue_in_new` from {@link HANDOFF_MILESTONE_MIN_BYTES} up, else `compact`. */
  readonly action: ContextAdvisoryAction;
}

/**
 * Decide whether a session's jsonl size has crossed a new compaction
 * milestone since the last check. Pure — no I/O, no side effects.
 *
 * @param currentSizeBytes  Result of `stat(jsonl).size`.
 * @param lastFiredMilestoneBytes  The highest milestone we've already
 *     advised on for this session, or `0` if none yet.
 * @param milestones  Ordered ascending list of thresholds. Defaults to
 *     {@link COMPACTION_MILESTONE_BYTES}.
 *
 * Returns the NEXT milestone the caller should fire on, or `null` when
 * the session is either below the first threshold OR already at ceiling.
 * Also `null` when current size is between two milestones and the
 * lower one has already been fired (steady state — nothing new to say).
 */
export function nextCompactionMilestone(
  currentSizeBytes: number,
  lastFiredMilestoneBytes: number,
  milestones: readonly number[] = COMPACTION_MILESTONE_BYTES,
  messages: Record<number, string> = MILESTONE_MESSAGE,
): MilestoneAdvisory | null {
  // Bytes-ladder convenience over the generic decision; custom milestone /
  // message arrays (tests) form an ad-hoc bytes ladder with the same handoff floor.
  const ladder: ContextLadder =
    milestones === COMPACTION_MILESTONE_BYTES && messages === MILESTONE_MESSAGE
      ? TRANSCRIPT_BYTES_LADDER
      : { signal: "transcript_bytes", milestones, messages, handoffMin: HANDOFF_MILESTONE_MIN_BYTES };
  const next = nextContextMilestone(currentSizeBytes, lastFiredMilestoneBytes, ladder);
  return next ? { milestoneBytes: next.milestone, message: next.message, action: next.action } : null;
}
