// Tests for owner decisions (spec §3.4/§3.5; AC7, AC8, AC9; plan Task 12).
//
// What is validated:
//   - validation covers the whole batch before anything is applied: unknown
//     entryId → 400, stale runId → 409, merge only into the duplicate
//     partner, memory findings accept only "seen", duplicates rejected;
//   - AC7: keep / merge / seen write NOTHING under the KB dir (byte compare);
//   - AC8: archive moves exactly that line to archive/gotchas.jsonl, the live
//     file differs by exactly that line, nothing is deleted, and
//     decisions.jsonl gains one line — the intent is recorded first;
//   - a retried archive is idempotent ("already-archived");
//   - the boot reconcile finishes only half-done archives (in BOTH files) and
//     leaves alone an entry the owner moved back by hand.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DecisionLine, KbAnalysisReport } from "./diagnostics-types.js";
import { appendDecisions, readDecisions } from "./kb-analysis-store.js";
import { applyDecisions, reconcileArchiveDecisions, validateDecisions } from "./kb-decisions.js";

let base: string;
let kb: string;
let reports: string;
const line = (id: string) => JSON.stringify({ id, type: "gotcha", fact: `fact ${id}` });

const REPORT: KbAnalysisReport = {
  schemaVersion: 1,
  runId: "abcdef0123456789",
  generatedAt: 1,
  trigger: "manual",
  kbEntryCount: 4,
  kbParseErrors: 0,
  findings: [
    { entryId: "got-017", signals: [{ signal: "never-used", criterion: "c" }], suggested: "archive", entry: {} as never },
    { entryId: "got-040", signals: [{ signal: "duplicate", criterion: "c", partnerId: "got-041" }], suggested: "merge", entry: {} as never },
    { entryId: "got-041", signals: [{ signal: "duplicate", criterion: "c", partnerId: "got-040" }], suggested: "merge", entry: {} as never },
  ],
  mergeTasks: [],
  memory: { fileCount: 2, truncated: false, findings: [{ findingId: "mem:feedback_a.md", file: "feedback_a.md", name: "a", description: "d", signals: [] }] },
};

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "kb-decisions-")));
  kb = join(base, "kb");
  reports = join(base, "reports");
  mkdirSync(kb);
  writeFileSync(join(kb, "gotchas.jsonl"), [line("got-001"), line("got-017"), line("got-040"), line("got-041")].join("\n") + "\n");
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

const body = (decisions: unknown[], runId = REPORT.runId) => ({ runId, decisions });
const apply = (decisions: unknown[]) => {
  const v = validateDecisions(body(decisions), REPORT);
  if (!v.ok) throw new Error(v.error);
  return applyDecisions(v, { kbRoot: kb, append: (l: DecisionLine[]) => appendDecisions(reports, l), now: () => 1000 });
};
const snapshot = (dir: string) => readdirSync(dir).map((f) => [f, existsSync(join(dir, f)) && !f.includes(".") ? "dir" : readFileSync(join(dir, f), "utf8")]);

describe("validateDecisions", () => {
  it.each([
    [body([{ entryId: "got-999", decision: "archive" }]), 400, /unknown entryId/],
    [body([{ entryId: "got-017", decision: "archive" }], "0000000000000000"), 409, /report changed/],
    [body([{ entryId: "got-017", decision: "delete" }]), 400, /keep, archive or merge/],
    [body([{ entryId: "got-040", decision: "merge", mergeInto: "got-017" }]), 400, /duplicate partner/],
    [body([{ entryId: "got-040", decision: "merge" }]), 400, /duplicate partner/],
    [body([{ entryId: "got-017", decision: "keep", mergeInto: "got-040" }]), 400, /only valid with merge/],
    [body([{ entryId: "mem:feedback_a.md", decision: "archive" }]), 400, /only "seen"/],
    [body([{ entryId: "got-017", decision: "keep" }, { entryId: "got-017", decision: "archive" }]), 400, /duplicate entryId/],
    [body([]), 400, /non-empty/],
    [{ decisions: [] }, 400, /runId/],
  ])("rejects %j", (b, status, error) => {
    const v = validateDecisions(b, REPORT);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.status).toBe(status);
      expect(v.error).toMatch(error);
    }
  });

  it("a partially valid batch is rejected as a whole (nothing applied)", () => {
    const before = readFileSync(join(kb, "gotchas.jsonl"), "utf8");
    const v = validateDecisions(body([{ entryId: "got-017", decision: "archive" }, { entryId: "got-999", decision: "keep" }]), REPORT);
    expect(v.ok).toBe(false);
    expect(readFileSync(join(kb, "gotchas.jsonl"), "utf8")).toBe(before);
    expect(existsSync(join(reports, "decisions.jsonl"))).toBe(false);
  });

  it("no report → 409", () => {
    expect(validateDecisions(body([{ entryId: "got-017", decision: "keep" }]), null)).toMatchObject({ ok: false, status: 409 });
  });
});

describe("applyDecisions", () => {
  it("AC7: keep, merge and seen leave every KB file byte-identical", () => {
    const before = snapshot(kb);
    const r = apply([
      { entryId: "got-017", decision: "keep" },
      { entryId: "got-040", decision: "merge", mergeInto: "got-041" },
      { entryId: "mem:feedback_a.md", decision: "seen" },
    ]);
    expect(r.ok).toBe(true);
    expect(snapshot(kb)).toEqual(before);
    expect(readDecisions(reports).lines.map((l) => [l.entryId, l.decision, l.mergeInto])).toEqual([
      ["got-017", "keep", undefined],
      ["got-040", "merge", "got-041"],
      ["mem:feedback_a.md", "seen", undefined],
    ]);
  });

  it("AC8: archive moves exactly that line, deletes nothing, and adds one ledger line", () => {
    const r = apply([{ entryId: "got-017", decision: "archive" }]);
    expect(r).toEqual({
      ok: true,
      applied: [{ entryId: "got-017", decision: "archive", archive: "archived", archivedTo: ".agents/knowledge/archive/gotchas.jsonl" }],
    });
    expect(readFileSync(join(kb, "gotchas.jsonl"), "utf8")).toBe([line("got-001"), line("got-040"), line("got-041")].join("\n") + "\n");
    const archived = readFileSync(join(kb, "archive", "gotchas.jsonl"), "utf8").trim().split("\n");
    expect(archived).toHaveLength(1);
    expect(JSON.parse(archived[0])).toMatchObject({ id: "got-017", fact: "fact got-017", archiveReason: expect.stringContaining("owner decision") });
    const ledger = readDecisions(reports).lines;
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ v: 1, entryId: "got-017", decision: "archive", by: "owner", runId: REPORT.runId });
  });

  it("a retried archive is idempotent", () => {
    apply([{ entryId: "got-017", decision: "archive" }]);
    const second = apply([{ entryId: "got-017", decision: "archive" }]);
    expect(second.ok && second.applied[0].archive).toBe("already-archived");
    expect(readFileSync(join(kb, "archive", "gotchas.jsonl"), "utf8").trim().split("\n")).toHaveLength(1);
  });
});

describe("reconcileArchiveDecisions", () => {
  it("finishes a half-done archive and leaves a hand-restored entry alone", () => {
    // got-017: archive decided, crash left it in BOTH files → finish it.
    // got-040: archive decided, owner later moved it back (live only) → leave it.
    mkdirSync(join(kb, "archive"));
    writeFileSync(join(kb, "archive", "gotchas.jsonl"), line("got-017") + "\n");
    const decided = new Map([
      ["got-017", { decision: "archive" as const, ts: 1 }],
      ["got-040", { decision: "archive" as const, ts: 1 }],
    ]);
    expect(reconcileArchiveDecisions(kb, decided)).toEqual(["got-017"]);
    const live = readFileSync(join(kb, "gotchas.jsonl"), "utf8");
    expect(live).not.toContain('"got-017"');
    expect(live).toContain('"got-040"');
  });
});
