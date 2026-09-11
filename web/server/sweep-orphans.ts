// AURA-LOCAL — Council Plan "Sweep orphans" (manual cleanup engine).
//
// The on-demand sibling of `orphan-reaper.ts`. Reaps ONLY resources this
// server owns and lost: server-owned orphan CLI subprocesses, archived-leak
// processes, stale exited-session records, and orphaned per-session timers.
// NEVER a process this server did not spawn, NEVER the caller's own session,
// NEVER a live non-archived tracked session.
//
// Two structurally separate functions (ritchie §A): `computeSweepCandidates`
// is PURE (enumerate + classify + evidence, zero side effects) and backs the
// preview; `executeSweep` re-verifies and kills. There is no `dryRun` boolean
// threaded through a kill call, so preview can never accidentally execute.

import { createHash } from "node:crypto";
import type { SdkSessionInfo } from "./cli-launcher.js";
import { classifyArgv, splitCmdline } from "./orphan-reaper.js";
import { readRuntimeSidecar } from "./cli-runtime-sidecar.js";
import { reapPidWithSentinel, type ReapPidOptions } from "./cleanup/reap-pid.js";
import { readFileSync, readdirSync } from "node:fs";
import { log } from "./logger.js";

/** Default age below which a session/process is too fresh to be "stale". */
export const DEFAULT_SWEEP_AGE_MS = Number(process.env.AURA_SWEEP_AGE_MS) || 60 * 60 * 1000; // 1h

export type SweepReason = "orphan" | "archived-leak" | "stale-session" | "orphan-timer";

export interface SweepCandidate {
  /** Stable id: `${reason}:${pid ?? sessionId ?? timerId}`. Preview↔execute binding. */
  readonly id: string;
  readonly reason: SweepReason;
  readonly pid?: number;
  readonly sessionId?: string;
  /** argv SHA-256 captured at classify time — the TOCTOU anchor for orphan kills. */
  readonly argvSha256?: string;
  /** Human-readable, server-clock-sourced evidence (never a model self-report). */
  readonly evidence: string;
  readonly ageMs: number;
}

export interface OrphanTimerRef {
  readonly id: string;
  readonly sessionId?: string;
  readonly kind: string;
}

export interface SweepComputeDeps {
  /** All session records this server knows (archived + live). */
  readonly listSessions: () => SdkSessionInfo[];
  /** The requesting agent's own sessionId — excluded from every category. */
  readonly callerSessionId?: string | null;
  /** This server process's own pid — never a candidate. */
  readonly serverPid?: number;
  /** Root holding per-session runtime sidecars (argvSha256 ownership proof). */
  readonly sessionsRoot: string;
  readonly now?: () => number;
  readonly ageThresholdMs?: number;
  // ── proc/syscall seams (default to /proc + process.kill) ──
  readonly listProcPids?: () => number[];
  readonly readStat?: (pid: number) => string;
  readonly readCmdline?: (pid: number) => string;
  readonly killCheck?: (pid: number) => boolean;
  /**
   * argvSha256 → owning sessionId, built from the sidecars this server wrote.
   * A /proc process whose argv hash is NOT in this map was not spawned by us
   * and is never a candidate. Defaults to reading sidecars for known sessions.
   */
  readonly readOwnedArgvShas?: () => Map<string, string>;
  /** Orphaned per-session timers whose owning session is no longer live. */
  readonly listOrphanTimers?: () => OrphanTimerRef[];
}

function defListProcPids(): number[] {
  const out: number[] = [];
  for (const e of readdirSync("/proc", { withFileTypes: true })) {
    if (e.isDirectory() && /^[0-9]+$/.test(e.name)) out.push(parseInt(e.name, 10));
  }
  return out;
}
const defReadCmdline = (pid: number): string => readFileSync(`/proc/${pid}/cmdline`, "utf8");
const defKillCheck = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

/** Build the owned-argv map from the runtime sidecars of the server's sessions. */
function buildOwnedFromSidecars(sessions: SdkSessionInfo[], sessionsRoot: string): Map<string, string> {
  const owned = new Map<string, string>();
  for (const s of sessions) {
    try {
      const sc = readRuntimeSidecar(sessionsRoot, s.sessionId);
      if (sc.kind === "present" && sc.payload.argvSha256) owned.set(sc.payload.argvSha256, s.sessionId);
    } catch { /* corrupt/absent sidecar → this session contributes no ownership proof */ }
  }
  return owned;
}

/**
 * PURE. Enumerate every sweep candidate grouped by reason, with server-clock
 * evidence and zero side effects. Self / live-session / not-server-owned are
 * excluded up front as a set-difference, not a post-hoc filter (Task 3).
 */
export function computeSweepCandidates(deps: SweepComputeDeps): SweepCandidate[] {
  const now = (deps.now ?? Date.now)();
  const ageThreshold = deps.ageThresholdMs ?? DEFAULT_SWEEP_AGE_MS;
  const sessions = deps.listSessions();
  const listProc = deps.listProcPids ?? defListProcPids;
  const readCmdline = deps.readCmdline ?? defReadCmdline;
  const killCheck = deps.killCheck ?? defKillCheck;
  const owned = deps.readOwnedArgvShas?.() ?? buildOwnedFromSidecars(sessions, deps.sessionsRoot);

  // Up-front exclusion sets (Task 3 — assertions, not filters).
  const callerId = deps.callerSessionId ?? null;
  const callerPid = callerId
    ? sessions.find((s) => s.sessionId === callerId)?.pid
    : undefined;
  const excludePids = new Set<number>();
  if (typeof deps.serverPid === "number") excludePids.add(deps.serverPid);
  if (typeof callerPid === "number") excludePids.add(callerPid);
  // Every pid that is the CURRENT pid of ANY tracked session — archived or not,
  // in ANY state — is NOT an orphan. Non-archived sessions in a live-ish state
  // (connected/running, but ALSO `starting` after a WS-transport restart and
  // `reconnecting` inside the grace window) must be protected: a ppid==1
  // survivor in one of those states would otherwise pass reap-pid's TOCTOU gate
  // and be SIGTERMed — the AC3 "never a live non-archived session" violation.
  // Archived sessions' live pids ARE reaped, but through the archived-leak
  // branch below (tracked-kill, exit bookkeeping), so listing them here too
  // would double-target one process. A true orphan is an owned-argv pid that is
  // NOT any session's current pid (e.g. a relaunched session left its old pid
  // behind, or the owning record was removed).
  const trackedPids = new Set<number>();
  for (const s of sessions) {
    if (typeof s.pid === "number") trackedPids.add(s.pid);
  }

  const out: SweepCandidate[] = [];

  // ── Category 1: server-owned orphan subprocess ──
  let pids: number[] = [];
  try { pids = listProc(); } catch { pids = []; }
  for (const pid of pids) {
    if (excludePids.has(pid) || trackedPids.has(pid)) continue;
    let argv: string[];
    try { argv = splitCmdline(readCmdline(pid)); } catch { continue; }
    if (argv.length === 0) continue;
    const cls = classifyArgv(argv);
    if (!cls.isCompanionShape) continue;
    const ownerSid = owned.get(cls.argvSha256);
    if (!ownerSid) continue; // not spawned by us → never a candidate
    out.push({
      id: `orphan:${pid}`,
      reason: "orphan",
      pid,
      sessionId: ownerSid,
      argvSha256: cls.argvSha256,
      evidence: "argv matches a server-written sidecar; pid is not a live tracked session",
      ageMs: 0,
    });
  }

  // ── Category 2/3: session-record-driven ──
  for (const s of sessions) {
    if (s.sessionId === callerId) continue; // never the caller
    const age = now - (s.createdAt ?? now);
    // Archived-leak: archived session whose CLI process is still alive.
    if (s.archived && typeof s.pid === "number" && age > ageThreshold) {
      if (killCheck(s.pid)) {
        out.push({
          id: `archived-leak:${s.sessionId}`,
          reason: "archived-leak",
          pid: s.pid,
          sessionId: s.sessionId,
          evidence: `archived session, pid ${s.pid} still alive, age ${Math.round(age / 1000)}s`,
          ageMs: age,
        });
      }
      continue;
    }
    // Stale-session: an exited (definitively not-live) record left old on disk.
    if (!s.archived && s.state === "exited" && age > ageThreshold) {
      const pidAlive = typeof s.pid === "number" && killCheck(s.pid);
      out.push({
        id: `stale-session:${s.sessionId}`,
        reason: "stale-session",
        pid: pidAlive ? s.pid : undefined,
        sessionId: s.sessionId,
        evidence: `state=exited, age ${Math.round(age / 1000)}s${pidAlive ? `, leaked pid ${s.pid}` : ""}`,
        ageMs: age,
      });
    }
  }

  // ── Category 4: orphaned timers ──
  for (const t of deps.listOrphanTimers?.() ?? []) {
    out.push({
      id: `orphan-timer:${t.id}`,
      reason: "orphan-timer",
      sessionId: t.sessionId,
      evidence: `${t.kind} timer with no live owning session`,
      ageMs: 0,
    });
  }

  // Safety assertion (Task 3): caller/server pids must be absent.
  for (const c of out) {
    if (typeof c.pid === "number" && excludePids.has(c.pid)) {
      throw new Error(`sweep candidate ${c.id} includes an excluded pid ${c.pid} — aborting`);
    }
    if (c.sessionId && c.sessionId === callerId) {
      throw new Error(`sweep candidate ${c.id} is the caller's own session — aborting`);
    }
  }
  return out;
}

/** Deterministic token binding a preview to its candidate set (hunt Principle 7). */
export function sweepPreviewToken(candidates: SweepCandidate[]): string {
  const ids = candidates.map((c) => c.id).sort();
  return createHash("sha256").update(ids.join("\n")).digest("hex").slice(0, 16);
}

export interface SweepExecuteDeps {
  readonly sentinelRoot: string;
  /** Kill a tracked session through the launcher's bookkeeping (recording close + store write). */
  readonly killTrackedSession: (sessionId: string) => Promise<void> | void;
  /** Clear an orphaned timer via the orchestrator's own teardown. */
  readonly clearOrphanTimer?: (timerId: string) => Promise<void> | void;
  /** Append a structured audit entry (JSONL). */
  readonly audit?: (entry: SweepAuditEntry) => void;
  /** reap-pid syscall/clock seam (tests inject; production uses /proc + process.kill). */
  readonly reapSeam?: Partial<Pick<ReapPidOptions, "kill" | "killCheck" | "readStat" | "readCmdline" | "sleep" | "now" | "graceMs" | "pollMs">>;
}

export interface SweepAuditEntry {
  readonly event: "sweep.candidate";
  readonly outcome: "killed" | "already-gone" | "skipped-drift" | "skipped-error" | "timer-cleared" | "session-killed";
  readonly reason: SweepReason;
  readonly pid?: number;
  readonly sessionId?: string;
  readonly ts: number;
}

export interface SweepExecuteResult {
  readonly requested: number;
  readonly swept: number;
  readonly skipped: number;
  readonly perReason: Record<SweepReason, number>;
}

/**
 * Execute the sweep on a candidate set. Each pid-bearing candidate is killed
 * via the shared sentinel/TOCTOU helper (`orphan`) or the launcher's tracked
 * kill (`archived-leak`/`stale-session` — closes recording + store); timers
 * go through the orchestrator teardown. Idempotent and safe on an empty set.
 */
export async function executeSweep(candidates: SweepCandidate[], deps: SweepExecuteDeps): Promise<SweepExecuteResult> {
  const perReason: Record<SweepReason, number> = {
    "orphan": 0, "archived-leak": 0, "stale-session": 0, "orphan-timer": 0,
  };
  let swept = 0;
  let skipped = 0;

  for (const c of candidates) {
    const audit = (outcome: SweepAuditEntry["outcome"]) =>
      deps.audit?.({ event: "sweep.candidate", outcome, reason: c.reason, pid: c.pid, sessionId: c.sessionId, ts: Date.now() });
    try {
      if (c.reason === "orphan" && typeof c.pid === "number" && c.argvSha256) {
        const outcome = await reapPidWithSentinel(c.pid, {
          sentinelRoot: deps.sentinelRoot,
          reason: c.reason,
          expectedArgvSha256: c.argvSha256,
          ...(deps.reapSeam ?? {}),
        });
        if (outcome === "reaped" || outcome === "already-gone") { swept++; perReason[c.reason]++; audit(outcome === "reaped" ? "killed" : "already-gone"); }
        else { skipped++; audit(outcome === "aborted-drift" ? "skipped-drift" : "skipped-error"); }
      } else if ((c.reason === "archived-leak" || c.reason === "stale-session") && c.sessionId) {
        await deps.killTrackedSession(c.sessionId);
        swept++; perReason[c.reason]++; audit("session-killed");
      } else if (c.reason === "orphan-timer") {
        await deps.clearOrphanTimer?.(c.id.replace(/^orphan-timer:/, ""));
        swept++; perReason[c.reason]++; audit("timer-cleared");
      } else {
        skipped++; audit("skipped-error");
      }
    } catch (e) {
      skipped++;
      log.warn("sweep-orphans", "candidate execute failed", {
        event: "sweep.candidate_failed", reason: c.reason, pid: c.pid, sessionId: c.sessionId,
        error: e instanceof Error ? e.message : String(e),
      });
      audit("skipped-error");
    }
  }
  return { requested: candidates.length, swept, skipped, perReason };
}
