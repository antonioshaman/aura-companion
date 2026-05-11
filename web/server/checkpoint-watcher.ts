import { readFile, watch } from "node:fs/promises";
import { join } from "node:path";
import { type CheckpointPayload, parseCheckpointPayload } from "./council-types.js";

/**
 * Debounce window between filesystem event and the read. Some platforms
 * fire two events for one atomic rename — coalesce them so the handler
 * runs once per logical write.
 */
const DEBOUNCE_MS = 150;

export interface CheckpointWatcherOptions {
  /** Absolute path to the directory containing checkpoint files. */
  directory: string;
  /** Receive a validated payload. Invalid events are dropped via {@link onDropped}. */
  onCheckpoint: (payload: CheckpointPayload) => void | Promise<void>;
  /**
   * Abort to stop the watcher. Aborting cleanly resolves the returned
   * promise; the watcher's pending debounce timers are cleared.
   */
  signal: AbortSignal;
  /** Optional logger for invalid/oversized/read-errored events. */
  onDropped?: (reason: string, filename: string) => void;
}

/**
 * Watch a checkpoint directory and emit validated {@link CheckpointPayload}
 * events. The orchestrator writes atomically via tmp+rename
 * ({@link writeAtomicJson}); this watcher reads only `*.json` files (never
 * `.tmp`/dotfiles) and parses via {@link parseCheckpointPayload}.
 *
 * Invalid/oversized files are dropped silently. The historical "болтается"
 * regression of an observer wedged on a partial JSON parse is mitigated
 * here: debounce + atomic-write contract + null-on-failure parsing.
 *
 * Resolves when the signal aborts. Non-abort errors propagate.
 */
export async function watchCheckpoints(opts: CheckpointWatcherOptions): Promise<void> {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const onDropped =
    opts.onDropped ??
    ((reason: string, file: string) => console.warn(`[checkpoint-watcher] dropped ${file}: ${reason}`));
  try {
    for await (const ev of watch(opts.directory, { signal: opts.signal })) {
      const file = ev.filename;
      if (!file) continue;
      // Ignore the writer's `.tmp` staging files (dotfile rule) and anything not .json.
      if (file.startsWith(".") || !file.endsWith(".json")) continue;
      // Defence-in-depth: refuse paths with NUL bytes even though fs.watch
      // would rarely surface them — some libraries truncate at NUL.
      if (file.includes("\0")) continue;

      const existing = timers.get(file);
      if (existing) clearTimeout(existing);
      const timer = setTimeout(() => {
        timers.delete(file);
        void readAndEmit(opts.directory, file, opts.onCheckpoint, onDropped);
      }, DEBOUNCE_MS);
      timers.set(file, timer);
    }
  } catch (err) {
    if ((err as { name?: string } | null)?.name !== "AbortError") {
      throw err;
    }
  } finally {
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
  }
}

async function readAndEmit(
  dir: string,
  file: string,
  onCheckpoint: (p: CheckpointPayload) => void | Promise<void>,
  onDropped: (reason: string, file: string) => void,
): Promise<void> {
  const path = join(dir, file);
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch (err) {
    onDropped(`read-error: ${(err as Error).message}`, file);
    return;
  }
  const payload = parseCheckpointPayload(raw);
  if (!payload) {
    onDropped("invalid-schema", file);
    return;
  }
  try {
    await onCheckpoint(payload);
  } catch (err) {
    onDropped(`handler-error: ${(err as Error).message}`, file);
  }
}
