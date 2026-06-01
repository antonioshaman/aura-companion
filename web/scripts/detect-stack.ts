#!/usr/bin/env bun
// Auto-stack-detection for council router slash commands (Tasks 1–5 of
// `.council/abtest/v2-router-plan.md`).
//
// Pure synchronous detector. Reads workspace markers, returns a discriminated
// union telling the calling skill whether to dispatch the Aura council,
// the Python council, refuse loudly on ambiguity, or refuse loudly on unknown.
//
// Convention notes (conventions.md):
// - EC-7 / EC-36 (filesystem-access predicates inline path resolution OR are
//   exposed only via a resolving wrapper): the per-marker probes all go
//   through `resolveMarker`, which realpath-resolves the workspace root once
//   and bounds-checks every marker path, refusing symlink leaves outright.
//   `enumerateCandidatePrefixes` is the EC-36 option (b) exception: it
//   inlines the equivalent discipline at the access site and documents each
//   present + intentionally-omitted check in its function header — wrapping
//   it through `resolveMarker` would silently drop A4-class lstat failures
//   via the wrapper's `existsSync`-first fallback.
// - No silent fallback (spec AC-3.3): every failure mode becomes a structured
//   result — never crashes the caller, never silently downgrades "malformed"
//   to "absent".
//
// Exported surface — also consumed by the Phase 0 SKILL.md mirror discipline:
//   detectStack(workspaceRoot) → DetectionResult
//   renderRefusal(result) → string
//   MARKER_NAMES, OVERRIDE_VALUES, REFUSAL_HEADLINES — closed allow-lists

import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { join, resolve, sep } from "node:path";

// =============================================================================
// Closed allow-lists — single source of truth for marker names + override
// values. The three SKILL.md Phase 0 mirror blocks cite these verbatim;
// the `detect-stack.skill-mirror.test.ts` snapshot test locks them in sync.
// =============================================================================

export const MARKER_NAMES = {
  AURA_PACKAGE_NAME: "web/package.json:name=aura-companion",
  AURA_PACKAGE_HONO: "web/package.json:dependencies.hono",
  AURA_WS_BRIDGE: "web/server/ws-bridge.ts",
  PYTHON_PYPROJECT_AIOGRAM: "pyproject.toml:aiogram",
  PYTHON_REQS_AIOGRAM: "requirements.txt:^aiogram + bot/",
  OVERRIDE: ".council-stack-override",
} as const;

export const OVERRIDE_VALUES = ["aura", "python"] as const;
export type OverrideValue = (typeof OVERRIDE_VALUES)[number];

export const REFUSAL_HEADLINES = {
  unknown: "Stack detection: no recognised stack markers at workspace root.",
  ambiguous: "Stack detection: both Aura and Python markers present.",
  override_malformed:
    "Stack detection: .council-stack-override is malformed.",
  override_conflict:
    "Stack detection: .council-stack-override conflicts with auto-detected markers.",
} as const;

// Size caps per marker (bytes). Plan §3.
const SIZE_CAP = {
  PACKAGE_JSON: 16 * 1024,
  PYPROJECT: 64 * 1024,
  REQUIREMENTS: 64 * 1024,
  OVERRIDE: 1024,
} as const;

// Depth-1 subdir scan (monorepo support, council-stack-autodetect-monorepo spec).
// SPECIFICITY INVARIANT: this widens the SEARCH SCOPE (where we look) without
// loosening individual marker semantics. `web/package.json:name=aura-companion`
// is still matched only by literal `name === "aura-companion"`; aiogram is
// still matched only by literal substring / `^aiogram\b` line — never by
// directory naming heuristics (`bot/` ≠ Python signal on its own) or partial
// substrings. The skip-list excludes dirs that produce false positives or
// blow the per-call budget.
//
// DISCLOSURE SURFACE: depth-1 subdir names that pass the filter appear in the
// refusal output (via probed marker paths like `<subdir>/package.json`). Users
// who paste a refusal into a public bug report leak the names of any
// project-shaped subdir at the workspace root. Refusal text never echoes
// FILE CONTENT (see `feedback never echoes raw file content` test) — but
// path bytes including directory NAMES do appear. Keep dir-name disclosure
// in mind when changing what enumeration surfaces.
export const SKIP_SUBDIRS = new Set<string>([
  "node_modules",
  ".git",
  ".husky",
  ".venv",
  "venv",
  ".env",
  "env",
  "dist",
  "build",
  "out",
  "target",
  ".next",
  ".turbo",
  ".cache",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".vscode",
  ".idea",
  ".council",
  ".agents",
  ".learnings",
]);
export const MAX_CANDIDATE_SUBDIRS = 64;

// =============================================================================
// Result shape
// =============================================================================

export type MarkerReason =
  | "json_parse"
  | "size_exceeded"
  | "out_of_bounds"
  | "symlink"
  | "read_error";

export interface MarkerCheck {
  name: string;
  path: string;
  present: boolean;
  parsed: boolean;
  matched: string[];
  reason?: MarkerReason;
}

export type DetectionKind =
  | "aura"
  | "python"
  | "ambiguous"
  | "unknown"
  | "override_conflict";

export interface DetectionResult {
  kind: DetectionKind;
  checked: MarkerCheck[];
  overrideUsed: boolean;
  overridePath: string | null;
  overrideMalformed: boolean;
  /** When kind === "override_conflict": the auto-detected kind that disagrees with override.value. */
  overrideConflictAutoDetected?: "aura" | "python" | "ambiguous";
  /** When kind === "override_conflict": the override-asserted value. */
  overrideConflictAsserted?: "aura" | "python";
  /**
   * True when the depth-1 subdir enumeration was capped at
   * {@link MAX_CANDIDATE_SUBDIRS} before all eligible subdirs were visited.
   * Surfaced in {@link renderRefusal} so users with very wide monorepo roots
   * see that the scan was incomplete — silent miss would mask the cap.
   */
  scanTruncated: boolean;
}

// =============================================================================
// Path resolution boundary (plan §2). Single entry: every marker read goes
// through `resolveMarker`, which is the EC-7 resolving wrapper.
// =============================================================================

type ResolveResult =
  | { ok: true; absolute: string }
  | { ok: false; reason: MarkerReason };

function resolveMarker(
  rootResolved: string,
  relativeMarker: string,
): ResolveResult {
  if (relativeMarker.startsWith("/") || relativeMarker.includes("..")) {
    return { ok: false, reason: "out_of_bounds" };
  }
  const candidate = join(rootResolved, relativeMarker);
  if (!existsSync(candidate)) {
    return { ok: true, absolute: candidate };
  }
  let lst;
  try {
    lst = lstatSync(candidate);
  } catch {
    return { ok: false, reason: "read_error" };
  }
  if (lst.isSymbolicLink()) {
    return { ok: false, reason: "symlink" };
  }
  let real;
  try {
    real = realpathSync(candidate);
  } catch {
    return { ok: false, reason: "read_error" };
  }
  if (real !== candidate && !real.startsWith(rootResolved + sep)) {
    return { ok: false, reason: "out_of_bounds" };
  }
  return { ok: true, absolute: candidate };
}

// =============================================================================
// Defensive marker reads (plan §3). Encoding always "utf8", BOM stripped,
// size cap enforced before read.
// =============================================================================

type ReadResult =
  | { ok: true; text: string }
  | { ok: false; reason: MarkerReason };

function readText(absolute: string, cap: number): ReadResult {
  try {
    const st = statSync(absolute);
    if (!st.isFile()) {
      return { ok: false, reason: "read_error" };
    }
    if (st.size > cap) {
      return { ok: false, reason: "size_exceeded" };
    }
  } catch {
    return { ok: false, reason: "read_error" };
  }
  let raw: string;
  try {
    raw = readFileSync(absolute, "utf8");
  } catch {
    return { ok: false, reason: "read_error" };
  }
  if (raw.charCodeAt(0) === 0xfeff) {
    raw = raw.slice(1);
  }
  return { ok: true, text: raw };
}

function isDirectory(absolute: string): boolean {
  try {
    const st = lstatSync(absolute);
    if (st.isSymbolicLink()) return false;
    return st.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Result of depth-1 subdir enumeration.
 *
 * - `prefixes` — the workspace-root marker ("") followed by accepted subdir
 *   names. Order is `readdirSync` order with `""` prepended.
 * - `enumeration` — synthetic MarkerChecks surfacing enumeration-level
 *   failures (`readdirSync` throw, per-entry `lstat` throw). Empty on the
 *   happy path. Distinct from per-marker probe failures so the refusal
 *   renderer can attribute them to the directory scan.
 * - `truncated` — true when {@link MAX_CANDIDATE_SUBDIRS} cap was hit
 *   before all eligible entries were visited.
 */
interface EnumerationResult {
  prefixes: string[];
  enumeration: MarkerCheck[];
  truncated: boolean;
}

// Enumerate depth-1 subdirs of the workspace root as relative prefixes to scan.
// Returns SUBDIR names only — workspace-root probes (pyproject.toml,
// requirements.txt + bot/) are dispatched separately by `detectStack` via
// `probe*AtRoot` helpers. The split between "subdir" and "root" probes is
// a Phase B refactor (commit <next>) that retired the `prefix === ""`
// sentinel hidden inside each probe — see commit message for details.
// Hidden dirs and SKIP_SUBDIRS members are excluded; symlinks are silently
// excluded; count is capped at MAX_CANDIDATE_SUBDIRS to bound the per-call
// probe budget — overflow surfaces via `truncated`.
//
// EC-36 compliance: this function does NOT route through `resolveMarker`
// even though `resolveMarker` is the canonical EC-7 wrapper for the rest
// of this file. The reason is intentional and load-bearing: `resolveMarker`
// uses `existsSync` first and swallows the EACCES/EIO/ENOENT class of
// errors as "absent" (returns `{ok: true}` with a path that doesn't
// resolve). That swallow is correct for per-marker probes — they already
// run an `existsSync` after — but it would silently drop A4-class
// per-entry lstat failures here. Instead we INLINE the complete equivalent
// discipline at the access site and name each present check explicitly,
// per EC-36 option (b):
//   (1) `name` comes from readdirSync's Dirent.name — Node guarantees it's
//       a single basename with no path separators, so `join(rootResolved,
//       name)` cannot escape rootResolved. No `..`/`/` reject needed at
//       this site (paranoia handled by readdir's API contract).
//   (2) `lstatSync` (not `statSync`) — does NOT follow symlinks.
//   (3) `lst.isSymbolicLink()` — silently rejects symlinks (EC-7 boundary
//       refusal, equivalent to resolveMarker's `symlink` reason).
//   (4) `lst.isDirectory()` — rejects files / sockets / pipes. Replaces
//       the old `entry.isDirectory()` check whose Dirent-type cache is
//       unreliable on `DT_UNKNOWN` filesystems (see Finding 12).
//   (5) `realpathSync` intentionally OMITTED — depth-1 candidates whose
//       lstat is non-symlink are by construction inside rootResolved;
//       no realpath traversal can change that. The bounds check that
//       resolveMarker performs (`real.startsWith(rootResolved + sep)`)
//       would be a tautology here.
//   (6) lstat catch surfaces as `read_error` (no silent fallback) —
//       distinguishes this site from resolveMarker's existsSync-swallow.
//
// Failures (readdirSync throw, per-entry lstat throw) surface as synthetic
// MarkerChecks on `enumeration` rather than silent skips, so the user sees
// "the scan tried but couldn't read this" in the refusal output. The
// no-silent-fallback invariant (file header) applies to enumeration as well
// as to per-marker probes.
function enumerateCandidatePrefixes(rootResolved: string): EnumerationResult {
  const prefixes: string[] = [];
  const enumeration: MarkerCheck[] = [];
  let entries;
  try {
    entries = readdirSync(rootResolved, { withFileTypes: true });
  } catch (err) {
    // A3 / no-silent-fallback: readdirSync failure (EACCES, EIO, ENOENT,
    // ENOTDIR) becomes a synthetic enumeration-level MarkerCheck surfaced in
    // the refusal under "Found at workspace root:". Stderr log carries the
    // underlying error message for operator debugging — wire body never does
    // (Hunt P3: no path bytes / errno text in user-facing output beyond the
    // structured `reason`).
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[detect-stack] readdirSync failed on workspace root: ${message}`,
    );
    enumeration.push({
      name: "<workspace>/ (directory scan)",
      path: "",
      present: true,
      parsed: false,
      matched: [],
      reason: "read_error",
    });
    return { prefixes, enumeration, truncated: false };
  }
  let scanned = 0;
  let truncated = false;
  for (const entry of entries) {
    if (scanned >= MAX_CANDIDATE_SUBDIRS) {
      truncated = true;
      break;
    }
    const name = entry.name;
    if (name.startsWith(".")) continue;
    if (SKIP_SUBDIRS.has(name)) continue;
    // Inline EC-36(b) discipline — see function header for the enumerated
    // checks. We do not pre-filter by `entry.isDirectory()` because the
    // Dirent-type cache is unreliable on DT_UNKNOWN filesystems (Finding 12);
    // the authoritative type comes from lstat below.
    const candidate = join(rootResolved, name);
    let lst;
    try {
      lst = lstatSync(candidate);
    } catch {
      // A4 / no-silent-fallback: per-entry lstat failure (EACCES on parent,
      // ENOENT race after readdir, EIO) becomes a synthetic MarkerCheck for
      // that prefix. Distinguishable from the silent symlink reject below
      // because failures and intentional refusals are different categories.
      // `path: ""` is intentional — the renderer's Found-section falls back
      // to `name` when path is empty, so the human-readable label
      // `<workspace>/<name> (lstat)` surfaces instead of the raw prefix.
      enumeration.push({
        name: `<workspace>/${name} (lstat)`,
        path: "",
        present: true,
        parsed: false,
        matched: [],
        reason: "read_error",
      });
      continue;
    }
    if (lst.isSymbolicLink()) continue; // EC-7 silent symlink reject.
    if (!lst.isDirectory()) continue; // not a directory — not a candidate.
    prefixes.push(name);
    scanned += 1;
  }
  return { prefixes, enumeration, truncated };
}

// =============================================================================
// Individual marker probes
// =============================================================================
//
// Each probe takes a fully-formed workspace-relative `relPath` and reads ONE
// concrete file. No sentinel-value branching, no per-call "is this the root
// variant?" ternary. The dispatcher in `detectStack` owns the decision of
// where to look — root vs subdir — and binds the `relPath` accordingly.
// This is Phase B (commit <next>) which retired the `prefix === ""` sentinel
// pattern; pre-Phase-B versions of these probes carried the sentinel
// inside each function and post-collected dedupe to clean up the double-probe
// when "web" was itself a depth-1 subdir.

/**
 * Probe a `package.json` for the Aura markers (name === "aura-companion",
 * dependencies.hono). Returns TWO MarkerChecks — one per marker — sharing
 * the same `path`.
 */
function probePackageJson(rootResolved: string, relPath: string): MarkerCheck[] {
  const r = resolveMarker(rootResolved, relPath);
  const both = (
    present: boolean,
    parsed: boolean,
    matchedName: boolean,
    matchedHono: boolean,
    reason?: MarkerReason,
  ): MarkerCheck[] => [
    {
      name: MARKER_NAMES.AURA_PACKAGE_NAME,
      path: relPath,
      present,
      parsed,
      matched: matchedName ? [MARKER_NAMES.AURA_PACKAGE_NAME] : [],
      ...(reason ? { reason } : {}),
    },
    {
      name: MARKER_NAMES.AURA_PACKAGE_HONO,
      path: relPath,
      present,
      parsed,
      matched: matchedHono ? [MARKER_NAMES.AURA_PACKAGE_HONO] : [],
      ...(reason ? { reason } : {}),
    },
  ];
  if (!r.ok) return both(true, false, false, false, r.reason);
  if (!existsSync(r.absolute)) return both(false, false, false, false);
  const read = readText(r.absolute, SIZE_CAP.PACKAGE_JSON);
  if (!read.ok) return both(true, false, false, false, read.reason);
  let pkg: unknown;
  try {
    pkg = JSON.parse(read.text);
  } catch {
    return both(true, false, false, false, "json_parse");
  }
  const obj = pkg && typeof pkg === "object" ? (pkg as Record<string, unknown>) : {};
  const nameMatched = obj["name"] === "aura-companion";
  const deps = obj["dependencies"];
  const honoMatched =
    deps !== null &&
    typeof deps === "object" &&
    "hono" in (deps as Record<string, unknown>);
  return both(true, true, nameMatched, honoMatched);
}

/** Probe for the Aura ws-bridge.ts file at a given workspace-relative path. */
function probeWsBridge(rootResolved: string, relPath: string): MarkerCheck {
  const r = resolveMarker(rootResolved, relPath);
  if (!r.ok) {
    return {
      name: MARKER_NAMES.AURA_WS_BRIDGE,
      path: relPath,
      present: true,
      parsed: false,
      matched: [],
      reason: r.reason,
    };
  }
  const present = existsSync(r.absolute);
  return {
    name: MARKER_NAMES.AURA_WS_BRIDGE,
    path: relPath,
    present,
    parsed: present,
    matched: present ? [MARKER_NAMES.AURA_WS_BRIDGE] : [],
  };
}

/**
 * Probe a `pyproject.toml` for the literal substring "aiogram". The probe
 * has no positional dependency — the dispatcher binds the `relPath`
 * (root or subdir) and the probe just reads it.
 */
function probePyproject(rootResolved: string, relPath: string): MarkerCheck {
  const r = resolveMarker(rootResolved, relPath);
  if (!r.ok) {
    return {
      name: MARKER_NAMES.PYTHON_PYPROJECT_AIOGRAM,
      path: relPath,
      present: true,
      parsed: false,
      matched: [],
      reason: r.reason,
    };
  }
  if (!existsSync(r.absolute)) {
    return {
      name: MARKER_NAMES.PYTHON_PYPROJECT_AIOGRAM,
      path: relPath,
      present: false,
      parsed: false,
      matched: [],
    };
  }
  const read = readText(r.absolute, SIZE_CAP.PYPROJECT);
  if (!read.ok) {
    return {
      name: MARKER_NAMES.PYTHON_PYPROJECT_AIOGRAM,
      path: relPath,
      present: true,
      parsed: false,
      matched: [],
      reason: read.reason,
    };
  }
  const matched = read.text.includes("aiogram");
  return {
    name: MARKER_NAMES.PYTHON_PYPROJECT_AIOGRAM,
    path: relPath,
    present: true,
    parsed: true,
    matched: matched ? [MARKER_NAMES.PYTHON_PYPROJECT_AIOGRAM] : [],
  };
}

/**
 * B2 — root variant of the requirements probe. Requires BOTH `requirements.txt`
 * with a `^aiogram` line AND a `bot/` directory at workspace root (existing
 * AC-2.2, backward compatible). Label `"requirements.txt + bot/"`.
 *
 * Split from the unified Phase-A `probeRequirementsAndBot` so the dispatcher
 * names the root-mode invariant explicitly — backward-compat with naming-based
 * co-requirement at the workspace root, NOT at depth-1 subdirs where the
 * subdir being project-shaped (owning its own requirements.txt) replaces it.
 */
function probeRequirementsAtRoot(rootResolved: string): MarkerCheck {
  const reqRes = resolveMarker(rootResolved, "requirements.txt");
  const path = "requirements.txt + bot/";
  if (!reqRes.ok) {
    return {
      name: MARKER_NAMES.PYTHON_REQS_AIOGRAM,
      path,
      present: true,
      parsed: false,
      matched: [],
      reason: reqRes.reason,
    };
  }
  const reqPresent = existsSync(reqRes.absolute);
  const botRes = resolveMarker(rootResolved, "bot");
  if (!botRes.ok) {
    return {
      name: MARKER_NAMES.PYTHON_REQS_AIOGRAM,
      path,
      present: true,
      parsed: false,
      matched: [],
      reason: botRes.reason,
    };
  }
  const botPresent = isDirectory(botRes.absolute);
  if (!reqPresent || !botPresent) {
    return {
      name: MARKER_NAMES.PYTHON_REQS_AIOGRAM,
      path,
      present: reqPresent || botPresent,
      parsed: false,
      matched: [],
    };
  }
  const read = readText(reqRes.absolute, SIZE_CAP.REQUIREMENTS);
  if (!read.ok) {
    return {
      name: MARKER_NAMES.PYTHON_REQS_AIOGRAM,
      path,
      present: true,
      parsed: false,
      matched: [],
      reason: read.reason,
    };
  }
  // CRLF-tolerant: /^aiogram\b/m matches both LF and CRLF lines (FS expert B-R2).
  const matched = /^aiogram\b/m.test(read.text);
  return {
    name: MARKER_NAMES.PYTHON_REQS_AIOGRAM,
    path,
    present: true,
    parsed: true,
    matched: matched ? [MARKER_NAMES.PYTHON_REQS_AIOGRAM] : [],
  };
}

/**
 * B2 — subdir variant of the requirements probe. Single-marker probe at
 * `<prefix>/requirements.txt`; no `bot/` co-requirement (subdir being
 * project-shaped IS the SPECIFICITY signal). Label `"<prefix>/requirements.txt"`.
 */
function probeRequirementsAtSubdir(rootResolved: string, prefix: string): MarkerCheck {
  const relPath = `${prefix}/requirements.txt`;
  const reqRes = resolveMarker(rootResolved, relPath);
  if (!reqRes.ok) {
    return {
      name: MARKER_NAMES.PYTHON_REQS_AIOGRAM,
      path: relPath,
      present: true,
      parsed: false,
      matched: [],
      reason: reqRes.reason,
    };
  }
  if (!existsSync(reqRes.absolute)) {
    return {
      name: MARKER_NAMES.PYTHON_REQS_AIOGRAM,
      path: relPath,
      present: false,
      parsed: false,
      matched: [],
    };
  }
  const read = readText(reqRes.absolute, SIZE_CAP.REQUIREMENTS);
  if (!read.ok) {
    return {
      name: MARKER_NAMES.PYTHON_REQS_AIOGRAM,
      path: relPath,
      present: true,
      parsed: false,
      matched: [],
      reason: read.reason,
    };
  }
  const matched = /^aiogram\b/m.test(read.text);
  return {
    name: MARKER_NAMES.PYTHON_REQS_AIOGRAM,
    path: relPath,
    present: true,
    parsed: true,
    matched: matched ? [MARKER_NAMES.PYTHON_REQS_AIOGRAM] : [],
  };
}

// =============================================================================
// .council-stack-override (plan §4)
// =============================================================================

interface OverrideRead {
  consulted: boolean;
  absolutePath: string | null;
  value: OverrideValue | null;
  malformed: boolean;
}

function readOverride(rootResolved: string): OverrideRead {
  const r = resolveMarker(rootResolved, ".council-stack-override");
  if (!r.ok) {
    return { consulted: true, absolutePath: null, value: null, malformed: true };
  }
  if (!existsSync(r.absolute)) {
    return {
      consulted: false,
      absolutePath: null,
      value: null,
      malformed: false,
    };
  }
  const read = readText(r.absolute, SIZE_CAP.OVERRIDE);
  if (!read.ok) {
    return {
      consulted: true,
      absolutePath: r.absolute,
      value: null,
      malformed: true,
    };
  }
  const trimmed = read.text.trim();
  if (trimmed === "") {
    return {
      consulted: true,
      absolutePath: r.absolute,
      value: null,
      malformed: true,
    };
  }
  if ((OVERRIDE_VALUES as readonly string[]).includes(trimmed)) {
    return {
      consulted: true,
      absolutePath: r.absolute,
      value: trimmed as OverrideValue,
      malformed: false,
    };
  }
  return {
    consulted: true,
    absolutePath: r.absolute,
    value: null,
    malformed: true,
  };
}

// =============================================================================
// Public entry point
// =============================================================================

export function detectStack(workspaceRoot: string): DetectionResult {
  let rootResolved: string;
  try {
    rootResolved = realpathSync(resolve(workspaceRoot));
  } catch {
    return {
      kind: "unknown",
      checked: [],
      overrideUsed: false,
      overridePath: null,
      overrideMalformed: false,
      scanTruncated: false,
    };
  }

  const override = readOverride(rootResolved);

  // Always probe all markers across workspace root + depth-1 subdirs — the user
  // sees the full enumeration in `checked` even when override decides the kind
  // (plan §4: override does not silence the marker enumeration). Per spec
  // council-stack-autodetect-monorepo §2a, depth=2 widens the SEARCH SCOPE
  // without loosening individual marker semantics.
  const { prefixes, enumeration, truncated } =
    enumerateCandidatePrefixes(rootResolved);
  // Enumeration-level synthetic MarkerChecks (readdir / per-entry lstat
  // failures) prepended so the refusal renderer surfaces them at the top of
  // "Found at workspace root:" — they describe failures of the scan itself,
  // not of individual marker probes.
  const checked: MarkerCheck[] = [...enumeration];
  // Phase B (commit <next>): probes are dispatched per "where to look".
  //   - Aura markers (`web/package.json`, `web/server/ws-bridge.ts`) live
  //     under depth-1 subdirs only — canonical "web/" is just one of the
  //     subdirs enumeration returns, no special case. If no subdir has them,
  //     the marker name still appears in the refusal's "Checked for:" list
  //     via `Object.values(MARKER_NAMES)`.
  //   - Python `pyproject.toml` + `requirements.txt+bot/` live at workspace
  //     root canonically AND at depth-1 subdirs (without the bot/ co-req).
  //     Root-mode is the backward-compat AC-2.1/AC-2.2 path; subdir-mode is
  //     the monorepo extension. Each has its own dispatcher entry so no
  //     post-collection dedupe is needed.
  for (const prefix of prefixes) {
    checked.push(...probePackageJson(rootResolved, `${prefix}/package.json`));
    checked.push(probeWsBridge(rootResolved, `${prefix}/server/ws-bridge.ts`));
    checked.push(probePyproject(rootResolved, `${prefix}/pyproject.toml`));
    checked.push(probeRequirementsAtSubdir(rootResolved, prefix));
  }
  checked.push(probePyproject(rootResolved, "pyproject.toml"));
  checked.push(probeRequirementsAtRoot(rootResolved));

  if (override.value !== null) {
    // Ask-First override-conflict gate (spec §⚠️): if the override disagrees with
    // what auto-detection would have decided, surface the conflict instead of
    // silently honoring the override. Caller must ask the user which to honor.
    const auraNamesAF = new Set<string>([
      MARKER_NAMES.AURA_PACKAGE_NAME,
      MARKER_NAMES.AURA_PACKAGE_HONO,
      MARKER_NAMES.AURA_WS_BRIDGE,
    ]);
    const pythonNamesAF = new Set<string>([
      MARKER_NAMES.PYTHON_PYPROJECT_AIOGRAM,
      MARKER_NAMES.PYTHON_REQS_AIOGRAM,
    ]);
    const auraSeen = checked.some((c) =>
      c.matched.some((m) => auraNamesAF.has(m)),
    );
    const pythonSeen = checked.some((c) =>
      c.matched.some((m) => pythonNamesAF.has(m)),
    );
    // Conflict only when auto-detection found markers of the OPPOSITE kind.
    // Mixed (auraSeen && pythonSeen) is "ambiguous" — override resolves it, not conflict.
    // Single-kind disagreement IS conflict (override says aura, only python markers found).
    const opposingMarkerSeen =
      (override.value === "aura" && pythonSeen && !auraSeen) ||
      (override.value === "python" && auraSeen && !pythonSeen);
    if (opposingMarkerSeen) {
      return {
        kind: "override_conflict",
        checked,
        overrideUsed: true,
        overridePath: override.absolutePath,
        overrideMalformed: false,
        overrideConflictAutoDetected: override.value === "aura" ? "python" : "aura",
        overrideConflictAsserted: override.value,
        scanTruncated: truncated,
      };
    }
    return {
      kind: override.value,
      checked,
      overrideUsed: true,
      overridePath: override.absolutePath,
      overrideMalformed: false,
      scanTruncated: truncated,
    };
  }

  if (override.malformed) {
    return {
      kind: "unknown",
      checked,
      overrideUsed: false,
      overridePath: override.absolutePath,
      overrideMalformed: true,
      scanTruncated: truncated,
    };
  }

  const auraNames = new Set<string>([
    MARKER_NAMES.AURA_PACKAGE_NAME,
    MARKER_NAMES.AURA_PACKAGE_HONO,
    MARKER_NAMES.AURA_WS_BRIDGE,
  ]);
  const pythonNames = new Set<string>([
    MARKER_NAMES.PYTHON_PYPROJECT_AIOGRAM,
    MARKER_NAMES.PYTHON_REQS_AIOGRAM,
  ]);
  const auraMatched = checked.some((c) =>
    c.matched.some((m) => auraNames.has(m)),
  );
  const pythonMatched = checked.some((c) =>
    c.matched.some((m) => pythonNames.has(m)),
  );

  let kind: DetectionKind;
  if (auraMatched && pythonMatched) kind = "ambiguous";
  else if (auraMatched) kind = "aura";
  else if (pythonMatched) kind = "python";
  else kind = "unknown";

  return {
    kind,
    checked,
    overrideUsed: false,
    overridePath: null,
    overrideMalformed: false,
    scanTruncated: truncated,
  };
}

// =============================================================================
// Refusal template (plan §5 — UX × Security)
// =============================================================================

const OVERRIDE_FOOTER = [
  "To override, run:",
  "  /council-plan-aura      # if this workspace is the Aura companion",
  "  /council-plan            # if this workspace is the Python bot (suffixless variant)",
];

function allMarkerNames(): string[] {
  // "Checked for:" is the FIXED list of marker categories the detector
  // knows about — NOT the per-run probe trace. After Phase B retired the
  // sentinel-driven double-probe (and the dedupe that cleaned it up),
  // some MARKER_NAMES no longer always appear in `checked` (e.g. AURA_*
  // probes don't run when no depth-1 subdir survives the SKIP_SUBDIRS
  // filter). The refusal still needs to enumerate every category the
  // detector knows about — that is the AC-3.1 contract.
  return Object.values(MARKER_NAMES);
}

// =============================================================================
// renderRefusal — pure block builders (Phase B3)
//
// The body of `renderRefusal` is concatenation of four blocks: headline,
// optional conflict block, marker-list ("Checked for:" + "Found at workspace
// root:"), footer. Each block is a pure function over `DetectionResult` —
// trivially safe to extract per Fowler P2 (extract pure logic). The main
// function reads top-to-bottom as the section order. Tests assert on
// substrings of the output, so the extraction is structure-insensitive.
// =============================================================================

function pickHeadline(result: DetectionResult): string {
  if (result.overrideMalformed) return REFUSAL_HEADLINES.override_malformed;
  if (result.kind === "override_conflict") return REFUSAL_HEADLINES.override_conflict;
  if (result.kind === "ambiguous") return REFUSAL_HEADLINES.ambiguous;
  return REFUSAL_HEADLINES.unknown;
}

function renderConflictBlock(result: DetectionResult): string[] {
  if (result.kind !== "override_conflict") return [];
  // Surface the disagreement explicitly — ask-first per spec AC-conflict.
  const asserted = result.overrideConflictAsserted ?? "?";
  const detected = result.overrideConflictAutoDetected ?? "?";
  return [
    `.council-stack-override asserts: ${asserted}`,
    `Auto-detected from markers: ${detected}`,
    "",
  ];
}

function renderCheckedForBlock(): string[] {
  const out: string[] = ["Checked for:"];
  for (const name of allMarkerNames()) {
    out.push("  - " + name);
  }
  return out;
}

function renderFoundAtRootBlock(result: DetectionResult): string[] {
  const out: string[] = ["Found at workspace root:"];
  const present = result.checked.filter((c) => c.present);
  if (present.length === 0 && !result.overrideMalformed) {
    out.push("  (no recognised stack markers)");
  } else {
    const printed = new Set<string>();
    for (const c of present) {
      // Render label = path for real markers (workspace-relative path),
      // OR name for synthetic enumeration failures whose `path` is "" so
      // the human-readable label (`<workspace>/ (directory scan)` etc.)
      // surfaces instead of an empty bullet.
      const label = c.path || c.name;
      if (printed.has(label)) continue;
      printed.add(label);
      const note = c.parsed ? "" : c.reason ? ` (${c.reason})` : "";
      out.push("  - " + label + note);
    }
    if (result.overrideMalformed) {
      out.push("  - .council-stack-override (malformed)");
    }
  }
  if (result.scanTruncated) {
    // A2: surface the silent cap so users with very wide monorepo roots see
    // the scan was incomplete. Brief — preserves the AC-3.2 line budget.
    out.push(
      `  (scan capped at ${MAX_CANDIDATE_SUBDIRS} subdirs; later entries skipped)`,
    );
  }
  return out;
}

function pickFooter(result: DetectionResult): string[] {
  if (result.kind === "override_conflict") {
    return [
      "To resolve:",
      "  - correct or delete .council-stack-override, then re-run",
    ];
  }
  return [...OVERRIDE_FOOTER];
}

export function renderRefusal(result: DetectionResult): string {
  if (
    result.kind !== "unknown" &&
    result.kind !== "ambiguous" &&
    result.kind !== "override_conflict"
  ) {
    return "";
  }
  return [
    pickHeadline(result),
    "",
    ...renderConflictBlock(result),
    ...renderCheckedForBlock(),
    "",
    ...renderFoundAtRootBlock(result),
    "",
    ...pickFooter(result),
  ].join("\n");
}
