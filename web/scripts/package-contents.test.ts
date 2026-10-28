// The npm package must be able to boot (PLAN Task 9 — hashimoto R1 "test the
// artifact"). pack-smoke found that it could not: server/ imported
// web/scripts/run-stats.ts and web/evals/schema/*, which package.json#files never
// shipped, so `aura-companion` from npm died at startup with "Cannot find module".
//
// This is the cheap static half of that check: every relative import (static or
// dynamic, string literal) from a shipped server/ or bin/ module must resolve to a
// file package.json#files ships. A planted import of an unshipped file proves the
// walker actually looks (meta-check).

import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const WEB = resolve(__dirname, "..");
const pkg = JSON.parse(readFileSync(join(WEB, "package.json"), "utf8")) as { files: string[] };
const includes = pkg.files.filter((f) => !f.startsWith("!"));

function shipped(rel: string): boolean {
  if (/\.test\.tsx?$/.test(rel) || rel.split("/").includes("__fixtures__")) return false;
  return includes.some((f) => (f.endsWith("/") ? rel.startsWith(f) : rel === f));
}

const IMPORT_RE = /(?:from\s+|import\s*\(\s*|import\s+)["'](\.{1,2}\/[^"']+)["']/g;

function relativeImports(src: string): string[] {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  return [...code.matchAll(IMPORT_RE)].map((m) => m[1]);
}

function resolveImport(fromFile: string, spec: string): string | null {
  const base = resolve(dirname(fromFile), spec);
  for (const c of [base, base.replace(/\.js$/, ".ts"), base.replace(/\.js$/, ".tsx"), `${base}.ts`, join(base, "index.ts")]) {
    if (existsSync(c) && !readdirSafe(c)) return c;
  }
  return null;
}
function readdirSafe(p: string): boolean {
  try {
    readdirSync(p);
    return true;
  } catch {
    return false;
  }
}

function shippedSources(): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) {
        if (e.name !== "node_modules") walk(p);
      } else if (/\.tsx?$/.test(e.name) && shipped(relative(WEB, p))) out.push(p);
    }
  };
  for (const d of ["server", "bin"]) walk(join(WEB, d));
  return out;
}

/** Unshipped targets reachable from shipped modules, transitively. */
function unshippedImports(entry: string[]): string[] {
  const bad: string[] = [];
  const seen = new Set<string>();
  const queue = [...entry];
  while (queue.length) {
    const f = queue.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    for (const spec of relativeImports(readFileSync(f, "utf8"))) {
      const target = resolveImport(f, spec);
      if (!target) continue; // non-TS assets and generated files are out of scope here
      const rel = relative(WEB, target);
      if (!shipped(rel)) bad.push(`${relative(WEB, f)} → ${rel}`);
      else queue.push(target);
    }
  }
  return bad;
}

describe("npm package contents", () => {
  it("every module server/ and bin/ import is in package.json#files", () => {
    const sources = shippedSources();
    expect(sources.length).toBeGreaterThan(50);
    expect(unshippedImports(sources)).toEqual([]);
  });

  it("the walker flags an import of an unshipped file (meta-check)", () => {
    expect(relativeImports(`import { x } from "../../scripts/guardrail.js";\nconst y = await import("../evals/a.js");`))
      .toEqual(["../../scripts/guardrail.js", "../evals/a.js"]);
    expect(shipped("scripts/guardrail.ts")).toBe(false);
    expect(shipped("evals/schema/eval-artifact.ts")).toBe(false);
    expect(shipped("server/index.ts")).toBe(true);
    expect(shipped("server/index.test.ts")).toBe(false);
  });
});
