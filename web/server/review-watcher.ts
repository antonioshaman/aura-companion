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
  const filename = `${phase}-${provider}-observer.md`;
  if (!OBSERVER_REVIEW_FILE_PATTERN.test(filename)) {
    throw new RangeError(
      `buildObserverReviewFilename: constructed name ${JSON.stringify(filename)} fails OBSERVER_REVIEW_FILE_PATTERN — phase token has illegal characters`,
    );
  }
  return filename;
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
      }, DEBOUNCE_MS);
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
