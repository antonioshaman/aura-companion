// Tests for the KB-analyzer persistence (spec §3.4; plan Task 10).
//
// What is validated:
//   - report names are lexically sortable by time, and "latest" is chosen by
//     name, not mtime (a restore/cp rewrites mtimes);
//   - retention keeps the newest 20 and touches ONLY strict-pattern report
//     files: decisions.jsonl, state.json, the marker, a decoy and a planted
//     symlink all survive;
//   - a corrupt, invalid or newer-schema report yields an explicit
//     unavailable state, never a crash or a silent fallback to an older file;
//   - decisions.jsonl: one line per decision, a torn last line is fenced off
//     so the next record starts clean, bad lines are counted and skipped,
//     and the fold keeps the last decision per id;
//   - state.json round-trips, a newer schema is refused (null), and the
//     in-flight marker from an earlier boot is consumed while this boot's
//     marker is left alone; stale atomic-write temp files are swept.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DecisionLine, KbAnalysisReport } from "./diagnostics-types.js";
import {
  appendDecisions,
  consumeStaleInflightMarker,
  emptyState,
  foldDecisions,
  listReports,
  pruneReports,
  readDecisions,
  readLatestReport,
  readState,
  reportFileName,
  sweepStaleTmp,
  writeInflightMarker,
  writeReport,
  writeState,
} from "./kb-analysis-store.js";

let root: string;
beforeEach(() => {
  root = join(realpathSync(mkdtempSync(join(tmpdir(), "kb-store-"))), "kb-analysis");
});
afterEach(() => {
  rmSync(join(root, ".."), { recursive: true, force: true });
});

function report(generatedAt: number, runId: string): KbAnalysisReport {
  return { schemaVersion: 1, runId, generatedAt, trigger: "manual", kbEntryCount: 1, kbParseErrors: 0, findings: [], mergeTasks: [], memory: null };
}
const dl = (entryId: string, decision: DecisionLine["decision"], ts: number, mergeInto?: string): DecisionLine => ({
  v: 1, ts, runId: "aaaaaaaa", entryId, decision, by: "owner", ...(mergeInto ? { mergeInto } : {}),
});

describe("reports", () => {
  it("names sort by time and latest is picked by name, not mtime", () => {
    expect(reportFileName(Date.parse("2026-10-19T06:07:08Z"), "deadbeef")).toBe("20261019T060708Z-deadbeef.json");
    writeReport(root, report(Date.parse("2026-10-19T00:00:00Z"), "aaaaaaaa"));
    writeReport(root, report(Date.parse("2026-10-18T00:00:00Z"), "bbbbbbbb"));
    // Make the OLDER report the newest by mtime — must not matter.
    const older = join(root, "20261018T000000Z-bbbbbbbb.json");
    utimesSync(older, new Date(), new Date(Date.now() + 60_000));
    const latest = readLatestReport(root);
    expect(latest?.status === "available" && latest.data.runId).toBe("aaaaaaaa");
  });

  it("retention keeps the newest 20 and never touches anything but report files", () => {
    for (let i = 0; i < 23; i++) writeReport(root, report(Date.parse("2026-10-01T00:00:00Z") + i * 3_600_000, `0000000${i.toString(16)}`.slice(-8)));
    appendDecisions(root, [dl("got-1", "keep", 1)]);
    writeState(root, emptyState());
    writeInflightMarker(root, { runId: "cafebabe", pid: 1, bootTimeMs: 1, startedAt: 1 });
    writeFileSync(join(root, "notes.json"), "{}");
    writeFileSync(join(root, "..", "outside.json"), "{}");
    symlinkSync(join(root, "..", "outside.json"), join(root, "20200101T000000Z-ffffffff.json"));

    const doomed = pruneReports(root);

    expect(doomed).toHaveLength(3);
    expect(listReports(root)).toHaveLength(20);
    for (const keep of ["decisions.jsonl", "state.json", ".inflight.json", "notes.json", "20200101T000000Z-ffffffff.json"]) {
      expect(readdirSync(root)).toContain(keep);
    }
    expect(existsSync(join(root, "..", "outside.json"))).toBe(true);
  });

  it.each([
    ["corrupt JSON", "{nope", "report-unreadable"],
    ["newer schema", JSON.stringify({ ...report(1, "aaaaaaaa"), schemaVersion: 2 }), "report-schema-newer"],
    ["unknown signal", JSON.stringify({ ...report(1, "aaaaaaaa"), findings: [{ entryId: "x", signals: [{ signal: "made-up" }] }] }), "report-invalid"],
  ])("a %s report is explicitly unavailable", (_label, text, reason) => {
    writeReport(root, report(1, "aaaaaaaa"));
    writeFileSync(join(root, listReports(root)[0]), text);
    expect(readLatestReport(root)).toMatchObject({ status: "unavailable", reason });
  });

  it("no report yet is null, not unavailable", () => {
    expect(readLatestReport(root)).toBeNull();
  });
});

describe("decisions.jsonl", () => {
  it("appends one line per decision and folds the last decision per id", () => {
    appendDecisions(root, [dl("got-1", "keep", 1), dl("got-2", "merge", 2, "got-3")]);
    appendDecisions(root, [dl("got-1", "archive", 3)]);
    const { lines, badLines } = readDecisions(root);
    expect(lines).toHaveLength(3);
    expect(badLines).toBe(0);
    expect(readFileSync(join(root, "decisions.jsonl"), "utf8").endsWith("\n")).toBe(true);
    expect([...foldDecisions(lines)]).toEqual([
      ["got-1", { decision: "archive", ts: 3 }],
      ["got-2", { decision: "merge", ts: 2, mergeInto: "got-3" }],
    ]);
  });

  it("fences off a torn last line so the next decision starts clean", () => {
    appendDecisions(root, [dl("got-1", "keep", 1)]);
    appendFileSync(join(root, "decisions.jsonl"), '{"v":1,"ts":2,"runId":"aa'); // crash mid-line
    appendDecisions(root, [dl("got-2", "keep", 3)]);
    const { lines, badLines } = readDecisions(root);
    expect(lines.map((l) => l.entryId)).toEqual(["got-1", "got-2"]);
    expect(badLines).toBe(1);
  });
});

describe("state + reconcile", () => {
  it("round-trips state and refuses a newer schema", () => {
    const s = { ...emptyState(), finishedSessionIds: ["a", "b"], autoTriggerSuppressed: true };
    writeState(root, s);
    expect(readState(root)).toEqual(s);
    writeFileSync(join(root, "state.json"), JSON.stringify({ schemaVersion: 99 }));
    expect(readState(root)).toBeNull();
  });

  it("consumes a marker from an earlier boot and leaves this boot's marker alone", () => {
    writeInflightMarker(root, { runId: "cafebabe", pid: 1, bootTimeMs: 100, startedAt: 150 });
    expect(consumeStaleInflightMarker(root, 100)).toBeNull();
    expect(existsSync(join(root, ".inflight.json"))).toBe(true);
    expect(consumeStaleInflightMarker(root, 200)).toMatchObject({ runId: "cafebabe" });
    expect(existsSync(join(root, ".inflight.json"))).toBe(false);
  });

  it("sweeps temp files older than this boot only", () => {
    writeState(root, emptyState());
    writeFileSync(join(root, ".0123456789abcdef.tmp"), "old");
    writeFileSync(join(root, ".fedcba9876543210.tmp"), "new");
    const boot = Date.now();
    utimesSync(join(root, ".0123456789abcdef.tmp"), new Date(boot - 60_000), new Date(boot - 60_000));
    utimesSync(join(root, ".fedcba9876543210.tmp"), new Date(boot + 60_000), new Date(boot + 60_000));
    expect(sweepStaleTmp(root, boot)).toEqual([".0123456789abcdef.tmp"]);
    expect(readdirSync(root)).toContain(".fedcba9876543210.tmp");
  });
});
