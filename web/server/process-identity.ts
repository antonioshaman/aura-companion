// AURA-LOCAL
// PID-identity helper. PLAN task T3. The structural keystone for
// session-map eviction & boot hygiene — replaces the bare
// `process.kill(pid, 0)` liveness probe at `cli-launcher.ts:312-323`
// (false-positives under PID reuse → relaunch storm).
//
// Three-factor probe, ALL three must agree → "match":
//   1. `process.kill(pid, 0)` liveness (cheap; no signal sent).
//   2. `/proc/<pid>/cmdline` NUL-split EXACT-token match for
//      `--sdk-url ws://.../<expectedSessionId>` — never String.includes
//      (defends against sessionId substring collisions in adjacent
//      tokens — e.g., a working-dir path that happens to embed the
//      sessionId fragment).
//   3. `/proc/<pid>/stat` field 22 (starttime in jiffies since boot)
//      converted to wallclock via `(btime + starttime / CLK_TCK) * 1000`
//      and matched against `expectedStartMs` with ±2s tolerance (PID
//      reuse across reboots/clock skew gets rejected).
//
// Fail-CLOSED on ANY read error → `"gone"`. Conservative by design:
// false-rejection means "relaunch a session that turned out to be
// alive" (existing relaunch path is idempotent); false-acceptance
// means "skip relaunch of a session whose PID was reused by an
// unrelated process" (silent data loss). The asymmetry favours rejection.
//
// macOS / non-Linux → `"unavailable"` with a one-time boot WARN; the
// reaper caller degrades gracefully (Phase D) rather than no-op silently.
//
// Factor 2 (argv) is pluggable: `verifyProcessIdentity` matches the
// session `--sdk-url <sessionId>` token; `verifyProcessIdentityByArgv`
// takes a caller-supplied `ArgvMatcher` for non-session process classes
// (PTY terminals), where uniqueness rests on factors 1 + 3.
//
// Pure helper: no kills, no mutation. Callers decide.
//
// EC-40: the test seam (`setProcReaderForTests`, `__resetProcReaderForTests`)
// is a plain ESM export — no inline `require()`.
//
// AP-17: the module-scope mutable `unavailableWarned` flag is bundled
// with `__resetUnavailableWarnedForTests` + a test exercising the warn
// path + a `beforeEach` reset in the suite.

import { readFileSync } from "node:fs";
import { platform as osPlatform } from "node:os";
import { log } from "./logger.js";

/** Probe result. Discriminated union — callers MUST narrow on `kind`. */
export type ProcessIdentityResult =
  | { kind: "match" }
  | {
      kind: "mismatch";
      /** Which factor disagreed — operator-facing diagnostic. */
      reason: "argv" | "starttime";
    }
  | { kind: "gone" }
  | {
      kind: "unavailable";
      /** `os.platform()` string — `"darwin"`, `"win32"`, etc. */
      platform: NodeJS.Platform;
    };

/**
 * Linux jiffy-per-second. On modern x86_64/arm64 kernels this is 100;
 * the legacy 250/300/1000 values are vanishingly rare on production
 * Linux deployments. If a future host runs with a non-default CLK_TCK
 * the wallclock conversion will skew, but the ±2s tolerance absorbs the
 * common 10-20ms drift and Phase D's reaper logs the mismatch with a
 * `reason: "starttime"` so the operator can correct.
 */
const DEFAULT_CLK_TCK = 100;

/** ±2s tolerance per spec (Subprocess P2). */
const STARTTIME_TOLERANCE_MS = 2_000;

/**
 * Test-injectable system layer. The default implementation reads
 * `/proc/<pid>/cmdline`, `/proc/<pid>/stat`, `/proc/stat`, and probes
 * liveness via `process.kill(pid, 0)`. Tests pass a `Partial<ProcReader>`
 * to override individual functions.
 */
export interface ProcReader {
  readCmdline: (pid: number) => string;
  readStat: (pid: number) => string;
  readBootStat: () => string;
  killCheck: (pid: number) => boolean;
  platform: () => NodeJS.Platform;
  clkTck: number;
}

function defaultProcReader(): ProcReader {
  return {
    readCmdline: (pid) => readFileSync(`/proc/${pid}/cmdline`, "utf8"),
    readStat: (pid) => readFileSync(`/proc/${pid}/stat`, "utf8"),
    readBootStat: () => readFileSync("/proc/stat", "utf8"),
    killCheck: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    },
    platform: () => osPlatform(),
    clkTck: DEFAULT_CLK_TCK,
  };
}

let procReader: ProcReader = defaultProcReader();

/**
 * Test seam: override one or more probe functions. Use `Partial<ProcReader>`
 * — unset fields keep their default. Pair with `__resetProcReaderForTests`
 * in `afterEach`.
 */
export function setProcReaderForTests(overrides: Partial<ProcReader>): void {
  procReader = { ...procReader, ...overrides };
}

/** Test seam: restore the production proc-reader. */
export function __resetProcReaderForTests(): void {
  procReader = defaultProcReader();
  __resetUnavailableWarnedForTests();
}

// ─── one-time boot WARN flag ────────────────────────────────────────────────

let unavailableWarned = false;

/** Test seam: reset the one-time WARN flag (AP-17). */
export function __resetUnavailableWarnedForTests(): void {
  unavailableWarned = false;
}

// ─── argv parsing ───────────────────────────────────────────────────────────

/**
 * Parse `/proc/<pid>/cmdline` content into a tokens array. The kernel
 * separates argv elements with NUL bytes and typically appends a trailing
 * NUL, so we filter empty strings.
 */
function splitCmdline(raw: string): string[] {
  return raw.split("\0").filter((s) => s.length > 0);
}

/**
 * Check the argv contains `--sdk-url <url>` where `<url>`'s URL path
 * ends with the expected sessionId. The token AFTER `--sdk-url` must be
 * the URL itself (not the URL embedded in a longer string).
 *
 * Returns `true` on exact-token match, `false` otherwise.
 */
function argvMatchesSessionId(tokens: string[], expectedSessionId: string): boolean {
  const flagIdx = tokens.indexOf("--sdk-url");
  if (flagIdx < 0 || flagIdx >= tokens.length - 1) return false;
  const urlToken = tokens[flagIdx + 1];

  // Parse as URL; bail on malformed. The cli-launcher emits
  // `ws://localhost:3456/ws/cli/<sessionId>` — we want the LAST path
  // segment to equal expectedSessionId exactly (not substring-match,
  // which would false-positive on a sessionId that's a prefix of
  // another).
  let parsedPath: string;
  try {
    parsedPath = new URL(urlToken).pathname;
  } catch {
    return false;
  }
  const segments = parsedPath.split("/").filter((s) => s.length > 0);
  const lastSegment = segments[segments.length - 1];
  return lastSegment === expectedSessionId;
}

// ─── starttime conversion ──────────────────────────────────────────────────

/**
 * Parse `/proc/stat` and return the kernel boot time in seconds since
 * epoch. The `btime <seconds>` line is always present on Linux.
 */
function parseBootTimeSecs(statContent: string): number {
  const m = statContent.match(/^btime\s+(\d+)/m);
  if (!m) throw new Error("btime not found in /proc/stat");
  const secs = parseInt(m[1], 10);
  if (!Number.isFinite(secs) || secs <= 0) {
    throw new Error(`btime invalid: ${m[1]}`);
  }
  return secs;
}

/**
 * Parse `/proc/<pid>/stat` and return field 22 (starttime in clock
 * ticks since boot). The `comm` field (field 2) can contain spaces and
 * parens, so we locate the LAST `)` and parse the suffix.
 */
function parseStartTimeTicks(statContent: string): number {
  const lastParen = statContent.lastIndexOf(")");
  if (lastParen < 0) throw new Error("malformed /proc/<pid>/stat — no closing paren");
  // After the closing paren the format is: " <state> <ppid> ... <starttime> ..."
  // — i.e., field 3 onward. starttime is field 22, so index 22 - 3 = 19
  // in the post-paren tail (0-indexed).
  const tail = statContent.slice(lastParen + 1).trim();
  const fields = tail.split(/\s+/);
  if (fields.length <= 19) {
    throw new Error(`malformed /proc/<pid>/stat — only ${fields.length} fields after comm`);
  }
  const ticks = parseInt(fields[19], 10);
  if (!Number.isFinite(ticks) || ticks < 0) {
    throw new Error(`starttime invalid: ${fields[19]}`);
  }
  return ticks;
}

function ticksToWallMs(startTimeTicks: number, bootSecs: number, clkTck: number): number {
  return bootSecs * 1000 + (startTimeTicks * 1000) / clkTck;
}

// ─── main entry ────────────────────────────────────────────────────────────

/**
 * Verify that `pid` is the same process Companion spawned for
 * `expectedSessionId` at `expectedStartMs`.
 *
 * Returns a discriminated union — callers MUST handle every variant.
 * The orchestrator caller treats `match` → keep, anything else → null
 * the pid + mark exited. The reaper caller (Phase D) treats
 * `mismatch | gone` → reap, `match` → re-attach, `unavailable` → degrade.
 *
 * **`expectedStartMs: null` (Phase A interim) → two-factor degraded mode.**
 * The Phase D sidecar `<sessionId>.runtime.json` will carry the spawn-time
 * anchor; until then, the boot-probe caller cannot reconstruct it. In the
 * interim the helper accepts `null` and skips the starttime factor —
 * verdict reduces to liveness + argv. Strictly stronger than the bare
 * `process.kill(pid, 0)` probe it replaces: argv-token verification
 * closes the live symptom (alive subprocess whose argv doesn't carry the
 * Companion sessionId → mismatch instead of false-positive match).
 * Phase D upgrades every site to pass a real number from the sidecar.
 *
 * Pure: no kills, no mutation. The probe takes ~3 file reads + 1
 * syscall (`kill(pid, 0)`), <1ms typical.
 */
export function verifyProcessIdentity(
  pid: number,
  expectedSessionId: string,
  expectedStartMs: number | null,
): ProcessIdentityResult {
  return verifyProcessIdentityByArgv(
    pid,
    (tokens) => argvMatchesSessionId(tokens, expectedSessionId),
    expectedStartMs,
  );
}

/**
 * Argv-shape predicate over the NUL-split `/proc/<pid>/cmdline` tokens.
 * Returns `true` when the tokens identify the process class the caller
 * expects. The session probe uses `argvMatchesSessionId`; other process
 * classes (PTY shells, docker-exec clients) supply their own shape check
 * — they carry no `--sdk-url <sessionId>` token, so uniqueness for those
 * comes from the starttime factor (PID + spawn-time anchor), not argv.
 */
export type ArgvMatcher = (tokens: string[]) => boolean;

/**
 * Generalized three-factor probe: liveness + caller-supplied argv-shape
 * predicate + starttime. `verifyProcessIdentity` is the session-flavoured
 * wrapper; the PTY-terminal reaper (resource-reclamation) passes a
 * terminal-shaped `argvMatches` here instead.
 *
 * Identical fail-CLOSED semantics and `expectedStartMs: null` two-factor
 * degraded mode as `verifyProcessIdentity` — the only difference is which
 * argv shape counts as a match.
 *
 * Pure: no kills, no mutation.
 */
export function verifyProcessIdentityByArgv(
  pid: number,
  argvMatches: ArgvMatcher,
  expectedStartMs: number | null,
): ProcessIdentityResult {
  const platform = procReader.platform();
  if (platform !== "linux") {
    if (!unavailableWarned) {
      unavailableWarned = true;
      log.warn(
        "process-identity",
        "verifyProcessIdentity unavailable on non-Linux — degraded probe",
        {
          event: "process_identity.unavailable",
          platform,
        },
      );
    }
    return { kind: "unavailable", platform };
  }

  // Liveness first — cheapest signal, exits early on dead PIDs.
  if (!procReader.killCheck(pid)) {
    return { kind: "gone" };
  }

  // argv check.
  let argvOk: boolean;
  try {
    const cmdline = procReader.readCmdline(pid);
    const tokens = splitCmdline(cmdline);
    argvOk = argvMatches(tokens);
  } catch {
    // ESRCH (race: process died between killCheck and readCmdline) or
    // EACCES (process owned by a different UID — shouldn't happen but
    // fail-CLOSED). Both → "gone" per spec.
    return { kind: "gone" };
  }
  if (!argvOk) {
    return { kind: "mismatch", reason: "argv" };
  }

  // Phase A interim: caller (boot probe at cli-launcher.ts:312-323) does
  // not yet have a spawn-time anchor — the sidecar lands in Phase D.
  // Skip the starttime factor; verdict is liveness + argv only.
  if (expectedStartMs === null) {
    return { kind: "match" };
  }

  // starttime check.
  let actualStartMs: number;
  try {
    const procStat = procReader.readStat(pid);
    const bootStat = procReader.readBootStat();
    const startTimeTicks = parseStartTimeTicks(procStat);
    const bootSecs = parseBootTimeSecs(bootStat);
    actualStartMs = ticksToWallMs(startTimeTicks, bootSecs, procReader.clkTck);
  } catch {
    return { kind: "gone" };
  }

  if (Math.abs(actualStartMs - expectedStartMs) > STARTTIME_TOLERANCE_MS) {
    return { kind: "mismatch", reason: "starttime" };
  }

  return { kind: "match" };
}

/**
 * EC-49 — read the KERNEL process-start instant for `pid` (the same
 * quantity `verifyProcessIdentity` compares against), in epoch-ms.
 *
 * Returns `null` on non-Linux (no `/proc`) or any read/parse error. The
 * caller (sidecar write at spawn) stores this so the verifier compares
 * like-for-like with zero clock-domain skew — instead of `Date.now()`
 * read in JS after spawn, which a GC pause / event-loop stall / cgroup
 * `MemoryHigh` throttle between fork and the JS read can push past the
 * ±2s window, false-flagging a live, correctly-identified subprocess as
 * `mismatch (starttime)`.
 *
 * Pure: no kills, no mutation. Routes through the same injectable
 * `procReader` seam as the verifier so tests drive both from one fake.
 */
export function readProcessStartMs(pid: number): number | null {
  if (procReader.platform() !== "linux") return null;
  try {
    const procStat = procReader.readStat(pid);
    const bootStat = procReader.readBootStat();
    const ticks = parseStartTimeTicks(procStat);
    const bootSecs = parseBootTimeSecs(bootStat);
    return ticksToWallMs(ticks, bootSecs, procReader.clkTck);
  } catch {
    return null;
  }
}

// Test-only: exported so tests can verify the splitter independently of
// the full probe.
export const __INTERNAL_FOR_TESTS = {
  splitCmdline,
  argvMatchesSessionId,
  parseBootTimeSecs,
  parseStartTimeTicks,
  ticksToWallMs,
};
