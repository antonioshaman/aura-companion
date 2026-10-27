// Spawn-time exposure of Aura's shipped skills (PLAN Task 7 — ritchie A1–A3 "decide
// once at spawn"; spec `uiux-agent-enrichment.md` AC2.1 / AC2.2 / AC2.5).
//
// The decision is made once, when a session is first spawned, and persisted on the
// session (`SdkSessionInfo.skillExposure`); relaunch and resume reuse it, so a pack
// upgrade or a settings change never alters a running conversation (EC-33: new
// skills need a new session).
//
// How each CLI sees the pack (owner decision 1 in HANDOFF-uiux-phase-B2 → option A,
// nothing is written into the user's `~/.claude`):
//   Claude  `--plugin-dir <pack>/exposures/<id>` — a session-only plugin, skills
//           answer as `/aura-toolkit:<name>`. Used only when the installed CLI's
//           `--help` lists `--plugin-dir`; otherwise the session is labelled
//           "toolkit unavailable".
//   Codex   marked, read-only copies in the Aura-managed per-session CODEX_HOME
//           (`syncCopies`), never the user's `~/.codex`. Claude-only skills
//           (`compat.codex === false`) are not copied: `requires-claude`.
//   Container sessions are not wired yet → "toolkit unavailable".
//
// Delivery itself (trees, copies, ownership) stays in skill-pack.ts.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { log } from "./logger.js";
import type { SkillManifest } from "./skill-manifest.js";
import type { CurrentPack, ExistingSkill, PackOutcome } from "./skill-pack.js";
import { DEFAULT_PACK_ROOT, installPack, planPack, PACK_MANIFEST_FILE, sweepCopies, sweepPackRoot } from "./skill-pack.js";

export const SKILL_EXPOSURE_SCHEMA_VERSION = 1;

export type ExposureOutcome = PackOutcome | "requires-claude";

export interface SkillExposureItem {
  name: string;
  outcome: ExposureOutcome;
  reasons: string[];
}

export interface SkillExposure {
  schemaVersion: 1;
  backend: "claude" | "codex";
  /**
   * on           the pack is exposed (possibly with zero provided skills)
   * off          the `uiux` layer is off for this session
   * unavailable  wanted, but this session cannot get it; `reason` says why
   */
  status: "on" | "off" | "unavailable";
  reason?: string;
  /** The pack version decided at spawn; kept alive by the boot sweep while the session exists. */
  version?: string;
  /** Claude only: the plugin dir passed with `--plugin-dir`. */
  pluginDir?: string;
  items: SkillExposureItem[];
  decidedAt: number;
}

export interface ExposureInput {
  backend: "claude" | "codex";
  /** The `uiux` layer flag for this session. */
  enabled: boolean;
  containerized: boolean;
  /** Claude only: whether the installed CLI supports `--plugin-dir`. */
  cliSupportsPluginDir?: boolean;
  pack: CurrentPack;
  /** Skill dirs that already answer to a name for this CLI (the user's win). */
  existing: ExistingSkill[];
  now?: number;
}

/** Pure: what this session gets. Exposes nothing unless every precondition holds. */
export function decideSkillExposure(input: ExposureInput): SkillExposure {
  const base = { schemaVersion: SKILL_EXPOSURE_SCHEMA_VERSION, backend: input.backend, decidedAt: input.now ?? Date.now() } as const;
  if (!input.enabled) return { ...base, status: "off", items: [] };
  const unavailable = (reason: string): SkillExposure => ({ ...base, status: "unavailable", reason, items: [] });
  if (input.containerized) return unavailable("container sessions do not receive the toolkit yet");
  if (input.backend === "claude" && input.cliSupportsPluginDir !== true) {
    return unavailable("the installed Claude Code CLI does not support --plugin-dir");
  }
  if ("error" in input.pack) return unavailable(`skill pack not installed: ${input.pack.error}`);
  const { manifest } = input.pack;
  const byName = new Map(manifest.entries.map((e) => [e.name, e]));
  const items = planPack({ manifest, existing: input.existing, enabled: true }).map((p): SkillExposureItem => {
    const e = byName.get(p.name);
    if (p.outcome !== "provide" || !e) return { ...p };
    // Only invocable skills ride a Claude plugin; the catalog is data for the dispatchers.
    if (input.backend === "claude" && e.kind !== "skill") {
      return { name: p.name, outcome: "disabled", reasons: ["reference data, not an invocable skill"] };
    }
    if (input.backend === "codex" && !e.compat.codex) {
      return { name: p.name, outcome: "requires-claude", reasons: e.compat.note ? [e.compat.note] : [] };
    }
    return { ...p };
  });
  return { ...base, status: "on", version: input.pack.version, items };
}

export function providedNames(exposure: Pick<SkillExposure, "status" | "items"> | undefined): string[] {
  if (!exposure || exposure.status !== "on") return [];
  return exposure.items.filter((i) => i.outcome === "provide").map((i) => i.name);
}

/** Strict parse of a persisted exposure; anything malformed is dropped (re-decided on next fresh launch). */
export function parseSkillExposure(raw: unknown): SkillExposure | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  if (r.schemaVersion !== SKILL_EXPOSURE_SCHEMA_VERSION) return undefined;
  if (r.backend !== "claude" && r.backend !== "codex") return undefined;
  if (r.status !== "on" && r.status !== "off" && r.status !== "unavailable") return undefined;
  if (!Array.isArray(r.items) || typeof r.decidedAt !== "number") return undefined;
  for (const k of ["reason", "version", "pluginDir"] as const) {
    if (r[k] !== undefined && typeof r[k] !== "string") return undefined;
  }
  const items: SkillExposureItem[] = [];
  for (const it of r.items) {
    if (!it || typeof it !== "object") return undefined;
    const i = it as Record<string, unknown>;
    if (typeof i.name !== "string" || typeof i.outcome !== "string" || !Array.isArray(i.reasons)) return undefined;
    items.push({ name: i.name, outcome: i.outcome as ExposureOutcome, reasons: i.reasons.filter((x): x is string => typeof x === "string") });
  }
  return { ...(r as unknown as SkillExposure), items };
}

// ─── CLI capability probe ───────────────────────────────────────────────────

const pluginDirSupport = new Map<string, boolean>();

/**
 * Does `binary --help` list `--plugin-dir`? Cached per binary path + mtime, so a CLI
 * upgrade is re-probed. A probe that fails or times out counts as unsupported.
 */
export function claudeSupportsPluginDir(
  binary: string,
  run: (bin: string) => string | null = defaultHelpRunner,
): boolean {
  let key = binary;
  try {
    key = `${binary}\0${statSync(binary).mtimeMs}`;
  } catch {
    /* unresolved binary: cache by name */
  }
  const hit = pluginDirSupport.get(key);
  if (hit !== undefined) return hit;
  const help = run(binary);
  const ok = help !== null && /(^|\s)--plugin-dir\b/.test(help);
  pluginDirSupport.set(key, ok);
  log.info("skill-exposure", "claude --plugin-dir probe", { event: "skill_exposure.cli_probe", binary, supported: ok });
  return ok;
}

function defaultHelpRunner(bin: string): string | null {
  const r = spawnSync(bin, ["--help"], { encoding: "utf8", timeout: 10_000, env: { ...process.env, CLAUDECODE: undefined } });
  return r.status === 0 ? `${r.stdout ?? ""}` : null;
}

export function _resetPluginDirProbeForTest(): void {
  pluginDirSupport.clear();
}

// ─── Boot maintenance ───────────────────────────────────────────────────────

/** `packs/skills` next to the server (git clone); overridable for packaged installs (B4). */
export function defaultPackSource(env: Record<string, string | undefined> = process.env): string {
  return env.COMPANION_SKILL_PACK_SOURCE || resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "packs", "skills");
}

export interface MaintainResult {
  installed?: string;
  error?: string;
}

/**
 * Boot: sweep the Aura tree (keeping every version a persisted session decided on),
 * install the shipped pack from `sourceDir` (idempotent), and sweep leftovers in
 * each Codex skills dir. Never throws — a failure leaves sessions "unavailable".
 */
export function maintainSkillPack(opts: {
  keepVersions: Array<string | undefined>;
  codexSkillDirs: string[];
  root?: string;
  sourceDir?: string;
}): MaintainResult {
  const root = opts.root ?? DEFAULT_PACK_ROOT;
  const sourceDir = opts.sourceDir ?? defaultPackSource();
  const keep = opts.keepVersions.filter((v): v is string => typeof v === "string");
  const out: MaintainResult = {};
  try {
    sweepPackRoot(root, { keep });
  } catch (err) {
    log.warn("skill-exposure", "pack root sweep failed", { event: "skill_exposure.sweep_failed", error: String(err) });
  }
  const manifestPath = join(sourceDir, PACK_MANIFEST_FILE);
  if (!existsSync(manifestPath)) {
    out.error = `no ${PACK_MANIFEST_FILE} in ${sourceDir}`;
    log.info("skill-exposure", "no shipped skill pack to install", { event: "skill_exposure.no_source", sourceDir });
  } else {
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as SkillManifest;
      out.installed = installPack({ sourceDir, manifest, root }).version;
    } catch (err) {
      out.error = err instanceof Error ? err.message : String(err);
      log.warn("skill-exposure", "skill pack install failed", { event: "skill_exposure.install_failed", sourceDir, error: out.error });
    }
  }
  for (const dir of opts.codexSkillDirs) {
    try {
      sweepCopies(dir);
    } catch (err) {
      log.warn("skill-exposure", "Codex skills sweep failed", { event: "skill_exposure.sweep_failed", dir, error: String(err) });
    }
  }
  return out;
}

// ─── Settings view ──────────────────────────────────────────────────────────

export interface ToolkitRow {
  name: string;
  kind: "skill" | "catalog";
  claude: SkillExposureItem;
  codex: SkillExposureItem;
}

export type ToolkitView =
  | { installed: true; version: string; claudeUnavailable?: string; rows: ToolkitRow[] }
  | { installed: false; error: string; rows: [] };

/**
 * Pure: what a NEW session would get from the current pack, per CLI — the Settings
 * "UI/UX toolkit" row. The toggle is shown separately, so this plans as if it were on.
 */
export function describeToolkit(input: {
  pack: CurrentPack;
  claudeExisting: ExistingSkill[];
  codexExisting: ExistingSkill[];
  claudeSupportsPluginDir: boolean;
}): ToolkitView {
  if ("error" in input.pack) return { installed: false, error: input.pack.error, rows: [] };
  const claude = decideSkillExposure({
    backend: "claude", enabled: true, containerized: false, cliSupportsPluginDir: true, pack: input.pack, existing: input.claudeExisting,
  });
  const codex = decideSkillExposure({ backend: "codex", enabled: true, containerized: false, pack: input.pack, existing: input.codexExisting });
  const rows = input.pack.manifest.entries.map((e, i): ToolkitRow => ({
    name: e.name,
    kind: e.kind,
    claude: claude.items[i],
    codex: codex.items[i],
  }));
  return {
    installed: true,
    version: input.pack.version,
    ...(input.claudeSupportsPluginDir ? {} : { claudeUnavailable: "the installed Claude Code CLI does not support --plugin-dir" }),
    rows,
  };
}
