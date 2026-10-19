/**
 * The live half of COUNCIL-PANEL-BENCH (P6): one `/council-review-aura` run
 * per case × panel × rep, and the idempotent loop over them.
 *
 * One run:
 *   1. sealed checkout of `base..head` ({@link sealedPanelCheckout}: two
 *      commits, no later objects, no archived reviews);
 *   2. `bun install --frozen-lockfile` in `web/` (best effort — reviewers may
 *      run tests; a failure is a confound, not a stop);
 *   3. a per-run HOME holding a COPY of the two skills the run needs
 *      ({@link PANEL_SKILLS}, dereferenced from the real `~/.claude/skills`,
 *      which is only read) with every prod `localhost:3456` rewritten to a
 *      dead port — the skills spell their paths `~/.claude/skills/…`, so
 *      `HOME` + `CLAUDE_CONFIG_DIR` both point into the run home; run-stats
 *      and the result cache (`~/.companion/…`) land there too;
 *   4. `claude -p` with the forced-roster prompt, the bare access token only
 *      (`CLAUDE_CODE_OAUTH_TOKEN`, P6/FIX-D2-CLAUDE-AUTH), no MCP, hooks
 *      visible;
 *   5. evidence: the init frame (the skill is loaded, no other user skill,
 *      no plugin/MCP/hook — {@link checkNakedClaudeIsolation}), the roster
 *      actually dispatched ({@link checkDispatch}), the review directory
 *      copied into the artifacts, the recall score, cost / time / turns, and
 *      that the run home holds no credentials file afterwards.
 *
 * A usage limit yields NO record (the loop sleeps and retries the same run).
 * Every effect is injected; unit-tested with scripted fakes. Firewall-clean.
 */

import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { detectLimit, emptyMetrics, limitSleepMs, summarizeClaudeStream, type LimitHit } from "../harness/agent-metrics.js";
import { rewriteSkillProdUrls } from "../harness/bench-instance.js";
import type { AgentMetrics } from "../harness/cells.js";
import { CLAUDE_TOKEN_ENV, claudeCredentialCopyEvidence } from "../harness/claude-auth.js";
import { checkNakedClaudeIsolation } from "../harness/isolation.js";
import { claudeNakedArgs, type Spawner } from "../harness/naked-agents.js";
import { removeCheckout, type AsyncExec } from "../harness/run-cell.js";
import { MIN_AVAILABLE_KB } from "../harness/driver.js";
import { USAGE_HOLD_POLL_MS, formatUsageHold, type UsageGate } from "../harness/usage-ceiling.js";
import type { PanelCase } from "./cases.js";
import { checkDispatch, type DispatchCheck } from "./dispatch.js";
import type { Panel, PanelId } from "./panels.js";
import { buildPanelPrompt } from "./prompt.js";
import { parseFinalReview, scoreReview, type RunScore } from "./score.js";
import { sealedPanelCheckout, type SealedPanelCheckout } from "./sealed.js";

export const PANEL_RECORD_VERSION = 1 as const;
/** The only user-level skills a run sees (copied, never linked). */
export const PANEL_SKILLS = ["council-review-aura", "_council-experts"] as const;
/** The skill the prompt invokes; must be in the init frame. */
export const PANEL_SKILL = "council-review-aura";
/** Where the skill copy's prod URLs point: the discard port — nothing listens,
 *  so the checkpoint-emit probe fails and the phase is skipped. */
export const PANEL_DEAD_PORT = 9;
export const DEFAULT_PANEL_TIMEOUT_MIN = 90;

export type PanelRunStatus =
  | "completed"
  | "invalid_roster"
  | "invalid_isolation"
  | "no_review"
  | "timeout"
  | "agent_error"
  | "harness_error";

export interface PanelRunRecord {
  v: typeof PANEL_RECORD_VERSION;
  key: string;
  case_id: string;
  pr: number;
  panel: PanelId;
  rep: number;
  /** The forced roster. */
  seats: string[];
  status: PanelRunStatus;
  /** Counts toward the results: completed, forced roster honoured, isolated, review written. */
  valid: boolean;
  started_at: string;
  finished_at: string;
  wall_ms: number;
  prompt_sha256: string | null;
  sealed: SealedPanelCheckout | null;
  dispatch: (Omit<DispatchCheck, "dispatches"> & { total: number; dispatches: DispatchCheck["dispatches"] }) | null;
  expert_files: { present: string[]; missing: string[] };
  /** Artifact-relative copy of the run's review directory. */
  review_dir: string | null;
  score: RunScore | null;
  metrics: AgentMetrics;
  isolation: Record<string, unknown>;
  confounds: string[];
  error?: string;
}

export function panelRunKey(caseId: string, panel: PanelId, rep: number): string {
  return `${caseId}|${panel}|${rep}`;
}

export interface PlannedPanelRun {
  key: string;
  case: PanelCase;
  panel: Panel;
  rep: number;
}

/** Case-major, then panel, then rep — the order the loop runs them in. */
export function planPanelRuns(cases: readonly { case: PanelCase; panels: Panel[] }[], reps: number): PlannedPanelRun[] {
  if (!Number.isInteger(reps) || reps < 1) throw new Error(`council-panel: reps must be a positive integer, got ${reps}`);
  const out: PlannedPanelRun[] = [];
  for (const { case: c, panels } of cases) {
    for (const panel of panels) {
      for (let rep = 1; rep <= reps; rep++) out.push({ key: panelRunKey(c.id, panel.id, rep), case: c, panel, rep });
    }
  }
  return out;
}

/** Keys already recorded (any status — an invalid run is data, not a retry). */
export function recordedPanelKeys(jsonl: string): Set<string> {
  const keys = new Set<string>();
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    try {
      const v = JSON.parse(line) as { key?: unknown; v?: unknown };
      if (typeof v.key === "string" && v.v === PANEL_RECORD_VERSION) keys.add(v.key);
    } catch {
      // torn last line of an interrupted run — the run is redone
    }
  }
  return keys;
}

/**
 * Copy {@link PANEL_SKILLS} from `realSkillsDir` into `<home>/.claude/skills`
 * (dereferenced; the source is only read) and point their prod URLs at the
 * dead port. Throws when a skill is missing — a run without the skill would
 * measure nothing.
 */
export function prepareSkillHome(home: string, realSkillsDir: string): { skills: string[]; rewrites: ReturnType<typeof rewriteSkillProdUrls> } {
  const skillsDir = join(home, ".claude", "skills");
  mkdirSync(skillsDir, { recursive: true, mode: 0o700 });
  for (const s of PANEL_SKILLS) {
    const src = join(realSkillsDir, s);
    if (!existsSync(src)) throw new Error(`council-panel: skill ${s} missing in ${realSkillsDir}`);
    cpSync(src, join(skillsDir, s), { recursive: true, dereference: true });
  }
  const rewrites = rewriteSkillProdUrls(skillsDir, PANEL_DEAD_PORT);
  if (rewrites.remaining !== 0) throw new Error(`council-panel: ${rewrites.remaining} prod URL(s) left in the skill copy`);
  return { skills: readdirSync(skillsDir).sort(), rewrites };
}

/** The run's review directory: the newest `.council/review-output/<TS>/` with a FINAL-REVIEW.md
 *  (the sealed checkout starts with none — see PANEL_SCRUB_PATHS). */
export function findReviewDir(checkout: string): string | null {
  const root = join(checkout, ".council", "review-output");
  let names: string[];
  try {
    names = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return null;
  }
  const withFinal = names.filter((n) => existsSync(join(root, n, "FINAL-REVIEW.md"))).sort();
  return withFinal.length ? join(root, withFinal[withFinal.length - 1]!) : null;
}

export interface PanelRunDeps {
  exec: AsyncExec;
  spawn: Spawner;
  /** Main repo holding the case commits. */
  repo: string;
  /** Fresh absolute path for the sealed checkout (outside repo and bench root). */
  checkout: string;
  /** Per-run artifact directory (exists, empty). */
  artifactDir: string;
  /** The real `~/.claude/skills` (read only). */
  realSkillsDir: string;
  /** The real `~/.claude` (isolation reference). */
  realClaudeDir: string;
  /** Names in the real `~/.claude/skills` (all but PANEL_SKILLS must stay invisible). */
  userSkillNames: () => string[];
  /** Prod's current access token (never a refresh token). */
  claudeAccessToken: () => string;
  env: (extra: Record<string, string>) => Record<string, string>;
  /** Catalog advisor ids (seat attribution). */
  catalogIds: ReadonlySet<string>;
  gitId: readonly string[];
  timeoutMs: number;
  claudeBin?: string;
  claudeModel?: string;
  /** Skip `bun install` (tests). */
  skipInstall?: boolean;
  now?: () => number;
}

export type PanelRunOutcome = { kind: "record"; record: PanelRunRecord } | { kind: "limit"; limit: LimitHit };

const tail = (s: string, n = 500) => (s.length <= n ? s : s.slice(s.length - n));

export async function runPanelRun(run: PlannedPanelRun, d: PanelRunDeps): Promise<PanelRunOutcome> {
  const now = d.now ?? Date.now;
  const started = now();
  const confounds: string[] = [];
  const base: PanelRunRecord = {
    v: PANEL_RECORD_VERSION,
    key: run.key,
    case_id: run.case.id,
    pr: run.case.pr,
    panel: run.panel.id,
    rep: run.rep,
    seats: [...run.panel.seats],
    status: "harness_error",
    valid: false,
    started_at: new Date(started).toISOString(),
    finished_at: "",
    wall_ms: 0,
    prompt_sha256: null,
    sealed: null,
    dispatch: null,
    expert_files: { present: [], missing: [...run.panel.seats] },
    review_dir: null,
    score: null,
    metrics: emptyMetrics(),
    isolation: {},
    confounds,
  };
  const finish = (patch: Partial<PanelRunRecord>): PanelRunOutcome => {
    const end = now();
    return { kind: "record", record: { ...base, ...patch, finished_at: new Date(end).toISOString(), wall_ms: end - started } };
  };

  try {
    const wiped = await removeCheckout(d.exec, d.repo, d.checkout);
    if (wiped.code !== 0) return finish({ error: wiped.output.slice(-300) });
    const sealed = await sealedPanelCheckout(d.exec, d.repo, d.checkout, d.artifactDir, run.case, d.gitId);
    if (!sealed.ok) return finish({ error: sealed.error });
    base.sealed = sealed.checkout;

    if (!d.skipInstall) {
      const inst = await d.exec("bun", ["install", "--frozen-lockfile"], { cwd: join(d.checkout, "web"), timeoutMs: 15 * 60_000 });
      if (inst.code !== 0) confounds.push(`bun install failed in web/ — reviewers could not run tests (${tail(inst.output, 120)})`);
    }

    const home = join(d.artifactDir, "home");
    let skillHome: ReturnType<typeof prepareSkillHome>;
    try {
      skillHome = prepareSkillHome(home, d.realSkillsDir);
    } catch (e) {
      return finish({ error: (e as Error).message });
    }

    const prompt = buildPanelPrompt(run.case, run.panel, sealed.checkout.sealedBase);
    writeFileSync(join(d.artifactDir, "prompt.txt"), prompt);
    base.prompt_sha256 = createHash("sha256").update(prompt).digest("hex");

    const claudeDir = join(home, ".claude");
    const r = await d.spawn(d.claudeBin ?? "claude", claudeNakedArgs(prompt, d.claudeModel), {
      cwd: d.checkout,
      timeoutMs: d.timeoutMs,
      env: d.env({ HOME: home, CLAUDE_CONFIG_DIR: claudeDir, [CLAUDE_TOKEN_ENV]: d.claudeAccessToken() }),
      stdoutFile: join(d.artifactDir, "agent.jsonl"),
      stderrFile: join(d.artifactDir, "agent.stderr"),
    });
    const s = summarizeClaudeStream(r.stdout);
    if (!r.timedOut && !(s.finishedOk && r.code === 0)) {
      const limit = detectLimit(`${s.resultText}\n${tail(r.stderr, 2000)}`, now(), s.limitResult);
      if (limit) return { kind: "limit", limit };
    }

    // Isolation: the copied skills are expected; every OTHER user skill must stay invisible.
    const copied = new Set<string>(PANEL_SKILLS);
    const iso = checkNakedClaudeIsolation(s.init, {
      userSkillNames: d.userSkillNames().filter((n) => !copied.has(n)),
      realClaudeDir: d.realClaudeDir,
      hookEvents: s.hookEvents,
      cwd: d.checkout,
    });
    const initSkills = Array.isArray(s.init?.skills) ? (s.init!.skills as unknown[]) : [];
    const violations = [...iso.violations];
    if (s.init && !initSkills.includes(PANEL_SKILL)) violations.push(`skill ${PANEL_SKILL} not loaded (init frame)`);
    const copies = claudeCredentialCopyEvidence([claudeDir, home]).credential_copies;
    violations.push(...copies.map((c) => `Claude credentials file in the run home: ${c}`));
    const isolation = {
      isolated: violations.length === 0,
      violations,
      ...iso.evidence,
      skill_copy: { skills: skillHome.skills, url_rewrites: skillHome.rewrites, dead_port: PANEL_DEAD_PORT },
      claude_auth: `${CLAUDE_TOKEN_ENV} access token only (no refresh token)`,
      credential_copies: copies,
    };

    const dc = checkDispatch(r.stdout, run.panel.seats, d.catalogIds);
    const dispatch = { ...dc, total: dc.dispatches.length };

    const reviewSrc = findReviewDir(d.checkout);
    let review_dir: string | null = null;
    let score: RunScore | null = null;
    const expert_files = { present: [] as string[], missing: [] as string[] };
    if (reviewSrc) {
      review_dir = "review";
      cpSync(reviewSrc, join(d.artifactDir, review_dir), { recursive: true });
      for (const seat of run.panel.seats) (existsSync(join(reviewSrc, `${seat}.md`)) ? expert_files.present : expert_files.missing).push(seat);
      score = scoreReview(run.case, parseFinalReview(readFileSync(join(reviewSrc, "FINAL-REVIEW.md"), "utf8")));
    } else {
      expert_files.missing.push(...run.panel.seats);
    }

    const status: PanelRunStatus = r.timedOut
      ? "timeout"
      : !(s.finishedOk && r.code === 0)
        ? "agent_error"
        : !reviewSrc
          ? "no_review"
          : !dc.valid
            ? "invalid_roster"
            : !isolation.isolated
              ? "invalid_isolation"
              : "completed";
    return finish({
      status,
      valid: status === "completed",
      metrics: s.metrics,
      isolation,
      dispatch,
      expert_files,
      review_dir,
      score,
      ...(status === "agent_error" ? { error: tail(s.resultText || r.stderr || `exit ${r.code}`) } : {}),
    });
  } finally {
    await removeCheckout(d.exec, d.repo, d.checkout);
  }
}

export interface PanelBenchDeps {
  plan: readonly PlannedPanelRun[];
  readResults: () => string;
  appendResult: (rec: PanelRunRecord) => void;
  runOne: (run: PlannedPanelRun) => Promise<PanelRunOutcome>;
  /** Subscription usage + Claude token gate, asked before every start (retries included). */
  usageGate: (run: PlannedPanelRun) => Promise<UsageGate>;
  memAvailableKb: () => number;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  log: (line: string) => void;
  onProgress?: (p: { done: number; total: number }) => void;
  fatalConfirmations?: number;
  fatalRecheckMs?: number;
  maxLimitRetries?: number;
  /** Stop after this many newly recorded runs (smoke). */
  maxRuns?: number;
}

export interface PanelBenchSummary {
  total: number;
  done: number;
  recorded: number;
  usageHolds: number;
  limitPauses: number;
  stoppedOnLimit: LimitHit | null;
  stoppedOnAuth: string | null;
}

/**
 * Run every planned, not yet recorded run, one at a time. Same gate rules as
 * the D2 driver (`runAblation`): usage ceiling holds re-check every 15 min, a
 * fatal gate (prod auth dead) is re-confirmed and then STOPS the loop, low
 * memory waits, a usage limit sleeps until the reset and retries the SAME run.
 */
export async function runPanelBench(d: PanelBenchDeps): Promise<PanelBenchSummary> {
  const done = recordedPanelKeys(d.readResults());
  const planned = new Set(d.plan.map((r) => r.key));
  let doneCount = [...done].filter((k) => planned.has(k)).length;
  const summary: PanelBenchSummary = { total: d.plan.length, done: doneCount, recorded: 0, usageHolds: 0, limitPauses: 0, stoppedOnLimit: null, stoppedOnAuth: null };
  const confirmations = d.fatalConfirmations ?? 3;
  d.onProgress?.({ done: doneCount, total: d.plan.length });
  d.log(`[council-panel] ${doneCount}/${d.plan.length} runs already recorded`);

  for (const run of d.plan) {
    if (done.has(run.key)) continue;
    if (d.maxRuns !== undefined && summary.recorded >= d.maxRuns) break;
    let retries = 0;
    for (;;) {
      let fatalSeen = 0;
      for (let g = await d.usageGate(run); !g.ok; g = await d.usageGate(run)) {
        if (g.fatal) {
          if (++fatalSeen >= confirmations) {
            summary.stoppedOnAuth = g.reason;
            d.log(`[council-panel] STOP: ${g.reason} (confirmed ${fatalSeen}x) — rerun resumes at ${run.key}`);
            return summary;
          }
          await d.sleep(d.fatalRecheckMs ?? 60_000);
          continue;
        }
        fatalSeen = 0;
        summary.usageHolds++;
        d.log(formatUsageHold(g));
        await d.sleep(USAGE_HOLD_POLL_MS);
      }
      while (d.memAvailableKb() < MIN_AVAILABLE_KB) {
        d.log("[council-panel] MemAvailable < 1.5 GB — waiting 30s");
        await d.sleep(30_000);
      }
      const out = await d.runOne(run);
      if (out.kind === "record") {
        d.appendResult(out.record);
        done.add(run.key);
        summary.done = ++doneCount;
        summary.recorded++;
        d.onProgress?.({ done: doneCount, total: d.plan.length });
        const sc = out.record.score;
        d.log(
          `[council-panel] ${run.key} ${out.record.status} recall ${sc ? `${sc.recall.found}/${sc.recall.total}` : "-"} ` +
            `(${Math.round(out.record.wall_ms / 1000)}s, $${out.record.metrics.cost_usd ?? "?"}) ${doneCount}/${d.plan.length}`,
        );
        break;
      }
      summary.limitPauses++;
      if (++retries > (d.maxLimitRetries ?? 50)) {
        summary.stoppedOnLimit = out.limit;
        d.log(`[council-panel] ${run.key}: limit retries exhausted — stopping (rerun resumes here)`);
        return summary;
      }
      const ms = limitSleepMs(out.limit, d.now());
      d.log(`[council-panel] ${run.key}: usage limit — sleeping ${Math.round(ms / 60_000)} min`);
      await d.sleep(ms);
    }
  }
  return summary;
}
