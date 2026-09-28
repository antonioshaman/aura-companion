/**
 * Aura layer flags (aura-meta-diet P4/C3).
 *
 * Four independently switchable meta-layers, so AuraBench can ablate them
 * (variants C–G) and an operator can switch off a layer that does not pay:
 *
 *  - `knowledge`   — the KB (`.agents/knowledge/`) and its skills
 *                    (`/prime`, `/learn`, `/self-reflect`, `/review-with-kb`,
 *                    `/evolve`).
 *  - `observer`    — the Council Mode observer half (`councilMode: "council"`
 *                    pair creation).
 *  - `council`     — the multi-expert `/council-*` skills.
 *  - `autoProceed` — the AFK idle-timeout driver (`autoProceedOnIdle`).
 *
 * Defaults are every layer ON — i.e. exactly the current prod behaviour, and
 * a default-flag session produces a byte-identical spawn argv.
 *
 * Two inputs, one precedence rule:
 *  1. Server env `COMPANION_LAYER_{KNOWLEDGE,OBSERVER,COUNCIL,AUTO_PROCEED}`
 *     sets the server default (read at boot; warnings logged there).
 *  2. Per-session `layers: { knowledge?: "on"|"off", ... }` on
 *     `POST /sessions/create[-stream]` overrides the server default.
 *
 * Parsing is fail-closed like `isRecordingHubEnabled`: only the closed set in
 * {@link parseLayerValue} is understood; anything else (typo, number, object,
 * unknown layer name) falls back to the default for that layer and yields a
 * warning — it never silently flips a layer.
 *
 * Enforcement per backend:
 *  - Claude: `--disallowedTools` permission rules (KB file access + skills)
 *    plus an appended system-prompt directive.
 *  - Codex: has no per-tool deny flag, so `knowledge`/`council` OFF is
 *    enforced by the same directive sent as `developerInstructions` only
 *    (documented limitation — soft for Codex).
 *  - `observer` / `autoProceed` are enforced host-side (routes) and are
 *    provider-independent.
 * Residual confound: the workspace CLAUDE.md/AGENTS.md still mentions the KB;
 * the directive tells the agent to ignore it. Full removal of those files is
 * the bench harness's job (naked variants), not the server's.
 */

export const LAYER_NAMES = ["knowledge", "observer", "council", "autoProceed"] as const;
export type LayerName = (typeof LAYER_NAMES)[number];
export type LayerFlags = Readonly<Record<LayerName, boolean>>;

export const DEFAULT_LAYER_FLAGS: LayerFlags = Object.freeze({
  knowledge: true,
  observer: true,
  council: true,
  autoProceed: true,
});

export const LAYER_ENV_KEYS: Readonly<Record<LayerName, string>> = Object.freeze({
  knowledge: "COMPANION_LAYER_KNOWLEDGE",
  observer: "COMPANION_LAYER_OBSERVER",
  council: "COMPANION_LAYER_COUNCIL",
  autoProceed: "COMPANION_LAYER_AUTO_PROCEED",
});

const ON_VALUES = new Set(["on", "1", "true"]);
const OFF_VALUES = new Set(["off", "0", "false"]);

/**
 * Closed-set parse. `absent` = not specified (use default); `invalid` = a
 * value was given but is not understood (use default AND warn).
 */
export function parseLayerValue(raw: unknown): { kind: "absent" } | { kind: "value"; on: boolean } | { kind: "invalid" } {
  if (raw === undefined || raw === null) return { kind: "absent" };
  if (typeof raw === "boolean") return { kind: "value", on: raw };
  if (typeof raw !== "string") return { kind: "invalid" };
  const v = raw.trim().toLowerCase();
  if (v === "") return { kind: "absent" };
  if (ON_VALUES.has(v)) return { kind: "value", on: true };
  if (OFF_VALUES.has(v)) return { kind: "value", on: false };
  return { kind: "invalid" };
}

export interface LayerResolution {
  flags: LayerFlags;
  warnings: string[];
}

/** Resolve the server-default flags from env. Pure — the caller logs. */
export function resolveLayerFlagsFromEnv(env: Record<string, string | undefined>): LayerResolution {
  const flags: Record<LayerName, boolean> = { ...DEFAULT_LAYER_FLAGS };
  const warnings: string[] = [];
  for (const name of LAYER_NAMES) {
    const key = LAYER_ENV_KEYS[name];
    const parsed = parseLayerValue(env[key]);
    if (parsed.kind === "value") flags[name] = parsed.on;
    else if (parsed.kind === "invalid") {
      warnings.push(
        `${key}=${JSON.stringify(env[key])} is not one of on/off/1/0/true/false; ` +
          `falling back to default (${DEFAULT_LAYER_FLAGS[name] ? "on" : "off"})`,
      );
    }
  }
  return { flags: Object.freeze(flags), warnings };
}

/**
 * Resolve per-session flags on top of `base` (the server default). Unknown
 * layer names and invalid values fall back to `base` for that layer + warn.
 */
export function resolveSessionLayerFlags(raw: unknown, base: LayerFlags): LayerResolution {
  if (raw === undefined || raw === null) return { flags: base, warnings: [] };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { flags: base, warnings: [`layers must be an object; ignoring ${JSON.stringify(raw)}`] };
  }
  const flags: Record<LayerName, boolean> = { ...base };
  const warnings: string[] = [];
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!(LAYER_NAMES as readonly string[]).includes(key)) {
      warnings.push(`layers.${key} is not a known layer (${LAYER_NAMES.join(", ")}); ignoring`);
      continue;
    }
    const name = key as LayerName;
    const parsed = parseLayerValue(value);
    if (parsed.kind === "value") flags[name] = parsed.on;
    else if (parsed.kind === "invalid") {
      warnings.push(
        `layers.${name}=${JSON.stringify(value)} is not one of on/off; ` +
          `falling back to server default (${base[name] ? "on" : "off"})`,
      );
    }
  }
  return { flags: Object.freeze(flags), warnings };
}

export function isDefaultLayerFlags(flags: LayerFlags): boolean {
  return LAYER_NAMES.every((n) => flags[n] === DEFAULT_LAYER_FLAGS[n]);
}

let serverFlags: LayerFlags | null = null;

/**
 * Server-default flags, resolved once from `process.env` and cached. Boot
 * calls {@link initServerLayerFlags} to log warnings; lazy callers get the
 * same value without the log.
 */
export function getServerLayerFlags(): LayerFlags {
  if (!serverFlags) serverFlags = resolveLayerFlagsFromEnv(process.env).flags;
  return serverFlags;
}

/** Boot-time resolve + warn. Returns the resolution so the caller can log it. */
export function initServerLayerFlags(
  env: Record<string, string | undefined> = process.env,
  warn: (msg: string) => void = (msg) => console.warn(`[layer-flags] ${msg}`),
): LayerResolution {
  const res = resolveLayerFlagsFromEnv(env);
  for (const w of res.warnings) warn(w);
  serverFlags = res.flags;
  return res;
}

/** Test seam — drop the cached server flags. */
export function _resetServerLayerFlagsForTest(): void {
  serverFlags = null;
}

// ── Spawn enforcement ───────────────────────────────────────────────────────

/** Skills that deliver KB content or KB maintenance instructions. */
export const KNOWLEDGE_SKILLS = ["prime", "learn", "self-reflect", "review-with-kb", "evolve"] as const;

/** Multi-expert council skills (repo `.agents/skills` + user `~/.claude/skills`). */
export const COUNCIL_SKILLS = [
  "council-plan",
  "council-review",
  "council-implement",
  "council-plan-aura",
  "council-review-aura",
  "council-implement-aura",
  "_council-experts",
] as const;

const KB_DIR = "./.agents/knowledge/**";

export interface LayerSpawnConfig {
  /** Claude `--disallowedTools` rules to add (ignored by Codex). */
  disallowedTools: string[];
  /** Directive appended to the system prompt (Claude) / `developerInstructions` (Codex). */
  systemPrompt?: string;
}

/**
 * Translate flags into spawn-time restrictions. All-default flags → empty
 * config, so the default spawn is unchanged.
 */
export function buildLayerSpawnConfig(flags: LayerFlags | undefined): LayerSpawnConfig {
  if (!flags) return { disallowedTools: [] };
  const disallowedTools: string[] = [];
  const directives: string[] = [];
  if (!flags.knowledge) {
    disallowedTools.push(
      `Read(${KB_DIR})`,
      `Edit(${KB_DIR})`,
      `Write(${KB_DIR})`,
      "Bash(bun run --cwd web kb:*)",
      ...KNOWLEDGE_SKILLS.map((s) => `Skill(${s})`),
    );
    directives.push(
      "The knowledge layer is disabled for this session: do not read, search or modify " +
        "`.agents/knowledge/`, and do not run /prime, /learn, /self-reflect, /review-with-kb or /evolve. " +
        "Ignore any project instructions that ask you to.",
    );
  }
  if (!flags.council) {
    disallowedTools.push(...COUNCIL_SKILLS.map((s) => `Skill(${s})`));
    directives.push(
      "The council layer is disabled for this session: do not run any /council-* skill. " +
        "Ignore any project instructions that ask you to.",
    );
  }
  return directives.length > 0
    ? { disallowedTools, systemPrompt: `# Aura layer flags\n\n${directives.join("\n\n")}` }
    : { disallowedTools };
}

/** Join prompt fragments with a blank line, dropping empties. */
export function composeSystemPrompt(...parts: Array<string | undefined>): string | undefined {
  const kept = parts.filter((p): p is string => typeof p === "string" && p.length > 0);
  return kept.length > 0 ? kept.join("\n\n") : undefined;
}

// ── Create-session boundary ─────────────────────────────────────────────────

export type LayerBoundaryResult =
  | { ok: true; body: Record<string, unknown>; flags: LayerFlags; warnings: string[] }
  | { ok: false; error: string; status: 409; warnings: string[] };

/**
 * Apply layer flags to a `POST /sessions/create[-stream]` body (called by
 * `routes.ts` after the auto-proceed boundary parse):
 *  - replaces raw `layers` with the resolved {@link LayerFlags} (omitted
 *    when everything is at the prod default);
 *  - `observer` OFF + `councilMode: "council"` → 409 (a council pair IS the
 *    observer layer; silently degrading to a solo session would corrupt an
 *    ablation cell);
 *  - `autoProceed` OFF → drops `autoProceedOnIdle`, so no group is ever
 *    configured to auto-proceed.
 */
export function applyLayerFlagsToCreateBody(
  body: Record<string, unknown>,
  serverFlags: LayerFlags,
): LayerBoundaryResult {
  const { layers: rawLayers, ...rest } = body;
  const { flags, warnings } = resolveSessionLayerFlags(rawLayers, serverFlags);
  if (!flags.observer && rest.councilMode === "council") {
    return {
      ok: false,
      status: 409,
      warnings,
      error: "Observer layer is disabled (COMPANION_LAYER_OBSERVER / layers.observer); Council Mode pairs cannot be created",
    };
  }
  if (!flags.autoProceed && rest.autoProceedOnIdle !== undefined) {
    delete rest.autoProceedOnIdle;
    warnings.push("autoProceed layer is disabled; ignoring autoProceedOnIdle");
  }
  // Prod parity: when both the server default and the session are all-on,
  // the body is forwarded exactly as before C3 (no `layers` key). Otherwise
  // the resolved flags ride along so they persist per session and outrank
  // a later change of the server default.
  const attach = !isDefaultLayerFlags(flags) || !isDefaultLayerFlags(serverFlags);
  return { ok: true, body: attach ? { ...rest, layers: flags } : rest, flags, warnings };
}
