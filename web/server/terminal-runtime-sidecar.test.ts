import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  writeTerminalSidecar,
  readTerminalSidecar,
  deleteTerminalSidecar,
  listTerminalSidecarIds,
  parseTerminalSidecarPayload,
  terminalSidecarPath,
  argvSha256,
  TERMINAL_SIDECAR_SCHEMA_VERSION,
  TERMINAL_SIDECAR_FILE_SUFFIX,
  type TerminalSidecarPayload,
} from "./terminal-runtime-sidecar.js";

// The sidecar is the persisted provenance the boot-reconcile reaper reads
// to find PTY terminals stranded across a server restart. These tests
// validate the round-trip, the strict loader contract (absent vs throw),
// the enumerator the reconcile pass depends on, and the resolver bounds.

let root: string;

const VALID_START_MS = 1_700_000_000_000; // well above the year-2000 floor
const VALID_SHA = argvSha256(["/bin/bash", "-l"]);

function makePayload(overrides: Partial<TerminalSidecarPayload> = {}): TerminalSidecarPayload {
  return {
    schemaVersion: TERMINAL_SIDECAR_SCHEMA_VERSION,
    terminalId: "11111111-2222-3333-4444-555555555555",
    pid: 4321,
    processStartMs: VALID_START_MS,
    argvSha256: VALID_SHA,
    kind: "host",
    ...overrides,
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "term-sidecar-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("writeTerminalSidecar + readTerminalSidecar round-trip", () => {
  // Happy path: what we write is exactly what the reaper reads back.
  it("round-trips a valid host payload", () => {
    const payload = makePayload();
    writeTerminalSidecar(root, payload);
    const result = readTerminalSidecar(root, payload.terminalId);
    expect(result).toEqual({ kind: "present", payload });
  });

  // Docker terminals carry the `docker` kind so the reaper picks the
  // host-side-client kill semantics (FLAG B).
  it("round-trips a docker payload", () => {
    const payload = makePayload({ kind: "docker", terminalId: "docker-term-id-0001" });
    writeTerminalSidecar(root, payload);
    const result = readTerminalSidecar(root, payload.terminalId);
    expect(result.kind === "present" && result.payload.kind).toBe("docker");
  });
});

describe("readTerminalSidecar — absent vs throw contract", () => {
  // ENOENT is the clean-teardown / never-existed case → absent, NOT throw.
  // The reaper treats absent as "nothing to reconcile for this id".
  it("returns {kind:'absent'} when the sidecar file does not exist", () => {
    expect(readTerminalSidecar(root, "no-such-terminal")).toEqual({ kind: "absent" });
  });

  // A corrupt-but-present sidecar is an explicit-intent violation → THROW.
  // Silently degrading would let a malformed provenance record drive a
  // reap decision, which must never happen.
  it("throws when the sidecar body is malformed JSON", () => {
    const id = "corrupt-term";
    writeFileSync(terminalSidecarPath(root, id), "{ not json", "utf8");
    expect(() => readTerminalSidecar(root, id)).toThrow();
  });

  // Parses-as-JSON but fails a field validator → THROW (e.g. pid as string).
  it("throws when a field fails validation despite valid JSON", () => {
    const id = "badfield-term";
    writeFileSync(
      terminalSidecarPath(root, id),
      JSON.stringify({ ...makePayload({ terminalId: id }), pid: "not-a-number" }),
      "utf8",
    );
    expect(() => readTerminalSidecar(root, id)).toThrow(/invalid pid/);
  });
});

describe("parseTerminalSidecarPayload — strict field validation", () => {
  it("rejects a wrong schemaVersion", () => {
    expect(() => parseTerminalSidecarPayload({ ...makePayload(), schemaVersion: 2 })).toThrow(
      /schemaVersion/,
    );
  });

  it("rejects a processStartMs below the year-2000 floor", () => {
    expect(() => parseTerminalSidecarPayload({ ...makePayload(), processStartMs: 1000 })).toThrow(
      /processStartMs/,
    );
  });

  it("rejects an argvSha256 that is not 64-char lowercase hex", () => {
    expect(() => parseTerminalSidecarPayload({ ...makePayload(), argvSha256: "ABC" })).toThrow(
      /argvSha256/,
    );
  });

  it("rejects an unknown kind", () => {
    expect(() => parseTerminalSidecarPayload({ ...makePayload(), kind: "vm" })).toThrow(/kind/);
  });

  it("rejects a non-object payload", () => {
    expect(() => parseTerminalSidecarPayload("nope")).toThrow(/JSON object/);
  });
});

describe("deleteTerminalSidecar", () => {
  // Clean teardown removes the provenance so boot-reconcile never sees it.
  it("removes an existing sidecar", () => {
    const payload = makePayload();
    const path = writeTerminalSidecar(root, payload);
    expect(existsSync(path)).toBe(true);
    deleteTerminalSidecar(root, payload.terminalId);
    expect(existsSync(path)).toBe(false);
  });

  // Double-delete is a no-op — the orphanTimer AND proc.exited paths can
  // both fire a delete for the same terminal; the second must not throw.
  it("is idempotent (ENOENT is silent)", () => {
    expect(() => deleteTerminalSidecar(root, "never-existed")).not.toThrow();
  });
});

describe("listTerminalSidecarIds — boot-reconcile enumerator", () => {
  // The reconcile pass has no other way to discover stranded terminals;
  // this enumerator is its sole input.
  it("lists only terminalIds with a sidecar, stripping the suffix", () => {
    writeTerminalSidecar(root, makePayload({ terminalId: "term-a" }));
    writeTerminalSidecar(root, makePayload({ terminalId: "term-b" }));
    // An unrelated file in the dir must be ignored.
    writeFileSync(join(root, "unrelated.txt"), "x", "utf8");
    const ids = listTerminalSidecarIds(root).sort();
    expect(ids).toEqual(["term-a", "term-b"]);
  });

  // A never-created root dir means no terminals were ever spawned → [].
  it("returns [] for a non-existent root", () => {
    expect(listTerminalSidecarIds(join(root, "missing-subdir"))).toEqual([]);
  });
});

describe("terminalSidecarPath — EC-7 resolver bounds", () => {
  // A terminalId containing traversal must be rejected by the resolver,
  // never escape the terminals root.
  it("rejects a traversal terminalId", () => {
    expect(() => terminalSidecarPath(root, "../escape")).toThrow();
  });

  // The reserved `.reaping` subdir name must not be usable as a terminalId.
  it("rejects the reserved .reaping subdir name", () => {
    expect(() => terminalSidecarPath(root, ".reaping")).toThrow(/reserved subdir/);
  });

  // The written file carries the documented suffix so the enumerator's
  // endsWith filter is correct.
  it("produces a path ending in the documented suffix", () => {
    const p = terminalSidecarPath(root, "term-x");
    expect(p.endsWith(`term-x${TERMINAL_SIDECAR_FILE_SUFFIX}`)).toBe(true);
    // sanity: the suffix constant is what readdir will see on disk
    writeTerminalSidecar(root, makePayload({ terminalId: "term-x" }));
    expect(readdirSync(root).some((f) => f === `term-x${TERMINAL_SIDECAR_FILE_SUFFIX}`)).toBe(true);
  });
});
