import { describe, expect, it } from "vitest";
import {
  OBSERVER_ALLOWED_TOOLS,
  OBSERVER_DISALLOWED_TOOLS,
  OBSERVER_PERMISSION_MODE,
  assertObserverToolPolicyConsistent,
  findObserverToolPolicyIntersection,
  getObserverSpawnOverrides,
} from "./observer-permissions.js";

describe("OBSERVER_ALLOWED_TOOLS", () => {
  // Willison P2.4: Edit and TodoWrite dropped — observer writes a single
  // fresh review file per checkpoint, never amends; no agentic plan needed.
  it("contains exactly the curated read + bounded-write tools", () => {
    expect([...OBSERVER_ALLOWED_TOOLS]).toEqual(["Read", "Grep", "Glob", "Write"]);
  });

  it("is frozen — runtime mutation is rejected", () => {
    expect(Object.isFrozen(OBSERVER_ALLOWED_TOOLS)).toBe(true);
  });

  it("does NOT contain Edit, MultiEdit, TodoWrite, Bash, or network tools", () => {
    for (const tool of ["Edit", "MultiEdit", "TodoWrite", "Bash", "BashOutput", "KillShell", "WebFetch", "WebSearch"]) {
      expect(OBSERVER_ALLOWED_TOOLS).not.toContain(tool);
    }
  });
});

describe("OBSERVER_DISALLOWED_TOOLS", () => {
  // The static-grep canary list. Pinned verbatim so a future regression
  // that drops "Bash" or "Edit" from explicit denial fails red.
  it("contains the canonical deny set verbatim", () => {
    expect([...OBSERVER_DISALLOWED_TOOLS]).toEqual([
      "Bash",
      "BashOutput",
      "KillShell",
      "WebFetch",
      "WebSearch",
      "NotebookEdit",
      "Edit",
      "MultiEdit",
      "TodoWrite",
    ]);
  });

  it("is frozen", () => {
    expect(Object.isFrozen(OBSERVER_DISALLOWED_TOOLS)).toBe(true);
  });
});

describe("getObserverSpawnOverrides", () => {
  it("returns fresh array copies on each call", () => {
    const a = getObserverSpawnOverrides();
    a.allowedTools.push("Bash");
    const b = getObserverSpawnOverrides();
    expect(b.allowedTools).not.toContain("Bash");
  });

  it("returns the canonical permission mode", () => {
    expect(getObserverSpawnOverrides().permissionMode).toBe(OBSERVER_PERMISSION_MODE);
  });
});

describe("findObserverToolPolicyIntersection", () => {
  // Beck F4: the previously-untested error branch — extracted into a pure
  // helper so both clean and conflicting inputs can be asserted directly.
  it("returns an empty array when allow and deny are disjoint", () => {
    expect(findObserverToolPolicyIntersection(["Read", "Grep"], ["Bash", "Edit"])).toEqual([]);
  });

  it("returns the intersecting tools when allow and deny overlap", () => {
    expect(findObserverToolPolicyIntersection(["Read", "Bash"], ["Bash", "Edit"])).toEqual(["Bash"]);
  });

  it("returns multiple intersecting tools in deny-list order", () => {
    expect(findObserverToolPolicyIntersection(["Read", "Bash", "Edit"], ["Bash", "Edit", "WebFetch"])).toEqual([
      "Bash",
      "Edit",
    ]);
  });
});

describe("assertObserverToolPolicyConsistent", () => {
  // Canonical no-op path — proves the module's own constants are clean.
  it("does not throw with the canonical lists (current module state)", () => {
    expect(() => assertObserverToolPolicyConsistent()).not.toThrow();
  });

  // Beck F4: the assertion's reason for existing — the throw branch — is
  // now testable directly via the parameterised override.
  it("throws when allow and deny lists intersect", () => {
    expect(() =>
      assertObserverToolPolicyConsistent(["Read", "Bash"], ["Bash", "WebFetch"]),
    ).toThrow(/appear in both/);
  });

  it("error message names every offending tool", () => {
    let thrown: Error | undefined;
    try {
      assertObserverToolPolicyConsistent(["Read", "Bash", "Edit"], ["Bash", "Edit"]);
    } catch (err) {
      thrown = err as Error;
    }
    expect(thrown?.message).toMatch(/Bash/);
    expect(thrown?.message).toMatch(/Edit/);
  });
});
