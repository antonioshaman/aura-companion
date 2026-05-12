import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  assertObserverWriteAllowed,
  isObserverReviewFilenameAllowed,
  isObserverWriteAllowed,
} from "./observer-write-policy.js";

const WS = "/work/repo";

describe("isObserverWriteAllowed", () => {
  // Happy path: only `.council/observer/` and `.council/reviews/` are allowed.
  // The previous `specs/*observer*.md` branch has been removed — specs are
  // human-owned and writes to it from the observer are an attack vector.
  it.each([
    [".council/observer/notes.md", `${WS}/.council/observer/notes.md`],
    [".council/observer/nested/deep.txt", `${WS}/.council/observer/nested/deep.txt`],
    [".council/reviews/phase-1-observer.md", `${WS}/.council/reviews/phase-1-observer.md`],
  ])("allows write to %s", (_rel, abs) => {
    expect(isObserverWriteAllowed(abs, WS)).toBe(true);
  });

  // Hunt P7: code paths and human-owned specs must always be denied.
  it.each([
    ["source file", `${WS}/src/foo.ts`],
    ["package.json", `${WS}/package.json`],
    ["husky hook", `${WS}/.husky/pre-commit`],
    ["checkpoint dir (orchestrator owns this)", `${WS}/.council/checkpoints/phase.json`],
    ["nested under .council root", `${WS}/.council/foo.txt`],
    ["specs file even with observer in name (removed loose match)", `${WS}/specs/foo-observer.md`],
    ["specs file plain", `${WS}/specs/upstream-sync.md`],
  ])("denies write to %s", (_label, target) => {
    expect(isObserverWriteAllowed(target, WS)).toBe(false);
  });

  // Hunt P7: path traversal escape.
  it.each([
    ["parent escape", `${WS}/../etc/passwd`],
    ["nested escape", `${WS}/.council/observer/../../etc/passwd`],
    ["sibling workspace", "/work/other-repo/.council/observer/foo.md"],
  ])("denies traversal: %s", (_label, target) => {
    expect(isObserverWriteAllowed(target, WS)).toBe(false);
  });

  it("rejects NUL byte in target path", () => {
    expect(isObserverWriteAllowed(`${WS}/.council/observer/foo\0.md`, WS)).toBe(false);
  });

  it("rejects relative target path", () => {
    expect(isObserverWriteAllowed(".council/observer/foo.md", WS)).toBe(false);
  });
});

describe("isObserverReviewFilenameAllowed", () => {
  // Filename must end `-observer.md` with a phase-shaped prefix.
  it.each(["plan-observer.md", "council-implement-observer.md", "phase_1.2-observer.md"])(
    "accepts: %s",
    (name) => {
      expect(isObserverReviewFilenameAllowed(name)).toBe(true);
    },
  );

  // Hunt: substring-match is the bug we removed; tight pattern prevents it.
  it.each([
    ["missing -observer.md", "plan.md"],
    ["wrong order", "observer-plan.md"],
    ["traversal", "../etc-observer.md"],
    ["non-md ext", "plan-observer.txt"],
    ["leading dot", ".plan-observer.md"],
  ])("rejects: %s", (_label, name) => {
    expect(isObserverReviewFilenameAllowed(name)).toBe(false);
  });
});

describe("assertObserverWriteAllowed", () => {
  let root: string;

  beforeEach(() => {
    // realpathSync resolves /var/folders → /private/var/folders on macOS so
    // equality checks against the integrated assert (which itself realpaths
    // the resolved write target) hold on both platforms.
    root = realpathSync(mkdtempSync(join(tmpdir(), "obs-write-")));
    mkdirSync(join(root, ".council", "observer"), { recursive: true });
    mkdirSync(join(root, ".council", "reviews"), { recursive: true });
    mkdirSync(join(root, "src"), { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  // Happy path: integrated entry-point resolves and asserts.
  it("returns the resolved path on an allowed write", () => {
    const target = join(root, ".council", "observer", "notes.md");
    const out = assertObserverWriteAllowed(target, root);
    expect(out).toBe(target);
  });

  // Hunt #1 — THE bug the council caught: the previous pure predicate
  // documented "callers must realpath first" in a comment. The new
  // integrated assert does it itself, so a symlinked attack is blocked
  // even when the caller forgets to resolve.
  it("rejects a symlink that points outside the workspace", () => {
    const linkSource = join(root, ".council", "observer", "escape.md");
    const target = "/etc/passwd";
    symlinkSync(target, linkSource);
    expect(() => assertObserverWriteAllowed(linkSource, root)).toThrow(/not allowed/);
  });

  // Symlink target inside the allowed dir is still allowed.
  it("allows a symlink that points to an allowed location", () => {
    const realFile = join(root, ".council", "observer", "real.md");
    writeFileSync(realFile, "x");
    const linked = join(root, ".council", "observer", "linked.md");
    symlinkSync(realFile, linked);
    expect(() => assertObserverWriteAllowed(linked, root)).not.toThrow();
  });

  it("throws on a target outside the workspace", () => {
    expect(() => assertObserverWriteAllowed("/etc/passwd", root)).toThrow(/not allowed/);
  });

  it("throws on a relative target whose resolution lands outside", () => {
    expect(() => assertObserverWriteAllowed("../../etc/passwd", root)).toThrow(/not allowed/);
  });

  it("throws on NUL byte in target", () => {
    expect(() => assertObserverWriteAllowed("\0bad", root)).toThrow(/invalid target/);
  });

  it("throws on non-absolute workspace root", () => {
    expect(() => assertObserverWriteAllowed("foo.md", "relative-root")).toThrow(/workspace root/);
  });
});
