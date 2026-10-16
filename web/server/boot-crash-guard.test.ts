import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BOOT_HISTORY_FILE,
  CRASH_LOOP_THRESHOLD,
  CRASH_LOOP_WINDOW_MS,
  gateBootResumeOnCrashLoop,
  markCleanShutdown,
  recordBootAndCheckCrashLoop,
} from "./boot-crash-guard.js";

// W2 review STOP on #362: the auto-relaunch budget lives in memory and resets
// on every boot. With boot resume, a NON-graceful death (OOM-kill, segfault)
// under `Restart=always` + `RestartSec=5` would bring every CLI back on each
// respawn — more memory → another OOM → another respawn, a positive feedback
// loop on an 8 GB box. The guard persists crash boots (boots NOT preceded by
// a graceful shutdown) and makes the server skip boot resume once
// CRASH_LOOP_THRESHOLD of them land inside CRASH_LOOP_WINDOW_MS. Graceful
// restarts (deploys) never count: they are exactly the case boot resume fixes.
describe("boot crash-loop guard (W2)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "boot-guard-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("first boot ever (no history) is not a crash loop", () => {
    expect(recordBootAndCheckCrashLoop(dir, 1_000).skipBootResume).toBe(false);
  });

  it("repeated graceful restarts never trip the guard — deploys must still resume sessions", () => {
    let t = 1_000;
    for (let i = 0; i < 10; i++) {
      expect(recordBootAndCheckCrashLoop(dir, t).skipBootResume).toBe(false);
      markCleanShutdown(dir);
      t += 4_000; // the 2026-10-16 06:12:57–06:13:06 restart burst
    }
  });

  it(`skips boot resume once ${CRASH_LOOP_THRESHOLD} crash boots land inside the window (OOM respawn loop)`, () => {
    // Boot 1 = initial start; every later boot follows a SIGKILL (no clean mark).
    let t = 1_000;
    const results: boolean[] = [];
    for (let i = 0; i < CRASH_LOOP_THRESHOLD + 2; i++) {
      results.push(recordBootAndCheckCrashLoop(dir, t).skipBootResume);
      t += 5_000; // RestartSec=5
    }
    // Crash boots #1..#(threshold-1) still resume; from the threshold on, skip.
    const expected = Array.from({ length: CRASH_LOOP_THRESHOLD + 2 }, (_, i) => i >= CRASH_LOOP_THRESHOLD);
    expect(results).toEqual(expected);
  });

  it("crash boots older than the window age out", () => {
    let t = 1_000;
    for (let i = 0; i < CRASH_LOOP_THRESHOLD + 1; i++) recordBootAndCheckCrashLoop(dir, (t += 1_000));
    expect(recordBootAndCheckCrashLoop(dir, t + 1_000).skipBootResume).toBe(true);
    // After a quiet window, one more crash is a single isolated crash again.
    expect(recordBootAndCheckCrashLoop(dir, t + CRASH_LOOP_WINDOW_MS + 60_000).skipBootResume).toBe(false);
  });

  it("a graceful shutdown in between resets nothing but is not itself counted", () => {
    recordBootAndCheckCrashLoop(dir, 1_000);
    recordBootAndCheckCrashLoop(dir, 2_000); // crash boot 1
    markCleanShutdown(dir);
    recordBootAndCheckCrashLoop(dir, 3_000); // clean → not counted
    const h = JSON.parse(readFileSync(join(dir, BOOT_HISTORY_FILE), "utf-8"));
    expect(h.crashBoots).toEqual([2_000]);
    expect(h.cleanShutdown).toBe(false);
  });

  it("a corrupt history file fails open (resume runs) and is rewritten", () => {
    writeFileSync(join(dir, BOOT_HISTORY_FILE), "{not json");
    expect(recordBootAndCheckCrashLoop(dir, 1_000).skipBootResume).toBe(false);
    expect(() => JSON.parse(readFileSync(join(dir, BOOT_HISTORY_FILE), "utf-8"))).not.toThrow();
  });
});

describe("gateBootResumeOnCrashLoop (W2 boot wiring)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "boot-gate-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("drains the boot-resume candidates in a crash loop and leaves them alone otherwise", () => {
    // index.ts calls this BEFORE orchestrator.initialize(); draining the
    // one-shot candidate list is what makes initialize() schedule nothing.
    const candidates = ["orch", "obs"];
    let drained = 0;
    const drain = () => {
      drained++;
      return candidates;
    };
    let t = 1_000;
    // First boot + (threshold - 1) crash boots: resume proceeds, nothing drained.
    for (let i = 0; i < CRASH_LOOP_THRESHOLD; i++) {
      expect(gateBootResumeOnCrashLoop(dir, drain, (t += 5_000))).toEqual([]);
    }
    expect(drained).toBe(0);
    // The threshold-th crash boot inside the window: skipped + drained.
    expect(gateBootResumeOnCrashLoop(dir, drain, (t += 5_000))).toEqual(["orch", "obs"]);
    expect(drained).toBe(1);
  });
});
