/**
 * Tests for the eval-local recording reader. The two behaviours that matter:
 * it correctly separates the header from entries, and it tolerates a
 * truncated/garbled trailing line instead of throwing (recordings are read
 * while being appended).
 */

import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { parseRecording, loadRecording } from "./read-recording.js";

const FX = join(__dirname, "..", "__fixtures__");

describe("parseRecording", () => {
  it("separates header from entries and exposes backendType", () => {
    const rec = loadRecording(join(FX, "claude-basic.jsonl"));
    expect(rec.header?.backend_type).toBe("claude");
    expect(rec.backendType).toBe("claude");
    expect(rec.header?.version).toBe(3);
    // 4 well-formed entries (2 result, 1 keep_alive, 1 synthetic envelope).
    expect(rec.entries.length).toBe(4);
    expect(rec.entries[0]!.ch).toBe("cli");
    expect(rec.entries[0]!.dir).toBe("in");
  });

  it("skips a truncated trailing line without throwing", () => {
    const rec = loadRecording(join(FX, "truncated-tail.jsonl"));
    // header + 1 good entry; the broken half-line is dropped.
    expect(rec.header?.backend_type).toBe("claude");
    expect(rec.entries.length).toBe(1);
    expect(rec.entries[0]!.ts).toBe(1000);
  });

  it("returns a null header when none is present", () => {
    const rec = parseRecording('{"ts":1,"dir":"in","ch":"cli","raw":"{}"}');
    expect(rec.header).toBeNull();
    expect(rec.backendType).toBe("");
    expect(rec.entries.length).toBe(1);
  });

  it("ignores blank lines and non-entry/non-header objects", () => {
    const rec = parseRecording('\n{"foo":1}\n\n{"ts":5,"dir":"out","ch":"browser","raw":"x"}\n');
    expect(rec.entries.length).toBe(1);
    expect(rec.entries[0]!.ts).toBe(5);
  });
});
