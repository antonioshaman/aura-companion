// AURA-LOCAL
// Per-terminal provenance sidecar — `<terminalId>.terminal.json`. Resource-
// reclamation plan Task 2 (sibling of `cli-runtime-sidecar.ts`).
//
// Why: PTY terminals (`terminal-manager.ts`) live in an in-memory
// `instances` Map keyed by `randomUUID()`. That Map dies with the bun
// parent, so after a `KillMode=process` restart the spawned shell (or
// `docker exec` client) survives, reparented to init, with NO record in
// the new process telling the boot-reconcile pass it exists. The 5s
// in-memory `orphanTimer` that would have reaped it is gone. Result: a
// leaked host shell per restart.
//
// This sidecar is the persisted provenance the boot-reconcile reaper reads
// to find + verify those stranded terminals. It is NOT a liveness cache —
// `verifyProcessIdentityByArgv` over `/proc` remains authoritative. The
// sidecar only answers "did WE spawn a terminal with this pid + start
// anchor + argv shape", so a reaper never SIGTERMs a PID we don't own.
//
// AP-3 (council-types.ts pattern): writer + reader + parser + lister
// colocated in ONE file so the schema lives in one place.
//
// EC-5: the loader runtime-validates EVERY field — a typed cast is never
// trusted. Malformed-but-parses-as-JSON THROWS; a missing file returns
// the `"absent"` variant (mirrors `cli-runtime-sidecar.ts`).
//
// EC-7: every path is derived via `resolveCleanupPath` (realpath +
// bounds-check) before any fs touch.

import { readFileSync, readdirSync, unlinkSync } from "node:fs";
import { writeAtomicJson } from "./atomic-write.js";
import { resolveCleanupPath, REAPING_SENTINEL_SUBDIR } from "./cleanup/cleanup-paths.js";
import { argvSha256 } from "./cli-runtime-sidecar.js";

/** Schema baseline. v1 — bump + extend the parser per EC-5 on any change. */
export const TERMINAL_SIDECAR_SCHEMA_VERSION = 1 as const;

/** Filename suffix appended to `<terminalId>`. */
export const TERMINAL_SIDECAR_FILE_SUFFIX = ".terminal.json" as const;

/** SHA-256 hex output length. */
const SHA256_HEX_LENGTH = 64;

/** Bound on the UUID-shaped terminalId — defends the resolver + filename. */
const TERMINAL_ID_MAX_LENGTH = 128;

/**
 * Spawn shape of the terminal. `host` = `[shell, "-l"]` spawned directly;
 * `docker` = `docker exec -i -t -w <cwd> <containerId> sh -lc '...'`. The
 * reaper uses this to pick kill semantics: for `docker`, `pid` is the
 * HOST-side `docker exec` client (FLAG B) — killing it releases the host
 * resource; the in-container shell is the container's lifecycle problem.
 */
export type TerminalSpawnKind = "host" | "docker";

/**
 * On-disk payload shape. Frozen at v1.
 *
 * `pid` — OS pid of the spawned process at launch (host shell or the
 * host-side docker-exec client).
 * `processStartMs` — kernel process-start instant (via `readProcessStartMs`)
 * captured at spawn, compared with ±2s tolerance by the verifier. Closes
 * PID-reuse across restarts.
 * `argvSha256` — SHA-256 of NUL-joined spawn argv; the reaper recomputes
 * from `/proc/<pid>/cmdline` and compares (exact content fingerprint).
 * `kind` — host vs docker, drives the reaper's kill-semantics branch.
 */
export interface TerminalSidecarPayload {
  readonly schemaVersion: typeof TERMINAL_SIDECAR_SCHEMA_VERSION;
  readonly terminalId: string;
  readonly pid: number;
  readonly processStartMs: number;
  readonly argvSha256: string;
  readonly kind: TerminalSpawnKind;
}

/**
 * Loader result. `present` = valid v1 payload; `absent` = ENOENT (the
 * terminal was cleanly torn down, or never had a sidecar). Corrupt-present
 * is NOT a variant — it THROWS (explicit-intent contract).
 */
export type TerminalSidecarResult =
  | { readonly kind: "present"; readonly payload: TerminalSidecarPayload }
  | { readonly kind: "absent" };

/** Re-export the shared argv hasher so spawn sites have one import. */
export { argvSha256 };

function assertValidTerminalId(terminalId: string): void {
  if (
    typeof terminalId !== "string" ||
    terminalId.length === 0 ||
    terminalId.length > TERMINAL_ID_MAX_LENGTH
  ) {
    throw new Error("terminal-runtime-sidecar: invalid terminalId");
  }
}

/**
 * Build the EC-7-resolved absolute path of the sidecar file. Routes
 * through `resolveCleanupPath` so realpath + bounds-check happen at one
 * site. The `.reaping` subdir is reserved for reap sentinels and must
 * never collide with a terminalId-derived filename.
 */
export function terminalSidecarPath(terminalsRoot: string, terminalId: string): string {
  assertValidTerminalId(terminalId);
  if (terminalId === REAPING_SENTINEL_SUBDIR) {
    throw new Error("terminal-runtime-sidecar: terminalId collides with reserved subdir");
  }
  return resolveCleanupPath(terminalsRoot, `${terminalId}${TERMINAL_SIDECAR_FILE_SUFFIX}`);
}

/**
 * Write the sidecar atomically. Caller pattern: capture `processStartMs`
 * via `readProcessStartMs(pid)` immediately after `Bun.spawn` returns,
 * hash the spawn argv, call this once.
 *
 * Throws on resolver violation or atomic-write failure — the spawn site
 * decides whether to treat a failed sidecar write as fatal (it should
 * NOT: the in-memory orphanTimer still covers the live case; the sidecar
 * only adds restart-survival).
 */
export function writeTerminalSidecar(
  terminalsRoot: string,
  payload: TerminalSidecarPayload,
): string {
  assertValidTerminalSidecarPayload(payload);
  const target = terminalSidecarPath(terminalsRoot, payload.terminalId);
  writeAtomicJson(target, payload);
  return target;
}

/**
 * Load + runtime-validate the sidecar. ENOENT → `{kind:"absent"}`. Any
 * other read error (EACCES, EISDIR, EIO) → THROW. Malformed-but-JSON →
 * THROW via the strict validator.
 */
export function readTerminalSidecar(
  terminalsRoot: string,
  terminalId: string,
): TerminalSidecarResult {
  const target = terminalSidecarPath(terminalsRoot, terminalId);
  let raw: string;
  try {
    raw = readFileSync(target, "utf8");
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ENOENT") return { kind: "absent" };
    throw err;
  }
  const parsed: unknown = JSON.parse(raw);
  return { kind: "present", payload: parseTerminalSidecarPayload(parsed) };
}

/**
 * Best-effort delete on clean teardown (kill / proc exit). ENOENT is
 * silent — a double-delete (orphanTimer + proc.exited both firing) is a
 * no-op, not an error.
 */
export function deleteTerminalSidecar(terminalsRoot: string, terminalId: string): void {
  const target = terminalSidecarPath(terminalsRoot, terminalId);
  try {
    unlinkSync(target);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}

/**
 * Enumerate terminalIds with a sidecar on disk. The boot-reconcile pass
 * is the sole consumer — there is no other enumerator for terminals
 * (unlike sessions, which session-store enumerates). A missing root dir
 * returns `[]` (no terminals were ever spawned, or the dir was swept).
 */
export function listTerminalSidecarIds(terminalsRoot: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(terminalsRoot);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  const ids: string[] = [];
  for (const name of entries) {
    if (!name.endsWith(TERMINAL_SIDECAR_FILE_SUFFIX)) continue;
    const id = name.slice(0, -TERMINAL_SIDECAR_FILE_SUFFIX.length);
    if (id.length > 0) ids.push(id);
  }
  return ids;
}

/**
 * Pure runtime-validator. Accepts `unknown`, returns the narrowed payload
 * OR throws naming the failed field. EC-5: every field checked; cast
 * never trusted.
 */
export function parseTerminalSidecarPayload(input: unknown): TerminalSidecarPayload {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("terminal-runtime-sidecar: payload must be a JSON object");
  }
  const obj = input as Record<string, unknown>;

  if (obj.schemaVersion !== TERMINAL_SIDECAR_SCHEMA_VERSION) {
    throw new Error(
      `terminal-runtime-sidecar: unexpected schemaVersion ${String(obj.schemaVersion)} (expected ${TERMINAL_SIDECAR_SCHEMA_VERSION})`,
    );
  }

  if (
    typeof obj.terminalId !== "string" ||
    obj.terminalId.length === 0 ||
    obj.terminalId.length > TERMINAL_ID_MAX_LENGTH
  ) {
    throw new Error(`terminal-runtime-sidecar: invalid terminalId ${String(obj.terminalId)}`);
  }

  // pid — positive integer in the typical kernel range (PID_MAX_LIMIT
  // 4_194_304; cap at 2^31-1 to also reject MAX_SAFE_INTEGER accidents).
  if (
    typeof obj.pid !== "number" ||
    !Number.isInteger(obj.pid) ||
    obj.pid <= 0 ||
    obj.pid > 2_147_483_647
  ) {
    throw new Error(`terminal-runtime-sidecar: invalid pid ${String(obj.pid)}`);
  }

  // processStartMs — positive wallclock ms above the year-2000 floor.
  if (
    typeof obj.processStartMs !== "number" ||
    !Number.isFinite(obj.processStartMs) ||
    obj.processStartMs < 946_684_800_000 ||
    obj.processStartMs > Number.MAX_SAFE_INTEGER
  ) {
    throw new Error(
      `terminal-runtime-sidecar: invalid processStartMs ${String(obj.processStartMs)}`,
    );
  }

  if (
    typeof obj.argvSha256 !== "string" ||
    obj.argvSha256.length !== SHA256_HEX_LENGTH ||
    !/^[0-9a-f]+$/.test(obj.argvSha256)
  ) {
    throw new Error("terminal-runtime-sidecar: invalid argvSha256 (must be 64-char lowercase hex)");
  }

  if (obj.kind !== "host" && obj.kind !== "docker") {
    throw new Error(`terminal-runtime-sidecar: invalid kind ${String(obj.kind)}`);
  }

  return {
    schemaVersion: TERMINAL_SIDECAR_SCHEMA_VERSION,
    terminalId: obj.terminalId,
    pid: obj.pid,
    processStartMs: obj.processStartMs,
    argvSha256: obj.argvSha256,
    kind: obj.kind,
  };
}

/** Producer-side validation — same checks as the loader (AP-3 spirit). */
function assertValidTerminalSidecarPayload(payload: TerminalSidecarPayload): void {
  parseTerminalSidecarPayload(JSON.parse(JSON.stringify(payload)));
}
