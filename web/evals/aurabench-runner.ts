/**
 * AuraBench corpus builder (P5/D1).
 *
 *   bun run eval:aurabench mine --prs <prs.json> --out <candidates.jsonl>
 *   bun run eval:aurabench validate --candidates <candidates.jsonl> \
 *     --results <results.jsonl> --wt-root <dir> [--limit N] [--pr N]
 *   bun run eval:aurabench leak --tasks <dir> [--id <task-id>]
 *   bun run eval:aurabench judge --tasks <dir> --results <f> [--model opus] [--id <task-id>]
 *   bun run eval:aurabench stability --tasks <dir> --results <f> --wt-root <dir> [--runs 3]
 *   bun run eval:aurabench bench --bench-root <dir> [--variants A,B,…] [--reps 5]
 *     [--task-ids a,b] [--max-cells N] [--state <STATE.json>] [--timeout-min 60]
 *     [--claude-model claude-opus-5-5] [--codex-model gpt-5.5]
 *
 * `prs.json` is `gh pr list --state merged --base main --limit 300
 *   --json number,title,body,mergeCommit`. `mine` writes one candidate per
 * line plus `<out>.excluded.jsonl` (every rejected PR with its reason).
 * `validate` runs each candidate's hidden tests on base and merge in a
 * throwaway worktree under `--wt-root` and APPENDS one verdict per PR to
 * `--results`; PRs already present are skipped, so it resumes after a restart.
 *
 * `leak` loads a task corpus and, per task, derives the PR's new surface from
 * git (base→merge diff of `expected_files`, hidden tests at merge) and checks
 * the prompt: every new name the hidden tests use must be named, no other new
 * name may be. Exits 1 on any leak or unnamed interface.
 *
 * `judge` asks an LLM (`claude -p`, no tools, no user/project settings, cwd
 * outside the repo) whether each prompt gives away the cause or the fix,
 * comparing it with the PR diff and hidden tests (`prompt-judge.ts`). One
 * record per task × prompt hash × rubric version is appended to `--results`;
 * already-judged prompts are skipped. Exits 1 unless every task is "clean".
 *
 * `stability` runs every task's hidden tests `--runs` times (default 3) on its
 * merge commit in a throwaway worktree and appends one verdict per task to
 * `--results` (resumable; exits 1 if any task is unstable) — see `flake.ts`.
 *
 * `bench` is the D2 ablation (see `aurabench/harness/`): every task × variant
 * × rep cell in a fresh worktree under `<bench-root>/wt`, results appended to
 * `<bench-root>/results/cells.jsonl` (idempotent — finished cells are
 * skipped), raw transcripts in `<bench-root>/cells/`. Aura variants start the
 * isolated Companion instance on :3499 on demand. `--state` mirrors progress
 * into `STATE.bench.cells_done/cells_total`.
 *
 * Child processes run under `nice -n 10` with every `AURA_*` variable unset and
 * a bounded Node heap; before each candidate it waits while MemAvailable is
 * under 1.5 GB (this box also runs production).
 *
 * Reads real repos/processes; not in the vitest glob. The mining, validation
 * and resume logic are unit-tested in `aurabench/*.test.ts`.
 */

import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { minePrs, type Candidate, type ChangedFile, type MergedPr } from "./aurabench/mine.js";
import { completedPrs, validateCandidate, type Exec } from "./aurabench/validate.js";
import { checkPrompt, computeSurface } from "./aurabench/leak.js";
import {
  JUDGE_JSON_SCHEMA,
  JUDGE_RUBRIC_VERSION,
  JUDGE_SYSTEM_PROMPT,
  buildJudgeRequest,
  judgeKey,
  parseJudgeReply,
  promptSha256,
  readJudgeRecords,
  type JudgeRecord,
} from "./aurabench/prompt-judge.js";
import { checkMergeStability, readStabilityVerdicts, stabilityKey } from "./aurabench/flake.js";
import { loadAuraBenchTasks } from "./aurabench/loader.js";
import type { AuraBenchTask } from "./aurabench/task.js";
import { runAblation } from "./aurabench/harness/driver.js";
import { runCell, computeBaseline, type AgentRunner, type Baseline } from "./aurabench/harness/run-cell.js";
import { VARIANTS, parseVariantList } from "./aurabench/harness/variants.js";
import { nakedClaudeRunner, nakedCodexRunner, type NakedDeps } from "./aurabench/harness/naked-agents.js";
import { auraRunner, type BenchSocket } from "./aurabench/harness/aura-agent.js";
import { benchInstancePaths, startBenchInstance, type RunningInstance } from "./aurabench/harness/bench-instance.js";
import {
  CODEX_AUTH_FILE,
  CodexAuthKeeper,
  authSafeSignalHandler,
  guardRealCodexHome,
  realAuthSha,
  withCodexAuthWatch,
} from "./aurabench/harness/codex-home.js";
import { benchChildEnv, niceExec, spawnNice } from "./aurabench/harness/proc.js";
import type { CellRecord } from "./aurabench/harness/cells.js";
import {
  CELL_PATH_CONFOUND,
  checkWorktreeRoot,
  newCellWorktree,
  sweepStaleCellWorktrees,
  withCleanClaudeProject,
} from "./aurabench/harness/cell-paths.js";
import { chmodSync, copyFileSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";

const MIN_AVAILABLE_KB = 1.5 * 1024 * 1024;

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  return eq?.slice(name.length + 3);
}

function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("AURA_")) env[k] = v;
  env.NODE_OPTIONS = "--max-old-space-size=2560";
  env.CI = "1";
  return env;
}

const exec: Exec = (cmd, args, { cwd, timeoutMs }) => {
  const r = spawnSync("nice", ["-n", "10", cmd, ...args], {
    cwd,
    env: childEnv(),
    encoding: "utf8",
    timeout: timeoutMs,
    killSignal: "SIGKILL",
    maxBuffer: 64 * 1024 * 1024,
  });
  const timedOut = (r.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
  return { code: r.status ?? 1, output: `${r.stdout ?? ""}${r.stderr ?? ""}`, timedOut };
};

function memAvailableKb(): number {
  const m = /MemAvailable:\s+(\d+)/.exec(readFileSync("/proc/meminfo", "utf8"));
  return m ? Number(m[1]) : Number.POSITIVE_INFINITY;
}

async function waitForMemory(): Promise<void> {
  while (memAvailableKb() < MIN_AVAILABLE_KB) {
    console.log(`[aurabench] MemAvailable < 1.5 GB — waiting 30s`);
    await new Promise((r) => setTimeout(r, 30_000));
  }
}

function gitChangedFiles(repo: string): (oid: string) => ChangedFile[] {
  return (oid) => {
    const r = spawnSync("git", ["diff", "--name-status", "-M", `${oid}^1`, oid], { cwd: repo, encoding: "utf8" });
    if (r.status !== 0) return [];
    return r.stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const parts = line.split("\t");
        return { status: parts[0]!, path: parts[parts.length - 1]! };
      });
  };
}

function git(repo: string, args: string[]): { ok: boolean; out: string } {
  const r = spawnSync("git", args, { cwd: repo, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, out: r.stdout ?? "" };
}

function taskSurface(repo: string, t: AuraBenchTask) {
  const base = t.start_commit;
  const merge = t.aurabench.merge_commit;
  const diff = git(repo, ["diff", "--no-color", "-U0", base, merge, "--", ...t.expected_files]).out;
  const addedSourceText = diff
    .split("\n")
    .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
    .map((l) => l.slice(1))
    .join("\n");
  const newSourceFiles = git(repo, ["diff", "--name-only", "--diff-filter=A", base, merge, "--", ...t.expected_files])
    .out.split("\n")
    .filter(Boolean);
  const hiddenTestText = t.aurabench.hidden_tests.map((f) => git(repo, ["show", `${merge}:${f}`]).out).join("\n");
  // `git grep` exits 0 on a match, 1 on none — anything present in the base tree is not new surface.
  const existsOnBase = (id: string) => git(repo, ["grep", "-qwF", id, base, "--", "web"]).ok;
  return computeSurface({ addedSourceText, newSourceFiles, hiddenTestText, existsOnBase });
}

function readJsonl<T>(file: string): T[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as T);
}

function readTextOrNull(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function presentNonEmpty(path: string): boolean {
  try {
    const st = statSync(path);
    return st.isDirectory() ? readdirSync(path).length > 0 : st.size > 0;
  } catch {
    return false;
  }
}

/** Mirror progress into STATE.bench (only those two fields + updated_at), atomically. */
function writeBenchProgress(stateFile: string, done: number, total: number): void {
  const text = readTextOrNull(stateFile);
  if (!text) return;
  const state = JSON.parse(text) as { bench?: Record<string, unknown>; updated_at?: string };
  state.bench = { ...(state.bench ?? {}), cells_done: done, cells_total: total };
  state.updated_at = new Date().toISOString();
  const tmp = `${stateFile}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n");
  renameSync(tmp, stateFile);
}

async function http(baseUrl: string, method: "GET" | "POST" | "DELETE", path: string, body?: unknown) {
  const r = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  const text = await r.text();
  let json: unknown = text;
  try {
    json = JSON.parse(text);
  } catch {
    // non-JSON body — keep the text
  }
  return { status: r.status, json };
}

function openSocket(url: string, onMessage: (d: string) => void, onClose: () => void): Promise<BenchSocket> {
  return new Promise((resolveSock, reject) => {
    const ws = new WebSocket(url);
    ws.onmessage = (e) => onMessage(typeof e.data === "string" ? e.data : String(e.data));
    ws.onclose = () => onClose();
    ws.onerror = () => reject(new Error(`websocket error: ${url}`));
    ws.onopen = () => resolveSock({ send: (d) => ws.send(d), close: () => ws.close() });
  });
}

async function bench(argv: string[], repo: string): Promise<number> {
  const benchRootArg = arg(argv, "bench-root");
  if (!benchRootArg) {
    console.error("usage: bench --bench-root <dir> [--variants A,B,…] [--reps 5] [--task-ids a,b] [--max-cells N] [--state <STATE.json>] [--timeout-min 60] [--tasks <dir>] [--wt-root <dir outside bench-root and repo>]");
    return 2;
  }
  const benchRoot = resolve(benchRootArg);
  const variants = parseVariantList(arg(argv, "variants"));
  if (!variants.ok) {
    console.error(`[aurabench] ${variants.reason}`);
    return 2;
  }
  const reps = Number(arg(argv, "reps") ?? 5);
  const maxCellsArg = arg(argv, "max-cells");
  const timeoutMs = Number(arg(argv, "timeout-min") ?? 60) * 60_000;
  const stateFile = arg(argv, "state");
  // Every variant of a provider runs the SAME pinned model: Companion's own
  // default (claude-sonnet-4-6) differs from the CLI's, and `codex exec
  // --ignore-user-config` drops the user's configured model. gpt-5.4 is no
  // longer accepted for ChatGPT-account Codex auth (pilot: HTTP 400), and the
  // account's models cache lists gpt-5.5.
  const models = { claude: arg(argv, "claude-model") ?? "claude-opus-5-5", codex: arg(argv, "codex-model") ?? "gpt-5.5" };
  console.log(`[aurabench] pinned models: ${JSON.stringify(models)}`);
  // One absolute binary per provider for ALL variants (see AuraDeps.binaries).
  const binaries = { claude: Bun.which("claude") ?? undefined, codex: Bun.which("codex") ?? undefined };
  if (!binaries.claude || !binaries.codex) {
    console.error(`[aurabench] claude/codex not on PATH: ${JSON.stringify(binaries)}`);
    return 2;
  }
  const versionOf = (bin: string) => spawnSync(bin, ["--version"], { encoding: "utf8" }).stdout.trim();
  console.log(`[aurabench] binaries: claude=${binaries.claude} (${versionOf(binaries.claude)}), codex=${binaries.codex} (${versionOf(binaries.codex)})`);
  const tasksDir = resolve(arg(argv, "tasks") ?? join(import.meta.dir, "aurabench", "tasks"));
  const { tasks, excluded } = loadAuraBenchTasks(tasksDir, (sha) => git(repo, ["cat-file", "-e", `${sha}^{commit}`]).ok);
  for (const e of excluded) console.log(`[aurabench] EXCLUDED ${e.file}: ${e.reason}`);
  const onlyIds = arg(argv, "task-ids")?.split(",").filter(Boolean);
  const selected = onlyIds ? tasks.filter((t) => onlyIds.includes(t.id)) : tasks;
  if (onlyIds && selected.length !== onlyIds.length) {
    console.error(`[aurabench] unknown task id(s): ${onlyIds.filter((id) => !tasks.some((t) => t.id === id)).join(", ")}`);
    return 2;
  }
  const byId = new Map(selected.map((t) => [t.id, t]));
  const resultsFile = join(benchRoot, "results", "cells.jsonl");
  for (const d of ["results", "cells", "wt", "baseline"]) mkdirSync(join(benchRoot, d), { recursive: true });
  // Cell checkouts live away from results and the repo (FIX-D2-3); a stale
  // one from an interrupted run is swept (its cell reruns from scratch).
  const wtRoot = resolve(arg(argv, "wt-root") ?? join(tmpdir(), "aurabench-wt"));
  const wtRootProblem = checkWorktreeRoot(wtRoot, [benchRoot, repo]);
  if (wtRootProblem) {
    console.error(`[aurabench] ${wtRootProblem}`);
    return 2;
  }
  mkdirSync(wtRoot, { recursive: true });
  const swept = sweepStaleCellWorktrees(wtRoot);
  console.log(`[aurabench] cell checkouts under ${wtRoot}${swept.length ? ` (swept ${swept.length} stale)` : ""}`);

  const realHome = homedir();
  const realCodexDir = join(realHome, ".codex");
  // Rotated Codex tokens go back to the real auth.json while the cell runs,
  // on a signal and after an exception; a killed run is recovered here.
  const authKeeper = new CodexAuthKeeper({
    realCodexDir,
    stateDir: join(benchRoot, "codex-auth"),
    log: (l) => console.log(l),
  });
  const recovered = authKeeper.recover();
  if (recovered.released.length || recovered.stash.propagated.length || recovered.stash.kept.length) {
    console.log(`[aurabench] codex auth recovery: ${JSON.stringify(recovered)}`);
  }
  if (recovered.stash.kept.length) {
    console.log(`[aurabench] WARNING: ${recovered.stash.kept.length} stashed Codex token(s) could not be written back — see ${authKeeper.stash}`);
  }
  authKeeper.start();
  const nakedDeps: NakedDeps = {
    spawn: spawnNice,
    env: (extra) => benchChildEnv(process.env, extra),
    realClaudeDir: join(realHome, ".claude"),
    realCodexDir,
    watchCodexHome: (home, sha) => authKeeper.watch(home, "home", sha),
    finishCodexHome: (home) => authKeeper.release(home)[CODEX_AUTH_FILE] ?? "no_auth",
    projectSkillNames: () => {
      const names = new Set<string>();
      for (const d of [join(repo, ".claude", "skills"), join(repo, ".agents", "skills")]) {
        try {
          for (const n of readdirSync(d)) names.add(n);
        } catch {
          // absent in this checkout
        }
      }
      return [...names];
    },
    userSkillNames: () => {
      try {
        return readdirSync(join(realHome, ".claude", "skills"));
      } catch {
        return [];
      }
    },
    prepareClaudeConfig: (dir, credentialsFrom) => {
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      copyFileSync(credentialsFrom, join(dir, ".credentials.json"));
      chmodSync(join(dir, ".credentials.json"), 0o600);
    },
    present: presentNonEmpty,
    claudeModel: models.claude,
    codexModel: models.codex,
    claudeBin: binaries.claude,
    codexBin: binaries.codex,
  };
  let instance: RunningInstance | null = null;
  const stopInstance = async () => {
    const i = instance;
    instance = null;
    await i?.stop();
  };
  const onSignal = authSafeSignalHandler(authKeeper, stopInstance, (code) => process.exit(code));
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, onSignal);
  // Every variant — naked or Aura — is fingerprinted against the real
  // ~/.codex before/after the cell; any write but auth.json is a violation.
  // A limit outcome has no record, so its violation is logged separately.
  const violationsFile = join(benchRoot, "results", "isolation-violations.jsonl");
  const guard = (r: AgentRunner) =>
    guardRealCodexHome(r, {
      realCodexDir,
      onLimitViolation: (diff, ctx) => {
        console.log(`[aurabench] WARNING: real ~/.codex changed during a limit-interrupted cell (${ctx.task.id} ${ctx.variant.id})`);
        appendFileSync(violationsFile, JSON.stringify({ at: new Date().toISOString(), task: ctx.task.id, variant: ctx.variant.id, outcome: "limit", real_codex_home: diff }) + "\n");
      },
    });
  const benchSessionCodexHomes = join(benchInstancePaths(benchRoot).home, ".companion", "codex-home");
  const runners: Record<"A" | "B" | "aura", AgentRunner> = {
    A: guard(nakedClaudeRunner(nakedDeps)),
    B: guard(nakedCodexRunner(nakedDeps)),
    // Unique checkout per cell → fresh `projects/<cwd>` in the shared bench
    // HOME; the wrapper proves it and moves it into the cell's artifacts.
    // Codex sessions of the bench instance may rotate the shared token.
    aura: guard(withCleanClaudeProject(withCodexAuthWatch(async (ctx) => {
      if (!instance) instance = await startBenchInstance({ webDir: join(repo, "web"), benchRoot, realHome });
      const inst = instance;
      return auraRunner({
        baseUrl: inst.baseUrl,
        http: (m, p, b) => http(inst.baseUrl, m, p, b),
        openSocket,
        instanceFacts: () => inst.facts,
        models,
        binaries,
        confounds: (c) =>
          c.variant.mode === "aura" && c.variant.layers.knowledge === "on" && !presentNonEmpty(join(c.worktree, ".agents", "knowledge"))
            ? ["knowledge layer on, but the base commit has no .agents/knowledge"]
            : [],
      })(ctx);
    }, authKeeper, benchSessionCodexHomes, () => realAuthSha(realCodexDir)), join(benchInstancePaths(benchRoot).home, ".claude", "projects"))),
  };
  const baselineCache = new Map<string, Baseline>();
  const baseline = async (task: AuraBenchTask): Promise<Baseline> => {
    const hit = baselineCache.get(task.id);
    if (hit) return hit;
    const file = join(benchRoot, "baseline", `${task.id}.json`);
    const cached = readTextOrNull(file);
    let map: Map<string, "pass" | "fail">;
    if (cached) {
      map = new Map(Object.entries(JSON.parse(cached) as Record<string, "pass" | "fail">));
    } else {
      map = await computeBaseline(task, {
        repo,
        exec: niceExec,
        readText: readTextOrNull,
        reportFile: (n) => join(benchRoot, "baseline", `${task.id}.${n}`),
        worktree: join(benchRoot, "wt", "baseline"),
      });
      writeFileSync(file, JSON.stringify(Object.fromEntries(map), null, 1) + "\n");
    }
    baselineCache.set(task.id, map);
    return map;
  };

  try {
    const summary = await runAblation({
      taskIds: selected.map((t) => t.id),
      variants: variants.ids,
      reps,
      readResults: () => readTextOrNull(resultsFile) ?? "",
      appendResult: (rec: CellRecord) => appendFileSync(resultsFile, JSON.stringify(rec) + "\n"),
      runCell: async (cell) => {
        const task = byId.get(cell.taskId)!;
        const variant = VARIANTS[cell.variant];
        const artifactDir = join(benchRoot, "cells", task.id, `${cell.variant}-${cell.rep}`);
        rmSync(artifactDir, { recursive: true, force: true });
        mkdirSync(artifactDir, { recursive: true });
        return runCell(task, variant, cell.rep, {
          repo,
          worktree: newCellWorktree(wtRoot),
          artifactDir,
          confounds: [CELL_PATH_CONFOUND],
          exec: niceExec,
          runAgent: variant.mode === "aura" ? runners.aura : cell.variant === "A" ? runners.A : runners.B,
          baseline,
          reportFile: (n) => join(artifactDir, n),
          readText: readTextOrNull,
          cellTimeoutMs: timeoutMs,
        });
      },
      memAvailableKb,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      now: Date.now,
      log: (l) => console.log(l),
      onProgress: stateFile ? (p) => writeBenchProgress(resolve(stateFile), p.done, p.total) : undefined,
      maxCells: maxCellsArg === undefined ? undefined : Number(maxCellsArg),
    });
    console.log(`[aurabench] ${JSON.stringify(summary)}`);
    return summary.stoppedOnLimit ? 3 : 0;
  } finally {
    authKeeper.syncAll();
    await stopInstance();
    authKeeper.stop();
    authKeeper.releaseAll();
  }
}

function judgeInput(repo: string, t: AuraBenchTask) {
  const base = t.start_commit;
  const merge = t.aurabench.merge_commit;
  return {
    id: t.id,
    cls: t.aurabench.class,
    title: t.title,
    prompt: t.prompt,
    requiredInterface: taskSurface(repo, t).required,
    sourceDiff: git(repo, ["diff", "--no-color", "-U3", base, merge, "--", ...t.expected_files]).out,
    hiddenTests: git(repo, ["diff", "--no-color", "-U15", base, merge, "--", ...t.aurabench.hidden_tests]).out,
  };
}

async function judge(argv: string[], repo: string): Promise<number> {
  const dir = arg(argv, "tasks");
  const results = arg(argv, "results");
  if (!dir || !results) {
    console.error("usage: judge --tasks <dir> --results <f> [--model opus] [--id <task-id>] [--repo <dir>]");
    return 2;
  }
  const model = arg(argv, "model") ?? "opus";
  const only = arg(argv, "id");
  const { tasks } = loadAuraBenchTasks(resolve(dir), (sha) => git(repo, ["cat-file", "-e", `${sha}^{commit}`]).ok);
  const done = existsSync(results) ? readJudgeRecords(readFileSync(results, "utf8")) : new Map<string, JudgeRecord>();
  // Outside the repo so no CLAUDE.md / .claude settings reach the judge.
  const cwd = join(tmpdir(), "aurabench-judge");
  mkdirSync(cwd, { recursive: true });
  let notClean = 0;
  for (const t of tasks.filter((x) => !only || x.id === only)) {
    let rec = done.get(judgeKey(t.id, t.prompt));
    for (let attempt = 1; !rec && attempt <= 3; attempt++) {
      const r = spawnSync(
        "claude",
        [
          "-p",
          "--tools", "",
          "--setting-sources", "",
          "--system-prompt", JUDGE_SYSTEM_PROMPT,
          "--output-format", "json",
          "--json-schema", JSON.stringify(JUDGE_JSON_SCHEMA),
          "--model", model,
        ],
        { cwd, env: childEnv(), input: buildJudgeRequest(judgeInput(repo, t)), encoding: "utf8", timeout: 15 * 60_000, maxBuffer: 64 * 1024 * 1024 },
      );
      let out: { structured_output?: unknown; modelUsage?: Record<string, unknown>; is_error?: boolean } = {};
      try {
        out = JSON.parse(r.stdout ?? "");
      } catch {
        console.log(`[aurabench] judge ${t.id}: unparseable CLI output (attempt ${attempt}): ${(r.stderr ?? "").slice(0, 300)}`);
        continue;
      }
      const parsed = parseJudgeReply(out.structured_output);
      if (!parsed.ok) {
        console.log(`[aurabench] judge ${t.id}: rejected reply (attempt ${attempt}): ${parsed.error}`);
        continue;
      }
      rec = {
        id: t.id,
        prompt_sha256: promptSha256(t.prompt),
        rubric_version: JUDGE_RUBRIC_VERSION,
        model: Object.keys(out.modelUsage ?? {})[0] ?? model,
        judged_at: new Date().toISOString(),
        ...parsed.value,
      };
      appendFileSync(results, JSON.stringify(rec) + "\n");
    }
    if (!rec) {
      notClean++;
      console.log(`[aurabench] ERROR   ${t.id}: no valid judge reply after 3 attempts`);
      continue;
    }
    if (rec.verdict !== "clean") notClean++;
    console.log(`[aurabench] ${rec.verdict.toUpperCase().padEnd(7)} ${t.id} ${rec.issues.map((i) => i.kind).join(",")}`);
  }
  return notClean === 0 ? 0 : 1;
}

async function main(argv: string[]): Promise<number> {
  const sub = argv[0];
  const repo = resolve(arg(argv, "repo") ?? join(import.meta.dir, "..", ".."));
  if (sub === "mine") {
    const prsFile = arg(argv, "prs");
    const out = arg(argv, "out");
    if (!prsFile || !out) {
      console.error("usage: mine --prs <prs.json> --out <candidates.jsonl> [--repo <dir>]");
      return 2;
    }
    const prs = JSON.parse(readFileSync(prsFile, "utf8")) as MergedPr[];
    const { candidates, excluded } = minePrs(prs, gitChangedFiles(repo));
    writeFileSync(out, candidates.map((c) => JSON.stringify(c)).join("\n") + "\n");
    writeFileSync(`${out}.excluded.jsonl`, excluded.map((e) => JSON.stringify(e)).join("\n") + "\n");
    const byClass: Record<string, number> = {};
    for (const c of candidates) byClass[c.class] = (byClass[c.class] ?? 0) + 1;
    console.log(`[aurabench] ${prs.length} PRs → ${candidates.length} candidates, ${excluded.length} excluded`);
    console.log(`[aurabench] candidates by class: ${JSON.stringify(byClass)}`);
    return 0;
  }
  if (sub === "validate") {
    const candFile = arg(argv, "candidates");
    const results = arg(argv, "results");
    const wtRoot = arg(argv, "wt-root");
    if (!candFile || !results || !wtRoot) {
      console.error("usage: validate --candidates <f> --results <f> --wt-root <dir> [--limit N] [--pr N] [--repo <dir>]");
      return 2;
    }
    mkdirSync(wtRoot, { recursive: true });
    const limit = Number(arg(argv, "limit") ?? Number.POSITIVE_INFINITY);
    const only = arg(argv, "pr");
    const done = existsSync(results) ? completedPrs(readFileSync(results, "utf8")) : new Set<number>();
    let todo = readJsonl<Candidate>(candFile).filter((c) => !done.has(c.pr));
    if (only) todo = todo.filter((c) => c.pr === Number(only));
    todo = todo.slice(0, limit);
    console.log(`[aurabench] ${done.size} already validated; validating ${todo.length}`);
    for (const c of todo) {
      await waitForMemory();
      const started = Date.now();
      const v = validateCandidate(c, { repo, worktree: join(resolve(wtRoot), `pr-${c.pr}`), exec });
      appendFileSync(results, JSON.stringify(v) + "\n");
      const secs = Math.round((Date.now() - started) / 1000);
      console.log(`[aurabench] #${c.pr} ${v.ok ? `VALID (${v.base_failure})` : `excluded: ${v.reason}`} (${secs}s)`);
    }
    return 0;
  }
  if (sub === "leak") {
    const dir = arg(argv, "tasks");
    if (!dir) {
      console.error("usage: leak --tasks <dir> [--id <task-id>] [--repo <dir>]");
      return 2;
    }
    const { tasks, excluded } = loadAuraBenchTasks(resolve(dir), (sha) => git(repo, ["cat-file", "-e", `${sha}^{commit}`]).ok);
    for (const e of excluded) console.log(`[aurabench] EXCLUDED ${e.file}: ${e.reason}`);
    const only = arg(argv, "id");
    let bad = excluded.length;
    for (const t of tasks.filter((x) => !only || x.id === only)) {
      const surface = taskSurface(repo, t);
      const r = checkPrompt(t.prompt, surface);
      const clean = r.leaks.length === 0 && r.unnamed.length === 0;
      if (!clean) bad++;
      console.log(
        `[aurabench] ${clean ? "OK  " : "FAIL"} ${t.id} required=[${surface.required.join(", ")}]` +
          (r.leaks.length ? ` LEAKS=[${r.leaks.join(", ")}]` : "") +
          (r.unnamed.length ? ` UNNAMED=[${r.unnamed.join(", ")}]` : ""),
      );
    }
    return bad === 0 ? 0 : 1;
  }
  if (sub === "stability") {
    const dir = arg(argv, "tasks");
    const results = arg(argv, "results");
    const wtRoot = arg(argv, "wt-root");
    if (!dir || !results || !wtRoot) {
      console.error("usage: stability --tasks <dir> --results <f> --wt-root <dir> [--runs 3] [--id <task-id>] [--repo <dir>]");
      return 2;
    }
    mkdirSync(wtRoot, { recursive: true });
    const runs = Number(arg(argv, "runs") ?? 3);
    const { tasks } = loadAuraBenchTasks(resolve(dir), (sha) => git(repo, ["cat-file", "-e", `${sha}^{commit}`]).ok);
    const done = existsSync(results) ? readStabilityVerdicts(readFileSync(results, "utf8")) : new Map();
    const only = arg(argv, "id");
    let unstable = 0;
    for (const t of tasks.filter((x) => !only || x.id === only)) {
      const target = { id: t.id, merge_commit: t.aurabench.merge_commit, hidden_tests: t.aurabench.hidden_tests };
      let v = done.get(stabilityKey(target));
      // A setup failure proves nothing about the tests — retry it.
      if (!v || !v.setup_ok) {
        await waitForMemory();
        v = checkMergeStability(target, { repo, worktree: join(resolve(wtRoot), t.id), exec, runs });
        appendFileSync(results, JSON.stringify(v) + "\n");
      }
      if (!v.stable) unstable++;
      console.log(`[aurabench] ${v.stable ? "STABLE  " : "UNSTABLE"} ${t.id} ${v.passed}/${v.runs.length}${v.reason ? ` (${v.reason.split("\n")[0]})` : ""}`);
    }
    return unstable === 0 ? 0 : 1;
  }
  if (sub === "judge") return judge(argv, repo);
  if (sub === "bench") return bench(argv, repo);
  console.error("usage: aurabench-runner.ts <mine|validate|leak|stability|judge|bench> …");
  return 2;
}

process.exit(await main(process.argv.slice(2)));
