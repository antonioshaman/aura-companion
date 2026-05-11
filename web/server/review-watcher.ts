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

import { readFile, watch } from "node:fs/promises";
import { join } from "node:path";
import { type ObserverReviewPayload, parseObserverReviewPayload } from "./council-types.js";
import { log } from "./logger.js";

const DEBOUNCE_MS = 150;
const SEEN_LRU_CAP = 256;
const REVIEW_FILE_PATTERN = /^[A-Za-z0-9_-][A-Za-z0-9_.\-]{0,63}-observer\.md$/;

export type ReviewDropReason =
  | "invalid-schema"
  | "invalid-filename"
  | "duplicate-review"
  | "read-error"
  | "handler-error";

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
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
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
      // Filename pattern matches the observer-write-policy pinned shape.
      if (!REVIEW_FILE_PATTERN.test(file)) {
        onDropped("invalid-filename", file);
        continue;
      }

      const existing = timers.get(file);
      if (existing) clearTimeout(existing);
      const timer = setTimeout(() => {
        timers.delete(file);
        if (opts.signal.aborted) return;
        const p = readAndEmit(opts.directory, file, seenDedupKeys, opts.onReview, onDropped, opts.signal);
        inflight.add(p);
        p.finally(() => inflight.delete(p));
      }, DEBOUNCE_MS);
      timers.set(file, timer);
    }
  } catch (err) {
    if (err instanceof Error && err.name !== "AbortError") {
      throw err;
    }
  } finally {
    for (const t of timers.values()) clearTimeout(t);
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
  seen.add(dedupKey);
  if (seen.size > SEEN_LRU_CAP) {
    const oldest = seen.values().next().value;
    if (oldest !== undefined) seen.delete(oldest);
  }
  if (signal.aborted) return;
  try {
    await onReview(payload);
  } catch (err) {
    onDropped("handler-error", file, err instanceof Error ? err.message : String(err));
  }
}
