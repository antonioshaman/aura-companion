import { readFile, stat, watch } from "node:fs/promises";
import { join } from "node:path";
import { type CheckpointPayload, parseCheckpointPayload } from "./council-types.js";
import { log } from "./logger.js";

/**
 * Debounce window between filesystem event and the read. Some platforms
 * fire two events for one atomic rename — coalesce them so the handler
 * runs once per logical write.
 */
const DEBOUNCE_MS = 150;

/** Bounded LRU cap for the seen-checkpoint dedup set. */
const SEEN_LRU_CAP = 256;

/**
 * Council review 2026-09-08 #1: build the group-scoped checkpoint filename.
 *
 * Pairs sharing one workspace share the `.council/checkpoints/` directory. A
 * non-group-scoped name (`<phase>.json`) means two pairs on the same phase —
 * or two fresh spawns (`spawn.json`) — write the SAME inode: last write wins,
 * and the loser's `entry.lastCheckpoint` never populates, so its observer
 * degrades. Scoping the filename by group id gives each pair its own file;
 * the watcher still reads every `*.json` and the per-group
 * `session_group_id` guard keeps foreign files out of the wrong group's
 * state. Readers glob (they never reconstruct this name), so the write side
 * is the only place this must change.
 *
 * `.json` filenames may contain `_`/`-`/`.`; a `grp_<hex>` id is safe. The
 * result is `<phase>.<groupId>.json`.
 */
export function buildCheckpointFilename(phase: string, sessionGroupId: string): string {
  return `${phase}.${sessionGroupId}.json`;
}

export type CheckpointDropReason =
  | "invalid-schema"
  | "duplicate-checkpoint-id"
  | "read-error"
  | "handler-error"
  /** Two distinct checkpoint writes (differing checkpoint_id/sequence, same
   *  phase → same inode) landed on the same path within the debounce window;
   *  the earlier rename's bytes were overwritten on disk before the watcher
   *  could read them. Honours EC-4's "never silently coalesce" rule — the loss
   *  is visible, not absorbed. Mirror of review-watcher's `superseded`. */
  | "superseded";

export interface CheckpointWatcherOptions {
  /** Absolute path to the directory containing checkpoint files. */
  directory: string;
  /** Receive a validated payload. Invalid events are dropped via {@link onDropped}. */
  onCheckpoint: (payload: CheckpointPayload) => void | Promise<void>;
  /**
   * Abort to stop the watcher. Aborting cleanly resolves the returned
   * promise; the watcher waits for any in-flight read/handler before
   * resolving, so callers can sequentially tear down dependent state.
   */
  signal: AbortSignal;
  /** Optional logger for invalid/oversized/read-errored/duplicate events. */
  onDropped?: (reason: CheckpointDropReason, filename: string, detail?: string) => void;
  /**
   * Debounce window in ms before a settled file is read. Defaults to
   * {@link DEBOUNCE_MS}. A test seam only: production callers leave it unset.
   * Tests that exercise the mtime-supersede path raise it so the first
   * fs.watch event is reliably observed at the intermediate mtime before the
   * timer flushes — decoupling "time for the event to be seen" from "time
   * before the timer fires" removes the real-fs.watch timing flake. Mirrors
   * the identical seam in {@link watchReviews}.
   */
  debounceMs?: number;
}

/**
 * Watch a checkpoint directory and emit validated {@link CheckpointPayload}
 * events. The orchestrator writes atomically via tmp+rename
 * ({@link writeAtomicJson}); this watcher reads only `*.json` files (never
 * `.tmp`/dotfiles) and parses via {@link parseCheckpointPayload}.
 *
 * Idempotency: an LRU of seen `checkpoint_id`s drops duplicates from
 * re-emitted files. The historical "болтается" regression of an observer
 * wedged on a partial JSON parse is mitigated here: debounce + atomic-write
 * contract + null-on-failure parsing.
 *
 * On abort: pending debounce timers are cleared AND in-flight read/handler
 * invocations are awaited before the returned promise resolves.
 */
export async function watchCheckpoints(opts: CheckpointWatcherOptions): Promise<void> {
  // Map from filename → { timer, mtimeNs from the event that set the timer }.
  // EC-4: debounce must NOT silently coalesce distinct payloads on the same
  // path. Pairs sharing a workspace collapse two checkpoints (different
  // checkpoint_id/sequence, same phase) onto one inode; keying the dedup
  // decision by `(file, mtimeNs)` means that when a second distinct write
  // lands within the window its mtime differs from the first's, so the loss
  // surfaces via `onDropped("superseded", …)` rather than vanishing. Mirror
  // of {@link watchReviews}.
  const timers = new Map<string, { timer: ReturnType<typeof setTimeout>; observedMtimeNs: bigint | null }>();
  const inflight = new Set<Promise<void>>();
  const seenCheckpointIds = new Set<string>();
  const debounceMs = opts.debounceMs ?? DEBOUNCE_MS;
  const onDropped =
    opts.onDropped ??
    ((reason: CheckpointDropReason, file: string, detail?: string) =>
      log.warn("checkpoint-watcher", "dropped event", { file, reason, detail }));

  try {
    for await (const ev of watch(opts.directory, { signal: opts.signal })) {
      const file = ev.filename;
      if (!file) continue;
      // Ignore the writer's `.tmp` staging files (dotfile rule) and anything not .json.
      if (file.startsWith(".") || !file.endsWith(".json")) continue;
      // Defence-in-depth: refuse paths with NUL bytes.
      if (file.includes("\0")) continue;

      // Capture the current mtime as the key for THIS debounce window. If a
      // second event arrives with the same mtime, it's a duplicate FS
      // notification for the same atomic-write; coalesce. If the mtime differs
      // (a real second write with a distinct payload), the first rename's bytes
      // were already overwritten on disk before we could read them — log the
      // loss explicitly (EC-4: every payload that crossed the rename barrier is
      // either read-and-emitted OR read-and-dropped-with-reason via onDropped).
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
          clearTimeout(existing.timer);
          onDropped("superseded", file, `mtime ${existing.observedMtimeNs} → ${observedMtimeNs}`);
        } else {
          clearTimeout(existing.timer);
        }
      }
      const timer = setTimeout(() => {
        timers.delete(file);
        if (opts.signal.aborted) return;
        const p = readAndEmit(opts.directory, file, seenCheckpointIds, opts.onCheckpoint, onDropped, opts.signal);
        inflight.add(p);
        // Cleanup when handler settles, whether success or failure.
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
    // Await any in-flight handlers so caller-side teardown after `await
    // watchCheckpoints(...)` resolves does not race late emissions.
    if (inflight.size > 0) {
      await Promise.allSettled([...inflight]);
    }
  }
}

async function readAndEmit(
  dir: string,
  file: string,
  seen: Set<string>,
  onCheckpoint: (p: CheckpointPayload) => void | Promise<void>,
  onDropped: (reason: CheckpointDropReason, file: string, detail?: string) => void,
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
  // Task 13: capture parser-level reason and emit a structured
  // protocol.frame_dropped signal alongside the watcher's higher-level
  // "invalid-schema" drop. Upstream writer drift becomes visible from
  // the first malformed frame rather than after silent divergence.
  let parserReason: string | undefined;
  let parserField: string | undefined;
  const payload = parseCheckpointPayload(raw, (reason, field) => {
    parserReason = reason;
    parserField = field;
  });
  if (!payload) {
    log.warn("checkpoint-watcher", "protocol.frame_dropped", {
      event: "protocol.frame_dropped",
      backend: "council",
      parser: "checkpoint",
      reason: parserReason ?? "unknown",
      field: parserField,
      file,
    });
    onDropped("invalid-schema", file);
    return;
  }
  // Realtime F4 / Persistence F5: dedup by checkpoint_id. Schema defines
  // the field "for dedup" — honour it here so observer wakes once per
  // logical checkpoint, not once per FS event.
  if (seen.has(payload.checkpoint_id)) {
    onDropped("duplicate-checkpoint-id", file, payload.checkpoint_id);
    return;
  }
  seen.add(payload.checkpoint_id);
  // Bounded LRU — evict oldest when over cap.
  if (seen.size > SEEN_LRU_CAP) {
    const oldest = seen.values().next().value;
    if (oldest !== undefined) seen.delete(oldest);
  }
  if (signal.aborted) return;
  try {
    await onCheckpoint(payload);
  } catch (err) {
    onDropped("handler-error", file, err instanceof Error ? err.message : String(err));
  }
}
