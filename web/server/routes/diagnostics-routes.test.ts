// Tests for the Diagnostics REST surface (spec §3.5; AC6; plan Task 13).
//
// What is validated: each runner / validator outcome maps to one status —
// run: started → 202 + runId, already-running → 409 with the running runId
// (AC6), memory off → 403, cooldown → 429, unavailable → 503; decisions:
// 409 while an analysis runs, validator 400/409 pass through with their fixed
// message, a recorded-but-not-applied archive is 202, success is 200 and
// refreshes the KB counters. Responses are no-store.

import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { registerDiagnosticsRoutes, type DiagnosticsRoutesDeps } from "./diagnostics-routes.js";

function app(over: Partial<DiagnosticsRoutesDeps> = {}) {
  const deps: DiagnosticsRoutesDeps = {
    overview: vi.fn(() => ({ generatedAt: 1 }) as never),
    status: vi.fn(() => ({ inFlight: null }) as never),
    requestRun: vi.fn(() => ({ kind: "started", runId: "r1", startedAt: 5 }) as const),
    isRunning: vi.fn(() => false),
    currentReport: vi.fn(() => ({ runId: "r1" }) as never),
    validate: vi.fn(() => ({ ok: true, runId: "r1", items: [] }) as ReturnType<DiagnosticsRoutesDeps["validate"]>),
    apply: vi.fn(() => ({ ok: true, applied: [] }) as ReturnType<DiagnosticsRoutesDeps["apply"]>),
    afterDecisions: vi.fn(),
    ...over,
  };
  const a = new Hono();
  const api = new Hono();
  registerDiagnosticsRoutes(api, deps);
  a.route("/api", api);
  return { a, deps };
}
const post = (a: Hono, path: string, body: unknown) =>
  a.request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

describe("diagnostics routes", () => {
  it("GET overview / latest are no-store", async () => {
    const { a } = app();
    for (const p of ["/api/diagnostics/overview", "/api/diagnostics/kb-analysis/latest"]) {
      const res = await a.request(p);
      expect(res.status).toBe(200);
      expect(res.headers.get("Cache-Control")).toBe("no-store");
    }
  });

  it.each([
    [{ kind: "started", runId: "r1", startedAt: 5 }, 202, { runId: "r1", startedAt: 5 }],
    [{ kind: "already-running", runId: "r0", startedAt: 3 }, 409, { error: "conflict", runId: "r0", startedAt: 3 }],
    [{ kind: "memory-disabled" }, 403, { error: "forbidden" }],
    [{ kind: "cooldown", retryAfterMs: 1000 }, 429, { error: "rate_limited", retryAfterMs: 1000 }],
    [{ kind: "unavailable", reason: "x" }, 503, { error: "unavailable" }],
  ])("run %j → %i", async (result, status, json) => {
    const { a, deps } = app({ requestRun: vi.fn(() => result as never) });
    const res = await post(a, "/api/diagnostics/kb-analysis/run", { includeMemory: true });
    expect(res.status).toBe(status);
    expect(await res.json()).toMatchObject(json);
    expect(deps.requestRun).toHaveBeenCalledWith({ includeMemory: true });
  });

  it("run rejects a non-boolean includeMemory", async () => {
    const { a, deps } = app();
    expect((await post(a, "/api/diagnostics/kb-analysis/run", { includeMemory: "yes" })).status).toBe(400);
    expect(deps.requestRun).not.toHaveBeenCalled();
  });

  it("decisions: 409 while an analysis runs, without validating or applying", async () => {
    const { a, deps } = app({ isRunning: vi.fn(() => true) });
    expect((await post(a, "/api/diagnostics/kb-analysis/decisions", {})).status).toBe(409);
    expect(deps.validate).not.toHaveBeenCalled();
    expect(deps.apply).not.toHaveBeenCalled();
  });

  it("decisions: validator errors pass through with their status and fixed message", async () => {
    const { a, deps } = app({ validate: vi.fn(() => ({ ok: false, status: 400, error: "unknown entryId for this report" }) as ReturnType<DiagnosticsRoutesDeps["validate"]>) });
    const res = await post(a, "/api/diagnostics/kb-analysis/decisions", { runId: "r1", decisions: [] });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "validation_failed", message: "unknown entryId for this report" });
    expect(deps.apply).not.toHaveBeenCalled();
  });

  it("decisions: success → 200 and KB counters refresh; recorded-not-applied → 202", async () => {
    const ok = app();
    expect((await post(ok.a, "/api/diagnostics/kb-analysis/decisions", {})).status).toBe(200);
    expect(ok.deps.afterDecisions).toHaveBeenCalled();
    const partial = app({ apply: vi.fn(() => ({ ok: false, recorded: true, error: "retry", applied: [] }) as ReturnType<DiagnosticsRoutesDeps["apply"]>) });
    const res = await post(partial.a, "/api/diagnostics/kb-analysis/decisions", {});
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ recorded: true, message: "retry" });
  });
});
