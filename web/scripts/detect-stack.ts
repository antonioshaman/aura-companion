#!/usr/bin/env bun
// Auto-stack-detection for council router slash commands (Tasks 1–5 of
// `.council/abtest/v2-router-plan.md`).
//
// Pure synchronous detector. Reads workspace markers, returns a discriminated
// union telling the calling skill whether to dispatch the Aura council,
// the Python council, refuse loudly on ambiguity, or refuse loudly on unknown.
//
// Convention notes (conventions.md):
// - EC-7 (filesystem-access predicates inline path resolution OR exposed via
//   a resolving wrapper): every marker access goes through `resolveMarker`,
//   which realpath-resolves the workspace root once and bounds-checks every
//   marker path, refusing symlink leaves outright.
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
const SKIP_SUBDIRS = new Set<string>([
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
const MAX_CANDIDATE_SUBDIRS = 64;

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

// Enumerate depth-1 subdirs of the workspace root as relative prefixes to scan.
// The empty string "" is always the first candidate (workspace root itself,
// preserves canonical root-only detection for AC-1/AC-2). Hidden dirs and
// SKIP_SUBDIRS members are excluded; symlinks are excluded (EC-7); count is
// capped at MAX_CANDIDATE_SUBDIRS to bound the per-call probe budget.
function enumerateCandidatePrefixes(rootResolved: string): string[] {
  const prefixes: string[] = [""];
  let entries;
  try {
    entries = readdirSync(rootResolved, { withFileTypes: true });
  } catch {
    return prefixes;
  }
  let scanned = 0;
  for (const entry of entries) {
    if (scanned >= MAX_CANDIDATE_SUBDIRS) break;
    const name = entry.name;
    if (name.startsWith(".")) continue;
    if (SKIP_SUBDIRS.has(name)) continue;
    if (!entry.isDirectory()) continue; // also rejects symlinks (isDirectory false on dirent symlinks)
    // Defensive realpath bounds check — never traverse outside workspace.
    const candidate = join(rootResolved, name);
    let lst;
    try {
      lst = lstatSync(candidate);
    } catch {
      continue;
    }
    if (lst.isSymbolicLink()) continue;
    prefixes.push(name);
    scanned += 1;
  }
  return prefixes;
}

// =============================================================================
// Individual marker probes
// =============================================================================

// prefix === "" → canonical root layout (web/package.json).
// prefix === "<dir>" → monorepo layout (<dir>/package.json).
// The marker NAME identifier stays canonical regardless of where matched.
function probePackageJson(rootResolved: string, prefix: string): MarkerCheck[] {
  const relPath = prefix === "" ? "web/package.json" : `${prefix}/package.json`;
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

function probeWsBridge(rootResolved: string, prefix: string): MarkerCheck {
  const relPath = prefix === "" ? "web/server/ws-bridge.ts" : `${prefix}/server/ws-bridge.ts`;
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

function probePyproject(rootResolved: string, prefix: string): MarkerCheck {
  const relPath = prefix === "" ? "pyproject.toml" : `${prefix}/pyproject.toml`;
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

// At root (prefix === ""): requires BOTH requirements.txt with ^aiogram AND a
// bot/ directory at workspace root (existing AC-2.2, backward compatible).
// At depth-1 subdir (prefix === "<dir>"): only requires <dir>/requirements.txt
// with ^aiogram. SPECIFICITY: the subdir being project-shaped (owning its own
// requirements.txt) replaces the bot/ co-requirement — directory naming is
// never relied on for stack signal.
function probeRequirementsAndBot(rootResolved: string, prefix: string): MarkerCheck {
  const reqRelPath = prefix === "" ? "requirements.txt" : `${prefix}/requirements.txt`;
  const reqRes = resolveMarker(rootResolved, reqRelPath);
  const path = prefix === "" ? "requirements.txt + bot/" : `${prefix}/requirements.txt`;
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
  let botPresent = true;
  if (prefix === "") {
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
    botPresent = isDirectory(botRes.absolute);
  }
  if (!reqPresent || !botPresent) {
    return {
      name: MARKER_NAMES.PYTHON_REQS_AIOGRAM,
      path,
      present: reqPresent || (prefix === "" && botPresent),
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
    };
  }

  const override = readOverride(rootResolved);

  // Always probe all markers across workspace root + depth-1 subdirs — the user
  // sees the full enumeration in `checked` even when override decides the kind
  // (plan §4: override does not silence the marker enumeration). Per spec
  // council-stack-autodetect-monorepo §2a, depth=2 widens the SEARCH SCOPE
  // without loosening individual marker semantics.
  const prefixes = enumerateCandidatePrefixes(rootResolved);
  const accumulated: MarkerCheck[] = [];
  for (const prefix of prefixes) {
    accumulated.push(...probePackageJson(rootResolved, prefix));
    accumulated.push(probeWsBridge(rootResolved, prefix));
    accumulated.push(probePyproject(rootResolved, prefix));
    accumulated.push(probeRequirementsAndBot(rootResolved, prefix));
  }
  // Dedupe by (name, path) — when "web" is itself a depth-1 candidate the
  // canonical Aura paths (web/package.json, web/server/ws-bridge.ts) get
  // probed twice (once via prefix="", once via prefix="web") and land here as
  // identical MarkerChecks. Drop the duplicates so later filters that count
  // by path (AC-3.3, refusal renderer) see one entry per real disk file.
  const seenKey = new Set<string>();
  const checked: MarkerCheck[] = [];
  for (const c of accumulated) {
    const key = c.name + "\0" + c.path;
    if (seenKey.has(key)) continue;
    seenKey.add(key);
    checked.push(c);
  }

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
      };
    }
    return {
      kind: override.value,
      checked,
      overrideUsed: true,
      overridePath: override.absolutePath,
      overrideMalformed: false,
    };
  }

  if (override.malformed) {
    return {
      kind: "unknown",
      checked,
      overrideUsed: false,
      overridePath: override.absolutePath,
      overrideMalformed: true,
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

function dedupedMarkerList(checked: MarkerCheck[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of checked) {
    if (!seen.has(c.name)) {
      seen.add(c.name);
      out.push(c.name);
    }
  }
  // Always include the override marker in the "Checked for" enumeration,
  // even when its file is absent — the spec lists it as a checked marker.
  if (!seen.has(MARKER_NAMES.OVERRIDE)) {
    out.push(MARKER_NAMES.OVERRIDE);
  }
  return out;
}

export function renderRefusal(result: DetectionResult): string {
  if (
    result.kind !== "unknown" &&
    result.kind !== "ambiguous" &&
    result.kind !== "override_conflict"
  ) {
    return "";
  }
  let headline: string;
  if (result.overrideMalformed) {
    headline = REFUSAL_HEADLINES.override_malformed;
  } else if (result.kind === "override_conflict") {
    headline = REFUSAL_HEADLINES.override_conflict;
  } else if (result.kind === "ambiguous") {
    headline = REFUSAL_HEADLINES.ambiguous;
  } else {
    headline = REFUSAL_HEADLINES.unknown;
  }
  const lines: string[] = [headline, ""];
  if (result.kind === "override_conflict") {
    // Surface the disagreement explicitly — ask-first per spec AC-conflict.
    const asserted = result.overrideConflictAsserted ?? "?";
    const detected = result.overrideConflictAutoDetected ?? "?";
    lines.push(
      `.council-stack-override asserts: ${asserted}`,
    );
    lines.push(
      `Auto-detected from markers: ${detected}`,
    );
    lines.push("");
  }
  lines.push("Checked for:");
  for (const name of dedupedMarkerList(result.checked)) {
    lines.push("  - " + name);
  }
  lines.push("");
  lines.push("Found at workspace root:");
  const present = result.checked.filter((c) => c.present);
  const printed = new Set<string>();
  if (present.length === 0 && !result.overrideMalformed) {
    lines.push("  (no recognised stack markers)");
  } else {
    for (const c of present) {
      if (printed.has(c.path)) continue;
      printed.add(c.path);
      const note = c.parsed ? "" : c.reason ? ` (${c.reason})` : "";
      lines.push("  - " + c.path + note);
    }
    if (result.overrideMalformed) {
      lines.push("  - .council-stack-override (malformed)");
    }
  }
  lines.push("");
  if (result.kind === "override_conflict") {
    lines.push("To resolve:");
    lines.push("  - correct or delete .council-stack-override, then re-run");
  } else {
    for (const f of OVERRIDE_FOOTER) lines.push(f);
  }
  return lines.join("\n");
}
