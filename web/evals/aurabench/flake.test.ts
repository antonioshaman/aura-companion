/**
 * Tests for the AuraBench hidden-test stability check (P6/FIX-D2-5: "hidden
 * tests run 3× on the merge commit; flaky → excluded"). A scripted fake
 * {@link Exec} stands in for git/bun/vitest, so each branch is deterministic:
 *   - 3/3 passes → stable; any failed or timed-out run → unstable, with the
 *     failing run's output kept (and passing runs' output dropped);
 *   - a setup failure (worktree/install) is `setup_ok: false` — unproven, not
 *     "flaky" — so the runner retries it instead of trusting it;
 *   - the worktree is always removed;
 *   - the results JSONL is keyed by task id + merge commit, torn lines ignored.
 */

import { describe, it, expect } from "vitest";
import { checkMergeStability, readStabilityVerdicts, stabilityKey } from "./flake.js";
import type { Exec, ExecResult } from "./validate.js";

const MERGE = "m".repeat(40);
const target = { id: "t1", merge_commit: MERGE, hidden_tests: ["web/server/x.test.ts"] };
const now = () => new Date("2026-09-28T12:00:00Z");

function fakeExec(testRuns: Partial<ExecResult>[], opts: { installFails?: boolean; addFails?: boolean } = {}) {
  const calls: string[] = [];
  let i = 0;
  const res = (r: Partial<ExecResult> = {}): ExecResult => ({ code: 0, output: "", timedOut: false, ...r });
  const exec: Exec = (cmd, args) => {
    calls.push(`${cmd} ${args.join(" ")}`);
    if (cmd === "git" && args[1] === "add") return res({ code: opts.addFails ? 128 : 0, output: "fatal: x" });
    if (cmd === "bun") return res({ code: opts.installFails ? 1 : 0, output: "lockfile mismatch" });
    if (cmd === "bunx") return res(testRuns[i++] ?? {});
    return res();
  };
  return { exec, calls };
}

describe("checkMergeStability", () => {
  it("is stable when every run passes, and runs vitest from web/ with web-relative paths", () => {
    const { exec, calls } = fakeExec([{}, {}, {}]);
    const v = checkMergeStability(target, { repo: "/r", worktree: "/wt/t1", exec, now });
    expect(v).toMatchObject({ id: "t1", setup_ok: true, passed: 3, stable: true });
    expect(v.reason).toBeUndefined();
    // Passing runs keep no output (the JSONL would otherwise balloon).
    expect(v.runs.every((r) => r.output_tail === undefined)).toBe(true);
    expect(calls.filter((c) => c.startsWith("bunx"))).toEqual(Array(3).fill("bunx vitest run --maxWorkers=2 server/x.test.ts"));
  });

  it("is unstable when one run of three fails, keeping that run's output", () => {
    // The flake case the check exists for: pass, FAIL, pass.
    const { exec } = fakeExec([{}, { code: 1, output: "× flaky assertion" }, {}]);
    const v = checkMergeStability(target, { repo: "/r", worktree: "/wt/t1", exec, now });
    expect(v).toMatchObject({ setup_ok: true, passed: 2, stable: false });
    expect(v.reason).toBe("hidden tests passed 2/3 runs on the merge commit");
    expect(v.runs[1]!.output_tail).toContain("flaky assertion");
  });

  it("counts a timed-out run as a failure even if its exit code is 0", () => {
    const { exec } = fakeExec([{}, {}, { code: 0, timedOut: true }]);
    const v = checkMergeStability(target, { repo: "/r", worktree: "/wt/t1", exec, now });
    expect(v).toMatchObject({ passed: 2, stable: false });
  });

  it("honours a custom run count", () => {
    const { exec, calls } = fakeExec([{}, {}, {}, {}, {}]);
    const v = checkMergeStability(target, { repo: "/r", worktree: "/wt/t1", exec, now, runs: 5 });
    expect(v).toMatchObject({ passed: 5, stable: true });
    expect(calls.filter((c) => c.startsWith("bunx"))).toHaveLength(5);
  });

  it("reports an install failure as setup_ok=false (unproven), runs no tests, removes the worktree", () => {
    const { exec, calls } = fakeExec([], { installFails: true });
    const v = checkMergeStability(target, { repo: "/r", worktree: "/wt/t1", exec, now });
    expect(v).toMatchObject({ setup_ok: false, stable: false, runs: [] });
    expect(v.reason).toMatch(/bun install failed/);
    expect(calls.some((c) => c.startsWith("bunx"))).toBe(false);
    expect(calls.at(-1)).toBe("git worktree remove --force /wt/t1");
  });

  it("reports a worktree add failure as setup_ok=false", () => {
    const { exec } = fakeExec([], { addFails: true });
    const v = checkMergeStability(target, { repo: "/r", worktree: "/wt/t1", exec, now });
    expect(v).toMatchObject({ setup_ok: false, stable: false });
    expect(v.reason).toMatch(/git worktree add failed/);
  });
});

describe("readStabilityVerdicts", () => {
  it("keys by id + merge commit, keeps the latest line, ignores torn lines", () => {
    const a1 = { id: "a", merge_commit: MERGE, setup_ok: false, runs: [], passed: 0, stable: false, checked_at: "x" };
    const a2 = { ...a1, setup_ok: true, passed: 3, stable: true };
    const b = { ...a2, id: "b", merge_commit: "n".repeat(40) };
    const map = readStabilityVerdicts([JSON.stringify(a1), JSON.stringify(a2), "{torn", JSON.stringify(b), ""].join("\n"));
    expect(map.size).toBe(2);
    expect(map.get(stabilityKey(a1))!.stable).toBe(true);
    // A different merge commit for the same id is a different key (re-mined task → re-check).
    expect(map.has(`b@${MERGE}`)).toBe(false);
  });
});
