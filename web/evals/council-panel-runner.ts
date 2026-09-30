/**
 * COUNCIL-PANEL-BENCH (P6) — offline half: cases, panels, scoring. No LLM.
 *
 *   bun run eval:council-panel verify [--cases <json>] [--repo <dir>]
 *   bun run eval:council-panel plan   [--cases <json>] [--repo <dir>] [--panels FULL,ECONOMY,MINIMAL]
 *   bun run eval:council-panel score  --case <id> --review <FINAL-REVIEW.md> [--cases <json>]
 *   bun run eval:council-panel run    --bench-root <dir> --wt-root <dir> [--case-ids a,b] [--panels …]
 *                                      [--reps 1] [--timeout-min 90] [--max-runs N] [--claude-model <id>]
 *
 * `verify` checks every pin against git (base/head/fixedBy resolve, defect
 * files exist at head, each fix descends from head); exits 1 on any problem.
 * `plan` prints the run matrix (case × panel) with the forced roster and the
 * diff size the ECONOMY budget was sized from — one JSON line per run.
 * `score` parses a finished review and prints recall / found-as-P1 /
 * unmatched-P1 candidates for the judge and the supervisor's manual pass.
 * `run` is the LIVE half (LLM, subscription): case × panel × rep runs of
 * `/council-review-aura`, idempotent by key, results JSONL + artifacts under
 * `<bench-root>/council-panel/` (see `aurabench/council-panel/run.ts`). Exit 0
 * done, 3 stopped on usage limits, 4 prod Claude auth dead, 2 usage error.
 */

import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { loadHistory, loadProfiles } from "../scripts/dispatch-policy.js";
import { DEFAULT_CASES_PATH, loadCases, verifyCases, type GitRun, type PanelCase } from "./aurabench/council-panel/cases.js";
import { composePanels, parsePanelIds, PANEL_IDS, type Panel, type PanelId } from "./aurabench/council-panel/panels.js";
import { parseFinalReview, scoreReview } from "./aurabench/council-panel/score.js";
import { planPanelRuns, runPanelBench, runPanelRun, DEFAULT_PANEL_TIMEOUT_MIN, type PlannedPanelRun } from "./aurabench/council-panel/run.js";
import { benchInstancePaths } from "./aurabench/harness/bench-instance.js";
import { checkWorktreeRoot, newCellWorktree, sweepStaleCellWorktrees } from "./aurabench/harness/cell-paths.js";
import { claudeTokenGate, quarantineClaudeCredentialCopies, readClaudeAccessToken } from "./aurabench/harness/claude-auth.js";
import { benchChildEnv, niceExec, spawnNice, stopLiveChildren } from "./aurabench/harness/proc.js";
import { fetchUsageGate, usageCeilingsFromEnv } from "./aurabench/harness/usage-ceiling.js";

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

function gitIn(repo: string): GitRun {
  return (args) => {
    try {
      return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      return null;
    }
  };
}

/** Added + deleted lines and file count of base..head (binary files count as a file, 0 lines). */
export function diffSize(numstat: string): { diffFiles: number; diffLines: number } {
  let diffFiles = 0;
  let diffLines = 0;
  for (const line of numstat.split("\n")) {
    const m = /^(\d+|-)\t(\d+|-)\t/.exec(line);
    if (!m) continue;
    diffFiles += 1;
    if (m[1] !== "-") diffLines += Number(m[1]);
    if (m[2] !== "-") diffLines += Number(m[2]);
  }
  return { diffFiles, diffLines };
}

interface ComposedCase {
  case: PanelCase;
  panels: Panel[];
  base: string;
  size: { diffFiles: number; diffLines: number };
}

/** Rosters per case (the ECONOMY budget is sized from the real base..head diff). Null + stderr on an unresolvable case. */
function composeCaseRuns(cases: PanelCase[], git: GitRun, repo: string, panelIds: PanelId[]): ComposedCase[] | null {
  const profiles = loadProfiles();
  const { fingerprintSignals } = loadHistory();
  const out: ComposedCase[] = [];
  for (const c of cases) {
    const base = git(["rev-parse", `${c.base}^{commit}`])?.trim();
    const numstat = base ? git(["diff", "--numstat", base, c.head]) : null;
    if (!base || numstat === null) {
      console.error(`${c.id}: cannot resolve ${c.base}..${c.head} in ${repo}`);
      return null;
    }
    const size = diffSize(numstat);
    const composed = composePanels(c.changedDomains, fingerprintSignals, profiles, size);
    out.push({ case: c, panels: panelIds.map((p) => composed[p]), base, size });
  }
  return out;
}

async function runCmd(argv: string[], allCases: PanelCase[], git: GitRun, repo: string): Promise<number> {
  const benchRootArg = flag(argv, "--bench-root");
  const wtRootArg = flag(argv, "--wt-root");
  if (!benchRootArg || !wtRootArg) {
    console.error("run: --bench-root <dir> and --wt-root <dir outside bench-root and repo> are required");
    return 2;
  }
  const root = join(resolve(benchRootArg), "council-panel");
  const wtRoot = resolve(wtRootArg);
  const wtProblem = checkWorktreeRoot(wtRoot, [resolve(benchRootArg), repo]);
  if (wtProblem) {
    console.error(`[council-panel] ${wtProblem}`);
    return 2;
  }
  const ids = flag(argv, "--case-ids")?.split(",").filter(Boolean);
  const unknown = ids?.filter((id) => !allCases.some((c) => c.id === id)) ?? [];
  if (unknown.length) {
    console.error(`[council-panel] unknown case id(s): ${unknown.join(", ")}`);
    return 2;
  }
  const cases = ids ? allCases.filter((c) => ids.includes(c.id)) : allCases;
  const reps = Number(flag(argv, "--reps") ?? 1);
  const timeoutMs = Number(flag(argv, "--timeout-min") ?? DEFAULT_PANEL_TIMEOUT_MIN) * 60_000;
  const maxRunsArg = flag(argv, "--max-runs");
  const claudeModel = flag(argv, "--claude-model") ?? "claude-opus-5-5";
  const claudeBin = Bun.which("claude");
  if (!claudeBin || !(timeoutMs > 0)) {
    console.error(`[council-panel] claude on PATH: ${claudeBin ?? "no"}; timeout ${timeoutMs} ms`);
    return 2;
  }
  const composed = composeCaseRuns(cases, git, repo, parsePanelIds(flag(argv, "--panels") ?? PANEL_IDS.join(",")));
  if (!composed) return 2;
  const plan: PlannedPanelRun[] = planPanelRuns(composed, reps);

  mkdirSync(join(root, "runs"), { recursive: true });
  mkdirSync(wtRoot, { recursive: true });
  const swept = sweepStaleCellWorktrees(wtRoot);
  if (swept.length) console.log(`[council-panel] swept ${swept.length} stale checkout(s) under ${wtRoot}`);
  const realClaudeDir = join(homedir(), ".claude");
  const realSkillsDir = join(realClaudeDir, "skills");
  // P6/FIX-D2-CLAUDE-AUTH: no bench process holds a refresh token.
  const quarantined = quarantineClaudeCredentialCopies([root], benchInstancePaths(resolve(benchRootArg)).claudeQuarantine);
  if (quarantined.length) console.log(`[council-panel] quarantined ${quarantined.length} Claude credentials cop(ies)`);
  const catalogIds = new Set(loadProfiles().map((p) => p.id));
  const resultsFile = join(root, "results.jsonl");
  const ceilings = usageCeilingsFromEnv(process.env);
  console.log(`[council-panel] ${plan.length} run(s), model ${claudeModel}, timeout ${timeoutMs / 60_000} min, ceilings ${JSON.stringify(ceilings)}`);

  const onSignal = () => void stopLiveChildren().finally(() => process.exit(130));
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, onSignal);

  const summary = await runPanelBench({
    plan,
    readResults: () => {
      try {
        return readFileSync(resultsFile, "utf8");
      } catch {
        return "";
      }
    },
    appendResult: (rec) => appendFileSync(resultsFile, JSON.stringify(rec) + "\n"),
    runOne: async (run) => {
      const artifactDir = join(root, "runs", run.case.id, `${run.panel.id}-${run.rep}`);
      rmSync(artifactDir, { recursive: true, force: true });
      mkdirSync(artifactDir, { recursive: true });
      return runPanelRun(run, {
        exec: niceExec,
        spawn: spawnNice,
        repo,
        checkout: newCellWorktree(wtRoot),
        artifactDir,
        realSkillsDir,
        realClaudeDir,
        userSkillNames: () => {
          try {
            return readdirSync(realSkillsDir);
          } catch {
            return [];
          }
        },
        claudeAccessToken: () => {
          const r = readClaudeAccessToken(realClaudeDir);
          if (!r.ok) throw new Error(`no prod Claude access token: ${r.reason}`);
          return r.accessToken;
        },
        env: (extra) => benchChildEnv(process.env, extra),
        catalogIds,
        gitId: ["-c", "user.name=aurabench", "-c", "user.email=aurabench@localhost", "-c", "commit.gpgsign=false"],
        timeoutMs,
        claudeBin,
        claudeModel,
      });
    },
    usageGate: async () => {
      const g = await fetchUsageGate(fetch, ceilings);
      if (!g.ok) return g;
      // The run must finish on the access token it starts with.
      const t = claudeTokenGate(readClaudeAccessToken(realClaudeDir), timeoutMs, Date.now());
      return t.ok ? g : { ok: false, fatal: t.fatal, reason: t.reason, sevenDay: g.sevenDay, fiveHour: g.fiveHour, resetsAt: null };
    },
    memAvailableKb: () => {
      const m = /MemAvailable:\s+(\d+)/.exec(readFileSync("/proc/meminfo", "utf8"));
      return m ? Number(m[1]) : Number.POSITIVE_INFINITY;
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: Date.now,
    log: (l) => console.log(l),
    maxRuns: maxRunsArg === undefined ? undefined : Number(maxRunsArg),
  });
  console.log(`[council-panel] ${JSON.stringify(summary)}`);
  return summary.stoppedOnAuth ? 4 : summary.stoppedOnLimit ? 3 : 0;
}

if (import.meta.main) {
  const [, , cmd, ...rest] = process.argv;
  const cases = loadCases(flag(rest, "--cases") ?? DEFAULT_CASES_PATH);
  const repo = resolve(flag(rest, "--repo") ?? "..");
  const git = gitIn(repo);

  if (cmd === "verify") {
    const problems = verifyCases(cases, git);
    for (const p of problems) console.error(p);
    const defects = cases.reduce((n, c) => n + c.knownDefects.length, 0);
    console.log(`${cases.length} case(s), ${defects} known defect(s), ${problems.length} problem(s)`);
    process.exit(problems.length === 0 ? 0 : 1);
  } else if (cmd === "plan") {
    const composed = composeCaseRuns(cases, git, repo, parsePanelIds(flag(rest, "--panels") ?? PANEL_IDS.join(",")));
    if (!composed) process.exit(1);
    for (const { case: c, panels, base, size } of composed) {
      for (const p of panels) {
        console.log(JSON.stringify({ case: c.id, pr: c.pr, panel: p.id, seats: p.seats, base, head: c.head, ...size }));
      }
    }
  } else if (cmd === "score") {
    const caseId = flag(rest, "--case");
    const review = flag(rest, "--review");
    const c = cases.find((x) => x.id === caseId);
    if (!c || !review) {
      console.error("score: --case <known id> and --review <FINAL-REVIEW.md> are required");
      process.exit(2);
    }
    console.log(JSON.stringify(scoreReview(c, parseFinalReview(readFileSync(review, "utf8"))), null, 2));
  } else if (cmd === "run") {
    process.exit(await runCmd(rest, cases, git, repo));
  } else {
    console.error("usage: council-panel-runner.ts verify|plan|score|run [...] (see file header)");
    process.exit(2);
  }
}
