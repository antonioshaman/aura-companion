/**
 * Filesystem watcher for observer review files. Mirror of
 * {@link watchCheckpoints} but for the `.council/reviews/` directory.
 *
 * The observer half writes one `<phase>-observer.md` file per checkpoint
 * (content is JSON matching {@link ObserverReviewPayload}, despite the
 * `.md` extension — the file pairing convention is filename-scoped, the
 * payload contract is JSON). This watcher detects new review files, parses
 * + validates them, and emits each payload to the supplied handler. Invalid
 * or duplicate emissions are dropped via the same `onDropped` hook as
 * `watchCheckpoints`, never silently.
 *
 * Idempotency: an LRU of seen `(checkpoint_id, observer_provider)` pairs
 * dedups re-emission of the same review (e.g. observer wrote the file,
 * was killed, restarted, re-emitted on re-read).
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { readFile, stat, watch } from "node:fs/promises";
import { join } from "node:path";
import { type ObserverReviewPayload, parseObserverReviewPayload } from "./council-types.js";
import { log } from "./logger.js";

const DEBOUNCE_MS = 150;
const SEEN_LRU_CAP = 256;
/**
 * Pinned filename shape: `<phase>-<provider>-observer.md`. The provider
 * segment (`claude` | `codex`) is REQUIRED so that two providers reviewing
 * the same checkpoint write to distinct paths — without it, the
 * `claude+codex` pairing collides under the debounce window and one
 * review is silently dropped (Persistence council review #5).
 *
 * Exported so agent harnesses, monitoring code, and external tools converge
 * on the SAME source of truth instead of hardcoding the pattern in prompts
 * or self-memory (Council Review 2026-05-15-0520 Prevention #5 / EC-20).
 * Consumers MUST NOT redefine this regex locally — drift between consumer-
 * side path expectations and producer-side reality is the
 * `feedback_consumer_path_drift_before_silent_claim` failure class. Pair
 * with {@link buildObserverReviewFilename} on the producer/writer side.
 */
export const OBSERVER_REVIEW_FILE_PATTERN = /^[A-Za-z0-9_-][A-Za-z0-9_.\-]{0,63}-(claude|codex)-observer\.md$/;

/**
 * Build the canonical observer-review filename for a given (phase, provider).
 * The single source of truth for the producer side; mirrors
 * {@link OBSERVER_REVIEW_FILE_PATTERN} on the consumer side.
 *
 * `phase` must match the phase-token rules enforced by `isValidPhase` in
 * `council-types.ts` (bounded, A-Z/a-z/0-9/_/-/. only). Length is bounded
 * to 64 chars by `OBSERVER_REVIEW_FILE_PATTERN`; this helper enforces the
 * same ceiling.
 *
 * Throws on invalid input rather than producing a silently-malformed name —
 * a writer that can't construct a valid filename has lost the contract and
 * the failure must surface, not be papered over with a fallback path.
 */
export function buildObserverReviewFilename(
  phase: string,
  provider: "claude" | "codex",
  sessionGroupId?: string,
): string {
  if (typeof phase !== "string" || phase.length === 0 || phase.length > 64) {
    throw new RangeError(
      `buildObserverReviewFilename: phase must be a non-empty string ≤64 chars (got ${typeof phase} length ${(phase as string)?.length})`,
    );
  }
  if (provider !== "claude" && provider !== "codex") {
    throw new RangeError(
      `buildObserverReviewFilename: provider must be "claude" or "codex" (got ${JSON.stringify(provider)})`,
    );
  }
  // Council review 2026-09-08 #1: the group-id segment scopes the review file
  // so pairs sharing a workspace don't collide on `<phase>-<provider>-...`.
  // Optional for backward compatibility — an observer running the pre-#1
  // prompt still writes the group-less name, which the pattern below (and the
  // reader) both accept; the group segment is just extra prefix characters.
  const filename = sessionGroupId
    ? `${fitPhaseBesideGroup(phase, sessionGroupId)}-${sessionGroupId}-${provider}-observer.md`
    : `${phase}-${provider}-observer.md`;
  if (!OBSERVER_REVIEW_FILE_PATTERN.test(filename)) {
    throw new RangeError(
      `buildObserverReviewFilename: constructed name ${JSON.stringify(filename)} fails OBSERVER_REVIEW_FILE_PATTERN — phase or group token has illegal characters, or the combined prefix exceeds 64 chars`,
    );
  }
  return filename;
}

/** Room the pattern's 64-char prefix leaves beside `-<group>`; hash suffix length. */
const PHASE_HASH_LEN = 8;

/**
 * FIX-B1-1: a valid phase (≤64) plus `-grp_<32hex>` can overflow the pattern's
 * 64-char prefix — any phase over 27 chars did, and the throw lost the review.
 * When it would overflow, shorten the phase deterministically to
 * `<head>.<sha256(phase)[:8]>` so the name still fits, stays stable for the
 * same phase, and distinct phases sharing a head do not collide. Readers match
 * reviews by the payload's `checkpoint_id`, never by the phase in the name, so
 * shortening is invisible to them. Phases that already fit are untouched.
 */
function fitPhaseBesideGroup(phase: string, sessionGroupId: string): string {
  const room = 64 - 1 - sessionGroupId.length;
  if (phase.length <= room) return phase;
  const headLen = room - 1 - PHASE_HASH_LEN;
  // A group id too long to leave a head falls through unchanged; the pattern
  // check below then throws with the "combined prefix" diagnostic.
  if (headLen < 1) return phase;
  const hash = createHash("sha256").update(phase).digest("hex").slice(0, PHASE_HASH_LEN);
  return `${phase.slice(0, headLen)}.${hash}`;
}

/**
 * Synchronously scan a reviews directory for a review answering `checkpointId`.
 *
 * `watchReviews` is the live path, but a single dropped `fs.watch` event is
 * unrecoverable: nothing else ever re-reads `.council/reviews/`. Checkpoints
 * already have the mirror-image failsafe (`scanForMissedObserverWakes` re-reads
 * `.council/checkpoints/` from disk on a tick); reviews had no equivalent, so a
 * lost event degraded the pair AND discarded the findings permanently. This is
 * the read half of that missing failsafe — EC-8's sentinel-before-sweep applied
 * to the wake→review watchdog: look at the disk before declaring absence.
 *
 * Deliberately synchronous. The caller is a `setTimeout` watchdog whose degrade
 * decision must stay in one turn; the directory holds a handful of small files.
 *
 * Returns the FIRST matching payload, or null when no file on disk answers the
 * checkpoint. Per-file read/parse failures are skipped, not thrown — a single
 * corrupt sibling must not mask a valid review.
 */
export function findReviewForCheckpointSync(opts: {
  directory: string;
  checkpointId: string;
  normalizeRaw?: (raw: string, provider: "claude" | "codex") => string;
}): { payload: ObserverReviewPayload; file: string; reviewedAt?: number } | null {
  let entries: string[];
  try {
    entries = readdirSync(opts.directory).filter((f) => OBSERVER_REVIEW_FILE_PATTERN.test(f));
  } catch {
    return null;
  }
  for (const file of entries) {
    const path = join(opts.directory, file);
    let raw: string;
    try {
      raw = readFileSync(path, "utf-8");
    } catch {
      continue;
    }
    if (opts.normalizeRaw) {
      const provider = OBSERVER_REVIEW_FILE_PATTERN.exec(file)?.[1] as "claude" | "codex" | undefined;
      if (provider) {
        try {
          raw = opts.normalizeRaw(raw, provider);
        } catch {
          continue;
        }
      }
    }
    const payload = parseObserverReviewPayload(raw);
    if (!payload || payload.checkpoint_id !== opts.checkpointId) continue;
    let reviewedAt: number | undefined;
    try {
      reviewedAt = statSync(path).mtimeMs;
    } catch {
      reviewedAt = undefined;
    }
    return { payload, file, reviewedAt };
  }
  return null;
}

/**
 * True when `file` is a review name scoped to `sessionGroupId`, i.e. the shape
 * {@link buildObserverReviewFilename} produces WITH a group id:
 * `<phase>-<group>-<provider>-observer.md`.
 *
 * A group-less `<phase>-<provider>-observer.md` (observed from Codex observers
 * that ignore the reply-only contract, AuraBench BENCH-H) is NOT group-scoped:
 * in a workspace shared by several pairs every pair's observer can write the
 * same name, so the name alone cannot say whose review it is. Only the host
 * that woke the observer can attribute it (see `ObserverReplyCapture`'s
 * adoption path), so the per-group watcher never consumes such a file.
 */
export function isGroupScopedReviewFilename(file: string, sessionGroupId: string): boolean {
  if (!OBSERVER_REVIEW_FILE_PATTERN.test(file)) return false;
  return file.endsWith(`-${sessionGroupId}-claude-observer.md`) || file.endsWith(`-${sessionGroupId}-codex-observer.md`);
}

/**
 * Suffix appended to a group-less review file once the host has adopted it
 * under the canonical group-scoped name. The result no longer ends in `.md`,
 * so no watcher, rescan or bootstrap reader ({@link OBSERVER_REVIEW_FILE_PATTERN})
 * can pick it up again — in particular not another pair sharing the directory.
 */
export function adoptedReviewAsideName(file: string, sessionGroupId: string, atMs: number): string {
  return `${file}.adopted-${sessionGroupId}-${atMs}`;
}

/**
 * Like {@link findReviewForCheckpointSync}, but only returns a review OWNED by
 * `sessionGroupId` (payload `session_group_id` matches), preferring the
 * group-scoped file name over a group-less one when both answer the
 * checkpoint. A foreign pair's same-checkpoint file never masks ours (the
 * first-match helper above returns whatever readdir lists first).
 */
export function findOwnReviewForCheckpointSync(opts: {
  directory: string;
  checkpointId: string;
  sessionGroupId: string;
  normalizeRaw?: (raw: string, provider: "claude" | "codex") => string;
}): { payload: ObserverReviewPayload; file: string; groupScoped: boolean; reviewedAt?: number } | null {
  let entries: string[];
  try {
    entries = readdirSync(opts.directory).filter((f) => OBSERVER_REVIEW_FILE_PATTERN.test(f));
  } catch {
    return null;
  }
  let groupless: { payload: ObserverReviewPayload; file: string; groupScoped: boolean; reviewedAt?: number } | null = null;
  for (const file of entries) {
    const path = join(opts.directory, file);
    let raw: string;
    try {
      raw = readFileSync(path, "utf-8");
      if (opts.normalizeRaw) {
        const provider = OBSERVER_REVIEW_FILE_PATTERN.exec(file)?.[1] as "claude" | "codex" | undefined;
        if (provider) raw = opts.normalizeRaw(raw, provider);
      }
    } catch {
      continue;
    }
    const payload = parseObserverReviewPayload(raw);
    if (!payload || payload.checkpoint_id !== opts.checkpointId) continue;
    if (payload.session_group_id !== opts.sessionGroupId) continue;
    let reviewedAt: number | undefined;
    try {
      reviewedAt = statSync(path).mtimeMs;
    } catch {
      reviewedAt = undefined;
    }
    const groupScoped = isGroupScopedReviewFilename(file, opts.sessionGroupId);
    if (groupScoped) return { payload, file, groupScoped, reviewedAt };
    groupless ??= { payload, file, groupScoped, reviewedAt };
  }
  return groupless;
}

export type ReviewDropReason =
  | "invalid-schema"
  | "invalid-filename"
  | "duplicate-review"
  | "read-error"
  | "handler-error"
  /** Two distinct writes landed on the same path within the debounce
   *  window; the earlier rename's bytes were overwritten on disk before
   *  the watcher could read them. Honours EC-4's "never silently
   *  coalesce" rule — the loss is visible, not absorbed. */
  | "superseded";

export interface ReviewWatcherOptions {
  /** Absolute path to the directory containing review files. */
  directory: string;
  /**
   * Receive a validated review payload. Invalid events drop via {@link onDropped}.
   * `reviewedAt` is the review FILE's mtime in ms epoch — the server-observed
   * real event time, NOT the observer's self-reported `reviewed_at` (which is
   * observer-authored and unreliable). Absent only if the post-read stat fails.
   */
  onReview: (payload: ObserverReviewPayload, reviewedAt?: number) => void | Promise<void>;
  /**
   * Abort to stop the watcher. Aborting cleanly resolves the returned
   * promise; the watcher waits for any in-flight read/handler before
   * resolving, so callers can sequentially tear down dependent state.
   */
  signal: AbortSignal;
  /** Optional logger for dropped events. Defaults to a structured warn log. */
  onDropped?: (reason: ReviewDropReason, filename: string, detail?: string) => void;
  /**
   * Optional pre-parse normalizer. Receives the raw file bytes and the
   * provider extracted from the filename, returns a (possibly rewritten)
   * raw string handed to {@link parseObserverReviewPayload}. Used to bring
   * codex-native reviews up to schema — the codex CLI omits the
   * server-mandated audit fields the parser requires. The caller owns the
   * provider gating (claude reviews flow through untouched). Defaults to
   * identity.
   */
  normalizeRaw?: (raw: string, provider: "claude" | "codex") => string;
  /**
   * Debounce window in ms before a settled file is read. Defaults to
   * {@link DEBOUNCE_MS}. A test seam only: production callers leave it unset.
   * Tests that exercise the mtime-supersede path raise it so the first
   * fs.watch event is reliably observed at the intermediate mtime before the
   * timer flushes — decoupling "time for the event to be seen" from "time
   * before the timer fires" removes the real-fs.watch timing flake.
   */
  debounceMs?: number;
  /**
   * The pair this watcher serves. When set, only review files named for THIS
   * group ({@link isGroupScopedReviewFilename}) are read; group-less and other
   * groups' files are skipped without a drop event (they are not this pair's
   * to consume — a group-less file is adopted, if at all, by the host that
   * woke its author). Unset = legacy single-tenant behaviour (every
   * pattern-matching file is read), kept for tests and external callers.
   */
  sessionGroupId?: string;
}

/**
 * Watch a review directory and emit validated {@link ObserverReviewPayload}
 * events. The same atomic-write + debounce + dedup contract as
 * `watchCheckpoints`.
 */
export async function watchReviews(opts: ReviewWatcherOptions): Promise<void> {
  // Map from filename → { timer, mtimeNs from the event that set the timer }.
  // EC-4 (Persistence council review #5): debounce must NOT silently
  // coalesce distinct payloads on the same path. Keying the dedup decision
  // by `(file, mtimeNs)` means that when two distinct writes land on the
  // same path within the 150 ms window, the second's mtime differs from
  // the first's and both surface (or the loss is logged via onDropped).
  const timers = new Map<string, { timer: ReturnType<typeof setTimeout>; observedMtimeNs: bigint | null }>();
  const inflight = new Set<Promise<void>>();
  const seenDedupKeys = new Set<string>();
  const debounceMs = opts.debounceMs ?? DEBOUNCE_MS;
  const onDropped =
    opts.onDropped ??
    ((reason: ReviewDropReason, file: string, detail?: string) =>
      log.warn("review-watcher", "dropped event", { file, reason, detail }));

  try {
    for await (const ev of watch(opts.directory, { signal: opts.signal })) {
      const file = ev.filename;
      if (!file) continue;
      if (file.startsWith(".")) continue;
      if (file.includes("\0")) continue;
      // Two-tier filter: silently drop events that don't look like a
      // review attempt at all (e.g. macOS fs.watch fires events with the
      // PARENT DIRECTORY name as `filename` when the dir's mtime
      // changes — observed as `rev-watcher-MeKrVU`-style identifiers on
      // macOS-latest CI). The strict pattern check stays — but only for
      // filenames that already look like a `.md` attempt, so a wrong
      // pattern under `.md` is a legitimate operator misconfig the
      // observer should learn about.
      if (!file.endsWith(".md")) continue;
      if (!OBSERVER_REVIEW_FILE_PATTERN.test(file)) {
        onDropped("invalid-filename", file);
        continue;
      }
      if (opts.sessionGroupId !== undefined && !isGroupScopedReviewFilename(file, opts.sessionGroupId)) continue;

      // Capture the current mtime as the key for THIS debounce window. If
      // a second event arrives with the same mtime, it's a duplicate FS
      // notification for the same atomic-write; coalesce. If the mtime
      // differs (a real second write), let the timer flush the prior
      // read AND schedule a new one — neither payload is lost.
      let observedMtimeNs: bigint | null = null;
      try {
        const st = await stat(join(opts.directory, file), { bigint: true });
        observedMtimeNs = st.mtimeNs;
      } catch {
        // Stat may fail under a rename-in-progress race; treat as unknown
        // mtime and rely on the timer to read on flush.
      }

      const existing = timers.get(file);
      if (existing) {
        if (existing.observedMtimeNs !== null && observedMtimeNs !== null
            && existing.observedMtimeNs !== observedMtimeNs) {
          // Distinct payload arrived during the debounce window. The
          // first rename's bytes were already overwritten on disk by the
          // second atomic-write, so we cannot recover them — log the
          // loss explicitly (EC-4 mandate: "every payload that crossed
          // the rename barrier is either read-and-emitted OR
          // read-and-dropped-with-reason via onDropped").
          clearTimeout(existing.timer);
          onDropped("superseded", file, `mtime ${existing.observedMtimeNs} → ${observedMtimeNs}`);
        } else {
          clearTimeout(existing.timer);
        }
      }
      const timer = setTimeout(() => {
        timers.delete(file);
        if (opts.signal.aborted) return;
        const p = readAndEmit(opts.directory, file, seenDedupKeys, opts.onReview, onDropped, opts.signal, opts.normalizeRaw);
        inflight.add(p);
        p.finally(() => inflight.delete(p));
      }, debounceMs);
      timers.set(file, { timer, observedMtimeNs });
    }
  } catch (err) {
    if (err instanceof Error && err.name !== "AbortError") {
      throw err;
    }
  } finally {
    for (const entry of timers.values()) clearTimeout(entry.timer);
    timers.clear();
    if (inflight.size > 0) {
      await Promise.allSettled([...inflight]);
    }
  }
}

async function readAndEmit(
  dir: string,
  file: string,
  seen: Set<string>,
  onReview: (p: ObserverReviewPayload, reviewedAt?: number) => void | Promise<void>,
  onDropped: (reason: ReviewDropReason, file: string, detail?: string) => void,
  signal: AbortSignal,
  normalizeRaw?: (raw: string, provider: "claude" | "codex") => string,
): Promise<void> {
  if (signal.aborted) return;
  const path = join(dir, file);
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch (err) {
    onDropped("read-error", file, err instanceof Error ? err.message : String(err));
    return;
  }
  if (signal.aborted) return;
  // Server-observed real event time = the review file's mtime. Passed to
  // the handler so the live `group:review` path stamps each finding with
  // when the file actually landed, not when the browser ingested the batch.
  // A stat failure degrades to undefined; the handler falls back to its own
  // clock rather than dropping the review.
  let reviewedAt: number | undefined;
  try {
    reviewedAt = (await stat(path)).mtimeMs;
  } catch {
    reviewedAt = undefined;
  }
  // Bring provider-specific native output up to schema before parsing. The
  // filename already passed OBSERVER_REVIEW_FILE_PATTERN in watchReviews, so
  // the provider capture group is present. codex omits the server-mandated
  // audit fields the parser requires; claude reviews are handed back
  // unchanged by the caller's normalizer.
  if (normalizeRaw) {
    const provider = OBSERVER_REVIEW_FILE_PATTERN.exec(file)?.[1] as "claude" | "codex" | undefined;
    if (provider) raw = normalizeRaw(raw, provider);
  }
  // Task 13: parser-level reason surfaces upstream observer drift via
  // structured protocol.frame_dropped log; watcher's higher-level
  // "invalid-schema" drop fires alongside for the watcher-state log.
  let parserReason: string | undefined;
  let parserField: string | undefined;
  const payload = parseObserverReviewPayload(raw, (reason, field) => {
    parserReason = reason;
    parserField = field;
  });
  if (!payload) {
    log.warn("review-watcher", "protocol.frame_dropped", {
      event: "protocol.frame_dropped",
      backend: "council",
      parser: "observer-review",
      reason: parserReason ?? "unknown",
      field: parserField,
      file,
    });
    onDropped("invalid-schema", file);
    return;
  }
  // Dedup by (checkpoint_id, observer_provider) — two reviews for the
  // same checkpoint from different providers should both surface.
  const dedupKey = `${payload.checkpoint_id}::${payload.observer_provider}`;
  if (seen.has(dedupKey)) {
    onDropped("duplicate-review", file, dedupKey);
    return;
  }
  if (signal.aborted) return;
  // Persistence council review #6 (P2-1): commit the dedup key AFTER a
  // successful handler invocation. If the handler throws (transient
  // broadcast failure, downstream bug), the key stays uncommitted so a
  // retry of the same review on the next FS event surfaces normally;
  // committing before the handler poisoned the dedup forever.
  try {
    await onReview(payload, reviewedAt);
  } catch (err) {
    onDropped("handler-error", file, err instanceof Error ? err.message : String(err));
    return;
  }
  seen.add(dedupKey);
  if (seen.size > SEEN_LRU_CAP) {
    const oldest = seen.values().next().value;
    if (oldest !== undefined) seen.delete(oldest);
  }
}
