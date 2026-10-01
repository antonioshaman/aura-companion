import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { tightenFileMode, writeAtomicJson } from "./atomic-write.js";
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

// P7/SEC-S7: the helper is now the write path for secret stores
// (settings.json, env profiles, agent configs, Linear OAuth connections).
describe("writeAtomicJson file mode and formatting", () => {
  // The tmp file is opened 0o600 and renamed over the target, so the result
  // is owner-only regardless of the process umask.
  it("writes the target with mode 0o600", () => {
    const target = join(dir, "secret.json");
    writeAtomicJson(target, { token: "x" });
    expect(statSync(target).mode & 0o777).toBe(0o600);
  });

  // writeFileSync's `mode` only applies on create; the rename replaces the
  // inode, so a world-readable file written by an older version is tightened.
  it("tightens a pre-existing 0o644 target to 0o600 on overwrite", () => {
    const target = join(dir, "legacy.json");
    writeFileSync(target, "{}", { mode: 0o644 });
    chmodSync(target, 0o644);
    writeAtomicJson(target, { v: 1 });
    expect(statSync(target).mode & 0o777).toBe(0o600);
  });

  // `space` keeps hand-editable stores pretty-printed (same bytes as the
  // old JSON.stringify(x, null, 2) writers); omitted → compact as before.
  it("pretty-prints only when `space` is given", () => {
    const pretty = join(dir, "pretty.json");
    const compact = join(dir, "compact.json");
    writeAtomicJson(pretty, { a: 1 }, { space: 2 });
    writeAtomicJson(compact, { a: 1 });
    expect(readFileSync(pretty, "utf-8")).toBe(JSON.stringify({ a: 1 }, null, 2));
    expect(readFileSync(compact, "utf-8")).toBe('{"a":1}');
  });
});

// FIX-P7-REVIEW (3): a secret store that is only ever read (auth.json) never
// goes through the atomic rename, so the loaders re-tighten it on read.
describe("tightenFileMode", () => {
  it("chmods a group/world-readable file to 0o600", () => {
    const target = join(dir, "auth.json");
    writeFileSync(target, "{}");
    chmodSync(target, 0o644);
    tightenFileMode(target);
    expect(statSync(target).mode & 0o777).toBe(0o600);
  });

  it("leaves an owner-only file's mode as is", () => {
    // 0o400 has no group/other bits — must not be widened to 0o600.
    const target = join(dir, "ro.json");
    writeFileSync(target, "{}");
    chmodSync(target, 0o400);
    tightenFileMode(target);
    expect(statSync(target).mode & 0o777).toBe(0o400);
  });

  it("is a no-op for a missing file", () => {
    expect(() => tightenFileMode(join(dir, "missing.json"))).not.toThrow();
  });
});
