// AURA-LOCAL
// PPID=1 orphan reaper — runs ONCE at server-init AFTER the orchestrator/
// bridge finish wiring and BEFORE the idle-timer manager arms. PLAN task T8.
//
// Why: production symptom — 5 live `claude --sdk-url` subprocesses with
// PIDs that don't match ANY Map `pid` field. They survived a bun-parent
// restart under `KillMode=process` (the recommended systemd policy) and
// are now reparented to init (ppid=1). Without a reaper:
//   * The boot probe (cli-launcher restoreFromDisk) sees `state="exited"`
//     for these sessions because their PIDs don't reconcile, then the
//     auto-relaunch loop spawns a SECOND CLI for the same Companion
//     sessionId. The original orphan keeps hogging memory until the
//     cgroup hits memory.high and the bun event loop stalls.
//   * Even when boot recovery does NOT relaunch, an orphan whose
//     companion-side state is gone (archived, evicted) is structurally
//     unreapable through normal session lifecycle.
//
// The reaper has two branches:
//
//   RE-ATTACH (Subprocess R5 — PURE Map mutation, NEVER respawn, NEVER
//   inject a synthetic init frame): orphan's argv matches a known
//   Companion session, `verifyProcessIdentity` returns `"match"` →
//   update `info.pid = orphanPid`. The orphan's WebSocket already
//   reconnected via `KillMode=process`; injecting a synthetic init or
//   re-issuing `--resume` would CONTAMINATE the recording corpus with
//   a server-fabricated frame indistinguishable from a real CLI
//   handshake. Hands-off mutation is the floor.
//
//   REAP: orphan has no matching Companion session, OR matches but the
//   verdict is `mismatch | gone`. Write `.reaping/<pid>.json` sentinel
//   (sentinel-markers.ts from Phase B — EC-8 sentinel-before-sweep) →
//   `process.kill(pid, "SIGTERM")` via pure syscall (NEVER `Bun.spawn(["pkill"])`
//   / `exec` / `shell:true` — Hunt R2) → wait for exit (bounded) →
//   delete the sentinel. SIGTERM only — DO NOT escalate to SIGKILL
//   inline (Backend-TS R11 / Subprocess R3 resolution: stragglers
//   handled by the next-boot reaper. Inline escalation would risk
//   blocking init past the systemd readiness budget).
//
// EC-7 (filesystem-access predicates inline path resolution or route
// through a resolving wrapper): every `/proc` read AND every sentinel
// fs touch routes through a resolver. `/proc` is bounded by the
// kernel (numeric pid → /proc/<pid>/...) so the wrapper is trivial,
// but the discipline is documented at the seam so a future refactor
// doesn't accidentally accept caller-supplied path components.
//
// EC-23 (filesystem paths in log payloads MUST be (present, depth)
// pair, SHA, or sentinel — NEVER raw path bytes): `orphan_reaped` and
// `orphan_reattached` log payloads expose
//   { pid, argvSha256, argvShape, cwdDepth, sessionIdPresent }
// with argv tokens categorised into shape labels (`<URL>`, `<PATH>`,
// `<TOKEN>`) — never raw bytes. Raw argv only goes to
// `~/.companion/orphan-reaped-debug.jsonl` mode 0600, gated on
// `COMPANION_LOG_PATHS_RAW=1`. This sidecar log is operator-opt-in
// for forensic triage; production deployments leave it off.
//
// Budget: hard cap 5s. Beyond that, log `orphan_reaper.budget_exceeded`
// WARN and return — un-classified orphans wait for next boot. The cap
// preserves the systemd readiness window (default 10s) so a misbehaving
// /proc snapshot (host with thousands of zombie processes) doesn't
// brick startup.

import { existsSync, readdirSync, readFileSync, appendFileSync, mkdirSync } from "node:fs";
import { homedir, platform as osPlatform } from "node:os";
import { join } from "node:path";
import { log } from "./logger.js";
import { verifyProcessIdentity } from "./process-identity.js";
import {
  argvSha256 as computeArgvSha,
  readRuntimeSidecar,
} from "./cli-runtime-sidecar.js";
import {
  writeReapingMarker,
  deleteReapingMarker,
} from "./cleanup/sentinel-markers.js";
import { ageMs, nowMs } from "./cleanup/age-ms.js";

/** Hard cap on reaper total work — preserves systemd readiness window. */
export const REAPER_BUDGET_MS = 5_000;

/** Per-process wait-for-exit budget after SIGTERM (SIGTERM-only at init
 *  per Backend-TS R11 / Subprocess R3; stragglers handled by next boot). */
const REAP_POST_TERM_GRACE_MS = 1_500;

/** Per-process poll interval while waiting for SIGTERM-driven exit. */
const REAP_POLL_INTERVAL_MS = 100;

/**
 * Loaded session shape the reaper consults — narrow subset of the
 * launcher's `SdkSessionInfo`, fields the reaper actually reads + mutates.
 * Decouples this module from the launcher's larger type so a future
 * sidecar-only callable signature doesn't churn.
 */
export interface ReaperKnownSession {
  sessionId: string;
  pid?: number;
}

/**
 * Reaper dependency seam. Production wiring binds these to
 * `node:fs` + `process.kill`; tests inject pure stubs.
 *
 * The boundary lives here so the reaper itself is platform-free —
 * the `unavailable` branch is the only path that reads the real
 * platform; everything else routes through these stubs.
 */
export interface OrphanReaperDeps {
  /** Companion-known sessions. The reaper MUTATES `pid` on match. */
  readonly loadedSessions: ReaperKnownSession[];
  /**
   * Filesystem root for the `.reaping/<pid>.json` sentinel. Typically
   * the session-store directory; tests pass a tmpdir.
   */
  readonly sentinelRoot: string;
  /**
   * Session-store directory for sidecar reads. Production wiring
   * matches `sentinelRoot`; tests can split them.
   */
  readonly sessionsRoot: string;
  /** Test seam — enumerate candidate pids. */
  readonly listProcPids?: () => number[];
  /** Test seam — read /proc/<pid>/stat. */
  readonly readStat?: (pid: number) => string;
  /** Test seam — read /proc/<pid>/cmdline. */
  readonly readCmdline?: (pid: number) => string;
  /** Test seam — kill check via process.kill(pid, 0). */
  readonly killCheck?: (pid: number) => boolean;
  /** Test seam — process.kill(pid, "SIGTERM"). */
  readonly kill?: (pid: number, signal: "SIGTERM") => void;
  /** Test seam — platform detection (defaults to os.platform()). */
  readonly platform?: () => NodeJS.Platform;
  /** Test seam — budget cap override. Defaults to REAPER_BUDGET_MS. */
  readonly budgetMs?: number;
  /** Test seam — sleep impl (Promise<void>). */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Test seam — clock reader. */
  readonly now?: () => number;
}

/**
 * Outcome summary — returned for diagnostics + the HANDOFF probe.
 *
 * `scannedPids` is the count of PPID=1 candidates that crossed the
 * argv-shape filter — useful for sanity-checking the dev host's
 * `/proc` baseline.
 *
 * `budgetExceeded` flips true on the 5s timeout; the caller logs
 * it as a WARN. Phase F's drain dispatch may consume this for a
 * delayed sweep, but the foundation-PR contract is: log + continue.
 */
export interface ReapSummary {
  readonly platform: NodeJS.Platform;
  readonly scannedPids: number;
  readonly reattached: number;
  readonly reaped: number;
  readonly skippedNoSessionMatch: number;
  readonly budgetExceeded: boolean;
  readonly durationMs: number;
}

/** Internal: argv classification output. */
interface ArgvClassification {
  /** Whether the argv shape looks like a Companion-spawned CLI. */
  readonly isCompanionShape: boolean;
  /** Extracted `sessionId` from the --sdk-url URL path (Claude). */
  readonly sessionId: string | null;
  /** Categorical argv shape for EC-23 redacted logging. */
  readonly argvShape: string[];
  /** SHA-256 of NUL-joined argv (matches cmdline format). */
  readonly argvSha256: string;
  /** Cwd depth — categorical replacement for raw path bytes. */
  readonly cwdDepth: number;
}

/**
 * Reap PPID=1 orphan CLI processes. Runs ONCE at server-init.
 *
 * The caller wires this between `orchestrator.initialize()` and
 * `idleTimerManager.arm()` in `index.ts` so:
 *   1. The orchestrator's `restoreFromDisk` already populated the
 *      `loadedSessions` map — the reaper has a complete view.
 *   2. The idle-timer manager hasn't armed yet — re-attaching a
 *      session's pid doesn't trigger a spurious idle-kill.
 *
 * Returns a `ReapSummary` for the boot diagnostic log. Never throws —
 * every fs/proc/kill error is caught at the per-pid boundary and
 * logged with EC-23-redacted context.
 */
export async function reapOrphans(deps: OrphanReaperDeps): Promise<ReapSummary> {
  const platform = (deps.platform ?? osPlatform)();
  const startedAt = (deps.now ?? nowMs)();

  if (platform !== "linux") {
    // macOS / Windows / BSD dev hosts: /proc is unavailable or has a
    // different shape. WARN once and degrade gracefully — the symptom
    // this reaper closes (PPID=1 reparented CLI orphans) is a Linux
    // production-host phenomenon, not a dev-loop issue.
    log.warn("orphan-reaper", "reapOrphans skipped — /proc unavailable on non-Linux", {
      event: "orphan_reaper.unavailable",
      platform,
    });
    return {
      platform,
      scannedPids: 0,
      reattached: 0,
      reaped: 0,
      skippedNoSessionMatch: 0,
      budgetExceeded: false,
      durationMs: ageMs(startedAt, deps.now?.()),
    };
  }

  const budgetMs = deps.budgetMs ?? REAPER_BUDGET_MS;
  const listProc = deps.listProcPids ?? defaultListProcPids;
  const readStat = deps.readStat ?? defaultReadStat;
  const readCmdline = deps.readCmdline ?? defaultReadCmdline;
  const killCheck = deps.killCheck ?? defaultKillCheck;
  const kill = deps.kill ?? defaultKill;
  const sleep = deps.sleep ?? defaultSleep;
  const clock = deps.now ?? nowMs;

  // Build O(1) lookup map for the argv-extracted sessionId → known
  // SdkSessionInfo reference. Mutating `pid` on the reference in the
  // RE-ATTACH branch propagates back to the launcher's internal map
  // because both hold references to the same object.
  const knownById = new Map<string, ReaperKnownSession>();
  for (const s of deps.loadedSessions) {
    knownById.set(s.sessionId, s);
  }

  // Pid set the Companion launcher is currently tracking as live —
  // anything matching the argv shape AND tracked here is NOT an
  // orphan, it's a live session. We skip without classifying so the
  // reaper's `process.kill` never targets the bun's own children.
  const trackedPids = new Set<number>();
  for (const s of deps.loadedSessions) {
    if (typeof s.pid === "number" && s.pid > 0) trackedPids.add(s.pid);
  }

  let pids: number[];
  try {
    pids = listProc();
  } catch (e) {
    // /proc unreadable — degrade rather than crash init.
    log.warn("orphan-reaper", "proc enumeration failed — skipping reap pass", {
      event: "orphan_reaper.proc_enum_failed",
      error_code: (e as NodeJS.ErrnoException).code ?? "unknown",
    });
    return {
      platform,
      scannedPids: 0,
      reattached: 0,
      reaped: 0,
      skippedNoSessionMatch: 0,
      budgetExceeded: false,
      durationMs: ageMs(startedAt, clock()),
    };
  }

  let scanned = 0;
  let reattached = 0;
  let reaped = 0;
  let skippedNoMatch = 0;
  let budgetExceeded = false;
  const rawArgvLogEnabled = process.env.COMPANION_LOG_PATHS_RAW === "1";

  for (const pid of pids) {
    if (ageMs(startedAt, clock()) > budgetMs) {
      log.warn("orphan-reaper", "reap budget exceeded — deferring remaining orphans to next boot", {
        event: "orphan_reaper.budget_exceeded",
        scanned,
        reattached,
        reaped,
      });
      budgetExceeded = true;
      break;
    }

    // PPID filter — only orphans (reparented to init). Read stat,
    // check field 4 (ppid). Errors short-circuit (race: pid died
    // mid-enumeration).
    let ppid: number;
    try {
      const stat = readStat(pid);
      ppid = parsePpidFromStat(stat);
    } catch {
      continue;
    }
    if (ppid !== 1) continue;

    // argv classification.
    let argv: string[];
    try {
      argv = splitCmdline(readCmdline(pid));
    } catch {
      continue;
    }
    if (argv.length === 0) continue;

    const classification = classifyArgv(argv);
    if (!classification.isCompanionShape) continue;
    scanned++;

    // Skip pids the launcher is already tracking — they're alive and
    // owned, not orphans.
    if (trackedPids.has(pid)) continue;

    // RE-ATTACH branch — argv sessionId matches a known session.
    const known = classification.sessionId
      ? knownById.get(classification.sessionId)
      : undefined;
    if (known) {
      // Pull processStartMs from the sidecar (Phase D contract); if
      // absent, the verifyProcessIdentity call accepts null and runs
      // two-factor (Phase A interim). Either way the verdict drives
      // the branch.
      let expectedStartMs: number | null = null;
      try {
        const sidecar = readRuntimeSidecar(deps.sessionsRoot, known.sessionId);
        if (sidecar.kind === "present") expectedStartMs = sidecar.payload.processStartMs;
      } catch (e) {
        // Corrupt sidecar — log + treat as absent (degrade to 2-factor).
        log.warn("orphan-reaper", "sidecar read failed — degrading to two-factor verify", {
          event: "orphan_reaper.sidecar_corrupt",
          sessionIdPresent: true,
          error_code: (e as NodeJS.ErrnoException).code ?? "unknown",
        });
      }

      const verdict = verifyProcessIdentity(pid, known.sessionId, expectedStartMs);
      if (verdict.kind === "match") {
        // PURE Map mutation. NEVER respawn. NEVER inject synthetic init.
        known.pid = pid;
        reattached++;
        log.info("orphan-reaper", "orphan re-attached to known session", {
          event: "orphan_reattached",
          pid,
          argvSha256: classification.argvSha256,
          argvShape: classification.argvShape,
          cwdDepth: classification.cwdDepth,
          sessionIdPresent: true,
        });
        if (rawArgvLogEnabled) appendRawDebug({ event: "orphan_reattached", pid, argv });
        continue;
      }
      // Verdict was mismatch/gone/unavailable — fall through to REAP.
    }

    // REAP branch — sentinel-before-sweep per EC-8.
    if (!known) skippedNoMatch++;
    const reason = known ? "identity_mismatch" : "no_known_session";
    try {
      writeReapingMarker(deps.sentinelRoot, pid, {
        pid,
        decisionTs: clock(),
        reason,
      });
    } catch (e) {
      // Sentinel write failed — DO NOT kill without the marker.
      // EC-8 floor: the marker is the bit that turns the next boot's
      // reconciliation idempotent. Without it, a crash between kill
      // and the next reaper run produces a "spontaneous-death" ghost.
      log.warn("orphan-reaper", "sentinel write failed — skipping SIGTERM", {
        event: "orphan_reaper.sentinel_write_failed",
        pid,
        argvSha256: classification.argvSha256,
        error_code: (e as NodeJS.ErrnoException).code ?? "unknown",
      });
      continue;
    }

    let killOk = false;
    try {
      kill(pid, "SIGTERM");
      killOk = true;
    } catch (e) {
      // ESRCH (already gone) is the happy path; everything else WARN.
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "ESRCH") {
        log.warn("orphan-reaper", "SIGTERM failed", {
          event: "orphan_reaper.kill_failed",
          pid,
          argvSha256: classification.argvSha256,
          error_code: code ?? "unknown",
        });
      }
    }

    // Wait for exit, bounded. Poll via kill(pid, 0) so a slow exit
    // doesn't tie up the budget for too long.
    if (killOk) {
      const exitDeadline = clock() + REAP_POST_TERM_GRACE_MS;
      while (clock() < exitDeadline) {
        if (!killCheck(pid)) break;
        // eslint-disable-next-line no-await-in-loop
        await sleep(REAP_POLL_INTERVAL_MS);
      }
    }

    reaped++;
    log.info("orphan-reaper", "orphan reaped via SIGTERM", {
      event: "orphan_reaped",
      pid,
      argvSha256: classification.argvSha256,
      argvShape: classification.argvShape,
      cwdDepth: classification.cwdDepth,
      sessionIdPresent: classification.sessionId !== null,
      reason,
    });
    if (rawArgvLogEnabled) appendRawDebug({ event: "orphan_reaped", pid, argv });

    // Cleanup the sentinel — best-effort; ENOENT silent.
    deleteReapingMarker(deps.sentinelRoot, pid);
  }

  const durationMs = ageMs(startedAt, clock());
  log.info("orphan-reaper", "reap pass complete", {
    event: "orphan_reaper.complete",
    scanned,
    reattached,
    reaped,
    skippedNoSessionMatch: skippedNoMatch,
    budgetExceeded,
    durationMs,
  });

  return {
    platform,
    scannedPids: scanned,
    reattached,
    reaped,
    skippedNoSessionMatch: skippedNoMatch,
    budgetExceeded,
    durationMs,
  };
}

// ─── /proc adapters (Linux production defaults) ─────────────────────────────

function defaultListProcPids(): number[] {
  // EC-7: `/proc` is a kernel pseudo-fs; the only caller-supplied
  // input is the directory name `/proc`. No realpath needed.
  const entries = readdirSync("/proc", { withFileTypes: true });
  const pids: number[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (!/^[0-9]+$/.test(e.name)) continue;
    pids.push(parseInt(e.name, 10));
  }
  return pids;
}

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
  // PURE syscall — NEVER `Bun.spawn(["pkill"])` / `exec` / `shell:true`
  // (Hunt R2). The signal name is a fixed string literal; argv shape
  // is `(number, "SIGTERM")` so command injection is structurally
  // impossible.
  process.kill(pid, signal);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── argv classification (EC-23 redaction at source) ────────────────────────

/**
 * Identify a Companion-spawned CLI shape. Recognises:
 *   - Claude: argv[0] basename === "claude" AND `--sdk-url <ws://.../<sessionId>>`
 *   - Codex (host mode): argv[0] basename === "codex" AND `app-server` somewhere
 *
 * Codex's sessionId is NOT in argv (Codex transport routes via a port
 * the launcher picks at spawn). Codex orphans therefore return
 * `sessionId: null` and fall through to the REAP branch by default —
 * the launcher's internal map can still hold an entry, but the reaper
 * can't cross-check. Subprocess R5 floor (pure mutation) is preserved
 * because the re-attach branch never fires without a sessionId match.
 *
 * EC-23: argvShape categorises tokens into labels — `<URL>`, `<PATH>`,
 * `<TOKEN>` — so log lines carry the structural shape (which factor
 * told us "this is a Companion process") without exposing raw bytes.
 */
export function classifyArgv(argv: readonly string[]): ArgvClassification {
  const shape: string[] = [];
  let isCompanionShape = false;
  let sessionId: string | null = null;
  let cwdDepth = 0;

  const argv0 = argv[0] ?? "";
  // argv[0] may be an absolute path; basename for shape, full token for
  // matching.
  const argv0Basename = lastPathSegment(argv0);
  if (argv0Basename === "claude" || argv0Basename === "codex") {
    isCompanionShape = true;
  } else if (argv0Basename === "node" && argv[1]) {
    // Codex stdio launcher path: `node /path/to/codex.js app-server`
    const argv1Base = lastPathSegment(argv[1]);
    if (argv1Base === "codex" || argv1Base === "codex.js" || argv1Base === "codex.cjs") {
      isCompanionShape = true;
    }
  }

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    // Categorical shape for redacted logging — never the raw bytes.
    if (i === 0) {
      shape.push(argv0Basename || "<BIN>");
      continue;
    }
    if (tok.startsWith("--")) {
      shape.push(tok);
      continue;
    }
    if (tok.startsWith("ws://") || tok.startsWith("wss://") || tok.startsWith("http://") || tok.startsWith("https://")) {
      shape.push("<URL>");
      // Extract sessionId from --sdk-url ws://.../<sessionId>
      if (i > 0 && argv[i - 1] === "--sdk-url") {
        try {
          const url = new URL(tok);
          const segs = url.pathname.split("/").filter((s) => s.length > 0);
          const last = segs[segs.length - 1];
          if (last && last.length > 0) sessionId = last;
        } catch { /* malformed URL — no sessionId extracted */ }
      }
      continue;
    }
    if (tok.includes("/") || tok.includes("\\")) {
      shape.push("<PATH>");
      // Track depth of the deepest path token for cwd-depth-ish forensic.
      const segs = tok.split(/[/\\]/).filter((s) => s.length > 0);
      if (segs.length > cwdDepth) cwdDepth = segs.length;
      continue;
    }
    shape.push("<TOKEN>");
  }

  return {
    isCompanionShape,
    sessionId,
    argvShape: shape,
    argvSha256: computeArgvSha(argv),
    cwdDepth,
  };
}

/** Helper — last `/` (or `\`) separated segment. */
function lastPathSegment(s: string): string {
  if (s.length === 0) return s;
  const lastSep = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
  return lastSep >= 0 ? s.slice(lastSep + 1) : s;
}

/** Kernel cmdline format: NUL-separated argv, optional trailing NUL. */
export function splitCmdline(raw: string): string[] {
  return raw.split("\0").filter((s) => s.length > 0);
}

/**
 * Parse `/proc/<pid>/stat` and return field 4 (ppid). The `comm` field
 * (field 2) can contain spaces and parens, so we locate the LAST `)`
 * and parse the suffix.
 */
export function parsePpidFromStat(statContent: string): number {
  const lastParen = statContent.lastIndexOf(")");
  if (lastParen < 0) throw new Error("malformed /proc/<pid>/stat");
  const tail = statContent.slice(lastParen + 1).trim();
  const fields = tail.split(/\s+/);
  // Fields after `comm` are: state(0) ppid(1) ...
  if (fields.length < 2) throw new Error("missing ppid field");
  const ppid = parseInt(fields[1], 10);
  if (!Number.isFinite(ppid) || ppid < 0) throw new Error("invalid ppid");
  return ppid;
}

// ─── raw-argv debug sidecar (operator opt-in via COMPANION_LOG_PATHS_RAW=1) ──

/**
 * Append a raw-argv debug entry to `~/.companion/orphan-reaped-debug.jsonl`
 * mode 0600. Only enabled when `COMPANION_LOG_PATHS_RAW=1` so production
 * deployments never spill argv bytes by default. EC-23 carve-out: this
 * file is the SOLE production sink for raw argv; the structured log
 * surface stays redacted.
 */
function appendRawDebug(entry: { event: string; pid: number; argv: readonly string[] }): void {
  try {
    const dir = join(homedir(), ".companion");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, "orphan-reaped-debug.jsonl");
    const line = JSON.stringify({ ts: Date.now(), ...entry }) + "\n";
    appendFileSync(path, line, { mode: 0o600 });
  } catch {
    // Best-effort sidecar; failure is structurally tolerable since the
    // structured log already captured the redacted forensic.
  }
}
