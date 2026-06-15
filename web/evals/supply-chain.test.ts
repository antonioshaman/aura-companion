/**
 * Supply-chain hygiene for the eval harness. Two independent guards:
 *
 *   1. Secret-scanner over every checked-in fixture. Synthetic fixtures bypass
 *      the real-recording redaction gate, so this is the backstop that catches
 *      a credential that slipped into a hand-authored fixture. The marker set
 *      mirrors the recorder's redaction policy (sk-…, sk-ant-…, Bearer …,
 *      gh*_…, github_pat_…, openai_api_key, bare 64-hex auth token). A real
 *      token in any fixture fails the suite.
 *
 *   2. Pack-exclusion guard. The eval tree is dev/CI tooling and must never
 *      ship in the published npm package. `bun pm pack --dry-run` enumerates
 *      the exact tarball contents; we assert no `evals/` path appears, so an
 *      accidental `package.json#files` change that vacuums the harness into the
 *      tarball is caught here rather than in a release.
 */

import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const FIXTURES_DIR = join(__dirname, "__fixtures__");
const WEB_ROOT = join(__dirname, "..");

/** Secret-shaped value patterns — kept aligned with the recorder's
 *  SECRET_VALUE_PATTERNS. Inlined (not imported) to keep the eval tree off any
 *  server coupling and make the guard self-contained. */
const SECRET_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: "anthropic sk-ant key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { name: "openai sk- key", re: /\bsk-(?:proj-|user-|svcacct-)?[A-Za-z0-9_-]{20,}\b/ },
  { name: "Bearer token", re: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/ },
  { name: "github token", re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { name: "github fine-grained PAT", re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/ },
  { name: "openai_api_key key name with value", re: /openai_api_key["'\s:=]+[A-Za-z0-9_-]{20,}/i },
  { name: "token= query credential", re: /[?&](?:token|access_token)=[A-Za-z0-9._~+/=-]{16,}/ },
  { name: "bare 64-hex auth token", re: /\b[0-9a-f]{64}\b/ },
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

describe("fixture secret-scanner", () => {
  const files = walk(FIXTURES_DIR);

  it("finds fixtures to scan (guards against a broken walk)", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    const rel = relative(FIXTURES_DIR, file);
    it(`${rel} contains no secret-shaped values`, () => {
      const text = readFileSync(file, "utf8");
      const hits = SECRET_PATTERNS.filter((p) => p.re.test(text)).map((p) => p.name);
      expect(hits, `secret marker(s) in ${rel}: ${hits.join(", ")}`).toEqual([]);
    });
  }

  it("the scanner actually fires on a planted secret (meta-check)", () => {
    const planted = 'authorization: "Bearer sk-ant-abcdefghijklmnopqrstuvwxyz0123456789"';
    const hits = SECRET_PATTERNS.filter((p) => p.re.test(planted));
    expect(hits.length).toBeGreaterThan(0);
  });
});

describe("pack-exclusion guard", () => {
  it("the eval tree never enters the published npm tarball", () => {
    const out = execFileSync("bun", ["pm", "pack", "--dry-run"], {
      cwd: WEB_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const evalLines = out
      .split("\n")
      .filter((l) => /(^|[\s/])evals\//.test(l) || /\bci-baseline\.json\b/.test(l));
    expect(evalLines, `evals/ leaked into pack:\n${evalLines.join("\n")}`).toEqual([]);
  });

  it("package.json#files does not list the eval tree", () => {
    const pkg = JSON.parse(readFileSync(join(WEB_ROOT, "package.json"), "utf8")) as {
      files?: string[];
    };
    const files = pkg.files ?? [];
    expect(files.some((f) => f.includes("evals"))).toBe(false);
  });
});
