/**
 * Operator-editable model registry — metadata overlay (Council Plan Task 1).
 *
 * Externalises per-model `status`/`replacement`/`tier`/`riskFlags` into an
 * operator-owned file (`~/.companion/models.json`) so a model's arrival or
 * retirement is a config edit, not a code release. This module is a PURE
 * `lookup` overlay: it does NOT list models (the dynamic Anthropic
 * `/v1/models` fetch and the Codex `models_cache.json` remain the two
 * catalog sources). Callers enrich each already-listed model by keying it
 * here (Task 3 for the REST surface; Tasks 4/5 for the failover resolvers).
 *
 * --- Bundled default is an in-code constant, NOT a packaged JSON file ---
 *
 * Council Plan Task 12 sketched a `models.json` shipped under
 * `__COMPANION_PACKAGE_ROOT`. We instead bundle the default as the
 * {@link BUNDLED_MODEL_REGISTRY} TS constant — the same robustness rationale
 * `observer-prompt-bundled.ts` follows: a compiled-in default can never be
 * missing, mis-resolved (`process.cwd()` vs package root), or omitted from a
 * build artifact. This resolves the plan's External Setup #2 by construction
 * — there is no file to package and no path to resolve for the default. The
 * ONLY file this module reads is the operator OVERRIDE.
 *
 * --- Negative-space (deliberately absent) ---
 *
 * - **Never writes.** The file is operator-owned. No `writeAtomicJson`, no
 *   create-on-missing — absence is a first-class "use bundled" signal.
 * - **No `fs.watch`.** Reload is read-on-access mtime poll (Plan External
 *   Setup #1) so an operator edit is no-restart/no-redeploy without a watcher
 *   pre-scan reconcile (EC-12 does not apply).
 * - **Does not absorb the catalog.** A registry-only id that is not in the
 *   served list will not appear — the registry annotates, it does not list.
 */

import { readFileSync, statSync, realpathSync } from "node:fs";
import { join, resolve as resolvePath, sep } from "node:path";
import { COMPANION_HOME } from "./paths.js";
import { log } from "./logger.js";
import type { BackendType } from "./session-types.js";

// ── Schema versioning (Persistence P8) ──────────────────────────────────────

/**
 * On-disk schema version. Strict equality on read — any other value (or
 * absence) makes the WHOLE file a loud bundled fallback (EC-17 fail-CLOSED).
 * A future format ships as v2 with a separate parser branch; v1 is never
 * silently migrated.
 */
export const MODEL_REGISTRY_SCHEMA_VERSION = 1 as const;

// ── Status union (writer + reader co-located, AP-3) ─────────────────────────

/**
 * Lifecycle status of a model in the registry.
 * - `active`    — offered normally.
 * - `degraded`  — offered, but UI marks it (still launchable).
 * - `retired`   — model_not_found upstream; suppress + suggest replacement.
 * - `blocked`   — region/policy/export-control blocked; suppress, never retry.
 */
export type ModelStatus = "active" | "degraded" | "retired" | "blocked";

/** Recognised status values. EC-20 single-source set; the parser tests against this. */
export const MODEL_STATUSES: ReadonlySet<ModelStatus> = new Set<ModelStatus>([
  "active",
  "degraded",
  "retired",
  "blocked",
]);

/**
 * Most-restrictive status — the fail-CLOSED default when a registry entry has
 * a valid id+backend but an unrecognised/missing `status`. We coerce to
 * `blocked` rather than skipping (which would fail OPEN: an unannotated id is
 * treated as `active`). A typo in `status` makes the model vanish loudly,
 * never silently resurrect. Cross-ref user memory
 * `feedback_validate_replacement_before_destroying_working_resource` family
 * (fail toward the safe state).
 */
export const MOST_RESTRICTIVE_STATUS: ModelStatus = "blocked";

// ── Entry shape (writer + reader co-located, AP-3) ──────────────────────────

/**
 * One registry entry, keyed by `(backend, id)`. `replacement` is the model id
 * to substitute when this one is `retired`/`blocked` (a single hop — the
 * resolver caps cascades). `tier` powers the no-cross-tier failover guard.
 * `riskFlags` are operator-internal annotations — NEVER echoed to the client
 * payload (Hunt REC-4, Task 3) and never logged verbatim (Plan Risk Hunt
 * REC-3).
 */
export interface ModelRegistryEntry {
  id: string;
  backend: BackendType;
  status: ModelStatus;
  replacement: string | null;
  tier?: string;
  riskFlags?: string[];
}

/** On-disk file shape. Co-located with the reader (AP-3) even though Aura never writes it. */
export interface ModelRegistryFile {
  schema_version: typeof MODEL_REGISTRY_SCHEMA_VERSION;
  models: ModelRegistryEntry[];
}

/**
 * A fully-loaded registry: parsed entries keyed by `${backend}\0${id}`, plus
 * the provenance of the load. `source: "bundled"` means either the override
 * file was absent (ENOENT) or it failed loudly and we fell back.
 */
export interface LoadedModelRegistry {
  source: "disk" | "bundled";
  entries: ReadonlyMap<string, ModelRegistryEntry>;
}

// ── Disk artifact location (EC-20 path-as-constant) ─────────────────────────

/** Override filename. Never constructed inline. */
export const MODEL_REGISTRY_FILENAME = "models.json";

/** Resolved absolute path to the operator override. Honours `COMPANION_HOME`. */
export const MODEL_REGISTRY_PATH = join(COMPANION_HOME, MODEL_REGISTRY_FILENAME);

/**
 * EC-23 sentinel for the registry path in structured logs — raw filesystem
 * bytes (operator username, project name) never egress via log lines.
 */
export const MODEL_REGISTRY_LOG_LABEL = "<companion-config:model-registry>" as const;

// ── Validation primitives (mirrors anthropic-models-cache.ts) ───────────────

/** Bound for the `value`/id that flows into CLI argv (Hunt REC-1 + Subprocess R1). */
const MODEL_ID_MAX_LEN = 128;

/** Bound for display/annotation strings (tier, risk flags). */
const MODEL_LABEL_MAX_LEN = 256;

/** Cap on registry entries — a runaway override file cannot blow up memory. */
const MAX_REGISTRY_ENTRIES = 256;

/** Cap on per-entry risk flags. */
const MAX_RISK_FLAGS = 16;

/**
 * Claude model-id allowlist — identical to `anthropic-models-cache.ts`
 * `CLAUDE_MODEL_ID_RE`. Leading `claude-` makes an argv-flag injection
 * (leading `-`) impossible by construction.
 */
const CLAUDE_MODEL_ID_RE = /^claude-[a-z0-9.\-]+$/;

/**
 * Codex model-id allowlist. Must start with an alphanumeric — defeats the
 * leading-`-` argv-flag injection without pinning to the `gpt-` prefix
 * (Codex's cache may surface non-`gpt` slugs).
 */
const CODEX_MODEL_ID_RE = /^[a-z0-9][a-z0-9._\-]*$/;

/**
 * Pure: reject CR/LF/NUL/C0/C1/DEL + Unicode bidi controls (Trojan-Source,
 * CVE-2021-42574). Copied from `anthropic-models-cache.ts` so every byte that
 * can reach a banner or log line is filtered at ingest.
 */
function isBoundedSafeString(s: unknown, maxLen: number): s is string {
  if (typeof s !== "string") return false;
  if (s.length === 0 || s.length > maxLen) return false;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code < 0x20) return false; // C0 controls (incl. tab, newline, CR)
    if (code === 0x7f) return false; // DEL
    if (code >= 0x80 && code <= 0x9f) return false; // C1 controls
    if (code >= 0x202a && code <= 0x202e) return false; // bidi LRE/RLE/PDF/LRO/RLO
    if (code >= 0x2066 && code <= 0x2069) return false; // bidi LRI/RLI/FSI/PDI
  }
  return true;
}

/**
 * Pure: is `id` a structurally-safe, injection-safe model id for `backend`?
 * The resolver re-runs this on any id it is about to emit into argv (Plan
 * Task 2) so the registry can never be the source of an unvalidated spawn arg.
 */
export function isValidModelIdForBackend(backend: BackendType, id: unknown): id is string {
  if (!isBoundedSafeString(id, MODEL_ID_MAX_LEN)) return false;
  return backend === "codex" ? CODEX_MODEL_ID_RE.test(id) : CLAUDE_MODEL_ID_RE.test(id);
}

// ── Bundled default (in-code constant) ──────────────────────────────────────

/**
 * Zero-config default. Mirrors today's offered models (the static
 * `CLAUDE_MODELS`/`CODEX_MODELS` in `web/src/utils/backends.ts`) all marked
 * `active` — so with no override file the offered set matches today's
 * behaviour exactly (spec Story 1 zero-config parity). `tier` is the only
 * load-bearing optional field (powers the no-cross-tier failover guard);
 * operators edit this set by dropping a `models.json` that replaces entries
 * by id.
 */
export const BUNDLED_MODEL_REGISTRY: readonly ModelRegistryEntry[] = Object.freeze([
  { id: "claude-opus-4-8", backend: "claude", status: "active", replacement: null, tier: "max" },
  { id: "claude-sonnet-4-6", backend: "claude", status: "active", replacement: null, tier: "balanced" },
  { id: "claude-haiku-4-5-20251001", backend: "claude", status: "active", replacement: null, tier: "fast" },
  { id: "gpt-5.3-codex", backend: "codex", status: "active", replacement: null, tier: "max" },
  { id: "gpt-5.2-codex", backend: "codex", status: "active", replacement: null, tier: "balanced" },
  { id: "gpt-5.1-codex-max", backend: "codex", status: "active", replacement: null, tier: "max" },
  { id: "gpt-5.2", backend: "codex", status: "active", replacement: null, tier: "balanced" },
  { id: "gpt-5.1-codex-mini", backend: "codex", status: "active", replacement: null, tier: "fast" },
] as const);

// ── Per-entry parser (drops/coerces individually, never throws) ─────────────

/** Map key for `(backend, id)`. NUL separator can never appear in a valid id. */
export function registryKey(backend: BackendType, id: string): string {
  return `${backend}\0${id}`;
}

function isBackendType(v: unknown): v is BackendType {
  return v === "claude" || v === "codex";
}

/**
 * Pure: validate one raw entry into a `ModelRegistryEntry`, or `null` to skip.
 *
 * Fail-CLOSED discipline (EC-17):
 * - Unkeyable entry (bad/missing `backend`, or `id` failing the per-backend
 *   validator) → **skip** (we literally cannot key it; spec Story 1).
 * - Keyable id but missing/invalid `status` → **keep**, coerce to
 *   {@link MOST_RESTRICTIVE_STATUS}. Skipping here would fail OPEN (absent ⇒
 *   treated active); coercing makes a typo vanish the model loudly instead.
 * - Invalid `replacement` → coerce to `null` (no auto-substitution is the
 *   safe default; a bad replacement id must never reach argv).
 * - Invalid `tier`/`riskFlags` → drop the field.
 *
 * `warn(reason)` is called for every coercion/skip so the operator sees why.
 */
export function parseRegistryEntry(
  raw: unknown,
  warn: (reason: string, detail?: Record<string, unknown>) => void,
): ModelRegistryEntry | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    warn("entry-not-object");
    return null;
  }
  const r = raw as Record<string, unknown>;

  if (!isBackendType(r.backend)) {
    warn("entry-bad-backend");
    return null;
  }
  const backend = r.backend;

  if (!isValidModelIdForBackend(backend, r.id)) {
    warn("entry-bad-id", { backend });
    return null;
  }
  const id = r.id;

  let status: ModelStatus;
  if (typeof r.status === "string" && MODEL_STATUSES.has(r.status as ModelStatus)) {
    status = r.status as ModelStatus;
  } else {
    warn("entry-bad-status-coerced-blocked", { id });
    status = MOST_RESTRICTIVE_STATUS;
  }

  let replacement: string | null = null;
  if (r.replacement !== null && r.replacement !== undefined) {
    if (isValidModelIdForBackend(backend, r.replacement)) {
      replacement = r.replacement;
    } else {
      warn("entry-bad-replacement-dropped", { id });
    }
  }

  const entry: ModelRegistryEntry = { id, backend, status, replacement };

  if (r.tier !== undefined) {
    if (isBoundedSafeString(r.tier, MODEL_LABEL_MAX_LEN)) {
      entry.tier = r.tier;
    } else {
      warn("entry-bad-tier-dropped", { id });
    }
  }

  if (r.riskFlags !== undefined) {
    if (
      Array.isArray(r.riskFlags) &&
      r.riskFlags.length <= MAX_RISK_FLAGS &&
      r.riskFlags.every((f) => isBoundedSafeString(f, MODEL_LABEL_MAX_LEN))
    ) {
      entry.riskFlags = r.riskFlags as string[];
    } else {
      warn("entry-bad-riskflags-dropped", { id });
    }
  }

  return entry;
}

// ── Whole-file parser (outcome union, never throws into caller) ─────────────

/**
 * Outcome of {@link parseModelRegistryFile}. A `loaded` result may still have
 * dropped/coerced individual entries (logged per-entry). A non-`loaded`
 * result means the WHOLE file is unusable → caller falls back to bundled
 * (EC-17), keeping every malformed-file mode out of the live path.
 */
/** Whole-file rejection reasons — shared by the pure parser and the disk reader. */
export type RegistryRejectReason = "not-object" | "schema-version" | "no-models-array" | "too-many";

export type ParseRegistryResult =
  | { kind: "loaded"; entries: ModelRegistryEntry[] }
  | { kind: "rejected"; reason: RegistryRejectReason };

/** Pure: parse + validate a raw (already-`JSON.parse`d) override. Never throws. */
export function parseModelRegistryFile(raw: unknown): ParseRegistryResult {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { kind: "rejected", reason: "not-object" };
  }
  const file = raw as Partial<ModelRegistryFile>;
  if (file.schema_version !== MODEL_REGISTRY_SCHEMA_VERSION) {
    return { kind: "rejected", reason: "schema-version" };
  }
  if (!Array.isArray(file.models)) {
    return { kind: "rejected", reason: "no-models-array" };
  }
  if (file.models.length > MAX_REGISTRY_ENTRIES) {
    return { kind: "rejected", reason: "too-many" };
  }

  const entries: ModelRegistryEntry[] = [];
  let index = 0;
  for (const rawEntry of file.models) {
    const at = index++;
    const entry = parseRegistryEntry(rawEntry, (reason, detail) => {
      log.warn("model-registry", "entry-dropped", {
        event: "model-registry.entry-dropped",
        file: MODEL_REGISTRY_LOG_LABEL,
        reason,
        index: at,
        ...detail,
      });
    });
    if (entry !== null) entries.push(entry);
  }
  return { kind: "loaded", entries };
}

// ── Disk read (EC-7 bounded, outcome union) ─────────────────────────────────

export type DiskRegistryResult =
  | { kind: "loaded"; entries: ModelRegistryEntry[] }
  | { kind: "enoent" }
  | { kind: "rejected"; reason: RegistryRejectReason }
  | { kind: "read-error"; code: string };

/**
 * EC-7 defensive realpath bounds check. The path is a fixed constant under
 * {@link COMPANION_HOME}, so traversal is impossible by construction, but the
 * convention floor mandates the wrapper against future refactors that make
 * the path dynamic. Returns the file contents, or a typed non-throwing signal.
 */
function readRegistryFileBounded(): { ok: true; raw: string } | { ok: false; code: string } {
  let homeCanonical: string;
  try {
    homeCanonical = realpathSync(COMPANION_HOME);
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code;
    // First-run / missing home → the override cannot exist yet. Treat as ENOENT.
    if (code === "ENOENT") return { ok: false, code: "ENOENT" };
    return { ok: false, code: code ?? "REALPATH_ERROR" };
  }
  const joined = resolvePath(homeCanonical, MODEL_REGISTRY_FILENAME);
  if (joined === homeCanonical || !joined.startsWith(homeCanonical + sep)) {
    return { ok: false, code: "PATH_ESCAPE" };
  }
  try {
    return { ok: true, raw: readFileSync(MODEL_REGISTRY_PATH, "utf8") };
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code;
    return { ok: false, code: code ?? "READ_ERROR" };
  }
}

/** Read + parse the override file. Never throws; ENOENT is a normal outcome. */
export function readModelRegistryFromDisk(): DiskRegistryResult {
  const read = readRegistryFileBounded();
  if (!read.ok) {
    if (read.code === "ENOENT") return { kind: "enoent" };
    return { kind: "read-error", code: read.code };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(read.raw);
  } catch {
    return { kind: "rejected", reason: "not-object" };
  }
  const result = parseModelRegistryFile(parsed);
  if (result.kind === "rejected") return { kind: "rejected", reason: result.reason };
  return { kind: "loaded", entries: result.entries };
}

// ── Merge (disk replaces bundled by key, wholesale) ─────────────────────────

/**
 * Pure: build the keyed map from bundled defaults then apply disk entries —
 * a disk entry REPLACES the bundled entry of the same `(backend, id)`
 * wholesale (no field-level merge).
 */
export function mergeRegistry(
  bundled: readonly ModelRegistryEntry[],
  disk: readonly ModelRegistryEntry[],
): Map<string, ModelRegistryEntry> {
  const map = new Map<string, ModelRegistryEntry>();
  for (const e of bundled) map.set(registryKey(e.backend, e.id), e);
  for (const e of disk) map.set(registryKey(e.backend, e.id), e);
  return map;
}

// ── Cached accessor (read-on-access mtime poll, never throws) ───────────────

interface RegistryCache {
  loaded: LoadedModelRegistry;
  /** Disk mtime in ms, or `null` when the override is absent. */
  diskMtimeMs: number | null;
}

let cache: RegistryCache | null = null;

function buildBundledOnly(): LoadedModelRegistry {
  return { source: "bundled", entries: mergeRegistry(BUNDLED_MODEL_REGISTRY, []) };
}

/**
 * Stat the override; reload only when its mtime changed since the cached
 * load (or it appeared/disappeared). Cheap enough to call per request — one
 * `statSync`. Returns the cached registry on a no-change poll.
 *
 * Never throws: any disk/parse failure logs and falls back to the bundled
 * default (EC-17). A present-but-broken override is loud (WARN) but still
 * yields a usable registry — the server is never crashed by config.
 */
export function getModelRegistry(): LoadedModelRegistry {
  let diskMtimeMs: number | null;
  try {
    diskMtimeMs = statSync(MODEL_REGISTRY_PATH).mtimeMs;
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code;
    diskMtimeMs = null;
    if (code !== "ENOENT") {
      log.warn("model-registry", "stat-failed", {
        event: "model-registry.stat-failed",
        file: MODEL_REGISTRY_LOG_LABEL,
        code: code ?? "unknown",
      });
    }
  }

  if (cache !== null && cache.diskMtimeMs === diskMtimeMs) {
    return cache.loaded;
  }

  // Absent override → bundled only.
  if (diskMtimeMs === null) {
    const loaded = buildBundledOnly();
    cache = { loaded, diskMtimeMs: null };
    return loaded;
  }

  const disk = readModelRegistryFromDisk();
  let loaded: LoadedModelRegistry;
  if (disk.kind === "loaded") {
    loaded = { source: "disk", entries: mergeRegistry(BUNDLED_MODEL_REGISTRY, disk.entries) };
    log.info("model-registry", "loaded", {
      event: "model-registry.loaded",
      file: MODEL_REGISTRY_LOG_LABEL,
      source: "disk",
      disk_entry_count: disk.entries.length,
    });
  } else {
    loaded = buildBundledOnly();
    // EC-17: whole-file failure is loud, but we still serve the safe bundled
    // default rather than crashing.
    log.warn("model-registry", "override-unusable-bundled-fallback", {
      event: "model-registry.bundled-fallback",
      file: MODEL_REGISTRY_LOG_LABEL,
      reason:
        disk.kind === "rejected"
          ? disk.reason
          : disk.kind === "read-error"
            ? `read-error:${disk.code}`
            : "enoent-after-stat",
    });
  }
  cache = { loaded, diskMtimeMs };
  return loaded;
}

/**
 * Look up a single model's registry entry, or `null` when the model is not in
 * the registry (an unannotated model is offered normally — the overlay only
 * narrows/annotates, it never adds). Drives the Task 2 resolver + Task 3
 * enrichment.
 */
export function lookupModel(backend: BackendType, id: string): ModelRegistryEntry | null {
  return getModelRegistry().entries.get(registryKey(backend, id)) ?? null;
}

/** Test-only: drop the cached registry so the next access re-polls disk. */
export function __resetModelRegistryCacheForTests(): void {
  cache = null;
}
