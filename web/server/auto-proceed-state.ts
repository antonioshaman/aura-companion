/**
 * Auto-proceed persistence layer — per-group on-disk artefacts that
 * survive server restart and feed the boot-reconcile path (Task 9 of
 * PLAN-aura-orchestrator-idle-auto-proceed).
 *
 * Two artefacts per active Council pair, both written under
 * `<workspaceRoot>/.council/state/` via {@link resolveCouncilStatePath}
 * so the path-traversal floor (EC-7) is enforced uniformly:
 *
 *  - `<group-id>-auto-proceed-trace.json` — schemaVersion-1 trace of
 *    iteration counter, fire timestamps, cap-reached flag, last
 *    objective-gate result. Whole-file atomic via {@link writeAtomicJson}
 *    so a crash mid-write never corrupts the trace.
 *
 *  - `<group-id>-afk-summary.md` — append-only Markdown log of
 *    auto-proceed-fired decisions. Each entry is a single `write(2)`
 *    bounded to ≤ {@link AFK_ENTRY_MAX_BYTES} (4 KiB, conservative
 *    POSIX PIPE_BUF floor) so the kernel guarantees atomicity even
 *    under concurrent writers. First-byte schema marker
 *    `<!-- afk-summary v1 -->` is written once at file creation; the
 *    reader / appender refuses to write to a file whose first line
 *    does not match.
 *
 * Schema-versioning discipline: both writers refuse to operate on
 * a file whose schemaVersion (JSON) or first-line marker (Markdown)
 * does not match the version this module knows. Loud failure beats
 * silent default — a mismatched file usually means a partially-rolled
 * deploy and silent-default would corrupt forensic state.
 */

import {
  closeSync,
  constants as fsConstants,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  writeSync,
} from "node:fs";
import { writeAtomicJson } from "./atomic-write.js";
import {
  resolveCouncilStatePath,
  resolveCouncilStateDir,
  type CouncilStatePathError,
} from "./council-state-path.js";
import { isIsoTimestamp } from "./council-types.js";

/**
 * Current schema version for `<group-id>-auto-proceed-trace.json`.
 * Bump in coordination with a forward-compatible reader (or a
 * migrator); the current reader hard-rejects any other value.
 */
export const AUTO_PROCEED_TRACE_SCHEMA_VERSION = 1;

/**
 * Marker line written as the first line of `<group-id>-afk-summary.md`
 * when the file is first created. The appender refuses to append to a
 * file whose first line is anything else (mismatched-version protection
 * + corruption canary).
 */
export const AFK_SUMMARY_MARKER_V1 = "<!-- afk-summary v1 -->";

/**
 * Conservative POSIX `PIPE_BUF` floor. Writes up to this size to a
 * regular file opened with `O_APPEND` are atomic on Linux, macOS, and
 * the BSDs — a concurrent writer cannot interleave bytes within a
 * single sub-`PIPE_BUF` `write(2)`. Real `PIPE_BUF` is 4096 on Linux
 * (often 512 on older systems); we use 4096 as the safe upper bound.
 *
 * Each AFK-summary entry MUST stay under this size, including the
 * trailing newline. Callers that produce a longer entry MUST truncate
 * before invoking the appender — the appender hard-rejects oversize
 * payloads so a forgetful caller cannot silently corrupt the log.
 */
export const AFK_ENTRY_MAX_BYTES = 4096;

/** On-disk shape of `<group-id>-auto-proceed-trace.json`. */
export interface AutoProceedTrace {
  /** Always equals {@link AUTO_PROCEED_TRACE_SCHEMA_VERSION} on read. */
  readonly schemaVersion: number;
  /** `grp_<32-hex>` — matches the file's group-id slug. */
  readonly sessionGroupId: string;
  /** Total auto-proceed fires accumulated for this group (≥ 0). */
  readonly iterationCount: number;
  /** ISO timestamps for each successful fire, in chronological order. */
  readonly firedAt: ReadonlyArray<string>;
  /** ISO timestamp of the moment the cap was tripped, or null. */
  readonly cappedAt: string | null;
  /** Last objective-gate result observed by the auto-proceed pipeline. */
  readonly lastObjectiveGateResult: "pass" | "fail" | null;
}

/** Discriminated drop reasons for {@link readAutoProceedTrace} failures. */
export type AutoProceedTraceReadError =
  | { kind: "missing" }
  | { kind: "path-error"; error: CouncilStatePathError }
  | { kind: "invalid-json" }
  | { kind: "schema-version-mismatch"; got: unknown }
  | { kind: "invalid-shape"; field: string };

/** Discriminated drop reasons for {@link writeAutoProceedTrace} failures. */
export type AutoProceedTraceWriteError =
  | { kind: "path-error"; error: CouncilStatePathError }
  | { kind: "invalid-shape"; field: string };

/** Discriminated drop reasons for {@link appendAfkSummary} failures. */
export type AfkAppendError =
  | { kind: "path-error"; error: CouncilStatePathError }
  | { kind: "entry-too-large"; sizeBytes: number; maxBytes: number }
  | { kind: "entry-contains-nul" }
  | { kind: "marker-mismatch"; firstLine: string };

/**
 * Read and validate the trace JSON for the given group. Returns the
 * typed payload on success, `null`-shaped drop reason on every failure
 * mode. Callers should EC-9-log the discriminant and treat the trace
 * as missing — the iteration counter rehydrates to 0 in that case,
 * which is the safe default.
 */
export function readAutoProceedTrace(
  workspaceRoot: string,
  groupId: string,
): { ok: true; value: AutoProceedTrace } | { ok: false; error: AutoProceedTraceReadError } {
  const pathOut = resolveCouncilStatePath(workspaceRoot, groupId, "-auto-proceed-trace.json");
  if (!pathOut.ok) {
    return { ok: false, error: { kind: "path-error", error: pathOut.error } };
  }

  let raw: string;
  try {
    raw = readFileSync(pathOut.value.absolutePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { ok: false, error: { kind: "missing" } };
    }
    // Any other read error (permission, EISDIR) propagates as missing
    // to the caller — the boot-reconcile path treats them all the
    // same (fall back to zero counter).
    return { ok: false, error: { kind: "missing" } };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: { kind: "invalid-json" } };
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: { kind: "invalid-shape", field: "<root>" } };
  }
  const obj = parsed as Record<string, unknown>;

  if (obj.schemaVersion !== AUTO_PROCEED_TRACE_SCHEMA_VERSION) {
    return { ok: false, error: { kind: "schema-version-mismatch", got: obj.schemaVersion } };
  }
  if (typeof obj.sessionGroupId !== "string" || obj.sessionGroupId.length === 0) {
    return { ok: false, error: { kind: "invalid-shape", field: "sessionGroupId" } };
  }
  if (
    typeof obj.iterationCount !== "number" ||
    !Number.isFinite(obj.iterationCount) ||
    !Number.isInteger(obj.iterationCount) ||
    obj.iterationCount < 0
  ) {
    return { ok: false, error: { kind: "invalid-shape", field: "iterationCount" } };
  }
  if (!Array.isArray(obj.firedAt)) {
    return { ok: false, error: { kind: "invalid-shape", field: "firedAt" } };
  }
  for (const ts of obj.firedAt) {
    if (!isIsoTimestamp(ts)) {
      return { ok: false, error: { kind: "invalid-shape", field: "firedAt[]" } };
    }
  }
  if (obj.cappedAt !== null && !isIsoTimestamp(obj.cappedAt)) {
    return { ok: false, error: { kind: "invalid-shape", field: "cappedAt" } };
  }
  if (
    obj.lastObjectiveGateResult !== null &&
    obj.lastObjectiveGateResult !== "pass" &&
    obj.lastObjectiveGateResult !== "fail"
  ) {
    return { ok: false, error: { kind: "invalid-shape", field: "lastObjectiveGateResult" } };
  }

  return {
    ok: true,
    value: {
      schemaVersion: AUTO_PROCEED_TRACE_SCHEMA_VERSION,
      sessionGroupId: obj.sessionGroupId,
      iterationCount: obj.iterationCount,
      firedAt: obj.firedAt as string[],
      cappedAt: obj.cappedAt as string | null,
      lastObjectiveGateResult: obj.lastObjectiveGateResult as "pass" | "fail" | null,
    },
  };
}

/**
 * Atomically write the trace JSON. The whole-file rename via
 * {@link writeAtomicJson} guarantees a partial-write crash leaves the
 * previous trace intact. Field validation runs BEFORE the write so a
 * shape mismatch cannot land on disk.
 *
 * Callers must {@link ensureCouncilStateDir} once per workspace before
 * the first write; this writer does not implicitly `mkdir -p` (kept
 * orthogonal so the caller controls the directory lifecycle).
 */
export function writeAutoProceedTrace(
  workspaceRoot: string,
  groupId: string,
  trace: AutoProceedTrace,
): { ok: true } | { ok: false; error: AutoProceedTraceWriteError } {
  // Validate payload first — never persist a malformed trace.
  if (trace.schemaVersion !== AUTO_PROCEED_TRACE_SCHEMA_VERSION) {
    return { ok: false, error: { kind: "invalid-shape", field: "schemaVersion" } };
  }
  if (typeof trace.sessionGroupId !== "string" || trace.sessionGroupId.length === 0) {
    return { ok: false, error: { kind: "invalid-shape", field: "sessionGroupId" } };
  }
  if (
    typeof trace.iterationCount !== "number" ||
    !Number.isInteger(trace.iterationCount) ||
    trace.iterationCount < 0
  ) {
    return { ok: false, error: { kind: "invalid-shape", field: "iterationCount" } };
  }
  if (!Array.isArray(trace.firedAt) || trace.firedAt.some((ts) => !isIsoTimestamp(ts))) {
    return { ok: false, error: { kind: "invalid-shape", field: "firedAt" } };
  }
  if (trace.cappedAt !== null && !isIsoTimestamp(trace.cappedAt)) {
    return { ok: false, error: { kind: "invalid-shape", field: "cappedAt" } };
  }
  if (
    trace.lastObjectiveGateResult !== null &&
    trace.lastObjectiveGateResult !== "pass" &&
    trace.lastObjectiveGateResult !== "fail"
  ) {
    return { ok: false, error: { kind: "invalid-shape", field: "lastObjectiveGateResult" } };
  }

  const pathOut = resolveCouncilStatePath(workspaceRoot, groupId, "-auto-proceed-trace.json");
  if (!pathOut.ok) {
    return { ok: false, error: { kind: "path-error", error: pathOut.error } };
  }

  writeAtomicJson(pathOut.value.absolutePath, {
    schemaVersion: AUTO_PROCEED_TRACE_SCHEMA_VERSION,
    sessionGroupId: trace.sessionGroupId,
    iterationCount: trace.iterationCount,
    firedAt: trace.firedAt,
    cappedAt: trace.cappedAt,
    lastObjectiveGateResult: trace.lastObjectiveGateResult,
  });
  return { ok: true };
}

/**
 * Append a single entry to `<group-id>-afk-summary.md`. The file is
 * created on first call with the `AFK_SUMMARY_MARKER_V1` line; existing
 * files are inspected for the marker and rejected if it doesn't match.
 *
 * Atomicity guarantee: each entry is a single `write(2)` ≤
 * {@link AFK_ENTRY_MAX_BYTES} on a file opened `O_APPEND | O_WRONLY`.
 * POSIX guarantees concurrent writers cannot interleave bytes within
 * such a write. Callers that produce a longer entry MUST truncate
 * before invoking the appender.
 *
 * `entry` is the body content WITHOUT trailing newline — the appender
 * adds one. Embedded NUL bytes are rejected (would corrupt
 * downstream Markdown renderers).
 */
export function appendAfkSummary(
  workspaceRoot: string,
  groupId: string,
  entry: string,
): { ok: true } | { ok: false; error: AfkAppendError } {
  if (entry.includes("\0")) {
    return { ok: false, error: { kind: "entry-contains-nul" } };
  }
  const payload = entry.endsWith("\n") ? entry : `${entry}\n`;
  const sizeBytes = Buffer.byteLength(payload, "utf8");
  if (sizeBytes > AFK_ENTRY_MAX_BYTES) {
    return {
      ok: false,
      error: { kind: "entry-too-large", sizeBytes, maxBytes: AFK_ENTRY_MAX_BYTES },
    };
  }

  const pathOut = resolveCouncilStatePath(workspaceRoot, groupId, "-afk-summary.md");
  if (!pathOut.ok) {
    return { ok: false, error: { kind: "path-error", error: pathOut.error } };
  }

  // First-call file creation: write the marker line, fsync, then
  // append the entry. We can't do this in one O_APPEND write because
  // we want the marker to be the canonical first line — append-mode
  // doesn't seek.
  let exists = false;
  try {
    statSync(pathOut.value.absolutePath);
    exists = true;
  } catch {
    // ENOENT — file doesn't exist yet
  }

  if (!exists) {
    // Create with marker. Caller pre-creates the state dir; we use
    // mkdirSync recursive as a defensive fallback so a stale caller
    // doesn't fail the very first write.
    try {
      mkdirSync(pathOut.value.stateDir, { recursive: true, mode: 0o700 });
    } catch {
      // ignore — best-effort
    }
    const fd = openSync(
      pathOut.value.absolutePath,
      fsConstants.O_CREAT | fsConstants.O_WRONLY | fsConstants.O_EXCL,
      0o600,
    );
    try {
      writeSync(fd, `${AFK_SUMMARY_MARKER_V1}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } else {
    // Existing file — verify the marker first.
    const first = readMarkerLine(pathOut.value.absolutePath);
    if (first !== AFK_SUMMARY_MARKER_V1) {
      return { ok: false, error: { kind: "marker-mismatch", firstLine: first ?? "" } };
    }
  }

  // Append the entry in a single atomic write.
  const fd = openSync(
    pathOut.value.absolutePath,
    fsConstants.O_APPEND | fsConstants.O_WRONLY,
    0o600,
  );
  try {
    writeSync(fd, payload);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return { ok: true };
}

/**
 * Read just the first line of a file (up to a small bound). Used by
 * {@link appendAfkSummary} for the marker-mismatch check. Returns
 * `null` on read error.
 */
function readMarkerLine(absolutePath: string): string | null {
  try {
    // Marker is bounded; reading 256 bytes is enough to compare and
    // avoids slurping a large existing file just to check the head.
    const fd = openSync(absolutePath, fsConstants.O_RDONLY);
    try {
      const buf = Buffer.alloc(256);
      const bytesRead = readSync(fd, buf, 0, buf.length, 0);
      const head = buf.subarray(0, bytesRead).toString("utf8");
      const nl = head.indexOf("\n");
      return nl >= 0 ? head.slice(0, nl) : head;
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

/**
 * Idempotent helper: create `<workspaceRoot>/.council/state/` with
 * mode 0700 if it doesn't already exist. Callers should invoke once
 * per workspace before the first auto-proceed write — keeps the
 * directory lifecycle owned by the caller, not the writer functions.
 */
export function ensureCouncilStateDir(
  workspaceRoot: string,
): { ok: true; stateDir: string } | { ok: false; error: CouncilStatePathError } {
  const out = resolveCouncilStateDir(workspaceRoot);
  if (!out.ok) return out;
  try {
    mkdirSync(out.value, { recursive: true, mode: 0o700 });
  } catch (err) {
    // Recursive mkdir returning EEXIST is fine; anything else
    // propagates as a no-op (caller's next write will surface the
    // real failure with file-level context).
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
      // best-effort — surface only if next write fails
    }
  }
  return { ok: true, stateDir: out.value };
}
