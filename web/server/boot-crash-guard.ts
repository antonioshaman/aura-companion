import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeAtomicJson } from "./atomic-write.js";
import { log } from "./logger.js";

/**
 * W2 crash-loop guard for boot resume.
 *
 * Boot resume relaunches every session that was alive before a restart. The
 * auto-relaunch budget lives in memory and resets per boot, so after a
 * NON-graceful death (OOM-kill, segfault) under systemd `Restart=always` +
 * `RestartSec=5`, each respawn would bring the whole fleet back — more
 * memory → another OOM → another respawn. This guard persists the boots that
 * were NOT preceded by a graceful shutdown ("crash boots") and tells the
 * server to skip boot resume once {@link CRASH_LOOP_THRESHOLD} of them fall
 * inside {@link CRASH_LOOP_WINDOW_MS}. Sessions then come back the old way,
 * when a browser opens them.
 *
 * Graceful restarts (deploys, `systemctl restart`) never count — they are
 * exactly what boot resume exists for. Every failure fails OPEN (resume runs):
 * a missing or corrupt file must not strand the fleet.
 */

export const BOOT_HISTORY_FILE = "boot-history.json";
export const CRASH_LOOP_WINDOW_MS = 10 * 60_000;
export const CRASH_LOOP_THRESHOLD = 3;

interface BootHistory {
  /** Set by graceful shutdown; reset to false at every boot. */
  cleanShutdown: boolean;
  /** Epoch ms of recent crash boots, pruned to the window. */
  crashBoots: number[];
}

function read(dir: string): BootHistory | null {
  try {
    const raw = JSON.parse(readFileSync(join(dir, BOOT_HISTORY_FILE), "utf-8")) as Partial<BootHistory>;
    return {
      cleanShutdown: raw.cleanShutdown === true,
      crashBoots: Array.isArray(raw.crashBoots) ? raw.crashBoots.filter((n): n is number => typeof n === "number") : [],
    };
  } catch {
    return null;
  }
}

function write(dir: string, h: BootHistory): void {
  try {
    writeAtomicJson(join(dir, BOOT_HISTORY_FILE), h, { maxBytes: 64 * 1024 });
  } catch (err) {
    console.error("[boot-crash-guard] failed to write boot history:", err);
  }
}

export interface BootCheck {
  skipBootResume: boolean;
  /** Crash boots inside the window, including this one if it is one. */
  recentCrashBoots: number;
  /** This boot followed a non-graceful death. */
  crashBoot: boolean;
}

/**
 * Call once per boot, before boot resume is scheduled. A missing/corrupt
 * history counts as a clean previous shutdown (first boot ever, fail open).
 */
export function recordBootAndCheckCrashLoop(dir: string, now: number = Date.now()): BootCheck {
  const prev = read(dir);
  const crashBoot = prev !== null && !prev.cleanShutdown;
  const crashBoots = (prev?.crashBoots ?? []).filter((t) => now - t < CRASH_LOOP_WINDOW_MS);
  if (crashBoot) crashBoots.push(now);
  write(dir, { cleanShutdown: false, crashBoots });
  return {
    skipBootResume: crashBoots.length >= CRASH_LOOP_THRESHOLD,
    recentCrashBoots: crashBoots.length,
    crashBoot,
  };
}

/** Call from graceful shutdown: the next boot is not a crash boot. */
export function markCleanShutdown(dir: string): void {
  const prev = read(dir);
  write(dir, { cleanShutdown: true, crashBoots: prev?.crashBoots ?? [] });
}

/**
 * Boot wiring: records this boot and, in a crash loop, drains the launcher's
 * boot-resume candidates so `orchestrator.initialize()` schedules nothing.
 * Returns the skipped session ids (empty when boot resume proceeds).
 */
export function gateBootResumeOnCrashLoop(
  dir: string,
  drainCandidates: () => string[],
  now: number = Date.now(),
): string[] {
  const check = recordBootAndCheckCrashLoop(dir, now);
  if (!check.skipBootResume) return [];
  const skipped = drainCandidates();
  log.warn("boot-crash-guard", "boot resume skipped: crash loop detected", {
    event: "boot_resume.skipped_crash_loop",
    recentCrashBoots: check.recentCrashBoots,
    windowMs: CRASH_LOOP_WINDOW_MS,
    threshold: CRASH_LOOP_THRESHOLD,
    skippedSessions: skipped.length,
    sessionIds: skipped,
  });
  return skipped;
}
