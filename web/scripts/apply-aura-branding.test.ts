// Tests for the Aura branding script.
//
// Beck B6 — idempotence test: running twice produces byte-identical output.
// Hunt H4 — protected-paths and keepUpstreamMarker behavior.
// Fowler F4 — config-as-data: the executor is dumb, the config is truth.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import {
  applyReplacementsToFile,
  isProtected,
  matchesContexts,
  type BrandingConfig,
} from "./apply-aura-branding.js";

const SCRIPT_PATH = join(__dirname, "apply-aura-branding.ts");

// A minimal config used by unit-level tests below.
const TEST_CONFIG: BrandingConfig = {
  replacements: [
    { from: "Vibe-Companion", to: "Aura Companion" },
    { from: "Vibe Companion", to: "Aura Companion" },
    { from: "The Companion", to: "Aura Companion" },
    {
      from: "the-companion",
      to: "aura-companion",
      contexts: ["**/*.json", "**/*.md", "**/*.ts"],
    },
  ],
  protectedPaths: [
    "node_modules/**",
    "**/node_modules/**",
    "*.lock",
    ".env",
    "**/*.jsonl",
    ".agents/knowledge/**",
  ],
  keepUpstreamMarker: "aura-keep-upstream-name",
};

describe("applyReplacementsToFile", () => {
  it("replaces user-facing strings with Aura equivalents", () => {
    // The replacer must hit all three branding variants in one pass.
    const input = "Welcome to The Companion. Forked from Vibe Companion (the upstream Vibe-Companion project).";
    const out = applyReplacementsToFile(input, "README.md", TEST_CONFIG);
    expect(out).toBe(
      "Welcome to Aura Companion. Forked from Aura Companion (the upstream Aura Companion project).",
    );
  });

  it("is idempotent — second pass produces no further change", () => {
    // The ground-truth invariant from Beck B6: the script must converge in one pass.
    // If we run it again on the result, the result must be byte-identical.
    const input = "v1.0 of the-companion (forked from The Companion)";
    const first = applyReplacementsToFile(input, "package.json", TEST_CONFIG);
    const second = applyReplacementsToFile(first, "package.json", TEST_CONFIG);
    expect(second).toBe(first);
  });

  it("skips a line marked with the keep-upstream marker on the same line", () => {
    // Per Hunt H4 — line-anchored allowlist. Code that legitimately queries
    // upstream's npm package (e.g. the update-checker) must keep "the-companion".
    const input = [
      "const url = `https://registry.npmjs.org/the-companion`; // aura-keep-upstream-name",
      "const fallback = 'the-companion';",
    ].join("\n");
    const out = applyReplacementsToFile(input, "src/checker.ts", TEST_CONFIG);
    const [line0, line1] = out.split("\n");
    // Line 0 has the marker → unchanged.
    expect(line0).toContain("the-companion");
    expect(line0).not.toContain("aura-companion");
    // Line 1 has no marker → replaced.
    expect(line1).toContain("aura-companion");
    expect(line1).not.toContain("the-companion");
  });

  it("skips a line whose preceding line has the keep-upstream marker", () => {
    // The marker can sit on the line before the protected reference,
    // which is more readable for multi-line strings.
    const input = [
      "// aura-keep-upstream-name — query upstream package, not Aura's name",
      "const url = `https://registry.npmjs.org/the-companion`;",
      "const otherUrl = 'the-companion';",
    ].join("\n");
    const out = applyReplacementsToFile(input, "src/checker.ts", TEST_CONFIG);
    const [, line1, line2] = out.split("\n");
    // Line 1 protected by previous line's marker.
    expect(line1).toContain("the-companion");
    // Line 2 is two lines past the marker → replaced.
    expect(line2).toContain("aura-companion");
  });

  it("respects context globs — replacement only applies to matching extensions", () => {
    // The "the-companion" → "aura-companion" replacement is contexts-gated.
    // A file outside those contexts (e.g. a .yml workflow) must be left alone
    // by that replacement, but generic "Vibe Companion" still applies everywhere.
    const input = "name: the-companion-build\ndescription: Vibe Companion CI";
    const out = applyReplacementsToFile(input, ".github/workflows/ci.yml", TEST_CONFIG);
    expect(out).toContain("the-companion-build"); // .yml not in contexts
    expect(out).toContain("Aura Companion"); // generic replacement still applies
  });
});

describe("isProtected", () => {
  it("matches deeply-nested node_modules", () => {
    expect(isProtected("web/node_modules/foo/bar.ts", TEST_CONFIG.protectedPaths)).toBe(true);
  });

  it("matches root-level lockfile patterns", () => {
    expect(isProtected("bun.lock", TEST_CONFIG.protectedPaths)).toBe(true);
    expect(isProtected("package.lock", TEST_CONFIG.protectedPaths)).toBe(true);
  });

  it("protects .agents/knowledge — Willison W1 (knowledge as user data, never sed'd)", () => {
    expect(isProtected(".agents/knowledge/patterns.jsonl", TEST_CONFIG.protectedPaths)).toBe(true);
  });

  it("does NOT protect ordinary source files", () => {
    expect(isProtected("web/src/components/MessageBubble.tsx", TEST_CONFIG.protectedPaths)).toBe(false);
  });
});

describe("matchesContexts", () => {
  it("matches multiple extensions in the contexts list", () => {
    const ctx = ["**/*.ts", "**/*.tsx"];
    expect(matchesContexts("web/src/foo.ts", ctx)).toBe(true);
    expect(matchesContexts("web/src/foo.tsx", ctx)).toBe(true);
    expect(matchesContexts("web/src/foo.css", ctx)).toBe(false);
  });

  it("returns true when no contexts specified (replacement is global)", () => {
    expect(matchesContexts("anywhere/anything.txt", undefined)).toBe(true);
    expect(matchesContexts("anywhere/anything.txt", [])).toBe(true);
  });
});

describe("end-to-end script run on a fixture tree", () => {
  // Beck B6 — full-script idempotence: spawn the actual script binary,
  // run it twice, assert byte-identical filesystem output.

  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "branding-test-"));

    // Fixture: mix of files needing replacement, files protected, files
    // with the keep-upstream marker, files in protected directories.
    const files: Record<string, string> = {
      "README.md": "# The Companion\n\nForked from Vibe Companion. Install: `bunx the-companion`.",
      "package.json": JSON.stringify({ name: "the-companion", version: "1.0.0" }, null, 2),
      "src/checker.ts": [
        "// aura-keep-upstream-name — we query upstream's package on purpose",
        "const PKG = 'the-companion';",
        "const TITLE = 'The Companion';",
      ].join("\n"),
      "node_modules/some-lib/index.js": "// The Companion is a great upstream",
      "bun.lock": "the-companion@0.95.0",
      ".agents/knowledge/patterns.jsonl": JSON.stringify({
        fact: "Vibe Companion is the upstream of Aura",
      }),
      ".github/workflows/ci.yml": "name: build\non: push\nenv:\n  PKG: the-companion",
    };

    for (const [rel, content] of Object.entries(files)) {
      const abs = join(tempDir, rel);
      mkdirSync(join(abs, ".."), { recursive: true });
      writeFileSync(abs, content);
    }

    // Drop a config file referencing relative-temp-dir's protected paths.
    writeFileSync(
      join(tempDir, "branding.config.json"),
      JSON.stringify(TEST_CONFIG, null, 2),
    );
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("rewrites unprotected files and leaves protected/marked content alone", () => {
    const result = runScript(tempDir);
    expect(result.status).toBe(0);

    const readme = readFileSync(join(tempDir, "README.md"), "utf-8");
    expect(readme).not.toContain("The Companion");
    expect(readme).not.toContain("Vibe Companion");
    // .md is in contexts → "the-companion" replaced too.
    expect(readme).toContain("aura-companion");

    // package.json is .json (in contexts) → replaced.
    const pkg = JSON.parse(readFileSync(join(tempDir, "package.json"), "utf-8"));
    expect(pkg.name).toBe("aura-companion");

    // src/checker.ts: marker on previous line protects line 1, but not line 2.
    const checker = readFileSync(join(tempDir, "src/checker.ts"), "utf-8");
    const lines = checker.split("\n");
    expect(lines[1]).toContain("the-companion"); // protected by marker
    expect(lines[2]).toContain("Aura Companion"); // generic replacement still applies

    // node_modules untouched.
    const lib = readFileSync(join(tempDir, "node_modules/some-lib/index.js"), "utf-8");
    expect(lib).toContain("The Companion");

    // bun.lock untouched (lock pattern).
    const lock = readFileSync(join(tempDir, "bun.lock"), "utf-8");
    expect(lock).toContain("the-companion");

    // .agents/knowledge/*.jsonl untouched (Willison W1 invariant).
    const knowledge = readFileSync(join(tempDir, ".agents/knowledge/patterns.jsonl"), "utf-8");
    expect(knowledge).toContain("Vibe Companion");
  });

  it("is byte-idempotent across two runs", () => {
    // The Beck B6 ground truth: run twice → diff of run-2 against run-1 is empty.
    runScript(tempDir);
    const snapshot1 = snapshotTree(tempDir);
    runScript(tempDir);
    const snapshot2 = snapshotTree(tempDir);
    expect(snapshot2).toEqual(snapshot1);
  });

  it("dry-run does not modify the filesystem", () => {
    const before = snapshotTree(tempDir);
    const result = runScript(tempDir, ["--dry-run"]);
    expect(result.status).toBe(0);
    const after = snapshotTree(tempDir);
    expect(after).toEqual(before);
    expect(result.stdout).toContain("dry-run");
  });
});

// Helpers ────────────────────────────────────────────────────────────────────

function runScript(root: string, extraArgs: string[] = []): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(
    "bun",
    [SCRIPT_PATH, "--root", root, "--config", join(root, "branding.config.json"), "--no-staged-check", ...extraArgs],
    { encoding: "utf-8" },
  );
  return {
    status: result.status ?? -1,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

interface TreeSnapshot {
  [relPath: string]: string;
}

function snapshotTree(root: string): TreeSnapshot {
  const out: TreeSnapshot = {};
  const stack: string[] = [""];
  while (stack.length > 0) {
    const rel = stack.pop()!;
    const abs = rel ? join(root, rel) : root;
    if (!existsSync(abs)) continue;
    const stat = require("node:fs").statSync(abs);
    if (stat.isDirectory()) {
      const entries = require("node:fs").readdirSync(abs);
      for (const entry of entries) stack.push(rel ? join(rel, entry) : entry);
    } else if (stat.isFile()) {
      out[rel] = require("node:fs").readFileSync(abs, "utf-8");
    }
  }
  return out;
}
