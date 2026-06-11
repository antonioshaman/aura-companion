// AURA-LOCAL
// PTY-terminal orphan reaper — resource-reclamation plan Task 3 (sibling of
// `orphan-reaper.ts`). Runs at server-init AND as a periodic reconcile.
//
// Why: PTY terminals (`terminal-manager.ts`) live in an in-memory `instances`
// Map keyed by `randomUUID()`. That Map dies with the bun parent, so after a
// `KillMode=process` restart the spawned shell (host) or `docker exec` client
// (docker, FLAG B) survives — reparented to init — with NO in-process record.
// The 5s in-memory `orphanTimer` that would have reaped a browserless terminal
// is gone. Result: one leaked host process per restart per open terminal.
//
// Unlike the session orphan reaper (`orphan-reaper.ts`), terminals carry NO
// identifying token in their argv — a `[bash, -l]` shell looks like any login
// shell. The provenance therefore lives in the sidecar
// (`<terminalId>.terminal.json`), and the reaper enumerates SIDECARS, not
// `/proc`. The sidecar's `argvSha256` + `processStartMs` are the identity
// anchors: `verifyProcessIdentityByArgv` recomputes the argv hash from
// `/proc/<pid>/cmdline` and the kernel starttime from `/proc/<pid>/stat`, so
// a reaped pid is provably the one WE spawned (FLAG A keystone — the argv
// predicate is the generalized factor 2).
//
// Verdict → action:
//   match       → STRANDED live terminal we own → REAP (sentinel-before-sweep,
//                 SIGTERM only) → delete sidecar.
//   gone        → process already exited → delete the now-stale sidecar; no kill.
//   mismatch    → the pid was reused by an unrelated process → DO NOT kill;
//                 delete the stale sidecar so it stops driving reap decisions.
//   unavailable → non-Linux dev host → whole pass is a no-op; sidecars untouched.
//
// EC-7: every sidecar fs touch routes through the sidecar module's
// `resolveCleanupPath`-backed helpers; every `/proc` read is bounded by the
// kernel (numeric pid). EC-8: `.reaping/<pid>.json` written BEFORE SIGTERM,
// deleted AFTER confirmed exit. SIGTERM-only — stragglers wait for the next
// pass (no inline SIGKILL, mirrors orphan-reaper's readiness-budget posture).

import { platform as osPlatform } from "node:os";
import { log } from "./logger.js";
import { verifyProcessIdentityByArgv, type ProcessIdentityResult } from "./process-identity.js";
import { ageMs, nowMs } from "./cleanup/age-ms.js";
import { writeReapingMarker, deleteReapingMarker } from "./cleanup/sentinel-markers.js";
import { recordCleanupEvent } from "./cleanup/cleanup-events.js";
import {
  argvSha256,
  listTerminalSidecarIds,
  readTerminalSidecar,
  deleteTerminalSidecar,
  type TerminalSidecarResult,
} from "./terminal-runtime-sidecar.js";

/** Hard cap on the pass — preserves the systemd readiness window at boot. */
export const TERMINAL_REAPER_BUDGET_MS = 5_000;

/** Per-process wait-for-exit budget after SIGTERM (SIGTERM-only; stragglers
 *  handled by the next pass). */
const REAP_POST_TERM_GRACE_MS = 1_500;

/** Per-process poll interval while waiting for SIGTERM-driven exit. */
const REAP_POLL_INTERVAL_MS = 100;

/**
 * Dependency seam. Production wiring binds these to the sidecar module +
 * sentinel-markers + `process.kill` + the real identity verifier; tests
 * inject pure stubs.
 */
export interface TerminalReaperDeps {
  /** Where `<terminalId>.terminal.json` sidecars live. */
  readonly terminalsRoot: string;
  /** Filesystem root for the `.reaping/<pid>.json` sentinel. */
  readonly sentinelRoot: string;
  /**
   * Predicate: is this terminalId still owned by the CURRENT process? At
   * boot the in-memory Map is empty (always false); a periodic reconcile
   * passes `manager.has(id)` so live terminals — covered by their own
   * orphanTimer — are never reaped out from under the running server.
   */
  readonly isLocallyTracked?: (terminalId: string) => boolean;
  /** Test seam — enumerate sidecar ids. */
  readonly listSidecarIds?: (root: string) => string[];
  /** Test seam — read one sidecar. */
  readonly readSidecar?: (root: string, id: string) => TerminalSidecarResult;
  /** Test seam — delete one sidecar. */
  readonly deleteSidecar?: (root: string, id: string) => void;
  /** Test seam — the identity verifier. */
  readonly verify?: (
    pid: number,
    argvMatches: (tokens: string[]) => boolean,
    expectedStartMs: number | null,
  ) => ProcessIdentityResult;
  /** Test seam — liveness probe via process.kill(pid, 0). */
  readonly killCheck?: (pid: number) => boolean;
  /** Test seam — process.kill(pid, "SIGTERM"). */
  readonly kill?: (pid: number, signal: "SIGTERM") => void;
  /** Test seam — sentinel writer. */
  readonly writeMarker?: (root: string, pid: number, payload: { pid: number; decisionTs: number; reason: string }) => void;
  /** Test seam — sentinel deleter. */
  readonly deleteMarker?: (root: string, pid: number) => void;
  /** Test seam — platform detection (defaults to os.platform()). */
  readonly platform?: () => NodeJS.Platform;
  /** Test seam — budget cap override. */
  readonly budgetMs?: number;
  /** Test seam — sleep impl. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Test seam — clock reader. */
  readonly now?: () => number;
}

/** Outcome summary — returned for the boot diagnostic + periodic-reconcile log. */
export interface TerminalReapSummary {
  readonly platform: NodeJS.Platform;
  /** Sidecars enumerated this pass. */
  readonly scannedSidecars: number;
  /** Stranded live terminals SIGTERMed. */
  readonly reaped: number;
  /** Stale sidecars pruned for already-dead processes (`gone`). */
  readonly prunedGone: number;
  /** Stale sidecars pruned because the pid was reused (`mismatch`). */
  readonly prunedReused: number;
  /** Live terminals skipped because the current process still owns them. */
  readonly skippedTracked: number;
  /** Reaps where SIGTERM threw a non-ESRCH error (e.g. EPERM) — process survives. */
  readonly killFailed: number;
  /** Corrupt/absent sidecars skipped without action. */
  readonly skippedUnreadable: number;
  readonly budgetExceeded: boolean;
  readonly durationMs: number;
}

function emptySummary(platform: NodeJS.Platform, durationMs: number): TerminalReapSummary {
  return {
    platform,
    scannedSidecars: 0,
    reaped: 0,
    prunedGone: 0,
    prunedReused: 0,
    skippedTracked: 0,
    killFailed: 0,
    skippedUnreadable: 0,
    budgetExceeded: false,
    durationMs,
  };
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
  // PURE syscall — NEVER `Bun.spawn(["pkill"])` / `exec` / `shell:true`. The
  // signal name is a fixed literal; argv shape `(number, "SIGTERM")` makes
  // command injection structurally impossible.
  process.kill(pid, signal);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Reap PTY terminals stranded across a server restart. Enumerates the sidecar
 * directory, verifies each pid's identity against its stored anchor, and acts
 * per the verdict table above. Never throws — every fs/proc/kill error is
 * caught at the per-terminal boundary. Returns a summary for the boot log.
 */
export async function reapStrandedTerminals(
  deps: TerminalReaperDeps,
): Promise<TerminalReapSummary> {
  const platform = (deps.platform ?? osPlatform)();
  const clock = deps.now ?? nowMs;
  const startedAt = clock();

  if (platform !== "linux") {
    log.warn("terminal-reaper", "reapStrandedTerminals skipped — /proc unavailable on non-Linux", {
      event: "terminal_reaper.unavailable",
      platform,
    });
    return emptySummary(platform, ageMs(startedAt, clock()));
  }

  const budgetMs = deps.budgetMs ?? TERMINAL_REAPER_BUDGET_MS;
  const listIds = deps.listSidecarIds ?? listTerminalSidecarIds;
  const readOne = deps.readSidecar ?? readTerminalSidecar;
  const deleteOne = deps.deleteSidecar ?? deleteTerminalSidecar;
  const verify = deps.verify ?? verifyProcessIdentityByArgv;
  const killCheck = deps.killCheck ?? defaultKillCheck;
  const kill = deps.kill ?? defaultKill;
  const writeMarker = deps.writeMarker ?? writeReapingMarker;
  const deleteMarker = deps.deleteMarker ?? deleteReapingMarker;
  const sleep = deps.sleep ?? defaultSleep;
  const isTracked = deps.isLocallyTracked ?? (() => false);

  let ids: string[];
  try {
    ids = listIds(deps.terminalsRoot);
  } catch (e) {
    log.warn("terminal-reaper", "sidecar enumeration failed — skipping pass", {
      event: "terminal_reaper.enum_failed",
      error_code: (e as NodeJS.ErrnoException).code ?? "unknown",
    });
    return emptySummary(platform, ageMs(startedAt, clock()));
  }

  let scanned = 0;
  let reaped = 0;
  let prunedGone = 0;
  let prunedReused = 0;
  let skippedTracked = 0;
  let killFailed = 0;
  let skippedUnreadable = 0;
  let budgetExceeded = false;

  for (const terminalId of ids) {
    if (ageMs(startedAt, clock()) > budgetMs) {
      log.warn("terminal-reaper", "budget exceeded — deferring remaining terminals to next pass", {
        event: "terminal_reaper.budget_exceeded",
        scanned,
        reaped,
      });
      budgetExceeded = true;
      break;
    }

    // Owned by the running server → its in-memory orphanTimer covers it.
    if (isTracked(terminalId)) {
      skippedTracked++;
      continue;
    }

    // Per-terminal boundary (honours the "Never throws" contract above). The
    // inner blocks guard the read/sentinel/SIGTERM paths individually; this
    // outer catch covers the residual throwers — chiefly the verdict-branch
    // `deleteOne` prunes, which rethrow every non-ENOENT errno (EACCES/EROFS/
    // ELOOP/EC-7 bounds violation). One un-prunable sidecar must degrade to a
    // skip, not abort the whole pass (and, via the scheduler, crash boot).
    try {
    let sidecar: TerminalSidecarResult;
    try {
      sidecar = readOne(deps.terminalsRoot, terminalId);
    } catch (e) {
      // Corrupt-but-present sidecar throws by contract. We cannot trust its
      // pid to drive a kill, so leave it for an operator + skip.
      skippedUnreadable++;
      log.warn("terminal-reaper", "sidecar read failed — skipping terminal", {
        event: "terminal_reaper.sidecar_unreadable",
        error_code: (e as NodeJS.ErrnoException).code ?? "unknown",
      });
      continue;
    }
    if (sidecar.kind === "absent") {
      // Raced with a concurrent delete (clean teardown) — nothing to do.
      continue;
    }
    scanned++;

    const { pid, processStartMs, argvSha256: expectedSha, kind } = sidecar.payload;
    const verdict = verify(
      pid,
      (tokens) => argvSha256(tokens) === expectedSha,
      processStartMs,
    );

    if (verdict.kind === "gone") {
      // Process exited cleanly without deleting its sidecar (the bun parent
      // died first). Prune the stale provenance; no kill.
      deleteOne(deps.terminalsRoot, terminalId);
      prunedGone++;
      log.info("terminal-reaper", "pruned sidecar for exited terminal", {
        event: "terminal_reaper.pruned_gone",
        pid,
        kind,
      });
      continue;
    }

    if (verdict.kind === "mismatch") {
      // The pid is alive but is NOT the process we spawned (argv hash or
      // starttime drift = PID reuse). Killing it would hit an innocent
      // bystander. Prune the stale sidecar and move on.
      deleteOne(deps.terminalsRoot, terminalId);
      prunedReused++;
      log.warn("terminal-reaper", "pid reused by unrelated process — pruning stale sidecar", {
        event: "terminal_reaper.pruned_reused",
        pid,
        kind,
        reason: verdict.reason,
      });
      continue;
    }

    if (verdict.kind === "unavailable") {
      // Shouldn't reach here (platform-gated above) but fail-safe: leave it.
      continue;
    }

    // verdict.kind === "match" — a stranded terminal we own. REAP it.
    //
    // FLAG B (docker): for a `kind === "docker"` terminal, `pid` is the
    // host-side `docker exec` client, NOT the in-container shell. SIGTERMing
    // the host client is sufficient to release the host resource we leaked —
    // the in-container shell is the container's lifecycle problem, reaped on
    // container teardown. We deliberately do NOT shell out to
    // `docker exec <id> kill` (fragile, out of scope). Same kill path for
    // both kinds; `kind` only colours the sentinel reason + logs.
    //
    // Sentinel-before-sweep (EC-8).
    try {
      writeMarker(deps.sentinelRoot, pid, { pid, decisionTs: clock(), reason: `terminal_${kind}` });
    } catch (e) {
      log.warn("terminal-reaper", "sentinel write failed — skipping SIGTERM", {
        event: "terminal_reaper.sentinel_write_failed",
        pid,
        error_code: (e as NodeJS.ErrnoException).code ?? "unknown",
      });
      continue;
    }

    let killOk = false;
    let killAlreadyGone = false;
    try {
      kill(pid, "SIGTERM");
      killOk = true;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ESRCH") {
        killAlreadyGone = true;
      } else {
        killFailed++;
        log.warn("terminal-reaper", "SIGTERM failed", {
          event: "terminal_reaper.kill_failed",
          pid,
          kind,
          error_code: code ?? "unknown",
        });
      }
    }

    if (killOk) {
      const exitDeadline = clock() + REAP_POST_TERM_GRACE_MS;
      while (clock() < exitDeadline) {
        if (!killCheck(pid)) break;
        // eslint-disable-next-line no-await-in-loop
        await sleep(REAP_POLL_INTERVAL_MS);
      }
    }

    if (killOk || killAlreadyGone) {
      reaped++;
      // EC-21: single counter source — the metrics projection
      // `getTerminalReapedLastHour` reads this same store.
      recordCleanupEvent("terminal_reaped");
      deleteOne(deps.terminalsRoot, terminalId);
      log.info("terminal-reaper", "stranded terminal reaped via SIGTERM", {
        event: "terminal_reaped",
        pid,
        kind,
      });
    }

    // Cleanup the sentinel — best-effort; ENOENT silent.
    deleteMarker(deps.sentinelRoot, pid);
    } catch (e) {
      // Residual unexpected error (e.g. a non-ENOENT prune/sentinel-delete
      // failure). Degrade to a counted skip so one bad terminal can never
      // abort the pass or reject the reconcile.
      skippedUnreadable++;
      log.warn("terminal-reaper", "unexpected per-terminal error — skipping", {
        event: "terminal_reaper.terminal_error",
        error_code: (e as NodeJS.ErrnoException).code ?? "unknown",
      });
      continue;
    }
  }

  const durationMs = ageMs(startedAt, clock());
  log.info("terminal-reaper", "terminal reap pass complete", {
    event: "terminal_reaper.complete",
    scanned,
    reaped,
    prunedGone,
    prunedReused,
    skippedTracked,
    killFailed,
    skippedUnreadable,
    budgetExceeded,
    durationMs,
  });

  return {
    platform,
    scannedSidecars: scanned,
    reaped,
    prunedGone,
    prunedReused,
    skippedTracked,
    killFailed,
    skippedUnreadable,
    budgetExceeded,
    durationMs,
  };
}
