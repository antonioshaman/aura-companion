// @vitest-environment jsdom
// jsdom so `?raw` fixture imports resolve the same way ws.test.ts loads them.

import { isResumeInterruptedResult } from "./resume-interrupted.js";
// EC-6 replay corpus: two REAL browser-bound result frames copied verbatim
// from a local Companion recording (only the header line is normalised):
//   1. the `--resume` bookkeeping frame (terminal_reason=aborted_streaming,
//      errors=["[ede_diagnostic] …"]) — the noise this predicate exists for;
//   2. an `api_error` result (is_error=true, no `errors`) — a real failure
//      shape that must never be mistaken for resume noise.
// Driving the recorded shape (not a hand-built object) makes CLI frame-shape
// drift (renamed field, reworded diagnostic prefix) turn this suite red.
import recordedRaw from "../__fixtures__/resume-interrupted/claude-resume-results.jsonl?raw";

function recordedResultData(): Array<Record<string, unknown>> {
  return recordedRaw
    .split("\n")
    .filter((l) => l.trim())
    .slice(1) // recorder header
    .map((l) => JSON.parse(l) as { dir: string; ch: string; raw: string })
    .filter((e) => e.dir === "out" && e.ch === "browser")
    .map((e) => (JSON.parse(e.raw) as { type: string; data: Record<string, unknown> }).data);
}

describe("isResumeInterruptedResult — replay of recorded frames", () => {
  const [aborted, apiError] = recordedResultData();

  it("loads both recorded frames with the expected terminal reasons", () => {
    // Guards the fixture itself: if it is edited, the assertions below would
    // silently test something else.
    expect(aborted.terminal_reason).toBe("aborted_streaming");
    expect(aborted.is_error).toBe(true);
    expect(apiError.terminal_reason).toBe("api_error");
    expect(apiError.is_error).toBe(true);
  });

  it("recognises the recorded --resume bookkeeping frame", () => {
    expect(isResumeInterruptedResult(aborted)).toBe(true);
  });

  it("does not match the recorded api_error frame", () => {
    expect(isResumeInterruptedResult(apiError)).toBe(false);
  });
});

describe("isResumeInterruptedResult — narrow match keeps real errors red", () => {
  const base = {
    is_error: true,
    terminal_reason: "aborted_streaming",
    errors: ["[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null"],
  };

  it("rejects the same terminal reason with a non-diagnostic error", () => {
    // A genuine abort with a human-readable error is a real failure.
    expect(isResumeInterruptedResult({ ...base, errors: ["Stream closed unexpectedly"] })).toBe(false);
  });

  it("rejects a diagnostic mixed with any other error line", () => {
    expect(
      isResumeInterruptedResult({ ...base, errors: [...base.errors, "Tool execution failed"] }),
    ).toBe(false);
  });

  it("rejects a diagnostic under a different terminal reason", () => {
    expect(isResumeInterruptedResult({ ...base, terminal_reason: "api_error" })).toBe(false);
    expect(isResumeInterruptedResult({ ...base, terminal_reason: undefined })).toBe(false);
  });

  it("rejects frames without error text or not flagged as errors", () => {
    expect(isResumeInterruptedResult({ ...base, errors: [] })).toBe(false);
    expect(isResumeInterruptedResult({ ...base, errors: undefined })).toBe(false);
    expect(isResumeInterruptedResult({ ...base, is_error: false })).toBe(false);
    expect(isResumeInterruptedResult(null)).toBe(false);
    expect(isResumeInterruptedResult(undefined)).toBe(false);
  });

  it("never matches a Codex-synthesised result (no errors / terminal_reason)", () => {
    // Shape produced by codex-adapter handleTurnCompleted for a failed or
    // interrupted turn — Codex has no counterpart of the resume noise.
    expect(
      isResumeInterruptedResult({ is_error: true, errors: undefined, terminal_reason: undefined }),
    ).toBe(false);
  });
});
