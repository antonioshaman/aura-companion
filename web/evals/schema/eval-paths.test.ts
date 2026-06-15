/**
 * Tests for the eval path-safety helpers. The point of this module is to
 * close the path-traversal gap that `isBoundedToken` leaves open, so the
 * tests are weighted toward the adversarial inputs: `..`, leading dots,
 * embedded slashes, NUL, and symlink escapes.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isEvalSlug, resolveWithinWorkspace, existsWithinWorkspace, EVAL_SLUG_MAX_LEN } from "./eval-paths.js";

describe("isEvalSlug", () => {
  it("accepts ordinary checkpoint-id shaped slugs", () => {
    expect(isEvalSlug("council-plan-0-deadbeef")).toBe(true);
    expect(isEvalSlug("council-implement.v2_3")).toBe(true);
    expect(isEvalSlug("A1")).toBe(true);
  });

  it("rejects the traversal tokens that isBoundedToken would accept", () => {
    // These are the exact strings that pass council-types isBoundedToken(128)
    // (no whitespace, no control chars) but must NOT become a filename.
    expect(isEvalSlug("..")).toBe(false);
    expect(isEvalSlug(".")).toBe(false);
    expect(isEvalSlug("../../etc/cron.d/x")).toBe(false);
    expect(isEvalSlug("a/b")).toBe(false);
    expect(isEvalSlug("a\\b")).toBe(false);
  });

  it("rejects leading-dot (hidden dotfile) slugs", () => {
    expect(isEvalSlug(".git")).toBe(false);
    expect(isEvalSlug(".env")).toBe(false);
    expect(isEvalSlug(".hidden")).toBe(false);
  });

  it("rejects empty, over-length, NUL, and non-string inputs", () => {
    expect(isEvalSlug("")).toBe(false);
    expect(isEvalSlug("a".repeat(EVAL_SLUG_MAX_LEN + 1))).toBe(false);
    expect(isEvalSlug("a\0b")).toBe(false);
    expect(isEvalSlug(undefined)).toBe(false);
    expect(isEvalSlug(123)).toBe(false);
    expect(isEvalSlug(null)).toBe(false);
  });

  it("honours a caller-supplied max length", () => {
    expect(isEvalSlug("abcd", 3)).toBe(false);
    expect(isEvalSlug("abc", 3)).toBe(true);
  });
});

describe("resolveWithinWorkspace / existsWithinWorkspace", () => {
  let root: string;

  beforeAll(() => {
    // realpath the tmp root so macOS /var → /private/var symlinking does not
    // make every bounds check look like an escape.
    root = realpathSync(mkdtempSync(join(tmpdir(), "eval-paths-")));
    mkdirSync(join(root, "sub"), { recursive: true });
    writeFileSync(join(root, "file.txt"), "x");
    writeFileSync(join(root, "sub", "nested.txt"), "y");
    // A symlink that escapes the workspace — the classic bounds-bypass.
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "eval-outside-")));
    writeFileSync(join(outside, "secret.txt"), "s");
    symlinkSync(join(outside, "secret.txt"), join(root, "escape.txt"));
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("resolves an in-bounds existing file to its realpath", () => {
    const resolved = resolveWithinWorkspace(root, "file.txt");
    expect(resolved).toBe(join(root, "file.txt"));
    expect(existsWithinWorkspace(root, "sub/nested.txt")).toBe(true);
  });

  it("returns null for a missing file (drives a grounding downgrade)", () => {
    expect(resolveWithinWorkspace(root, "nope.txt")).toBeNull();
    expect(existsWithinWorkspace(root, "sub/nope.txt")).toBe(false);
  });

  it("returns null for traversal, absolute, NUL, and empty inputs", () => {
    expect(resolveWithinWorkspace(root, "../escape")).toBeNull();
    expect(resolveWithinWorkspace(root, "sub/../../escape")).toBeNull();
    expect(resolveWithinWorkspace(root, "/etc/passwd")).toBeNull();
    expect(resolveWithinWorkspace(root, "a\0b")).toBeNull();
    expect(resolveWithinWorkspace(root, "")).toBeNull();
  });

  it("rejects a symlink that escapes the workspace after realpath", () => {
    // The symlink itself lives inside root, but realpath lands outside →
    // must be rejected, otherwise grounding could be satisfied by a planted
    // symlink to /etc/passwd.
    expect(resolveWithinWorkspace(root, "escape.txt")).toBeNull();
    expect(existsWithinWorkspace(root, "escape.txt")).toBe(false);
  });

  it("throws on a non-absolute or NUL workspace root (caller invariant)", () => {
    expect(() => resolveWithinWorkspace("relative/root", "file.txt")).toThrow();
    expect(() => resolveWithinWorkspace("/abs\0", "file.txt")).toThrow();
  });
});
