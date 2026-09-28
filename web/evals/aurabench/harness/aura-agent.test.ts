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
 *     the wall clock yields `timeout`; sessions are killed + deleted always.
 */

import { describe, it, expect } from "vitest";
import type { AuraBenchTask } from "../task.js";
import { VARIANTS, type AuraVariant } from "./variants.js";
import { AuraSessionTracker } from "./aura-session-tracker.js";
import { auraRunner, createBody, quietWindowMs, sessionIdsFromCreate, type AuraDeps } from "./aura-agent.js";

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
function fakeCompanion(opts: { council?: boolean; onPrompt?: (emit: (id: string, m: unknown) => void) => void; connectAfter?: number }) {
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
        return { status: 200, json: opts.council ? { primary: { sessionId: "p" }, observer: { sessionId: "o" } } : { sessionId: "p" } };
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

const ctx = (variant: "C" | "D", timeoutMs = 3_600_000) => ({
  task: { id: "t", prompt: "fix it" } as AuraBenchTask,
  variant: VARIANTS[variant],
  worktree: "/wt/cell",
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
    expect(f.calls.filter((c) => c.startsWith("GET")).length).toBe(3); // waited for connect
    expect(f.sent[0]).toMatchObject({ id: "p", data: { type: "user_message", content: "fix it" } });
    expect(f.sent).toContainEqual({ id: "p", data: { type: "permission_response", request_id: "r1", behavior: "allow" } });
    expect(f.calls).toEqual(expect.arrayContaining(["POST /api/sessions/p/kill", "DELETE /api/sessions/p", "close p"]));
  });

  it("council: observes both halves and kills both", async () => {
    const f = fakeCompanion({ council: true, onPrompt: (emit) => emit("p", result()) });
    const r = await auraRunner(f.d)(ctx("D"));
    expect(r).toMatchObject({ kind: "done", status: "completed" });
    expect(f.calls.find((c) => c.startsWith("POST /api/sessions/create"))).toContain('"councilMode":"council"');
    for (const id of ["p", "o"]) expect(f.calls).toContain(`DELETE /api/sessions/${id}`);
  });

  it("a limit result is reported as limit, not as a cell result", async () => {
    const f = fakeCompanion({ onPrompt: (emit) => emit("p", result({ is_error: true, result: "usage limit reached|2000000000" })) });
    expect(await auraRunner(f.d)(ctx("C"))).toMatchObject({ kind: "limit", limit: { resetAt: 2_000_000_000_000 } });
  });

  it("no result before the wall clock → timeout (and cleanup)", async () => {
    const f = fakeCompanion({ onPrompt: (emit) => emit("p", { type: "status_change", status: "running" }) });
    const r = await auraRunner(f.d)(ctx("C", 30_000));
    expect(r).toMatchObject({ kind: "done", status: "timeout" });
    expect(f.calls).toContain("POST /api/sessions/p/kill");
  });

  it("a failed create is an agent_error with the server's reason", async () => {
    const f = fakeCompanion({});
    f.d.http = async () => ({ status: 409, json: { error: "observer layer is off" } });
    expect(await auraRunner(f.d)(ctx("D"))).toMatchObject({ kind: "done", status: "agent_error", error: expect.stringContaining("409") });
  });
});
