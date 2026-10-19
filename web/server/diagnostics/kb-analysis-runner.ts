/**
 * KbAnalysisRunner — the one owner of KB-analysis run state (plan Task 11;
 * ritchie §A A1–A6, fowler 6/12, dahl, hunt 8).
 *
 * - Single-flight: one in-memory slot, claimed synchronously before any await
 *   and released in `finally`. The hourly check and the POST route call the
 *   same `requestRun`. The on-disk marker is informational for the NEXT boot
 *   only — a stale marker can never block a live process.
 * - Accumulation: new/changed KB entries (by their own timestamps), distinct
 *   finished sessions (≥ 1 turn, both backends via `session:exited`), and the
 *   age safety net; thresholds are read from settings on every check.
 * - Failure: a failed run keeps `lastRun`, records `lastAttempt`, and backs
 *   off automatic retries; a run that died with the server suppresses
 *   automatic runs until one manual run succeeds (crash-loop guard).
 * - Shutdown: `dispose()` aborts a running analysis at its next step boundary;
 *   it writes no report and does not advance `lastRun`.
 *
 * Nothing here writes to the KB or the memory dir.
 */

import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import { log } from "../logger.js";
import { trackSync } from "../event-loop-lag-monitor.js";
import { computeHealth, indexUsage, loadKb, readUsageLog, type KbLoad } from "../knowledge/kb-store.js";
import type { AnalysisTrigger, KbAnalysisReport, KbAnalysisStatus, KbHealthView } from "./diagnostics-types.js";
import type { KbAnalysisSettings } from "./kb-analysis-settings.js";
import {
  appendDecisions,
  clearInflightMarker,
  consumeStaleInflightMarker,
  emptyState,
  foldDecisions,
  MAX_TRACKED_SESSIONS,
  pruneReports,
  readDecisions,
  readLatestReport,
  readState,
  sweepStaleTmp,
  writeInflightMarker,
  writeReport,
  writeState,
  type KbAnalysisState,
} from "./kb-analysis-store.js";
import { countNewEntries, evaluateTrigger, formatProgress } from "./kb-analysis-trigger.js";
import { analyzeKb } from "./kb-analyzer.js";
import { reconcileArchiveDecisions } from "./kb-decisions.js";
import { analyzeMemoryDir, type ReadOnlyDir } from "./memory-report.js";
import { resolveInside, type DiagnosticsRoots } from "./roots.js";

export const AUTO_RETRY_BACKOFF_MS = 6 * 60 * 60 * 1000;
export const MANUAL_COOLDOWN_MS = 30 * 1000;
const STATE_DEBOUNCE_MS = 2000;
const DAY = 86_400_000;

export interface KbAnalysisRunnerDeps {
  roots: DiagnosticsRoots;
  settings: () => { kbAnalysis: KbAnalysisSettings; diagnosticsMemoryReport: boolean };
  /** Repo-relative existence check for dead-reference (bounded to the repo root). */
  repoExists: (repoRelativePath: string) => boolean;
  now?: () => number;
  bootTimeMs?: number;
}

export type RunRequestResult =
  | { kind: "started"; runId: string; startedAt: number }
  | { kind: "already-running"; runId: string; startedAt: number }
  | { kind: "memory-disabled" }
  | { kind: "cooldown"; retryAfterMs: number }
  | { kind: "unavailable"; reason: string };

class AbortedError extends Error {}

export class KbAnalysisRunner {
  private readonly now: () => number;
  private readonly bootTimeMs: number;
  private state: KbAnalysisState = emptyState();
  /** null after init = state.json has a newer schema: the runner refuses to run (and to overwrite it). */
  private stateUsable = true;
  private inFlight: {
    runId: string;
    startedAt: number;
    trigger: AnalysisTrigger;
    includeMemory: boolean;
    promise: Promise<void>;
    abort: AbortController;
  } | null = null;
  private latest: KbAnalysisStatus["report"] = null;
  private lastFailure: KbAnalysisStatus["lastFailure"] = null;
  private cachedHealth: KbHealthView | null = null;
  private cachedNewEntries = 0;
  private lastManualStartAt = 0;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(private readonly deps: KbAnalysisRunnerDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.bootTimeMs = deps.bootTimeMs ?? this.now();
  }

  // ─── boot ───────────────────────────────────────────────────────────────

  /** Boot reconcile: load state, sweep temp files, detect a run that died with the server, adopt a newer report. */
  init(): void {
    const root = this.deps.roots.reports;
    const s = readState(root);
    if (s === null) {
      this.stateUsable = false;
      log.warn("kb-analysis", "state.json has a newer schema; analysis disabled until upgraded", {
        event: "kb_analysis.state_schema_newer",
      });
      return;
    }
    this.state = s;
    // Finish archive decisions a crash interrupted (in BOTH files only).
    try {
      if (existsSync(this.deps.roots.kb)) reconcileArchiveDecisions(this.deps.roots.kb, foldDecisions(readDecisions(root).lines));
    } catch (err) {
      log.warn("kb-analysis", "archive reconcile failed", {
        event: "kb_analysis.archive_reconcile_failed",
        error: err instanceof Error ? err.message : String(err),
      });
    }
    const swept = sweepStaleTmp(root, this.bootTimeMs);
    if (swept.length > 0) log.info("kb-analysis", "removed stale temp files", { event: "kb_analysis.tmp_swept", count: swept.length });
    const died = consumeStaleInflightMarker(root, this.bootTimeMs);
    if (died) {
      this.state.autoTriggerSuppressed = true;
      this.state.lastAttempt = { at: died.startedAt || this.now(), outcome: "failed", reason: "died with the server" };
      this.lastFailure = { at: this.state.lastAttempt.at, reason: "the previous run died with the server" };
      log.warn("kb-analysis", "previous analysis died with the server; automatic runs paused until a manual run succeeds", {
        event: "kb_analysis.died_previous_boot",
        runId: died.runId,
      });
    }
    this.latest = readLatestReport(root);
    if (this.latest?.status === "available") {
      const r = this.latest.data;
      if (!this.state.lastRun || r.generatedAt > this.state.lastRun.at) {
        this.state.lastRun = { runId: r.runId, at: r.generatedAt, trigger: r.trigger };
        log.info("kb-analysis", "adopted a report newer than the recorded last run", { event: "kb_analysis.report_adopted", runId: r.runId });
      }
    }
    this.persistNow();
    this.refreshCachedKb();
  }

  // ─── accumulation ───────────────────────────────────────────────────────

  /** Wired to `session:exited`; sessions with no completed turn (spawn failures) do not count. */
  noteSessionExited(sessionId: string, numTurns: number | undefined): void {
    if (!this.stateUsable || !numTurns || numTurns < 1) return;
    if (this.state.finishedSessionIds.includes(sessionId)) return;
    this.state.finishedSessionIds.push(sessionId);
    if (this.state.finishedSessionIds.length > MAX_TRACKED_SESSIONS) this.state.finishedSessionIds.shift();
    this.schedulePersist();
  }

  private refreshCachedKb(): KbLoad | null {
    if (!existsSync(this.deps.roots.kb)) {
      this.cachedHealth = null;
      return null;
    }
    return trackSync("kb-analysis.load", () => {
      const load = loadKb(this.deps.roots.kb);
      const h = computeHealth(load, readUsageLog(this.deps.roots.kb));
      this.cachedHealth = {
        total: h.total,
        used: h.used,
        helpful: h.helpful,
        promoted: h.promoted,
        stale: h.stale,
        neverSurfaced: h.neverSurfaced,
        idle: h.idle,
        parseErrors: h.errors.length,
      };
      this.cachedNewEntries = countNewEntries(load, this.state.lastRun?.at ?? null);
      return load;
    });
  }

  private progress() {
    return evaluateTrigger({
      lastRunAt: this.state.lastRun?.at ?? null,
      newEntries: this.cachedNewEntries,
      sessions: this.state.finishedSessionIds.length,
      now: this.now(),
      thresholds: this.deps.settings().kbAnalysis,
    });
  }

  /** The hourly check: cheap, decides only — the run itself is launched, not awaited. */
  hourlyCheck(): void {
    if (this.disposed || !this.stateUsable) return;
    try {
      this.refreshCachedKb();
    } catch (err) {
      log.warn("kb-analysis", "KB unreadable during the hourly check", {
        event: "kb_analysis.check_failed",
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    const p = this.progress();
    const now = this.now();
    if (!p.due) {
      if (this.state.lastNotDueLogAt === null || now - this.state.lastNotDueLogAt >= DAY) {
        this.state.lastNotDueLogAt = now;
        this.schedulePersist();
        log.info("kb-analysis", `not due: ${formatProgress(p)}`, {
          event: "kb_analysis.not_due",
          newEntries: p.newEntries,
          sessions: p.sessions,
          ageDays: p.ageDays,
        });
      }
      return;
    }
    if (this.state.autoTriggerSuppressed) {
      log.info("kb-analysis", "due, but automatic runs are paused after a crashed run", { event: "kb_analysis.auto_suppressed" });
      return;
    }
    const la = this.state.lastAttempt;
    if (la && la.outcome === "failed" && now - la.at < AUTO_RETRY_BACKOFF_MS) return;
    const r = this.start(p.reason ?? "age", false);
    log.info("kb-analysis", "hourly check", { event: "kb_analysis.due", reason: p.reason, outcome: r.kind });
  }

  // ─── runs ───────────────────────────────────────────────────────────────

  /** Manual "Run analysis now" (and memory report). */
  requestManualRun(opts: { includeMemory?: boolean } = {}): RunRequestResult {
    const includeMemory = opts.includeMemory === true;
    if (includeMemory && !this.deps.settings().diagnosticsMemoryReport) return { kind: "memory-disabled" };
    if (this.inFlight) return { kind: "already-running", runId: this.inFlight.runId, startedAt: this.inFlight.startedAt };
    const since = this.now() - this.lastManualStartAt;
    if (since < MANUAL_COOLDOWN_MS) return { kind: "cooldown", retryAfterMs: MANUAL_COOLDOWN_MS - since };
    const r = this.start("manual", includeMemory);
    if (r.kind === "started") this.lastManualStartAt = r.startedAt;
    return r;
  }

  private start(trigger: AnalysisTrigger, includeMemory: boolean): RunRequestResult {
    if (this.disposed) return { kind: "unavailable", reason: "shutting-down" };
    if (!this.stateUsable) return { kind: "unavailable", reason: "state-schema-newer" };
    if (this.inFlight) {
      log.info("kb-analysis", "analysis already running", { event: "kb_analysis.skipped_in_flight", runId: this.inFlight.runId });
      return { kind: "already-running", runId: this.inFlight.runId, startedAt: this.inFlight.startedAt };
    }
    // Claimed synchronously — two callers in the same tick cannot both pass.
    const runId = randomBytes(8).toString("hex");
    const startedAt = this.now();
    const abort = new AbortController();
    const slot = { runId, startedAt, trigger, includeMemory, abort, promise: Promise.resolve() };
    this.inFlight = slot;
    slot.promise = this.run(slot).finally(() => {
      if (this.inFlight === slot) this.inFlight = null;
    });
    return { kind: "started", runId, startedAt };
  }

  private async run(slot: { runId: string; startedAt: number; trigger: AnalysisTrigger; includeMemory: boolean; abort: AbortController }): Promise<void> {
    const root = this.deps.roots.reports;
    const { runId, trigger } = slot;
    const check = () => {
      if (slot.abort.signal.aborted) throw new AbortedError("aborted");
    };
    log.info("kb-analysis", "analysis started", { event: "kb_analysis.started", runId, trigger, includeMemory: slot.includeMemory });
    try {
      writeInflightMarker(root, { runId, pid: process.pid, bootTimeMs: this.bootTimeMs, startedAt: slot.startedAt });
      await Promise.resolve(); // the route answers 202 before any heavy work
      check();
      const load = this.refreshCachedKb();
      if (!load) throw new Error("kb-dir-missing");
      const usage = indexUsage(readUsageLog(this.deps.roots.kb));
      const decisions = foldDecisions(readDecisions(root).lines);
      const result = trackSync("kb-analysis.analyze", () =>
        analyzeKb({ load, usage, decisions, now: this.now(), exists: this.deps.repoExists }),
      );
      check();
      const memory = slot.includeMemory
        ? await analyzeMemoryDir(memoryDirAdapter(this.deps.roots.memory), { now: this.now(), exists: this.deps.repoExists })
        : null;
      check();
      const report: KbAnalysisReport = {
        schemaVersion: 1,
        runId,
        generatedAt: this.now(),
        trigger,
        kbEntryCount: result.entryCount,
        kbParseErrors: result.parseErrors,
        findings: result.findings,
        mergeTasks: result.mergeTasks,
        memory,
      };
      writeReport(root, report);
      pruneReports(root);
      // lastRun advances only after the report rename landed.
      this.state.lastRun = { runId, at: report.generatedAt, trigger };
      this.state.finishedSessionIds = [];
      this.state.lastAttempt = { at: report.generatedAt, outcome: "ok" };
      if (trigger === "manual") this.state.autoTriggerSuppressed = false;
      this.persistNow();
      this.latest = { status: "available", data: report, fetchedAt: report.generatedAt };
      this.lastFailure = null;
      this.cachedNewEntries = 0;
      log.info("kb-analysis", "analysis finished", {
        event: "kb_analysis.completed",
        runId,
        trigger,
        findings: report.findings.length,
        memoryFindings: memory?.findings.length ?? 0,
        durationMs: report.generatedAt - slot.startedAt,
      });
    } catch (err) {
      const aborted = err instanceof AbortedError;
      const reason = aborted ? "aborted" : err instanceof Error ? err.message.slice(0, 200) : String(err);
      this.state.lastAttempt = { at: this.now(), outcome: aborted ? "aborted" : "failed", reason };
      if (!aborted) this.lastFailure = { at: this.state.lastAttempt.at, reason };
      if (!this.disposed) this.persistNow();
      log.warn("kb-analysis", aborted ? "analysis aborted" : "analysis failed", {
        event: aborted ? "kb_analysis.aborted" : "kb_analysis.failed",
        runId,
        reason,
      });
    } finally {
      try {
        clearInflightMarker(root);
      } catch {
        /* the next boot consumes it */
      }
    }
  }

  // ─── read side ──────────────────────────────────────────────────────────

  status(): KbAnalysisStatus {
    const settings = this.deps.settings();
    const report = this.latest;
    const decisions: KbAnalysisStatus["decisions"] = {};
    if (report?.status === "available") {
      const ids = new Set([
        ...report.data.findings.map((f) => f.entryId),
        ...(report.data.memory?.findings.map((f) => f.findingId) ?? []),
      ]);
      for (const [id, d] of foldDecisions(readDecisions(this.deps.roots.reports).lines)) {
        if (ids.has(id) && d.ts >= report.data.generatedAt) decisions[id] = d;
      }
    }
    return {
      inFlight: this.inFlight
        ? { runId: this.inFlight.runId, startedAt: this.inFlight.startedAt, trigger: this.inFlight.trigger, includeMemory: this.inFlight.includeMemory }
        : null,
      lastRun: this.state.lastRun,
      lastFailure: this.lastFailure,
      autoTriggerSuppressed: this.state.autoTriggerSuppressed,
      progress: this.stateUsable && this.cachedHealth ? this.progress() : null,
      health: this.cachedHealth,
      memoryReportEnabled: settings.diagnosticsMemoryReport,
      report,
      decisions,
    };
  }

  /** The report decisions are validated against (in memory, never re-read per request). */
  currentReport(): KbAnalysisReport | null {
    return this.latest?.status === "available" ? this.latest.data : null;
  }

  isRunning(): boolean {
    return this.inFlight !== null;
  }

  /** Called by the decisions applier after a successful append, so status() reflects it. */
  recordDecisions(lines: Parameters<typeof appendDecisions>[1]): void {
    appendDecisions(this.deps.roots.reports, lines);
  }

  /** Re-read KB counters after an archive so the card does not show stale numbers. */
  refresh(): void {
    try {
      this.refreshCachedKb();
    } catch {
      /* surfaced on the next hourly check */
    }
  }

  // ─── persistence + shutdown ─────────────────────────────────────────────

  private schedulePersist(): void {
    if (this.persistTimer || this.disposed) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.persistNow();
    }, STATE_DEBOUNCE_MS);
    this.persistTimer.unref?.();
  }

  private persistNow(): void {
    if (!this.stateUsable) return;
    try {
      writeState(this.deps.roots.reports, this.state);
    } catch (err) {
      log.warn("kb-analysis", "could not persist analysis state", {
        event: "kb_analysis.state_write_failed",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Abort a running analysis (no report, lastRun unchanged) and flush state. Bounded wait. */
  async dispose(maxWaitMs = 2000): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    const running = this.inFlight;
    if (running) {
      running.abort.abort();
      await Promise.race([running.promise, new Promise((r) => setTimeout(r, maxWaitMs).unref?.())]);
    }
    if (this.stateUsable) {
      try {
        writeState(this.deps.roots.reports, this.state);
      } catch {
        /* best effort at shutdown */
      }
    }
  }

  /** Test-only: wait for the running analysis. */
  async _waitForRun(): Promise<void> {
    await this.inFlight?.promise;
  }
}

/** The read-only capability handed to the memory analyzer (list / read / stat — nothing else). */
export function memoryDirAdapter(root: string): ReadOnlyDir {
  return {
    list: async () => {
      if (!existsSync(root)) return [];
      return (await readdir(root, { withFileTypes: true })).filter((d) => d.isFile()).map((d) => d.name);
    },
    read: (name) => readFile(resolveInside(root, name), "utf8"),
    stat: async (name) => {
      const s = await stat(resolveInside(root, name));
      return { mtimeMs: s.mtimeMs, size: s.size };
    },
  };
}

/** Repo-root-bounded existence predicate for dead-reference (EC-7). */
export function repoExistsPredicate(repoRoot: string): (rel: string) => boolean {
  return (rel) => {
    try {
      return existsSync(resolveInside(repoRoot, rel));
    } catch {
      return false;
    }
  };
}

// Silence "unused" for helpers some environments tree-shake differently.
void readdirSync;
void statSync;
void join;
