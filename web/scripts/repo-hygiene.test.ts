/**
 * Repo-root hygiene invariants (P7/REPO-JUNK, external tech audit).
 *
 * Each check pins one piece of junk the audit found at the repo root, so it
 * cannot quietly come back:
 *   1. The root package.json only carries husky (for the pre-commit hook). It
 *      used to depend on `the-companion` (the upstream npm package), which
 *      nothing imports — every runtime dependency lives in web/package.json.
 *   2. The root bun.lock is not tracked. It was a pre-fork leftover
 *      (`claude-code-controller` / `the-vibe-companion`) that did not match the
 *      root package.json; CI installs only from web/bun.lock.
 *   3. No stray screenshot.png at the root (the landing copy in
 *      landing/public/ is the one actually served).
 *   4. No tracked path contains an apostrophe. Shell globs, the history-refs
 *      gate (scripts/aura-diet/check-history-refs.py stops a token at `'`)
 *      and quoting in scripts all break on such names.
 *   5. The README does not tell people to install the stale npm package
 *      (`bun install -g` / `bunx aura-companion`); install is via git clone.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// repo-hygiene.test.ts → web/scripts → web → repo root.
const repoRoot = join(fileURLToPath(import.meta.url), "..", "..", "..");

function trackedFiles(): string[] {
  // core.quotepath=false: the default C-quotes non-ASCII names (α, β), which
  // would hide exactly the kind of odd filename this test looks for.
  return execFileSync("git", ["-c", "core.quotepath=false", "ls-files", "-z"], {
    cwd: repoRoot,
    encoding: "utf-8",
  })
    .split("\0")
    .filter(Boolean);
}

describe("repo root hygiene (P7/REPO-JUNK)", () => {
  it("root package.json has no runtime dependencies, only husky", () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf-8"));
    expect(pkg.dependencies ?? {}).toEqual({});
    expect(Object.keys(pkg.devDependencies ?? {})).toEqual(["husky"]);
    // The `prepare: husky` hook is why the root package.json exists at all.
    expect(pkg.scripts?.prepare).toBe("husky");
  });

  it("neither the stale root bun.lock nor the root screenshot.png is tracked", () => {
    const files = new Set(trackedFiles());
    expect(files.has("bun.lock")).toBe(false);
    expect(files.has("screenshot.png")).toBe(false);
    // The lockfile CI actually installs from must stay tracked.
    expect(files.has("web/bun.lock")).toBe(true);
    // The landing still serves its own copy of the screenshot.
    expect(existsSync(join(repoRoot, "landing", "public", "screenshot.png"))).toBe(true);
  });

  it("no tracked path contains an apostrophe", () => {
    expect(trackedFiles().filter((f) => f.includes("'"))).toEqual([]);
  });

  it("README does not recommend installing the stale npm package", () => {
    const readme = readFileSync(join(repoRoot, "README.md"), "utf-8");
    // Any shell line that installs or runs the npm package counts; prose
    // mentioning the package name is fine.
    expect(readme).not.toMatch(/^\s*(?:bunx|npx)\s+aura-companion\b/m);
    expect(readme).not.toMatch(/^\s*(?:bun|npm)\s+(?:install|i|add)\s+-g\s+aura-companion\b/m);
    expect(readme).toContain("git clone https://github.com/antonioshaman/aura-companion.git");
  });
});
