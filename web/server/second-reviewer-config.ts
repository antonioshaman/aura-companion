/**
 * W15 multi-model review — configuration for the Council "second opinion".
 *
 * A Council pair's observer reviews every checkpoint on ONE backend/model.
 * The owner found that two different models catch different real bugs
 * (codex: a cancel race; Sonnet: a crash-loop storm), so a pair can name a
 * SECOND reviewer on another backend/model. The host runs it as a one-shot
 * headless review per checkpoint (`second-reviewer.ts`).
 *
 * Setting shape (wire + disk):
 *   reviewer: "off" | "auto" | { backend: "claude" | "codex", model?: string }
 *     - auto = the backend opposite the observer's (codex observer → claude
 *       on the `sonnet` alias; claude observer → codex on its default model)
 *   scope: "review-implement" (default) | "all"
 *     - review-implement = only checkpoints whose phase names a review or an
 *       implementation step (`council-review`, `council-implement-aura`, …);
 *       plan/spec checkpoints are not second-reviewed (cost).
 *
 * Resolution order per group: the group's own file
 * `.council/state/<group>-second-reviewer.json` (written by the server from
 * the create request or `PUT /api/groups/:id/second-reviewer`), else the
 * global Settings default. The observer cannot write `.council/state/`
 * (observer-write-policy), so it cannot switch its own second opinion off.
 */

import { readFileSync } from "node:fs";
import { writeAtomicJson } from "./atomic-write.js";
import { resolveCouncilStatePath } from "./council-state-path.js";

export type SecondReviewerBackend = "claude" | "codex";
export type SecondReviewerSetting = "off" | "auto" | { backend: SecondReviewerBackend; model?: string };
export type SecondReviewScope = "review-implement" | "all";

export interface SecondReviewerConfig {
  reviewer: SecondReviewerSetting;
  scope: SecondReviewScope;
}

export const DEFAULT_SECOND_REVIEWER_CONFIG: Readonly<SecondReviewerConfig> = Object.freeze({
  reviewer: "off",
  scope: "review-implement",
});

/** Claude model for `auto` when the observer runs on codex: the CLI's `sonnet`
 *  alias tracks the current Sonnet, so it never goes stale like a pinned id. */
export const AUTO_CLAUDE_SECOND_REVIEW_MODEL = "sonnet";

export interface ResolvedSecondReviewer {
  backend: SecondReviewerBackend;
  /** Absent = the backend CLI's own default model. */
  model?: string;
}

/** Model ids go into argv (never a shell) — still: bounded, no leading dash
 *  (a `-x` value would be parsed as a flag by the CLI), no whitespace. */
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@\[\]-]{0,127}$/;

export function isValidSecondReviewerModel(model: unknown): model is string {
  return typeof model === "string" && MODEL_PATTERN.test(model);
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** Strict parser for the wire/disk `reviewer` value. Unknown shapes are errors (EC-5). */
export function parseSecondReviewerSetting(raw: unknown): ParseResult<SecondReviewerSetting> {
  if (raw === "off" || raw === "auto") return { ok: true, value: raw };
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
    const o = raw as Record<string, unknown>;
    const keys = Object.keys(o).filter((k) => k !== "backend" && k !== "model");
    if (keys.length > 0) return { ok: false, error: `secondReviewer has unknown keys: ${keys.join(", ")}` };
    if (o.backend !== "claude" && o.backend !== "codex") {
      return { ok: false, error: "secondReviewer.backend must be \"claude\" or \"codex\"" };
    }
    if (o.model === undefined || o.model === null || o.model === "") return { ok: true, value: { backend: o.backend } };
    if (!isValidSecondReviewerModel(o.model)) {
      return { ok: false, error: `secondReviewer.model is not a valid model id: ${JSON.stringify(o.model)}` };
    }
    return { ok: true, value: { backend: o.backend, model: o.model } };
  }
  return { ok: false, error: `secondReviewer must be "off", "auto" or {backend, model} (got ${JSON.stringify(raw)})` };
}

export function parseSecondReviewScope(raw: unknown): ParseResult<SecondReviewScope> {
  if (raw === "review-implement" || raw === "all") return { ok: true, value: raw };
  return { ok: false, error: `secondReviewScope must be "review-implement" or "all" (got ${JSON.stringify(raw)})` };
}

/** Lenient normaliser for the settings file: anything invalid → default. */
export function normalizeSecondReviewerConfig(raw: unknown): SecondReviewerConfig {
  const o = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const reviewer = parseSecondReviewerSetting(o.reviewer);
  const scope = parseSecondReviewScope(o.scope);
  return {
    reviewer: reviewer.ok ? reviewer.value : DEFAULT_SECOND_REVIEWER_CONFIG.reviewer,
    scope: scope.ok ? scope.value : DEFAULT_SECOND_REVIEWER_CONFIG.scope,
  };
}

/** Which backend/model reviews second for an observer on `observerBackend`; null = off. */
export function resolveSecondReviewer(
  setting: SecondReviewerSetting,
  observerBackend: SecondReviewerBackend,
): ResolvedSecondReviewer | null {
  if (setting === "off") return null;
  if (setting === "auto") {
    return observerBackend === "codex"
      ? { backend: "claude", model: AUTO_CLAUDE_SECOND_REVIEW_MODEL }
      : { backend: "codex" };
  }
  return setting.model ? { backend: setting.backend, model: setting.model } : { backend: setting.backend };
}

/**
 * Whether a checkpoint phase is second-reviewed under `scope`. The synthetic
 * `spawn` ack is never reviewed (empty manifest). `review-implement` matches
 * phases that name a review or an implementation step, case-insensitively.
 */
export function isPhaseInSecondReviewScope(phase: string, scope: SecondReviewScope): boolean {
  if (phase === "spawn") return false;
  if (scope === "all") return true;
  return /(review|implement)/i.test(phase);
}

const GROUP_FILE_SUFFIX = "-second-reviewer.json";
const GROUP_FILE_SCHEMA_VERSION = 1;

export type GroupSecondReviewerRead =
  | { ok: true; config: SecondReviewerConfig | null }
  | { ok: false; reason: "path-error" | "unreadable" | "invalid" };

/** The group's own setting, if one was ever written. `config: null` = use the global default. */
export function readGroupSecondReviewer(workspaceRoot: string, groupId: string): GroupSecondReviewerRead {
  const p = resolveCouncilStatePath(workspaceRoot, groupId, GROUP_FILE_SUFFIX);
  if (!p.ok) return { ok: false, reason: "path-error" };
  let raw: string;
  try {
    raw = readFileSync(p.value.absolutePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { ok: true, config: null };
    return { ok: false, reason: "unreadable" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "invalid" };
  }
  if (typeof parsed !== "object" || parsed === null) return { ok: false, reason: "invalid" };
  const o = parsed as Record<string, unknown>;
  if (o.schemaVersion !== GROUP_FILE_SCHEMA_VERSION) return { ok: false, reason: "invalid" };
  const reviewer = parseSecondReviewerSetting(o.reviewer);
  const scope = parseSecondReviewScope(o.scope);
  if (!reviewer.ok || !scope.ok) return { ok: false, reason: "invalid" };
  return { ok: true, config: { reviewer: reviewer.value, scope: scope.value } };
}

export function writeGroupSecondReviewer(
  workspaceRoot: string,
  groupId: string,
  config: SecondReviewerConfig,
): { ok: true } | { ok: false; reason: "path-error" | "write-failed"; detail?: string } {
  const p = resolveCouncilStatePath(workspaceRoot, groupId, GROUP_FILE_SUFFIX);
  if (!p.ok) return { ok: false, reason: "path-error" };
  try {
    writeAtomicJson(p.value.absolutePath, {
      schemaVersion: GROUP_FILE_SCHEMA_VERSION,
      sessionGroupId: groupId,
      reviewer: config.reviewer,
      scope: config.scope,
    });
  } catch (err) {
    return { ok: false, reason: "write-failed", detail: err instanceof Error ? err.message : String(err) };
  }
  return { ok: true };
}

/**
 * Effective config for a group: its own file wins; an unreadable/invalid file
 * falls back to the global default (and the caller logs it) — a broken file
 * must not silently turn a configured second opinion into "off" without a trace.
 */
export function effectiveSecondReviewerConfig(
  workspaceRoot: string,
  groupId: string,
  globalDefault: SecondReviewerConfig,
): { config: SecondReviewerConfig; source: "group" | "global"; readError?: string } {
  const read = readGroupSecondReviewer(workspaceRoot, groupId);
  if (read.ok && read.config) return { config: read.config, source: "group" };
  return { config: globalDefault, source: "global", ...(read.ok ? {} : { readError: read.reason }) };
}
