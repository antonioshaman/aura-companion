// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  AFK_ENTRY_MAX_BYTES,
  AFK_SUMMARY_MARKER_V1,
  AUTO_PROCEED_TRACE_SCHEMA_VERSION,
  appendAfkSummary,
  ensureCouncilStateDir,
  readAutoProceedTrace,
  writeAutoProceedTrace,
  type AutoProceedTrace,
} from "./auto-proceed-state.js";

const VALID_GROUP_ID = "grp_4469a4c2bb3d1c4ac621d4cd9ae67bd9";

const VALID_TRACE: AutoProceedTrace = {
  schemaVersion: AUTO_PROCEED_TRACE_SCHEMA_VERSION,
  sessionGroupId: VALID_GROUP_ID,
  iterationCount: 1,
  firedAt: ["2026-05-14T16:00:00.000Z"],
  cappedAt: null,
  lastObjectiveGateResult: null,
};

let workspaceRoot: string;

beforeEach(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), "auto-proceed-state-"));
});

afterEach(() => {
  rmSync(workspaceRoot, { recursive: true, force: true });
});

describe("ensureCouncilStateDir", () => {
  it("creates <workspaceRoot>/.council/state/ on first call", () => {
    const out = ensureCouncilStateDir(workspaceRoot);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.stateDir).toBe(join(workspaceRoot, ".council", "state"));
  });

  it("is idempotent — second call returns the same path with no error", () => {
    const a = ensureCouncilStateDir(workspaceRoot);
    const b = ensureCouncilStateDir(workspaceRoot);
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) expect(a.stateDir).toBe(b.stateDir);
  });

  it("rejects relative workspaceRoot via the path-error contract", () => {
    expect(ensureCouncilStateDir("relative/dir")).toEqual({
      ok: false,
      error: { kind: "invalid-workspace-root", reason: "not-absolute" },
    });
  });
});

describe("writeAutoProceedTrace + readAutoProceedTrace — round trip", () => {
  beforeEach(() => {
    ensureCouncilStateDir(workspaceRoot);
  });

  it("written trace reads back bit-identical", () => {
    const w = writeAutoProceedTrace(workspaceRoot, VALID_GROUP_ID, VALID_TRACE);
    expect(w).toEqual({ ok: true });
    const r = readAutoProceedTrace(workspaceRoot, VALID_GROUP_ID);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual(VALID_TRACE);
  });

  it("subsequent writes replace the previous trace (whole-file atomic)", () => {
    writeAutoProceedTrace(workspaceRoot, VALID_GROUP_ID, VALID_TRACE);
    const updated: AutoProceedTrace = {
      ...VALID_TRACE,
      iterationCount: 5,
      firedAt: [
        "2026-05-14T16:00:00.000Z",
        "2026-05-14T16:05:00.000Z",
        "2026-05-14T16:10:00.000Z",
      ],
      lastObjectiveGateResult: "pass",
    };
    writeAutoProceedTrace(workspaceRoot, VALID_GROUP_ID, updated);
    const r = readAutoProceedTrace(workspaceRoot, VALID_GROUP_ID);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual(updated);
  });

  it("cappedAt round-trips ISO timestamp + lastObjectiveGateResult round-trips 'pass'/'fail'", () => {
    const capped: AutoProceedTrace = {
      ...VALID_TRACE,
      iterationCount: 10,
      cappedAt: "2026-05-14T17:00:00.000Z",
      lastObjectiveGateResult: "fail",
    };
    writeAutoProceedTrace(workspaceRoot, VALID_GROUP_ID, capped);
    const r = readAutoProceedTrace(workspaceRoot, VALID_GROUP_ID);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.cappedAt).toBe("2026-05-14T17:00:00.000Z");
      expect(r.value.lastObjectiveGateResult).toBe("fail");
    }
  });
});

describe("readAutoProceedTrace — drop reasons", () => {
  beforeEach(() => {
    ensureCouncilStateDir(workspaceRoot);
  });

  it("returns missing when the trace file does not exist", () => {
    const r = readAutoProceedTrace(workspaceRoot, VALID_GROUP_ID);
    expect(r).toEqual({ ok: false, error: { kind: "missing" } });
  });

  it("returns invalid-json on malformed JSON", () => {
    const tracePath = join(
      workspaceRoot,
      ".council",
      "state",
      `${VALID_GROUP_ID}-auto-proceed-trace.json`,
    );
    writeFileSync(tracePath, "{not-json", "utf8");
    const r = readAutoProceedTrace(workspaceRoot, VALID_GROUP_ID);
    expect(r).toEqual({ ok: false, error: { kind: "invalid-json" } });
  });

  it("returns schema-version-mismatch LOUDLY on unknown schemaVersion (never silent-default)", () => {
    // Forward-compat tripwire — a partial deploy with v2 trace files
    // landing on a v1 reader must NOT silently coerce. Loud rejection
    // surfaces the mismatch and the caller can decide policy.
    const tracePath = join(
      workspaceRoot,
      ".council",
      "state",
      `${VALID_GROUP_ID}-auto-proceed-trace.json`,
    );
    writeFileSync(
      tracePath,
      JSON.stringify({ schemaVersion: 2, sessionGroupId: VALID_GROUP_ID, iterationCount: 0, firedAt: [], cappedAt: null, lastObjectiveGateResult: null }),
      "utf8",
    );
    const r = readAutoProceedTrace(workspaceRoot, VALID_GROUP_ID);
    expect(r).toEqual({ ok: false, error: { kind: "schema-version-mismatch", got: 2 } });
  });

  it.each([
    ["missing sessionGroupId", { ...VALID_TRACE, sessionGroupId: "" }, "sessionGroupId"],
    ["negative iterationCount", { ...VALID_TRACE, iterationCount: -1 }, "iterationCount"],
    ["non-integer iterationCount", { ...VALID_TRACE, iterationCount: 1.5 }, "iterationCount"],
    ["firedAt not array", { ...VALID_TRACE, firedAt: "not-array" as unknown }, "firedAt"],
    ["firedAt with bad timestamp", { ...VALID_TRACE, firedAt: ["not-iso"] }, "firedAt[]"],
    ["cappedAt invalid type", { ...VALID_TRACE, cappedAt: "not-iso" }, "cappedAt"],
    [
      "lastObjectiveGateResult invalid value",
      { ...VALID_TRACE, lastObjectiveGateResult: "maybe" as "pass" | "fail" },
      "lastObjectiveGateResult",
    ],
  ])("returns invalid-shape for %s", (_label, payload, expectedField) => {
    const tracePath = join(
      workspaceRoot,
      ".council",
      "state",
      `${VALID_GROUP_ID}-auto-proceed-trace.json`,
    );
    writeFileSync(tracePath, JSON.stringify(payload), "utf8");
    const r = readAutoProceedTrace(workspaceRoot, VALID_GROUP_ID);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe("invalid-shape");
      if (r.error.kind === "invalid-shape") {
        expect(r.error.field).toBe(expectedField);
      }
    }
  });

  it("propagates a path-error when groupId is malformed", () => {
    const r = readAutoProceedTrace(workspaceRoot, "not-a-group-id");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("path-error");
  });
});

describe("writeAutoProceedTrace — input validation", () => {
  beforeEach(() => {
    ensureCouncilStateDir(workspaceRoot);
  });

  it("rejects payload with wrong schemaVersion BEFORE any disk write", () => {
    const bad = { ...VALID_TRACE, schemaVersion: 999 } as AutoProceedTrace;
    const w = writeAutoProceedTrace(workspaceRoot, VALID_GROUP_ID, bad);
    expect(w.ok).toBe(false);
    // And the file MUST NOT exist on disk after rejection.
    const r = readAutoProceedTrace(workspaceRoot, VALID_GROUP_ID);
    expect(r).toEqual({ ok: false, error: { kind: "missing" } });
  });

  it("rejects payload with negative iterationCount", () => {
    const bad = { ...VALID_TRACE, iterationCount: -1 };
    const w = writeAutoProceedTrace(workspaceRoot, VALID_GROUP_ID, bad);
    expect(w.ok).toBe(false);
    if (!w.ok && w.error.kind === "invalid-shape") {
      expect(w.error.field).toBe("iterationCount");
    }
  });

  it("rejects malformed groupId via path-error", () => {
    const w = writeAutoProceedTrace(workspaceRoot, "not-a-group-id", VALID_TRACE);
    expect(w.ok).toBe(false);
    if (!w.ok) expect(w.error.kind).toBe("path-error");
  });
});

describe("appendAfkSummary — first call creates marker, subsequent calls append", () => {
  beforeEach(() => {
    ensureCouncilStateDir(workspaceRoot);
  });

  it("writes the marker line on first call before the entry", () => {
    const out = appendAfkSummary(workspaceRoot, VALID_GROUP_ID, "decision 1");
    expect(out).toEqual({ ok: true });
    const summaryPath = join(
      workspaceRoot,
      ".council",
      "state",
      `${VALID_GROUP_ID}-afk-summary.md`,
    );
    const contents = readFileSync(summaryPath, "utf8");
    expect(contents).toBe(`${AFK_SUMMARY_MARKER_V1}\ndecision 1\n`);
  });

  it("appends each subsequent entry on its own line, marker stays canonical first line", () => {
    appendAfkSummary(workspaceRoot, VALID_GROUP_ID, "decision 1");
    appendAfkSummary(workspaceRoot, VALID_GROUP_ID, "decision 2");
    appendAfkSummary(workspaceRoot, VALID_GROUP_ID, "decision 3");
    const summaryPath = join(
      workspaceRoot,
      ".council",
      "state",
      `${VALID_GROUP_ID}-afk-summary.md`,
    );
    const lines = readFileSync(summaryPath, "utf8").split("\n");
    expect(lines[0]).toBe(AFK_SUMMARY_MARKER_V1);
    expect(lines[1]).toBe("decision 1");
    expect(lines[2]).toBe("decision 2");
    expect(lines[3]).toBe("decision 3");
  });

  it("accepts an entry that already ends with a newline (no double-NL)", () => {
    appendAfkSummary(workspaceRoot, VALID_GROUP_ID, "already-newline\n");
    const summaryPath = join(
      workspaceRoot,
      ".council",
      "state",
      `${VALID_GROUP_ID}-afk-summary.md`,
    );
    expect(readFileSync(summaryPath, "utf8")).toBe(
      `${AFK_SUMMARY_MARKER_V1}\nalready-newline\n`,
    );
  });
});

describe("appendAfkSummary — drop reasons", () => {
  beforeEach(() => {
    ensureCouncilStateDir(workspaceRoot);
  });

  it("rejects entry larger than AFK_ENTRY_MAX_BYTES (4 KiB POSIX PIPE_BUF floor)", () => {
    // The atomicity guarantee depends on the entry fitting in a single
    // write(2). The appender hard-rejects rather than silently
    // splitting; callers must truncate ahead of time.
    const big = "x".repeat(AFK_ENTRY_MAX_BYTES + 10);
    const out = appendAfkSummary(workspaceRoot, VALID_GROUP_ID, big);
    expect(out.ok).toBe(false);
    if (!out.ok && out.error.kind === "entry-too-large") {
      expect(out.error.sizeBytes).toBeGreaterThan(AFK_ENTRY_MAX_BYTES);
      expect(out.error.maxBytes).toBe(AFK_ENTRY_MAX_BYTES);
    }
  });

  it("rejects entry containing NUL byte (would corrupt downstream Markdown render)", () => {
    const out = appendAfkSummary(workspaceRoot, VALID_GROUP_ID, "before\0after");
    expect(out).toEqual({ ok: false, error: { kind: "entry-contains-nul" } });
  });

  it("refuses to append to a file whose first line is not the v1 marker", () => {
    // Defends against a partial-deploy / corruption scenario where a
    // v2 (or hand-rolled) AFK summary file already exists. Silent
    // append would mix schemas; the loud rejection lets the caller
    // route to recovery.
    const summaryPath = join(
      workspaceRoot,
      ".council",
      "state",
      `${VALID_GROUP_ID}-afk-summary.md`,
    );
    writeFileSync(summaryPath, "<!-- afk-summary v2 -->\nsome content\n", "utf8");
    const out = appendAfkSummary(workspaceRoot, VALID_GROUP_ID, "new entry");
    expect(out.ok).toBe(false);
    if (!out.ok && out.error.kind === "marker-mismatch") {
      expect(out.error.firstLine).toBe("<!-- afk-summary v2 -->");
    }
  });

  it("rejects malformed groupId via path-error", () => {
    const out = appendAfkSummary(workspaceRoot, "not-a-group-id", "entry");
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.kind).toBe("path-error");
  });
});

describe("appendAfkSummary — boundary cases", () => {
  beforeEach(() => {
    ensureCouncilStateDir(workspaceRoot);
  });

  it("accepts an entry exactly at AFK_ENTRY_MAX_BYTES (minus the trailing newline)", () => {
    // Entry length budget is `MAX_BYTES - 1` so the trailing `\n`
    // fits — sanity-check the boundary so a 4096-byte entry doesn't
    // silently fail.
    const entry = "y".repeat(AFK_ENTRY_MAX_BYTES - 1);
    const out = appendAfkSummary(workspaceRoot, VALID_GROUP_ID, entry);
    expect(out).toEqual({ ok: true });
  });
});
