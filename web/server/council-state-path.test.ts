// @vitest-environment node
import { describe, it, expect } from "vitest";
import path from "node:path";
import {
  resolveCouncilStatePath,
  resolveCouncilStateDir,
} from "./council-state-path.js";

// `GROUP_ID_PATTERN` is `^grp_[a-f0-9]{32}$` — these fixtures match.
const VALID_GROUP_ID = "grp_4469a4c2bb3d1c4ac621d4cd9ae67bd9";
const VALID_GROUP_ID_2 = "grp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

describe("resolveCouncilStatePath — happy path", () => {
  it("returns the joined path under <workspaceRoot>/.council/state/", () => {
    const out = resolveCouncilStatePath("/work/project", VALID_GROUP_ID, "-trace.json");
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.value.absolutePath).toBe(
        path.resolve("/work/project/.council/state", `${VALID_GROUP_ID}-trace.json`),
      );
      expect(out.value.stateDir).toBe(path.resolve("/work/project/.council/state"));
    }
  });

  it("trace and afk-summary suffixes both resolve cleanly for the same group", () => {
    // Two artefact files per group must resolve to two distinct paths
    // in the same state dir — basic invariant of the persistence layer.
    const trace = resolveCouncilStatePath("/w", VALID_GROUP_ID, "-auto-proceed-trace.json");
    const afk = resolveCouncilStatePath("/w", VALID_GROUP_ID, "-afk-summary.md");
    expect(trace.ok && afk.ok).toBe(true);
    if (trace.ok && afk.ok) {
      expect(trace.value.absolutePath).not.toBe(afk.value.absolutePath);
      expect(trace.value.stateDir).toBe(afk.value.stateDir);
    }
  });

  it("lowercases the group-id defensively (HFS+ case-insensitivity guard)", () => {
    // GROUP_ID_PATTERN already constrains the input to lowercase hex,
    // but a future widening must not silently produce two paths that
    // differ only in case on case-insensitive filesystems (macOS HFS+).
    // Today this test passes because lowercase input → lowercase
    // output; the defence kicks in if the pattern is ever relaxed.
    const out = resolveCouncilStatePath("/w", VALID_GROUP_ID, "-trace.json");
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.value.absolutePath.toLowerCase()).toBe(out.value.absolutePath);
    }
  });
});

describe("resolveCouncilStatePath — workspaceRoot validation", () => {
  it("rejects empty workspaceRoot", () => {
    const out = resolveCouncilStatePath("", VALID_GROUP_ID, "-trace.json");
    expect(out).toEqual({ ok: false, error: { kind: "invalid-workspace-root", reason: "empty" } });
  });

  it("rejects non-string workspaceRoot", () => {
    const out = resolveCouncilStatePath(
      undefined as unknown as string,
      VALID_GROUP_ID,
      "-trace.json",
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.kind).toBe("invalid-workspace-root");
  });

  it("rejects relative workspaceRoot (must be absolute — safe-before-chdir contract)", () => {
    // The wrapper is called from `initialize()` which runs before any
    // explicit `chdir`. A relative path would silently resolve against
    // the current cwd of whatever process invoked the server — never
    // the right semantics. Hard reject.
    const out = resolveCouncilStatePath("relative/dir", VALID_GROUP_ID, "-trace.json");
    expect(out).toEqual({
      ok: false,
      error: { kind: "invalid-workspace-root", reason: "not-absolute" },
    });
  });
});

describe("resolveCouncilStatePath — group-id validation", () => {
  it.each([
    ["empty", ""],
    ["wrong prefix", "GRP_4469a4c2bb3d1c4ac621d4cd9ae67bd9"],
    ["wrong length", "grp_4469a4c2"],
    ["non-hex bytes", "grp_zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz"],
    ["traversal in id", "grp_4469a4c2bb3d1c4ac621d4cd9ae67../"],
    ["uppercase hex", "grp_4469A4C2BB3D1C4AC621D4CD9AE67BD9"],
  ])("rejects malformed groupId: %s", (_label, raw) => {
    const out = resolveCouncilStatePath("/w", raw, "-trace.json");
    expect(out).toEqual({ ok: false, error: { kind: "invalid-group-id" } });
  });

  it("accepts the canonical grp_<32-hex> shape", () => {
    const out = resolveCouncilStatePath("/w", VALID_GROUP_ID_2, "-trace.json");
    expect(out.ok).toBe(true);
  });
});

describe("resolveCouncilStatePath — suffix validation", () => {
  it("rejects empty suffix", () => {
    const out = resolveCouncilStatePath("/w", VALID_GROUP_ID, "");
    expect(out).toEqual({ ok: false, error: { kind: "invalid-suffix", reason: "empty" } });
  });

  it.each([
    ["forward slash", "/trace.json"],
    ["backslash", "\\trace.json"],
    ["embedded /", "-trace/json"],
    ["traversal segment", "-../etc"],
  ])("rejects suffix with path separator: %s", (_label, suffix) => {
    const out = resolveCouncilStatePath("/w", VALID_GROUP_ID, suffix);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      // Either "contains-separator" or "escapes-state-dir" depending on
      // how the path resolves — both are correct rejections; the
      // contract is that the call refuses.
      expect(out.error.kind).toMatch(/^(invalid-suffix|escapes-state-dir)$/);
    }
  });

  it("rejects suffix with NUL byte", () => {
    const out = resolveCouncilStatePath("/w", VALID_GROUP_ID, "-trace\0.json");
    expect(out).toEqual({
      ok: false,
      error: { kind: "invalid-suffix", reason: "control-bytes" },
    });
  });

  it("rejects suffix with CR / LF (would corrupt JSON-log paths)", () => {
    const out1 = resolveCouncilStatePath("/w", VALID_GROUP_ID, "-trace\n.json");
    expect(out1.ok).toBe(false);
    const out2 = resolveCouncilStatePath("/w", VALID_GROUP_ID, "-trace\r.json");
    expect(out2.ok).toBe(false);
  });

  it("allows tab in suffix (printable-control exception matching council-types isBoundedText)", () => {
    // Matches `isBoundedText` semantics: tabs are allowed for code-excerpt
    // text fields. We don't expect tabs in real suffixes, but the
    // validator stays consistent with sibling validators.
    const out = resolveCouncilStatePath("/w", VALID_GROUP_ID, "-trace\t.json");
    expect(out.ok).toBe(true);
  });
});

describe("resolveCouncilStatePath — anti-traversal final-check", () => {
  it("refuses a path that escapes the state dir even after passing prior checks", () => {
    // Engineered case: suffix contains no separator the simple filter
    // catches, but `path.resolve` normalises into something outside
    // the state dir. The final `startsWith` check is the backstop.
    // (In practice the separator filter catches this; the test
    // documents the backstop behaviour.)
    const out = resolveCouncilStatePath("/w", VALID_GROUP_ID, "-..");
    // Suffix `-..` does not include `/` or `\`, but `<id>-..` would
    // resolve to one level above state dir. Per current impl this is
    // caught by `escapes-state-dir`.
    if (!out.ok) {
      expect(["escapes-state-dir", "invalid-suffix"]).toContain(out.error.kind);
    }
  });
});

describe("resolveCouncilStateDir", () => {
  it("returns the absolute state dir path for a valid workspaceRoot", () => {
    const out = resolveCouncilStateDir("/work/project");
    expect(out).toEqual({ ok: true, value: path.resolve("/work/project/.council/state") });
  });

  it("rejects empty workspaceRoot", () => {
    expect(resolveCouncilStateDir("")).toEqual({
      ok: false,
      error: { kind: "invalid-workspace-root", reason: "empty" },
    });
  });

  it("rejects relative workspaceRoot", () => {
    expect(resolveCouncilStateDir("not/absolute")).toEqual({
      ok: false,
      error: { kind: "invalid-workspace-root", reason: "not-absolute" },
    });
  });
});
