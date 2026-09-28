/**
 * AuraBench corpus builder (P5/D1).
 *
 *   bun run eval:aurabench mine --prs <prs.json> --out <candidates.jsonl>
 *   bun run eval:aurabench validate --candidates <candidates.jsonl> \
 *     --results <results.jsonl> --wt-root <dir> [--limit N] [--pr N]
 *   bun run eval:aurabench leak --tasks <dir> [--id <task-id>]
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
  console.error("usage: aurabench-runner.ts <mine|validate|leak> …");
  return 2;
}

process.exit(await main(process.argv.slice(2)));
