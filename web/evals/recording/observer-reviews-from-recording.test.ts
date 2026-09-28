/**
 * Recovery of observer reviews from raw recordings (P3/B3). Frames here are
 * synthetic but copy the exact shapes seen in `~/.companion/recordings`:
 *   - Claude: cli-out `user` wake, cli-in `assistant` tool_use `Write`,
 *     cli-in `result`;
 *   - Codex: cli-out `turn/start` wake, cli-in `item/completed` fileChange /
 *     agentMessage.
 * What is validated: every complete review shape is recovered exactly once,
 * incomplete writes are counted (never guessed), browser mirrors are ignored,
 * and B1 replies are attributed to the checkpoint of the preceding wake.
 */

import { describe, it, expect } from "vitest";
import type { LoadedRecording, RecordingEntry } from "./read-recording.js";
import {
  latestPerReview,
  parseFindingsReply,
  parseWakeText,
  recoverObserverReviews,
} from "./observer-reviews-from-recording.js";

const GROUP = "grp_0123456789abcdef0123456789abcdef";

function wakeText(checkpoint: string): string {
  const manifest = { observer_wake_payload_version: 1, session_group_id: GROUP, checkpoint_id: checkpoint, phase: "p1" };
  return `# Council Checkpoint — p1\n\nIntro.\n\n\`\`\`json\n${JSON.stringify(manifest, null, 2)}\n\`\`\`\n\nReview it.`;
}

function review(checkpoint: string, claim: string): string {
  return JSON.stringify({
    session_group_id: GROUP,
    checkpoint_id: checkpoint,
    phase: "p1",
    observer_provider: "claude",
    findings: [{ severity: "STOP", claim, evidence_path: "src/a.ts", evidence_lines: [1, 2] }],
  });
}

let ts = 1_000;
function entry(dir: "in" | "out", frame: unknown, ch: "cli" | "browser" = "cli"): RecordingEntry {
  return { ts: ts++, dir, ch, raw: JSON.stringify(frame) };
}

function rec(backend: string, entries: RecordingEntry[]): LoadedRecording {
  return { header: { _header: true, version: 3, backend_type: backend }, entries, backendType: backend };
}

const claudeUser = (text: string) => ({ type: "user", message: { role: "user", content: [{ type: "text", text }] } });
const claudeToolUse = (name: string, input: Record<string, unknown>) => ({
  type: "assistant",
  message: { model: "claude-opus-4-8", role: "assistant", content: [{ type: "tool_use", id: "t1", name, input }] },
});

describe("parseWakeText", () => {
  it("reads group/checkpoint/phase from the fenced manifest", () => {
    expect(parseWakeText(wakeText("cp-1"))).toEqual({ session_group_id: GROUP, checkpoint_id: "cp-1", phase: "p1" });
  });
  it("returns null for ordinary prompts and manifests missing ids", () => {
    expect(parseWakeText("hello")).toBeNull();
    expect(parseWakeText('```json\n{"observer_wake_payload_version":1}\n```')).toBeNull();
  });
});

describe("parseFindingsReply", () => {
  it("accepts a bare or fenced JSON array", () => {
    expect(parseFindingsReply("[]")).toEqual([]);
    expect(parseFindingsReply('```json\n[{"severity":"STOP"}]\n```')).toEqual([{ severity: "STOP" }]);
  });
  it("rejects prose, objects and broken JSON", () => {
    expect(parseFindingsReply("Review written.")).toBeNull();
    expect(parseFindingsReply('{"findings":[]}')).toBeNull();
    expect(parseFindingsReply("[{")).toBeNull();
  });
});

describe("recoverObserverReviews — Claude", () => {
  it("recovers a Write of a review file verbatim and ignores the browser mirror", () => {
    const text = review("cp-1", "bug");
    const frame = claudeToolUse("Write", { file_path: "/w/.council/reviews/cp-1-claude-observer.md", content: text });
    const r = recoverObserverReviews(rec("claude", [entry("in", frame), entry("out", frame, "browser")]), "rec");
    expect(r.reviews).toHaveLength(1);
    expect(r.reviews[0]!.text).toBe(text); // verbatim → same finding ids as on disk
    expect(r.unrecoverable).toBe(0);
  });

  it("ignores writes to non-review paths and counts Edits of a review file as unrecoverable", () => {
    const r = recoverObserverReviews(
      rec("claude", [
        entry("in", claudeToolUse("Write", { file_path: "/w/src/a.ts", content: "x" })),
        entry("in", claudeToolUse("Edit", { file_path: "/w/.council/reviews/cp-1-claude-observer.md" })),
      ]),
      "rec",
    );
    expect(r.reviews).toEqual([]);
    expect(r.unrecoverable).toBe(1);
  });

  it("builds a host envelope for a B1 bare-array reply using the preceding wake", () => {
    const findings = [{ severity: "WARN", claim: "c", evidence_path: "src/a.ts" }];
    const r = recoverObserverReviews(
      rec("claude", [
        entry("out", claudeUser(wakeText("cp-7"))),
        entry("in", claudeToolUse("Read", { file_path: "/w/src/a.ts" })),
        entry("in", { type: "result", result: JSON.stringify(findings) }),
      ]),
      "rec",
    );
    expect(r.reviews).toHaveLength(1);
    const doc = JSON.parse(r.reviews[0]!.text);
    expect(doc).toMatchObject({
      session_group_id: GROUP,
      checkpoint_id: "cp-7",
      observer_provider: "claude",
      observer_model: "claude-opus-4-8",
      findings,
    });
  });

  it("drops a reply with no wake in scope, and a prose result", () => {
    const r = recoverObserverReviews(
      rec("claude", [
        entry("in", { type: "result", result: "[]" }),
        entry("out", claudeUser(wakeText("cp-8"))),
        entry("in", { type: "result", result: "Review written." }),
      ]),
      "rec",
    );
    expect(r.reviews).toEqual([]);
  });
});

describe("recoverObserverReviews — Codex", () => {
  const fileChange = (kind: string, diff: string) => ({
    method: "item/completed",
    params: { item: { type: "fileChange", changes: [{ path: "/w/.council/reviews/cp-2-codex-observer.md", kind: { type: kind }, diff }] } },
  });

  it("recovers an `add` fileChange and counts an `update` patch as unrecoverable", () => {
    const text = review("cp-2", "bug");
    const r = recoverObserverReviews(
      rec("codex", [entry("in", fileChange("add", text)), entry("in", fileChange("update", "@@ -1 +1 @@"))]),
      "rec",
    );
    expect(r.reviews.map((x) => x.text)).toEqual([text]);
    expect(r.unrecoverable).toBe(1);
  });

  it("attributes an agentMessage bare-array reply to the turn/start wake", () => {
    const r = recoverObserverReviews(
      rec("codex", [
        entry("out", { method: "turn/start", params: { input: [{ type: "text", text: wakeText("cp-9") }] } }),
        entry("in", { method: "item/completed", params: { item: { type: "agentMessage", text: "[]" } } }),
      ]),
      "rec",
    );
    expect(JSON.parse(r.reviews[0]!.text)).toMatchObject({ checkpoint_id: "cp-9", observer_provider: "codex", findings: [] });
  });
});

describe("latestPerReview", () => {
  it("keeps only the last write per (group, checkpoint, provider) and passes unparseable docs through", () => {
    const first = { name: "a", text: review("cp-1", "old"), ts: 1 };
    const second = { name: "b", text: review("cp-1", "new"), ts: 5 };
    const other = { name: "c", text: review("cp-2", "x"), ts: 3 };
    const junk = { name: "d", text: "not json", ts: 4 };
    const out = latestPerReview([second, first, other, junk]);
    expect(out.map((r) => r.name).sort()).toEqual(["b", "c", "d"]);
  });
});
