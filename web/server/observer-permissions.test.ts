import { describe, expect, it } from "vitest";
import {
  OBSERVER_ALLOWED_TOOLS,
  OBSERVER_DISALLOWED_TOOLS,
  OBSERVER_PERMISSION_MODE,
  assertObserverToolPolicyConsistent,
  getObserverSpawnOverrides,
} from "./observer-permissions.js";

describe("OBSERVER_ALLOWED_TOOLS", () => {
  // Hunt P5: the observer's allow-list must contain ONLY the read +
  // bounded-write tools it needs. Pinning the exact list as a literal
  // assertion catches accidental widening (e.g. someone copy-pastes
  // an orchestrator allow-list).
  it("contains exactly the curated read + bounded-write tools", () => {
    expect([...OBSERVER_ALLOWED_TOOLS]).toEqual(["Read", "Grep", "Glob", "Write", "Edit", "TodoWrite"]);
  });

  it("is frozen — runtime mutation is rejected", () => {
    expect(Object.isFrozen(OBSERVER_ALLOWED_TOOLS)).toBe(true);
  });

  // Hunt P5 explicit denials — these are the load-bearing rejections.
  // A literal assertion makes the boundary visible to future readers
  // and to grep.
  it("does NOT contain Bash, network tools, or unscoped MCP", () => {
    for (const tool of ["Bash", "BashOutput", "KillShell", "WebFetch", "WebSearch"]) {
      expect(OBSERVER_ALLOWED_TOOLS).not.toContain(tool);
    }
  });
});

describe("OBSERVER_DISALLOWED_TOOLS", () => {
  // Pin the deny list verbatim so a regression that drops "Bash" from
  // the explicit denial fails red rather than slipping through.
  it("contains the canonical deny set verbatim", () => {
    expect([...OBSERVER_DISALLOWED_TOOLS]).toEqual([
      "Bash",
      "BashOutput",
      "KillShell",
      "WebFetch",
      "WebSearch",
      "NotebookEdit",
    ]);
  });

  it("is frozen — runtime mutation is rejected", () => {
    expect(Object.isFrozen(OBSERVER_DISALLOWED_TOOLS)).toBe(true);
  });
});

describe("getObserverSpawnOverrides", () => {
  // Caller-side mutation of returned arrays must not affect the frozen
  // source lists. Tests by mutating the return value and re-asserting
  // the canonical shape on a fresh call.
  it("returns fresh array copies on each call", () => {
    const a = getObserverSpawnOverrides();
    a.allowedTools.push("Bash"); // would be catastrophic if it stuck
    const b = getObserverSpawnOverrides();
    expect(b.allowedTools).not.toContain("Bash");
  });

  it("returns the canonical permission mode", () => {
    expect(getObserverSpawnOverrides().permissionMode).toBe(OBSERVER_PERMISSION_MODE);
  });
});

describe("assertObserverToolPolicyConsistent", () => {
  // The boot canary: allow and deny lists must be disjoint. With the
  // canonical lists this is a no-op; the test exists so that a later
  // edit that breaks the invariant surfaces immediately at startup
  // rather than silently widening the observer's surface.
  it("does not throw with the canonical lists", () => {
    expect(() => assertObserverToolPolicyConsistent()).not.toThrow();
  });
});
