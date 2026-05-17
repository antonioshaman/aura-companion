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
} as const;

// Size caps per marker (bytes). Plan §3.
const SIZE_CAP = {
  PACKAGE_JSON: 16 * 1024,
  PYPROJECT: 64 * 1024,
  REQUIREMENTS: 64 * 1024,
  OVERRIDE: 1024,
} as const;

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

export type DetectionKind = "aura" | "python" | "ambiguous" | "unknown";

export interface DetectionResult {
  kind: DetectionKind;
  checked: MarkerCheck[];
  overrideUsed: boolean;
  overridePath: string | null;
  overrideMalformed: boolean;
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

// =============================================================================
// Individual marker probes
// =============================================================================

function probePackageJson(rootResolved: string): MarkerCheck[] {
  const r = resolveMarker(rootResolved, "web/package.json");
  const both = (
    present: boolean,
    parsed: boolean,
    matchedName: boolean,
    matchedHono: boolean,
    reason?: MarkerReason,
  ): MarkerCheck[] => [
    {
      name: MARKER_NAMES.AURA_PACKAGE_NAME,
      path: "web/package.json",
      present,
      parsed,
      matched: matchedName ? [MARKER_NAMES.AURA_PACKAGE_NAME] : [],
      ...(reason ? { reason } : {}),
    },
    {
      name: MARKER_NAMES.AURA_PACKAGE_HONO,
      path: "web/package.json",
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

function probeWsBridge(rootResolved: string): MarkerCheck {
  const r = resolveMarker(rootResolved, "web/server/ws-bridge.ts");
  if (!r.ok) {
    return {
      name: MARKER_NAMES.AURA_WS_BRIDGE,
      path: "web/server/ws-bridge.ts",
      present: true,
      parsed: false,
      matched: [],
      reason: r.reason,
    };
  }
  const present = existsSync(r.absolute);
  return {
    name: MARKER_NAMES.AURA_WS_BRIDGE,
    path: "web/server/ws-bridge.ts",
    present,
    parsed: present,
    matched: present ? [MARKER_NAMES.AURA_WS_BRIDGE] : [],
  };
}

function probePyproject(rootResolved: string): MarkerCheck {
  const r = resolveMarker(rootResolved, "pyproject.toml");
  if (!r.ok) {
    return {
      name: MARKER_NAMES.PYTHON_PYPROJECT_AIOGRAM,
      path: "pyproject.toml",
      present: true,
      parsed: false,
      matched: [],
      reason: r.reason,
    };
  }
  if (!existsSync(r.absolute)) {
    return {
      name: MARKER_NAMES.PYTHON_PYPROJECT_AIOGRAM,
      path: "pyproject.toml",
      present: false,
      parsed: false,
      matched: [],
    };
  }
  const read = readText(r.absolute, SIZE_CAP.PYPROJECT);
  if (!read.ok) {
    return {
      name: MARKER_NAMES.PYTHON_PYPROJECT_AIOGRAM,
      path: "pyproject.toml",
      present: true,
      parsed: false,
      matched: [],
      reason: read.reason,
    };
  }
  const matched = read.text.includes("aiogram");
  return {
    name: MARKER_NAMES.PYTHON_PYPROJECT_AIOGRAM,
    path: "pyproject.toml",
    present: true,
    parsed: true,
    matched: matched ? [MARKER_NAMES.PYTHON_PYPROJECT_AIOGRAM] : [],
  };
}

function probeRequirementsAndBot(rootResolved: string): MarkerCheck {
  const reqRes = resolveMarker(rootResolved, "requirements.txt");
  const botRes = resolveMarker(rootResolved, "bot");
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
  const reqPresent = existsSync(reqRes.absolute);
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

  // Always probe all markers — the user sees the full enumeration in
  // `checked` even when override decides the kind (plan §4: override does
  // not silence the marker enumeration).
  const checked: MarkerCheck[] = [
    ...probePackageJson(rootResolved),
    probeWsBridge(rootResolved),
    probePyproject(rootResolved),
    probeRequirementsAndBot(rootResolved),
  ];

  if (override.value !== null) {
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
  "  /council-plan-python    # if this workspace is the Python bot (suffixed variant)",
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
  if (result.kind !== "unknown" && result.kind !== "ambiguous") {
    return "";
  }
  let headline: string;
  if (result.overrideMalformed) {
    headline = REFUSAL_HEADLINES.override_malformed;
  } else if (result.kind === "ambiguous") {
    headline = REFUSAL_HEADLINES.ambiguous;
  } else {
    headline = REFUSAL_HEADLINES.unknown;
  }
  const lines: string[] = [headline, ""];
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
  for (const f of OVERRIDE_FOOTER) lines.push(f);
  return lines.join("\n");
}
