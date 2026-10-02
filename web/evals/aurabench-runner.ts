/**
 * AuraBench corpus builder (P5/D1).
 *
 *   bun run eval:aurabench mine --prs <prs.json> --out <candidates.jsonl>
 *   bun run eval:aurabench validate --candidates <candidates.jsonl> \
 *     --results <results.jsonl> --wt-root <dir> [--limit N] [--pr N]
 *   bun run eval:aurabench leak --tasks <dir> [--id <task-id>]
 *   bun run eval:aurabench judge --tasks <dir> --results <f> [--model opus] [--id <task-id>]
 *   bun run eval:aurabench spec-check --tasks <dir> --results <f> [--model opus] [--id <task-id>]
 *   bun run eval:aurabench stability --tasks <dir> --results <f> --wt-root <dir> [--runs 3]
 *   bun run eval:aurabench bench --bench-root <dir> [--variants A,B,…] [--reps 5]
 *     [--task-ids a,b] [--max-cells N] [--state <STATE.json>] [--timeout-min 60] [--timeout-min-class architecture=120]
 *     [--claude-model claude-opus-5-5] [--codex-model gpt-5.5]
 *     [--diet-overlay before|after] [--diet-after-ref diet/main]
 *   bun run eval:aurabench report --cells <cells.jsonl>[,<more.jsonl>] [--iters 10000] [--exclude-tasks a,b]
 *
 * `report` prints the D3 tables (success / Aura Lift / cost with bootstrap
 * 95% CIs, per class, the A→C→D→E ladder) for `docs/aurabench/REPORT.md` —
 * see `aurabench/report.ts`. Several cell files are concatenated;
 * `--exclude-tasks` drops tasks (a sensitivity table without artefact tasks).
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
 * `spec-check` is the converse LLM check (`spec-check.ts`): is every behaviour
 * the hidden tests assert stated by the prompt or determined by the base
 * repository? Same call shape, keying and resume as `judge`; exits 1 unless
 * every task is "ok".
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
 * into `STATE.bench.cells_done/cells_total`. Before every cell `bench` asks the
 * prod `GET /api/usage-limits` (read-only) and holds while the Claude
 * subscription is at/over `AURABENCH_WEEKLY_CEILING` (default 75%) weekly or
 * `AURABENCH_FIVE_HOUR_CEILING` (default 90%) 5-hourly; fail-closed.
 * Codex cells (B/F/G/H) additionally obey a rolling-24 h start budget
 * (`AURABENCH_CODEX_DAILY_CELLS`, default 12; ledger `AURABENCH_CODEX_LEDGER`,
 * default `<bench-root>/codex-starts.log` — point every runner at one file),
 * and a Codex usage limit pauses only the Codex cells — see `codex-quota.ts`.
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
import { dirname, join, resolve } from "node:path";
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
import {
  SPEC_JSON_SCHEMA,
  SPEC_RUBRIC_VERSION,
  SPEC_SYSTEM_PROMPT,
  buildSpecRequest,
  parseSpecReply,
  readSpecRecords,
  specKey,
  type SpecRecord,
} from "./aurabench/spec-check.js";
import { checkMergeStability, readStabilityVerdicts, stabilityKey } from "./aurabench/flake.js";
import { loadAuraBenchTasks } from "./aurabench/loader.js";
import type { AuraBenchTask } from "./aurabench/task.js";
import { runAblation } from "./aurabench/harness/driver.js";
import { loadReportCells, renderReportTables } from "./aurabench/report.js";
import { codexDailyCellsFromEnv, parseCodexLedger, variantUsesCodex } from "./aurabench/harness/codex-quota.js";
import { fetchUsageGate, usageCeilingsFromEnv } from "./aurabench/harness/usage-ceiling.js";
import { claudeTokenGate, quarantineClaudeCredentialCopies, readClaudeAccessToken } from "./aurabench/harness/claude-auth.js";
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
import { benchChildEnv, killLiveChildren, niceExec, spawnNice, stopLiveChildren } from "./aurabench/harness/proc.js";
import { parseClassTimeouts, staleCellRecords, type CellRecord } from "./aurabench/harness/cells.js";
import { DIET_BEFORE_REF, overlayMismatches, parseDietVersion, type DietOverlaySpec } from "./aurabench/harness/diet-overlay.js";
import {
  CELL_PATH_CONFOUND,
  checkWorktreeRoot,
  newCellWorktree,
  sweepStaleCellWorktrees,
  withCleanClaudeProject,
} from "./aurabench/harness/cell-paths.js";
import { readdirSync, renameSync, rmSync, statSync } from "node:fs";
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

/** A confirmed fatal auth gate stops the run; the human queue gets the why. */
function appendAuthStopAsk(askFile: string, reason: string): void {
  appendFileSync(
    askFile,
    `\n## AuraBench остановлен: прод-OAuth Claude недоступен (${new Date().toISOString()}, раннер D2)\n\n` +
      `Раннер остановился (exit 4), а не ждёт молча: ${reason}. Проверить \`~/.claude/.credentials.json\` и прод-\`GET /api/usage-limits\`; ` +
      `после восстановления логина перезапустить runner_cmd (ячейки идемпотентны).\n`,
  );
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

async function http(baseUrl: string, method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown) {
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
    console.error("usage: bench --bench-root <dir> [--variants A,B,…] [--reps 5] [--task-ids a,b] [--max-cells N] [--state <STATE.json>] [--timeout-min 60] [--timeout-min-class architecture=120] [--tasks <dir>] [--wt-root <dir outside bench-root and repo>]");
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
  const classTimeouts = parseClassTimeouts(arg(argv, "timeout-min-class"));
  if (!classTimeouts.ok) {
    console.error(`[aurabench] ${classTimeouts.reason}`);
    return 2;
  }
  const stateFile = arg(argv, "state");
  // DIET-AB: swap the control files for the pre-/post-diet version. Refs are
  // pinned to full shas at start, so a moving `diet/main` cannot mix versions.
  const dietVersion = parseDietVersion(arg(argv, "diet-overlay"));
  if (!dietVersion.ok) {
    console.error(`[aurabench] ${dietVersion.reason}`);
    return 2;
  }
  let dietOverlay: DietOverlaySpec | null = null;
  if (dietVersion.version) {
    const naked = variants.ids.filter((id) => VARIANTS[id].mode === "naked");
    if (naked.length) {
      console.error(`[aurabench] --diet-overlay needs Aura variants; naked: ${naked.join(",")}`);
      return 2;
    }
    const pin = (ref: string) => git(repo, ["rev-parse", "--verify", `${ref}^{commit}`]);
    const after = pin(arg(argv, "diet-after-ref") ?? "diet/main");
    const before = pin(DIET_BEFORE_REF);
    if (!after.ok || !before.ok) {
      console.error(`[aurabench] cannot resolve diet refs (after ok=${after.ok}, before ok=${before.ok})`);
      return 2;
    }
    dietOverlay =
      dietVersion.version === "before"
        ? { version: "before", ref: before.out.trim(), learningsRef: after.out.trim() }
        : { version: "after", ref: after.out.trim() };
    console.log(`[aurabench] diet overlay: ${JSON.stringify(dietOverlay)}`);
  }
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
  // Reuse only cells that measured the prompt the corpus has now.
  const promptSha = new Map(selected.map((t) => [t.id, promptSha256(t.prompt)]));
  const stale = staleCellRecords(readTextOrNull(resultsFile) ?? "", promptSha);
  if (stale.mismatched.length) {
    console.error(`[aurabench] ${stale.mismatched.length} finished cell(s) ran an older prompt — move them out of ${resultsFile} before rerunning: ${stale.mismatched.map((m) => m.key).join(", ")}`);
    return 2;
  }
  const wrongOverlay = overlayMismatches(readTextOrNull(resultsFile) ?? "", dietOverlay);
  if (wrongOverlay.length) {
    console.error(`[aurabench] ${wrongOverlay.length} finished cell(s) in ${resultsFile} ran another diet overlay — one overlay per bench root: ${wrongOverlay.slice(0, 5).join(", ")}`);
    return 2;
  }
  if (stale.unstamped.length) console.log(`[aurabench] WARNING: ${stale.unstamped.length} reused cell(s) carry no prompt sha — reuse unverified`);
  if (Object.keys(classTimeouts.minutes).length) console.log(`[aurabench] per-class timeouts (min): ${JSON.stringify(classTimeouts.minutes)}`);
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
  const realClaudeDir = join(realHome, ".claude");
  // P6/FIX-D2-CLAUDE-AUTH: no bench process may hold a refresh token of
  // prod's Claude login. Copies left by older runs (bench HOME, A cells) are
  // moved to quarantine — never written back, never deleted.
  const claudeQuarantine = benchInstancePaths(benchRoot).claudeQuarantine;
  const quarantined = quarantineClaudeCredentialCopies([benchRoot], claudeQuarantine);
  if (quarantined.length) console.log(`[aurabench] quarantined ${quarantined.length} Claude credentials cop(ies) → ${claudeQuarantine}`);
  const claudeAccessToken = () => {
    const r = readClaudeAccessToken(realClaudeDir);
    if (!r.ok) throw new Error(`no prod Claude access token: ${r.reason}`);
    return r.accessToken;
  };
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
    realClaudeDir,
    realCodexDir,
    claudeAccessToken,
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
    prepareClaudeConfig: (dir) => {
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true, mode: 0o700 });
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
  // Agents run detached (own process group): stop them before the cell
  // homes are released, so auth.json never vanishes under a live Codex.
  const onSignal = authSafeSignalHandler(authKeeper, stopInstance, (code) => process.exit(code), {
    stop: () => stopLiveChildren(),
    killNow: () => killLiveChildren(),
  });
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
      // Claude sessions of the instance get the bare access token through the
      // setting the server injects as CLAUDE_CODE_OAUTH_TOKEN (create and relaunch).
      const set = await http(inst.baseUrl, "PUT", "/api/settings", { claudeCodeOAuthToken: claudeAccessToken() });
      if (set.status !== 200) throw new Error(`bench instance rejected the Claude token setting (HTTP ${set.status})`);
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

  const ceilings = usageCeilingsFromEnv(process.env);
  console.log(`[aurabench] usage ceilings: seven_day < ${ceilings.weekly}%, five_hour < ${ceilings.fiveHour}%`);
  const codexDailyCells = codexDailyCellsFromEnv(process.env);
  const codexLedger = resolve(process.env.AURABENCH_CODEX_LEDGER?.trim() || join(benchRoot, "codex-starts.log"));
  console.log(`[aurabench] Codex budget: ${codexDailyCells} cell starts / 24 h (ledger ${codexLedger})`);
  try {
    const summary = await runAblation({
      taskIds: selected.map((t) => t.id),
      variants: variants.ids,
      reps,
      readResults: () => readTextOrNull(resultsFile) ?? "",
      appendResult: (rec: CellRecord) =>
        appendFileSync(resultsFile, JSON.stringify({ ...rec, prompt_sha256: promptSha.get(rec.task_id) }) + "\n"),
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
          ...(dietOverlay ? { dietOverlay } : {}),
          exec: niceExec,
          runAgent: variant.mode === "aura" ? runners.aura : cell.variant === "A" ? runners.A : runners.B,
          baseline,
          reportFile: (n) => join(artifactDir, n),
          readText: readTextOrNull,
          cellTimeoutMs: (classTimeouts.minutes[task.aurabench.class] ?? timeoutMs / 60_000) * 60_000,
        });
      },
      memAvailableKb,
      codex: {
        isCodexCell: (cell) => variantUsesCodex(cell.variant),
        dailyCells: codexDailyCells,
        starts: () => parseCodexLedger(readTextOrNull(codexLedger) ?? ""),
        noteStart: (at) => {
          mkdirSync(dirname(codexLedger), { recursive: true });
          appendFileSync(codexLedger, `${at}\n`);
        },
      },
      usageGate: async (cell) => {
        const g = await fetchUsageGate(fetch, ceilings);
        if (!g.ok || cell.variant === "B") return g;
        // Every Claude-driven cell must finish on the access token it starts with.
        const task = byId.get(cell.taskId)!;
        const needMs = (classTimeouts.minutes[task.aurabench.class] ?? timeoutMs / 60_000) * 60_000;
        const t = claudeTokenGate(readClaudeAccessToken(realClaudeDir), needMs, Date.now());
        return t.ok ? g : { ok: false, fatal: t.fatal, reason: t.reason, sevenDay: g.sevenDay, fiveHour: g.fiveHour, resetsAt: null };
      },
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      now: Date.now,
      log: (l) => console.log(l),
      onProgress: stateFile ? (p) => writeBenchProgress(resolve(stateFile), p.done, p.total) : undefined,
      maxCells: maxCellsArg === undefined ? undefined : Number(maxCellsArg),
    });
    console.log(`[aurabench] ${JSON.stringify(summary)}`);
    if (summary.stoppedOnAuth) {
      if (stateFile) appendAuthStopAsk(join(dirname(resolve(stateFile)), "ASK-FIRST.md"), summary.stoppedOnAuth);
      return 4;
    }
    return summary.stoppedOnLimit || summary.stoppedOnCodex ? 3 : 0;
  } finally {
    // Best effort: the bench HOME keeps no access token after the run.
    if (instance) await http((instance as RunningInstance).baseUrl, "PUT", "/api/settings", { claudeCodeOAuthToken: "" }).catch(() => undefined);
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

async function specCheck(argv: string[], repo: string): Promise<number> {
  const dir = arg(argv, "tasks");
  const results = arg(argv, "results");
  if (!dir || !results) {
    console.error("usage: spec-check --tasks <dir> --results <f> [--model opus] [--id <task-id>] [--repo <dir>]");
    return 2;
  }
  const model = arg(argv, "model") ?? "opus";
  const only = arg(argv, "id");
  const { tasks } = loadAuraBenchTasks(resolve(dir), (sha) => git(repo, ["cat-file", "-e", `${sha}^{commit}`]).ok);
  const done = existsSync(results) ? readSpecRecords(readFileSync(results, "utf8")) : new Map<string, SpecRecord>();
  // Outside the repo so no CLAUDE.md / .claude settings reach the checker.
  const cwd = join(tmpdir(), "aurabench-spec-check");
  mkdirSync(cwd, { recursive: true });
  let notOk = 0;
  for (const t of tasks.filter((x) => !only || x.id === only)) {
    let rec = done.get(specKey(t.id, t.prompt));
    for (let attempt = 1; !rec && attempt <= 3; attempt++) {
      await waitForMemory();
      const r = spawnSync(
        "claude",
        [
          "-p",
          "--tools", "",
          "--setting-sources", "",
          "--system-prompt", SPEC_SYSTEM_PROMPT,
          "--output-format", "json",
          "--json-schema", JSON.stringify(SPEC_JSON_SCHEMA),
          "--model", model,
        ],
        { cwd, env: childEnv(), input: buildSpecRequest(judgeInput(repo, t)), encoding: "utf8", timeout: 15 * 60_000, maxBuffer: 64 * 1024 * 1024 },
      );
      let out: { structured_output?: unknown; modelUsage?: Record<string, unknown> } = {};
      try {
        out = JSON.parse(r.stdout ?? "");
      } catch {
        console.log(`[aurabench] spec-check ${t.id}: unparseable CLI output (attempt ${attempt}): ${(r.stderr ?? "").slice(0, 300)}`);
        continue;
      }
      const parsed = parseSpecReply(out.structured_output);
      if (!parsed.ok) {
        console.log(`[aurabench] spec-check ${t.id}: rejected reply (attempt ${attempt}): ${parsed.error}`);
        continue;
      }
      rec = {
        id: t.id,
        prompt_sha256: promptSha256(t.prompt),
        rubric_version: SPEC_RUBRIC_VERSION,
        model: Object.keys(out.modelUsage ?? {})[0] ?? model,
        checked_at: new Date().toISOString(),
        ...parsed.value,
      };
      appendFileSync(results, JSON.stringify(rec) + "\n");
    }
    if (!rec) {
      notOk++;
      console.log(`[aurabench] ERROR   ${t.id}: no valid spec-check reply after 3 attempts`);
      continue;
    }
    if (rec.verdict !== "ok") notOk++;
    console.log(`[aurabench] ${rec.verdict.toUpperCase().padEnd(14)} ${t.id} gaps=${rec.gaps.length}`);
  }
  return notOk === 0 ? 0 : 1;
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
  if (sub === "spec-check") return specCheck(argv, repo);
  if (sub === "bench") return bench(argv, repo);
  if (sub === "report") {
    const files = arg(argv, "cells");
    if (!files) {
      console.error("usage: report --cells <cells.jsonl>[,<more.jsonl>] [--iters 10000] [--exclude-tasks a,b]");
      return 2;
    }
    const jsonl = files
      .split(",")
      .map((f) => readFileSync(resolve(f), "utf8"))
      .join("\n");
    const dropTasks = new Set((arg(argv, "exclude-tasks") ?? "").split(",").filter(Boolean));
    const loaded = loadReportCells(jsonl);
    const cells = loaded.cells.filter((c) => !dropTasks.has(c.task_id));
    const excluded = loaded.excluded;
    console.log(`<!-- ${cells.length} cells, ${excluded.length} excluded, tasks dropped: ${[...dropTasks].join(",") || "none"} -->`);
    for (const e of excluded) console.log(`<!-- excluded ${e.key}: ${e.reason} -->`);
    console.log(renderReportTables(cells, Number(arg(argv, "iters") ?? 10_000)));
    return 0;
  }
  console.error("usage: aurabench-runner.ts <mine|validate|leak|stability|judge|spec-check|bench|report> …");
  return 2;
}

process.exit(await main(process.argv.slice(2)));
