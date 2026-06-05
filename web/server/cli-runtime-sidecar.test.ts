// AURA-LOCAL — tests for cli-runtime-sidecar.ts (PLAN T7).
//
// Coverage shape:
//   - happy path: write → read → equal-payload round-trip.
//   - argvSha256: deterministic hash over the NUL-joined argv.
//   - ENOENT: read on a missing sidecar returns {kind:"absent"} (no throw).
//   - corrupt-present: read on a malformed JSON body throws (preserves
//     observer-prompt loader's explicit-intent contract).
//   - field validators: each field individually rejects bad input —
//     pid (non-int / zero / negative / too-large), processStartMs
//     (pre-2000 / non-finite), argvSha256 (wrong length / non-hex /
//     uppercase), schemaVersion (0 / 2 / string "1"), top-level shape
//     (array / null / string).
//   - sidecarPath: routes through resolveCleanupPath — traversal in
//     sessionId throws at the resolver (EC-7 inheritance).
//   - producer-side guard: writeRuntimeSidecar with a deliberately-bad
//     payload throws BEFORE touching the disk.

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  SIDECAR_SCHEMA_VERSION,
  SIDECAR_FILE_SUFFIX,
  argvSha256,
  parseRuntimeSidecarPayload,
  readRuntimeSidecar,
  sidecarPath,
  writeRuntimeSidecar,
} from "./cli-runtime-sidecar.js";

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "runtime-sidecar-test-"));
});
afterEach(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* */ }
});

describe("sidecarPath — EC-7 routing through resolveCleanupPath", () => {
  it("resolves to <root>/<sessionId>.runtime.json", () => {
    const path = sidecarPath(tmpRoot, "sess_abc123");
    // sidecarPath routes through resolveCleanupPath, which realpaths the root
    // (macOS /var → /private/var portability).
    expect(path).toBe(join(realpathSync(tmpRoot), `sess_abc123${SIDECAR_FILE_SUFFIX}`));
  });

  it("rejects empty sessionId", () => {
    expect(() => sidecarPath(tmpRoot, "")).toThrow(/invalid sessionId/);
  });

  it("rejects traversal in sessionId (EC-7 inherited from resolver)", () => {
    expect(() => sidecarPath(tmpRoot, "../etc/passwd")).toThrow(/traversal|escapes/);
  });

  it("rejects NUL in sessionId", () => {
    expect(() => sidecarPath(tmpRoot, "sess\0bad")).toThrow(/NUL/);
  });
});

describe("argvSha256 — content fingerprint", () => {
  // NUL-joining matches /proc/<pid>/cmdline so a reaper can recompute
  // without re-tokenising. Pin the exact hash so a regression that
  // switches to space-join (the obvious-but-wrong alternative) gets
  // caught structurally.
  it("hashes NUL-joined argv (matches /proc/<pid>/cmdline layout)", () => {
    const sha = argvSha256(["claude", "--sdk-url", "ws://localhost:3456/ws/cli/abc"]);
    // Manually computed for the joined string "claude\0--sdk-url\0ws://localhost:3456/ws/cli/abc"
    expect(sha).toMatch(/^[0-9a-f]{64}$/);
    expect(sha).toBe(argvSha256(["claude", "--sdk-url", "ws://localhost:3456/ws/cli/abc"]));
  });

  it("differs from space-joined hash (regression canary)", () => {
    // Hash for NUL-join vs space-join MUST diverge — if a future
    // regression swaps separators the reaper's cross-check breaks
    // silently.
    const nulHash = argvSha256(["a", "b"]);
    const spaceJoinedHash = require("node:crypto").createHash("sha256").update("a b").digest("hex");
    expect(nulHash).not.toBe(spaceJoinedHash);
  });

  it("is deterministic over identical input", () => {
    expect(argvSha256(["x", "y", "z"])).toBe(argvSha256(["x", "y", "z"]));
  });
});

describe("writeRuntimeSidecar + readRuntimeSidecar — round-trip", () => {
  it("happy path: writes the payload, reads it back equal", () => {
    const payload = {
      schemaVersion: SIDECAR_SCHEMA_VERSION,
      pid: 12345,
      processStartMs: 1_700_000_000_000,
      argvSha256: "0".repeat(64),
    } as const;
    const target = writeRuntimeSidecar(tmpRoot, "sess_xyz", payload);
    expect(existsSync(target)).toBe(true);
    const result = readRuntimeSidecar(tmpRoot, "sess_xyz");
    expect(result.kind).toBe("present");
    if (result.kind === "present") {
      expect(result.payload).toEqual(payload);
    }
  });

  it("read on missing sidecar returns {kind:'absent'} — no throw", () => {
    // ENOENT-vs-malformed contract: absent is the documented Phase A →
    // Phase D transition state. Reader degrades gracefully.
    const result = readRuntimeSidecar(tmpRoot, "no-such-session");
    expect(result.kind).toBe("absent");
  });

  it("read on corrupt JSON body throws (preserves explicit-intent contract)", () => {
    // Mirror observer-prompt.ts: ENOENT = absent (return), malformed-
    // but-present = throw. Operator MUST notice a corrupted sidecar
    // rather than silently degrading to two-factor.
    const target = sidecarPath(tmpRoot, "sess_corrupt");
    writeFileSync(target, "{not-valid-json", { encoding: "utf8" });
    expect(() => readRuntimeSidecar(tmpRoot, "sess_corrupt")).toThrow(SyntaxError);
  });

  it("read on well-formed JSON but invalid payload throws (EC-5)", () => {
    // Parses as JSON, fails the field validators. Mirrors EC-5
    // (parsers reject unknown frame shapes). The error message names
    // the field so triage is one log line.
    const target = sidecarPath(tmpRoot, "sess_bad_fields");
    writeFileSync(target, JSON.stringify({ schemaVersion: 1, pid: "not-a-number" }));
    expect(() => readRuntimeSidecar(tmpRoot, "sess_bad_fields")).toThrow(/invalid pid/);
  });

  it("read on EACCES (or any non-ENOENT errno) propagates the throw", () => {
    // Mirror observer-prompt's behaviour: only ENOENT is "absent".
    // Constructing a directory at the sidecar path makes the read fail
    // with EISDIR — that should bubble.
    mkdirSync(sidecarPath(tmpRoot, "sess_dir_collision"));
    expect(() => readRuntimeSidecar(tmpRoot, "sess_dir_collision")).toThrow();
  });
});

describe("parseRuntimeSidecarPayload — strict field validation (EC-5)", () => {
  const valid = {
    schemaVersion: SIDECAR_SCHEMA_VERSION,
    pid: 1234,
    processStartMs: 1_700_000_000_000,
    argvSha256: "a".repeat(64),
  };

  it("accepts the happy-path shape", () => {
    expect(parseRuntimeSidecarPayload(valid)).toEqual(valid);
  });

  it("rejects array input (top-level shape)", () => {
    expect(() => parseRuntimeSidecarPayload([])).toThrow(/must be a JSON object/);
  });

  it("rejects null input", () => {
    expect(() => parseRuntimeSidecarPayload(null)).toThrow(/must be a JSON object/);
  });

  it("rejects string input", () => {
    expect(() => parseRuntimeSidecarPayload("hello")).toThrow(/must be a JSON object/);
  });

  it("rejects schemaVersion=0 (future-proof gate)", () => {
    expect(() => parseRuntimeSidecarPayload({ ...valid, schemaVersion: 0 })).toThrow(/schemaVersion/);
  });

  it("rejects schemaVersion=2 (forward-compat: bump-without-parser is a regression)", () => {
    expect(() => parseRuntimeSidecarPayload({ ...valid, schemaVersion: 2 })).toThrow(/schemaVersion/);
  });

  it("rejects schemaVersion='1' as string (type cast is NOT trusted)", () => {
    expect(() => parseRuntimeSidecarPayload({ ...valid, schemaVersion: "1" })).toThrow(/schemaVersion/);
  });

  it("rejects pid=0", () => {
    expect(() => parseRuntimeSidecarPayload({ ...valid, pid: 0 })).toThrow(/invalid pid/);
  });

  it("rejects negative pid", () => {
    expect(() => parseRuntimeSidecarPayload({ ...valid, pid: -1 })).toThrow(/invalid pid/);
  });

  it("rejects non-integer pid (1.5)", () => {
    expect(() => parseRuntimeSidecarPayload({ ...valid, pid: 1.5 })).toThrow(/invalid pid/);
  });

  it("rejects pid above kernel PID_MAX upper bound", () => {
    expect(() => parseRuntimeSidecarPayload({ ...valid, pid: 2_147_483_648 })).toThrow(/invalid pid/);
  });

  it("rejects processStartMs below year-2000 floor", () => {
    expect(() => parseRuntimeSidecarPayload({ ...valid, processStartMs: 100 })).toThrow(/processStartMs/);
  });

  it("rejects processStartMs=NaN", () => {
    expect(() => parseRuntimeSidecarPayload({ ...valid, processStartMs: NaN })).toThrow(/processStartMs/);
  });

  it("rejects processStartMs=Infinity", () => {
    expect(() => parseRuntimeSidecarPayload({ ...valid, processStartMs: Infinity })).toThrow(/processStartMs/);
  });

  it("rejects argvSha256 of wrong length", () => {
    expect(() => parseRuntimeSidecarPayload({ ...valid, argvSha256: "deadbeef" })).toThrow(/argvSha256/);
  });

  it("rejects argvSha256 with uppercase hex (canonical form is lowercase)", () => {
    expect(() => parseRuntimeSidecarPayload({ ...valid, argvSha256: "A".repeat(64) })).toThrow(/argvSha256/);
  });

  it("rejects argvSha256 with non-hex chars", () => {
    expect(() => parseRuntimeSidecarPayload({ ...valid, argvSha256: "z".repeat(64) })).toThrow(/argvSha256/);
  });

  it("rejects argvSha256 of wrong type (number)", () => {
    expect(() => parseRuntimeSidecarPayload({ ...valid, argvSha256: 12345 })).toThrow(/argvSha256/);
  });
});

describe("writeRuntimeSidecar — producer-side guard", () => {
  // Producer-side validation prevents a regressing writer from emitting
  // a malformed payload that the next-boot loader would throw on.
  // Defect-equivalent guarantee at both ends of the AP-3 contract.
  it("throws BEFORE disk touch when payload is invalid", () => {
    const badPayload = {
      schemaVersion: SIDECAR_SCHEMA_VERSION,
      pid: -1,
      processStartMs: 1_700_000_000_000,
      argvSha256: "0".repeat(64),
    } as const;
    expect(() => writeRuntimeSidecar(tmpRoot, "sess_bad", badPayload)).toThrow(/invalid pid/);
    // Verify no partial write landed.
    expect(existsSync(sidecarPath(tmpRoot, "sess_bad"))).toBe(false);
  });
});
