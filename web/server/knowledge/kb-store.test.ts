import { spawnSync } from "node:child_process";
// Tests for `archiveEntries` — the single function that rewrites a KB store
// (used by `kb:prune` and by the diagnostics "archive" decision).
//
// What is validated:
//   - an archived entry moves to `archive/<store>.jsonl` with `archivedAt` /
//     `archiveReason`, and the live store loses exactly that line — every other
//     line (including an unparseable one) is written back byte-for-byte;
//   - idempotency by on-disk state: a retried archive of an id already in the
//     archive and no longer live is a no-op ("already-archived"); an id left in
//     BOTH files by a crash between the two writes only gets the live rewrite
//     ("completed-partial") and is NOT appended to the archive a second time;
//   - an unknown id is reported "not-found" and nothing is written;
//   - best-effort guard: if the live store changes before the final stat, the
//     rename (a concurrent /learn append), the rewrite aborts with
//     KbStoreConflictError and the appended line survives.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as atomicWrite from "../atomic-write.js";
import { ARCHIVE_DIR, archiveEntries, KbStoreConflictError } from "./kb-store.js";

let dir: string;
const line = (id: string) => JSON.stringify({ id, type: "gotcha", fact: `fact ${id}` });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kb-store-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeStore(name: string, rows: string[]): string {
  const p = join(dir, name);
  writeFileSync(p, rows.join("\n") + "\n");
  return p;
}

describe("archiveEntries", () => {
  it("moves exactly the requested line and keeps every other line verbatim", () => {
    const corrupt = '{"id": "got-x", broken';
    const spaced = '{ "id":"got-003",  "fact":"keeps its odd spacing" }';
    const live = writeStore("gotchas.jsonl", [line("got-001"), corrupt, line("got-002"), spaced]);

    const out = archiveEntries(dir, [{ id: "got-002", reason: "owner: archive" }], {
      now: new Date("2026-10-19T00:00:00Z"),
    });

    expect(out).toEqual([{ id: "got-002", file: "gotchas.jsonl", status: "archived" }]);
    expect(readFileSync(live, "utf8")).toBe([line("got-001"), corrupt, spaced].join("\n") + "\n");
    const archived = readFileSync(join(dir, ARCHIVE_DIR, "gotchas.jsonl"), "utf8").trim().split("\n");
    expect(archived).toHaveLength(1);
    expect(JSON.parse(archived[0])).toMatchObject({
      id: "got-002",
      archivedAt: "2026-10-19T00:00:00.000Z",
      archiveReason: "owner: archive",
    });
  });

  it("is a no-op for an id that is already archived and no longer live", () => {
    writeStore("gotchas.jsonl", [line("got-001"), line("got-002")]);
    archiveEntries(dir, [{ id: "got-002", reason: "r" }]);
    const archiveBefore = readFileSync(join(dir, ARCHIVE_DIR, "gotchas.jsonl"), "utf8");

    const out = archiveEntries(dir, [{ id: "got-002", reason: "r" }]);

    expect(out).toEqual([{ id: "got-002", file: "gotchas.jsonl", status: "already-archived" }]);
    expect(readFileSync(join(dir, ARCHIVE_DIR, "gotchas.jsonl"), "utf8")).toBe(archiveBefore);
  });

  it("finishes a half-done archive (in both files) without appending a duplicate", () => {
    // Simulates a crash after the archive append but before the live rewrite.
    const live = writeStore("gotchas.jsonl", [line("got-001"), line("got-002")]);
    mkdirSync(join(dir, ARCHIVE_DIR));
    writeFileSync(join(dir, ARCHIVE_DIR, "gotchas.jsonl"), line("got-002") + "\n");

    const out = archiveEntries(dir, [{ id: "got-002", reason: "r" }]);

    expect(out).toEqual([{ id: "got-002", file: "gotchas.jsonl", status: "completed-partial" }]);
    expect(readFileSync(live, "utf8")).toBe(line("got-001") + "\n");
    expect(readFileSync(join(dir, ARCHIVE_DIR, "gotchas.jsonl"), "utf8").trim().split("\n")).toHaveLength(1);
  });

  // Same id is not the same version: preserve changed and unknown nested fields.
  it("archives the current version even when an older version has the same id", () => {
    const current = { id: "got-002", fact: "new", extra: { b: 2, a: [1] } };
    writeStore("gotchas.jsonl", [JSON.stringify(current)]);
    mkdirSync(join(dir, ARCHIVE_DIR));
    const archive = join(dir, ARCHIVE_DIR, "gotchas.jsonl");
    writeFileSync(archive, line("got-002") + "\n");
    expect(archiveEntries(dir, [{ id: "got-002", reason: "r" }])[0].status).toBe("archived");
    const rows = readFileSync(archive, "utf8").trim().split("\n").map((r) => JSON.parse(r));
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject(current);
    // A restored identical version with reordered keys is not appended twice.
    writeStore("gotchas.jsonl", [JSON.stringify({ extra: { a: [1], b: 2 }, fact: "new", id: "got-002" })]);
    expect(archiveEntries(dir, [{ id: "got-002", reason: "retry" }])[0].status).toBe("completed-partial");
    expect(readFileSync(archive, "utf8").trim().split("\n")).toHaveLength(2);
  });

  it("reports an unknown id as not-found and writes nothing", () => {
    const live = writeStore("gotchas.jsonl", [line("got-001")]);
    const before = readFileSync(live, "utf8");

    expect(archiveEntries(dir, [{ id: "got-999", reason: "r" }])).toEqual([{ id: "got-999", status: "not-found" }]);
    expect(readFileSync(live, "utf8")).toBe(before);
    expect(existsSync(join(dir, ARCHIVE_DIR))).toBe(false);
  });

  it("aborts the live rewrite when another writer appended before the final stat", () => {
    const live = writeStore("gotchas.jsonl", [line("got-001"), line("got-002")]);
    // Inject the concurrent /learn append at the last moment before the live
    // rename, by wrapping writeAtomicText's beforeRename for the live store.
    const real = atomicWrite.writeAtomicText;
    const spy = vi.spyOn(atomicWrite, "writeAtomicText").mockImplementation((target, text, opts) => {
      if (target === live) {
        return real(target, text, {
          ...opts,
          beforeRename: () => {
            appendFileSync(live, line("got-new") + "\n");
            opts?.beforeRename?.();
          },
        });
      }
      return real(target, text, opts);
    });
    try {
      expect(() => archiveEntries(dir, [{ id: "got-002", reason: "r" }])).toThrow(KbStoreConflictError);
    } finally {
      spy.mockRestore();
    }
    // The concurrent line survives and the live store was not replaced.
    expect(readFileSync(live, "utf8")).toBe([line("got-001"), line("got-002"), line("got-new")].join("\n") + "\n");
  });
});

describe("writeAtomicText", () => {
  it("leaves the target untouched and no tmp behind when beforeRename throws", () => {
    const p = join(dir, "store.jsonl");
    writeFileSync(p, "original\n");
    expect(() =>
      atomicWrite.writeAtomicText(p, "replacement\n", {
        beforeRename: () => {
          throw new Error("guard");
        },
      }),
    ).toThrow("guard");
    expect(readFileSync(p, "utf8")).toBe("original\n");
    expect(readFileSync(p, "utf8")).not.toContain("replacement");
    expect(readdirSync(dir)).toEqual(["store.jsonl"]);
  });
});

// A separate, non-cooperating writer after stat defeats the offline guard.
// This is why production Archive/prune are disabled, not advertised as CAS.
it("demonstrates the after-stat external writer window on temporary files", () => {
  const live = writeStore("gotchas.jsonl", [line("got-002")]);
  const real = atomicWrite.writeAtomicText;
  const spy = vi.spyOn(atomicWrite, "writeAtomicText").mockImplementation((target, text, opts) => {
    if (target !== live) return real(target, text, opts);
    return real(target, text, { ...opts, beforeRename: () => {
      opts?.beforeRename?.(); // barrier: identity already checked
      const child = spawnSync(process.execPath, ["-e", "require('node:fs').appendFileSync(process.argv[1], process.argv[2])", live, line("external") + "\n"]);
      expect(child.status).toBe(0);
      expect(readFileSync(live, "utf8")).toContain("external");
    }});
  });
  try {
    archiveEntries(dir, [{ id: "got-002", reason: "offline repro" }]);
    expect(readFileSync(live, "utf8")).not.toContain("external");
  } finally { spy.mockRestore(); }
});
