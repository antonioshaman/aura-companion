#!/usr/bin/env bun
/**
 * sync-claude-models.ts — fetches Anthropic /v1/models, picks the newest
 * model per tier (opus, sonnet, haiku), rewrites the AUTO-GENERATED block
 * of `web/src/utils/backends.ts`.
 *
 * Invoked daily by `.github/workflows/sync-claude-models.yml`. End users
 * who never configure their own ANTHROPIC_API_KEY in Aura Settings still
 * get a fresh static fallback list via the next aura-companion release —
 * the maintainer's API key (stored as a repo secret) does the upstream
 * read on behalf of all installs.
 *
 * Exit codes:
 *   0 — file unchanged OR file rewritten with new contents. Workflow
 *       inspects `git diff` to decide whether to open a PR.
 *   1 — fatal error (missing env, network failure, parser reject).
 *       Workflow surfaces the error to the maintainer.
 *
 * Re-uses the canonical parser + sort from
 * `web/server/anthropic-models-cache.ts` so this script and the
 * runtime cache module agree on edge cases (Trojan-Source defence,
 * tier ordering, version-aware numeric tiebreaker).
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseAnthropicModelsResponse,
  sortAnthropicModels,
  ANTHROPIC_MODELS_URL,
  ANTHROPIC_VERSION_HEADER,
} from "../server/anthropic-models-cache.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const BACKENDS_TS = join(HERE, "..", "src", "utils", "backends.ts");
const SENTINEL_START = "// AUTO-GENERATED:CLAUDE-MODELS-START";
const SENTINEL_END = "// AUTO-GENERATED:CLAUDE-MODELS-END";

export interface ModelLiteral {
  value: string;
  label: string;
}

/** Drop "Claude " prefix from upstream display_name to match repo label style. */
export function stripClaudePrefix(name: string): string {
  return name.replace(/^Claude\s+/, "");
}

interface SortedAnthropicModel {
  id: string;
  display_name: string | undefined;
  created_at: number | undefined;
}

/**
 * Pick the newest model per tier (opus, sonnet, haiku) from a list
 * already sorted opus>sonnet>haiku then created_at desc. Order in
 * the output matches the static fallback contract.
 */
export function pickTopPerTier(
  sorted: ReadonlyArray<SortedAnthropicModel>,
): ModelLiteral[] {
  const out: ModelLiteral[] = [];
  const seen = new Set<string>();
  for (const m of sorted) {
    const tier = m.id.includes("opus")
      ? "opus"
      : m.id.includes("sonnet")
        ? "sonnet"
        : m.id.includes("haiku")
          ? "haiku"
          : null;
    if (tier === null || seen.has(tier)) continue;
    seen.add(tier);
    out.push({
      value: m.id,
      label: m.display_name ? stripClaudePrefix(m.display_name) : m.id,
    });
  }
  return out;
}

/**
 * Render the CLAUDE_MODELS literal block (between the AUTO-GENERATED
 * sentinels). Output is deterministic — same input always produces
 * byte-identical output so a no-op run leaves git tree clean.
 */
export function renderClaudeModelsLiteral(picks: ReadonlyArray<ModelLiteral>): string {
  const indent = "  ";
  const lines = picks.map(
    (p) => `${indent}{ value: "${p.value}", label: "${p.label}", icon: "" },`,
  );
  return [
    "export const CLAUDE_MODELS: ModelOption[] = [",
    ...lines,
    "];",
  ].join("\n");
}

/**
 * Replace the block between SENTINEL_START and SENTINEL_END (exclusive
 * of the sentinel lines themselves) with `newBlock`. Throws on missing
 * sentinels so a malformed source file doesn't silently corrupt.
 */
export function rewriteBlock(source: string, newBlock: string): string {
  const startIdx = source.indexOf(SENTINEL_START);
  const endIdx = source.indexOf(SENTINEL_END);
  if (startIdx < 0 || endIdx < 0 || endIdx <= startIdx) {
    throw new Error(
      `sync-claude-models: sentinels not found in source (start=${startIdx}, end=${endIdx})`,
    );
  }
  const before = source.slice(0, startIdx + SENTINEL_START.length);
  const after = source.slice(endIdx);
  return `${before}\n${newBlock}\n${after}`;
}

async function main(): Promise<number> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey === undefined || apiKey.length === 0) {
    console.error(
      "sync-claude-models: ANTHROPIC_API_KEY env var is not set. " +
        "Add it as a repository secret (see docs/deploy/sync-claude-models.mdx).",
    );
    return 1;
  }

  let res: Response;
  try {
    res = await fetch(ANTHROPIC_MODELS_URL, {
      method: "GET",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION_HEADER,
        accept: "application/json",
      },
    });
  } catch (e) {
    console.error(`sync-claude-models: fetch failed: ${(e as Error).message}`);
    return 1;
  }

  if (!res.ok) {
    console.error(
      `sync-claude-models: Anthropic /v1/models HTTP ${res.status}`,
    );
    return 1;
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch (e) {
    console.error(`sync-claude-models: response JSON parse failed: ${(e as Error).message}`);
    return 1;
  }

  const parsed = parseAnthropicModelsResponse(json);
  if (!parsed.ok) {
    console.error(`sync-claude-models: parser rejected response — reason=${parsed.reason}`);
    return 1;
  }
  if (parsed.models.length === 0) {
    console.error("sync-claude-models: no models survived parser");
    return 1;
  }

  const sorted = sortAnthropicModels(parsed.models);
  const picks = pickTopPerTier(sorted);
  if (picks.length === 0) {
    console.error("sync-claude-models: no opus/sonnet/haiku tier match in upstream response");
    return 1;
  }

  const newBlock = renderClaudeModelsLiteral(picks);
  const current = readFileSync(BACKENDS_TS, "utf8");
  const updated = rewriteBlock(current, newBlock);
  if (current === updated) {
    console.log("sync-claude-models: no change — backends.ts already current.");
    return 0;
  }
  writeFileSync(BACKENDS_TS, updated);
  console.log("sync-claude-models: updated backends.ts");
  for (const p of picks) {
    console.log(`  ${p.value} (${p.label})`);
  }
  return 0;
}

// Allow `bun run` import without executing (for tests). Detect direct
// invocation via `import.meta.main` (Bun-specific) or argv comparison.
const isDirect =
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (import.meta as any).main === true ||
  process.argv[1] === fileURLToPath(import.meta.url);
if (isDirect) {
  const code = await main();
  process.exit(code);
}
