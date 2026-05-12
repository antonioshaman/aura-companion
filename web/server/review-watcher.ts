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
 */
const REVIEW_FILE_PATTERN = /^[A-Za-z0-9_-][A-Za-z0-9_.\-]{0,63}-(claude|codex)-observer\.md$/;

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
  /** Receive a validated review payload. Invalid events drop via {@link onDropped}. */
  onReview: (payload: ObserverReviewPayload) => void | Promise<void>;
  /**
   * Abort to stop the watcher. Aborting cleanly resolves the returned
   * promise; the watcher waits for any in-flight read/handler before
   * resolving, so callers can sequentially tear down dependent state.
   */
  signal: AbortSignal;
  /** Optional logger for dropped events. Defaults to a structured warn log. */
  onDropped?: (reason: ReviewDropReason, filename: string, detail?: string) => void;
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
      if (!REVIEW_FILE_PATTERN.test(file)) {
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
        const p = readAndEmit(opts.directory, file, seenDedupKeys, opts.onReview, onDropped, opts.signal);
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
  onReview: (p: ObserverReviewPayload) => void | Promise<void>,
  onDropped: (reason: ReviewDropReason, file: string, detail?: string) => void,
  signal: AbortSignal,
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
  const payload = parseObserverReviewPayload(raw);
  if (!payload) {
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
    await onReview(payload);
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
