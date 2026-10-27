import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  COUNCIL_BUDGET_ENV,
  CouncilBudgetTracker,
  DEFAULT_COUNCIL_MAX_TOKENS_PER_GROUP,
  addTurnUsage,
  budgetedTokens,
  emptyRoleUsage,
  readGroupBudget,
  resolveCouncilBudgetLimit,
} from "./council-budget.js";

// Council budget guard: per-pair token accounting for Claude + Codex council
// halves and the "exceeded" switch that pauses automatic activity. These
// tests pin the accounting unit (cache reads excluded), the exactly-once
// crossing event, Continue semantics and the `.council/state/` persistence
// that keeps a restart from handing a looping pair a fresh budget.

const GROUP = "grp_0123456789abcdef0123456789abcdef";
const ORCH = "sess-orch";
const OBS = "sess-obs";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function workspace(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "council-budget-")));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function tracker(opts: { limit: number; cwd?: string; now?: () => number; errors?: string[] }) {
  return new CouncilBudgetTracker({
    defaultLimit: opts.limit,
    cwdFor: () => opts.cwd,
    now: opts.now ?? (() => 1_000),
    onPersistError: (_g, op, reason) => opts.errors?.push(`${op}:${reason}`),
  });
}

describe("resolveCouncilBudgetLimit", () => {
  // Unset → the documented default; 0 → disabled; garbage fails toward
  // guarding (the default) with a warning instead of silently disabling.
  it("defaults, disables on 0, accepts underscores, warns on garbage", () => {
    expect(resolveCouncilBudgetLimit({})).toEqual({ limit: DEFAULT_COUNCIL_MAX_TOKENS_PER_GROUP });
    expect(resolveCouncilBudgetLimit({ [COUNCIL_BUDGET_ENV]: "  " })).toEqual({ limit: DEFAULT_COUNCIL_MAX_TOKENS_PER_GROUP });
    expect(resolveCouncilBudgetLimit({ [COUNCIL_BUDGET_ENV]: "0" })).toEqual({ limit: 0 });
    expect(resolveCouncilBudgetLimit({ [COUNCIL_BUDGET_ENV]: "5_000_000" })).toEqual({ limit: 5_000_000 });
    for (const bad of ["-1", "1.5", "lots", "1e6"]) {
      const r = resolveCouncilBudgetLimit({ [COUNCIL_BUDGET_ENV]: bad });
      expect(r.limit).toBe(DEFAULT_COUNCIL_MAX_TOKENS_PER_GROUP);
      expect(r.warning).toContain(COUNCIL_BUDGET_ENV);
    }
  });
});

describe("addTurnUsage / budgetedTokens", () => {
  // Cache reads dominate long sessions (95–99 % of prompt tokens) and are
  // cheap, so they are tracked but excluded from the budgeted figure.
  it("tracks cache reads but does not budget them", () => {
    const u = addTurnUsage(emptyRoleUsage(), {
      input_tokens: 10,
      output_tokens: 200,
      cache_creation_input_tokens: 3_000,
      cache_read_input_tokens: 900_000,
    });
    expect(u).toEqual({ inputTokens: 10, outputTokens: 200, cacheCreationTokens: 3_000, cacheReadTokens: 900_000, turns: 1 });
    expect(budgetedTokens(u)).toBe(3_210);
  });

  // Synthesized zero-usage frames (interrupt, resume bookkeeping, a Codex
  // turn with no usage notification) are not turns; junk values are ignored.
  it("ignores zero-usage frames and non-numeric values", () => {
    const u = addTurnUsage(emptyRoleUsage(), { input_tokens: 0, output_tokens: 0 });
    expect(u.turns).toBe(0);
    const junk = addTurnUsage(emptyRoleUsage(), { input_tokens: Number.NaN, output_tokens: -5 } as never);
    expect(budgetedTokens(junk)).toBe(0);
    expect(junk.turns).toBe(0);
  });
});

describe("CouncilBudgetTracker", () => {
  // Both halves add up; the crossing event fires exactly once, on the turn
  // that crosses, carrying the half (session + role) that crossed it.
  it("sums both halves and reports the crossing exactly once", () => {
    const t = tracker({ limit: 1_000 });
    expect(t.recordTurn(GROUP, ORCH, "orchestrator", { input_tokens: 400, output_tokens: 100 })).toBeNull();
    expect(t.isExceeded(GROUP)).toBe(false);
    const ev = t.recordTurn(GROUP, OBS, "observer", { input_tokens: 300, output_tokens: 250, cache_read_input_tokens: 10_000_000 });
    expect(ev).not.toBeNull();
    expect(ev).toMatchObject({ sessionGroupId: GROUP, sessionId: OBS, role: "observer" });
    expect(ev!.budget).toMatchObject({ spentTokens: 1_050, limitTokens: 1_000, exceeded: true, exceededAt: 1_000, limitSource: "env" });
    expect(t.isExceeded(GROUP)).toBe(true);
    // Further turns keep accounting but never re-fire.
    expect(t.recordTurn(GROUP, ORCH, "orchestrator", { output_tokens: 50 })).toBeNull();
    expect(t.snapshot(GROUP).byRole.orchestrator.turns).toBe(2);
  });

  // A huge cache-read-only turn (the dominant Claude pattern) never trips it.
  it("cache reads alone never exceed the budget", () => {
    const t = tracker({ limit: 1_000 });
    for (let i = 0; i < 10; i++) {
      t.recordTurn(GROUP, ORCH, "orchestrator", { input_tokens: 1, cache_read_input_tokens: 5_000_000 });
    }
    expect(t.isExceeded(GROUP)).toBe(false);
    expect(t.snapshot(GROUP).spentTokens).toBe(10);
  });

  // 0 = the guard is off (env or per pair): accounting continues, never trips.
  it("limit 0 disables the guard", () => {
    const t = tracker({ limit: 0 });
    t.recordTurn(GROUP, ORCH, "orchestrator", { output_tokens: 1e9 });
    expect(t.isExceeded(GROUP)).toBe(false);
    expect(t.snapshot(GROUP).spentTokens).toBe(1e9);
  });

  // Continue restarts the spend window (lifetime totals kept) and may set a
  // pair-specific limit; invalid limits are rejected without side effects.
  it("continue restarts the window, keeps lifetime totals, sets a pair limit", () => {
    const t = tracker({ limit: 100 });
    t.recordTurn(GROUP, ORCH, "orchestrator", { output_tokens: 150 });
    expect(t.isExceeded(GROUP)).toBe(true);
    expect(t.continue(GROUP, { limitTokens: -1 })).toEqual({ ok: false, reason: "invalid_input" });
    expect(t.isExceeded(GROUP)).toBe(true);

    const res = t.continue(GROUP);
    expect(res).toMatchObject({ ok: true, wasExceeded: true });
    expect(t.isExceeded(GROUP)).toBe(false);
    const snap = t.snapshot(GROUP);
    expect(snap.spentTokens).toBe(0);
    expect(snap.byRole.orchestrator.outputTokens).toBe(150);
    expect(snap.exceededAt).toBeUndefined();

    // Raised limit for this pair only.
    const raised = t.continue(GROUP, { limitTokens: 500 });
    expect(raised.ok && raised.budget).toMatchObject({ limitTokens: 500, limitSource: "group" });
    t.recordTurn(GROUP, OBS, "observer", { output_tokens: 400 });
    expect(t.isExceeded(GROUP)).toBe(false);
    expect(t.recordTurn(GROUP, OBS, "observer", { output_tokens: 100 })).not.toBeNull();
  });

  // Restart safety: state is written to `.council/state/<group>-budget.json`
  // and a fresh tracker (new server process) still sees the pair as paused.
  it("persists to .council/state and survives a restart", () => {
    const cwd = workspace();
    const t1 = tracker({ limit: 100, cwd });
    t1.recordTurn(GROUP, ORCH, "orchestrator", { output_tokens: 120, cache_read_input_tokens: 7 });
    const file = join(cwd, ".council", "state", `${GROUP}-budget.json`);
    const onDisk = JSON.parse(readFileSync(file, "utf8"));
    expect(onDisk).toMatchObject({ schemaVersion: 1, sessionGroupId: GROUP, exceededAt: 1_000 });

    const t2 = tracker({ limit: 100, cwd });
    expect(t2.isExceeded(GROUP)).toBe(true);
    expect(t2.snapshot(GROUP).byRole.orchestrator).toMatchObject({ outputTokens: 120, cacheReadTokens: 7, turns: 1 });
    t2.continue(GROUP, { limitTokens: 0 });
    const t3 = tracker({ limit: 100, cwd });
    expect(t3.isExceeded(GROUP)).toBe(false);
    expect(t3.snapshot(GROUP)).toMatchObject({ limitTokens: 0, limitSource: "group" });
  });

  // Usage recorded before the pair's workspace is known (watcher not armed
  // yet) is merged on top of the persisted totals, not lost or doubled.
  it("merges in-memory usage with persisted totals once the workspace is known", () => {
    const cwd = workspace();
    tracker({ limit: 10_000, cwd }).recordTurn(GROUP, OBS, "observer", { output_tokens: 300 });
    let known: string | undefined;
    const t = new CouncilBudgetTracker({ defaultLimit: 10_000, cwdFor: () => known });
    t.recordTurn(GROUP, ORCH, "orchestrator", { output_tokens: 50 });
    known = cwd;
    expect(t.snapshot(GROUP).spentTokens).toBe(350);
    expect(t.snapshot(GROUP).spentTokens).toBe(350);
  });

  // A corrupt budget file is reported, never thrown; the pair starts from the
  // in-memory view (fails open only for history it cannot read).
  it("reports an unreadable budget file without throwing", () => {
    const cwd = workspace();
    mkdirSync(join(cwd, ".council", "state"), { recursive: true });
    writeFileSync(join(cwd, ".council", "state", `${GROUP}-budget.json`), "{not json");
    expect(readGroupBudget(cwd, GROUP)).toEqual({ ok: false, reason: "invalid-json" });
    const errors: string[] = [];
    const t = tracker({ limit: 100, cwd, errors });
    expect(t.isExceeded(GROUP)).toBe(false);
    expect(errors).toEqual(["read:invalid-json"]);
  });

  // forget() drops only memory; the file is the source after an unarchive.
  it("forget drops the in-memory copy but keeps the file", () => {
    const cwd = workspace();
    const t = tracker({ limit: 100, cwd });
    t.recordTurn(GROUP, ORCH, "orchestrator", { output_tokens: 150 });
    t.forget(GROUP);
    expect(t.isExceeded(GROUP)).toBe(true);
  });

  // An unknown group with no workspace is never "exceeded" and creates no state.
  it("an unknown group is not exceeded", () => {
    const t = tracker({ limit: 1 });
    expect(t.isExceeded("grp_ffffffffffffffffffffffffffffffff")).toBe(false);
  });
});
