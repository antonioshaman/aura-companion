/**
 * AuraBench corpus builder (P5/D1).
 *
 *   bun run eval:aurabench mine --prs <prs.json> --out <candidates.jsonl>
 *   bun run eval:aurabench validate --candidates <candidates.jsonl> \
 *     --results <results.jsonl> --wt-root <dir> [--limit N] [--pr N]
 *   bun run eval:aurabench leak --tasks <dir> [--id <task-id>]
 *   bun run eval:aurabench bench --bench-root <dir> [--variants A,B,…] [--reps 5]
 *     [--task-ids a,b] [--max-cells N] [--state <STATE.json>] [--timeout-min 60]
 *     [--claude-model claude-opus-5-5] [--codex-model gpt-5.4]
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
import { loadAuraBenchTasks } from "./aurabench/loader.js";
import type { AuraBenchTask } from "./aurabench/task.js";
import { runAblation } from "./aurabench/harness/driver.js";
import { runCell, computeBaseline, type AgentRunner, type Baseline } from "./aurabench/harness/run-cell.js";
import { VARIANTS, parseVariantList } from "./aurabench/harness/variants.js";
import { nakedClaudeRunner, nakedCodexRunner, type NakedDeps } from "./aurabench/harness/naked-agents.js";
import { auraRunner, type BenchSocket } from "./aurabench/harness/aura-agent.js";
import { startBenchInstance, type RunningInstance } from "./aurabench/harness/bench-instance.js";
import { benchChildEnv, niceExec, spawnNice } from "./aurabench/harness/proc.js";
import type { CellRecord } from "./aurabench/harness/cells.js";
import { chmodSync, copyFileSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";

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
    console.error("usage: bench --bench-root <dir> [--variants A,B,…] [--reps 5] [--task-ids a,b] [--max-cells N] [--state <STATE.json>] [--timeout-min 60] [--tasks <dir>]");
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
  // --ignore-user-config` drops the user's configured model.
  const models = { claude: arg(argv, "claude-model") ?? "claude-opus-5-5", codex: arg(argv, "codex-model") ?? "gpt-5.4" };
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

  const realHome = homedir();
  const nakedDeps: NakedDeps = {
    spawn: spawnNice,
    env: (extra) => benchChildEnv(process.env, extra),
    realClaudeDir: join(realHome, ".claude"),
    realCodexDir: join(realHome, ".codex"),
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
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => void stopInstance().finally(() => process.exit(130)));
  }
  const runners: Record<"A" | "B" | "aura", AgentRunner> = {
    A: nakedClaudeRunner(nakedDeps),
    B: nakedCodexRunner(nakedDeps),
    aura: async (ctx) => {
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
    },
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
          worktree: join(benchRoot, "wt", "cell"),
          artifactDir,
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
    await stopInstance();
  }
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
  if (sub === "bench") return bench(argv, repo);
  console.error("usage: aurabench-runner.ts <mine|validate|leak|bench> …");
  return 2;
}

process.exit(await main(process.argv.slice(2)));
