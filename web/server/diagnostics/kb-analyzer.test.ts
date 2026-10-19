// Tests for the deterministic KB analyzer (spec §3.3, AC7; plan Task 9).
//
// What is validated, signal by signal, on a fixture KB built in a tmp dir:
//   - never-used: usage 0, not in usage.log, created ≥ 30 days ago (a 10-day
//     old entry is NOT flagged — new entries get time to be used);
//   - dead-reference: only real repo-relative paths are checked; prose, PR
//     numbers, URLs and `~/…` references are never reported dead;
//   - duplicate: identical normalised facts pair up and suggest "merge";
//   - contradiction / bitter-pill are heuristics: flagged, NO suggestion;
//   - stale-promoted suggests nothing (update, not archive);
//   - owner decisions: keep suppresses for 90 days unless the entry changed,
//     merge moves the entry into mergeTasks, archive drops it;
//   - AC7: running the analysis writes NOTHING under the KB dir (byte compare).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { indexUsage, loadKb, readUsageLog } from "../knowledge/kb-store.js";
import { analyzeKb, referencedPath, type FoldedDecision } from "./kb-analyzer.js";

const NOW = Date.parse("2026-10-19T00:00:00Z");
const DAY = 86_400_000;
const iso = (daysAgo: number) => new Date(NOW - daysAgo * DAY).toISOString();

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kb-analyzer-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function e(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    type: "gotcha",
    fact: `distinct fact about ${id} subsystem ${id}`,
    recommendation: "check it",
    confidence: "medium",
    provenance: [{ source: "codebase", reference: "web/server/index.ts", date: iso(5).slice(0, 10) }],
    tags: [id],
    affectedFiles: ["web/server/index.ts"],
    createdAt: iso(5),
    updatedAt: iso(5),
    usageCount: 1,
    helpfulCount: 0,
    outdatedReports: 0,
    ...extra,
  };
}

function writeKb(rows: object[]) {
  writeFileSync(join(dir, "gotchas.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

const EXISTING = new Set(["web/server/index.ts", "docs/a.md", ".husky/x"]);
function run(decisions = new Map<string, FoldedDecision>()) {
  const load = loadKb(dir);
  return analyzeKb({ load, usage: indexUsage(readUsageLog(dir)), decisions, now: NOW, exists: (p) => EXISTING.has(p) });
}
const signalsOf = (r: ReturnType<typeof run>, id: string) => r.findings.find((f) => f.entryId === id)?.signals.map((s) => s.signal) ?? [];

describe("analyzeKb", () => {
  it("flags never-used only once the entry is at least 30 days old", () => {
    writeKb([e("got-017", { usageCount: 0, createdAt: iso(40) }), e("got-new", { usageCount: 0, createdAt: iso(10) })]);
    const r = run();
    expect(signalsOf(r, "got-017")).toEqual(["never-used"]);
    expect(r.findings.find((f) => f.entryId === "got-017")?.suggested).toBe("archive");
    expect(r.findings.find((f) => f.entryId === "got-017")?.signals[0].criterion).toMatch(/40 days ≥ 30/);
    expect(signalsOf(r, "got-new")).toEqual([]);
  });

  it("reports only real missing repo paths as dead references", () => {
    writeKb([
      e("got-dead", { affectedFiles: ["web/server/gone.ts"], provenance: [{ source: "codebase", reference: "web/server/gone.ts:12", date: "2026-10-01" }] }),
      e("got-prose", {
        affectedFiles: ["~/.claude/skills/council-plan-aura/"],
        provenance: [
          { source: "user", reference: "PR #338", date: "2026-10-01" },
          { source: "user", reference: "2026-05-11 user response post-review", date: "2026-10-01" },
          { source: "web", reference: "https://example.com/x.ts", date: "2026-10-01" },
          { source: "codebase", reference: "docs/a.md D2/NR2", date: "2026-10-01" },
        ],
      }),
    ]);
    const r = run();
    const dead = r.findings.find((f) => f.entryId === "got-dead")!;
    expect(dead.signals).toEqual([{ signal: "dead-reference", criterion: "missing in the repo: web/server/gone.ts" }]);
    expect(dead.entry.affectedFiles).toEqual([{ path: "web/server/gone.ts", exists: false }]);
    expect(signalsOf(r, "got-prose")).toEqual([]);
  });

  it("pairs duplicates and suggests merge", () => {
    writeKb([
      e("got-040", { fact: "Pre-commit hook runs typecheck AND tests!" }),
      e("got-041", { fact: "pre-commit hook runs typecheck and tests" }),
    ]);
    const r = run();
    const a = r.findings.find((f) => f.entryId === "got-040")!;
    expect(a.signals).toEqual([{ signal: "duplicate", criterion: "identical normalised fact", partnerId: "got-041", similarity: 1 }]);
    expect(a.suggested).toBe("merge");
    expect(r.findings.find((f) => f.entryId === "got-041")?.signals[0].partnerId).toBe("got-040");
  });

  it("flags contradiction and bitter-pill as heuristics with no suggestion", () => {
    writeKb([
      e("got-a", { fact: "pre-commit hook slow tests typecheck order matters", recommendation: "Always run tests first", affectedFiles: [".husky/x"] }),
      e("got-b", { fact: "pre-commit hook slow typecheck order tests cost", recommendation: "Never run tests first", affectedFiles: [".husky/x"] }),
      e("got-model", {
        fact: "Claude CLI forgets to read the plan file",
        tags: ["claude"],
        affectedFiles: [],
        provenance: [{ source: "observation", reference: "session", date: iso(200).slice(0, 10) }],
      }),
    ]);
    const r = run();
    expect(signalsOf(r, "got-a")).toEqual(["contradiction"]);
    expect(r.findings.find((f) => f.entryId === "got-a")?.suggested).toBeNull();
    expect(signalsOf(r, "got-model")).toEqual(["bitter-pill"]);
    expect(r.findings.find((f) => f.entryId === "got-model")?.suggested).toBeNull();
  });

  it("a promoted entry with dead references is stale-promoted and suggests no archive", () => {
    writeKb([e("pat-1", { type: "pattern", promoted: true, affectedFiles: ["web/gone.ts"] })]);
    const f = run().findings[0];
    expect(f.signals.map((s) => s.signal)).toEqual(["dead-reference", "stale-promoted"]);
    expect(f.suggested).toBeNull();
  });

  it("honours owner decisions: keep suppresses 90 days unless changed, merge becomes a task, archive drops", () => {
    writeKb([
      e("got-kept", { usageCount: 0, createdAt: iso(60), updatedAt: iso(60) }),
      e("got-kept-changed", { usageCount: 0, createdAt: iso(60), updatedAt: iso(1) }),
      e("got-merge", { usageCount: 0, createdAt: iso(60) }),
      e("got-archived", { usageCount: 0, createdAt: iso(60) }),
    ]);
    const decisions = new Map<string, FoldedDecision>([
      ["got-kept", { decision: "keep", ts: NOW - 10 * DAY }],
      ["got-kept-changed", { decision: "keep", ts: NOW - 10 * DAY }],
      ["got-merge", { decision: "merge", ts: NOW - DAY, mergeInto: "got-kept" }],
      ["got-archived", { decision: "archive", ts: NOW - DAY }],
    ]);
    const r = run(decisions);
    expect(r.findings.map((f) => f.entryId)).toEqual(["got-kept-changed"]);
    expect(r.mergeTasks).toEqual([{ entryId: "got-merge", mergeInto: "got-kept", decidedAt: NOW - DAY }]);
  });

  it("AC7: analysis writes nothing under the KB dir", () => {
    writeKb([e("got-017", { usageCount: 0, createdAt: iso(40) }), e("got-040", { fact: "x y z" }), e("got-041", { fact: "x y z" })]);
    const before = readdirSync(dir).map((f) => [f, readFileSync(join(dir, f), "utf8")]);
    const r = run();
    expect(r.findings.length).toBeGreaterThan(0);
    expect(readdirSync(dir).map((f) => [f, readFileSync(join(dir, f), "utf8")])).toEqual(before);
  });
});

describe("referencedPath", () => {
  it.each([
    ["web/server/index.ts", "web/server/index.ts"],
    ["web/server/index.ts:120", "web/server/index.ts"],
    ["package.json", "package.json"],
    ["docs/history/HANDOFF.md D2/NR2", "docs/history/HANDOFF.md"],
    ["PR #338", null],
    ["~/.claude/skills/x/", null],
    ["/etc/passwd", null],
    ["https://example.com/a.ts", null],
    ["../outside.ts", null],
    ["CLAUDE.md", "CLAUDE.md"],
    ["codebase", null],
  ])("%j → %j", (ref, want) => {
    expect(referencedPath(ref)).toBe(want);
  });
});
