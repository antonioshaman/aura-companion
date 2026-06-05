import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  existsSync,
  utimesSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  SessionRecorder,
  RecorderManager,
  redactRaw,
  REDACTED_PLACEHOLDER,
  RECORDING_HEADER_VERSION,
  RECORDING_HEADER_VERSIONS_ACCEPTED,
} from "./recorder.js";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "recorder-test-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function readDirSafe(dir: string): string[] {
  try {
    return readdirSync(dir) as string[];
  } catch {
    return [];
  }
}

/**
 * Create a fake JSONL recording file with a given number of entry lines.
 * Returns the full path. The header counts as 1 line, so total lines = 1 + entryCount.
 */
function createFakeRecording(
  dir: string,
  filename: string,
  entryCount: number,
  mtime?: Date,
): string {
  const header = JSON.stringify({
    _header: true,
    version: 1,
    session_id: "fake",
    backend_type: "claude",
    started_at: Date.now(),
    cwd: "/fake",
  });
  const entry = JSON.stringify({ ts: Date.now(), dir: "in", raw: "x", ch: "cli" });
  const lines = [header, ...Array(entryCount).fill(entry)];
  const filePath = join(dir, filename);
  writeFileSync(filePath, lines.join("\n") + "\n");
  if (mtime) {
    utimesSync(filePath, mtime, mtime);
  }
  return filePath;
}

// ─── SessionRecorder ─────────────────────────────────────────────────────────

describe("SessionRecorder", () => {
  it("writes a header as the first line with correct metadata", () => {
    const rec = new SessionRecorder("sess-1", "claude", "/project", tempDir);
    rec.close();

    const lines = readFileSync(rec.filePath, "utf-8").trim().split("\n");
    expect(lines.length).toBe(1);

    const header = JSON.parse(lines[0]);
    expect(header._header).toBe(true);
    // Schema bumped to v3 in Task 11 (redactionApplied flag); writer
    // always emits the current version, readers tolerate 1, 2 and 3
    // for forensic access to historical recordings.
    expect(header.version).toBe(3);
    expect(header.version).toBe(RECORDING_HEADER_VERSION);
    expect(RECORDING_HEADER_VERSIONS_ACCEPTED.has(header.version)).toBe(true);
    expect(header.redactionApplied).toBe(true);
    expect(header.session_id).toBe("sess-1");
    expect(header.backend_type).toBe("claude");
    expect(header.cwd).toBe("/project");
    expect(typeof header.started_at).toBe("number");
  });

  it("preserves raw strings exactly without re-serialization", () => {
    // The raw string has intentional formatting (extra spaces, specific order)
    // that must be preserved verbatim — not re-parsed and re-serialized.
    const rawMsg = '{"type":"system",  "subtype":"init", "extra_field": true}';
    const rec = new SessionRecorder("sess-2", "claude", "/project", tempDir);
    rec.record("in", rawMsg, "cli");
    rec.close();

    const lines = readFileSync(rec.filePath, "utf-8").trim().split("\n");
    expect(lines.length).toBe(2);

    const entry = JSON.parse(lines[1]);
    expect(entry.raw).toBe(rawMsg);
  });

  it("records entries with monotonically increasing timestamps", () => {
    const rec = new SessionRecorder("sess-3", "codex", "/project", tempDir);
    rec.record("in", "msg1", "cli");
    rec.record("out", "msg2", "cli");
    rec.record("in", "msg3", "browser");
    rec.close();

    const lines = readFileSync(rec.filePath, "utf-8").trim().split("\n");
    expect(lines.length).toBe(4);

    const entries = lines.slice(1).map((l) => JSON.parse(l));
    for (let i = 1; i < entries.length; i++) {
      expect(entries[i].ts).toBeGreaterThanOrEqual(entries[i - 1].ts);
    }
  });

  it("records direction and channel correctly", () => {
    const rec = new SessionRecorder("sess-4", "claude", "/cwd", tempDir);
    rec.record("in", "hello", "cli");
    rec.record("out", "world", "browser");
    rec.close();

    const lines = readFileSync(rec.filePath, "utf-8").trim().split("\n");
    const e1 = JSON.parse(lines[1]);
    const e2 = JSON.parse(lines[2]);

    expect(e1.dir).toBe("in");
    expect(e1.ch).toBe("cli");
    expect(e2.dir).toBe("out");
    expect(e2.ch).toBe("browser");
  });

  it("does not record after close()", () => {
    const rec = new SessionRecorder("sess-5", "claude", "/cwd", tempDir);
    rec.record("in", "before-close", "cli");
    rec.close();
    rec.record("in", "after-close", "cli");

    const lines = readFileSync(rec.filePath, "utf-8").trim().split("\n");
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[1]).raw).toBe("before-close");
  });

  it("generates a filename with session ID and backend type", () => {
    const rec = new SessionRecorder("my-session", "codex", "/cwd", tempDir);
    rec.close();

    expect(rec.filePath).toContain("my-session");
    expect(rec.filePath).toContain("codex");
    expect(rec.filePath).toMatch(/\.jsonl$/);
  });

  it("tracks lineCount correctly (header + entries)", () => {
    // lineCount starts at 1 (the header), increments for each recorded entry
    const rec = new SessionRecorder("sess-lc", "claude", "/cwd", tempDir);
    expect(rec.lineCount).toBe(1);

    rec.record("in", "a", "cli");
    rec.record("in", "b", "cli");
    rec.record("out", "c", "browser");
    rec.record("in", "d", "cli");
    rec.record("out", "e", "browser");
    expect(rec.lineCount).toBe(6);

    rec.close();
    // lineCount doesn't change after close
    expect(rec.lineCount).toBe(6);
  });

  // CR-6 (council review 2026-05-15-0336 finding #6 / Willison W-P1-2):
  // The `RecordingOrigin` union is the load-bearing forensic discriminant
  // for distinguishing browser-relayed frames from server-synthesised
  // wake / auto-proceed frames in replay tooling. Before this PR the
  // discriminant shipped without any test exercising it through the
  // replay loader — a future PR refactoring recorder.ts (e.g. compact
  // origin into a single-byte flag for disk-size) would still pass the
  // existing tests while replay tools silently misclassify auto-proceed
  // turns as browser-relayed → incident response writes the wrong
  // post-mortem.
  it("CR-6: records `server:auto-proceed` and `server:council-wake` origin values and loadRecording round-trips them", async () => {
    const { loadRecording } = await import("./replay.js");
    const rec = new SessionRecorder("sess-origin", "claude", "/cwd", tempDir);
    // Three frames: browser (origin omitted = default), council-wake,
    // auto-proceed. Exercises every member of the RecordingOrigin union.
    rec.record("in", "frame-browser", "browser");
    rec.record("out", "frame-wake", "cli", "server:council-wake");
    rec.record("out", "frame-auto-proceed", "cli", "server:auto-proceed");
    rec.close();

    const recording = loadRecording(rec.filePath);
    expect(recording.entries.length).toBe(3);
    // The browser entry omits `origin` (writer side optimisation per
    // recorder.ts:298-305 — default is implicit). Replay tools treat
    // absent origin as "browser-relayed".
    expect(recording.entries[0].origin).toBeUndefined();
    expect(recording.entries[1].origin).toBe("server:council-wake");
    expect(recording.entries[2].origin).toBe("server:auto-proceed");
  });

  it("CR-6: a mixed-origin recording can be filtered by origin via the replay loader", async () => {
    const { loadRecording } = await import("./replay.js");
    const rec = new SessionRecorder("sess-mix", "claude", "/cwd", tempDir);
    rec.record("in", "user-typed", "browser");
    rec.record("out", "wake-1", "cli", "server:council-wake");
    rec.record("out", "auto-1", "cli", "server:auto-proceed");
    rec.record("out", "auto-2", "cli", "server:auto-proceed");
    rec.record("in", "another-user", "browser");
    rec.close();

    const recording = loadRecording(rec.filePath);
    const autoProceedFrames = recording.entries.filter(
      (e) => e.origin === "server:auto-proceed",
    );
    const wakeFrames = recording.entries.filter(
      (e) => e.origin === "server:council-wake",
    );
    const userFrames = recording.entries.filter((e) => e.origin === undefined);

    // Partition is total: 2 + 1 + 2 = 5 entries, every entry belongs to
    // exactly one origin class.
    expect(autoProceedFrames.length).toBe(2);
    expect(wakeFrames.length).toBe(1);
    expect(userFrames.length).toBe(2);
    expect(autoProceedFrames.length + wakeFrames.length + userFrames.length).toBe(
      recording.entries.length,
    );

    // Provenance preserved on the auto-proceed frames specifically — this
    // is the forensic-trail claim of the PR description that nothing else
    // tested.
    expect(autoProceedFrames[0].raw).toBe("auto-1");
    expect(autoProceedFrames[1].raw).toBe("auto-2");
  });
});

// ─── RecorderManager ─────────────────────────────────────────────────────────

describe("RecorderManager", () => {
  it("enabled by default when no options provided", () => {
    // Recording is always on unless explicitly disabled
    const mgr = new RecorderManager({ recordingsDir: tempDir });
    expect(mgr.isGloballyEnabled()).toBe(true);
    expect(mgr.isRecording("any-session")).toBe(true);
    mgr.closeAll();
  });

  it("respects globalEnabled: true", () => {
    const mgr = new RecorderManager({ globalEnabled: true, recordingsDir: tempDir });
    expect(mgr.isGloballyEnabled()).toBe(true);
    expect(mgr.isRecording("any-session")).toBe(true);
    mgr.closeAll();
  });

  it("does not record when disabled globally and per-session", () => {
    const mgr = new RecorderManager({ globalEnabled: false, recordingsDir: tempDir });
    expect(mgr.isRecording("sess-1")).toBe(false);

    mgr.record("sess-1", "in", "test", "cli", "claude", "/cwd");

    const files = readDirSafe(tempDir);
    expect(files.length).toBe(0);
  });

  it("supports per-session enable/disable", () => {
    const mgr = new RecorderManager({ globalEnabled: false, recordingsDir: tempDir });

    expect(mgr.isRecording("sess-1")).toBe(false);

    mgr.enableForSession("sess-1");
    expect(mgr.isRecording("sess-1")).toBe(true);
    expect(mgr.isRecording("sess-2")).toBe(false);

    mgr.disableForSession("sess-1");
    expect(mgr.isRecording("sess-1")).toBe(false);
  });

  it("lazily creates a recorder on first record() call", () => {
    const mgr = new RecorderManager({ globalEnabled: true, recordingsDir: tempDir });

    expect(readDirSafe(tempDir).length).toBe(0);

    mgr.record("sess-1", "in", "first-msg", "cli", "claude", "/cwd");

    const files = readDirSafe(tempDir);
    expect(files.length).toBe(1);
    expect(files[0]).toMatch(/^sess-1_claude_.*\.jsonl$/);
    mgr.closeAll();
  });

  it("creates separate files for concurrent sessions", () => {
    const mgr = new RecorderManager({ globalEnabled: true, recordingsDir: tempDir });

    mgr.record("sess-a", "in", "msg-a", "cli", "claude", "/cwd");
    mgr.record("sess-b", "in", "msg-b", "cli", "codex", "/cwd");

    const files = readDirSafe(tempDir);
    expect(files.length).toBe(2);
    expect(files.some((f) => f.includes("sess-a"))).toBe(true);
    expect(files.some((f) => f.includes("sess-b"))).toBe(true);
    mgr.closeAll();
  });

  it("stopRecording closes the recorder and removes it", () => {
    const mgr = new RecorderManager({ globalEnabled: true, recordingsDir: tempDir });
    mgr.record("sess-1", "in", "msg1", "cli", "claude", "/cwd");

    mgr.stopRecording("sess-1");

    mgr.record("sess-1", "in", "msg2", "cli", "claude", "/cwd");

    const files = readDirSafe(tempDir);
    expect(files.length).toBe(2);
    mgr.closeAll();
  });

  it("getRecordingStatus returns filePath when active", () => {
    const mgr = new RecorderManager({ globalEnabled: true, recordingsDir: tempDir });
    mgr.record("sess-1", "in", "msg", "cli", "claude", "/cwd");

    const status = mgr.getRecordingStatus("sess-1");
    expect(status.filePath).toBeDefined();
    expect(status.filePath!).toMatch(/sess-1.*\.jsonl$/);
    mgr.closeAll();
  });

  it("getRecordingStatus returns empty when not active", () => {
    const mgr = new RecorderManager({ globalEnabled: false, recordingsDir: tempDir });
    const status = mgr.getRecordingStatus("sess-1");
    expect(status.filePath).toBeUndefined();
  });

  it("listRecordings returns correct metadata and line counts", () => {
    const mgr = new RecorderManager({ globalEnabled: true, recordingsDir: tempDir });
    // sess-1: header + 1 entry = 2 lines
    mgr.record("sess-1", "in", "msg", "cli", "claude", "/cwd");
    // sess-2: header + 1 entry = 2 lines
    mgr.record("sess-2", "in", "msg", "cli", "codex", "/cwd");

    const recordings = mgr.listRecordings();
    expect(recordings.length).toBe(2);

    const r1 = recordings.find((r) => r.sessionId === "sess-1");
    expect(r1).toBeDefined();
    expect(r1!.backendType).toBe("claude");
    expect(r1!.lines).toBe(2);

    const r2 = recordings.find((r) => r.sessionId === "sess-2");
    expect(r2).toBeDefined();
    expect(r2!.backendType).toBe("codex");
    expect(r2!.lines).toBe(2);
    mgr.closeAll();
  });

  it("listRecordings returns empty array when directory does not exist", () => {
    const mgr = new RecorderManager({
      globalEnabled: false,
      recordingsDir: join(tempDir, "nonexistent"),
    });
    expect(mgr.listRecordings()).toEqual([]);
  });

  it("closeAll closes all active recorders and stops cleanup timer", () => {
    const mgr = new RecorderManager({ globalEnabled: true, recordingsDir: tempDir });
    mgr.record("sess-1", "in", "msg", "cli", "claude", "/cwd");
    mgr.record("sess-2", "in", "msg", "cli", "codex", "/cwd");

    mgr.closeAll();

    expect(mgr.getRecordingStatus("sess-1").filePath).toBeUndefined();
    expect(mgr.getRecordingStatus("sess-2").filePath).toBeUndefined();
  });

  it("disableForSession also stops and closes the recorder", () => {
    const mgr = new RecorderManager({ globalEnabled: false, recordingsDir: tempDir });
    mgr.enableForSession("sess-1");
    mgr.record("sess-1", "in", "msg", "cli", "claude", "/cwd");

    expect(mgr.getRecordingStatus("sess-1").filePath).toBeDefined();

    mgr.disableForSession("sess-1");

    expect(mgr.getRecordingStatus("sess-1").filePath).toBeUndefined();
  });

  it("disableForSession overrides globalEnabled and prevents new recordings", () => {
    // When globalEnabled is true, disableForSession must still stop recording
    // for that specific session by adding it to the perSessionDisabled set.
    const mgr = new RecorderManager({ globalEnabled: true, recordingsDir: tempDir });
    mgr.record("sess-1", "in", "msg1", "cli", "claude", "/cwd");

    expect(mgr.isRecording("sess-1")).toBe(true);

    mgr.disableForSession("sess-1");

    // Session is no longer recording despite globalEnabled=true
    expect(mgr.isRecording("sess-1")).toBe(false);

    // New record() calls should be no-ops (no new file created)
    const filesBefore = readDirSafe(tempDir).length;
    mgr.record("sess-1", "in", "msg2", "cli", "claude", "/cwd");
    expect(readDirSafe(tempDir).length).toBe(filesBefore);

    // Re-enabling should work
    mgr.enableForSession("sess-1");
    expect(mgr.isRecording("sess-1")).toBe(true);

    mgr.closeAll();
  });

  it("getMaxLines returns configured limit", () => {
    const mgr = new RecorderManager({
      globalEnabled: false,
      recordingsDir: tempDir,
      maxLines: 42,
    });
    expect(mgr.getMaxLines()).toBe(42);
  });
});

// ─── Cleanup / Rotation ─────────────────────────────────────────────────────

describe("cleanup / rotation", () => {
  it("deletes oldest files when total lines exceed maxLines", () => {
    // Create 3 files with 10 entries each (= 11 lines each including header, 33 total)
    // Use different mtimes so we control which is "oldest"
    const now = Date.now();
    createFakeRecording(tempDir, "old_claude_2025-01-01.jsonl", 10, new Date(now - 3000));
    createFakeRecording(tempDir, "mid_claude_2025-01-02.jsonl", 10, new Date(now - 2000));
    createFakeRecording(tempDir, "new_claude_2025-01-03.jsonl", 10, new Date(now - 1000));

    // maxLines = 20 → total 33 lines exceeds limit → should delete oldest first
    const mgr = new RecorderManager({
      globalEnabled: false, // don't start auto-cleanup timer
      recordingsDir: tempDir,
      maxLines: 20,
    });

    const deleted = mgr.cleanup();

    // Should have deleted at least the oldest file (11 lines), bringing total to 22,
    // still > 20, so the mid file (11 lines) gets deleted too → total 11 lines
    expect(deleted).toBe(2);

    const remaining = readDirSafe(tempDir);
    expect(remaining.length).toBe(1);
    expect(remaining[0]).toContain("new_claude");
  });

  it("does not delete files from active recording sessions", () => {
    // Create an old file that would normally be deleted
    const now = Date.now();
    createFakeRecording(tempDir, "stale_claude_2025-01-01.jsonl", 10, new Date(now - 3000));

    // Start an active recording — this file's path will be in the active set
    const mgr = new RecorderManager({
      globalEnabled: true,
      recordingsDir: tempDir,
      maxLines: 5, // Very low limit to force cleanup
    });
    mgr.record("active-sess", "in", "msg", "cli", "claude", "/cwd");

    // Now cleanup should delete the stale file but NOT the active recording's file
    const deleted = mgr.cleanup();

    // stale file deleted
    expect(existsSync(join(tempDir, "stale_claude_2025-01-01.jsonl"))).toBe(false);

    // active session's file should still exist
    const status = mgr.getRecordingStatus("active-sess");
    expect(status.filePath).toBeDefined();
    expect(existsSync(status.filePath!)).toBe(true);

    mgr.closeAll();
  });

  it("is a no-op when total lines are under the limit", () => {
    // 2 files × 3 entries = 2 × 4 lines = 8 total, well under 100
    createFakeRecording(tempDir, "a_claude_2025-01-01.jsonl", 3);
    createFakeRecording(tempDir, "b_claude_2025-01-02.jsonl", 3);

    const mgr = new RecorderManager({
      globalEnabled: false,
      recordingsDir: tempDir,
      maxLines: 100,
    });

    const deleted = mgr.cleanup();
    expect(deleted).toBe(0);

    expect(readDirSafe(tempDir).length).toBe(2);
  });

  it("handles empty recordings directory gracefully", () => {
    const mgr = new RecorderManager({
      globalEnabled: false,
      recordingsDir: tempDir,
      maxLines: 10,
    });

    const deleted = mgr.cleanup();
    expect(deleted).toBe(0);
  });

  it("runs cleanup at construction when globally enabled", () => {
    // Pre-fill the directory over the limit
    const now = Date.now();
    createFakeRecording(tempDir, "old_claude_2025-01-01.jsonl", 20, new Date(now - 2000));
    createFakeRecording(tempDir, "new_claude_2025-01-02.jsonl", 5, new Date(now - 1000));

    // Total = 21 + 6 = 27 lines, maxLines = 10
    // Constructor should run cleanup immediately, deleting the old file
    const mgr = new RecorderManager({
      globalEnabled: true,
      recordingsDir: tempDir,
      maxLines: 10,
    });

    const remaining = readDirSafe(tempDir);
    expect(remaining.length).toBe(1);
    expect(remaining[0]).toContain("new_claude");

    mgr.closeAll();
  });
});

// ─── Redaction (Task 11) ─────────────────────────────────────────────────────

describe("redactRaw — pure function", () => {
  // The pre-screen short-circuits frames that carry no secret marker so the
  // overwhelming majority of recorded NDJSON (assistant deltas, tool
  // results, keep-alives) round-trips byte-identical. This keeps replay-
  // fixture corpora stable across the schema bump.
  it("returns inert input unchanged (byte-identical)", () => {
    const inputs = [
      '{"type":"system","subtype":"init","model":"claude-opus-4-7"}',
      '{"type":"assistant","content":[{"type":"text","text":"Hello world"}]}',
      '{"type":"keep_alive"}',
      "",
      "plain non-JSON text",
    ];
    for (const raw of inputs) {
      expect(redactRaw(raw)).toBe(raw);
    }
  });

  it("redacts OpenAI sk- keys in structured JSON values", () => {
    const raw = JSON.stringify({
      type: "system",
      env: { OPENAI_API_KEY: "sk-proj-abcdef1234567890ABCDEF" },
    });
    const out = redactRaw(raw);
    const parsed = JSON.parse(out);
    expect(parsed.env.OPENAI_API_KEY).toBe(REDACTED_PLACEHOLDER);
    expect(out).not.toContain("sk-proj-abcdef");
  });

  it("redacts Anthropic sk-ant- keys", () => {
    const raw = JSON.stringify({
      params: { authToken: "sk-ant-api03-abcXYZ_123-deadbeef987654321abcdef" },
    });
    const out = redactRaw(raw);
    expect(out).not.toContain("sk-ant-api03");
    // Output must remain parseable JSON — guaranteed by parse-then-mutate.
    expect(() => JSON.parse(out)).not.toThrow();
  });

  it("redacts Bearer tokens in string values regardless of key name", () => {
    const raw = JSON.stringify({
      type: "control_request",
      headers: { Authorization: "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abcdef" },
    });
    const out = redactRaw(raw);
    expect(out).not.toContain("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abcdef");
    expect(out).toContain(REDACTED_PLACEHOLDER);
  });

  it("redacts GitHub PAT (ghp_, gho_, github_pat_) patterns", () => {
    const cases = [
      "ghp_1234567890abcdefghijklmnopqrstuvwxyz",
      "gho_abcdefghijklmnopqrstuvwxyz1234567890",
      "github_pat_11ABCDEFG0abcdefghijkl_LongRestPartHere1234",
    ];
    for (const token of cases) {
      const out = redactRaw(JSON.stringify({ token }));
      expect(out).not.toContain(token);
    }
  });

  it("redacts by sensitive key name even when value isn't pattern-shaped", () => {
    // A bare opaque string under `companion_auth_token` must be redacted
    // even though it doesn't match any value-shape pattern — the key name
    // is the authoritative signal here.
    const raw = JSON.stringify({ companion_auth_token: "some-opaque-token-abc123" });
    const out = redactRaw(raw);
    const parsed = JSON.parse(out);
    expect(parsed.companion_auth_token).toBe(REDACTED_PLACEHOLDER);
  });

  it("redacts the Companion auth token in a WS URL query string (?token=)", () => {
    // Hunt finding #7 — the bare-hex token rides in the browser WS upgrade
    // URL. If that URL is echoed into a recorded frame value (close reason,
    // error string) the value must be redacted while the param name survives.
    const token = "a".repeat(64);
    const raw = JSON.stringify({
      type: "ws_close",
      reason: `connect failed: ws://localhost:3456/ws/browser/sess-1?token=${token}`,
    });
    const out = redactRaw(raw);
    expect(out).not.toContain(token);
    expect(out).toContain(REDACTED_PLACEHOLDER);
    // Param name is retained for debugging which URL leaked.
    expect(out).toContain("token=");
    expect(() => JSON.parse(out)).not.toThrow();
  });

  it("redacts the &access_token= query-param variant", () => {
    const token = "deadbeef".repeat(8); // 64 hex chars
    const raw = JSON.stringify({ url: `wss://host/x?foo=1&access_token=${token}` });
    const out = redactRaw(raw);
    expect(out).not.toContain(token);
    expect(out).toContain(REDACTED_PLACEHOLDER);
  });

  it("redacts a bare 64-hex Companion auth token outside any query string", () => {
    // No `token=` prefix — the bare-hex value-shape pattern is the only thing
    // that can catch a token echoed standalone into an argv/error string.
    const token = "0123456789abcdef".repeat(4); // exactly 64 hex chars
    const raw = JSON.stringify({ type: "system", note: `spawned with auth ${token}` });
    const out = redactRaw(raw);
    expect(out).not.toContain(token);
    expect(out).toContain(REDACTED_PLACEHOLDER);
    expect(() => JSON.parse(out)).not.toThrow();
  });

  it("redacts in arrays + nested objects", () => {
    const raw = JSON.stringify({
      env_list: [
        { name: "OPENAI_API_KEY", value: "sk-user-deadbeef123456789012345" },
        { name: "PATH", value: "/usr/bin" },
      ],
    });
    const out = redactRaw(raw);
    expect(out).not.toContain("sk-user-deadbeef");
    expect(out).toContain("/usr/bin");
  });

  it("falls back to pattern replacement for non-JSON raw with a marker", () => {
    // control_response can carry a raw string. If parse fails, the function
    // applies value patterns directly.
    const raw = "Authorization: Bearer abcdefghijklmnopqrstuv";
    const out = redactRaw(raw);
    expect(out).not.toContain("Bearer abcdefghijklmnopqrstuv");
    expect(out).toContain(REDACTED_PLACEHOLDER);
  });

  it("output of structured redaction is always valid JSON", () => {
    // Per task spec: every emitted line must JSON.parse — the parse-then-
    // mutate-then-restringify path has no streaming-regex-spanning-escape
    // hazard. We verify with input containing tricky escapes.
    const raw = JSON.stringify({
      apiKey: "Bearer xx\nyy\\zz\"qq",
      note: "value with \\t \\n and \"quotes\"",
    });
    const out = redactRaw(raw);
    expect(() => JSON.parse(out)).not.toThrow();
  });
});

describe("SessionRecorder — redaction at write time", () => {
  it("redacts sk- keys when raw is recorded", () => {
    const rec = new SessionRecorder("sess-redact-1", "claude", "/cwd", tempDir);
    rec.record(
      "in",
      JSON.stringify({ env: { OPENAI_API_KEY: "sk-proj-realbeefdeadbeef123456" } }),
      "cli",
    );
    rec.close();

    const lines = readFileSync(rec.filePath, "utf-8").trim().split("\n");
    expect(lines.length).toBe(2);
    expect(lines[1]).not.toContain("sk-proj-realbeefdeadbeef");

    // Per spec acceptance: every line must remain JSON-parseable post-redaction.
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }

    const entry = JSON.parse(lines[1]);
    const innerRaw = JSON.parse(entry.raw);
    expect(innerRaw.env.OPENAI_API_KEY).toBe(REDACTED_PLACEHOLDER);
  });

  it("redacts sensitive fields inside lifecycle event meta", () => {
    const rec = new SessionRecorder("sess-event-redact", "codex", "/cwd", tempDir);
    rec.recordEvent("ws_error", "cli", {
      error: "connection failed",
      headers: { Authorization: "Bearer secret_jwt_blob_abcdef1234567890" },
    });
    rec.close();

    const lines = readFileSync(rec.filePath, "utf-8").trim().split("\n");
    expect(lines.length).toBe(2);
    expect(lines[1]).not.toContain("secret_jwt_blob_abcdef");

    const entry = JSON.parse(lines[1]);
    expect(entry.meta.headers.Authorization).toBe(REDACTED_PLACEHOLDER);
    expect(entry.meta.error).toBe("connection failed");
  });
});

// ─── File / directory mode (Task 11 — Hunt Principle 3) ──────────────────────

describe("recording file + directory permissions", () => {
  // On systems that don't surface POSIX modes (e.g. some CI Windows runners
  // through node), statSync still returns a `mode` — but the bottom octal
  // bits are coerced. Skip the bit-level assertions on non-POSIX platforms
  // and just assert the file/dir exists.
  const isPosix = process.platform !== "win32";

  it("creates the recordings directory with mode 0o700", () => {
    const nestedDir = join(tempDir, "fresh-recordings");
    const mgr = new RecorderManager({ globalEnabled: true, recordingsDir: nestedDir });
    // Triggers ensureDir on first record() call.
    mgr.record("sess-perm-1", "in", "msg", "cli", "claude", "/cwd");

    expect(existsSync(nestedDir)).toBe(true);
    if (isPosix) {
      const mode = statSync(nestedDir).mode & 0o777;
      expect(mode).toBe(0o700);
    }
    mgr.closeAll();
  });

  it("creates the recording file with mode 0o600", () => {
    const rec = new SessionRecorder("sess-perm-2", "claude", "/cwd", tempDir);
    rec.close();

    expect(existsSync(rec.filePath)).toBe(true);
    if (isPosix) {
      const mode = statSync(rec.filePath).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });
});

// ─── Auth-probe exclusion (Task 11 — record: false plumbing) ─────────────────

describe("RecorderManager — auth-probe exclusion via disableForSession", () => {
  // The cli-launcher disables recording for a session BEFORE any adapter
  // wires its first record() call — short-lived auth-probe spawns (Codex
  // smoke check, MAX 20x tier verification) must never write init frames
  // (which carry the raw token before redaction reaches the per-frame
  // writer) to disk.
  it("a session disabled before any record() call writes no file", () => {
    const mgr = new RecorderManager({ globalEnabled: true, recordingsDir: tempDir });

    // Simulate the cli-launcher path: disable, then attempt to record.
    mgr.disableForSession("probe-sess");
    expect(mgr.isRecording("probe-sess")).toBe(false);

    mgr.record(
      "probe-sess",
      "in",
      JSON.stringify({ env: { OPENAI_API_KEY: "sk-real-probe-secret-1234567890" } }),
      "cli",
      "claude",
      "/cwd",
    );

    // No file should have been opened for the probe session.
    const files = readdirSync(tempDir).filter((f) => f.includes("probe-sess"));
    expect(files.length).toBe(0);

    mgr.closeAll();
  });
});
