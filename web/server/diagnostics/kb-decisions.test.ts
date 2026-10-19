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
//   - review 2026-10-19-1110 (ritchie B-1/B-2/B-4, beck #3): the pending
//     sentinel is written BEFORE the move and the ledger line only AFTER it;
//     one concurrent write is retried; two leave the decision pending with no
//     ledger line (the page must not claim "archived"); an id on two live lines
//     is refused; the boot reconcile finishes ONLY what the sentinel proves was
//     interrupted and never re-archives an entry the owner restored by hand.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DecisionLine, KbAnalysisReport } from "./diagnostics-types.js";
import { appendDecisions, readDecisions } from "./kb-analysis-store.js";
import * as atomicWrite from "../atomic-write.js";
import { appendFileSync } from "node:fs";
import { vi } from "vitest";
import { appendDecisions as append2, clearArchivePending, readArchivePending, writeArchivePending } from "./kb-analysis-store.js";
import { applyDecisions, reconcileArchivePending, validateDecisions } from "./kb-decisions.js";

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
const deps = (over: Partial<Parameters<typeof applyDecisions>[1]> = {}) => ({
  kbRoot: kb,
  append: (l: DecisionLine[]) => appendDecisions(reports, l),
  pending: { write: (p: Parameters<typeof writeArchivePending>[1]) => writeArchivePending(reports, p), clear: () => clearArchivePending(reports) },
  now: () => 1000,
  ...over,
});
const apply = (decisions: unknown[]) => {
  const v = validateDecisions(body(decisions), REPORT);
  if (!v.ok) throw new Error(v.error);
  return applyDecisions(v, deps());
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

describe("archive ordering and failure (review 2026-10-19-1110)", () => {
  it("writes the pending sentinel before the move and the ledger line only after it", () => {
    const seen: string[] = [];
    const v = validateDecisions(body([{ entryId: "got-017", decision: "archive" }]), REPORT);
    if (!v.ok) throw new Error(v.error);
    const r = applyDecisions(
      v,
      deps({
        pending: {
          write: (p) => {
            seen.push(`pending:${readFileSync(join(kb, "gotchas.jsonl"), "utf8").includes('"got-017"') ? "live" : "gone"}`);
            writeArchivePending(reports, p);
          },
          clear: () => {
            seen.push("clear");
            clearArchivePending(reports);
          },
        },
        append: (l) => {
          seen.push(`ledger:${readFileSync(join(kb, "gotchas.jsonl"), "utf8").includes('"got-017"') ? "live" : "gone"}`);
          appendDecisions(reports, l);
        },
      }),
    );
    expect(r.ok).toBe(true);
    expect(seen).toEqual(["pending:live", "ledger:gone", "clear"]);
    expect(readArchivePending(reports)).toBeNull();
  });

  function conflicts(times: number) {
    let left = times;
    const real = atomicWrite.writeAtomicText;
    return vi.spyOn(atomicWrite, "writeAtomicText").mockImplementation((target, text, opts) => {
      if (target === join(kb, "gotchas.jsonl") && left > 0) {
        left--;
        return real(target, text, {
          ...opts,
          beforeRename: () => {
            appendFileSync(target, line(`got-learn-${left}`) + "\n"); // a concurrent /learn append
            opts?.beforeRename?.();
          },
        });
      }
      return real(target, text, opts);
    });
  }

  it("retries once after a concurrent /learn append and succeeds", () => {
    const spy = conflicts(1);
    try {
      const r = apply([{ entryId: "got-017", decision: "archive" }]);
      expect(r.ok).toBe(true);
    } finally {
      spy.mockRestore();
    }
    const live = readFileSync(join(kb, "gotchas.jsonl"), "utf8");
    expect(live).not.toContain('"got-017"');
    expect(live).toContain('"got-learn-0"'); // the concurrent line survived
    expect(readDecisions(reports).lines).toHaveLength(1);
  });

  it("two conflicts: nothing moved, NO ledger line, the sentinel stays pending", () => {
    const spy = conflicts(2);
    let r;
    try {
      r = apply([{ entryId: "got-017", decision: "archive" }]);
    } finally {
      spy.mockRestore();
    }
    expect(r).toMatchObject({ ok: false, recorded: true, error: expect.stringMatching(/press Archive again/) });
    expect(readFileSync(join(kb, "gotchas.jsonl"), "utf8")).toContain('"got-017"');
    expect(existsSync(join(reports, "decisions.jsonl"))).toBe(false);
    expect(readArchivePending(reports)?.ids).toEqual(["got-017"]);
  });

  it("refuses an id that sits on two live lines and moves nothing", () => {
    writeFileSync(join(kb, "gotchas.jsonl"), [line("got-001"), line("got-017"), line("got-017")].join("\n") + "\n");
    const before = readFileSync(join(kb, "gotchas.jsonl"), "utf8");
    const r = apply([{ entryId: "got-017", decision: "archive" }]);
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/more than one line/) });
    expect(readFileSync(join(kb, "gotchas.jsonl"), "utf8")).toBe(before);
    expect(existsSync(join(kb, "archive"))).toBe(false);
    expect(existsSync(join(reports, "decisions.jsonl"))).toBe(false);
  });
});

describe("reconcileArchivePending", () => {
  const ledger = (l: DecisionLine[]) => append2(reports, l);

  it("P1 repro: an entry the owner restored with git checkout (in BOTH files) is never re-archived at boot", () => {
    apply([{ entryId: "got-017", decision: "archive" }]);
    // Owner undoes it: the live line comes back, the archive copy stays.
    writeFileSync(join(kb, "gotchas.jsonl"), [line("got-001"), line("got-017"), line("got-040"), line("got-041")].join("\n") + "\n");
    const before = readFileSync(join(kb, "gotchas.jsonl"), "utf8");
    expect(reconcileArchivePending(kb, reports, ledger)).toEqual([]);
    expect(readFileSync(join(kb, "gotchas.jsonl"), "utf8")).toBe(before);
  });

  it("finishes an archive the sentinel proves was interrupted, writes its ledger line and clears the sentinel", () => {
    // Crash right after the sentinel, before any move.
    writeArchivePending(reports, { v: 1, runId: REPORT.runId, ts: 777, ids: ["got-017"] });
    expect(reconcileArchivePending(kb, reports, ledger)).toEqual(["got-017"]);
    expect(readFileSync(join(kb, "gotchas.jsonl"), "utf8")).not.toContain('"got-017"');
    expect(readDecisions(reports).lines).toEqual([
      expect.objectContaining({ entryId: "got-017", decision: "archive", ts: 777, runId: REPORT.runId }),
    ]);
    expect(readArchivePending(reports)).toBeNull();
  });

  it("finishes a half-done move (in both files) when the sentinel is present", () => {
    mkdirSync(join(kb, "archive"));
    writeFileSync(join(kb, "archive", "gotchas.jsonl"), line("got-017") + "\n");
    writeArchivePending(reports, { v: 1, runId: REPORT.runId, ts: 777, ids: ["got-017"] });
    expect(reconcileArchivePending(kb, reports, ledger)).toEqual(["got-017"]);
    expect(readFileSync(join(kb, "archive", "gotchas.jsonl"), "utf8").trim().split("\n")).toHaveLength(1);
  });
});
