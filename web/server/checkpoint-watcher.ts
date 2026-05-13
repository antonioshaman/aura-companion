import { readFile, watch } from "node:fs/promises";
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

export type CheckpointDropReason =
  | "invalid-schema"
  | "duplicate-checkpoint-id"
  | "read-error"
  | "handler-error";

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
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const inflight = new Set<Promise<void>>();
  const seenCheckpointIds = new Set<string>();
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

      const existing = timers.get(file);
      if (existing) clearTimeout(existing);
      const timer = setTimeout(() => {
        timers.delete(file);
        if (opts.signal.aborted) return;
        const p = readAndEmit(opts.directory, file, seenCheckpointIds, opts.onCheckpoint, onDropped, opts.signal);
        inflight.add(p);
        // Cleanup when handler settles, whether success or failure.
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
