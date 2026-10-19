// Tests for KbAnalysisRunner (plan Task 11; AC5, AC6, AC7 at the runner level).
//
// What is validated, against a real tmp KB + reports dir:
//   - AC5: the hourly check starts exactly one analysis when due by entries,
//     writes one report, advances lastRun and clears the session counter;
//     a second check right after is not due (no second run);
//   - AC6: single-flight — while a run is in flight a manual request answers
//     "already-running" with the same runId, and a manual run has a cooldown;
//   - the memory report is refused server-side when the setting is off;
//   - finished sessions count once per id and only with ≥ 1 turn;
//   - a marker left by an earlier boot pauses automatic runs (crash-loop
//     guard) until a manual run succeeds;
//   - a failed run keeps lastRun and records the failure;
//   - dispose aborts a running analysis: no report, lastRun unchanged;
//   - AC7: no file under the KB dir changes during an analysis.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { log } from "../logger.js";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { KbAnalysisRunner, type KbAnalysisRunnerDeps } from "./kb-analysis-runner.js";
import { listReports, readState, writeInflightMarker, writeState, emptyState } from "./kb-analysis-store.js";
import { CleanupScheduler } from "../cleanup/cleanup-scheduler.js";

const DAY = 86_400_000;
let base: string;
let now: number;
let memoryOn: boolean;

function entry(id: string, createdDaysAgo: number) {
  const iso = new Date(now - createdDaysAgo * DAY).toISOString();
  return JSON.stringify({ id, type: "gotcha", fact: `fact ${id} ${id}`, recommendation: "r", tags: [id], affectedFiles: [], provenance: [], createdAt: iso, updatedAt: iso, usageCount: 0 });
}

function deps(over: Partial<KbAnalysisRunnerDeps> = {}): KbAnalysisRunnerDeps {
  return {
    roots: { kb: join(base, "kb"), reports: join(base, "reports"), memory: join(base, "memory") },
    settings: () => ({ kbAnalysis: { newEntriesThreshold: 10, sessionsThreshold: 25, maxAgeDays: 14 }, diagnosticsMemoryReport: memoryOn }),
    repoExists: () => true,
    now: () => now,
    bootTimeMs: now,
    ...over,
  };
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "kb-runner-")));
  now = Date.parse("2026-10-19T12:00:00Z");
  memoryOn = false;
  mkdirSync(join(base, "kb"));
  mkdirSync(join(base, "memory"));
  writeFileSync(join(base, "kb", "gotchas.jsonl"), [entry("got-old", 60)].join("\n") + "\n");
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

/** Seed a previous run 2 days ago so only the thresholds can make it due. */
function seedLastRun() {
  writeState(join(base, "reports"), { ...emptyState(), lastRun: { runId: "0000000000000000", at: now - 2 * DAY, trigger: "manual" } });
}

describe("KbAnalysisRunner", () => {
  it("AC5: due by entries → exactly one analysis, one report, lastRun advanced", async () => {
    seedLastRun();
    writeFileSync(join(base, "kb", "gotchas.jsonl"), [entry("got-old", 60), ...Array.from({ length: 10 }, (_, i) => entry(`got-n${i}`, 1))].join("\n") + "\n");
    const r = new KbAnalysisRunner(deps());
    r.init();
    r.noteSessionExited("s1", 3);
    expect(r.status().progress).toMatchObject({ due: true, reason: "entries", newEntries: 10 });

    r.hourlyCheck();
    expect(r.isRunning()).toBe(true);
    await r._waitForRun();

    expect(listReports(join(base, "reports"))).toHaveLength(1);
    const st = r.status();
    expect(st.report?.status).toBe("available");
    expect(st.lastRun?.trigger).toBe("entries");
    expect(readState(join(base, "reports"))?.finishedSessionIds).toEqual([]);
    r.hourlyCheck();
    expect(r.isRunning()).toBe(false);
    expect(listReports(join(base, "reports"))).toHaveLength(1);
    await r.dispose();
  });

  it("AC4: not due → no run, progress explains why", async () => {
    seedLastRun();
    const r = new KbAnalysisRunner(deps());
    r.init();
    r.hourlyCheck();
    expect(r.isRunning()).toBe(false);
    expect(r.status().progress).toMatchObject({ due: false, ageDays: 2, dueInDays: 12 });
    await r.dispose();
  });

  it("AC6: single-flight and cooldown on manual runs", async () => {
    const r = new KbAnalysisRunner(deps());
    r.init();
    const first = r.requestManualRun();
    expect(first.kind).toBe("started");
    const second = r.requestManualRun();
    expect(second).toEqual({ kind: "already-running", runId: (first as { runId: string }).runId, startedAt: now });
    await r._waitForRun();
    expect(r.requestManualRun().kind).toBe("cooldown");
    now += 31_000;
    expect(r.requestManualRun().kind).toBe("started");
    await r._waitForRun();
    await r.dispose();
  });

  it("refuses the memory report when the setting is off, and runs it when on", async () => {
    const r = new KbAnalysisRunner(deps());
    r.init();
    expect(r.requestManualRun({ includeMemory: true })).toEqual({ kind: "memory-disabled" });
    memoryOn = true;
    writeFileSync(join(base, "memory", "feedback_a.md"), "---\nname: a\ndescription: dup words here\ntype: feedback\n---\nx\n");
    writeFileSync(join(base, "memory", "feedback_b.md"), "---\nname: b\ndescription: dup words here\ntype: feedback\n---\nx\n");
    expect(r.requestManualRun({ includeMemory: true }).kind).toBe("started");
    await r._waitForRun();
    const rep = r.currentReport();
    expect(rep?.memory?.findings.map((f) => f.findingId).sort()).toEqual(["mem:feedback_a.md", "mem:feedback_b.md"]);
    await r.dispose();
  });

  it("counts a finished session once, and only with at least one turn", async () => {
    seedLastRun();
    const r = new KbAnalysisRunner(deps());
    r.init();
    r.noteSessionExited("s1", 1);
    r.noteSessionExited("s1", 2); // relaunch of the same session
    r.noteSessionExited("s2", 0); // spawn failure
    r.noteSessionExited("s3", undefined);
    expect(r.status().progress?.sessions).toBe(1);
    await r.dispose();
    expect(readState(join(base, "reports"))?.finishedSessionIds).toEqual(["s1"]);
  });

  it("a run that died with the server pauses automatic runs until a manual run succeeds", async () => {
    writeState(join(base, "reports"), emptyState());
    writeInflightMarker(join(base, "reports"), { runId: "dead", pid: 1, bootTimeMs: now - 1000, startedAt: now - 2000 });
    const r = new KbAnalysisRunner(deps());
    r.init();
    expect(r.status()).toMatchObject({ autoTriggerSuppressed: true, lastFailure: { reason: "the previous run died with the server" } });
    r.hourlyCheck(); // due by age (never analysed) — but suppressed
    expect(r.isRunning()).toBe(false);
    expect(r.requestManualRun().kind).toBe("started");
    await r._waitForRun();
    expect(r.status().autoTriggerSuppressed).toBe(false);
    await r.dispose();
  });

  it("a failed run keeps lastRun and records the failure", async () => {
    seedLastRun();
    const r = new KbAnalysisRunner(deps({ roots: { kb: join(base, "missing-kb"), reports: join(base, "reports"), memory: join(base, "memory") } }));
    r.init();
    r.requestManualRun();
    await r._waitForRun();
    const st = r.status();
    expect(st.lastRun?.runId).toBe("0000000000000000");
    expect(st.lastFailure?.reason).toBe("kb-dir-missing");
    expect(listReports(join(base, "reports"))).toHaveLength(0);
    await r.dispose();
  });

  it("dispose aborts a running analysis: no report, lastRun unchanged", async () => {
    seedLastRun();
    const r = new KbAnalysisRunner(deps());
    r.init();
    r.requestManualRun();
    await r.dispose();
    expect(listReports(join(base, "reports"))).toHaveLength(0);
    expect(readState(join(base, "reports"))?.lastRun?.runId).toBe("0000000000000000");
    expect(readdirSync(join(base, "reports"))).not.toContain(".inflight.json");
  });

  it("AC7: an analysis changes nothing under the KB dir", async () => {
    const before = readFileSync(join(base, "kb", "gotchas.jsonl"), "utf8");
    const r = new KbAnalysisRunner(deps());
    r.init();
    r.requestManualRun();
    await r._waitForRun();
    expect(readdirSync(join(base, "kb"))).toEqual(["gotchas.jsonl"]);
    expect(readFileSync(join(base, "kb", "gotchas.jsonl"), "utf8")).toBe(before);
    await r.dispose();
  });
});

describe("CleanupScheduler label", () => {
  it("rejects a malformed label and keeps 'cleanup' as the default scope", async () => {
    expect(() => new CleanupScheduler({ label: "Bad Label" })).toThrow(/invalid label/);
    const info = vi.spyOn(log, "info");
    const s = new CleanupScheduler({ label: "kb-analysis", intervalMs: 3_600_000 });
    s.start();
    await s.dispose();
    const events = info.mock.calls.map((c) => (c[2] as { event?: string })?.event);
    expect(events).toContain("kb-analysis.scheduler.started");
    expect(events).not.toContain("cleanup.scheduler.started");
    expect(info.mock.calls.find((c) => (c[2] as { event?: string })?.event === "kb-analysis.scheduler.started")?.[0]).toBe("kb-analysis-scheduler");
    info.mockRestore();
  });
});
