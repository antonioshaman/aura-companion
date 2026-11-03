import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PortableHistoryStore } from "./portable-history-store.js";
import { createPortableArchive } from "./portable-history.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "portable-store-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });
const fixture = () => createPortableArchive([
  { id: "source-c", project: "alpha", backend: "claude", messageHistory: [{ type: "user_message", content: "Keep the pending migration" }] },
  { id: "source-x", project: "beta", backend: "codex", messageHistory: [{ type: "assistant", message: { content: [{ type: "text", text: "Tests passed" }] } }] },
]);

describe("PortableHistoryStore — inert durable imports", () => {
  // A new instance proves disk durability, rather than an in-memory cache roundtrip.
  it("survives restart, uses private files and deduplicates timestamp/key-order changes", () => {
    const store = new PortableHistoryStore(join(root, "imports"));
    const archive = fixture();
    const first = store.import(archive);
    expect(first.duplicate).toBe(false);
    const restarted = new PortableHistoryStore(join(root, "imports"));
    expect(restarted.get(first.id)).toEqual(archive);
    const reordered = { sessions: archive.sessions, exclusions: archive.exclusions, redactionVersion: archive.redactionVersion, version: archive.version, format: archive.format, exportedAt: "2025-01-01T00:00:00Z" };
    expect(restarted.import(reordered)).toEqual({ id: first.id, duplicate: true });
    expect(restarted.list()).toHaveLength(1);
    expect(statSync(join(root, "imports", `${first.id}.json`)).mode & 0o777).toBe(0o600);
    expect(statSync(join(root, "imports")).mode & 0o777).toBe(0o700);
  });

  // Rejection must not replace the good snapshot or touch any live-session sentinel.
  it("rejects invalid imports atomically and never accepts a path as an archive id", () => {
    const store = new PortableHistoryStore(join(root, "imports"));
    const good = store.import(fixture());
    const file = join(root, "imports", `${good.id}.json`);
    const before = readFileSync(file, "utf8");
    writeFileSync(join(root, "live-session.json"), "untouched");
    for (const raw of ["{broken", { ...fixture(), version: 999 }, { ...fixture(), sessions: "bad" }]) {
      expect(() => store.import(raw)).toThrow();
      expect(readFileSync(file, "utf8")).toBe(before);
    }
    expect(() => store.get("../live-session")).toThrow();
    expect(readdirSync(join(root, "imports"))).toEqual([`${good.id}.json`]);
    expect(readFileSync(join(root, "live-session.json"), "utf8")).toBe("untouched");
  });

  it("rejects symlinked archive files instead of reading outside the root", () => {
    const store = new PortableHistoryStore(join(root, "imports"));
    const first = store.import(fixture());
    const file = join(root, "imports", `${first.id}.json`);
    const outside = join(root, "outside.json");
    writeFileSync(outside, readFileSync(file));
    rmSync(file);
    symlinkSync(outside, file);
    expect(() => store.get(first.id)).toThrow();
    expect(() => store.import(fixture())).toThrow();
  });
});

// Beck reproduced a normalization boundary bug: adding a required binary warning
// after validating the exclusion count could commit an archive the next read rejects.
it("never commits an archive whose normalized review notes exceed the format limit", () => {
  const store = new PortableHistoryStore(join(root, "imports"));
  const archive = fixture();
  archive.sessions[0].messages.push({ role: "assistant", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "YWJj" } }] });
  archive.exclusions = Array.from({ length: 10_000 }, (_, index) => `Review note ${index}`);
  expect(() => store.import(archive)).toThrow(/limit/i);
  expect(store.list()).toEqual([]);
});
