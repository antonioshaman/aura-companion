/**
 * Tests for the eval-local recording reader. The two behaviours that matter:
 * it correctly separates the header from entries, and it tolerates a
 * truncated/garbled trailing line instead of throwing (recordings are read
 * while being appended).
 */

import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { parseRecording, loadRecording, assertRedactedForImport } from "./read-recording.js";

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

/**
 * The real-recording import gate is refuse-by-default: a recording missing the
 * recorder's v3+ `redactionApplied:true` marker is rejected rather than
 * ingested, so an un-redacted file can never become a committed fixture.
 */
describe("assertRedactedForImport", () => {
  it("accepts a recording whose header marks redaction applied", () => {
    const rec = parseRecording(
      '{"_header":true,"version":3,"backend_type":"claude","redactionApplied":true}',
    );
    expect(() => assertRedactedForImport(rec)).not.toThrow();
  });

  it("rejects a recording with no redaction marker (pre-v3 / hand-dropped)", () => {
    const rec = parseRecording('{"_header":true,"version":2,"backend_type":"claude"}');
    expect(() => assertRedactedForImport(rec, "real-recording.jsonl")).toThrow(
      /refusing to import.*redactionApplied/s,
    );
  });

  it("rejects a recording with no header at all", () => {
    const rec = parseRecording('{"ts":1,"dir":"in","ch":"cli","raw":"{}"}');
    expect(() => assertRedactedForImport(rec)).toThrow(/redactionApplied/);
  });
});
