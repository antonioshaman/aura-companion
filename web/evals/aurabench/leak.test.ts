/**
 * Tests for the AuraBench prompt-leak check (Story D1: "a second pass checks
 * the prompt for leakage — names of new symbols/files from the diff → rewrite").
 * The contract pinned here:
 *   - only code-shaped tokens count as identifiers (plain prose never flags);
 *   - identifiers that already exist on base are neither required nor forbidden;
 *   - new identifiers the hidden tests use are REQUIRED (the prompt must name
 *     them, or the task is unpassable); all other new ones are FORBIDDEN;
 *   - a new file is required iff a hidden test imports it;
 *   - prompt matching is whole-token (`fooBar` does not match `fooBarBaz`).
 */

import { describe, it, expect } from "vitest";
import { checkPrompt, codeIdentifiers, computeSurface, fileStem, stripComments } from "./leak.js";

describe("codeIdentifiers", () => {
  it("extracts camelCase, PascalCase, snake_case and UPPER_SNAKE but not plain words", () => {
    const ids = codeIdentifiers("const trimArchived = new WsBridge(); MAX_RETRIES half_respawned session Archive x_");
    expect([...ids].sort()).toEqual(["MAX_RETRIES", "WsBridge", "half_respawned", "trimArchived"]);
  });
});

describe("stripComments", () => {
  it("drops comment lines and trailing // comments but keeps URLs", () => {
    // Names that only appear in comments (e.g. a fixture bot name cited in a
    // doc comment) must not become "required interface".
    const src = ["/** see fixture_bot */", " * other_note", "// line_comment", "const keepMe = 1; // trailing_note", 'const u = "http://x";'].join("\n");
    expect(stripComments(src)).toBe(["const keepMe = 1; ", 'const u = "http://x";'].join("\n"));
  });

  it("does not let comment-only names into the surface", () => {
    const s = computeSurface({
      addedSourceText: "// mirrors fixture_bot\nexport const realName = 1;",
      newSourceFiles: [],
      hiddenTestText: "fixture_bot realName",
      existsOnBase: () => false,
    });
    expect(s.required).toEqual(["realName"]);
  });

  it("does not require a name the hidden tests only mention in a comment", () => {
    // A private field cited in a test's doc comment is not something the test
    // exercises — naming it in the prompt would be a solution hint, not contract.
    const s = computeSurface({
      addedSourceText: "private lastPending: string | null = null;",
      newSourceFiles: [],
      hiddenTestText: "// replays via lastPending\nexpect(sent).toHaveLength(1);",
      existsOnBase: () => false,
    });
    expect(s.required).toEqual([]);
    expect(s.forbidden).toEqual(["lastPending"]);
  });
});

describe("fileStem", () => {
  it("strips directories, .test and the TS/JS extension", () => {
    expect(fileStem("web/server/idle-timer.ts")).toBe("idle-timer");
    expect(fileStem("web/src/components/Foo.test.tsx")).toBe("Foo");
  });
});

describe("computeSurface", () => {
  const onBase = new Set(["existingHelper", "WsBridge"]);
  const surface = computeSurface({
    addedSourceText: "export function trimState() { return existingHelper(internalCounter); }\nWsBridge.x",
    newSourceFiles: ["web/server/new-module.ts", "web/server/private-util.ts"],
    hiddenTestText: 'import { trimState } from "./new-module.js";\nexpect(trimState()).toBe(1);',
    existsOnBase: (id) => onBase.has(id),
  });

  it("marks new identifiers and files the tests reference as required", () => {
    // trimState is imported by the test; new-module is the file it imports from.
    expect(surface.required).toEqual(["new-module", "trimState"]);
  });

  it("marks new identifiers and files the tests do not reference as forbidden", () => {
    // internalCounter is an implementation detail; private-util is an unimported new file.
    expect(surface.forbidden).toEqual(["internalCounter", "private-util"]);
  });

  it("ignores identifiers that already exist on base", () => {
    expect(surface.required).not.toContain("existingHelper");
    expect(surface.forbidden).not.toContain("WsBridge");
  });
});

describe("checkPrompt", () => {
  const surface = { required: ["trimState"], forbidden: ["internalCounter", "private-util"] };

  it("reports forbidden names the prompt leaks and required names it omits", () => {
    const r = checkPrompt("Use internalCounter in private-util.ts to fix it.", surface);
    expect(r.leaks).toEqual(["internalCounter", "private-util"]);
    expect(r.unnamed).toEqual(["trimState"]);
  });

  it("is clean when the prompt names exactly the required interface", () => {
    expect(checkPrompt("Export `trimState()` so archived sessions shrink.", surface)).toEqual({ leaks: [], unnamed: [] });
  });

  it("matches whole tokens only", () => {
    // `trimStateAll` is not `trimState`; `internalCounters` is not `internalCounter`.
    const r = checkPrompt("trimStateAll and internalCounters", surface);
    expect(r.leaks).toEqual([]);
    expect(r.unnamed).toEqual(["trimState"]);
  });
});
