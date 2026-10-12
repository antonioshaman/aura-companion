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

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeAtomicJson } from "./atomic-write.js";
import { type ObserverReviewPayload, normalizeCodexObserverReviewRaw, parseObserverReviewPayload } from "./council-types.js";
import {
  ObserverReplyCapture,
  type ObserverReplyCaptureDeps,
  type ObserverReplyExpectation,
  buildHostObserverReview,
  extractObserverFindings,
} from "./observer-reply.js";
import { findOwnReviewForCheckpointSync, findReviewForCheckpointSync, watchReviews } from "./review-watcher.js";

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
      findExistingReview: (directory, checkpointId, sessionGroupId) =>
        findOwnReviewForCheckpointSync({ directory, checkpointId, sessionGroupId }),
      moveAside: (directory, file, asideName) => renameSync(join(directory, file), join(directory, asideName)),
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

// ── BENCH-H: group-less observer review files in a shared workspace ────────
//
// AuraBench BENCH-H (PR #330) found Codex observers writing their review as
// `.council/reviews/spawn-codex-observer.md` — no `grp_…` segment — and
// self-reporting `observer_model: "gpt-5-codex"` while the session ran
// `gpt-5.5`. Several pairs can share one `.council/` (prod checkout), so that
// name is ambiguous: two observers overwrite it and before this fix each
// pair's watcher consumed whatever was there, trusting the payload's own
// group claim and model. These tests replay the REAL group-less files
// captured on this box (fixtures README) and the REAL codex legacy turn
// frames (model `gpt-5.5`), with two groups sharing one directory and the
// real per-group watchers running.
describe("group-less observer review files (BENCH-H)", () => {
  const FIXTURES = join(__dirname, "__fixtures__", "observer-reply");
  // Group id baked into the captured schema-shaped fixture.
  const GROUP_A = "grp_cf817d385e821de93883337e81800ce7";
  const GROUP_B = "grp_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const SPAWN_A = `spawn-${GROUP_A}`;
  const SPAWN_B = `spawn-${GROUP_B}`;
  const GROUPLESS = "spawn-codex-observer.md";
  let cwd: string;
  let reviewsDir: string;
  let capture: ObserverReplyCapture;

  // Production-equivalent deps: the codex normalizer the orchestrator wires
  // into `findExistingReview`, the real ownership-checked finder, a real
  // rename for the move-aside.
  const normalizeRaw = (raw: string, provider: "claude" | "codex") =>
    provider === "codex"
      ? normalizeCodexObserverReviewRaw(raw, { observerModel: "gpt-5.5", observerCliVersion: "unknown" })
      : raw;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "obs-groupless-"));
    reviewsDir = join(cwd, ".council", "reviews");
    mkdirSync(reviewsDir, { recursive: true });
    capture = new ObserverReplyCapture({
      now: () => new Date("2026-10-08T12:00:00Z"),
      writeReview: (path, payload) => writeAtomicJson(path, payload),
      findExistingReview: (directory, checkpointId, sessionGroupId) =>
        findOwnReviewForCheckpointSync({ directory, checkpointId, sessionGroupId, normalizeRaw }),
      moveAside: (directory, file, asideName) => renameSync(join(directory, file), join(directory, asideName)),
      resolveCliVersion: () => "0.130.0",
    });
  });
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  const codexExpectation = (sessionGroupId: string, checkpointId: string): ObserverReplyExpectation => ({
    sessionGroupId,
    checkpointId,
    phase: "spawn",
    provider: "codex",
    cwd,
    fallbackModel: "gpt-5.5",
  });

  /** Replay the captured codex legacy turn (frames carry model `gpt-5.5`,
   *  final text is prose — the observer "wrote the file itself"). */
  function replayLegacyCodexTurn(sessionId: string) {
    const lines = readFileSync(join(FIXTURES, "codex-legacy-turn.jsonl"), "utf-8").split("\n").filter(Boolean);
    for (const l of lines) {
      const f = JSON.parse(l);
      if (f.type === "assistant") capture.onAssistant(sessionId, f);
    }
  }

  /** The captured group-less file, re-addressed to `groupId`. */
  function grouplessFixture(name: string, groupId: string): string {
    return readFileSync(join(FIXTURES, name), "utf-8").replaceAll(/grp_[0-9a-f]{32}/g, groupId);
  }

  /** Two real per-group watchers on the ONE shared reviews directory. */
  function startWatchers() {
    const controller = new AbortController();
    const seen: Record<string, ObserverReviewPayload[]> = { [GROUP_A]: [], [GROUP_B]: [] };
    const done = Promise.all(
      [GROUP_A, GROUP_B].map((g) =>
        watchReviews({
          directory: reviewsDir,
          signal: controller.signal,
          sessionGroupId: g,
          normalizeRaw,
          onReview: (p) => { seen[g]!.push(p); },
        }),
      ),
    );
    return { seen, stop: async () => { controller.abort(); await done; } };
  }
  const settle = () => new Promise((r) => setTimeout(r, 500));

  // Core replay: observer A writes the group-less file; neither watcher may
  // consume it. At turn end the host adopts it for A: canonical group-scoped
  // file with the host model, group-less original moved aside. Only A's
  // watcher sees the review; B sees nothing.
  it("adopts A's group-less file for A only, host-stamps the model, and hides the original from B", async () => {
    const w = startWatchers();
    capture.expect("obs_a", codexExpectation(GROUP_A, SPAWN_A));
    replayLegacyCodexTurn("obs_a");
    writeFileSync(join(reviewsDir, GROUPLESS), grouplessFixture("codex-groupless-review-schema.md", GROUP_A));
    await settle();
    // Group-less name: ambiguous → no pair's watcher consumes it.
    expect(w.seen[GROUP_A]).toHaveLength(0);
    expect(w.seen[GROUP_B]).toHaveLength(0);

    const out = capture.finalize("obs_a");
    expect(out).toMatchObject({
      kind: "adopted",
      file: `spawn-${GROUP_A}-codex-observer.md`,
      sourceFile: GROUPLESS,
      findingCount: 0,
      reportedModel: "gpt-5-codex", // the LLM's self-report…
      hostModel: "gpt-5.5", //         …loses to the frames' model
    });
    await settle();
    await w.stop();

    expect(w.seen[GROUP_A]).toHaveLength(1);
    expect(w.seen[GROUP_A]![0]).toMatchObject({
      session_group_id: GROUP_A,
      checkpoint_id: SPAWN_A,
      observer_model: "gpt-5.5",
      observer_cli_version: "0.130.0",
      reviewed_at: "2026-10-08T12:00:00.000Z",
    });
    expect(w.seen[GROUP_B]).toHaveLength(0);
    // The group-less original is gone from every reader's view: B's finder
    // and the any-group rescan only see A's canonical file.
    const files = readdirSync(reviewsDir);
    expect(files).not.toContain(GROUPLESS);
    expect(files.filter((f) => f.startsWith(`${GROUPLESS}.adopted-${GROUP_A}-`))).toHaveLength(1);
    expect(findOwnReviewForCheckpointSync({ directory: reviewsDir, checkpointId: SPAWN_A, sessionGroupId: GROUP_B })).toBeNull();
    expect(findReviewForCheckpointSync({ directory: reviewsDir, checkpointId: SPAWN_A })?.file).toBe(`spawn-${GROUP_A}-codex-observer.md`);
  });

  // Both pairs' codex observers write the SAME group-less name in turn. Each
  // host adopts only the file that names its own group, so each group ends
  // with exactly its own review — never the neighbour's.
  it("two pairs writing the same group-less name each get only their own review", async () => {
    const w = startWatchers();
    capture.expect("obs_a", codexExpectation(GROUP_A, SPAWN_A));
    replayLegacyCodexTurn("obs_a");
    writeFileSync(join(reviewsDir, GROUPLESS), grouplessFixture("codex-groupless-review-schema.md", GROUP_A));
    expect(capture.finalize("obs_a")).toMatchObject({ kind: "adopted" });

    capture.expect("obs_b", codexExpectation(GROUP_B, SPAWN_B));
    replayLegacyCodexTurn("obs_b");
    // Codex-native shape (no schema_version/model) — the other captured form.
    writeFileSync(join(reviewsDir, GROUPLESS), grouplessFixture("codex-groupless-review-native.md", GROUP_B));
    expect(capture.finalize("obs_b")).toMatchObject({ kind: "adopted", file: `spawn-${GROUP_B}-codex-observer.md` });
    await settle();
    await w.stop();

    expect(w.seen[GROUP_A]!.map((p) => [p.session_group_id, p.checkpoint_id])).toEqual([[GROUP_A, SPAWN_A]]);
    expect(w.seen[GROUP_B]!.map((p) => [p.session_group_id, p.checkpoint_id])).toEqual([[GROUP_B, SPAWN_B]]);
    expect(w.seen[GROUP_B]![0]!.observer_model).toBe("gpt-5.5");
    expect(readdirSync(reviewsDir)).not.toContain(GROUPLESS);
  });

  // The other pair overwrote the group-less file before A's turn ended: the
  // file now names B. A must NOT adopt (or move) it — A falls back to its own
  // chat reply; the file stays for B's host to adopt.
  it("never adopts a group-less file that names another group", () => {
    writeFileSync(join(reviewsDir, GROUPLESS), grouplessFixture("codex-groupless-review-schema.md", GROUP_B));
    const before = readFileSync(join(reviewsDir, GROUPLESS), "utf-8");
    capture.expect("obs_a", codexExpectation(GROUP_A, SPAWN_A));
    capture.onAssistant("obs_a", assistant([{ type: "text", text: JSON.stringify([STOP]) }], "gpt-5.5"));
    expect(capture.finalize("obs_a")).toMatchObject({ kind: "written", file: `spawn-${GROUP_A}-codex-observer.md`, findingCount: 1 });
    expect(readFileSync(join(reviewsDir, GROUPLESS), "utf-8")).toBe(before);
  });

  // A group-less file with no attributable group (the bare `[]` seen in a
  // bench instance) is not a review of anyone: the reply is used instead.
  it("ignores an unattributable group-less file and uses the reply", () => {
    writeFileSync(join(reviewsDir, GROUPLESS), "[]");
    capture.expect("obs_a", codexExpectation(GROUP_A, SPAWN_A));
    capture.onAssistant("obs_a", assistant([{ type: "text", text: "[]" }], "gpt-5.5"));
    expect(capture.finalize("obs_a")).toMatchObject({ kind: "written" });
    expect(readFileSync(join(reviewsDir, GROUPLESS), "utf-8")).toBe("[]");
  });

  // Unchanged path: a canonical group-scoped file wins over a group-less one
  // for the same checkpoint, and the host stands down exactly as before.
  it("still stands down for a canonical file even when a group-less copy also exists", () => {
    const canonical = `spawn-${GROUP_A}-codex-observer.md`;
    writeFileSync(join(reviewsDir, GROUPLESS), grouplessFixture("codex-groupless-review-schema.md", GROUP_A));
    writeFileSync(join(reviewsDir, canonical), grouplessFixture("codex-groupless-review-schema.md", GROUP_A));
    capture.expect("obs_a", codexExpectation(GROUP_A, SPAWN_A));
    replayLegacyCodexTurn("obs_a");
    expect(capture.finalize("obs_a")).toMatchObject({ kind: "skipped_existing", file: canonical });
  });

  // A failed move-aside is reported, not thrown, and the review is still
  // adopted (the group-less file stays unconsumed by any watcher).
  it("reports a failed move-aside without losing the adopted review", () => {
    const failing = new ObserverReplyCapture({
      now: () => new Date("2026-10-08T12:00:00Z"),
      writeReview: (path, payload) => writeAtomicJson(path, payload),
      findExistingReview: (directory, checkpointId, sessionGroupId) =>
        findOwnReviewForCheckpointSync({ directory, checkpointId, sessionGroupId, normalizeRaw }),
      moveAside: () => { throw new Error("EACCES"); },
      resolveCliVersion: () => undefined,
    });
    writeFileSync(join(reviewsDir, GROUPLESS), grouplessFixture("codex-groupless-review-schema.md", GROUP_A));
    failing.expect("obs_a", codexExpectation(GROUP_A, SPAWN_A));
    expect(failing.finalize("obs_a")).toMatchObject({ kind: "adopted", asideError: "EACCES", hostModel: "gpt-5.5" });
    expect(existsSync(join(reviewsDir, `spawn-${GROUP_A}-codex-observer.md`))).toBe(true);
  });

  // The observed model outlives the per-wake slot (for stamping a review
  // the watcher delivers after finalize) and is dropped on forget.
  it("remembers the frames' model per session until forget", () => {
    capture.expect("obs_a", codexExpectation(GROUP_A, SPAWN_A));
    replayLegacyCodexTurn("obs_a");
    capture.finalize("obs_a");
    expect(capture.observedModel("obs_a")).toBe("gpt-5.5");
    capture.forget("obs_a");
    expect(capture.observedModel("obs_a")).toBeUndefined();
  });
});
