/**
 * Tests for the Aura variant runner and its completion tracker (C–G). The
 * Companion instance is faked at its public boundary (REST + browser WS); no
 * server, CLI or LLM runs.
 *
 * Validates:
 *   - the create body carries the variant's per-session `layers`,
 *     bypassPermissions, and `councilMode`/`councilPairing` only for Council
 *     variants (auto-proceed only when that layer is on);
 *   - the prompt is sent only once the primary is `connected`, as a
 *     `user_message` on the primary's socket;
 *   - done = primary produced a result after the prompt, every session idle,
 *     and a quiet window elapsed — a running observer keeps the cell open;
 *     messages before the prompt (init probe) are ignored;
 *   - metrics sum across primary + observer (the observer is Aura's cost);
 *   - permission requests are auto-allowed; a limit result yields `limit`;
 *     the wall clock yields `timeout`; sessions are archived + deleted always;
 *   - FIX-D2-3: teardown never uses `POST /kill` (not an intentional kill
 *     server-side → keepalive relaunch into the deleted checkout); it
 *     archives every session (group-aware, marks the pair intentional) before
 *     any delete, then re-reads the list — `isolation.teardown.still_present`
 *     proves nothing survived;
 *   - FIX-D2-2: observer-loop variants (D, E) append the checkpoint → review
 *     directive with the pair's concrete orchestrator id, group id and the
 *     BENCH url (C's prompt is untouched); a council create without a group
 *     id fails the cell instead of silently measuring C under D's name; the
 *     pair's `.council/` traces become `isolation.layer_evidence`, scoped to
 *     the pair's group, so "D/E measured the observer / auto-proceed" is
 *     proven per cell, not assumed.
 */

import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuraBenchTask } from "../task.js";
import { VARIANTS, type AuraVariant } from "./variants.js";
import { AuraSessionTracker } from "./aura-session-tracker.js";
import {
  auraRunner,
  createBody,
  observerLoopDirective,
  quietWindowMs,
  readLayerEvidence,
  sessionIdsFromCreate,
  type AuraDeps,
} from "./aura-agent.js";

const result = (extra: object = {}) => ({
  type: "result",
  data: { subtype: "success", is_error: false, num_turns: 2, total_cost_usd: 1, usage: { input_tokens: 5, output_tokens: 7 }, ...extra },
});

describe("createBody / sessionIdsFromCreate / quietWindowMs", () => {
  it("solo knowledge variant: layers + bypass, no council, no auto-proceed", () => {
    const b = createBody(VARIANTS.C as AuraVariant, "/wt");
    expect(b).toEqual({ cwd: "/wt", backend: "claude", permissionMode: "bypassPermissions", layers: (VARIANTS.C as AuraVariant).layers });
  });
  it("full council variant: pairing + auto-proceed", () => {
    const b = createBody(VARIANTS.E as AuraVariant, "/wt");
    expect(b).toMatchObject({ councilMode: "council", councilPairing: "claude+claude", autoProceedOnIdle: { idleMs: 120_000, maxIterations: 3 } });
  });
  it("pins the model when given (Companion's own default differs from the CLI's)", () => {
    expect(createBody(VARIANTS.C as AuraVariant, "/wt", "claude-opus-5-5").model).toBe("claude-opus-5-5");
    expect("model" in createBody(VARIANTS.C as AuraVariant, "/wt")).toBe(false);
  });
  it("passes the provider's absolute binary (bench HOME's PATH would pick an older CLI)", () => {
    const bins = { claude: "/u/.local/bin/claude", codex: "/u/.bun/bin/codex" };
    expect(createBody(VARIANTS.E as AuraVariant, "/wt", undefined, bins)).toMatchObject({ claudeBinary: bins.claude });
    expect("codexBinary" in createBody(VARIANTS.E as AuraVariant, "/wt", undefined, bins)).toBe(false);
    expect(createBody(VARIANTS.F as AuraVariant, "/wt", undefined, bins)).toMatchObject({ codexBinary: bins.codex });
  });
  it("Codex variant uses the codex backend", () => {
    expect(createBody(VARIANTS.F as AuraVariant, "/wt").backend).toBe("codex");
  });
  it("parses solo and council create responses", () => {
    expect(sessionIdsFromCreate({ sessionId: "s1" })).toEqual({ primary: "s1", others: [] });
    expect(sessionIdsFromCreate({ primary: { sessionId: "p" }, observer: { sessionId: "o" } })).toEqual({ primary: "p", others: ["o"] });
    expect(sessionIdsFromCreate({ error: "x" })).toBeNull();
    // The group id is what the observer-loop directive and the evidence need.
    expect(sessionIdsFromCreate({ sessionGroupId: "grp_1", primary: { sessionId: "p" }, observer: { sessionId: "o" } })).toEqual({
      primary: "p",
      others: ["o"],
      groupId: "grp_1",
    });
  });
  it("quiet window grows for council and auto-proceed", () => {
    expect(quietWindowMs(VARIANTS.C as AuraVariant)).toBe(60_000);
    expect(quietWindowMs(VARIANTS.D as AuraVariant)).toBe(180_000);
    expect(quietWindowMs(VARIANTS.E as AuraVariant)).toBe(240_000);
  });
});

describe("AuraSessionTracker", () => {
  it("ignores pre-prompt traffic (the Companion init probe)", () => {
    const t = new AuraSessionTracker("p", [], 10);
    t.onMessage("p", result({ is_error: true, subtype: "error_during_execution" }), 0);
    t.promptSent(1);
    expect(t.isDone(1000)).toBe(false);
    expect(t.metrics().turns).toBeNull();
  });

  it("stays open while the observer runs, closes after the quiet window", () => {
    const t = new AuraSessionTracker("p", ["o"], 100);
    t.promptSent(0);
    t.onMessage("p", { type: "assistant", message: { content: [{ type: "tool_use" }] } }, 10);
    t.onMessage("p", result(), 20);
    t.onMessage("o", { type: "status_change", status: "running" }, 30);
    expect(t.isDone(1000)).toBe(false); // observer still running
    t.onMessage("o", result({ total_cost_usd: 0.5, num_turns: 1 }), 50);
    expect(t.isDone(100)).toBe(false); // quiet window not yet elapsed
    expect(t.isDone(151)).toBe(true);
    // Observer cost counts toward the cell.
    expect(t.metrics()).toMatchObject({ turns: 3, tool_calls: 1, cost_usd: 1.5, tokens_out: 14 });
  });

  // P6/FIX-D2-4 (pilot 1: F/G wrote tokens/cost 0). The bridge synthesises
  // every Codex `result` with placeholder zeros; the real token totals ride on
  // `session_update.codex_token_details` and the cost is unknown.
  const codexResult = () => ({
    type: "result",
    data: { subtype: "success", is_error: false, num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
  });
  const codexTokens = (inputTokens: number, outputTokens: number, cachedInputTokens: number) => ({
    type: "session_update",
    session: { codex_token_details: { inputTokens, outputTokens, cachedInputTokens, reasoningOutputTokens: 0, modelContextWindow: 258400 } },
  });

  it("Codex session: placeholder zeros are ignored — tokens from codex_token_details, cost null", () => {
    const t = new AuraSessionTracker("p", [], 10, "codex");
    t.promptSent(0);
    t.onMessage("p", { type: "assistant", message: { model: "gpt-5.5", content: [{ type: "tool_use" }] } }, 1);
    t.onMessage("p", codexTokens(1000, 50, 800), 2);
    t.onMessage("p", codexTokens(3000, 120, 2500), 3); // cumulative — latest wins
    t.onMessage("p", codexResult(), 4);
    expect(t.metrics()).toEqual({
      turns: 1,
      tool_calls: 1,
      tokens_in: 3000,
      tokens_out: 120,
      tokens_cache_read: 2500,
      tokens_cache_write: null,
      cost_usd: null,
      models: ["gpt-5.5"],
    });
  });

  it("Codex session without any token report: tokens unknown (null), not 0", () => {
    const t = new AuraSessionTracker("p", [], 10, "codex");
    t.promptSent(0);
    t.onMessage("p", codexResult(), 1);
    expect(t.metrics()).toMatchObject({ tokens_in: null, tokens_out: null, tokens_cache_read: null, cost_usd: null });
  });

  it("learns the backend from session_init even before the prompt, and banks a reset counter (new thread)", () => {
    // Default backend claude, but the server says codex → placeholders ignored.
    const t = new AuraSessionTracker("p", [], 10);
    t.onMessage("p", { type: "session_init", session: { backend_type: "codex" } }, 0);
    t.promptSent(1);
    t.onMessage("p", codexTokens(500, 10, 100), 2);
    t.onMessage("p", codexTokens(200, 5, 50), 3); // dropped → relaunch on a new thread
    t.onMessage("p", codexResult(), 4);
    expect(t.metrics()).toMatchObject({ tokens_in: 700, tokens_out: 15, tokens_cache_read: 150, cost_usd: null });
  });

  it("one unknown session makes the cell total unknown (no partial sums); idle sessions don't count", () => {
    // Claude primary (known cost) + a Codex session that ran without a
    // cost → the cell cost is unknown, not the primary's alone.
    const t = new AuraSessionTracker("p", ["o", "idle"], 10);
    t.onMessage("o", { type: "session_init", session: { backend_type: "codex" } }, 0);
    t.promptSent(1);
    t.onMessage("p", result(), 2);
    t.onMessage("o", codexTokens(100, 1, 0), 3);
    t.onMessage("o", codexResult(), 4);
    expect(t.metrics()).toMatchObject({ tokens_in: 105, tokens_out: 8, cost_usd: null, tokens_cache_write: null });
    // Without the Codex session the never-ran "idle" one does not poison the total.
    const u = new AuraSessionTracker("p", ["idle"], 10);
    u.promptSent(0);
    u.onMessage("p", result(), 1);
    expect(u.metrics()).toMatchObject({ tokens_in: 5, cost_usd: 1 });
  });

  it("a limit-shaped primary error is a limit; a later success clears it", () => {
    const t = new AuraSessionTracker("p", [], 10);
    t.promptSent(0);
    t.onMessage("p", result({ is_error: true, result: "You've hit your usage limit" }), 1);
    expect(t.limit).not.toBeNull();
    expect(t.primaryError).toBeNull();
    t.onMessage("p", result(), 2);
    expect(t.limit).toBeNull();
  });
});

/** Fake Companion: records REST calls; sockets deliver scripted messages when prompted. */
function fakeCompanion(opts: { council?: boolean; noGroup?: boolean; survivors?: string[]; onPrompt?: (emit: (id: string, m: unknown) => void) => void; connectAfter?: number }) {
  const calls: string[] = [];
  const sent: { id: string; data: unknown }[] = [];
  const handlers = new Map<string, (d: string) => void>();
  let polls = 0;
  let clock = 0;
  const emit = (id: string, m: unknown) => handlers.get(id)?.(JSON.stringify(m));
  const d: AuraDeps = {
    baseUrl: "http://127.0.0.1:3499",
    http: async (method, path, body) => {
      calls.push(`${method} ${path}${body ? ` ${JSON.stringify(body)}` : ""}`);
      if (path === "/api/sessions/create") {
        const pair = { primary: { sessionId: "p" }, observer: { sessionId: "o" } };
        return {
          status: 200,
          json: opts.council ? (opts.noGroup ? pair : { sessionGroupId: "grp_abc", ...pair }) : { sessionId: "p" },
        };
      }
      if (method === "GET" && path === "/api/sessions") {
        return { status: 200, json: opts.survivors?.map((sessionId) => ({ sessionId })) ?? [] };
      }
      if (method === "GET") {
        polls++;
        return { status: 200, json: { state: polls > (opts.connectAfter ?? 0) ? "connected" : "starting" } };
      }
      return { status: 200, json: { ok: true } };
    },
    openSocket: async (url, onMessage) => {
      const id = url.split("/").pop()!;
      handlers.set(id, onMessage);
      return {
        send: (data) => {
          const parsed = JSON.parse(data);
          sent.push({ id, data: parsed });
          if (parsed.type === "user_message") opts.onPrompt?.(emit);
        },
        close: () => calls.push(`close ${id}`),
      };
    },
    instanceFacts: () => ({ instance_port: 3499 }),
    confounds: () => [],
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    pollMs: 1000,
  };
  return { d, calls, sent, emit };
}

const ctx = (variant: "C" | "D" | "E", timeoutMs = 3_600_000, worktree = "/wt/cell") => ({
  task: { id: "t", prompt: "fix it" } as AuraBenchTask,
  variant: VARIANTS[variant],
  worktree,
  timeoutMs,
  artifactDir: "/cells",
});

describe("auraRunner", () => {
  it("prompts after connect, completes, auto-allows permissions, cleans up", async () => {
    const f = fakeCompanion({
      connectAfter: 2,
      onPrompt: (emit) => {
        emit("p", { type: "permission_request", request: { request_id: "r1", tool_name: "Bash" } });
        emit("p", result());
      },
    });
    f.d.models = { claude: "claude-opus-5-5", codex: "gpt-5.4" };
    const r = await auraRunner(f.d)(ctx("C"));
    expect(r).toMatchObject({ kind: "done", status: "completed", isolation: { instance_port: 3499 } });
    expect(f.calls.find((c) => c.startsWith("POST /api/sessions/create"))).toContain('"model":"claude-opus-5-5"');
    const create = f.calls.find((c) => c.startsWith("POST /api/sessions/create"))!;
    expect(create).toContain('"cwd":"/wt/cell"');
    expect(create).toContain('"knowledge":"on"');
    expect(f.calls.filter((c) => c === "GET /api/sessions/p").length).toBe(3); // waited for connect
    expect(f.sent[0]).toMatchObject({ id: "p", data: { type: "user_message", content: "fix it" } });
    expect(f.sent).toContainEqual({ id: "p", data: { type: "permission_response", request_id: "r1", behavior: "allow" } });
    expect(f.calls).toEqual(expect.arrayContaining(["POST /api/sessions/p/archive {}", "DELETE /api/sessions/p", "close p"]));
    expect(f.calls.some((c) => c.includes("/kill"))).toBe(false);
    expect(r).toMatchObject({ isolation: { teardown: { archived: ["p"], deleted: ["p"], still_present: [] } } });
  });

  it("council: observes both halves, archives both before deleting either", async () => {
    const f = fakeCompanion({ council: true, onPrompt: (emit) => emit("p", result()) });
    const r = await auraRunner(f.d)(ctx("D"));
    expect(r).toMatchObject({ kind: "done", status: "completed" });
    expect(f.calls.find((c) => c.startsWith("POST /api/sessions/create"))).toContain('"councilMode":"council"');
    for (const id of ["p", "o"]) expect(f.calls).toContain(`DELETE /api/sessions/${id}`);
    // EC-2 on the bench: both halves are archived (marked intentional) before
    // either is deleted, so neither exit can schedule a keepalive relaunch.
    const lastArchive = Math.max(...["p", "o"].map((id) => f.calls.indexOf(`POST /api/sessions/${id}/archive {}`)));
    const firstDelete = Math.min(...["p", "o"].map((id) => f.calls.indexOf(`DELETE /api/sessions/${id}`)));
    expect(f.calls.indexOf("POST /api/sessions/p/archive {}")).toBeGreaterThanOrEqual(0);
    expect(lastArchive).toBeLessThan(firstDelete);
    expect(f.calls.some((c) => c.includes("/kill"))).toBe(false);
  });

  it("a session still listed after teardown is reported, not hidden", async () => {
    const f = fakeCompanion({ council: true, survivors: ["o", "someone-else"], onPrompt: (emit) => emit("p", result()) });
    const r = await auraRunner(f.d)(ctx("D"));
    expect(r).toMatchObject({ isolation: { teardown: { still_present: ["o"] } } });
  });

  it("a limit result is reported as limit, not as a cell result", async () => {
    const f = fakeCompanion({ onPrompt: (emit) => emit("p", result({ is_error: true, result: "usage limit reached|2000000000" })) });
    expect(await auraRunner(f.d)(ctx("C"))).toMatchObject({ kind: "limit", limit: { resetAt: 2_000_000_000_000 } });
  });

  it("no result before the wall clock → timeout (and cleanup)", async () => {
    const f = fakeCompanion({ onPrompt: (emit) => emit("p", { type: "status_change", status: "running" }) });
    const r = await auraRunner(f.d)(ctx("C", 30_000));
    expect(r).toMatchObject({ kind: "done", status: "timeout" });
    expect(f.calls).toContain("POST /api/sessions/p/archive {}");
  });

  it("a failed create is an agent_error with the server's reason", async () => {
    const f = fakeCompanion({});
    f.d.http = async () => ({ status: 409, json: { error: "observer layer is off" } });
    expect(await auraRunner(f.d)(ctx("D"))).toMatchObject({ kind: "done", status: "agent_error", error: expect.stringContaining("409") });
  });
});

describe("observer loop (FIX-D2-2)", () => {
  it("C sends the task prompt verbatim — no directive for a solo variant", async () => {
    const f = fakeCompanion({ onPrompt: (emit) => emit("p", result()) });
    await auraRunner(f.d)(ctx("C"));
    expect(f.sent[0]).toMatchObject({ data: { type: "user_message", content: "fix it" } });
  });

  it("D appends the directive with the pair's ids and the bench URL, never the prod port", async () => {
    const f = fakeCompanion({ council: true, onPrompt: (emit) => emit("p", result()) });
    await auraRunner(f.d)(ctx("D"));
    const content = (f.sent[0].data as { content: string }).content;
    expect(content.startsWith("fix it\n")).toBe(true);
    expect(content).toContain("http://127.0.0.1:3499/api/sessions/p/council/checkpoint");
    expect(content).toContain('"session_group_id":"grp_abc"');
    expect(content).toContain('"phase":"bench-implement"');
    expect(content).not.toContain("3456");
    // The D → E step must still add the skills: the directive names none.
    expect(content).not.toMatch(/council-(implement|plan|review)/);
  });

  it("the directive's checkpoint body is a valid CheckpointPayload once the placeholders are filled", () => {
    // Guards against the directive drifting from the server's parser
    // (schema_version / field names) — a drifted directive = 400 on every POST.
    const text = observerLoopDirective({ baseUrl: "http://127.0.0.1:3499", orchestratorId: "p", groupId: "grp_abc" });
    const body = text.split("\n").find((l) => l.trim().startsWith("{"))!.trim();
    const filled = body
      .replace("bench-<n>-<8 random hex>", "bench-1-deadbeef")
      .replace("<n>", "1")
      .replace(/<UTC now[^"]*>/, "2026-09-28T12:00:00Z")
      .replace("[<workspace-relative paths of the files you changed, at most 50>]", '["web/server/x.ts"]');
    expect(JSON.parse(filled)).toEqual({
      schema_version: 1,
      checkpoint_id: "bench-1-deadbeef",
      phase: "bench-implement",
      sequence: 1,
      session_group_id: "grp_abc",
      emitted_at: "2026-09-28T12:00:00Z",
      artifact_paths: ["web/server/x.ts"],
    });
  });

  it("a council create without sessionGroupId fails the cell and cleans up both halves", async () => {
    const f = fakeCompanion({ council: true, noGroup: true, onPrompt: (emit) => emit("p", result()) });
    const r = await auraRunner(f.d)(ctx("D"));
    expect(r).toMatchObject({ kind: "done", status: "agent_error", error: expect.stringContaining("sessionGroupId") });
    expect(f.sent).toEqual([]); // never prompted
    for (const id of ["p", "o"]) expect(f.calls).toContain(`DELETE /api/sessions/${id}`);
  });

  it("E: confounds name the bench directive and the unattended STOP hold", async () => {
    const f = fakeCompanion({ council: true, onPrompt: (emit) => emit("p", result()) });
    const r = await auraRunner(f.d)(ctx("E"));
    expect(r.kind === "done" && r.confounds.join("\n")).toMatch(/bench directive[\s\S]*holds auto-proceed/);
  });

  it("records layer_evidence from the worktree's .council/ for the pair's group", async () => {
    const wt = mkdtempSync(join(tmpdir(), "aurabench-ev-"));
    const f = fakeCompanion({
      council: true,
      onPrompt: (emit) => {
        // What a working loop leaves behind by the time the cell ends.
        mkdirSync(join(wt, ".council", "checkpoints"), { recursive: true });
        mkdirSync(join(wt, ".council", "reviews"), { recursive: true });
        writeFileSync(join(wt, ".council", "checkpoints", "bench-implement.grp_abc.json"), JSON.stringify({ phase: "bench-implement", sequence: 1 }));
        writeFileSync(join(wt, ".council", "reviews", "bench-implement-grp_abc-claude-observer.md"), "[]");
        emit("p", result());
      },
    });
    const r = await auraRunner(f.d)(ctx("D", 3_600_000, wt));
    expect(r).toMatchObject({ kind: "done", status: "completed" });
    expect(r.kind === "done" && r.isolation.layer_evidence).toMatchObject({ observer_loop_ran: true, reviews: 1, auto_proceed_fires: null });
  });
});

describe("readLayerEvidence", () => {
  const setup = () => {
    const wt = mkdtempSync(join(tmpdir(), "aurabench-ev-"));
    for (const d of ["checkpoints", "reviews", "state"]) mkdirSync(join(wt, ".council", d), { recursive: true });
    const put = (rel: string, body: string, mtimeSec?: number) => {
      const p = join(wt, ".council", rel);
      writeFileSync(p, body);
      if (mtimeSec !== undefined) utimesSync(p, mtimeSec, mtimeSec);
    };
    return { wt, put };
  };

  it("missing .council → empty evidence, no throw", () => {
    expect(readLayerEvidence("/nonexistent/wt", "grp_x")).toEqual({ checkpoints: [], reviews: 0, observer_loop_ran: false, auto_proceed_fires: null });
  });

  it("only the spawn checkpoint + its review → the loop did NOT run (pilot-1 shape of D)", () => {
    const { wt, put } = setup();
    put("checkpoints/spawn.grp_a.json", JSON.stringify({ phase: "spawn", sequence: 0 }), 1000);
    put("reviews/spawn-grp_a-claude-observer.md", "[]", 1001);
    const ev = readLayerEvidence(wt, "grp_a");
    expect(ev.observer_loop_ran).toBe(false);
    expect(ev.checkpoints).toEqual([{ file: "spawn.grp_a.json", phase: "spawn", sequence: 0 }]);
  });

  it("a work checkpoint with no review written after it → not ran", () => {
    const { wt, put } = setup();
    put("reviews/spawn-grp_a-claude-observer.md", "[]", 1000);
    put("checkpoints/bench-implement.grp_a.json", JSON.stringify({ phase: "bench-implement", sequence: 1 }), 2000);
    expect(readLayerEvidence(wt, "grp_a").observer_loop_ran).toBe(false);
  });

  it("work checkpoint + later review → ran; auto-proceed fires from the trace", () => {
    const { wt, put } = setup();
    put("checkpoints/bench-implement.grp_a.json", JSON.stringify({ phase: "bench-implement", sequence: 2 }), 2000);
    put("reviews/bench-implement-grp_a-claude-observer.md", "[]", 2100);
    put("state/grp_a-auto-proceed-trace.json", JSON.stringify({ iterationCount: 2 }));
    expect(readLayerEvidence(wt, "grp_a")).toMatchObject({ observer_loop_ran: true, reviews: 1, auto_proceed_fires: 2 });
  });

  it("another pair's files in the same workspace are ignored", () => {
    const { wt, put } = setup();
    put("checkpoints/bench-implement.grp_other.json", JSON.stringify({ phase: "bench-implement", sequence: 1 }), 2000);
    put("reviews/bench-implement-grp_other-claude-observer.md", "[]", 2100);
    put("state/grp_other-auto-proceed-trace.json", JSON.stringify({ iterationCount: 3 }));
    expect(readLayerEvidence(wt, "grp_a")).toEqual({ checkpoints: [], reviews: 0, observer_loop_ran: false, auto_proceed_fires: null });
  });
});
