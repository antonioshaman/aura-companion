/**
 * Tests for the AuraBench candidate miner. What matters:
 *   - every PR ends up either a candidate or an exclusion WITH a reason
 *     (Story D1: "a task whose PR has no before/after-distinguishing tests is
 *     excluded with a reason");
 *   - hidden tests = added/modified web test files only (deleted ones can't
 *     run, non-web ones aren't in the vitest tree);
 *   - the class heuristic is deterministic and lands in the D1 vocabulary.
 * Git is injected as a fake `changedFiles`, so these are hermetic.
 */

import { describe, it, expect } from "vitest";
import { classifyPr, commitType, minePrs, MAX_SOURCE_FILES, type ChangedFile, type MergedPr } from "./mine.js";

const pr = (number: number, title: string, oid: string | null = `sha${number}`): MergedPr => ({
  number,
  title,
  body: "",
  mergeCommit: oid ? { oid } : null,
});

describe("commitType", () => {
  it("parses conventional-commit types with scope and bang", () => {
    expect(commitType("fix(server): x")).toBe("fix");
    expect(commitType("feat!: x")).toBe("feat");
    expect(commitType("Create README")).toBeNull();
  });
});

describe("classifyPr", () => {
  it("maps conventional types to D1 classes", () => {
    expect(classifyPr("fix(server): guard new URL", ["web/server/a.ts"])).toBe("bugfix");
    expect(classifyPr("feat(server): add endpoint", ["web/server/a.ts"])).toBe("feature");
    expect(classifyPr("refactor(chat): tidy bubble", ["web/src/a.tsx"])).toBe("refactor");
  });

  it("feature confined to web/src is ui; a fix confined to web/src stays bugfix", () => {
    expect(classifyPr("feat(ui): context meter", ["web/src/components/M.tsx"])).toBe("ui");
    expect(classifyPr("fix(ui): meter drops after compaction", ["web/src/components/M.tsx"])).toBe("bugfix");
  });

  it("architecture for extract/decouple titles or refactors spanning >= 5 files", () => {
    expect(classifyPr("refactor(chat): extract AssistantAvatar", ["web/src/a.tsx"])).toBe("architecture");
    const five = ["a", "b", "c", "d", "e"].map((x) => `web/server/${x}.ts`);
    expect(classifyPr("chore: sever self-update", five)).toBe("architecture");
  });

  it("security and debug intent win over the type, including in the scope", () => {
    expect(classifyPr("feat(security): Origin allowlist on WS upgrade", ["web/server/a.ts"])).toBe("security");
    expect(classifyPr("feat(recorder): redact secrets at write", ["web/server/a.ts"])).toBe("security");
    expect(classifyPr("feat(server): init-frame health canary", ["web/server/a.ts"])).toBe("debug");
    // "auth" alone is NOT security — provider-credential plumbing is a feature.
    expect(classifyPr("fix(codex): re-seed stale auth.json copies", ["web/server/a.ts"])).toBe("bugfix");
  });
});

describe("minePrs", () => {
  const files: Record<string, ChangedFile[]> = {
    sha1: [
      { status: "M", path: "web/server/a.ts" },
      { status: "A", path: "web/server/a.test.ts" },
      { status: "D", path: "web/server/old.test.ts" },
      { status: "M", path: "landing/x.test.ts" },
      { status: "M", path: "docs/notes.md" },
    ],
    sha2: [{ status: "M", path: "web/server/a.ts" }],
    sha3: [{ status: "M", path: "web/server/a.test.ts" }],
    sha5: [
      { status: "A", path: "web/server/big.test.ts" },
      ...Array.from({ length: MAX_SOURCE_FILES + 1 }, (_, i) => ({ status: "M", path: `web/server/f${i}.ts` })),
    ],
  };
  const changed = (oid: string) => files[oid] ?? [];

  it("keeps added/modified web tests as hidden tests and non-test code as source", () => {
    const { candidates } = minePrs([pr(1, "fix(server): a")], changed);
    expect(candidates).toEqual([
      {
        pr: 1,
        title: "fix(server): a",
        body: "",
        merge_commit: "sha1",
        class: "bugfix",
        hidden_tests: ["web/server/a.test.ts"],
        source_files: ["web/server/a.ts"],
      },
    ]);
  });

  it("excludes every non-candidate with a reason, and accounts for all PRs", () => {
    const prs = [
      pr(2, "fix: no tests"),
      pr(3, "fix: tests only"),
      pr(4, "docs: readme"),
      pr(5, "feat: huge"),
      pr(6, "fix: orphan", null),
      pr(1, "fix(server): a"),
    ];
    const { candidates, excluded } = minePrs(prs, changed);
    expect(candidates.map((c) => c.pr)).toEqual([1]);
    expect(excluded.map((e) => [e.pr, e.reason])).toEqual([
      [2, expect.stringMatching(/no web\/ test files/)],
      [3, expect.stringMatching(/only tests/)],
      [4, 'non-task PR type "docs"'],
      [5, expect.stringMatching(/too large/)],
      [6, "no merge commit"],
    ]);
    expect(candidates.length + excluded.length).toBe(prs.length);
  });
});
