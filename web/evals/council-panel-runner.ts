/**
 * COUNCIL-PANEL-BENCH (P6) — offline half: cases, panels, scoring. No LLM.
 *
 *   bun run eval:council-panel verify [--cases <json>] [--repo <dir>]
 *   bun run eval:council-panel plan   [--cases <json>] [--repo <dir>] [--panels FULL,ECONOMY,MINIMAL]
 *   bun run eval:council-panel score  --case <id> --review <FINAL-REVIEW.md> [--cases <json>]
 *
 * `verify` checks every pin against git (base/head/fixedBy resolve, defect
 * files exist at head, each fix descends from head); exits 1 on any problem.
 * `plan` prints the run matrix (case × panel) with the forced roster and the
 * diff size the ECONOMY budget was sized from — one JSON line per run.
 * `score` parses a finished review and prints recall / found-as-P1 /
 * unmatched-P1 candidates for the judge and the supervisor's manual pass.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { loadHistory, loadProfiles } from "../scripts/dispatch-policy.js";
import { DEFAULT_CASES_PATH, loadCases, verifyCases, type GitRun } from "./aurabench/council-panel/cases.js";
import { composePanels, parsePanelIds, PANEL_IDS } from "./aurabench/council-panel/panels.js";
import { parseFinalReview, scoreReview } from "./aurabench/council-panel/score.js";

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
    const panels = parsePanelIds(flag(rest, "--panels") ?? PANEL_IDS.join(","));
    const profiles = loadProfiles();
    const { fingerprintSignals } = loadHistory();
    for (const c of cases) {
      const base = git(["rev-parse", `${c.base}^{commit}`])?.trim();
      const numstat = base ? git(["diff", "--numstat", base, c.head]) : null;
      if (!base || numstat === null) {
        console.error(`${c.id}: cannot resolve ${c.base}..${c.head} in ${repo}`);
        process.exit(1);
      }
      const size = diffSize(numstat);
      const composed = composePanels(c.changedDomains, fingerprintSignals, profiles, size);
      for (const p of panels) {
        console.log(JSON.stringify({ case: c.id, pr: c.pr, panel: p, seats: composed[p].seats, base, head: c.head, ...size }));
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
  } else {
    console.error("usage: council-panel-runner.ts verify|plan|score [...] (see file header)");
    process.exit(2);
  }
}
