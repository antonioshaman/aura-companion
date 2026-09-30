/**
 * One AuraBench cell, end to end (P6/D2):
 *
 *   1. fresh sealed checkout of the task's base commit ({@link sealedCheckout};
 *      a stale one from an interrupted run is removed first);
 *   2. naked variants: delete the Aura files ({@link NAKED_SCRUB_PATHS});
 *      commit the prepared tree locally so the agent's diff is measured
 *      against it (the scrub never counts as the agent's change);
 *   3. `bun install --frozen-lockfile` in `web/` (the agent must be able to
 *      run tests);
 *   4. run the agent (injected — naked CLI or Companion session) under the
 *      60-min wall clock;
 *   5. measure the diff (`git add -A -N` first so new files count; the base is
 *      the prepared commit, so agent-made commits count too) and note any
 *      hidden test file the agent modified;
 *   6. fetch the merge commit (only now — the agent never had it), restore
 *      the hidden tests from it and run them;
 *   7. regression check: `vitest related` of the agent-changed sources, minus
 *      the hidden tests, compared with the task's pristine-base baseline;
 *   8. remove the checkout.
 *
 * A usage limit is reported as `{ kind: "limit" }` and NO record is produced —
 * the runner sleeps and retries the same cell. Everything that spawns goes
 * through injected deps; unit-tested with scripted fakes. Firewall-clean.
 */

import type { AuraBenchTask } from "../task.js";
import { toWebRelative } from "../validate.js";
import type { AgentMetrics, CellRecord, CellStatus, DiffStats, HiddenTestOutcome, RegressionOutcome } from "./cells.js";
import { CELL_RECORD_VERSION, cellKey } from "./cells.js";
import { emptyMetrics, type LimitHit } from "./agent-metrics.js";
import { applyDietOverlay, DIET_BEFORE_HOOK_CONFOUND, DIET_SOURCE_LATER_CONFOUND, type DietOverlaySpec } from "./diet-overlay.js";
import { NAKED_SCRUB_PATHS } from "./isolation.js";
import type { Variant } from "./variants.js";

export interface ExecResult {
  code: number;
  output: string;
  timedOut: boolean;
}

export type AsyncExec = (
  cmd: string,
  args: string[],
  opts: { cwd: string; timeoutMs: number; env?: Record<string, string> },
) => Promise<ExecResult>;

export interface AgentContext {
  task: AuraBenchTask;
  variant: Variant;
  /** Worktree root (repo root at the base commit). */
  worktree: string;
  timeoutMs: number;
  /** Per-cell directory outside the worktree for raw transcripts. */
  artifactDir: string;
}

export type AgentRun =
  | {
      kind: "done";
      status: Extract<CellStatus, "completed" | "timeout" | "agent_error">;
      metrics: AgentMetrics;
      isolation: Record<string, unknown>;
      confounds: string[];
      error?: string;
    }
  | { kind: "limit"; limit: LimitHit };

export type AgentRunner = (ctx: AgentContext) => Promise<AgentRun>;

/** Per-file verdicts of the pristine base (test file path relative to `web/`). */
export type Baseline = ReadonlyMap<string, "pass" | "fail">;

export interface CellDeps {
  /** Repo whose object store holds the task commits. */
  repo: string;
  /** Fresh per cell, outside the bench root and the repo (see `cell-paths.ts`). */
  worktree: string;
  artifactDir: string;
  /** Harness-level confounds recorded on every cell (e.g. unsandboxed paths). */
  confounds?: readonly string[];
  /** DIET-AB: overlay this control-file version before the agent runs
   *  (Aura variants only — a naked cell has no control files to swap). */
  dietOverlay?: DietOverlaySpec;
  exec: AsyncExec;
  runAgent: AgentRunner;
  baseline: (task: AuraBenchTask) => Promise<Baseline>;
  /** Where vitest writes its JSON report (outside the worktree). */
  reportFile: (name: string) => string;
  readText: (path: string) => string | null;
  now?: () => Date;
  cellTimeoutMs?: number;
  testTimeoutMs?: number;
  installTimeoutMs?: number;
}

/**
 * A standalone repo holding ONLY `sha` (depth 1, no remote, no other refs) —
 * deliberately NOT a `git worktree`. From a linked worktree Claude Code
 * resolves the project to the MAIN checkout: it loaded the main repo's
 * `.claude/skills` into a "naked" cell and keyed auto-memory on it (pilot
 * finding), and `git log --all` there would expose the merge commit, i.e. the
 * reference solution. `dir` must be absolute and is wiped first.
 */
export async function sealedCheckout(exec: AsyncExec, repo: string, dir: string, sha: string): Promise<ExecResult> {
  const steps: [string, string[], string][] = [
    ["git", ["init", "-q", dir], repo],
    ["git", ["fetch", "-q", "--depth=1", "--no-tags", repo, sha], dir],
    ["git", ["checkout", "-q", "--detach", "FETCH_HEAD"], dir],
  ];
  const wiped = await removeCheckout(exec, repo, dir);
  if (wiped.code !== 0) return wiped;
  for (const [cmd, args, cwd] of steps) {
    const r = await exec(cmd, args, { cwd, timeoutMs: 120_000 });
    if (r.code !== 0) return r;
  }
  return { code: 0, output: "", timedOut: false };
}

export async function removeCheckout(exec: AsyncExec, repo: string, dir: string): Promise<ExecResult> {
  if (!dir.startsWith("/") || dir.replace(/\/+$/, "").split("/").length < 3) {
    return { code: 2, output: `refusing to remove suspicious checkout path: ${dir}`, timedOut: false };
  }
  return exec("rm", ["-rf", dir], { cwd: repo, timeoutMs: 120_000 });
}

export type CellOutcome = { kind: "record"; record: CellRecord } | { kind: "limit"; limit: LimitHit };

export const CELL_TIMEOUT_MS = 60 * 60_000;
const GIT_ID = ["-c", "user.name=aurabench", "-c", "user.email=aurabench@localhost", "-c", "commit.gpgsign=false"];

interface VitestJson {
  numPassedTests?: number;
  numFailedTests?: number;
  testResults?: { name?: string; status?: string }[];
}

/** Per-file verdicts from a vitest `--reporter=json` report; paths made
 *  relative to `webDir`. */
export function vitestFileVerdicts(report: VitestJson | null, webDir: string): Map<string, "pass" | "fail"> {
  const out = new Map<string, "pass" | "fail">();
  const prefix = webDir.replace(/\/+$/, "") + "/";
  for (const r of report?.testResults ?? []) {
    if (typeof r.name !== "string") continue;
    const rel = r.name.startsWith(prefix) ? r.name.slice(prefix.length) : r.name;
    out.set(rel, r.status === "passed" ? "pass" : "fail");
  }
  return out;
}

/** `git diff --numstat` → stats. Binary files (`-\t-`) count as touched, 0 LOC. */
export function parseNumstat(out: string): DiffStats {
  const files: string[] = [];
  let added = 0;
  let removed = 0;
  for (const line of out.split("\n")) {
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    files.push(parts.slice(2).join("\t"));
    if (parts[0] !== "-") added += Number(parts[0]) || 0;
    if (parts[1] !== "-") removed += Number(parts[1]) || 0;
  }
  return { files_touched: files.length, loc_added: added, loc_removed: removed, files };
}

/** Agent-changed files that `vitest related` should start from: TS/TSX under
 *  `web/`, excluding the hidden tests (they are scored separately). */
export function relatedSources(diffFiles: readonly string[], hiddenTests: readonly string[]): string[] {
  const hidden = new Set(hiddenTests);
  return diffFiles.filter((f) => f.startsWith("web/") && /\.(ts|tsx)$/.test(f) && !hidden.has(f)).map(toWebRelative);
}

function parseReport(text: string | null): VitestJson | null {
  if (!text) return null;
  try {
    return JSON.parse(text) as VitestJson;
  } catch {
    return null;
  }
}

export async function runCell(task: AuraBenchTask, variant: Variant, rep: number, d: CellDeps): Promise<CellOutcome> {
  const now = d.now ?? (() => new Date());
  const started = now();
  const web = `${d.worktree}/web`;
  const git = (args: string[], cwd = d.repo) => d.exec("git", args, { cwd, timeoutMs: 120_000 });
  const testTimeoutMs = d.testTimeoutMs ?? 15 * 60_000;
  const base: Omit<CellRecord, "status" | "success" | "finished_at" | "wall_clock_ms"> = {
    v: CELL_RECORD_VERSION,
    key: cellKey(task.id, variant.id, rep),
    task_id: task.id,
    task_class: task.aurabench.class,
    variant: variant.id,
    rep,
    hidden: null,
    regressions: null,
    diff: null,
    metrics: emptyMetrics(),
    started_at: started.toISOString(),
    isolation: {},
    confounds: [],
  };
  const finish = (status: CellStatus, extra: Partial<CellRecord>): CellOutcome => {
    const rec: CellRecord = {
      ...base,
      ...extra,
      status,
      success: false,
      finished_at: now().toISOString(),
      wall_clock_ms: 0,
    };
    rec.wall_clock_ms = Date.parse(rec.finished_at) - started.getTime();
    rec.success = status === "completed" && !!rec.hidden?.passed && (rec.regressions?.regressed.length ?? 0) === 0;
    return { kind: "record", record: rec };
  };

  const added = await sealedCheckout(d.exec, d.repo, d.worktree, task.start_commit);
  if (added.code !== 0) return finish("harness_error", { error: `sealed checkout failed: ${added.output.slice(-300)}` });
  try {
    if (variant.mode === "naked") {
      const rm = await git(["rm", "-r", "-q", "--ignore-unmatch", "--", ...NAKED_SCRUB_PATHS], d.worktree);
      if (rm.code !== 0) return finish("harness_error", { error: `scrub failed: ${rm.output.slice(-300)}` });
      const ci = await git([...GIT_ID, "commit", "-q", "--no-verify", "--allow-empty", "-m", "aurabench: scrub"], d.worktree);
      if (ci.code !== 0) return finish("harness_error", { error: `scrub commit failed: ${ci.output.slice(-300)}` });
    }
    if (d.dietOverlay) {
      if (variant.mode === "naked") return finish("harness_error", { error: "diet overlay on a naked variant" });
      const o = await applyDietOverlay(d.exec, d.repo, d.worktree, d.artifactDir, d.dietOverlay, GIT_ID);
      if (!o.ok) return finish("harness_error", { error: o.error });
      base.diet_overlay = o.evidence;
    }
    const prepared = (await git(["rev-parse", "HEAD"], d.worktree)).output.trim();
    const inst = await d.exec("bun", ["install", "--frozen-lockfile"], {
      cwd: web,
      timeoutMs: d.installTimeoutMs ?? 10 * 60_000,
    });
    if (inst.code !== 0) return finish("harness_error", { error: `bun install failed: ${inst.output.slice(-300)}` });

    const agent = await d.runAgent({
      task,
      variant,
      worktree: d.worktree,
      timeoutMs: d.cellTimeoutMs ?? CELL_TIMEOUT_MS,
      artifactDir: d.artifactDir,
    });
    if (agent.kind === "limit") return { kind: "limit", limit: agent.limit };
    base.metrics = agent.metrics;
    base.isolation = { ...agent.isolation, worktree: d.worktree };
    base.confounds = [
      ...agent.confounds,
      ...(d.confounds ?? []),
      ...(d.dietOverlay ? [DIET_SOURCE_LATER_CONFOUND, ...(d.dietOverlay.version === "before" ? [DIET_BEFORE_HOOK_CONFOUND] : [])] : []),
    ];

    // Diff against the prepared commit, new files included.
    await git(["add", "-A", "-N"], d.worktree);
    const numstat = await git(["diff", "--numstat", prepared, "--", ".", ":(exclude)web/node_modules"], d.worktree);
    const diff = parseNumstat(numstat.output);
    const tampered: string[] = [];
    for (const f of task.aurabench.hidden_tests) {
      if (diff.files.includes(f)) tampered.push(f);
    }

    // Hidden tests come back exactly as merged, whatever the agent did to them.
    // The merge commit enters the checkout only now, after the agent is done.
    const fetched = await git(["fetch", "-q", "--depth=1", "--no-tags", d.repo, task.aurabench.merge_commit], d.worktree);
    const restore =
      fetched.code !== 0
        ? fetched
        : await git(["checkout", task.aurabench.merge_commit, "--", ...task.aurabench.hidden_tests], d.worktree);
    if (restore.code !== 0) {
      return finish("harness_error", { diff, error: `restoring hidden tests failed: ${restore.output.slice(-300)}` });
    }
    const hiddenReport = d.reportFile("hidden.json");
    const hiddenRun = await d.exec(
      "bunx",
      ["vitest", "run", "--maxWorkers=2", "--reporter=json", `--outputFile=${hiddenReport}`, ...task.aurabench.hidden_tests.map(toWebRelative)],
      { cwd: web, timeoutMs: testTimeoutMs },
    );
    const hr = parseReport(d.readText(hiddenReport));
    const hidden: HiddenTestOutcome = {
      passed:
        hiddenRun.code === 0 && !hiddenRun.timedOut && (hr?.numFailedTests ?? 1) === 0 && (hr?.numPassedTests ?? 0) > 0,
      tests_passed: hr?.numPassedTests ?? 0,
      tests_failed: hr?.numFailedTests ?? 0,
      tampered,
    };

    const sources = relatedSources(diff.files, task.aurabench.hidden_tests);
    let regressions: RegressionOutcome = { regressed: [], checked: 0, unknown: 0 };
    if (sources.length) {
      const relReport = d.reportFile("related.json");
      await d.exec(
        "bunx",
        ["vitest", "related", "--run", "--passWithNoTests", "--maxWorkers=2", "--reporter=json", `--outputFile=${relReport}`, ...sources],
        { cwd: web, timeoutMs: testTimeoutMs },
      );
      const baseline = await d.baseline(task);
      const hiddenRel = new Set(task.aurabench.hidden_tests.map(toWebRelative));
      const verdicts = vitestFileVerdicts(parseReport(d.readText(relReport)), web);
      for (const [file, verdict] of verdicts) {
        if (hiddenRel.has(file)) continue;
        regressions.checked++;
        const was = baseline.get(file);
        if (was === undefined) regressions.unknown++;
        else if (was === "pass" && verdict === "fail") regressions.regressed.push(file);
      }
      regressions = { ...regressions, regressed: regressions.regressed.sort() };
    }
    return finish(agent.status, { diff, hidden, regressions, ...(agent.error ? { error: agent.error } : {}) });
  } finally {
    await removeCheckout(d.exec, d.repo, d.worktree);
  }
}

/** Test-file zones of a task's baseline: the top-level `web/` directories that
 *  hold its hidden tests (e.g. `server`, `src`). */
export function baselineZones(task: AuraBenchTask): string[] {
  return [...new Set(task.aurabench.hidden_tests.map((f) => toWebRelative(f).split("/")[0]!))].sort();
}

/**
 * Pristine-base verdicts for the task's zones — computed once per task (the
 * runner caches them on disk). Hidden tests are NOT restored here: the
 * baseline is what the agent started from.
 */
export async function computeBaseline(
  task: AuraBenchTask,
  d: Pick<CellDeps, "repo" | "exec" | "readText" | "reportFile" | "testTimeoutMs" | "installTimeoutMs"> & { worktree: string },
): Promise<Map<string, "pass" | "fail">> {
  const web = `${d.worktree}/web`;
  const added = await sealedCheckout(d.exec, d.repo, d.worktree, task.start_commit);
  if (added.code !== 0) throw new Error(`baseline sealed checkout failed: ${added.output.slice(-300)}`);
  try {
    const inst = await d.exec("bun", ["install", "--frozen-lockfile"], { cwd: web, timeoutMs: d.installTimeoutMs ?? 10 * 60_000 });
    if (inst.code !== 0) throw new Error(`baseline bun install failed: ${inst.output.slice(-300)}`);
    const report = d.reportFile("baseline.json");
    await d.exec("bunx", ["vitest", "run", "--maxWorkers=2", "--reporter=json", `--outputFile=${report}`, ...baselineZones(task)], {
      cwd: web,
      timeoutMs: d.testTimeoutMs ?? 30 * 60_000,
    });
    const verdicts = vitestFileVerdicts(parseReport(d.readText(report)), web);
    if (verdicts.size === 0) throw new Error("baseline produced no test verdicts");
    return verdicts;
  } finally {
    await removeCheckout(d.exec, d.repo, d.worktree);
  }
}
