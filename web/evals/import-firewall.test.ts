/**
 * Import firewall: portable eval code (scorers, schema, recording readers)
 * must depend ONLY on the artifact format, never on `web/server/`. That is
 * what makes "score recordings from any Aura version" real rather than
 * aspirational — the moment a scorer reaches into server internals it can no
 * longer run against an artifact produced by a different build.
 *
 * There is exactly one sanctioned coupling: the grounding rerun (Task 7)
 * re-drives the live `validateObserverFindings`, so it is allow-listed by
 * path. Everything else under web/evals/ (excluding tests, which may import
 * server fixtures) is forbidden from importing server.
 *
 * No eslint in this repo, so this meta-test IS the enforcement mechanism.
 */

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, dirname } from "node:path";

const EVALS_ROOT = dirname(new URL(import.meta.url).pathname);

/** Files permitted to import from web/server/ (the single sanctioned coupling). */
const SERVER_IMPORT_ALLOWLIST = new Set<string>([
  // Task 7 — grounding rerun re-drives the live grounding gate. Not yet
  // created; listed ahead of time so the firewall is correct on day one.
  "scorers/grounding-rerun.ts",
]);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "__fixtures__") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
    } else if (full.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

/** Extract every import/export-from/dynamic-import specifier in a source file. */
function extractSpecifiers(src: string): string[] {
  const specs: string[] = [];
  const patterns = [
    /\bimport\s+[^'"]*?\bfrom\s*['"]([^'"]+)['"]/g,
    /\bexport\s+[^'"]*?\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\s*['"]([^'"]+)['"]/g, // side-effect import
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) specs.push(m[1]!);
  }
  return specs;
}

/** True if a module specifier crosses into web/server/. */
function pointsAtServer(spec: string): boolean {
  return spec.split("/").some((seg) => seg === "server");
}

describe("eval import firewall", () => {
  const files = walk(EVALS_ROOT).filter((f) => !f.endsWith(".test.ts"));

  it("finds eval source files to police (guards against a broken walk)", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    const rel = relative(EVALS_ROOT, file);
    it(`${rel} does not import web/server/ unless allow-listed`, () => {
      const specs = extractSpecifiers(readFileSync(file, "utf8"));
      const serverImports = specs.filter(pointsAtServer);
      if (SERVER_IMPORT_ALLOWLIST.has(rel)) {
        // Allow-listed file MAY import server; nothing to assert beyond that
        // it remains intentional. (Presence of the coupling is fine.)
        return;
      }
      expect(serverImports).toEqual([]);
    });
  }
});
