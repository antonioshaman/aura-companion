/**
 * The live COUNCIL-PANEL-BENCH run and loop, without an LLM: the Chair is a
 * scripted fake spawn that writes a review into the checkout and prints a
 * stream-json transcript. git, tar and the filesystem are REAL (temp dir), so
 * the sealed checkout, the skill copy and the artifact copy are exercised for
 * real.
 *
 * Validates (runPanelRun):
 *   - happy path: sealed checkout, prompt names the SEALED base, Claude gets
 *     HOME + CLAUDE_CONFIG_DIR = the run home and ONLY an access token, the
 *     skill copy has no prod URL left while the real skills are untouched, the
 *     review is copied into the artifacts and scored, cost/turns recorded, the
 *     checkout is removed;
 *   - status precedence: a wrong roster → invalid_roster; another user skill
 *     visible → invalid_isolation; no FINAL-REVIEW → no_review; a missing skill
 *     source → harness_error — each recorded with valid=false;
 *   - a usage limit yields NO record (the loop retries) and still removes the checkout.
 * Validates (runPanelBench / plan / keys):
 *   - recorded keys are skipped (any status), a torn last line is redone;
 *   - a limit retries the SAME run after sleeping; a fatal gate stops after
 *     3 confirmations; a usage hold re-checks;
 *   - plan order is case → panel → rep; reps must be a positive integer.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpawnOptions, SpawnResult } from "../harness/proc.js";
import type { PanelCase } from "./cases.js";
import type { Panel } from "./panels.js";
import {
  PANEL_RECORD_VERSION,
  planPanelRuns,
  prepareSkillHome,
  recordedPanelKeys,
  runPanelBench,
  runPanelRun,
  type PanelRunDeps,
  type PanelRunOutcome,
  type PanelRunRecord,
  type PlannedPanelRun,
} from "./run.js";
import { git, makeCaseRepo, realExec, TEST_GIT_ID } from "./test-fixtures.js";

let root: string;
let fx: ReturnType<typeof makeCaseRepo>;
let realSkills: string;

const CASE = (): PanelCase => ({
  id: "case-x",
  pr: 7,
  base: `${fx.head}^`,
  head: fx.head,
  title: "Make a configurable",
  changedDomains: ["backend-architecture"],
  evidence: "test",
  knownDefects: [
    {
      id: "d1",
      kind: "defect",
      severity: "P1",
      summary: "racy constant",
      fixedBy: [fx.fix],
      locations: [{ file: "web/server/a.ts", lines: [1, 1] }],
      keywords: ["racy"],
    },
  ],
});
const PANEL: Panel = { id: "MINIMAL", seats: ["dahl", "hunt"] };

const REVIEW = `# Council Review

## P1 — Fix Now

### 1. Racy constant

| | |
|---|---|
| **File** | \`web/server/a.ts:1\` |

**Finding:** the constant is racy.
`;

const seatPrompt = (seat: string) =>
  `Read ~/.claude/skills/_council-experts/${seat}/review-aura.md; write .council/review-output/2026-09-30-0000/${seat}.md`;

interface Script {
  seats?: string[];
  initSkills?: string[];
  writeReview?: boolean;
  limit?: boolean;
}

function fakeChair(script: Script, calls: { args: string[]; o: SpawnOptions }[]) {
  return async (_cmd: string, args: string[], o: SpawnOptions): Promise<SpawnResult> => {
    calls.push({ args, o });
    if (script.limit) {
      const stdout = JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, api_error_status: 429, result: "limit" });
      return { code: 1, output: stdout, stdout, stderr: "", timedOut: false };
    }
    const seats = script.seats ?? ["dahl", "hunt"];
    if (script.writeReview !== false) {
      const dir = join(o.cwd, ".council", "review-output", "2026-09-30-0000");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "FINAL-REVIEW.md"), REVIEW);
      for (const s of seats) writeFileSync(join(dir, `${s}.md`), `${s} findings`);
    }
    const frames = [
      { type: "system", subtype: "init", model: "claude-opus-5-5", skills: script.initSkills ?? ["council-review-aura"], plugins: [], mcp_servers: [] },
      ...seats.map((s, i) => ({
        type: "assistant",
        parent_tool_use_id: null,
        message: { content: [{ type: "tool_use", id: `t${i}`, name: "Agent", input: { description: s, prompt: seatPrompt(s) } }] },
      })),
      { type: "result", subtype: "success", is_error: false, result: "done", num_turns: 9, total_cost_usd: 2.5, usage: { input_tokens: 10, output_tokens: 20 } },
    ];
    const stdout = frames.map((f) => JSON.stringify(f)).join("\n");
    return { code: 0, output: stdout, stdout, stderr: "", timedOut: false };
  };
}

function deps(name: string, script: Script, calls: { args: string[]; o: SpawnOptions }[], over: Partial<PanelRunDeps> = {}): PanelRunDeps {
  const artifactDir = join(root, "runs", name);
  mkdirSync(artifactDir, { recursive: true });
  return {
    exec: realExec,
    spawn: fakeChair(script, calls),
    repo: fx.repo,
    checkout: join(root, "wt", `c-${name}`),
    artifactDir,
    realSkillsDir: realSkills,
    realClaudeDir: join(root, "realhome", ".claude"),
    userSkillNames: () => ["council-review-aura", "_council-experts", "self-improvement"],
    claudeAccessToken: () => "ACCESS-ONLY",
    env: (extra) => ({ PATH: process.env.PATH ?? "", ...extra }),
    catalogIds: new Set(["dahl", "hunt", "fowler"]),
    gitId: TEST_GIT_ID,
    timeoutMs: 60_000,
    skipInstall: true,
    ...over,
  };
}

const RUN = (): PlannedPanelRun => ({ key: "case-x|MINIMAL|1", case: CASE(), panel: PANEL, rep: 1 });

async function record(out: PanelRunOutcome): Promise<PanelRunRecord> {
  expect(out.kind).toBe("record");
  if (out.kind !== "record") throw new Error("no record");
  return out.record;
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "panel-run-"));
  fx = makeCaseRepo(root);
  realSkills = join(root, "realhome", ".claude", "skills");
  for (const [p, body] of [
    ["council-review-aura/SKILL.md", "Probe `curl -fsS http://localhost:3456/api/sessions`.\n"],
    ["_council-experts/hunt/review-aura.md", "hunt\n"],
    ["_council-experts/dahl/review-aura.md", "dahl\n"],
    ["self-improvement/SKILL.md", "never visible\n"],
  ] as const) {
    mkdirSync(join(realSkills, p, ".."), { recursive: true });
    writeFileSync(join(realSkills, p), body);
  }
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("runPanelRun", () => {
  it("runs the Chair on a sealed checkout with a skill copy and an access token only, then scores the review", async () => {
    const calls: { args: string[]; o: SpawnOptions }[] = [];
    const d = deps("ok", {}, calls);
    const rec = await record(await runPanelRun(RUN(), d));

    expect(rec).toMatchObject({ v: PANEL_RECORD_VERSION, status: "completed", valid: true, case_id: "case-x", panel: "MINIMAL", seats: ["dahl", "hunt"] });
    // Prompt: names the sealed base (the only base the checkout knows), not the original sha.
    const prompt = readFileSync(join(d.artifactDir, "prompt.txt"), "utf8");
    expect(prompt).toContain(`git diff ${rec.sealed!.sealedBase}..HEAD`);
    expect(prompt).not.toContain(fx.base);
    expect(rec.prompt_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(calls[0]!.args).toContain(prompt);

    // Auth + HOME: the run home, an access token, no refresh token anywhere.
    const env = calls[0]!.o.env!;
    const home = join(d.artifactDir, "home");
    expect(env.HOME).toBe(home);
    expect(env.CLAUDE_CONFIG_DIR).toBe(join(home, ".claude"));
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("ACCESS-ONLY");
    expect(rec.isolation).toMatchObject({ isolated: true, credential_copies: [] });

    // Skill copy: only the two panel skills, prod URL rewritten; the real skills untouched.
    expect(existsSync(join(home, ".claude/skills/self-improvement"))).toBe(false);
    expect(readFileSync(join(home, ".claude/skills/council-review-aura/SKILL.md"), "utf8")).toContain("127.0.0.1:9/api/sessions");
    expect(readFileSync(join(realSkills, "council-review-aura/SKILL.md"), "utf8")).toContain("localhost:3456");

    // Roster, review copy, score, metrics.
    expect(rec.dispatch).toMatchObject({ valid: true, seated: ["dahl", "hunt"], total: 2 });
    expect(rec.expert_files).toEqual({ present: ["dahl", "hunt"], missing: [] });
    expect(readFileSync(join(d.artifactDir, "review", "FINAL-REVIEW.md"), "utf8")).toBe(REVIEW);
    expect(rec.score!.recall).toEqual({ found: 1, total: 1 });
    expect(rec.score!.recallAsP1).toEqual({ found: 1, total: 1 });
    expect(rec.metrics).toMatchObject({ cost_usd: 2.5, turns: 9 });
    expect(rec.sealed).toMatchObject({ base: fx.base, head: fx.head, scrubbed: { base: 4, head: 5 } });

    // The checkout never outlives the run.
    expect(existsSync(d.checkout)).toBe(false);
  });

  it("records a wrong roster as invalid_roster", async () => {
    const rec = await record(await runPanelRun(RUN(), deps("roster", { seats: ["hunt", "fowler"] }, [])));
    expect(rec).toMatchObject({ status: "invalid_roster", valid: false });
    expect(rec.dispatch).toMatchObject({ missing: ["dahl"], extra: ["fowler"] });
    // Still scored — the supervisor may want to look — but it does not count.
    expect(rec.score!.recall.found).toBe(1);
  });

  it("records another visible user skill as invalid_isolation", async () => {
    const rec = await record(await runPanelRun(RUN(), deps("iso", { initSkills: ["council-review-aura", "self-improvement"] }, [])));
    expect(rec).toMatchObject({ status: "invalid_isolation", valid: false });
    expect((rec.isolation.violations as string[]).join()).toMatch(/self-improvement/);
  });

  it("flags a run whose init frame lacks the skill", async () => {
    const rec = await record(await runPanelRun(RUN(), deps("noskill", { initSkills: [] }, [])));
    expect(rec.status).toBe("invalid_isolation");
    expect((rec.isolation.violations as string[]).join()).toMatch(/council-review-aura not loaded/);
  });

  it("records a run that wrote no FINAL-REVIEW as no_review", async () => {
    const rec = await record(await runPanelRun(RUN(), deps("noreview", { writeReview: false }, [])));
    expect(rec).toMatchObject({ status: "no_review", valid: false, review_dir: null, score: null });
    expect(rec.expert_files.missing).toEqual(["dahl", "hunt"]);
  });

  it("returns a limit (no record) and removes the checkout", async () => {
    const d = deps("limit", { limit: true }, []);
    const out = await runPanelRun(RUN(), d);
    expect(out.kind).toBe("limit");
    expect(existsSync(d.checkout)).toBe(false);
  });

  it("is a harness_error when a panel skill is missing from the real skills", async () => {
    const calls: { args: string[]; o: SpawnOptions }[] = [];
    const rec = await record(await runPanelRun(RUN(), deps("missing", {}, calls, { realSkillsDir: join(root, "nowhere") })));
    expect(rec).toMatchObject({ status: "harness_error", valid: false });
    expect(rec.error).toMatch(/skill council-review-aura missing/);
    expect(calls).toHaveLength(0);
  });
});

describe("prepareSkillHome", () => {
  it("copies only the panel skills and leaves no prod URL", () => {
    const home = join(root, "home-only");
    const r = prepareSkillHome(home, realSkills);
    expect(r.skills).toEqual(["_council-experts", "council-review-aura"]);
    expect(r.rewrites).toMatchObject({ replaced: 1, remaining: 0 });
  });
});

describe("plan and recorded keys", () => {
  it("orders runs case → panel → rep and rejects a bad reps count", () => {
    const c = { ...CASE(), id: "c1" };
    const plan = planPanelRuns([{ case: c, panels: [PANEL, { id: "FULL", seats: ["hunt"] }] }], 2);
    expect(plan.map((p) => p.key)).toEqual(["c1|MINIMAL|1", "c1|MINIMAL|2", "c1|FULL|1", "c1|FULL|2"]);
    expect(() => planPanelRuns([], 0)).toThrow(/positive integer/);
  });

  it("keeps recorded keys of any status and ignores a torn line or another record version", () => {
    const jsonl = [
      JSON.stringify({ v: PANEL_RECORD_VERSION, key: "a|FULL|1", status: "invalid_roster" }),
      JSON.stringify({ v: 99, key: "b|FULL|1" }),
      '{"v":1,"key":"c|FU',
    ].join("\n");
    expect([...recordedPanelKeys(jsonl)]).toEqual(["a|FULL|1"]);
  });
});

describe("runPanelBench", () => {
  const plan = (): PlannedPanelRun[] => planPanelRuns([{ case: { ...CASE(), id: "c1" }, panels: [PANEL, { id: "FULL", seats: ["hunt"] }] }], 1);
  const rec = (key: string): PanelRunRecord => ({ key, status: "completed", wall_ms: 1, metrics: { cost_usd: 1 }, score: null } as unknown as PanelRunRecord);
  const base = () => {
    const log: string[] = [];
    const sleeps: number[] = [];
    const appended: string[] = [];
    return {
      log,
      sleeps,
      appended,
      d: {
        plan: plan(),
        readResults: () => JSON.stringify({ v: PANEL_RECORD_VERSION, key: "c1|MINIMAL|1" }) + "\n",
        appendResult: (r: PanelRunRecord) => appended.push(r.key),
        usageGate: async () => ({ ok: true as const, sevenDay: 10, fiveHour: 10 }),
        memAvailableKb: () => 8 * 1024 * 1024,
        sleep: async (ms: number) => void sleeps.push(ms),
        now: () => 0,
        log: (l: string) => void log.push(l),
      },
    };
  };

  it("skips recorded runs and retries the same run after a limit", async () => {
    const b = base();
    const seen: string[] = [];
    let first = true;
    const s = await runPanelBench({
      ...b.d,
      runOne: async (run) => {
        seen.push(run.key);
        if (first) {
          first = false;
          return { kind: "limit", limit: { resetAt: null, message: "limit" } };
        }
        return { kind: "record", record: rec(run.key) };
      },
    });
    expect(seen).toEqual(["c1|FULL|1", "c1|FULL|1"]);
    expect(b.appended).toEqual(["c1|FULL|1"]);
    expect(b.sleeps).toEqual([20 * 60_000]);
    expect(s).toMatchObject({ total: 2, done: 2, recorded: 1, limitPauses: 1, stoppedOnAuth: null });
  });

  it("holds on a usage ceiling, then stops on a confirmed fatal gate without running", async () => {
    const b = base();
    const gates = [
      { ok: false as const, reason: "seven_day 80% >= ceiling 75%", sevenDay: 80, fiveHour: 1, resetsAt: null },
      ...Array.from({ length: 3 }, () => ({ ok: false as const, fatal: true, reason: "prod OAuth dead", sevenDay: null, fiveHour: null, resetsAt: null })),
    ];
    let ran = 0;
    const s = await runPanelBench({
      ...b.d,
      usageGate: async () => gates.shift()!,
      runOne: async (run) => {
        ran++;
        return { kind: "record", record: rec(run.key) };
      },
    });
    expect(ran).toBe(0);
    expect(s).toMatchObject({ usageHolds: 1, stoppedOnAuth: "prod OAuth dead", recorded: 0 });
    expect(b.log.at(-1)).toMatch(/STOP: prod OAuth dead \(confirmed 3x\)/);
  });
});

// Sanity: the fixture repo really holds the later fix (so the leak guard above is meaningful).
it("fixture repo carries a fix commit after head", () => {
  expect(git(fx.repo, "rev-list", `${fx.head}..${fx.fix}`)).toBe(fx.fix);
});
