// @vitest-environment node
import { describe, it, expect } from "vitest";
import {
  SYNTHETIC_FRAME_TOOL_DENYLIST,
  denialMessageForSynthetic,
  isToolUseDeniedForSynthetic,
} from "./auto-proceed-permissions.js";

// PLAN Task 11.5 — denylist module unit tests.
//
// The gate consumer (claude-adapter can_use_tool handler — Task 11.8)
// reads `idleTimerManager.isSyntheticTurnInFlight(sid)` FIRST, then
// calls `isToolUseDeniedForSynthetic` only if that's true. These tests
// pin the predicate behavior in isolation; integration tests for the
// in-flight × deny composition land in claude-adapter when the gate is
// wired.

describe("SYNTHETIC_FRAME_TOOL_DENYLIST (PLAN Task 11.5)", () => {
  it("contains exactly the four documented entries", () => {
    // Pin the contents so a future drift (entry added/removed) gets a
    // failing test instead of silent behavior change. Each entry's
    // inclusion was a deliberate decision per the module docstring.
    expect(SYNTHETIC_FRAME_TOOL_DENYLIST.size).toBe(4);
    expect(SYNTHETIC_FRAME_TOOL_DENYLIST.has("Bash:git push")).toBe(true);
    expect(SYNTHETIC_FRAME_TOOL_DENYLIST.has("Bash:git commit")).toBe(true);
    expect(SYNTHETIC_FRAME_TOOL_DENYLIST.has("Bash:gh pr create")).toBe(true);
    expect(SYNTHETIC_FRAME_TOOL_DENYLIST.has("Bash:gh pr merge")).toBe(true);
  });
});

describe("isToolUseDeniedForSynthetic — Bash denylist matches", () => {
  it("denies plain `git push`", () => {
    expect(isToolUseDeniedForSynthetic("Bash", { command: "git push" })).toBe(true);
  });

  it("denies `git push origin main` (denied prefix + suffix args)", () => {
    expect(isToolUseDeniedForSynthetic("Bash", { command: "git push origin main" })).toBe(true);
  });

  it("denies `git commit -m 'msg'`", () => {
    expect(isToolUseDeniedForSynthetic("Bash", { command: "git commit -m 'msg'" })).toBe(true);
  });

  it("denies `gh pr create --base main`", () => {
    expect(isToolUseDeniedForSynthetic("Bash", { command: "gh pr create --base main" })).toBe(true);
  });

  it("denies `gh pr merge 50 --squash`", () => {
    expect(isToolUseDeniedForSynthetic("Bash", { command: "gh pr merge 50 --squash" })).toBe(true);
  });

  it("denies even when leading ASCII whitespace is present", () => {
    expect(isToolUseDeniedForSynthetic("Bash", { command: "  git push" })).toBe(true);
    expect(isToolUseDeniedForSynthetic("Bash", { command: "\tgit push" })).toBe(true);
  });
});

describe("isToolUseDeniedForSynthetic — Bash allow path", () => {
  it("allows ALL Read/Edit/etc. by tool-name (denylist is Bash-only)", () => {
    expect(isToolUseDeniedForSynthetic("Read", { file_path: "/tmp/x" })).toBe(false);
    expect(isToolUseDeniedForSynthetic("Edit", { file_path: "/tmp/x", old_string: "a", new_string: "b" })).toBe(false);
    expect(isToolUseDeniedForSynthetic("Glob", { pattern: "**/*.ts" })).toBe(false);
    expect(isToolUseDeniedForSynthetic("Grep", { pattern: "foo" })).toBe(false);
    expect(isToolUseDeniedForSynthetic("Write", { file_path: "/tmp/x", content: "hi" })).toBe(false);
  });

  it("allows `git status`, `git log`, `git diff` (read-only Git ops)", () => {
    expect(isToolUseDeniedForSynthetic("Bash", { command: "git status" })).toBe(false);
    expect(isToolUseDeniedForSynthetic("Bash", { command: "git log -3 --oneline" })).toBe(false);
    expect(isToolUseDeniedForSynthetic("Bash", { command: "git diff --stat" })).toBe(false);
  });

  it("allows `gh pr view`, `gh pr list`, `gh pr checkout` (read-only PR ops)", () => {
    expect(isToolUseDeniedForSynthetic("Bash", { command: "gh pr view 50" })).toBe(false);
    expect(isToolUseDeniedForSynthetic("Bash", { command: "gh pr list" })).toBe(false);
    expect(isToolUseDeniedForSynthetic("Bash", { command: "gh pr checkout 50" })).toBe(false);
  });

  it("allows unrelated commands `ls`, `bun run test`, etc.", () => {
    expect(isToolUseDeniedForSynthetic("Bash", { command: "ls" })).toBe(false);
    expect(isToolUseDeniedForSynthetic("Bash", { command: "bun run test" })).toBe(false);
    expect(isToolUseDeniedForSynthetic("Bash", { command: "echo hi" })).toBe(false);
  });
});

// Council Review #11 — fail-CLOSED on non-string toolName. Wire boundary
// (NDJSON from CLI) carries `unknown`; type-narrowing failure must deny,
// not allow. Pin behaviour.
describe("isToolUseDeniedForSynthetic — fail-CLOSED on non-string toolName (#11)", () => {
  it("denies when toolName is a number", () => {
    expect(isToolUseDeniedForSynthetic(42 as unknown as string, { command: "ls" })).toBe(true);
  });
  it("denies when toolName is null", () => {
    expect(isToolUseDeniedForSynthetic(null as unknown as string, { command: "ls" })).toBe(true);
  });
  it("denies when toolName is undefined", () => {
    expect(isToolUseDeniedForSynthetic(undefined as unknown as string, { command: "ls" })).toBe(true);
  });
  it("denies when toolName is an object", () => {
    expect(isToolUseDeniedForSynthetic({} as unknown as string, { command: "ls" })).toBe(true);
  });
});

// Council Review #15 — ZW-class characters embedded in the command must
// not bypass the literal prefix-match. The 5 chars stripped pre-match
// are: U+200B ZWSP, U+200C ZWNJ, U+200D ZWJ, U+FEFF ZWNBSP/BOM, U+2060 WJ.
describe("isToolUseDeniedForSynthetic — ZW-class bypass defence (#15)", () => {
  it("denies `g<ZWSP>it push` (ZWSP between g and it)", () => {
    expect(isToolUseDeniedForSynthetic("Bash", { command: "g​it push" })).toBe(true);
  });
  it("denies `<ZWSP>git push` (leading ZWSP)", () => {
    expect(isToolUseDeniedForSynthetic("Bash", { command: "​git push" })).toBe(true);
  });
  it("denies `git<ZWJ> push` (ZWJ before space)", () => {
    expect(isToolUseDeniedForSynthetic("Bash", { command: "git‍ push" })).toBe(true);
  });
  it("denies command with BOM prefix", () => {
    expect(isToolUseDeniedForSynthetic("Bash", { command: "﻿git commit -m x" })).toBe(true);
  });
  it("denies command interspersed with all 5 ZW chars", () => {
    expect(isToolUseDeniedForSynthetic("Bash", {
      command: "​‌‍git﻿ push⁠ origin",
    })).toBe(true);
  });
  it("ZW chars in middle that would NOT form a denied prefix after strip stay allowed", () => {
    // `gitpush` (no space) after stripping ZW between git and push is NOT
    // a denied prefix. Bash wouldn't execute it anyway; we only catch the
    // shapes that COULD execute as a denied command.
    expect(isToolUseDeniedForSynthetic("Bash", { command: "git​push" })).toBe(false);
  });
});

describe("isToolUseDeniedForSynthetic — malformed / edge-case inputs", () => {
  it("returns false for null toolInput", () => {
    expect(isToolUseDeniedForSynthetic("Bash", null)).toBe(false);
  });

  it("returns false for non-object toolInput", () => {
    expect(isToolUseDeniedForSynthetic("Bash", "git push")).toBe(false);
    expect(isToolUseDeniedForSynthetic("Bash", 42)).toBe(false);
    expect(isToolUseDeniedForSynthetic("Bash", undefined)).toBe(false);
  });

  it("returns false when command field is missing", () => {
    expect(isToolUseDeniedForSynthetic("Bash", {})).toBe(false);
    expect(isToolUseDeniedForSynthetic("Bash", { not_command: "git push" })).toBe(false);
  });

  it("returns false when command is non-string", () => {
    expect(isToolUseDeniedForSynthetic("Bash", { command: 42 })).toBe(false);
    expect(isToolUseDeniedForSynthetic("Bash", { command: null })).toBe(false);
    expect(isToolUseDeniedForSynthetic("Bash", { command: ["git", "push"] })).toBe(false);
  });

  it("returns false for empty command", () => {
    expect(isToolUseDeniedForSynthetic("Bash", { command: "" })).toBe(false);
    expect(isToolUseDeniedForSynthetic("Bash", { command: "   " })).toBe(false);
  });
});

describe("isToolUseDeniedForSynthetic — documented limitations (NOT bugs)", () => {
  // These cases ARE in fact not caught — verified to pin the behavior so
  // a future change that DOES start catching them is announced explicitly
  // (the doc claim and the test would update together).

  it("does NOT catch shell chaining (`; git push`)", () => {
    expect(isToolUseDeniedForSynthetic("Bash", { command: "ls ; git push" })).toBe(false);
    expect(isToolUseDeniedForSynthetic("Bash", { command: "true && git push" })).toBe(false);
  });

  it("does NOT catch command substitution (`$(git push)`)", () => {
    expect(isToolUseDeniedForSynthetic("Bash", { command: "echo $(git push)" })).toBe(false);
  });

  it("does NOT catch `bash -c \"git push\"` indirection", () => {
    expect(isToolUseDeniedForSynthetic("Bash", { command: "bash -c \"git push\"" })).toBe(false);
  });
});

describe("denialMessageForSynthetic", () => {
  it("includes the denied Bash command head (truncated to 80 chars)", () => {
    const msg = denialMessageForSynthetic("Bash", { command: "git push origin main" });
    expect(msg).toContain("git push origin main");
    expect(msg).toContain("Engage manually");
  });

  it("truncates very long commands to 80 chars + only shows the first line", () => {
    const long = "git push origin " + "a".repeat(200);
    const msg = denialMessageForSynthetic("Bash", { command: long });
    // Head extraction: first line, sliced to 80 chars. Verify boundary.
    const head = long.split("\n", 1)[0]?.slice(0, 80) ?? "";
    expect(msg).toContain(head);
    expect(msg.length).toBeLessThan(long.length); // truncation visible
  });

  it("handles multi-line bash commands by showing only the first line", () => {
    const msg = denialMessageForSynthetic("Bash", { command: "git push origin main\nsecret_line" });
    expect(msg).toContain("git push origin main");
    expect(msg).not.toContain("secret_line");
  });

  it("falls back to a generic message for non-Bash / missing command", () => {
    expect(denialMessageForSynthetic("Read", {})).toContain("may not invoke");
    expect(denialMessageForSynthetic("Bash", null as unknown as object)).toContain("may not invoke");
    expect(denialMessageForSynthetic("Bash", {})).toContain("may not invoke");
  });

  // Council Review #14 — strip backticks from the embedded command head.
  // The message uses a markdown code-span wrapper; an embedded backtick
  // would terminate the span early and let the rest render as raw markdown
  // (potentially as bold/emphasis/link injection on a chat surface that
  // does post-message rendering).
  it("strips embedded backticks from the command head (#14)", () => {
    const msg = denialMessageForSynthetic("Bash", { command: "git push `evil` origin" });
    expect(msg).not.toContain("`evil`"); // raw backtick gone
    expect(msg).toContain("‘evil‘"); // replaced with safe look-alike
    expect(msg).toContain("Engage manually");
  });
  it("strips multiple backticks", () => {
    const msg = denialMessageForSynthetic("Bash", { command: "git push `a` `b` `c`" });
    // count backticks in message (excluding the wrapper pair around `head`)
    const backtickCount = (msg.match(/`/g) || []).length;
    expect(backtickCount).toBe(2); // exactly the wrapping pair from the message template
  });
});
