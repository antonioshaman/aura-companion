import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_REVIEW_VERDICTS_PER_GROUP,
  applyFrozenVerdict,
  readReviewVerdicts,
  recordReviewVerdicts,
} from "./observer-review-verdicts.js";
import type { BrowserObserverFinding } from "./session-types.js";

// aura-meta-diet P4/FIX-AP-2. The host freezes the grounding verdict of each
// finding at review time so a restart never re-grounds an old STOP against a
// later checkpoint. These tests pin the file's contract: round-trip, latest
// review wins, bounded size, and every failure reported (callers fail closed).

const GROUP = "grp_0123456789abcdef0123456789abcdef";
const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function ws(): string {
  const dir = mkdtempSync(join(tmpdir(), "verdicts-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function finding(overrides: Partial<BrowserObserverFinding> = {}): BrowserObserverFinding {
  return { id: "f1", severity: "STOP", claim: "`x` breaks", evidence_path: "src/a.ts", ...overrides };
}

const file = (cwd: string) => join(cwd, ".council", "state", `${GROUP}-review-verdicts.json`);

describe("observer-review-verdicts", () => {
  // No file yet = no review recorded: an empty map, not an error.
  it("reads a missing file as empty", () => {
    expect(readReviewVerdicts(ws(), GROUP)).toEqual({ ok: true, verdicts: new Map() });
  });

  // Only grounding fields are frozen; `disputed` is re-applied live.
  it("round-trips the grounding verdict and drops non-grounding fields", () => {
    const cwd = ws();
    const r = recordReviewVerdicts(cwd, GROUP, "chk_a", [
      finding({ disputed: "same_claim" }),
      finding({ id: "f2", severity: "NOTE", wasDowngraded: true, downgradeReason: "evidence_not_in_modified_set" }),
      finding({ id: "f3", weakEvidence: "no_cited_lines" }),
    ]);
    expect(r).toEqual({ ok: true, recorded: 3 });
    const read = readReviewVerdicts(cwd, GROUP);
    if (!read.ok) throw new Error("unreadable");
    expect(read.verdicts.get("f1")).toEqual({ checkpointId: "chk_a", severity: "STOP" });
    expect(read.verdicts.get("f2")).toEqual({
      checkpointId: "chk_a", severity: "NOTE", wasDowngraded: true, downgradeReason: "evidence_not_in_modified_set",
    });
    expect(read.verdicts.get("f3")).toEqual({ checkpointId: "chk_a", severity: "STOP", weakEvidence: "no_cited_lines" });
  });

  // A re-review of the same finding id replaces the verdict (latest wins,
  // as on the live WS path).
  it("a later review of the same id overwrites its verdict", () => {
    const cwd = ws();
    recordReviewVerdicts(cwd, GROUP, "chk_a", [finding()]);
    recordReviewVerdicts(cwd, GROUP, "chk_a", [finding({ weakEvidence: "no_cited_lines" })]);
    const read = readReviewVerdicts(cwd, GROUP);
    expect(read.ok && read.verdicts.get("f1")).toEqual({ checkpointId: "chk_a", severity: "STOP", weakEvidence: "no_cited_lines" });
  });

  // Bounded: the oldest verdicts are evicted first (an evicted finding falls
  // back to raw severity in the hold restore — fail-closed).
  it("keeps at most MAX_REVIEW_VERDICTS_PER_GROUP, evicting the oldest", () => {
    const cwd = ws();
    const many = Array.from({ length: MAX_REVIEW_VERDICTS_PER_GROUP + 2 }, (_, i) => finding({ id: `f${i}` }));
    recordReviewVerdicts(cwd, GROUP, "chk_a", many);
    const read = readReviewVerdicts(cwd, GROUP);
    if (!read.ok) throw new Error("unreadable");
    expect(read.verdicts.size).toBe(MAX_REVIEW_VERDICTS_PER_GROUP);
    expect(read.verdicts.has("f0")).toBe(false);
    expect(read.verdicts.has(`f${MAX_REVIEW_VERDICTS_PER_GROUP + 1}`)).toBe(true);
  });

  // Corrupt / wrong-shape files are reported, never read as "no verdicts",
  // and never overwritten (that would drop every earlier verdict).
  it("reports a corrupt file and refuses to overwrite it", () => {
    const cwd = ws();
    mkdirSync(join(cwd, ".council", "state"), { recursive: true });
    writeFileSync(file(cwd), "{not json");
    expect(readReviewVerdicts(cwd, GROUP)).toEqual({ ok: false, reason: "invalid-json" });
    expect(recordReviewVerdicts(cwd, GROUP, "chk_a", [finding()])).toMatchObject({ ok: false, reason: "unreadable-existing" });
    expect(readFileSync(file(cwd), "utf8")).toBe("{not json");
    writeFileSync(file(cwd), JSON.stringify({ schemaVersion: 99, verdicts: [] }));
    expect(readReviewVerdicts(cwd, GROUP)).toEqual({ ok: false, reason: "invalid-shape" });
  });

  // One malformed row loses only its own verdict.
  it("skips malformed rows and keeps the rest", () => {
    const cwd = ws();
    mkdirSync(join(cwd, ".council", "state"), { recursive: true });
    writeFileSync(file(cwd), JSON.stringify({
      schemaVersion: 1,
      verdicts: [["ok", { checkpointId: "c", severity: "STOP" }], ["bad", { severity: "LOUD" }], "junk"],
    }));
    const read = readReviewVerdicts(cwd, GROUP);
    expect(read.ok && [...read.verdicts.keys()]).toEqual(["ok"]);
  });

  // An invalid group id never resolves to a path.
  it("rejects a non-group id", () => {
    expect(readReviewVerdicts(ws(), "../etc")).toEqual({ ok: false, reason: "path-error" });
  });

  // The frozen verdict replaces the re-grounded one; `disputed` survives.
  it("applyFrozenVerdict restores the review-time grounding", () => {
    const regrounded = finding({
      severity: "NOTE", wasDowngraded: true, downgradeReason: "evidence_not_in_modified_set",
      weakEvidence: "no_cited_lines", disputed: "shared_anchor",
    });
    expect(applyFrozenVerdict(regrounded, { checkpointId: "chk_a", severity: "STOP" })).toEqual(
      finding({ disputed: "shared_anchor" }),
    );
  });
});
