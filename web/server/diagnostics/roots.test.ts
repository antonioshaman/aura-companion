// Tests for the Diagnostics filesystem roots (EC-7, plan Task 3).
//
// What is validated:
//   - the project slug matches the Claude CLI rule (`/` and `_` → `-`), so the
//     memory root points at the same dir the CLI writes;
//   - resolveInside rejects absolute paths, `..`, NUL, symlinks (even ones
//     pointing inside), and accepts a not-yet-existing file inside the root;
//   - resolveRootPath resolves through the nearest existing ancestor, so a
//     reports dir that has not been created yet still gets a canonical path.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { claudeProjectSlug, PathOutsideRootError, resolveInside, resolveRootPath } from "./roots.js";

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "diag-roots-")));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("claudeProjectSlug", () => {
  it("replaces both slashes and underscores with dashes", () => {
    expect(claudeProjectSlug("/root/aura-companion")).toBe("-root-aura-companion");
    expect(claudeProjectSlug("/root/Rapesha_shop_bot")).toBe("-root-Rapesha-shop-bot");
  });
});

describe("resolveInside", () => {
  it("accepts a plain file and a not-yet-existing file inside the root", () => {
    writeFileSync(join(dir, "gotchas.jsonl"), "");
    expect(resolveInside(dir, "gotchas.jsonl")).toBe(join(dir, "gotchas.jsonl"));
    expect(resolveInside(dir, "archive/gotchas.jsonl")).toBe(join(dir, "archive", "gotchas.jsonl"));
  });

  it.each(["/etc/passwd", "../settings.json", "archive/../../x", "a\0b", ""])("rejects %j", (rel) => {
    expect(() => resolveInside(dir, rel)).toThrow(PathOutsideRootError);
  });

  it("rejects a symlink, even one pointing inside the root", () => {
    writeFileSync(join(dir, "real.jsonl"), "");
    symlinkSync(join(dir, "real.jsonl"), join(dir, "link.jsonl"));
    expect(() => resolveInside(dir, "link.jsonl")).toThrow(PathOutsideRootError);
  });
});

describe("resolveRootPath", () => {
  it("resolves a missing dir through its nearest existing ancestor", () => {
    mkdirSync(join(dir, "a"));
    expect(resolveRootPath(join(dir, "a", "b", "c"))).toBe(join(dir, "a", "b", "c"));
  });
});
