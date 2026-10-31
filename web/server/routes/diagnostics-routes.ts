import { KbArchiveUnavailableError } from "../knowledge/archive-availability.js";
import type { Hono } from "hono";
import type { DiagnosticsOverview, KbAnalysisReport, KbAnalysisStatus } from "../diagnostics/diagnostics-types.js";
import type { RunRequestResult } from "../diagnostics/kb-analysis-runner.js";
import type { ApplyResult, DecisionValidation } from "../diagnostics/kb-decisions.js";
import { log } from "../logger.js";

/**
 * Diagnostics page REST surface (spec §3.5; plan Task 13; dahl, hunt 1/7/8).
 *
 * Registered AFTER the auth middleware (never next to the public stats
 * routes): the overview exposes process topology and the POSTs move KB lines.
 * Handlers only parse, call one method and map its result to a status. Error
 * bodies carry a stable code plus a fixed sentence — never paths, upstream
 * bodies or stack traces. No paths are ever read from a request.
 */

export interface DiagnosticsRoutesDeps {
  overview: () => DiagnosticsOverview;
  status: () => KbAnalysisStatus;
  requestRun: (opts: { includeMemory: boolean }) => RunRequestResult;
  isRunning: () => boolean;
  currentReport: () => KbAnalysisReport | null;
  validate: (body: unknown, report: KbAnalysisReport | null) => DecisionValidation;
  apply: (v: Extract<DecisionValidation, { ok: true }>) => ApplyResult;
  afterDecisions: () => void;
}

const NO_STORE = { "Cache-Control": "no-store" };

export function registerDiagnosticsRoutes(api: Hono, deps: DiagnosticsRoutesDeps): void {
  api.get("/diagnostics/overview", (c) => c.json(deps.overview(), 200, NO_STORE));

  api.get("/diagnostics/kb-analysis/latest", (c) => c.json(deps.status(), 200, NO_STORE));

  api.post("/diagnostics/kb-analysis/run", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { includeMemory?: unknown };
    if (body.includeMemory !== undefined && typeof body.includeMemory !== "boolean") {
      return c.json({ error: "bad_request", message: "includeMemory must be a boolean" }, 400);
    }
    const r = deps.requestRun({ includeMemory: body.includeMemory === true });
    switch (r.kind) {
      case "started":
        return c.json({ runId: r.runId, startedAt: r.startedAt }, 202);
      case "already-running":
        return c.json({ error: "conflict", message: "An analysis is already running.", runId: r.runId, startedAt: r.startedAt }, 409);
      case "memory-disabled":
        return c.json({ error: "forbidden", message: "The memory report is off in Settings." }, 403);
      case "cooldown":
        return c.json({ error: "rate_limited", message: "Wait a few seconds before the next run.", retryAfterMs: r.retryAfterMs }, 429);
      case "unavailable":
        return c.json({ error: "unavailable", message: "Analysis is not available right now." }, 503);
      default: {
        const never: never = r;
        throw new Error(`unhandled run result ${JSON.stringify(never)}`);
      }
    }
  });

  api.post("/diagnostics/kb-analysis/decisions", async (c) => {
    if (deps.isRunning()) {
      return c.json({ error: "conflict", message: "An analysis is running; decide after it finishes." }, 409);
    }
    const body = await c.req.json().catch(() => undefined);
    // Reading the body yields; analysis may have started since the first check.
    if (deps.isRunning()) return c.json({ error: "conflict", message: "An analysis is running; decide after it finishes." }, 409);
    const v = deps.validate(body, deps.currentReport());
    if (!v.ok) return c.json({ error: v.status === 409 ? "conflict" : "validation_failed", message: v.error }, v.status);
    let result: ApplyResult;
    try {
      result = deps.apply(v);
    } catch (err) {
      if (err instanceof KbArchiveUnavailableError) return c.json({ error: "archive_unavailable", message: err.message }, 409);
      log.warn("diagnostics-routes", "decision apply failed", {
        event: "kb_analysis.decision_failed",
        error: err instanceof Error ? err.message : String(err),
      });
      return c.json({ error: "internal_error", message: "The decision could not be recorded." }, 500);
    }
    deps.afterDecisions();
    if (!result.ok) return c.json({ recorded: true, applied: result.applied, message: result.error }, 202);
    return c.json({ applied: result.applied }, 200);
  });
}
