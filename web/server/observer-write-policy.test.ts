import { describe, expect, it } from "vitest";
import { isObserverWriteAllowed } from "./observer-write-policy.js";

const WS = "/work/repo";

describe("isObserverWriteAllowed", () => {
  // Happy path: each of the three allowed locations must accept a normal
  // child path. These three are the entire surface the observer may touch.
  it.each([
    [".council/observer/notes.md", `${WS}/.council/observer/notes.md`],
    [".council/observer/nested/deep.txt", `${WS}/.council/observer/nested/deep.txt`],
    [".council/reviews/phase-1-observer.md", `${WS}/.council/reviews/phase-1-observer.md`],
    ["specs/foo-observer.md", `${WS}/specs/foo-observer.md`],
    ["specs/observer.md", `${WS}/specs/observer.md`],
  ])("allows write to %s", (_rel, abs) => {
    expect(isObserverWriteAllowed(abs, WS)).toBe(true);
  });

  // Hunt P7: code paths are the primary attack target — must always deny.
  // A drifted observer prompt overwriting `src/...` is the worst-case scenario.
  it.each([
    ["source file", `${WS}/src/foo.ts`],
    ["package.json", `${WS}/package.json`],
    ["husky hook", `${WS}/.husky/pre-commit`],
    ["checkpoint dir (orchestrator owns this)", `${WS}/.council/checkpoints/phase.json`],
    ["nested under .council root", `${WS}/.council/foo.txt`],
    ["specs file without 'observer' in name", `${WS}/specs/upstream-sync.md`],
    ["specs subdir with observer-named file (two levels)", `${WS}/specs/nested/foo-observer.md`],
    ["specs observer-named but non-markdown", `${WS}/specs/observer.txt`],
  ])("denies write to %s", (_label, target) => {
    expect(isObserverWriteAllowed(target, WS)).toBe(false);
  });

  // Hunt P7: path traversal escape via realpath-resolved `..` must be
  // caught by the predicate too (defence-in-depth — caller should also
  // realpath before calling, but predicate must hold even if they forget).
  it.each([
    ["parent escape", `${WS}/../etc/passwd`],
    ["nested escape", `${WS}/.council/observer/../../etc/passwd`],
    ["sibling workspace", "/work/other-repo/.council/observer/foo.md"],
  ])("denies traversal: %s", (_label, target) => {
    expect(isObserverWriteAllowed(target, WS)).toBe(false);
  });

  // Hunt P7: NUL byte poisoning — some libraries truncate at NUL but
  // sandbox checks may compare the full string. Hard reject either way.
  it("rejects NUL byte in target path", () => {
    expect(isObserverWriteAllowed(`${WS}/.council/observer/foo\0.md`, WS)).toBe(false);
  });

  it("rejects NUL byte in workspace root", () => {
    expect(isObserverWriteAllowed(`${WS}/.council/observer/foo.md`, `${WS}\0`)).toBe(false);
  });

  // Both inputs must be absolute. A relative `target` could not exist in a
  // realpath'd world, but explicit rejection makes the contract clear.
  it("rejects relative target path", () => {
    expect(isObserverWriteAllowed(".council/observer/foo.md", WS)).toBe(false);
  });

  it("rejects relative workspace root", () => {
    expect(isObserverWriteAllowed(`${WS}/.council/observer/foo.md`, "repo")).toBe(false);
  });

  // Writing to the workspace root itself is not an allowed location.
  it("denies writing to workspace root", () => {
    expect(isObserverWriteAllowed(WS, WS)).toBe(false);
  });
});
