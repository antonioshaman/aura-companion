/**
 * One wiring seam for the Diagnostics feature (plan Task 13; fowler 1).
 * `index.ts` creates the drift feed early (the orchestrator's recovery needs
 * its sink), then calls `createDiagnosticsService` once and gets back the
 * route deps, the hourly scheduler and a single `dispose` for shutdown.
 */

import { CleanupScheduler } from "../cleanup/cleanup-scheduler.js";
import { companionBus } from "../event-bus.js";
import { log } from "../logger.js";
import { readCouncilWakeSentinel } from "../council-wake-sentinel.js";
import type { CliLauncher } from "../cli-launcher.js";
import type { WsBridge } from "../ws-bridge.js";
import type { SessionOrchestrator } from "../session-orchestrator.js";
import type { DiagnosticsRoutesDeps } from "../routes/diagnostics-routes.js";
import type { CompanionSettings } from "../settings-manager.js";
import type { ContextAdvisoryView, RuntimeSnapshotView } from "./diagnostics-types.js";
import type { DriftFeed } from "./drift-feed.js";
import { KbAnalysisRunner, repoExistsPredicate } from "./kb-analysis-runner.js";
import { appendDecisions } from "./kb-analysis-store.js";
import { applyDecisions, validateDecisions } from "./kb-decisions.js";
import { buildDiagnosticsOverview } from "./overview.js";
import { buildPairsSnapshot } from "./pairs-snapshot.js";
import { defaultDiagnosticsRoots, REPO_ROOT, type DiagnosticsRoots } from "./roots.js";
import { buildRuntimeSnapshot, getRuntimeSnapshotLoggedAt, type RuntimeSnapshotDeps } from "./runtime-snapshot.js";
import { globalStatsUpstream, usageLimitsUpstream } from "./upstream-status.js";

export const KB_ANALYSIS_CHECK_INTERVAL_MS = 60 * 60 * 1000;

export interface DiagnosticsServiceDeps {
  launcher: CliLauncher;
  wsBridge: WsBridge;
  orchestrator: Pick<SessionOrchestrator, "getAllGroupsForBootstrap" | "getGroupLastCheckpointAt">;
  runtime: RuntimeSnapshotDeps;
  driftFeed: DriftFeed;
  settings: () => CompanionSettings;
  version: string;
  roots?: Partial<DiagnosticsRoots>;
}

export function createDiagnosticsService(deps: DiagnosticsServiceDeps) {
  const roots = defaultDiagnosticsRoots(deps.roots);
  const runner = new KbAnalysisRunner({
    roots,
    settings: () => {
      const s = deps.settings();
      return { kbAnalysis: s.kbAnalysis, diagnosticsMemoryReport: s.diagnosticsMemoryReport };
    },
    repoExists: repoExistsPredicate(REPO_ROOT),
  });
  try {
    runner.init();
  } catch (err) {
    log.warn("kb-analysis", "analysis init failed; the KB card will show it", {
      event: "kb_analysis.init_failed",
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Finished sessions, identical for both backends (same bus event).
  const offExited = companionBus.on("session:exited", ({ sessionId }) => {
    runner.noteSessionExited(sessionId, deps.wsBridge.getSession(sessionId)?.state.num_turns);
  });

  const scheduler = new CleanupScheduler({ label: "kb-analysis", intervalMs: KB_ANALYSIS_CHECK_INTERVAL_MS });
  scheduler.registerSweep("kb-analysis-check", async () => runner.hourlyCheck());
  scheduler.start();

  const runtimeView = (): RuntimeSnapshotView => ({
    pid: process.pid,
    uptimeMs: Math.round(process.uptime() * 1000),
    version: deps.version,
    bunVersion: typeof Bun !== "undefined" ? Bun.version : process.version,
    snapshot: Object.fromEntries(
      Object.entries(buildRuntimeSnapshot(deps.runtime).payload).map(([k, v]) => [k, v === null ? "—" : typeof v === "boolean" ? String(v) : v]),
    ) as Record<string, string | number>,
    lastLoggedAt: getRuntimeSnapshotLoggedAt(),
  });

  const contextAdvisories = (): ContextAdvisoryView[] =>
    deps.wsBridge
      .getAllSessions()
      .filter((s) => s.context_advisory)
      .map((s) => ({ sessionId: s.session_id, backendType: s.backend_type ?? "claude", advisory: s.context_advisory }));

  const overview = () =>
    buildDiagnosticsOverview({
      runtime: runtimeView,
      pairs: () =>
        buildPairsSnapshot({
          groups: () => deps.orchestrator.getAllGroupsForBootstrap(),
          session: (id) => {
            const info = deps.launcher.getSession(id);
            return info
              ? { backendType: info.backendType, state: info.state, pid: info.pid, exitCode: info.exitCode, cwd: info.cwd }
              : undefined;
          },
          lastFrameAt: (id) => deps.wsBridge.getSession(id)?.backendAdapter?.getLastCliFrameReceivedMs?.(),
          lastCheckpointAt: (gid) => deps.orchestrator.getGroupLastCheckpointAt(gid),
          lastWakeAt: (gid, cwd) => {
            const s = readCouncilWakeSentinel(cwd, gid);
            const t = s ? Date.parse(s.last_woken_at) : NaN;
            return Number.isFinite(t) ? t : null;
          },
        }),
      drift: () => deps.driftFeed.view(),
      contextAdvisories,
      usage: () => ({ globalStats: globalStatsUpstream.view(), usageLimits: usageLimitsUpstream.view() }),
      onSupplierError: (card, err) =>
        log.warn("diagnostics", "overview card source failed", {
          event: "diagnostics.card_failed",
          card,
          error: err instanceof Error ? err.message : String(err),
        }),
    });

  const routes: DiagnosticsRoutesDeps = {
    overview,
    status: () => runner.status(),
    requestRun: (opts) => runner.requestManualRun(opts),
    isRunning: () => runner.isRunning(),
    currentReport: () => runner.currentReport(),
    validate: validateDecisions,
    apply: (v) => applyDecisions(v, { kbRoot: roots.kb, append: (lines) => appendDecisions(roots.reports, lines), now: () => Date.now() }),
    afterDecisions: () => runner.refresh(),
  };

  return {
    runner,
    routes,
    async dispose(): Promise<void> {
      offExited();
      await scheduler.dispose();
      await runner.dispose();
    },
  };
}

export type DiagnosticsService = ReturnType<typeof createDiagnosticsService>;
