/**
 * B2b (meta-diet): host-side memory of disputed observer claims.
 *
 * The motivating incident: at diet-A2-103 a Codex observer raised a STOP
 * claiming `bun run --cwd web kb:record` fails (false: verified working on the
 * host); the claim was dismissed, and at diet-A3-104 the observer raised it
 * again with different wording and a different evidence file. These tests pin
 * that a dismissal is remembered on disk and that the re-raised variant is
 * recognised, while unrelated STOPs are not.
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
  readDisputes,
  type DisputeRecord,
} from "./observer-disputes.js";
import { isObserverWriteAllowed } from "./observer-write-policy.js";
import type { BrowserObserverFinding } from "./session-types.js";

const GROUP = "grp_0123456789abcdef0123456789abcdef";
const A2_CLAIM = "`bun run --cwd web kb:record` fails: bun ignores --cwd after `run`, so the /prime usage step never executes.";
const A3_CLAIM = "CLAUDE.md tells agents to run `bun run --cwd web kb:record`; this mandatory step will fail.";

function record(claim: string, evidencePath = ".council/diet-review/A2.diff"): DisputeRecord {
  return { claim, evidencePath, source: "browser_dismiss", disputedAt: "2026-09-28T00:00:00.000Z" };
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

describe("matchDispute", () => {
  // The real incident: reworded claim, different evidence file, same command.
  it("matches the diet-A3-104 re-raise of the disputed diet-A2-103 claim via the shared command", () => {
    const m = matchDispute([record(A2_CLAIM)], A3_CLAIM);
    expect(m?.via).toBe("shared_anchor");
  });

  it("prefers same_claim, and matches it regardless of evidence path", () => {
    const m = matchDispute([record("other `bun run --cwd web kb:record` claim"), record(A2_CLAIM, "x.diff")], A2_CLAIM.toUpperCase());
    expect(m?.via).toBe("same_claim");
    expect(m?.record.evidencePath).toBe("x.diff");
  });

  it("does not match an unrelated STOP, nor a claim sharing only a short token", () => {
    expect(matchDispute([record(A2_CLAIM)], "alpha() returns the wrong value")).toBeNull();
    expect(matchDispute([record(A2_CLAIM)], "`kb:record` writes to the tracked store")).toBeNull();
    expect(matchDispute([], A2_CLAIM)).toBeNull();
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
    ];
    const { findings: out, applied } = applyDisputes(findings, [record(A2_CLAIM)]);
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
    expect(addDispute(ws, GROUP, { claim: A2_CLAIM, evidencePath: "a.diff", findingId: "fnd_1", source: "browser_dismiss" }, now))
      .toEqual({ ok: true, added: true, count: 1 });
    // Same claim modulo formatting + same path: not a second record.
    expect(addDispute(ws, GROUP, { claim: `  ${A2_CLAIM.toUpperCase()} `, evidencePath: "a.diff", source: "browser_dismiss" }, now))
      .toEqual({ ok: true, added: false, count: 1 });
    // Same claim on another path is a separate judgement (kept for forensics).
    expect(addDispute(ws, GROUP, { claim: A2_CLAIM, evidencePath: "b.diff", source: "browser_dismiss" }, now))
      .toEqual({ ok: true, added: true, count: 2 });
    const read = readDisputes(ws, GROUP);
    expect(read.ok && read.records[0]).toEqual({
      claim: A2_CLAIM,
      evidencePath: "a.diff",
      findingId: "fnd_1",
      source: "browser_dismiss",
      disputedAt: "2026-09-28T01:02:03.000Z",
    });
    const onDisk = JSON.parse(readFileSync(file(), "utf8"));
    expect(onDisk).toMatchObject({ schemaVersion: 1, sessionGroupId: GROUP });
  });

  it("evicts the oldest disputes past the per-group cap", () => {
    for (let i = 0; i < MAX_DISPUTES_PER_GROUP + 3; i++) {
      addDispute(ws, GROUP, { claim: `claim number ${i}`, evidencePath: "a.diff", source: "browser_dismiss" });
    }
    const read = readDisputes(ws, GROUP);
    expect(read.ok && read.records.length).toBe(MAX_DISPUTES_PER_GROUP);
    expect(read.ok && read.records[0]!.claim).toBe("claim number 3");
  });

  it("rejects empty / oversized input and malformed group ids without writing", () => {
    expect(addDispute(ws, GROUP, { claim: "", evidencePath: "a", source: "browser_dismiss" })).toMatchObject({ ok: false, reason: "invalid-input" });
    expect(addDispute(ws, GROUP, { claim: "x".repeat(4_001), evidencePath: "a", source: "browser_dismiss" })).toMatchObject({ ok: false, reason: "invalid-input" });
    // A traversal-shaped group id never reaches the filesystem (EC-7 wrapper).
    expect(addDispute(ws, "../../etc", { claim: "x", evidencePath: "a", source: "browser_dismiss" })).toMatchObject({ ok: false, reason: "path-error" });
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
    expect(addDispute(ws, GROUP, { claim: A2_CLAIM, evidencePath: "a.diff", source: "browser_dismiss" })).toMatchObject({ ok: true, added: true, count: 1 });
    expect(readDisputes(ws, GROUP)).toMatchObject({ ok: true, records: [{ claim: A2_CLAIM }] });
  });

  it("skips malformed rows instead of discarding every other dispute", () => {
    mkdirSync(join(ws, ".council", "state"), { recursive: true });
    writeFileSync(file(), JSON.stringify({
      schemaVersion: 1,
      disputes: [{ claim: 42 }, { ...record(A2_CLAIM), source: "observer" }, record(A2_CLAIM)],
    }));
    expect(readDisputes(ws, GROUP)).toMatchObject({ ok: true, records: [{ claim: A2_CLAIM, source: "browser_dismiss" }] });
  });

  // The dispute list suppresses banners, so the observer (an LLM reading
  // untrusted bytes) must not be able to write it.
  it("lives outside the observer's write allow-list", () => {
    expect(isObserverWriteAllowed(file(), ws)).toBe(false);
  });
});
