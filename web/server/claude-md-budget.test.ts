// CLAUDE.md budget guard (aura-meta-diet P2/A3).
//
// CLAUDE.md (and AGENTS.md, a symlink to it) is loaded into every Claude Code /
// Codex session, so every byte is paid on every turn. P2/A3 cut it from 33 KB
// to a load-bearing core and moved area-specific detail into on-demand docs
// under docs/architecture/ and docs/conventions/, each linked by one line.
//
// These tests keep that split from silently eroding:
//   1. The core stays within the 15 360-byte budget (spec AC, Story A3).
//   2. Every relative markdown link in CLAUDE.md resolves — a broken link
//      means the moved rules are unreachable, which is the same as deleting them.
//   3. Every moved doc is still linked from CLAUDE.md (no orphaned rules).
//   4. AGENTS.md serves the same bytes as CLAUDE.md (Codex reads AGENTS.md).
//   5. Every inline `bun run <script>` command in CLAUDE.md and the convention
//      docs names a script that exists in the package.json of the directory it
//      runs from (FIX-A3-1: CLAUDE.md told agents to run `bun run kb:record`
//      from the repo root, where it fails with `Script not found`).

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

// Path is relative to web/server since vitest runs from web/.
const REPO_ROOT = resolve(__dirname, "..", "..");
const CLAUDE_MD = resolve(REPO_ROOT, "CLAUDE.md");
const BUDGET_BYTES = 15_360;
const ON_DEMAND_DIRS = ["docs/architecture", "docs/conventions"];

/**
 * Inline code spans containing `bun run <script>`, resolved to the directory
 * the script runs in: `--cwd <dir>` or a leading `cd <dir> &&`, else repo root.
 * Chained commands (`a && bun run b`) inherit the span's cwd.
 */
function bunRunCommands(markdown: string): { span: string; cwd: string; script: string }[] {
  const spans = [...markdown.matchAll(/`([^`\n]*\bbun run\b[^`\n]*)`/g)].map((m) => m[1]);
  return spans.flatMap((span) => {
    const cdPrefix = span.match(/^cd\s+(\S+)\s*&&/);
    return [...span.matchAll(/\bbun run\s+(?:--cwd\s+(\S+)\s+)?([\w:.-]+)/g)].map((m) => ({
      span,
      cwd: m[1] ?? cdPrefix?.[1] ?? ".",
      script: m[2],
    }));
  });
}

function packageScripts(dir: string): Set<string> {
  const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, dir, "package.json"), "utf8"));
  return new Set(Object.keys(pkg.scripts ?? {}));
}

function relativeLinks(markdown: string): string[] {
  // [text](target) where target is not a URL and not a pure #anchor.
  const links = [...markdown.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]);
  return links
    .filter((l) => !/^[a-z]+:/i.test(l) && !l.startsWith("#"))
    .map((l) => l.split("#")[0]);
}

describe("CLAUDE.md budget", () => {
  const content = readFileSync(CLAUDE_MD);
  const text = content.toString("utf8");

  it(`stays within ${BUDGET_BYTES} bytes`, () => {
    // Byte length, not character length: the spec budget is in bytes and the
    // file contains multi-byte characters (arrows in the data-flow diagram).
    expect(content.byteLength).toBeLessThanOrEqual(BUDGET_BYTES);
  });

  it("has only resolvable relative links", () => {
    const broken = relativeLinks(text).filter((l) => !existsSync(resolve(REPO_ROOT, l)));
    expect(broken).toEqual([]);
  });

  it("links every on-demand doc it split out", () => {
    // Adding a doc under docs/architecture|conventions without a CLAUDE.md
    // pointer would leave its rules invisible to agents.
    const linked = new Set(relativeLinks(text));
    const orphans = ON_DEMAND_DIRS.flatMap((dir) =>
      readdirSync(resolve(REPO_ROOT, dir))
        .filter((f) => f.endsWith(".md"))
        .map((f) => `${dir}/${f}`),
    ).filter((p) => !linked.has(p));
    expect(orphans).toEqual([]);
  });

  it("AGENTS.md serves the same content as CLAUDE.md", () => {
    // AGENTS.md is a symlink today; if someone replaces it with a copy the
    // two would drift and Codex sessions would read stale rules.
    const agents = resolve(REPO_ROOT, "AGENTS.md");
    expect(readFileSync(agents).equals(content)).toBe(true);
  });
});

describe("CLAUDE.md commands", () => {
  it("every inline `bun run` names a script that exists where it runs", () => {
    // Agents copy these spans verbatim. `bun run kb:record` from the repo root
    // exits with `Script not found` because kb:* live in web/package.json —
    // the correct form is `bun run --cwd web kb:record`.
    const files = ["CLAUDE.md", ...readdirSync(resolve(REPO_ROOT, "docs/conventions"))
      .filter((f) => f.endsWith(".md"))
      .map((f) => `docs/conventions/${f}`)];
    const missing = files.flatMap((file) =>
      bunRunCommands(readFileSync(resolve(REPO_ROOT, file), "utf8"))
        .filter(({ cwd, script }) => !packageScripts(cwd).has(script))
        .map(({ span, cwd, script }) => `${file}: \`${span}\` (no "${script}" in ${cwd}/package.json)`),
    );
    expect(missing).toEqual([]);
  });

  it("parser resolves --cwd, cd-prefix and root forms", () => {
    // Guards the guard: if the regex stopped matching, the test above would
    // pass vacuously on an empty list.
    expect(bunRunCommands("`bun run kb:record`")).toEqual([
      { span: "bun run kb:record", cwd: ".", script: "kb:record" },
    ]);
    expect(bunRunCommands("`bun run --cwd web kb:record -- <id>`")[0]).toMatchObject({ cwd: "web", script: "kb:record" });
    expect(bunRunCommands("`cd web && bun run typecheck && bun run test -- --coverage`").map((c) => [c.cwd, c.script])).toEqual([
      ["web", "typecheck"],
      ["web", "test"],
    ]);
    expect(packageScripts(".").has("kb:record")).toBe(false);
  });
});
