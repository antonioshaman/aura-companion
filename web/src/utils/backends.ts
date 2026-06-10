import type { BackendType } from "../types.js";
import type { BackendModelInfo } from "../api.js";

export interface ModelOption {
  value: string;
  label: string;
  icon: string;
}

export interface ModeOption {
  value: string;
  label: string;
}

// ─── Icon assignment for dynamically fetched models ──────────────────────────

const MODEL_ICONS: Record<string, string> = {
  "codex": "\u2733",    // ✳ for codex-optimized models
  "max": "\u25A0",      // ■ for max/flagship
  "mini": "\u26A1",     // ⚡ for mini/fast
};

function pickIcon(slug: string, _index: number): string {
  // PLAN-aura-dynamic-model-list Task 13 / Saarinen R1: Claude column
  // stays intentionally icon-less. The geometric fallback set would read
  // as noise when Claude entries grow from 3 to 5-7 items — version
  // number IS the differentiator. Codex tier markers remain.
  if (slug.startsWith("claude-")) return "";
  for (const [key, icon] of Object.entries(MODEL_ICONS)) {
    if (slug.includes(key)) return icon;
  }
  // Council Review 2026-06-04-0823 P1 #7 (React/Web UI) — position-dependent
  // fallback `fallback[index % 4]` was a silent stable-identity regression:
  // if the upstream cache reordered Codex entries, `gpt-5.2` could flip
  // glyphs for the same slug across refreshes. Icon is supposed to be a
  // type marker, not a position marker. Drop the fallback (return "")
  // — more honest about the lack of tier semantics for unrecognised slugs.
  return "";
}

/** Convert server model info to frontend ModelOption with icons. */
export function toModelOptions(models: BackendModelInfo[]): ModelOption[] {
  return models.map((m, i) => ({
    value: m.value,
    label: m.label || m.value,
    icon: pickIcon(m.value, i),
  }));
}

// ─── Static fallbacks ────────────────────────────────────────────────────────

// Static fallback list used when the dynamic Anthropic /v1/models fetch
// is unavailable (no API key configured, or upstream unreachable). Order
// matters: [0] is the default model picked by `pickSessionDefaultModel`.
// Hand-maintained — bump these literals when Anthropic ships a new model.
// Source of truth: https://docs.anthropic.com/en/docs/about-claude/models/overview
export const CLAUDE_MODELS: ModelOption[] = [
  { value: "claude-opus-4-8", label: "Opus 4.8", icon: "" },
  { value: "claude-sonnet-4-6", label: "Sonnet 4.6", icon: "" },
  { value: "claude-haiku-4-5-20251001", label: "Haiku 4.5", icon: "" },
];

export const CODEX_MODELS: ModelOption[] = [
  { value: "gpt-5.3-codex", label: "GPT-5.3 Codex", icon: "\u2733" },
  { value: "gpt-5.2-codex", label: "GPT-5.2 Codex", icon: "\u25C6" },
  { value: "gpt-5.1-codex-max", label: "GPT-5.1 Max", icon: "\u25A0" },
  { value: "gpt-5.2", label: "GPT-5.2", icon: "\u25CF" },
  { value: "gpt-5.1-codex-mini", label: "GPT-5.1 Mini", icon: "\u26A1" },
];

export const CLAUDE_MODES: ModeOption[] = [
  { value: "bypassPermissions", label: "Agent" },
  { value: "plan", label: "Plan" },
];

export const CODEX_MODES: ModeOption[] = [
  { value: "bypassPermissions", label: "Auto" },
  { value: "plan", label: "Plan" },
];

// Skills that conduct interactive discovery (ask the user questions and
// wait for typed answers). Plan permission-mode forces the agent to
// "finalise and exit via ExitPlanMode", which silently overrides the
// discovery loop and substitutes "recommended defaults" for empty input.
// Composer refuses to dispatch these while plan-mode is active.
// EC-20: single exported constant, never inlined at consumers.
// Trust boundary: matched via exact equality on the first token after
// the leading slash, never via startsWith/includes/regex.
export const INTERACTIVE_DISCOVERY_SKILLS = Object.freeze([
  "council-plan-aura",
  "council-plan-aura-v2",
  "council-plan",
  "council-plan-v2",
  "spec-writer",
  "plan-feature",
] as const);

export type InteractiveDiscoverySkill = typeof INTERACTIVE_DISCOVERY_SKILLS[number];

/**
 * Detect whether a composer text matches an interactive-discovery skill
 * invocation. Returns the matched slug, or null.
 *
 * Match rules (Hunt trust-boundary):
 * - Input must start with `/` (after trim).
 * - Strip the leading `/`, lowercase, split on first whitespace.
 * - The first token must equal one of INTERACTIVE_DISCOVERY_SKILLS exactly.
 * - No partial match, no regex — exact equality only.
 */
export function detectInteractiveDiscoverySkill(text: string): InteractiveDiscoverySkill | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;
  const firstToken = trimmed.slice(1).split(/\s+/, 1)[0]?.toLowerCase() ?? "";
  if (firstToken.length === 0) return null;
  for (const slug of INTERACTIVE_DISCOVERY_SKILLS) {
    if (slug === firstToken) return slug;
  }
  return null;
}

/**
 * Decide which permission mode to restore when toggling plan→agent.
 *
 * Contract (Codex fix anchor — DO NOT regress):
 * - `pickRestoreMode("",   true)`  → "default"      (Codex: NEVER bypassPermissions)
 * - `pickRestoreMode("",   false)` → "acceptEdits"  (Claude default unchanged)
 * - `pickRestoreMode(prev, _)`     → prev           (saved prior mode wins)
 *
 * The Codex empty-previous case is the silent-privilege-upgrade canary —
 * landing on "bypassPermissions" granted unrestricted tool execution to a
 * user who never opted in. Cross-ref: feedback_no_sentinel_user_id_fallback.
 */
export function pickRestoreMode(previousMode: string, isCodex: boolean): string {
  if (previousMode.length > 0) return previousMode;
  return isCodex ? "default" : "acceptEdits";
}

// Agent-specific modes: "plan" is excluded because agents are autonomous
// and cannot wait for human plan approval.
export const CLAUDE_AGENT_MODES: ModeOption[] = [
  { value: "bypassPermissions", label: "Full Auto" },
  { value: "acceptEdits", label: "Auto-Edit" },
  { value: "default", label: "Supervised" },
];

export const CODEX_AGENT_MODES: ModeOption[] = [
  { value: "bypassPermissions", label: "Full Auto" },
  { value: "default", label: "Supervised" },
];

// ─── Getters ─────────────────────────────────────────────────────────────────

export function getModelsForBackend(backend: BackendType): ModelOption[] {
  return backend === "codex" ? CODEX_MODELS : CLAUDE_MODELS;
}

export function getModesForBackend(backend: BackendType): ModeOption[] {
  return backend === "codex" ? CODEX_MODES : CLAUDE_MODES;
}

export function getAgentModesForBackend(backend: BackendType): ModeOption[] {
  return backend === "codex" ? CODEX_AGENT_MODES : CLAUDE_AGENT_MODES;
}

export function getDefaultModel(backend: BackendType): string {
  return backend === "codex" ? CODEX_MODELS[0].value : CLAUDE_MODELS[0].value;
}

/**
 * Pick the default model for a NEW session, respecting user preference and
 * the dynamically-fetched list when available.
 *
 * PLAN-aura-dynamic-model-list Task 9. Precedence (highest first):
 *
 *  1. `stickyPreference` — the user's explicit `anthropicModel` from
 *     settings. Wins UNCONDITIONALLY, even when the preference is no
 *     longer in the dynamic list (model deprecated upstream). Frontend
 *     R1 + Friedman R2: silent default-flip from "user's preferred
 *     Sonnet" to "newest Opus" betrays the trust the preference encodes.
 *     ModelSwitcher's existing fallback path (`ModelSwitcher.tsx:29-30`)
 *     renders the value as a custom entry — preference flows through.
 *  2. `dynamic[0].value` — first item of the live list (sorted server-
 *     side: opus > sonnet > haiku, then created_at desc). This is the
 *     "newest Opus" case when the user has no saved preference.
 *  3. `getDefaultModel(backend)` — static fallback (zero-config path).
 *
 * NOTE on signature discipline (Fowler R3): `getDefaultModel` is NOT
 * widened — its job is "the static default for this backend". The new
 * helper composes with it rather than threading optional args through
 * every caller of `getDefaultModel`.
 */
export function pickSessionDefaultModel(
  backend: BackendType,
  dynamic?: readonly ModelOption[] | undefined,
  stickyPreference?: string | null | undefined,
): string {
  if (typeof stickyPreference === "string" && stickyPreference.length > 0) {
    return stickyPreference;
  }
  if (dynamic !== undefined && dynamic.length > 0) {
    return dynamic[0]!.value;
  }
  return getDefaultModel(backend);
}

export function getDefaultMode(backend: BackendType): string {
  return backend === "codex" ? CODEX_MODES[0].value : CLAUDE_MODES[0].value;
}

export function getDefaultAgentMode(backend: BackendType): string {
  return backend === "codex" ? CODEX_AGENT_MODES[0].value : CLAUDE_AGENT_MODES[0].value;
}
