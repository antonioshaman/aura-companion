/**
 * B2b (meta-diet): host-side memory of disputed observer claims.
 *
 * The motivating incident: at diet-A2-103 a Codex observer raised a STOP
 * claiming `bun run --cwd web kb:record` fails (false: verified working on the
 * host); the claim was dismissed, and at diet-A3-104 the observer raised it
 * again with different wording. These tests pin that an explicit dispute is
 * remembered on disk and that a re-raised variant on the same evidence file is
 * recognised, while unrelated STOPs are not.
 *
 * FIX-B2b-1 (supervisor review, reproduced): B2b matched on any evidence path
 * and turned every "Dismiss for now" into a permanent dispute, so one quoted
 * `bun run typecheck` silenced every later STOP quoting it, in any file.
 * Matching is now scoped to the disputed file, and legacy dismissal rows
 * (`browser_dismiss`) never match.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_DISPUTES_PER_GROUP,
  addDispute,
  applyDisputes,
  claimAnchors,
  matchDispute,
  normalizeClaim,
  normalizeEvidencePath,
  readDisputes,
  type DisputeRecord,
} from "./observer-disputes.js";
import { isObserverWriteAllowed } from "./observer-write-policy.js";
import type { BrowserObserverFinding } from "./session-types.js";

const GROUP = "grp_0123456789abcdef0123456789abcdef";
const A2_CLAIM = "`bun run --cwd web kb:record` fails: bun ignores --cwd after `run`, so the /prime usage step never executes.";
const A3_CLAIM = "CLAUDE.md tells agents to run `bun run --cwd web kb:record`; this mandatory step will fail.";

function record(claim: string, evidencePath = ".council/diet-review/A2.diff"): DisputeRecord {
  return { claim, evidencePath, source: "browser_dispute", disputedAt: "2026-09-28T00:00:00.000Z" };
}

describe("normalizeClaim", () => {
  // Re-emissions differ in case, spacing and a trailing full stop; none of
  // that is a different claim.
  it("ignores case, whitespace runs and trailing punctuation", () => {
    expect(normalizeClaim("  Foo   is\tBROKEN.  ")).toBe("foo is broken");
    expect(normalizeClaim("foo is broken")).toBe("foo is broken");
  });
});

describe("claimAnchors", () => {
  // Commands (contain a space) and long code spans are distinctive; a short
  // single token like `run` or `kb:record` appears in many unrelated claims
  // and must not make two claims "the same".
  it("keeps commands and long spans, drops short single tokens", () => {
    expect([...claimAnchors(A2_CLAIM)]).toEqual(["bun run --cwd web kb:record"]);
    expect(claimAnchors("`kb:record` and `run` are fine").size).toBe(0);
    expect([...claimAnchors("see `extractIdentifiers`")]).toEqual(["extractIdentifiers"]);
  });

  it("collapses whitespace inside a span so reformatting does not break the match", () => {
    expect([...claimAnchors("`bun  run   --cwd web kb:record`")]).toEqual(["bun run --cwd web kb:record"]);
  });
});

describe("normalizeEvidencePath", () => {
  // The observer writes paths inconsistently (`./src/a.ts`, `src//a.ts`,
  // Windows separators from a Codex run); these are one file.
  it("drops ./ prefixes, collapses slashes, unifies separators, keeps case", () => {
    expect(normalizeEvidencePath(" ././src//a.ts ")).toBe("src/a.ts");
    expect(normalizeEvidencePath("src\\a.ts")).toBe("src/a.ts");
    expect(normalizeEvidencePath("Src/A.ts")).toBe("Src/A.ts");
  });
});

describe("matchDispute", () => {
  const PATH = ".council/diet-review/A2.diff";
  // The real incident, reworded claim, same command, on the disputed file.
  it("matches a reworded re-raise quoting the same command on the same evidence file", () => {
    const m = matchDispute([record(A2_CLAIM, PATH)], A3_CLAIM, `./${PATH}`);
    expect(m?.via).toBe("shared_anchor");
  });

  it("prefers same_claim over shared_anchor on the same path", () => {
    const m = matchDispute(
      [record("other `bun run --cwd web kb:record` claim", "x.diff"), record(A2_CLAIM, "x.diff")],
      A2_CLAIM.toUpperCase(),
      "x.diff",
    );
    expect(m?.via).toBe("same_claim");
    expect(m?.record.claim).toBe(A2_CLAIM);
  });

  // FIX-B2b-1: a STOP about another file is a new claim, even with the same
  // wording or the same quoted command. Before the fix both returned a match.
  it("never matches a STOP whose evidence is in a different file", () => {
    expect(matchDispute([record(A2_CLAIM, "a.diff")], A2_CLAIM, "b.diff")).toBeNull();
    const typecheck = record("`bun run typecheck` fails on the new module", "src/a.ts");
    expect(matchDispute([typecheck], "`bun run typecheck` now fails: missing export", "src/b.ts")).toBeNull();
    expect(matchDispute([typecheck], "`bun run typecheck` now fails: missing export", "src/a.ts")?.via).toBe("shared_anchor");
  });

  // FIX-B2b-1: rows written when "Dismiss for now" still created disputes are
  // not a human verdict that the claim is wrong, so they suppress nothing.
  it("ignores legacy browser_dismiss rows", () => {
    const legacy: DisputeRecord = { ...record(A2_CLAIM, PATH), source: "browser_dismiss" };
    expect(matchDispute([legacy], A2_CLAIM, PATH)).toBeNull();
  });

  it("does not match an unrelated STOP, nor a claim sharing only a short token", () => {
    expect(matchDispute([record(A2_CLAIM)], "alpha() returns the wrong value", PATH)).toBeNull();
    expect(matchDispute([record(A2_CLAIM)], "`kb:record` writes to the tracked store", PATH)).toBeNull();
    expect(matchDispute([], A2_CLAIM, PATH)).toBeNull();
  });
});

describe("applyDisputes", () => {
  const base = { evidence_path: "src/a.ts" };
  it("marks only live STOPs; NOTE, WARN and grounding-downgraded findings are left alone", () => {
    const findings: BrowserObserverFinding[] = [
      { id: "f1", severity: "STOP", claim: A3_CLAIM, ...base },
      { id: "f2", severity: "NOTE", claim: A2_CLAIM, ...base },
      { id: "f3", severity: "NOTE", claim: A2_CLAIM, wasDowngraded: true, downgradeReason: "evidence_lines_unchanged", ...base },
      { id: "f4", severity: "WARN", claim: A2_CLAIM, ...base },
      { id: "f5", severity: "STOP", claim: "alpha is broken", ...base },
      // Same claim, other file: not suppressed (FIX-B2b-1).
      { id: "f6", severity: "STOP", claim: A3_CLAIM, evidence_path: "src/b.ts" },
    ];
    const { findings: out, applied } = applyDisputes(findings, [record(A2_CLAIM, "src/a.ts")]);
    expect(applied.map((a) => [a.index, a.via])).toEqual([[0, "shared_anchor"]]);
    expect(out[0]).toMatchObject({ id: "f1", severity: "STOP", disputed: "shared_anchor" });
    expect(out.slice(1).every((f) => f.disputed === undefined)).toBe(true);
    // Input is not mutated; severity never changes.
    expect(findings[0]!.disputed).toBeUndefined();
    expect(out.map((f) => f.severity)).toEqual(findings.map((f) => f.severity));
  });
});

describe("readDisputes / addDispute (persistence)", () => {
  let ws: string;
  beforeEach(() => {
    ws = realpathSync(mkdtempSync(join(tmpdir(), "observer-disputes-")));
  });
  afterEach(() => {
    rmSync(ws, { recursive: true, force: true });
  });
  const file = () => join(ws, ".council", "state", `${GROUP}-disputes.json`);

  it("treats a missing file as no disputes", () => {
    expect(readDisputes(ws, GROUP)).toEqual({ ok: true, records: [] });
  });

  it("persists a dispute, is idempotent on claim+path, and round-trips through the file", () => {
    const now = () => new Date("2026-09-28T01:02:03.000Z");
    expect(addDispute(ws, GROUP, { claim: A2_CLAIM, evidencePath: "a.diff", findingId: "fnd_1", source: "browser_dispute" }, now))
      .toEqual({ ok: true, added: true, count: 1 });
    // Same claim modulo formatting + same path: not a second record.
    expect(addDispute(ws, GROUP, { claim: `  ${A2_CLAIM.toUpperCase()} `, evidencePath: "a.diff", source: "browser_dispute" }, now))
      .toEqual({ ok: true, added: false, count: 1 });
    // Same claim with a differently spelled but equal path: still one record.
    expect(addDispute(ws, GROUP, { claim: A2_CLAIM, evidencePath: "./a.diff", source: "browser_dispute" }, now))
      .toEqual({ ok: true, added: false, count: 1 });
    // Same claim on another path is a separate judgement.
    expect(addDispute(ws, GROUP, { claim: A2_CLAIM, evidencePath: "b.diff", source: "browser_dispute" }, now))
      .toEqual({ ok: true, added: true, count: 2 });
    const read = readDisputes(ws, GROUP);
    expect(read.ok && read.records[0]).toEqual({
      claim: A2_CLAIM,
      evidencePath: "a.diff",
      findingId: "fnd_1",
      source: "browser_dispute",
      disputedAt: "2026-09-28T01:02:03.000Z",
    });
    const onDisk = JSON.parse(readFileSync(file(), "utf8"));
    expect(onDisk).toMatchObject({ schemaVersion: 1, sessionGroupId: GROUP });
  });

  it("evicts the oldest disputes past the per-group cap", () => {
    for (let i = 0; i < MAX_DISPUTES_PER_GROUP + 3; i++) {
      addDispute(ws, GROUP, { claim: `claim number ${i}`, evidencePath: "a.diff", source: "browser_dispute" });
    }
    const read = readDisputes(ws, GROUP);
    expect(read.ok && read.records.length).toBe(MAX_DISPUTES_PER_GROUP);
    expect(read.ok && read.records[0]!.claim).toBe("claim number 3");
  });

  it("rejects empty / oversized input and malformed group ids without writing", () => {
    expect(addDispute(ws, GROUP, { claim: "", evidencePath: "a", source: "browser_dispute" })).toMatchObject({ ok: false, reason: "invalid-input" });
    expect(addDispute(ws, GROUP, { claim: "x".repeat(4_001), evidencePath: "a", source: "browser_dispute" })).toMatchObject({ ok: false, reason: "invalid-input" });
    // A traversal-shaped group id never reaches the filesystem (EC-7 wrapper).
    expect(addDispute(ws, "../../etc", { claim: "x", evidencePath: "a", source: "browser_dispute" })).toMatchObject({ ok: false, reason: "path-error" });
    expect(readDisputes(ws, "../../etc")).toEqual({ ok: false, reason: "path-error" });
  });

  // A corrupt file must not hide blockers (the caller treats a failed read as
  // "no disputes") and must not block new disputes (the add rewrites it).
  it("reports a corrupt file, then recovers on the next dispute", () => {
    mkdirSync(join(ws, ".council", "state"), { recursive: true });
    writeFileSync(file(), "{not json");
    expect(readDisputes(ws, GROUP)).toEqual({ ok: false, reason: "invalid-json" });
    writeFileSync(file(), JSON.stringify({ schemaVersion: 99, disputes: [] }));
    expect(readDisputes(ws, GROUP)).toEqual({ ok: false, reason: "invalid-shape" });
    expect(addDispute(ws, GROUP, { claim: A2_CLAIM, evidencePath: "a.diff", source: "browser_dispute" })).toMatchObject({ ok: true, added: true, count: 1 });
    expect(readDisputes(ws, GROUP)).toMatchObject({ ok: true, records: [{ claim: A2_CLAIM }] });
  });

  it("skips malformed rows instead of discarding every other dispute", () => {
    mkdirSync(join(ws, ".council", "state"), { recursive: true });
    writeFileSync(file(), JSON.stringify({
      schemaVersion: 1,
      disputes: [{ claim: 42 }, { ...record(A2_CLAIM), source: "observer" }, record(A2_CLAIM)],
    }));
    expect(readDisputes(ws, GROUP)).toMatchObject({ ok: true, records: [{ claim: A2_CLAIM, source: "browser_dispute" }] });
  });

  // Files written by the B2b build hold `browser_dismiss` rows; they must
  // still parse (the file is not "corrupt"), matchDispute then ignores them.
  it("still reads legacy browser_dismiss rows", () => {
    mkdirSync(join(ws, ".council", "state"), { recursive: true });
    writeFileSync(file(), JSON.stringify({ schemaVersion: 1, disputes: [{ ...record(A2_CLAIM), source: "browser_dismiss" }] }));
    expect(readDisputes(ws, GROUP)).toMatchObject({ ok: true, records: [{ source: "browser_dismiss" }] });
  });

  // The dispute list suppresses banners, so the observer (an LLM reading
  // untrusted bytes) must not be able to write it.
  it("lives outside the observer's write allow-list", () => {
    expect(isObserverWriteAllowed(file(), ws)).toBe(false);
  });
});
