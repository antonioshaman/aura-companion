/**
 * Tests for the AuraBench candidate validator (Story D1: "hidden tests fail on
 * the base commit and pass on the merged commit, otherwise the task is
 * excluded"). A scripted fake {@link Exec} stands in for git/bun/vitest and
 * tracks which commit the worktree is on, so each verdict branch is driven
 * deterministically:
 *   - pass-on-merge + fail-on-base → VALID, with the failure kind classified;
 *   - fail on merge, pass on base, timeouts, install failures → excluded;
 *   - hidden tests are restored from merge onto base (they are the whole
 *     point), deps are reinstalled only when package.json/lockfile differ;
 *   - the worktree is always removed, even on an early exclusion.
 */

import { describe, it, expect } from "vitest";
import type { Candidate } from "./mine.js";
import { classifyBaseFailure, completedPrs, toWebRelative, validateCandidate, type Exec, type ExecResult } from "./validate.js";

const MERGE = "m".repeat(40);
const BASE = "b".repeat(40);
const cand: Candidate = {
  pr: 42,
  title: "fix: x",
  body: "",
  merge_commit: MERGE,
  class: "bugfix",
  hidden_tests: ["web/server/x.test.ts"],
  source_files: ["web/server/x.ts"],
};

interface Script {
  onMerge?: Partial<ExecResult>;
  onBase?: Partial<ExecResult>;
  installFails?: boolean;
  depsChanged?: boolean;
}

function fakeExec(s: Script): { exec: Exec; calls: string[] } {
  const calls: string[] = [];
  let at: "none" | "merge" | "base" = "none";
  const res = (r: Partial<ExecResult> = {}): ExecResult => ({ code: 0, output: "", timedOut: false, ...r });
  const exec: Exec = (cmd, args) => {
    const line = `${cmd} ${args.join(" ")}`;
    calls.push(line);
    if (cmd === "git" && args[0] === "rev-parse") return res({ output: `${BASE}\n` });
    if (cmd === "git" && args[0] === "worktree" && args[1] === "add") {
      at = "merge";
      return res();
    }
    if (cmd === "git" && args[0] === "checkout" && args.includes("--detach")) {
      at = "base";
      return res();
    }
    if (cmd === "git" && args[0] === "diff") return res({ code: s.depsChanged ? 1 : 0 });
    if (cmd === "bun") return res({ code: s.installFails ? 1 : 0 });
    if (cmd === "bunx") return res(at === "merge" ? s.onMerge : s.onBase);
    return res();
  };
  return { exec, calls };
}

const opts = (exec: Exec) => ({
  repo: "/repo",
  worktree: "/wt/pr-42",
  exec,
  now: () => new Date("2026-09-28T10:00:00Z"),
});

describe("validateCandidate", () => {
  it("VALID when hidden tests pass on merge and fail on base; tests restored onto base", () => {
    const { exec, calls } = fakeExec({ onBase: { code: 1, output: "AssertionError: expected 1 to be 2" } });
    const v = validateCandidate(cand, opts(exec));
    expect(v).toMatchObject({ ok: true, pr: 42, base_commit: BASE, merge_commit: MERGE, base_failure: "assertion" });
    // The hidden tests must be checked out from MERGE while the tree is on BASE.
    const detach = calls.findIndex((c) => c.startsWith("git checkout --force --detach"));
    const restore = calls.findIndex((c) => c === `git checkout ${MERGE} -- web/server/x.test.ts`);
    expect(detach).toBeGreaterThan(-1);
    expect(restore).toBeGreaterThan(detach);
    // vitest runs from web/, so paths are web-relative.
    expect(calls.filter((c) => c.startsWith("bunx vitest run"))).toEqual([
      "bunx vitest run --maxWorkers=2 server/x.test.ts",
      "bunx vitest run --maxWorkers=2 server/x.test.ts",
    ]);
    // Deps unchanged → a single install; worktree cleaned up last.
    expect(calls.filter((c) => c.startsWith("bun install"))).toHaveLength(1);
    expect(calls.at(-1)).toBe("git worktree remove --force /wt/pr-42");
  });

  it("classifies a base failure caused by a missing module/export as missing-interface", () => {
    const { exec } = fakeExec({
      onBase: { code: 1, output: "\x1b[31mTypeError\x1b[39m: __vi_import_4__.resumeTranscriptExists is not a function" },
    });
    expect(validateCandidate(cand, opts(exec))).toMatchObject({ ok: true, base_failure: "missing-interface" });
  });

  it("reinstalls deps on base only when package.json/lockfile changed", () => {
    const { exec, calls } = fakeExec({ depsChanged: true, onBase: { code: 1 } });
    validateCandidate(cand, opts(exec));
    expect(calls.filter((c) => c.startsWith("bun install"))).toHaveLength(2);
  });

  it.each([
    ["hidden tests already pass on base commit", { onBase: { code: 0 } }],
    ["hidden tests fail on merge commit", { onMerge: { code: 1 } }],
    ["hidden tests timed out on merge commit", { onMerge: { code: 1, timedOut: true } }],
    ["hidden tests time out on base commit", { onBase: { code: 1, timedOut: true } }],
    ["bun install failed on merge commit", { installFails: true }],
  ] as Array<[string, Script]>)("excluded: %s — and the worktree is still removed", (reason, script) => {
    const { exec, calls } = fakeExec(script);
    const v = validateCandidate(cand, opts(exec));
    expect(v).toMatchObject({ ok: false, pr: 42, reason, checked_at: "2026-09-28T10:00:00.000Z" });
    expect(calls.at(-1)).toBe("git worktree remove --force /wt/pr-42");
  });
});

describe("helpers", () => {
  it("classifyBaseFailure distinguishes interface gaps from assertions", () => {
    expect(classifyBaseFailure("Error: Failed to load url ./new-module.js")).toBe("missing-interface");
    expect(classifyBaseFailure("SyntaxError: does not provide an export named 'x'")).toBe("missing-interface");
    expect(classifyBaseFailure("AssertionError: expected true to be false")).toBe("assertion");
  });

  it("toWebRelative strips the web/ prefix only", () => {
    expect(toWebRelative("web/src/a.test.tsx")).toBe("src/a.test.tsx");
    expect(toWebRelative("server/a.test.ts")).toBe("server/a.test.ts");
  });

  it("completedPrs resumes from a results log and ignores a torn last line", () => {
    // Idempotency: a restart must skip PRs that already have a verdict.
    const log = '{"pr":1,"ok":true}\n{"pr":2,"ok":false,"reason":"x"}\n{"pr":3,"ok":tr';
    expect([...completedPrs(log)].sort()).toEqual([1, 2]);
  });
});
