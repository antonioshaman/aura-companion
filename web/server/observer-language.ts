/**
 * Observer claim language (observer rigor, 2026-10-16).
 *
 * The observer's findings are read by the person driving the pair. Observed
 * live 2026-10-13..16 (grp_879b81b6): the user writes Russian, the checkpoint
 * artifacts are Russian, and every observer claim came back in English. The
 * wake now names the language the claims must be written in; identifiers,
 * paths, code and severity tokens stay verbatim (prompt rule).
 *
 * Resolution order (first hit wins):
 *   1. `COMPANION_OBSERVER_CLAIM_LANGUAGE` = `ru` | `en` (operator setting;
 *      `auto` or unset = detect);
 *   2. the language of the user's recent messages to the ORCHESTRATOR;
 *   3. the language of the checkpoint's prose artifacts;
 *   4. none — the prompt's default (English) applies.
 *
 * Detection is a deliberately small script heuristic (Cyrillic vs Latin
 * letters after stripping code, paths and URLs), not a language model: it
 * only has to tell "the human writes Russian" from "the human writes English".
 */

import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";

export type ClaimLanguage = "ru" | "en";

/** Human-readable language names used in the wake directive. */
export const CLAIM_LANGUAGE_NAMES: Record<ClaimLanguage, string> = {
  ru: "Russian (русский)",
  en: "English",
};

/** Minimum letters of evidence before any verdict. */
const MIN_CYRILLIC = 12;
const MIN_LATIN = 40;

/** Remove text that is the same in every language: code, paths, URLs. */
function stripLanguageNeutral(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`\n]*`/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/\S*[/\\]\S*/g, " ")
    .replace(/\b[\w-]+\.[a-z]{1,6}\b/gi, " ");
}

/**
 * Pure: decide the dominant human language of `samples`. Cyrillic wins when
 * it makes up ≥ 30 % of the letters — Russian technical prose is full of
 * Latin identifiers, so a plain majority would misread it as English.
 */
export function detectClaimLanguage(samples: readonly string[]): ClaimLanguage | null {
  let cyrillic = 0;
  let latin = 0;
  for (const sample of samples) {
    const text = stripLanguageNeutral(sample);
    for (const ch of text) {
      if (/[Ѐ-ӿ]/.test(ch)) cyrillic++;
      else if (/[A-Za-z]/.test(ch)) latin++;
    }
  }
  const letters = cyrillic + latin;
  if (cyrillic >= MIN_CYRILLIC && cyrillic / letters >= 0.3) return "ru";
  if (latin >= MIN_LATIN && cyrillic / Math.max(letters, 1) < 0.05) return "en";
  return null;
}

/** Pure: parse the operator override. `auto` / unset / junk = detect. */
export function parseClaimLanguageOverride(raw: string | undefined): ClaimLanguage | null {
  const v = raw?.trim().toLowerCase();
  return v === "ru" || v === "en" ? v : null;
}

export function resolveClaimLanguage(input: {
  override?: string;
  /** Recent user messages to the orchestrator, oldest first. */
  conversation: readonly string[];
  /** Prose read from the checkpoint artifacts — called only when the
   *  conversation is inconclusive (it touches the filesystem). */
  artifactTexts: () => readonly string[];
}): ClaimLanguage | null {
  return (
    parseClaimLanguageOverride(input.override) ??
    detectClaimLanguage(input.conversation) ??
    detectClaimLanguage(input.artifactTexts())
  );
}

/** Server-composed messages in the orchestrator thread (peer findings,
 *  probes) are not the user's own words — never language evidence. */
const NOT_USER_AUTHORED = /^\s*\[(?:from-(?:observer|orchestrator)|liveness[\s-]?probe|probe|ping)\b/i;

/** Pure: the user's last `limit` own messages from a session history. */
export function recentUserTexts(history: readonly unknown[], limit = 8): string[] {
  const out: string[] = [];
  for (let i = history.length - 1; i >= 0 && out.length < limit; i--) {
    const m = history[i] as { type?: unknown; content?: unknown } | null;
    if (!m || m.type !== "user_message" || typeof m.content !== "string") continue;
    if (NOT_USER_AUTHORED.test(m.content)) continue;
    out.unshift(m.content);
  }
  return out;
}

const MAX_ARTIFACT_FILES = 4;
const MAX_ARTIFACT_BYTES = 8 * 1024;
const PROSE_ARTIFACT = /\.(?:md|markdown|mdx|txt|rst)$/i;

/**
 * Read the head of up to {@link MAX_ARTIFACT_FILES} prose artifacts. EC-7:
 * every path is resolved (realpath) and must stay inside the workspace —
 * the containment check is inline, never a bare predicate. Unreadable or
 * outside paths are skipped silently: language detection is best-effort.
 */
export function readProseArtifactSamples(workspaceRoot: string, artifactPaths: readonly string[]): string[] {
  let root: string;
  try {
    root = realpathSync(workspaceRoot);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const p of artifactPaths) {
    if (out.length >= MAX_ARTIFACT_FILES) break;
    if (!PROSE_ARTIFACT.test(p) || isAbsolute(p)) continue;
    try {
      const real = realpathSync(resolve(root, p));
      if (!real.startsWith(root + sep)) continue;
      out.push(readFileSync(real, "utf-8").slice(0, MAX_ARTIFACT_BYTES));
    } catch {
      continue;
    }
  }
  return out;
}
