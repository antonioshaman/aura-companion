// AURA-LOCAL
// Per-session runtime sidecar — `<sessionId>.runtime.json` written next to
// the persisted session JSON. PLAN tasks T7 + T8.
//
// Phase A shipped `verifyProcessIdentity` with a Phase-A interim
// `expectedStartMs: null` two-factor probe (liveness + argv). The sidecar
// carries the third factor (`processStartMs`) AND a content fingerprint
// (`argvSha256`) so:
//   1. Boot recovery upgrades from 2-factor to 3-factor (closes PID-reuse
//      across reboots — the live symptom in the original spec).
//   2. The Phase D orphan reaper (orphan-reaper.ts) can authoritatively
//      classify a PPID=1 candidate against our spawn record without
//      asking the launcher to re-derive an expected starttime.
//
// AP-3 (council-types.ts pattern): writer + reader + parser colocated in
// ONE file so the schema lives in one place. A future v2 migration adds
// the new shape here, bumps `SIDECAR_SCHEMA_VERSION`, and updates the
// parser — every consumer pulls from the same module.
//
// EC-5 (parsers reject unknown frame shapes; tolerate polymorphic-by-spec
// fields): the loader runtime-validates EVERY field. It NEVER trusts a
// typed cast — a malformed-but-parses-as-JSON payload throws at parse
// time rather than silently masquerading as a v1 record.
//
// ENOENT-vs-malformed contract (mirrors `observer-prompt.ts`): a missing
// sidecar file returns the `"absent"` variant — caller decides what to do
// (boot probe degrades to the Phase A two-factor path; reaper treats as
// unknown-orphan). A corrupt-present sidecar THROWS — the explicit-intent
// contract is preserved at the loader layer.
//
// EC-7 (filesystem-access predicates inline path resolution or route
// through a resolving wrapper): the sidecar path is derived from
// `sessionsRoot + sessionId` and routed through the cleanup-paths
// resolver (`resolveCleanupPath`) before any read/write.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { writeAtomicJson } from "./atomic-write.js";
import { resolveCleanupPath } from "./cleanup/cleanup-paths.js";

/**
 * Schema baseline. Phase D ships v1. A v2 migration would:
 *   1. Add the new optional fields to `RuntimeSidecarPayload`.
 *   2. Bump this constant.
 *   3. Extend `parseRuntimeSidecarPayload` to branch on the parsed `schemaVersion`.
 * Bumping without a parser branch is a regression — the existing v1
 * loader rejects unknown versions per EC-5.
 */
export const SIDECAR_SCHEMA_VERSION = 1 as const;

/** Filename suffix appended to `<sessionId>`. */
export const SIDECAR_FILE_SUFFIX = ".runtime.json" as const;

/** SHA-256 hex output length. */
const SHA256_HEX_LENGTH = 64;

/**
 * On-disk payload shape. Frozen at v1.
 *
 * `pid` — the OS pid of the Companion-spawned subprocess at launch
 * time. Identifies the process for `verifyProcessIdentity` and the
 * orphan reaper's re-attach branch.
 *
 * `processStartMs` — wallclock ms captured immediately after `Bun.spawn`
 * returns. Compared against `/proc/<pid>/stat` field 22 (converted via
 * `_SC_CLK_TCK` + btime) with ±2s tolerance by `verifyProcessIdentity`.
 * Closes the PID-reuse-across-reboots case the Phase A interim couldn't.
 *
 * `argvSha256` — SHA-256 hex digest of `args.join("\0")`. NUL-joining
 * matches `/proc/<pid>/cmdline`'s on-kernel separator, so a reaper that
 * reads cmdline can recompute and compare without re-tokenising. Not
 * load-bearing for `verifyProcessIdentity` (which does its own
 * exact-token match against the URL path segment) — it's a content
 * fingerprint for forensic logs (EC-23 redaction allows SHA but never
 * raw argv bytes).
 *
 * `schemaVersion` — pinned to `1`. The loader rejects anything else.
 */
export interface RuntimeSidecarPayload {
  readonly schemaVersion: typeof SIDECAR_SCHEMA_VERSION;
  readonly pid: number;
  readonly processStartMs: number;
  readonly argvSha256: string;
}

/**
 * Loader result. Discriminated union — callers MUST narrow on `kind`.
 *
 * `present` is the happy path; the caller has a valid v1 payload.
 *
 * `absent` is the documented Phase A → Phase D transition state: a
 * session that was first launched under Phase A code has no sidecar on
 * disk; the reader degrades gracefully rather than throwing. This is
 * the SAME shape the observer-prompt loader uses for the absent case.
 *
 * Corrupt-present is NOT a variant — it THROWS. A payload that parses
 * as JSON but fails the field validators is an explicit-intent contract
 * violation: somebody wrote a malformed sidecar and the boot probe
 * MUST surface that rather than silently masquerading as v1.
 */
export type RuntimeSidecarResult =
  | { readonly kind: "present"; readonly payload: RuntimeSidecarPayload }
  | { readonly kind: "absent" };

/**
 * Build the EC-7-resolved absolute path of the sidecar file.
 * Routes through `resolveCleanupPath` so the resolver inlines
 * realpath + bounds-check at one site rather than relying on every
 * caller to remember the discipline.
 */
export function sidecarPath(sessionsRoot: string, sessionId: string): string {
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw new Error("cli-runtime-sidecar: invalid sessionId");
  }
  return resolveCleanupPath(sessionsRoot, `${sessionId}${SIDECAR_FILE_SUFFIX}`);
}

/**
 * Compute the argv-content SHA-256 fingerprint that goes into the
 * sidecar payload. NUL-joining matches the kernel's cmdline format so
 * a reaper read of `/proc/<pid>/cmdline` can recompute and compare
 * without re-tokenising.
 */
export function argvSha256(args: readonly string[]): string {
  const joined = args.join("\0");
  return createHash("sha256").update(joined, "utf8").digest("hex");
}

/**
 * Write the sidecar atomically. Caller pattern: capture `processStartMs`
 * immediately after `Bun.spawn` returns, hash the args, call this once.
 *
 * Throws on resolver violation, oversize, or atomic-write failure —
 * the spawn site is already in a try-aware context (every spawn path
 * already handles persistState failures), so a thrown sidecar write
 * surfaces structurally rather than getting silently lost.
 */
export function writeRuntimeSidecar(
  sessionsRoot: string,
  sessionId: string,
  payload: RuntimeSidecarPayload,
): string {
  // Validate the payload BEFORE the disk touch so a regressing caller
  // can't write a malformed sidecar that the next-boot loader would
  // throw on. Same shape as `parseRuntimeSidecarPayload` but with the
  // happy-path early-return — the validators are shared via the
  // assertion helper below.
  assertValidRuntimeSidecarPayload(payload);
  const target = sidecarPath(sessionsRoot, sessionId);
  writeAtomicJson(target, payload);
  return target;
}

/**
 * Load and runtime-validate the sidecar at `<sessionsRoot>/<sessionId>.runtime.json`.
 *
 * ENOENT → `{kind:"absent"}` per the contract above.
 * Any other read error (EACCES, EISDIR, EIO) → THROW. The boot probe
 * surfaces these as `verifyProcessIdentity` failures rather than
 * masquerading as absent (which would degrade silently to two-factor).
 *
 * Malformed-but-parses-as-JSON → THROW. The strict validator at
 * {@link parseRuntimeSidecarPayload} rejects unknown fields, missing
 * fields, wrong types, out-of-range numbers, etc.
 */
export function readRuntimeSidecar(
  sessionsRoot: string,
  sessionId: string,
): RuntimeSidecarResult {
  const target = sidecarPath(sessionsRoot, sessionId);
  let raw: string;
  try {
    raw = readFileSync(target, "utf8");
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ENOENT") return { kind: "absent" };
    throw err;
  }
  // JSON.parse throws SyntaxError on corrupt body; preserved.
  const parsed: unknown = JSON.parse(raw);
  const payload = parseRuntimeSidecarPayload(parsed);
  return { kind: "present", payload };
}

/**
 * Pure runtime-validator. Accepts `unknown`, returns the narrowed
 * payload OR throws with a precise message naming which field failed.
 *
 * EC-5: every field is checked individually. Type cast is NEVER
 * trusted — `(parsed as RuntimeSidecarPayload).pid` would happily
 * accept a `string` because TypeScript's type system erases at runtime.
 *
 * The error messages name the field name verbatim so a corrupted
 * sidecar surfaces a triage handle (which field is wrong) without
 * leaking the full payload (which could carry sensitive argv bytes
 * if a regressing writer accidentally widened the shape).
 */
export function parseRuntimeSidecarPayload(input: unknown): RuntimeSidecarPayload {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("cli-runtime-sidecar: payload must be a JSON object");
  }
  const obj = input as Record<string, unknown>;

  // schemaVersion — exact constant match. Any other value (including 0,
  // 2, "1") rejects so a future migration that bumps without updating
  // the parser surfaces structurally.
  if (obj.schemaVersion !== SIDECAR_SCHEMA_VERSION) {
    throw new Error(
      `cli-runtime-sidecar: unexpected schemaVersion ${String(obj.schemaVersion)} (expected ${SIDECAR_SCHEMA_VERSION})`,
    );
  }

  // pid — positive integer in the typical kernel range. PID_MAX_LIMIT
  // on Linux is 4_194_304; we cap at 2^31-1 to also reject Number.MAX_SAFE_INTEGER
  // accidents and obviously bogus negative entries from a regressing
  // writer.
  if (
    typeof obj.pid !== "number" ||
    !Number.isInteger(obj.pid) ||
    obj.pid <= 0 ||
    obj.pid > 2_147_483_647
  ) {
    throw new Error(`cli-runtime-sidecar: invalid pid ${String(obj.pid)}`);
  }

  // processStartMs — positive wallclock ms. Anchored above the year-2000
  // floor (946_684_800_000) to reject 0/negative/garbage; capped at
  // Number.MAX_SAFE_INTEGER to reject runaway writes.
  if (
    typeof obj.processStartMs !== "number" ||
    !Number.isFinite(obj.processStartMs) ||
    obj.processStartMs < 946_684_800_000 ||
    obj.processStartMs > Number.MAX_SAFE_INTEGER
  ) {
    throw new Error(
      `cli-runtime-sidecar: invalid processStartMs ${String(obj.processStartMs)}`,
    );
  }

  // argvSha256 — exactly 64 hex chars (SHA-256). The format check
  // doubles as a regression canary: if the writer ever emits a base64
  // digest or a truncated prefix, the loader catches it.
  if (
    typeof obj.argvSha256 !== "string" ||
    obj.argvSha256.length !== SHA256_HEX_LENGTH ||
    !/^[0-9a-f]+$/.test(obj.argvSha256)
  ) {
    throw new Error(`cli-runtime-sidecar: invalid argvSha256 (must be 64-char lowercase hex)`);
  }

  return {
    schemaVersion: SIDECAR_SCHEMA_VERSION,
    pid: obj.pid,
    processStartMs: obj.processStartMs,
    argvSha256: obj.argvSha256,
  };
}

/**
 * Shared assertion for the producer-side validation in
 * {@link writeRuntimeSidecar}. Runs the same shape checks the loader
 * uses — a defect-equivalent guarantee at both ends of the contract
 * (AP-3 spirit applied to runtime).
 */
function assertValidRuntimeSidecarPayload(payload: RuntimeSidecarPayload): void {
  // Reuse the parser by round-tripping through JSON. Cheap and the
  // single source of truth for "what does the contract accept."
  parseRuntimeSidecarPayload(JSON.parse(JSON.stringify(payload)));
}
