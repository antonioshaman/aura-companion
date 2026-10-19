// AURA-LOCAL
// Kernel wait channels of a process's threads (P7/SERVER-STDOUT-STALL).
//
// When the silent-stdio drift detector kills a CLI, the open question is
// which side stopped: did bun stop reading the stdout pipe (the CLI then
// blocks in the kernel with a thread parked in `pipe_write`), or did the CLI
// stop writing (threads idle in `ep_poll` / `futex_wait_queue`, no
// `pipe_write`)? Reading `/proc/<pid>/task/*/wchan` at detection time answers
// that for free. Linux-only; returns null wherever /proc is unavailable.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface WaitChannelFs {
  readdir(path: string): string[];
  readFile(path: string): string;
}

const realFs: WaitChannelFs = {
  readdir: (p) => readdirSync(p),
  readFile: (p) => readFileSync(p, "utf8"),
};

/**
 * Summarise thread wait channels as `pipe_write×1, ep_poll×2, futex_wait_queue×5`
 * (most frequent first, ties by name). `0` (running/runnable) is reported as
 * `running`. Returns null if the process or /proc is not readable.
 */
export function summarizeWaitChannels(
  pid: number,
  opts: { procRoot?: string; maxTasks?: number; fs?: WaitChannelFs } = {},
): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const fs = opts.fs ?? realFs;
  const taskDir = join(opts.procRoot ?? "/proc", String(pid), "task");
  let tids: string[];
  try {
    tids = fs.readdir(taskDir).filter((t) => /^\d+$/.test(t)).slice(0, opts.maxTasks ?? 256);
  } catch {
    return null;
  }
  const counts = new Map<string, number>();
  for (const tid of tids) {
    let wchan: string;
    try {
      wchan = fs.readFile(join(taskDir, tid, "wchan")).trim();
    } catch {
      continue; // thread exited between readdir and read
    }
    const key = wchan === "" || wchan === "0" ? "running" : wchan;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  if (counts.size === 0) return null;
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([k, n]) => `${k}×${n}`)
    .join(", ");
}
