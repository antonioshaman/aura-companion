/**
 * Process plumbing for the AuraBench harness: an async `nice -n 10` spawn with
 * a wall-clock timeout that kills the whole process group (agents spawn test
 * runners, dev servers, …), and the scrubbed child environment.
 *
 * Firewall-clean. Tested: `benchChildEnv`, the live-child registry (proc.test.ts).
 */

import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import type { AsyncExec, ExecResult } from "./run-cell.js";

/**
 * Child env: every `AURA_*` removed (RUNBOOK §1.5), and the variables that
 * would tie a child to THIS process's agent/Companion session
 * (`CLAUDECODE`, `CLAUDE_CODE_*`, `COMPANION_*`, `CODEX_*` thread vars) —
 * a bench agent must not believe it is nested inside another session.
 * `extra` is applied last.
 */
export function benchChildEnv(
  base: Record<string, string | undefined>,
  extra: Record<string, string> = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    if (k.startsWith("AURA_") || k.startsWith("COMPANION_") || k.startsWith("CLAUDE_CODE_")) continue;
    if (k === "CLAUDECODE" || k === "CLAUDE_CONFIG_DIR" || k.startsWith("CODEX_")) continue;
    env[k] = v;
  }
  env.NODE_OPTIONS = "--max-old-space-size=2560";
  env.CI = "1";
  return { ...env, ...extra };
}

export interface SpawnOptions {
  cwd: string;
  timeoutMs: number;
  env?: Record<string, string>;
  /** Tee stdout / stderr to these files (raw transcripts). */
  stdoutFile?: string;
  stderrFile?: string;
  /** Cap on the in-memory copy returned in `output` (the files keep everything). */
  maxBufferBytes?: number;
}

export interface SpawnResult extends ExecResult {
  stdout: string;
  stderr: string;
}

/** Process groups of agents/tools spawned by {@link spawnNice} that have not exited yet. */
const liveGroups = new Map<number, Promise<void>>();

/** How many spawned process groups are still running. */
export const liveChildCount = () => liveGroups.size;

/** SIGKILL every live spawned process group now. */
export function killLiveChildren(sig: NodeJS.Signals = "SIGKILL"): void {
  for (const pid of liveGroups.keys()) {
    try {
      process.kill(-pid, sig);
    } catch {
      // already gone
    }
  }
}

/**
 * SIGTERM every live spawned process group, wait up to `graceMs` for them to
 * exit, SIGKILL the rest and wait (bounded) again. Used by the signal handler
 * before cell homes are released (FIX-D2-1c).
 */
export async function stopLiveChildren(graceMs = 10_000): Promise<void> {
  const waitAll = (ms: number) =>
    Promise.race([
      Promise.allSettled([...liveGroups.values()]).then(() => undefined),
      new Promise<void>((r) => setTimeout(r, ms).unref()),
    ]);
  if (!liveGroups.size) return;
  killLiveChildren("SIGTERM");
  await waitAll(graceMs);
  if (!liveGroups.size) return;
  killLiveChildren("SIGKILL");
  await waitAll(5_000);
}

export function spawnNice(cmd: string, args: string[], o: SpawnOptions): Promise<SpawnResult> {
  const max = o.maxBufferBytes ?? 64 * 1024 * 1024;
  return new Promise((resolvePromise) => {
    const child = spawn("nice", ["-n", "10", cmd, ...args], {
      cwd: o.cwd,
      env: o.env ?? benchChildEnv(process.env),
      detached: true, // own process group → the timeout kills the whole tree
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out = o.stdoutFile ? createWriteStream(o.stdoutFile) : null;
    const err = o.stderrFile ? createWriteStream(o.stderrFile) : null;
    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", (b: Buffer) => {
      out?.write(b);
      if (stdout.length < max) stdout += b.toString("utf8");
    });
    child.stderr!.on("data", (b: Buffer) => {
      err?.write(b);
      if (stderr.length < max) stderr += b.toString("utf8");
    });
    let timedOut = false;
    const killGroup = (sig: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, sig);
      } catch {
        // already gone
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup("SIGTERM");
      setTimeout(() => killGroup("SIGKILL"), 10_000).unref();
    }, o.timeoutMs);
    let exited: () => void = () => {};
    const pid = child.pid;
    if (pid) liveGroups.set(pid, new Promise<void>((r) => (exited = r)));
    const done = (code: number) => {
      if (pid) liveGroups.delete(pid);
      exited();
      clearTimeout(timer);
      out?.end();
      err?.end();
      resolvePromise({ code, output: stdout + stderr, stdout, stderr, timedOut });
    };
    child.on("error", (e) => {
      stderr += String(e);
      done(127);
    });
    child.on("close", (code) => done(code ?? 1));
  });
}

/** {@link AsyncExec} over {@link spawnNice} (git, bun, vitest). */
export const niceExec: AsyncExec = (cmd, args, { cwd, timeoutMs, env }) =>
  spawnNice(cmd, args, { cwd, timeoutMs, env: env ?? benchChildEnv(process.env), maxBufferBytes: 8 * 1024 * 1024 });
