import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeAtomicJson } from "./atomic-write.js";
import { COUNCIL_ARTIFACT_MAX_BYTES } from "./council-types.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "atomic-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("writeAtomicJson", () => {
  // Round-trip — the simplest contract: what went in comes back out.
  it("writes a JSON payload to the target path", () => {
    const target = join(dir, "out.json");
    writeAtomicJson(target, { foo: "bar", n: 42 });
    expect(JSON.parse(readFileSync(target, "utf-8"))).toEqual({ foo: "bar", n: 42 });
  });

  // Creating parent dirs lazily means the caller doesn't have to mkdir
  // `.council/checkpoints/` separately before each write.
  it("creates the parent directory if missing", () => {
    const target = join(dir, "nested/sub/out.json");
    writeAtomicJson(target, { ok: true });
    expect(JSON.parse(readFileSync(target, "utf-8"))).toEqual({ ok: true });
  });

  // Hunt P2 oversize defence — must reject before opening the fd so a
  // hostile or buggy writer cannot fill the disk.
  it("rejects payloads larger than COUNCIL_ARTIFACT_MAX_BYTES", () => {
    const big = { huge: "a".repeat(COUNCIL_ARTIFACT_MAX_BYTES) };
    expect(() => writeAtomicJson(join(dir, "x.json"), big)).toThrow(/exceeds/);
  });

  // Failed write must leave NO visible target file. Combined with the
  // tmp+rename strategy this guarantees observers never see torn writes.
  it("does not create the target file when payload is oversized", () => {
    const target = join(dir, "x.json");
    const big = { huge: "a".repeat(COUNCIL_ARTIFACT_MAX_BYTES) };
    expect(() => writeAtomicJson(target, big)).toThrow();
    expect(() => readFileSync(target, "utf-8")).toThrow();
  });

  // The `.tmp` staging file must be renamed away — leaving one behind
  // would slowly fill the directory and the watcher would skip them
  // (dotfile rule) but it still indicates a writer bug.
  it("leaves no .tmp staging file after a successful write", () => {
    writeAtomicJson(join(dir, "out.json"), { ok: 1 });
    expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toHaveLength(0);
  });

  // Overwrite semantics — second write must atomically replace the first.
  // Crucial for re-emitting the same checkpoint on idempotent retries.
  it("overwrites an existing target atomically", () => {
    const target = join(dir, "out.json");
    writeAtomicJson(target, { v: 1 });
    writeAtomicJson(target, { v: 2 });
    expect(JSON.parse(readFileSync(target, "utf-8"))).toEqual({ v: 2 });
  });
});
