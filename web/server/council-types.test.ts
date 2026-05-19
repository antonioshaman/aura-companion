import { describe, expect, it } from "vitest";
import {
  COUNCIL_ARTIFACT_MAX_BYTES,
  COUNCIL_SCHEMA_VERSION,
  MAX_ARTIFACT_PATHS,
  MAX_FINDINGS_PER_REVIEW,
  PEER_MESSAGE_MAX_BYTES,
  formatPeerMessage,
  isBoundedText,
  isBoundedToken,
  isIsoTimestamp,
  parseCheckpointPayload,
  parseObserverReviewPayload,
  type CheckpointPayload,
  type ObserverReviewPayload,
} from "./council-types.js";

// ── CheckpointPayload ────────────────────────────────────────────────────────

function validCheckpoint(): CheckpointPayload {
  return {
    schema_version: COUNCIL_SCHEMA_VERSION,
    checkpoint_id: "chk-001",
    phase: "council-plan",
    sequence: 0,
    session_group_id: "grp-abc123",
    emitted_at: "2026-05-11T10:00:00.000Z",
    artifact_paths: ["PLAN-foo.md", "specs/foo.md"],
  };
}

describe("parseCheckpointPayload", () => {
  // Happy path round-trip — proves the writer/reader contract converges.
  it("accepts a well-formed payload and returns a typed object", () => {
    const raw = JSON.stringify(validCheckpoint());
    expect(parseCheckpointPayload(raw)).toEqual(validCheckpoint());
  });

  // Hunt P2: malformed JSON must not crash the watcher.
  it("returns null on invalid JSON", () => {
    expect(parseCheckpointPayload("not-json{")).toBeNull();
  });

  // Hunt P2: oversize defence — and now in UTF-8 BYTES, not UTF-16 code units.
  // A multibyte payload that "looks" short by .length but is >256KiB on disk
  // must still be rejected. This is the gap a council reviewer flagged.
  it("rejects payloads larger than COUNCIL_ARTIFACT_MAX_BYTES (UTF-8 bytes)", () => {
    const huge = "a".repeat(COUNCIL_ARTIFACT_MAX_BYTES + 1);
    expect(parseCheckpointPayload(huge)).toBeNull();
  });

  it("counts size in UTF-8 bytes, not UTF-16 code units", () => {
    // Each emoji is 4 UTF-8 bytes — `string.length` undercounts by 4×.
    // Buffer.byteLength is the correct count.
    const emoji = "🚀"; // 4 bytes
    const n = Math.ceil((COUNCIL_ARTIFACT_MAX_BYTES + 1) / 4);
    const huge = emoji.repeat(n);
    expect(parseCheckpointPayload(huge)).toBeNull();
  });

  // Fowler P6 schema versioning: a writer on a newer schema must not
  // silently pass the reader's validation.
  it("rejects mismatched schema_version", () => {
    const p = { ...validCheckpoint(), schema_version: 999 };
    expect(parseCheckpointPayload(JSON.stringify(p))).toBeNull();
  });

  // Hunt P2: phase becomes part of the filename — must reject slash/dotdot/NUL.
  it.each([
    ["empty phase", ""],
    ["slash in phase", "council/plan"],
    ["dotdot in phase", "../etc"],
    ["NUL byte in phase", "council plan"],
    ["leading dot", ".hidden"],
  ])("rejects phase: %s", (_label, badPhase) => {
    const p = { ...validCheckpoint(), phase: badPhase };
    expect(parseCheckpointPayload(JSON.stringify(p))).toBeNull();
  });

  // Hunt P10: leading-dot segments are sensitive directories.
  // A prompt-injected orchestrator could direct observer to read .env/.ssh/.git.
  // The validator must reject these explicitly, not just `..` traversal.
  it.each([
    ["absolute path", "/etc/passwd"],
    ["dotdot segment", "../secrets.env"],
    ["nested dotdot", "src/../../etc/passwd"],
    ["NUL byte", "src/foo\0.ts"],
    [".env at root", ".env"],
    [".env nested", "config/.env"],
    [".git config", ".git/config"],
    [".ssh keys", ".ssh/id_rsa"],
    [".companion envs", ".companion/envs/prod.json"],
    [".aws creds", ".aws/credentials"],
  ])("rejects unsafe artifact path: %s", (_label, badPath) => {
    const p = { ...validCheckpoint(), artifact_paths: [badPath] };
    expect(parseCheckpointPayload(JSON.stringify(p))).toBeNull();
  });

  // Persistence F6: split constant — artifact_paths uses MAX_ARTIFACT_PATHS
  // not MAX_FINDINGS, so the two limits can drift independently.
  it("accepts up to MAX_ARTIFACT_PATHS but rejects more", () => {
    const at = Array.from({ length: MAX_ARTIFACT_PATHS }, (_, i) => `file-${i}.md`);
    expect(parseCheckpointPayload(JSON.stringify({ ...validCheckpoint(), artifact_paths: at }))).not.toBeNull();
    expect(
      parseCheckpointPayload(JSON.stringify({ ...validCheckpoint(), artifact_paths: [...at, "extra.md"] })),
    ).toBeNull();
  });

  // Numeric invariants — sequence is monotonic and must be a non-negative integer.
  it.each([
    ["negative", -1],
    ["float", 1.5],
    ["NaN", Number.NaN],
    ["string", "0" as unknown as number],
  ])("rejects sequence: %s", (_label, seq) => {
    const p = { ...validCheckpoint(), sequence: seq as number };
    expect(parseCheckpointPayload(JSON.stringify(p))).toBeNull();
  });

  // Realtime F7 / Hunt #11: emitted_at must be a valid ISO timestamp,
  // not just "non-empty no-space string". Tests reject malformed timestamps.
  it.each([
    ["space-separated", "2026-05-11 10:00:00.000Z"],
    ["missing TZ", "2026-05-11T10:00:00.000"],
    ["NaN-parsed", "not-a-date"],
    ["empty", ""],
  ])("rejects emitted_at: %s", (_label, ts) => {
    const p = { ...validCheckpoint(), emitted_at: ts };
    expect(parseCheckpointPayload(JSON.stringify(p))).toBeNull();
  });
});

// ── ObserverReviewPayload ───────────────────────────────────────────────────

function validReview(): ObserverReviewPayload {
  return {
    schema_version: COUNCIL_SCHEMA_VERSION,
    checkpoint_id: "chk-001",
    phase: "council-plan",
    session_group_id: "grp-abc123",
    reviewed_at: "2026-05-11T10:05:00.000Z",
    observer_provider: "codex",
    observer_model: "gpt-5-codex",
    observer_cli_version: "1.4.0",
    findings: [
      {
        severity: "STOP",
        claim: "Task 4 conflates GroupOrchestrator with SessionOrchestrator",
        evidence_path: "PLAN-council.md",
        evidence_lines: [40, 52],
        confidence: "high",
      },
      {
        severity: "NOTE",
        claim: "Consider renaming `BackendProvider`",
        evidence_path: "PLAN-council.md",
      },
    ],
  };
}

describe("parseObserverReviewPayload", () => {
  it("accepts a well-formed review with all optional fields populated", () => {
    const raw = JSON.stringify(validReview());
    expect(parseObserverReviewPayload(raw)).toEqual(validReview());
  });

  // Hunt #11 / Realtime F7 — THE bug the council caught: multi-word `claim`
  // was silently dropped because `isBoundedString` rejected spaces. Now that
  // `isBoundedText` allows them, every realistic observer claim parses.
  it("accepts findings whose claim contains spaces, punctuation, newlines", () => {
    const p = validReview();
    p.findings[0]!.claim = "The orchestrator opens session-store before the worktree exists.\nThis races with the cleanup path on rollback.";
    expect(parseObserverReviewPayload(JSON.stringify(p))).not.toBeNull();
  });

  // Willison P1.2: severity is now four-tier (STOP|WARN|NOTE|INFO), not bipolar.
  it.each<["STOP" | "WARN" | "NOTE" | "INFO"]>([["STOP"], ["WARN"], ["NOTE"], ["INFO"]])("accepts severity: %s", (sev) => {
    const p = validReview();
    p.findings[0]!.severity = sev;
    expect(parseObserverReviewPayload(JSON.stringify(p))).not.toBeNull();
  });

  // Willison P1: strict enum still — typo'd severities must fail.
  it("rejects findings with unknown severity", () => {
    const p = validReview();
    (p.findings[0] as unknown as { severity: string }).severity = "STOPP";
    expect(parseObserverReviewPayload(JSON.stringify(p))).toBeNull();
  });

  // Willison P1.1: forensic re-run requires model+CLI version per payload.
  it("rejects review missing observer_model", () => {
    const p: Record<string, unknown> = { ...validReview() };
    delete p.observer_model;
    expect(parseObserverReviewPayload(JSON.stringify(p))).toBeNull();
  });

  it("rejects review missing observer_cli_version", () => {
    const p: Record<string, unknown> = { ...validReview() };
    delete p.observer_cli_version;
    expect(parseObserverReviewPayload(JSON.stringify(p))).toBeNull();
  });

  // Willison P3: confidence is optional but strict-enum when present.
  it("rejects unknown confidence value", () => {
    const p = validReview();
    (p.findings[0] as unknown as { confidence: string }).confidence = "very-sure";
    expect(parseObserverReviewPayload(JSON.stringify(p))).toBeNull();
  });

  // Willison P7: grounding — evidence_path must be a workspace-relative path.
  it("rejects findings with absolute evidence_path", () => {
    const p = validReview();
    p.findings[0]!.evidence_path = "/etc/passwd";
    expect(parseObserverReviewPayload(JSON.stringify(p))).toBeNull();
  });

  // evidence_lines must be a valid 1-indexed [start, end] pair with end >= start.
  it("rejects evidence_lines with end < start", () => {
    const p = validReview();
    p.findings[0]!.evidence_lines = [10, 5];
    expect(parseObserverReviewPayload(JSON.stringify(p))).toBeNull();
  });

  it("rejects evidence_lines with zero or negative start", () => {
    const p = validReview();
    p.findings[0]!.evidence_lines = [0, 5];
    expect(parseObserverReviewPayload(JSON.stringify(p))).toBeNull();
  });

  // Empty findings array is legal (observer found nothing).
  it("accepts a review with zero findings", () => {
    const p = validReview();
    p.findings = [];
    expect(parseObserverReviewPayload(JSON.stringify(p))).toEqual(p);
  });

  it("rejects a review missing schema_version", () => {
    const p: Record<string, unknown> = { ...validReview() };
    delete p.schema_version;
    expect(parseObserverReviewPayload(JSON.stringify(p))).toBeNull();
  });

  // Distinct cap for findings — split from artifact paths so the two
  // axes can be tuned independently.
  it("accepts up to MAX_FINDINGS_PER_REVIEW findings", () => {
    const p = validReview();
    p.findings = Array.from({ length: MAX_FINDINGS_PER_REVIEW }, () => ({
      severity: "NOTE" as const,
      claim: "ok",
      evidence_path: "foo.md",
    }));
    expect(parseObserverReviewPayload(JSON.stringify(p))).not.toBeNull();
  });

  // observer_provider is a token (no spaces) — multi-word provider names
  // are not supported; producers must normalise.
  it("rejects observer_provider with spaces", () => {
    const p = validReview();
    p.observer_provider = "claude code";
    expect(parseObserverReviewPayload(JSON.stringify(p))).toBeNull();
  });
});

// ── Drop-reporter (Task 13 — protocol.frame_dropped telemetry) ──────────────

describe("parseCheckpointPayload — onDrop reporter", () => {
  // The reporter is the load-bearing observability signal that surfaces
  // upstream writer drift from the first malformed frame. These tests
  // pin the categorical reason for each rejection branch so a future
  // refactor that loses a drop emission goes red.

  it("emits json-parse-error on invalid JSON", () => {
    const drops: Array<{ reason: string; field?: string }> = [];
    parseCheckpointPayload("not-json{", (reason, field) => drops.push({ reason, field }));
    expect(drops).toEqual([{ reason: "json-parse-error", field: undefined }]);
  });

  it("emits oversize on payloads > 256KB", () => {
    const drops: Array<{ reason: string; field?: string }> = [];
    const huge = JSON.stringify({ _filler: "x".repeat(300_000) });
    parseCheckpointPayload(huge, (reason, field) => drops.push({ reason, field }));
    expect(drops[0]!.reason).toBe("oversize");
  });

  it("emits schema-mismatch with field=schema_version on wrong version", () => {
    const drops: Array<{ reason: string; field?: string }> = [];
    const p = { ...validCheckpoint(), schema_version: 99 };
    parseCheckpointPayload(JSON.stringify(p), (reason, field) => drops.push({ reason, field }));
    expect(drops[0]).toEqual({ reason: "schema-mismatch", field: "schema_version" });
  });

  it("emits invalid-field with the offending field name", () => {
    const drops: Array<{ reason: string; field?: string }> = [];
    const p = { ...validCheckpoint(), checkpoint_id: "has spaces" };
    parseCheckpointPayload(JSON.stringify(p), (reason, field) => drops.push({ reason, field }));
    expect(drops[0]).toEqual({ reason: "invalid-field", field: "checkpoint_id" });
  });

  it("does not emit on a successful parse", () => {
    const drops: unknown[] = [];
    const result = parseCheckpointPayload(JSON.stringify(validCheckpoint()), () => drops.push("called"));
    expect(result).not.toBeNull();
    expect(drops).toHaveLength(0);
  });

  it("is backward compatible — onDrop is optional", () => {
    // Existing callers must continue to work without the new parameter.
    expect(parseCheckpointPayload("not-json{")).toBeNull();
    expect(parseCheckpointPayload(JSON.stringify(validCheckpoint()))).not.toBeNull();
  });
});

describe("parseObserverReviewPayload — onDrop reporter", () => {
  it("emits json-parse-error on invalid JSON", () => {
    const drops: Array<{ reason: string; field?: string }> = [];
    parseObserverReviewPayload("{not valid json", (r, f) => drops.push({ reason: r, field: f }));
    expect(drops).toEqual([{ reason: "json-parse-error", field: undefined }]);
  });

  it("emits invalid-field with field=findings.severity on bad severity", () => {
    const p = validReview();
    p.findings[0]!.severity = "PANIC" as unknown as ObserverReviewPayload["findings"][number]["severity"];
    const drops: Array<{ reason: string; field?: string }> = [];
    parseObserverReviewPayload(JSON.stringify(p), (r, f) => drops.push({ reason: r, field: f }));
    expect(drops[0]).toEqual({ reason: "invalid-field", field: "findings.severity" });
  });

  it("is backward compatible — existing single-arg callers unchanged", () => {
    expect(parseObserverReviewPayload(JSON.stringify(validReview()))).not.toBeNull();
  });
});

// ── Validator helpers (exported for reuse by other modules) ─────────────────

describe("isBoundedToken", () => {
  it("accepts plain ASCII identifiers", () => {
    expect(isBoundedToken("foo-bar_baz", 32)).toBe(true);
  });

  it.each([
    ["empty", ""],
    ["space inside", "foo bar"],
    ["leading space", " foo"],
    ["NUL byte", "foo\0bar"],
    ["tab", "foo\tbar"],
    ["newline", "foo\nbar"],
    ["DEL char", "foo\x7fbar"],
  ])("rejects token: %s", (_label, v) => {
    expect(isBoundedToken(v, 32)).toBe(false);
  });

  it("rejects oversize", () => {
    expect(isBoundedToken("a".repeat(33), 32)).toBe(false);
  });

  it("rejects non-string", () => {
    expect(isBoundedToken(42, 32)).toBe(false);
    expect(isBoundedToken(null, 32)).toBe(false);
  });
});

describe("isBoundedText", () => {
  // The opposite half of the split: text allows spaces and common
  // whitespace (tab/CR/LF) — needed for claim and other prose fields.
  it.each([
    "hello world",
    "multi\nline\ntext",
    "with\ttab",
    "trailing space ",
  ])("accepts text: %s", (v) => {
    expect(isBoundedText(v, 4_000)).toBe(true);
  });

  it.each([
    ["empty", ""],
    ["NUL byte", "hello\0world"],
    ["control byte", "hello\x01world"],
  ])("rejects text: %s", (_label, v) => {
    expect(isBoundedText(v, 4_000)).toBe(false);
  });
});

describe("isIsoTimestamp", () => {
  it.each([
    "2026-05-11T10:00:00Z",
    "2026-05-11T10:00:00.123Z",
    "2026-05-11T10:00:00+00:00",
    "2026-05-11T10:00:00.000-05:00",
  ])("accepts ISO 8601 T-form: %s", (v) => {
    expect(isIsoTimestamp(v)).toBe(true);
  });

  it.each([
    ["space-separated", "2026-05-11 10:00:00Z"],
    ["missing TZ", "2026-05-11T10:00:00"],
    ["invalid date", "2026-13-99T10:00:00Z"],
    ["not a date", "yesterday"],
    ["empty", ""],
  ])("rejects: %s", (_label, v) => {
    expect(isIsoTimestamp(v)).toBe(false);
  });
});

// ─── Peer-message formatter (bidirectional pipeline Story 2.3) ──────────────

describe("formatPeerMessage", () => {
  it("renders the [from-<role>: <severity>] tag verbatim for the AT to read", () => {
    const out = formatPeerMessage({
      sourceRole: "observer",
      severity: "STOP",
      body: "auth bypass at web/server/routes.ts:84",
      reviewPath: ".council/reviews/council-implement-claude-observer.md",
    });
    expect(out.startsWith("[from-observer: STOP] ")).toBe(true);
    expect(out).toContain("auth bypass at web/server/routes.ts:84");
  });

  it("renders orchestrator-tagged messages (bidirectional)", () => {
    const out = formatPeerMessage({
      sourceRole: "orchestrator",
      severity: "INFO",
      body: "advancing to task 4",
      reviewPath: ".council/reviews/council-plan-claude-observer.md",
    });
    expect(out.startsWith("[from-orchestrator: INFO] ")).toBe(true);
  });

  it("does NOT truncate a 1023-byte body (boundary below cap)", () => {
    // Body sized so prefix+body fits under PEER_MESSAGE_MAX_BYTES (1024).
    const prefix = "[from-observer: WARN] ";
    const headroom = PEER_MESSAGE_MAX_BYTES - Buffer.byteLength(prefix, "utf8");
    const body = "a".repeat(headroom);
    const out = formatPeerMessage({
      sourceRole: "observer",
      severity: "WARN",
      body,
      reviewPath: ".council/reviews/x.md",
    });
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(PEER_MESSAGE_MAX_BYTES);
    expect(out).not.toContain("truncated; full text:");
    expect(out.endsWith("a")).toBe(true);
  });

  it("truncates a 2048-byte body and appends audit-trail link", () => {
    const body = "x".repeat(2048);
    const reviewPath = ".council/reviews/council-implement-claude-observer.md";
    const out = formatPeerMessage({
      sourceRole: "observer",
      severity: "STOP",
      body,
      reviewPath,
    });
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(PEER_MESSAGE_MAX_BYTES);
    expect(out).toContain("truncated; full text:");
    expect(out).toContain(reviewPath);
    expect(out.startsWith("[from-observer: STOP] ")).toBe(true);
  });

  it("byte-safe truncation does not split multi-byte UTF-8 sequences", () => {
    // 4-byte rocket per code point; 600 rockets = 2400 bytes
    const body = "🚀".repeat(600);
    const out = formatPeerMessage({
      sourceRole: "observer",
      severity: "NOTE",
      body,
      reviewPath: ".council/reviews/x.md",
    });
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(PEER_MESSAGE_MAX_BYTES);
    // Output must remain valid UTF-8 — Buffer.from + back-string round-trips clean
    expect(Buffer.from(out, "utf8").toString("utf8")).toBe(out);
    // Truncation marker still present
    expect(out).toContain("truncated; full text:");
  });
});
