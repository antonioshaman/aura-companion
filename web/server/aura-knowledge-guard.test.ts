// Aura knowledge-store guard tests (Willison W1).
//
// The six JSONL files under `.agents/knowledge/` are append-only stores
// written by the self-learning skills (/prime, /learn, /self-reflect).
// They must:
//   1. Exist (one file per knowledge category).
//   2. Parse line-by-line as JSON — a corrupted line breaks /prime's load
//      and silently degrades the agent's context across sessions.
//   3. Survive merges byte-equal — verified separately by the merge workflow,
//      not by these tests (CI doesn't have a "before" baseline).
//
// These tests run on every commit (husky pre-commit) so a sed gone wrong
// or a stray edit gets caught immediately, not at the next /prime call.

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

// Path is relative to web/ since vitest runs there.
const KNOWLEDGE_DIR = resolve(__dirname, "..", "..", ".agents", "knowledge");

const EXPECTED_STORES = [
  "patterns.jsonl",
  "gotchas.jsonl",
  "decisions.jsonl",
  "anti-patterns.jsonl",
  "codebase-facts.jsonl",
  "api-behaviors.jsonl",
];

describe("aura knowledge stores", () => {
  it("all six expected JSONL files exist", () => {
    // The self-learning protocol (CLAUDE.md) names six categories; missing
    // one means /prime has nothing to read for that category.
    for (const filename of EXPECTED_STORES) {
      const path = resolve(KNOWLEDGE_DIR, filename);
      expect(existsSync(path), `missing ${filename}`).toBe(true);
    }
  });

  it("every non-empty line in every store parses as JSON", () => {
    // The single most important invariant. A single un-parseable line
    // breaks the load loop. JSONL = one JSON object per line; the file
    // may have a trailing newline (so the last "line" is empty and skipped).
    for (const filename of EXPECTED_STORES) {
      const path = resolve(KNOWLEDGE_DIR, filename);
      const content = readFileSync(path, "utf-8");
      const lines = content.split("\n");
      lines.forEach((line, i) => {
        if (line.trim() === "") return; // empty trailing line is fine
        expect(() => JSON.parse(line), `${filename}:${i + 1} is not valid JSON`).not.toThrow();
      });
    }
  });

  it("every entry has the minimum required fields", () => {
    // Per CLAUDE.md the schema is { id, type, fact, recommendation,
    // confidence, provenance, tags, affectedFiles, createdAt }. We only
    // assert the two fields we reliably depend on across categories — the
    // rest may evolve. Loud failure here means a writer somewhere is
    // emitting the wrong shape and /prime will return shallow context.
    for (const filename of EXPECTED_STORES) {
      const path = resolve(KNOWLEDGE_DIR, filename);
      const content = readFileSync(path, "utf-8");
      for (const line of content.split("\n")) {
        if (line.trim() === "") continue;
        const entry = JSON.parse(line) as Record<string, unknown>;
        expect(entry.id, `${filename}: entry missing id`).toBeTruthy();
        expect(entry.fact, `${filename}: entry missing fact`).toBeTruthy();
      }
    }
  });
});
