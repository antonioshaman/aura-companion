/**
 * Tests for one AuraBench cell (Story D2). A scripted fake exec stands in for
 * git/bun/vitest; the agent is a stub. No LLM, no real processes.
 *
 * Validates:
 *   - naked variants scrub the Aura files and commit the scrub BEFORE the
 *     agent runs, so the scrub never shows up in the agent's diff; Aura
 *     variants keep the workspace untouched;
 *   - the diff is measured against the prepared commit with new files
 *     included (`add -A -N`), and a modified hidden test is flagged as
 *     tampered — then the hidden tests are restored from the merge commit
 *     BEFORE they run (the agent can never score by editing them);
 *   - success = completed ∧ hidden tests green ∧ no regressions; a regression
 *     is a file that was green on the pristine base and is red now; files
 *     without a baseline verdict are counted as unknown, never as regressions;
 *   - a usage limit yields NO record (the driver retries the cell);
 *   - timeout is a recorded failure; a failed checkout is a harness_error;
 *   - the cell is a SEALED checkout (fresh `git init` + depth-1 fetch of the
 *     base), never a `git worktree`: from a linked worktree Claude Code loads
 *     the main checkout's `.claude/skills` and `git log --all` exposes the
 *     merge commit. The merge commit is fetched only AFTER the agent ran;
 *   - the checkout is removed on every path;
 *   - FIX-D2-3: the record carries its checkout path and the harness-level
 *     confounds (appended after the agent's).
 */

import { describe, it, expect } from "vitest";
import type { AuraBenchTask } from "../task.js";
import { VARIANTS } from "./variants.js";
import { emptyMetrics } from "./agent-metrics.js";
import { baselineZones, computeBaseline, parseNumstat, relatedSources, removeCheckout, runCell, vitestFileVerdicts, type AgentRun, type AsyncExec, type CellDeps, type ExecResult } from "./run-cell.js";

const BASE = "b".repeat(40);
const MERGE = "m".repeat(40);
const WT = "/bench/wt/cell";
const task: AuraBenchTask = {
  golden_task_version: 1,
  id: "t1",
  title: "T",
  start_commit: BASE,
  prompt: "fix it",
  expected_files: ["web/server/x.ts"],
  expected_tests: ["web/server/x.test.ts"],
  failure_modes: [],
  rubric: [],
  aurabench: {
    pr: 1,
    merge_commit: MERGE,
    class: "bugfix",
    hidden_tests: ["web/server/x.test.ts"],
    validation: { base: "fail", merge: "pass", base_failure: "assertion", checked_at: "2026-09-28T00:00:00Z" },
  },
};

interface Script {
  addFails?: boolean;
  numstat?: string;
  hiddenPass?: boolean;
  related?: Record<string, "passed" | "failed">;
  agent?: AgentRun;
}

function harness(s: Script) {
  const calls: string[] = [];
  const reports = new Map<string, string>();
  const res = (r: Partial<ExecResult> = {}): ExecResult => ({ code: 0, output: "", timedOut: false, ...r });
  const exec: AsyncExec = async (cmd, args, { cwd }) => {
    const c = `${cmd} ${args.join(" ")}`;
    calls.push(`${cwd}$ ${c}`);
    if (cmd === "git" && args[0] === "fetch" && args.includes(BASE)) return res({ code: s.addFails ? 128 : 0, output: "fatal" });
    if (cmd === "git" && args[0] === "rev-parse") return res({ output: "p".repeat(40) + "\n" });
    if (cmd === "git" && args[0] === "diff" && args[1] === "--numstat") return res({ output: s.numstat ?? "" });
    if (cmd === "bunx" && args[1] === "run") {
      const out = args.find((a) => a.startsWith("--outputFile="))!.slice(13);
      const pass = s.hiddenPass ?? true;
      reports.set(out, JSON.stringify({ numPassedTests: pass ? 3 : 1, numFailedTests: pass ? 0 : 2 }));
      return res({ code: pass ? 0 : 1 });
    }
    if (cmd === "bunx" && args[1] === "related") {
      const out = args.find((a) => a.startsWith("--outputFile="))!.slice(13);
      const testResults = Object.entries(s.related ?? {}).map(([f, status]) => ({ name: `${WT}/web/${f}`, status }));
      reports.set(out, JSON.stringify({ testResults }));
      return res();
    }
    return res();
  };
  const agentCalls: string[] = [];
  const deps: CellDeps = {
    repo: "/repo",
    worktree: WT,
    artifactDir: "/bench/cells/t1/A-1",
    exec,
    runAgent: async (ctx) => {
      agentCalls.push(ctx.worktree);
      calls.push("AGENT");
      return s.agent ?? { kind: "done", status: "completed", metrics: { ...emptyMetrics(), turns: 3 }, isolation: { isolated: true }, confounds: [] };
    },
    baseline: async () => new Map([["server/y.test.ts", "pass"], ["server/z.test.ts", "fail"]]),
    reportFile: (n) => `/bench/cells/t1/A-1/${n}`,
    readText: (p) => reports.get(p) ?? null,
    now: () => new Date("2026-09-28T00:00:00Z"),
  };
  return { deps, calls, agentCalls };
}

// "AGENT" marks the stub agent call exactly ("AGENTS.md" appears in the scrub command).
const idx = (calls: string[], needle: string) =>
  calls.findIndex((c) => (needle === "AGENT" ? c === "AGENT" : c.includes(needle)));

describe("runCell", () => {
  it("naked: scrubs + commits before the agent, restores hidden tests before scoring", async () => {
    const { deps, calls } = harness({ numstat: "5\t1\tweb/server/x.ts\n2\t0\tweb/server/new.ts\n" });
    const out = await runCell(task, VARIANTS.A, 1, deps);
    expect(out.kind).toBe("record");
    if (out.kind !== "record") return;
    const r = out.record;
    expect(r).toMatchObject({ key: "t1|A|1", status: "completed", success: true, task_class: "bugfix" });
    expect(r.diff).toEqual({ files_touched: 2, loc_added: 7, loc_removed: 1, files: ["web/server/x.ts", "web/server/new.ts"] });
    expect(r.hidden).toEqual({ passed: true, tests_passed: 3, tests_failed: 0, tampered: [] });
    expect(r.metrics.turns).toBe(3);
    // Order: scrub → scrub commit → install → AGENT → diff → restore hidden → run hidden.
    const order = ["git rm -r", "aurabench: scrub", "bun install", "AGENT", "diff --numstat", `checkout ${MERGE} -- web/server/x.test.ts`, "vitest run"];
    const positions = order.map((n) => idx(calls, n));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    // The diff base is the prepared (post-scrub) commit, new files included.
    expect(idx(calls, "add -A -N")).toBeLessThan(idx(calls, "diff --numstat"));
    expect(calls.find((c) => c.includes("diff --numstat"))).toContain("p".repeat(40));
    expect(calls[calls.length - 1]).toContain(`rm -rf ${WT}`);
  });

  it("the agent works in a sealed checkout: no git worktree, merge commit fetched only after the agent", async () => {
    const { deps, calls } = harness({ numstat: "1\t0\tweb/server/x.ts\n" });
    await runCell(task, VARIANTS.A, 1, deps);
    // Leak channel from the pilot: a linked worktree points Claude Code at the main repo.
    expect(calls.some((c) => c.includes("git worktree"))).toBe(false);
    const order = [`rm -rf ${WT}`, `git init -q ${WT}`, `fetch -q --depth=1 --no-tags /repo ${BASE}`, "checkout -q --detach FETCH_HEAD", "AGENT"];
    const positions = order.map((n) => idx(calls, n));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    // The base fetch runs inside the new checkout, not in the source repo.
    expect(calls[idx(calls, `--depth=1 --no-tags /repo ${BASE}`)]).toMatch(new RegExp(`^${WT}\\$`));
    // The reference solution (merge commit) is never reachable while the agent works.
    const mergeFetch = idx(calls, `--depth=1 --no-tags /repo ${MERGE}`);
    expect(mergeFetch).toBeGreaterThan(idx(calls, "AGENT"));
    expect(mergeFetch).toBeLessThan(idx(calls, `checkout ${MERGE} --`));
  });

  it("aura variants leave the workspace unscrubbed", async () => {
    const { deps, calls } = harness({});
    await runCell(task, VARIANTS.C, 1, deps);
    expect(idx(calls, "git rm")).toBe(-1);
    expect(idx(calls, "aurabench: scrub")).toBe(-1);
  });

  it("flags a hidden test the agent edited — and still scores the restored original", async () => {
    const { deps } = harness({ numstat: "1\t1\tweb/server/x.test.ts\n", hiddenPass: false });
    const out = await runCell(task, VARIANTS.A, 2, deps);
    if (out.kind !== "record") throw new Error("expected record");
    expect(out.record.hidden).toMatchObject({ passed: false, tampered: ["web/server/x.test.ts"] });
    expect(out.record.success).toBe(false);
  });

  it("a test green on base and red now is a regression; no-baseline files are unknown", async () => {
    const { deps } = harness({
      numstat: "3\t0\tweb/server/x.ts\n",
      related: {
        "server/y.test.ts": "failed", // pass on base → regression
        "server/z.test.ts": "failed", // already failing on base → not a regression
        "server/new.test.ts": "failed", // no baseline verdict → unknown
        "server/x.test.ts": "passed", // hidden test — scored separately, skipped here
      },
    });
    const out = await runCell(task, VARIANTS.C, 1, deps);
    if (out.kind !== "record") throw new Error("expected record");
    expect(out.record.regressions).toEqual({ regressed: ["server/y.test.ts"], checked: 3, unknown: 1 });
    expect(out.record.hidden?.passed).toBe(true);
    expect(out.record.success).toBe(false);
  });

  it("a usage limit produces no record (the cell is retried later)", async () => {
    const { deps, calls } = harness({ agent: { kind: "limit", limit: { resetAt: null, message: "usage limit" } } });
    const out = await runCell(task, VARIANTS.A, 1, deps);
    expect(out.kind).toBe("limit");
    expect(idx(calls, "vitest")).toBe(-1);
    expect(calls[calls.length - 1]).toContain(`rm -rf ${WT}`);
  });

  it("a timeout is a recorded failure even if the hidden tests pass", async () => {
    const { deps } = harness({
      agent: { kind: "done", status: "timeout", metrics: emptyMetrics(), isolation: {}, confounds: ["c"] },
    });
    const out = await runCell(task, VARIANTS.B, 1, deps);
    if (out.kind !== "record") throw new Error("expected record");
    expect(out.record).toMatchObject({ status: "timeout", success: false, confounds: ["c"] });
    expect(out.record.hidden?.passed).toBe(true);
  });

  it("FIX-D2-3: the record names its checkout and carries the harness-level confounds after the agent's", async () => {
    // The per-cell checkout path is evidence that no two cells shared a
    // project directory; the unsandboxed-paths residue is stated, not hidden.
    const { deps } = harness({
      agent: { kind: "done", status: "completed", metrics: emptyMetrics(), isolation: { isolated: true }, confounds: ["agent-c"] },
    });
    const out = await runCell(task, VARIANTS.B, 1, { ...deps, confounds: ["harness-c"] });
    if (out.kind !== "record") throw new Error("expected record");
    expect(out.record.isolation).toEqual({ isolated: true, worktree: WT });
    expect(out.record.confounds).toEqual(["agent-c", "harness-c"]);
  });

  it("a failed checkout is a harness_error and the agent never runs", async () => {
    const { deps, agentCalls } = harness({ addFails: true });
    const out = await runCell(task, VARIANTS.A, 1, deps);
    if (out.kind !== "record") throw new Error("expected record");
    expect(out.record.status).toBe("harness_error");
    expect(agentCalls).toEqual([]);
  });
});

describe("helpers", () => {
  it("removeCheckout refuses relative or near-root paths (it runs rm -rf)", async () => {
    const calls: string[] = [];
    const exec: AsyncExec = async (cmd, args) => {
      calls.push(`${cmd} ${args.join(" ")}`);
      return { code: 0, output: "", timedOut: false };
    };
    for (const bad of ["", "wt/cell", "/", "/home", "/home/"]) {
      expect((await removeCheckout(exec, "/repo", bad)).code).not.toBe(0);
    }
    expect(calls).toEqual([]);
    expect((await removeCheckout(exec, "/repo", "/bench/wt/cell")).code).toBe(0);
    expect(calls).toEqual(["rm -rf /bench/wt/cell"]);
  });

  it("parseNumstat counts binary files as touched with 0 LOC", () => {
    expect(parseNumstat("-\t-\timg.png\n4\t2\ta.ts\n")).toEqual({ files_touched: 2, loc_added: 4, loc_removed: 2, files: ["img.png", "a.ts"] });
  });
  it("relatedSources keeps web TS sources, drops hidden tests and non-web files", () => {
    expect(relatedSources(["web/server/a.ts", "web/src/B.tsx", "web/server/x.test.ts", "docs/a.md", "web/package.json"], ["web/server/x.test.ts"])).toEqual([
      "server/a.ts",
      "src/B.tsx",
    ]);
  });
  it("vitestFileVerdicts makes paths web-relative", () => {
    const v = vitestFileVerdicts({ testResults: [{ name: "/wt/web/server/a.test.ts", status: "passed" }, { name: "/wt/web/src/b.test.tsx", status: "failed" }] }, "/wt/web");
    expect([...v]).toEqual([["server/a.test.ts", "pass"], ["src/b.test.tsx", "fail"]]);
  });
  it("baselineZones = top-level web dirs of the hidden tests", () => {
    expect(baselineZones({ ...task, aurabench: { ...task.aurabench, hidden_tests: ["web/server/a.test.ts", "web/src/b.test.tsx", "web/server/c.test.ts"] } })).toEqual(["server", "src"]);
  });

  it("computeBaseline runs the zones on the pristine base and refuses an empty report", async () => {
    const calls: string[] = [];
    const exec: AsyncExec = async (cmd, args) => {
      calls.push(`${cmd} ${args.join(" ")}`);
      return { code: 0, output: "", timedOut: false };
    };
    const reports: Record<string, string> = {
      "/b/baseline.json": JSON.stringify({ testResults: [{ name: "/wt/b/web/server/y.test.ts", status: "passed" }] }),
    };
    const got = await computeBaseline(task, { repo: "/repo", exec, readText: (p) => reports[p] ?? null, reportFile: (n) => `/b/${n}`, worktree: "/wt/b" });
    expect([...got]).toEqual([["server/y.test.ts", "pass"]]);
    expect(calls.some((c) => c === `git fetch -q --depth=1 --no-tags /repo ${BASE}`)).toBe(true);
    // Hidden tests are NOT restored for the baseline — it is what the agent starts from.
    expect(calls.some((c) => c.includes(`checkout ${MERGE}`))).toBe(false);
    expect(calls[calls.length - 1]).toBe("rm -rf /wt/b");
    await expect(
      computeBaseline(task, { repo: "/repo", exec, readText: () => null, reportFile: (n) => `/b/${n}`, worktree: "/wt/b" }),
    ).rejects.toThrow(/no test verdicts/);
  });
});
