// AURA-LOCAL — Council Plan "Sweep orphans", Task 1 (ritchie §A A2/A3 + EC-8).
//
// The single shared per-PID kill primitive: sentinel-before-sweep, a
// TOCTOU re-verify at the signal instant, SIGTERM-only (never SIGKILL
// inline, never a shell `pkill`), and a bounded wait-for-exit. Both the
// boot-time `orphan-reaper.ts` and the on-demand manual sweep MUST route
// their kills through this so there is exactly one place PID-reuse can be
// guarded and exactly one sentinel format the next-boot reconcile reads.
//
// (The boot reaper still carries its own inline copy of this sequence for
// now; rewiring it to call this helper is deferred to avoid churning its
// extensive test suite in the same change — see the implementation log.
// The manual sweep uses THIS helper exclusively, so no second sentinel
// scheme or second TOCTOU window is introduced by the new feature.)

import { readFileSync } from "node:fs";
import { log } from "../logger.js";
import { classifyArgv, splitCmdline, parsePpidFromStat } from "../orphan-reaper.js";
import { writeReapingMarker, deleteReapingMarker } from "./sentinel-markers.js";

/** Per-process wait-for-exit budget after SIGTERM (SIGTERM-only; stragglers
 *  are left for the next reaper/sweep pass). */
const DEFAULT_POST_TERM_GRACE_MS = 1_500;
/** Poll interval while waiting for SIGTERM-driven exit. */
const DEFAULT_POLL_INTERVAL_MS = 100;

/** Injectable syscall/clock seam — production binds `/proc` + `process.kill`. */
export interface ReapPidSeam {
  readStat?: (pid: number) => string;
  readCmdline?: (pid: number) => string;
  /** Liveness via `process.kill(pid, 0)`. */
  killCheck?: (pid: number) => boolean;
  /** `process.kill(pid, "SIGTERM")` — pure syscall, never a shell. */
  kill?: (pid: number, signal: "SIGTERM") => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface ReapPidOptions extends ReapPidSeam {
  /** Filesystem root for the `.reaping/<pid>.json` sentinel. */
  readonly sentinelRoot: string;
  /** Structured reason recorded in the sentinel + logs. */
  readonly reason: string;
  /**
   * The argv SHA-256 captured when the caller CLASSIFIED this pid as a
   * candidate. The TOCTOU re-verify aborts the kill if the pid's argv no
   * longer matches this — i.e. the kernel recycled the PID for an
   * unrelated process between classification and the signal.
   */
  readonly expectedArgvSha256: string;
  readonly graceMs?: number;
  readonly pollMs?: number;
}

/**
 * Outcome of a single reap attempt. Only `reaped`/`already-gone` mean the
 * process is on its way out; every other value means it SURVIVES and the
 * caller must not count it as swept.
 */
export type ReapPidOutcome =
  | "reaped"
  | "already-gone"
  | "aborted-drift"
  | "kill-failed"
  | "sentinel-failed";

function defaultReadStat(pid: number): string {
  return readFileSync(`/proc/${pid}/stat`, "utf8");
}
function defaultReadCmdline(pid: number): string {
  return readFileSync(`/proc/${pid}/cmdline`, "utf8");
}
function defaultKillCheck(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
function defaultKill(pid: number, signal: "SIGTERM"): void {
  // PURE syscall — NEVER `Bun.spawn(["pkill"])` / `exec` / `shell:true`.
  // Signature is `(number, "SIGTERM")` so command injection is impossible.
  process.kill(pid, signal);
}
function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Reap ONE pid the caller has already classified as a server-owned,
 * identity-verified sweep candidate.
 *
 * Sequence (EC-8): write sentinel → re-read `/proc/<pid>` and confirm ppid
 * is still 1 AND the argv still hashes to `expectedArgvSha256` → SIGTERM →
 * bounded poll-for-exit → delete sentinel. Aborts (deletes sentinel, does
 * not kill) on any drift. Never throws — every fs/proc/kill error is
 * caught and mapped to an outcome.
 */
export async function reapPidWithSentinel(pid: number, opts: ReapPidOptions): Promise<ReapPidOutcome> {
  const readStat = opts.readStat ?? defaultReadStat;
  const readCmdline = opts.readCmdline ?? defaultReadCmdline;
  const killCheck = opts.killCheck ?? defaultKillCheck;
  const kill = opts.kill ?? defaultKill;
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;
  const graceMs = opts.graceMs ?? DEFAULT_POST_TERM_GRACE_MS;
  const pollMs = opts.pollMs ?? DEFAULT_POLL_INTERVAL_MS;

  // Sentinel first — EC-8. Without it a crash between kill and the next
  // reconcile produces a "spontaneous death" ghost.
  try {
    writeReapingMarker(opts.sentinelRoot, pid, { pid, decisionTs: now(), reason: opts.reason });
  } catch (e) {
    log.warn("reap-pid", "sentinel write failed — skipping SIGTERM", {
      event: "sweep.reap.sentinel_write_failed",
      pid,
      reason: opts.reason,
      error_code: (e as NodeJS.ErrnoException).code ?? "unknown",
    });
    return "sentinel-failed";
  }

  // TOCTOU re-verify at the signal instant.
  let stillSame = false;
  try {
    const ppid = parsePpidFromStat(readStat(pid));
    const reClass = classifyArgv(splitCmdline(readCmdline(pid)));
    stillSame = ppid === 1 && reClass.isCompanionShape && reClass.argvSha256 === opts.expectedArgvSha256;
  } catch {
    stillSame = false; // pid vanished mid-window — nothing to kill
  }
  if (!stillSame) {
    log.warn("reap-pid", "identity drift before SIGTERM — aborting kill", {
      event: "sweep.reap.aborted_drift",
      pid,
      reason: opts.reason,
    });
    deleteReapingMarker(opts.sentinelRoot, pid);
    return "aborted-drift";
  }

  let killOk = false;
  let alreadyGone = false;
  try {
    kill(pid, "SIGTERM");
    killOk = true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ESRCH") {
      alreadyGone = true;
    } else {
      log.warn("reap-pid", "SIGTERM failed", {
        event: "sweep.reap.kill_failed",
        pid,
        reason: opts.reason,
        error_code: code ?? "unknown",
      });
      deleteReapingMarker(opts.sentinelRoot, pid);
      return "kill-failed";
    }
  }

  if (killOk) {
    const deadline = now() + graceMs;
    while (now() < deadline) {
      if (!killCheck(pid)) break;
      // eslint-disable-next-line no-await-in-loop
      await sleep(pollMs);
    }
  }

  deleteReapingMarker(opts.sentinelRoot, pid);
  return alreadyGone ? "already-gone" : "reaped";
}
