/**
 * Council Review 2026-05-13 Realtime/Willison/Beck #7 (EC-6 fixture):
 * load the pinned wake-frame fixture and assert the on-wire bytes still
 * round-trip through the consumer-side parser. Convention EC-6 says load-
 * bearing protocol parsers need replay-based regression tests against
 * captured recordings — the wake frame is the first server-initiated
 * `user` NDJSON path in the codebase and qualifies.
 *
 * Also covers Council Review 2026-05-13 Realtime #8 (content-shape
 * asymmetry between `handleOutgoingUserMessage`'s plain-string content
 * and `sendUserFrameFromServer`'s array-of-one-text-block content) by
 * pinning the array shape as the canonical wake shape. A future
 * "normalisation" refactor that flips this shape will fail the test.
 */

import { describe, expect, it } from "vitest";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { buildObserverWakePayload } from "./observer-prompt.js";
import { parseCheckpointPayload } from "./council-types.js";

const FIXTURE_PATH = fileURLToPath(
  new URL("./__fixtures__/observer-wake/claude-v1.jsonl", import.meta.url),
);

describe("observer wake fixture (EC-6 replay)", () => {
  it("the pinned wake frame is a single NDJSON line", () => {
    const raw = readFileSync(FIXTURE_PATH, "utf-8");
    // Allow a single trailing newline (the NDJSON line-terminator).
    const lines = raw.split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(1);
  });

  it("the wake frame parses as a `user` NDJSON envelope with array-content shape", () => {
    const raw = readFileSync(FIXTURE_PATH, "utf-8").trim();
    const parsed = JSON.parse(raw);
    expect(parsed.type).toBe("user");
    expect(parsed.message.role).toBe("user");
    expect(Array.isArray(parsed.message.content)).toBe(true);
    expect(parsed.message.content).toHaveLength(1);
    expect(parsed.message.content[0].type).toBe("text");
    expect(parsed.parent_tool_use_id).toBeNull();
    expect(parsed.session_id).toBe("");
  });

  it("the inner JSON block (fenced) parses as a CheckpointPayload", () => {
    const raw = readFileSync(FIXTURE_PATH, "utf-8").trim();
    const parsed = JSON.parse(raw);
    const body: string = parsed.message.content[0].text;
    const fenceMatch = /```json\n([\s\S]*?)\n```/.exec(body);
    expect(fenceMatch).not.toBeNull();
    const jsonText = fenceMatch![1];
    const payload = JSON.parse(jsonText);
    // Echo-first key order — observer's autoregressive parse sees the
    // schema discriminator before any content.
    expect(Object.keys(payload).slice(0, 5)).toEqual([
      "observer_wake_payload_version",
      "session_group_id",
      "checkpoint_id",
      "phase",
      "checkpoint_seq",
    ]);
    expect(payload.observer_wake_payload_version).toBe(1);
  });

  it("the body's outer JSON block content validates against a hand-rolled CheckpointPayload (round-trip)", () => {
    // Convert the wake's inner block into a CheckpointPayload-shaped
    // object and assert it parses. The wake's `checkpoint_seq` is the
    // CheckpointPayload's `sequence`; the wake-builder renames the
    // field at serialise time, so we map back here.
    const raw = readFileSync(FIXTURE_PATH, "utf-8").trim();
    const parsed = JSON.parse(raw);
    const body: string = parsed.message.content[0].text;
    const fenceMatch = /```json\n([\s\S]*?)\n```/.exec(body);
    const wakeInner = JSON.parse(fenceMatch![1]);
    const checkpointShape = {
      schema_version: 1,
      checkpoint_id: wakeInner.checkpoint_id,
      phase: wakeInner.phase,
      sequence: wakeInner.checkpoint_seq,
      session_group_id: wakeInner.session_group_id,
      emitted_at: "2026-01-01T00:00:00Z",
      artifact_paths: wakeInner.delta,
    };
    const reparsed = parseCheckpointPayload(JSON.stringify(checkpointShape));
    expect(reparsed).not.toBeNull();
    expect(reparsed?.checkpoint_id).toBe("chk_fixture");
  });

  it("the live builder, given the same inputs, produces a body that round-trips through the same parsers", () => {
    // This is the producer-side canary. If the builder's output shape
    // drifts, the unit asserts in this file stay green but THIS test
    // fails — the round-trip through the consumer-side parsers is what
    // pins the wire contract.
    const tmp = mkdtempSync(join(tmpdir(), "wake-fixture-test-"));
    try {
      writeFileSync(join(tmp, "src"), ""); // makes 'src/' look like an existing file path; harmless
      // The builder requires workspace-existing parent dirs for the
      // realpath check; the path 'src/foo.ts' resolves with parent
      // climb to the tmp dir, which exists.
      const result = buildObserverWakePayload({
        checkpoint: {
          session_group_id: "grp_fixture",
          checkpoint_id: "chk_fixture",
          phase: "council-plan",
          sequence: 1,
        },
        manifest: { delta: ["src/foo.ts"], carried: [], dropped: [] },
        workspaceRoot: tmp,
        observerProvider: "claude",
      });
      expect(result.textBody).toContain("# Council Checkpoint — council-plan");
      expect(result.textBody).toContain("```json");
      const fenceMatch = /```json\n([\s\S]*?)\n```/.exec(result.textBody);
      expect(fenceMatch).not.toBeNull();
      const wakeInner = JSON.parse(fenceMatch![1]);
      expect(wakeInner.observer_wake_payload_version).toBe(1);
      expect(wakeInner.session_group_id).toBe("grp_fixture");
      expect(wakeInner.checkpoint_id).toBe("chk_fixture");
      expect(wakeInner.checkpoint_seq).toBe(1);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  // Council Review 2026-05-13-0150 Realtime × Beck #13: byte-compare the
  // pinned fixture against what the live builder emits. The prior
  // round-trip test only checked structural properties — a drift
  // between fixture and builder (e.g., builder gains a new prose line)
  // would pass the structural test but fail the contract this fixture
  // pins. This is the EC-6-grade producer canary.
  it("live builder output byte-matches the pinned fixture for canonical inputs", () => {
    const tmp = mkdtempSync(join(tmpdir(), "wake-fixture-bytematch-"));
    try {
      const result = buildObserverWakePayload({
        checkpoint: {
          session_group_id: "grp_fixture",
          checkpoint_id: "chk_fixture",
          phase: "council-plan",
          sequence: 1,
        },
        manifest: { delta: ["src/foo.ts"], carried: [], dropped: [] },
        workspaceRoot: tmp,
        observerProvider: "claude",
      });
      // Wrap the body in the exact NDJSON envelope the adapter would
      // build at send time (see claude-adapter.ts sendUserFrameFromServer).
      const frame = JSON.stringify({
        type: "user",
        message: { role: "user", content: [{ type: "text", text: result.textBody }] },
        parent_tool_use_id: null,
        session_id: "",
      });
      const fixtureRaw = readFileSync(FIXTURE_PATH, "utf-8").trim();
      // Byte-equal comparison — drift in builder output (extra
      // whitespace, key reorder, content change) fails this test.
      expect(frame).toBe(fixtureRaw);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
