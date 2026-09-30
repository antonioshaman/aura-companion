/**
 * P3/B1 — host-built observer reviews.
 *
 * The observer now replies with a bare findings array; `observer-reply.ts`
 * extracts it, stamps the envelope from HOST facts (checkpoint identity from
 * the dispatched wake, server clock, provider from the pairing, model from the
 * observer's own frames, CLI version from the init handshake) and writes the
 * review file the existing watcher/grounding/UI/eval consumers already read.
 *
 * Covered here:
 *  - extraction: accepted reply shapes, and fail-closed rejection reasons;
 *  - envelope: host fields win, native finding shapes map, invalid findings
 *    reject with the parser's field (no partial review is ever written);
 *  - capture: text-after-last-tool rule, model provenance, transition
 *    stand-down when the observer wrote the file itself, rejection streaks;
 *  - EC-6 replay on captured Claude AND Codex observer turns (fixtures in
 *    `__fixtures__/observer-reply/`, provenance in its README).
 */

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeAtomicJson } from "./atomic-write.js";
import { parseObserverReviewPayload } from "./council-types.js";
import {
  ObserverReplyCapture,
  type ObserverReplyCaptureDeps,
  type ObserverReplyExpectation,
  buildHostObserverReview,
  extractObserverFindings,
} from "./observer-reply.js";
import { findReviewForCheckpointSync } from "./review-watcher.js";

const STOP = { severity: "STOP", claim: "x is null on the retry path", evidence_path: "src/a.ts", evidence_lines: [3, 9], confidence: "high" };

describe("extractObserverFindings", () => {
  it("accepts a bare JSON array (the B1 contract)", () => {
    const r = extractObserverFindings(JSON.stringify([STOP]));
    expect(r).toEqual({ ok: true, findings: [STOP], shape: "array" });
  });

  it("accepts `[]` — an empty review is a complete review", () => {
    expect(extractObserverFindings(" [] \n")).toEqual({ ok: true, findings: [], shape: "array" });
  });

  it("accepts a legacy full envelope pasted in chat, using only its findings", () => {
    // Transition: a pre-B1 observer may emit the whole ObserverReviewPayload in
    // chat. Its self-reported envelope is ignored; the host stamps its own.
    const legacy = { schema_version: 1, checkpoint_id: "WRONG", findings: [STOP] };
    expect(extractObserverFindings(JSON.stringify(legacy))).toEqual({ ok: true, findings: [STOP], shape: "object" });
  });

  it("accepts the array inside a code fence or after a prose preamble", () => {
    // Models add fences/prose despite being told not to; the last fence wins.
    const fenced = "Here is my review:\n```json\n[]\n```\nand the final one:\n```json\n" + JSON.stringify([STOP]) + "\n```";
    expect(extractObserverFindings(fenced)).toMatchObject({ ok: true, findings: [STOP] });
    const prose = "No change since last cycle.\n" + JSON.stringify([STOP]);
    expect(extractObserverFindings(prose)).toMatchObject({ ok: true, findings: [STOP] });
  });

  it("rejects with a reason instead of guessing", () => {
    expect(extractObserverFindings("   ")).toEqual({ ok: false, reason: "empty_reply" });
    expect(extractObserverFindings("Done. The review file was written.")).toEqual({ ok: false, reason: "no_json" });
    // Valid JSON that is not a findings list (e.g. a native `{status, summary}` verdict).
    expect(extractObserverFindings('{"status":"approved","summary":"ok"}')).toEqual({ ok: false, reason: "not_findings" });
  });

  // P3/FIX-B1-2 (supervisor review 2026-09-28): the old extractor sliced from
  // the FIRST `[` to the LAST `]`, so any bracket in prose either broke a
  // real findings array (→ not_findings, review lost) or turned a sentence
  // into an EMPTY review (→ a silent "all clear"). Each case below was a
  // reproduced failure on the old code.
  describe("brackets in prose (FIX-B1-2)", () => {
    const arr = JSON.stringify([STOP]);

    it("finds the array after a prose preamble that cites a bracketed rule", () => {
      // Old: slice "[R3]…[{…}]" → JSON.parse throws → no findings.
      expect(extractObserverFindings(`Per rule [R3] this is blocking:\n${arr}`)).toEqual({ ok: true, findings: [STOP], shape: "array" });
    });

    it("finds the array when prose with brackets follows it", () => {
      // Old: slice "[{…}]\nSee [docs]" → parse error.
      expect(extractObserverFindings(`${arr}\nSee [docs] for the protocol.`)).toEqual({ ok: true, findings: [STOP], shape: "array" });
    });

    it("skips a code-ish index expression that is itself valid JSON", () => {
      // `[0]` parses as a JSON array, but a number list is not findings;
      // the real array after it must win.
      expect(extractObserverFindings(`\`foo[0]\` is read before the guard:\n${arr}`)).toEqual({ ok: true, findings: [STOP], shape: "array" });
    });

    it("never turns bracketed prose into an empty review", () => {
      // Old: "[ ]" parsed as [] → accepted as a complete, EMPTY review.
      expect(extractObserverFindings("like [ ] but here: none")).toEqual({ ok: false, reason: "not_findings" });
      expect(extractObserverFindings("Nothing to report: []")).toEqual({ ok: false, reason: "not_findings" });
      // A prose-embedded legacy envelope with no findings is equally implicit.
      expect(extractObserverFindings('Result: {"findings": []}')).toEqual({ ok: false, reason: "not_findings" });
    });

    it("still accepts an explicit empty list as the whole reply or a whole fenced block", () => {
      expect(extractObserverFindings("[]")).toEqual({ ok: true, findings: [], shape: "array" });
      expect(extractObserverFindings("No issues.\n```json\n[]\n```")).toEqual({ ok: true, findings: [], shape: "array" });
    });

    it("keeps brackets inside JSON strings from closing the span", () => {
      // A claim quoting code with `]` must not truncate the array.
      const tricky = { ...STOP, claim: 'arr[i] is read after "]" handling' };
      const reply = `See [notes]:\n${JSON.stringify([tricky])}\nthanks`;
      expect(extractObserverFindings(reply)).toEqual({ ok: true, findings: [tricky], shape: "array" });
    });

    it("takes the LAST findings-shaped span when prose carries several", () => {
      const WARN = { ...STOP, severity: "WARN", claim: "second" };
      const reply = `Draft: ${JSON.stringify([STOP])}\nFinal: ${JSON.stringify([WARN])}`;
      expect(extractObserverFindings(reply)).toMatchObject({ ok: true, findings: [WARN] });
    });

    it("stays bounded on pathological unmatched brackets", () => {
      // 20k unmatched `[` would be quadratic without the scan-start cap;
      // the result is a plain rejection, not a hang.
      expect(extractObserverFindings("[".repeat(20_000))).toEqual({ ok: false, reason: "no_json" });
    });
  });
});

describe("buildHostObserverReview", () => {
  const id = {
    sessionGroupId: "grp_b1",
    checkpointId: "chk_b1",
    phase: "council-implement",
    provider: "codex" as const,
    model: "gpt-5.5",
    cliVersion: "0.142.5",
    reviewedAt: new Date("2026-09-28T05:00:00.000Z"),
  };

  it("stamps every envelope field from host facts and passes the shared reader parser", () => {
    const r = buildHostObserverReview([STOP], id);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.payload).toEqual({
      schema_version: 1,
      checkpoint_id: "chk_b1",
      phase: "council-implement",
      session_group_id: "grp_b1",
      reviewed_at: "2026-09-28T05:00:00.000Z",
      observer_provider: "codex",
      observer_model: "gpt-5.5",
      observer_cli_version: "0.142.5",
      findings: [STOP],
    });
    // Round-trip: what the host writes is exactly what every consumer parses.
    expect(parseObserverReviewPayload(JSON.stringify(r.payload))).toEqual(r.payload);
  });

  it("maps native finding shapes the same way the file path does", () => {
    const native = { severity: "high", file: "src/a.ts", line: 4, title: "t", detail: "d" };
    const r = buildHostObserverReview([native], id);
    expect(r.ok && r.payload.findings[0]).toEqual({ severity: "WARN", claim: "t — d", evidence_path: "src/a.ts", evidence_lines: [4, 4] });
  });

  it("falls back to `unknown` for missing or non-token audit fields rather than rejecting", () => {
    const r = buildHostObserverReview([], { ...id, model: undefined, cliVersion: "not a token" });
    expect(r.ok && [r.payload.observer_model, r.payload.observer_cli_version]).toEqual(["unknown", "unknown"]);
  });

  it("rejects the whole reply on an invalid finding, naming the field", () => {
    // An absolute evidence path escapes the workspace — the parser's rule.
    const r = buildHostObserverReview([{ ...STOP, evidence_path: "/etc/passwd" }], id);
    expect(r).toMatchObject({ ok: false, reason: "invalid_findings", field: "findings.evidence_path" });
  });
});

// ── Capture ────────────────────────────────────────────────────────────────

function assistant(content: unknown[], model = "claude-opus-4-8") {
  return { type: "assistant", message: { model, content } };
}

describe("ObserverReplyCapture", () => {
  let cwd: string;
  let deps: ObserverReplyCaptureDeps;
  let capture: ObserverReplyCapture;
  const expectation = (): ObserverReplyExpectation => ({
    sessionGroupId: "grp_cap",
    checkpointId: "chk_cap",
    phase: "council-plan",
    provider: "claude",
    cwd,
    fallbackModel: "spawn-model",
  });

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "obs-reply-"));
    // Production-equivalent deps against a real temp workspace.
    deps = {
      now: () => new Date("2026-09-28T05:00:00Z"),
      writeReview: (path, payload) => writeAtomicJson(path, payload),
      findExistingReview: (directory, checkpointId, groupId) => {
        const f = findReviewForCheckpointSync({ directory, checkpointId });
        return f && f.payload.session_group_id === groupId ? f.file : null;
      },
      resolveCliVersion: () => "2.1.283",
    };
    capture = new ObserverReplyCapture(deps);
  });
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  function readReview(file: string) {
    return parseObserverReviewPayload(readFileSync(join(cwd, ".council", "reviews", file), "utf-8"));
  }

  it("writes the canonical review file from the text after the last tool call", () => {
    capture.expect("obs", expectation());
    capture.onAssistant("obs", assistant([{ type: "text", text: "Reading the plan." }]));
    capture.onAssistant("obs", assistant([{ type: "tool_use", id: "t1", name: "Read", input: {} }]));
    capture.onAssistant("obs", assistant([{ type: "text", text: JSON.stringify([STOP]) }]));
    const out = capture.finalize("obs");
    expect(out).toMatchObject({ kind: "written", file: "council-plan-grp_cap-claude-observer.md", findingCount: 1 });
    const review = readReview("council-plan-grp_cap-claude-observer.md");
    expect(review).toMatchObject({
      checkpoint_id: "chk_cap",
      session_group_id: "grp_cap",
      observer_provider: "claude",
      observer_model: "claude-opus-4-8", // from the frame, not the spawn fallback
      observer_cli_version: "2.1.283",
      reviewed_at: "2026-09-28T05:00:00.000Z",
      findings: [STOP],
    });
    // Atomic write leaves no temp files behind.
    expect(readdirSync(join(cwd, ".council", "reviews"))).toEqual(["council-plan-grp_cap-claude-observer.md"]);
  });

  it("uses the spawn-time model only when no frame carried one", () => {
    capture.expect("obs", expectation());
    capture.onAssistant("obs", { type: "assistant", message: { content: [{ type: "text", text: "[]" }] } });
    capture.finalize("obs");
    expect(readReview("council-plan-grp_cap-claude-observer.md")?.observer_model).toBe("spawn-model");
  });

  it("ignores frames for sessions without an outstanding wake, and finalize without one is a no-op", () => {
    capture.onAssistant("other", assistant([{ type: "text", text: "[]" }]));
    expect(capture.finalize("other")).toEqual({ kind: "no_expectation" });
  });

  it("stands down when the observer wrote its own review file (pre-B1 prompt)", () => {
    const file = "council-plan-grp_cap-claude-observer.md";
    const own = buildHostObserverReview([STOP], { sessionGroupId: "grp_cap", checkpointId: "chk_cap", phase: "council-plan", provider: "claude", model: "m", cliVersion: "1", reviewedAt: new Date(0) });
    if (!own.ok) throw new Error("fixture");
    writeAtomicJson(join(cwd, ".council", "reviews", file), own.payload);
    const before = readFileSync(join(cwd, ".council", "reviews", file), "utf-8");
    capture.expect("obs", expectation());
    capture.onAssistant("obs", assistant([{ type: "text", text: "Done. Review written." }]));
    expect(capture.finalize("obs")).toMatchObject({ kind: "skipped_existing", file });
    // The observer's file is untouched.
    expect(readFileSync(join(cwd, ".council", "reviews", file), "utf-8")).toBe(before);
  });

  it("does not stand down for another group's review of the same checkpoint id", () => {
    // Shared workspace: a foreign pair's file must not suppress ours (got-051).
    const foreign = buildHostObserverReview([], { sessionGroupId: "grp_other", checkpointId: "chk_cap", phase: "council-plan", provider: "claude", model: "m", cliVersion: "1", reviewedAt: new Date(0) });
    if (!foreign.ok) throw new Error("fixture");
    writeAtomicJson(join(cwd, ".council", "reviews", "council-plan-grp_other-claude-observer.md"), foreign.payload);
    capture.expect("obs", expectation());
    capture.onAssistant("obs", assistant([{ type: "text", text: "[]" }]));
    expect(capture.finalize("obs")).toMatchObject({ kind: "written" });
  });

  it("counts consecutive rejections per session and resets on success", () => {
    const bad = (checkpointId = "chk_cap") => {
      capture.expect("obs", { ...expectation(), checkpointId });
      capture.onAssistant("obs", assistant([{ type: "text", text: "looks fine to me" }]));
      return capture.finalize("obs");
    };
    expect(bad()).toMatchObject({ kind: "rejected", reason: "no_json", consecutive: 1 });
    expect(bad()).toMatchObject({ kind: "rejected", consecutive: 2 });
    capture.expect("obs", expectation());
    capture.onAssistant("obs", assistant([{ type: "text", text: "[]" }]));
    expect(capture.finalize("obs").kind).toBe("written");
    // Fresh checkpoint: chk_cap now has a review on disk (stand-down case).
    expect(bad("chk_cap_2")).toMatchObject({ kind: "rejected", consecutive: 1 });
  });

  it("reports an empty reply distinctly (no text after the last tool call)", () => {
    capture.expect("obs", expectation());
    capture.onAssistant("obs", assistant([{ type: "text", text: "[]" }]));
    capture.onAssistant("obs", assistant([{ type: "tool_use", id: "t", name: "Read", input: {} }]));
    expect(capture.finalize("obs")).toMatchObject({ kind: "rejected", reason: "empty_reply" });
  });

  it("reports a write failure without throwing", () => {
    const failing = new ObserverReplyCapture({ ...deps, writeReview: () => { throw new Error("EACCES"); } });
    failing.expect("obs", expectation());
    failing.onAssistant("obs", assistant([{ type: "text", text: "[]" }]));
    expect(failing.finalize("obs")).toMatchObject({ kind: "write_failed", error: "EACCES" });
  });

  // FIX-B1-1 regression: phase + `-grp_<32hex>` used to overflow the 64-char
  // filename prefix for any phase over 27 chars; the RangeError escaped
  // finalize() and the observer's findings were lost. A real-shaped group id
  // and a 40-char phase must still produce a written, findable review whose
  // payload keeps the FULL phase (only the filename is shortened).
  it("writes the review for a phase too long to sit beside a real group id", () => {
    const groupId = `grp_${"a".repeat(32)}`;
    const phase = "council-implement-task-07-review-fixpass"; // 40 chars
    capture.expect("obs", { ...expectation(), sessionGroupId: groupId, phase });
    capture.onAssistant("obs", assistant([{ type: "text", text: JSON.stringify([STOP]) }]));
    const out = capture.finalize("obs");
    expect(out).toMatchObject({ kind: "written", findingCount: 1 });
    if (out.kind !== "written") throw new Error("unreachable");
    expect(out.file).toMatch(new RegExp(`^council-implement-.*\\.[0-9a-f]{8}-${groupId}-claude-observer\\.md$`));
    expect(readReview(out.file)).toMatchObject({ phase, session_group_id: groupId, checkpoint_id: "chk_cap" });
    // The disk rescan (watchdog failsafe) finds it by checkpoint id.
    expect(findReviewForCheckpointSync({ directory: join(cwd, ".council", "reviews"), checkpointId: "chk_cap" })?.file).toBe(out.file);
  });

  // A name that cannot be built at all comes back as an outcome instead of
  // throwing out of the turn-done handler. A 70-char group id is a valid
  // payload token (≤128) but leaves no room in the 64-char filename prefix.
  it("reports a filename failure as an outcome without throwing", () => {
    capture.expect("obs", { ...expectation(), sessionGroupId: `grp_${"b".repeat(66)}` });
    capture.onAssistant("obs", assistant([{ type: "text", text: "[]" }]));
    expect(capture.finalize("obs")).toMatchObject({ kind: "filename_failed", error: expect.stringMatching(/combined prefix exceeds 64/) });
    expect(existsSync(join(cwd, ".council", "reviews"))).toBe(false); // nothing written
  });

  // ── EC-6 replay: captured observer turns, both providers ─────────────────
  const FIXTURES = join(__dirname, "__fixtures__", "observer-reply");
  const frames = (name: string) =>
    readFileSync(join(FIXTURES, name), "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

  function replay(name: string, provider: "claude" | "codex") {
    capture.expect("obs", { ...expectation(), provider });
    for (const f of frames(name)) {
      if (f.type === "assistant") capture.onAssistant("obs", f);
    }
    return capture.finalize("obs");
  }

  it.each([
    ["claude", "claude-reply-turn.jsonl", 6, "claude-opus-4-8"],
    ["codex", "codex-reply-turn.jsonl", 1, "gpt-5.5"],
  ] as const)("replay %s B1 turn → host writes a valid review", (provider, fixture, count, model) => {
    const out = replay(fixture, provider);
    expect(out).toMatchObject({ kind: "written", findingCount: count, file: `council-plan-grp_cap-${provider}-observer.md` });
    const review = readReview(`council-plan-grp_cap-${provider}-observer.md`);
    expect(review?.observer_provider).toBe(provider);
    expect(review?.observer_model).toBe(model);
    expect(review?.findings).toHaveLength(count);
  });

  it.each([
    ["claude", "claude-legacy-turn.jsonl"],
    ["codex", "codex-legacy-turn.jsonl"],
  ] as const)("replay %s legacy turn without its file on disk → rejected, nothing invented", (provider, fixture) => {
    // A pre-B1 observer's prose sign-off must never be turned into a review.
    const out = replay(fixture, provider);
    expect(out).toMatchObject({ kind: "rejected" });
    expect(() => readdirSync(join(cwd, ".council", "reviews"))).toThrow();
  });
});
