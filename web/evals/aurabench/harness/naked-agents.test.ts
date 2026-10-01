/**
 * Tests for the naked agent runners (variants A/B). The process spawner is a
 * scripted fake — no real `claude`/`codex` is started.
 *
 * Validates:
 *   - A runs with a FRESH, EMPTY per-cell CLAUDE_CONFIG_DIR — no credentials
 *     copy (P6/FIX-D2-CLAUDE-AUTH: a copied refresh token logged prod out) —
 *     authenticated by the bare access token in CLAUDE_CODE_OAUTH_TOKEN, and
 *     a credentials file found in the config dir afterwards is a violation;
 *     the isolating flags
 *     (`--strict-mcp-config`, `--include-hook-events`, no session persistence);
 *     the init-frame isolation verdict lands in the result;
 *   - B runs `codex exec --json --ignore-user-config` (NOT `--ephemeral`:
 *     P6/FIX-D2-4 — the rollout is the only place naming the model used) with a
 *     FRESH per-cell CODEX_HOME (P6/FIX-D2-1: pilot 1 let B write the real
 *     ~/.codex); the rotated-auth write-back runs even when the spawn throws;
 *     anything the isolated home still exposes is a confound AND a violation;
 *   - B's `models` is the model from the cell's rollout `turn_context`, and
 *     stays [] (unknown) without one — never the pinned `-m` (pilot 1 wrote
 *     `models: []` for every B cell);
 *   - exit states map to completed / timeout / agent_error, and a usage limit
 *     in the FINAL message becomes `limit` (not a failure).
 */

import { describe, it, expect } from "vitest";
import type { AuraBenchTask } from "../task.js";
import { VARIANTS } from "./variants.js";
import { claudeNakedArgs, codexConfounds, codexNakedArgs, nakedClaudeRunner, nakedCodexRunner, type NakedDeps } from "./naked-agents.js";
import type { SpawnOptions, SpawnResult } from "./proc.js";
import type { AgentContext } from "./run-cell.js";

const task = { id: "t1", prompt: "do the thing" } as AuraBenchTask;
const ctx = (variant: "A" | "B"): AgentContext => ({
  task,
  variant: VARIANTS[variant],
  worktree: "/wt/cell",
  timeoutMs: 1000,
  artifactDir: "/cells/t1/A-1",
});
const line = (o: unknown) => JSON.stringify(o);
const cleanInit = { type: "system", subtype: "init", model: "m", skills: ["simplify"], plugins: [], mcp_servers: [], memory_paths: {} };

function deps(result: Partial<SpawnResult>, extra: Partial<NakedDeps> = {}) {
  const spawned: { cmd: string; args: string[]; o: SpawnOptions }[] = [];
  const prepared: string[] = [];
  const d: NakedDeps = {
    spawn: async (cmd, args, o) => {
      spawned.push({ cmd, args, o });
      return { code: 0, output: "", stdout: "", stderr: "", timedOut: false, ...result };
    },
    env: (e) => ({ PATH: "/bin", ...e }),
    realClaudeDir: "/home/u/.claude",
    realCodexDir: "/home/u/.codex",
    userSkillNames: () => ["council-review-aura"],
    prepareClaudeConfig: (dir) => prepared.push(dir),
    claudeAccessToken: () => "at-live",
    credentialCopies: () => [],
    present: () => false,
    now: () => 0,
    // Codex-home fs work is proven against real files in codex-home.test.ts;
    // here it is stubbed so no test mkdirs the fake /cells paths.
    prepareCodexHome: () => ({}),
    finishCodexHome: () => "unchanged",
    authSha: () => null,
    ...extra,
  };
  return { d, spawned, prepared };
}

describe("naked Claude (A)", () => {
  it("uses a fresh empty per-cell config dir, the access token env and isolating flags", async () => {
    const stdout = [line(cleanInit), line({ type: "result", subtype: "success", is_error: false, num_turns: 2, total_cost_usd: 0.5, usage: {} })].join("\n");
    const { d, spawned, prepared } = deps({ stdout });
    const r = await nakedClaudeRunner(d)(ctx("A"));
    expect(prepared).toEqual(["/cells/t1/A-1/claude-config"]);
    // Only an access token reaches the CLI — nothing it could refresh prod's login with.
    expect(spawned[0]!.o.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe("at-live");
    expect(spawned[0]!.cmd).toBe("claude");
    expect(spawned[0]!.o.env?.CLAUDE_CONFIG_DIR).toBe("/cells/t1/A-1/claude-config");
    expect(spawned[0]!.o.cwd).toBe("/wt/cell");
    expect(spawned[0]!.args).toEqual(claudeNakedArgs("do the thing"));
    for (const f of ["--strict-mcp-config", "--include-hook-events", "--no-session-persistence"]) expect(spawned[0]!.args).toContain(f);
    expect(r).toMatchObject({ kind: "done", status: "completed", isolation: { isolated: true, credential_copies: [] } });
  });

  it("flags a credentials file that appears in the cell config dir", async () => {
    const stdout = [line(cleanInit), line({ type: "result", subtype: "success", is_error: false })].join("\n");
    const r = await nakedClaudeRunner(deps({ stdout }, { credentialCopies: (dirs) => dirs.map((d) => `${d}/.credentials.json`) }).d)(ctx("A"));
    if (r.kind !== "done") throw new Error("expected done");
    expect(r.isolation.isolated).toBe(false);
    expect(r.isolation.violations).toEqual(["Claude credentials file in the cell config: /cells/t1/A-1/claude-config/.credentials.json"]);
  });

  it("does not start the agent without a prod access token", async () => {
    const { d, spawned } = deps({}, { claudeAccessToken: () => { throw new Error("no prod Claude access token"); } });
    await expect(nakedClaudeRunner(d)(ctx("A"))).rejects.toThrow("no prod Claude access token");
    expect(spawned).toHaveLength(0);
  });

  it("records an isolation violation instead of hiding it", async () => {
    const stdout = [line({ ...cleanInit, skills: ["council-review-aura"] }), line({ type: "result", subtype: "success", is_error: false })].join("\n");
    const r = await nakedClaudeRunner(deps({ stdout }).d)(ctx("A"));
    expect(r).toMatchObject({ kind: "done", isolation: { isolated: false } });
  });

  // Pilot regression: the runner must hand the checker the repo's project
  // skills and the cell cwd, or a linked-worktree leak goes unnoticed.
  it("checks Aura project skills and the memory project key against the cell cwd", async () => {
    const init = { ...cleanInit, skills: ["simplify", "polish"], memory_paths: { auto: "/cells/t1/A-1/claude-config/projects/-repo/memory/" } };
    const stdout = [line(init), line({ type: "result", subtype: "success", is_error: false })].join("\n");
    const r = await nakedClaudeRunner(deps({ stdout }, { projectSkillNames: () => ["polish"] }).d)(ctx("A"));
    if (r.kind !== "done") throw new Error("expected done");
    expect(r.isolation.isolated).toBe(false);
    expect(r.isolation.violations).toEqual([
      "Aura project skills visible: polish",
      expect.stringContaining("expected /projects/-wt-cell/"),
    ]);
  });

  it("maps timeout, limit and plain errors", async () => {
    expect(await nakedClaudeRunner(deps({ timedOut: true, code: 143 }).d)(ctx("A"))).toMatchObject({ kind: "done", status: "timeout" });
    const limited = line({ type: "result", subtype: "error_during_execution", is_error: true, result: "Claude AI usage limit reached|1000000600" });
    expect(await nakedClaudeRunner(deps({ stdout: limited, code: 1 }).d)(ctx("A"))).toMatchObject({ kind: "limit", limit: { resetAt: 1_000_000_600_000 } });
    // P6/FIX-D2-LIMIT: the real pilot-2 frame (subtype "success" + is_error +
    // api_error_status 429) was recorded as agent_error; it must pause instead.
    const session = line({ type: "result", subtype: "success", is_error: true, api_error_status: 429, terminal_reason: "api_error", num_turns: 1, total_cost_usd: 0, duration_ms: 620, result: "You've hit your session limit · resets 12:10am (UTC)" });
    const at2313 = Date.UTC(2026, 8, 28, 23, 13, 34);
    expect(await nakedClaudeRunner(deps({ stdout: session, code: 1 }, { now: () => at2313 }).d)(ctx("A"))).toMatchObject({
      kind: "limit",
      limit: { resetAt: Date.UTC(2026, 8, 29, 0, 10) },
    });
    // 429 with wording no regex knows is still a limit (structural evidence).
    const novel = line({ type: "result", subtype: "success", is_error: true, api_error_status: 429, result: "Slow down, friend" });
    expect(await nakedClaudeRunner(deps({ stdout: novel, code: 1 }).d)(ctx("A"))).toMatchObject({ kind: "limit" });
    const broken = line({ type: "result", subtype: "error_during_execution", is_error: true, result: "boom" });
    expect(await nakedClaudeRunner(deps({ stdout: broken, code: 1 }).d)(ctx("A"))).toMatchObject({ kind: "done", status: "agent_error", error: "boom" });
  });
});

describe("model pinning", () => {
  it("passes the pinned model to both CLIs (same model in every variant of a provider)", async () => {
    expect(claudeNakedArgs("p", "claude-opus-5-5").slice(0, 2)).toEqual(["--model", "claude-opus-5-5"]);
    expect(codexNakedArgs("p", "/wt", "gpt-5.4").slice(0, 3)).toEqual(["exec", "-m", "gpt-5.4"]);
    const { d, spawned } = deps({ stdout: "" }, { claudeModel: "claude-opus-5-5" });
    await nakedClaudeRunner(d)(ctx("A"));
    expect(spawned[0]!.args).toEqual(expect.arrayContaining(["--model", "claude-opus-5-5"]));
  });
});

describe("naked Codex (B)", () => {
  it("runs codex exec in a fresh per-cell CODEX_HOME and writes auth back after", async () => {
    const stdout = line({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 2 } });
    const calls: string[] = [];
    const { d, spawned } = deps(
      { stdout },
      {
        authSha: () => "sha0",
        prepareCodexHome: (home, real) => (calls.push(`prepare ${home} ${real}`), { codex_home: home, seeded: ["auth.json"] }),
        // FIX-D2-1b: registered for write-back WHILE the cell runs, before the spawn.
        watchCodexHome: (home, sha) => calls.push(`watch ${home} ${sha}`),
        finishCodexHome: (home, real, sha) => (calls.push(`finish ${home} ${real} ${sha}`), "unchanged"),
      },
    );
    const r = await nakedCodexRunner(d)(ctx("B"));
    expect(spawned[0]!.cmd).toBe("codex");
    expect(spawned[0]!.args).toEqual(codexNakedArgs("do the thing", "/wt/cell"));
    expect(spawned[0]!.args).toEqual(expect.arrayContaining(["--json", "--ignore-user-config"]));
    // The rollout must persist (in the cell home) — it is the model's only source.
    expect(spawned[0]!.args).not.toContain("--ephemeral");
    // The cell's own home, never the real ~/.codex.
    expect(spawned[0]!.o.env?.CODEX_HOME).toBe("/cells/t1/A-1/codex-home");
    expect(calls).toEqual([
      "prepare /cells/t1/A-1/codex-home /home/u/.codex",
      "watch /cells/t1/A-1/codex-home sha0",
      "finish /cells/t1/A-1/codex-home /home/u/.codex sha0",
    ]);
    expect(r).toMatchObject({ kind: "done", status: "completed", confounds: [], isolation: { isolated: true, auth: "unchanged" } });
  });

  it("reports anything the isolated home still exposes as a confound and a violation", async () => {
    const stdout = line({ type: "turn.completed", usage: {} });
    const { d } = deps(
      { stdout },
      {
        prepareCodexHome: () => ({}),
        finishCodexHome: () => "unchanged",
        authSha: () => null,
        present: (p) => p === "/cells/t1/A-1/codex-home/AGENTS.md",
      },
    );
    const r = await nakedCodexRunner(d)(ctx("B"));
    if (r.kind !== "done") throw new Error("expected done");
    expect(r.confounds).toEqual(["CODEX_HOME/AGENTS.md (global instructions)"]);
    expect(r.isolation).toMatchObject({ isolated: false, violations: ["visible to the agent: CODEX_HOME/AGENTS.md (global instructions)"] });
  });

  // A crashed spawn must still remove the cell's auth copy / write back a rotated token.
  it("runs the auth write-back even when the spawn throws", async () => {
    const finished: string[] = [];
    const { d } = deps({}, {
      spawn: async () => {
        throw new Error("spawn EACCES");
      },
      prepareCodexHome: () => ({}),
      finishCodexHome: (home) => (finished.push(home), "unchanged"),
      authSha: () => null,
    });
    await expect(nakedCodexRunner(d)(ctx("B"))).rejects.toThrow("spawn EACCES");
    expect(finished).toEqual(["/cells/t1/A-1/codex-home"]);
  });

  it("a usage-limit turn failure is a limit, not a result", async () => {
    const stdout = line({ type: "turn.failed", error: { message: "You've hit your usage limit. Try again in 3 hours." } });
    expect(await nakedCodexRunner(deps({ stdout, code: 1 }).d)(ctx("B"))).toMatchObject({ kind: "limit", limit: { resetAt: 3 * 3_600_000 } });
  });

  // P6/FIX-CODEX-QUOTA: the real ChatGPT-plan refusal (BENCH-H, 2026-10-01).
  // The limit is tagged provider "codex" so the driver pauses only the Codex
  // cells, and the absolute "try again at" date becomes the reset time.
  it("the real Codex weekly refusal → codex limit with the absolute reset", async () => {
    const msg =
      "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Oct 4th, 2026 11:56 PM.";
    const stdout = line({ type: "turn.failed", error: { message: msg } });
    expect(await nakedCodexRunner(deps({ stdout, code: 1 }).d)(ctx("B"))).toMatchObject({
      kind: "limit",
      limit: { provider: "codex", resetAt: Date.UTC(2026, 9, 4, 23, 56) },
    });
  });

  // P6/FIX-D2-4: `codex exec --json` never names the model; it is read from
  // the rollout the run left in the CELL's CODEX_HOME.
  it("records the model the rollout says ran, not the pinned one", async () => {
    const stdout = line({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 2 } });
    const read: string[] = [];
    const rollout = [
      line({ type: "session_meta", payload: { id: "x", model_provider: "openai" } }),
      line({ type: "turn_context", payload: { turn_id: "t1", model: "gpt-5.5" } }),
      line({ type: "turn_context", payload: { turn_id: "t2", model: "gpt-5.5" } }),
    ].join("\n");
    const { d } = deps(
      { stdout },
      {
        codexModel: "gpt-5.4",
        prepareCodexHome: () => ({}),
        finishCodexHome: () => "unchanged",
        authSha: () => null,
        readRollouts: (home) => (read.push(home), [rollout]),
      },
    );
    const r = await nakedCodexRunner(d)(ctx("B"));
    if (r.kind !== "done") throw new Error("expected done");
    expect(read).toEqual(["/cells/t1/A-1/codex-home"]);
    expect(r.metrics.models).toEqual(["gpt-5.5"]);
    expect(r.isolation).toMatchObject({ model_source: "rollout turn_context" });
  });

  it("leaves models unknown ([]) without a rollout model — never back-fills the pinned one", async () => {
    const stdout = line({ type: "turn.completed", usage: {} });
    for (const readRollouts of [() => [], () => { throw new Error("EACCES"); }]) {
      const { d } = deps(
        { stdout },
        { codexModel: "gpt-5.4", prepareCodexHome: () => ({}), finishCodexHome: () => "unchanged", authSha: () => null, readRollouts },
      );
      const r = await nakedCodexRunner(d)(ctx("B"));
      if (r.kind !== "done") throw new Error("expected done");
      expect(r.metrics.models).toEqual([]);
      expect(r.isolation).toMatchObject({ model_source: "unknown (no rollout model)" });
    }
  });

  it("codexConfounds is empty when the home injects nothing", () => {
    expect(codexConfounds("/h/.codex", () => false)).toEqual([]);
  });
});
