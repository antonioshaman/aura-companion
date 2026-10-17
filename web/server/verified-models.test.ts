/**
 * Tests for the observed-working model store (`verified-models.ts`).
 *
 * Every test uses a fresh tmp dir — the store is NEVER pointed at the real
 * `~/.companion/verified-models.json` (this suite runs on the prod box; an
 * earlier test wiped prod's model cache by touching the real path).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  VerifiedModelStore,
  VERIFIED_MODELS_SCHEMA_VERSION,
  getVerifiedModelStore,
  setVerifiedModelStore,
} from "./verified-models.js";

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "verified-models-test-"));
  path = join(dir, "verified-models.json");
});

afterEach(() => {
  vi.useRealTimers();
  setVerifiedModelStore(null);
  rmSync(dir, { recursive: true, force: true });
});

describe("VerifiedModelStore", () => {
  it("an unknown model becomes verified after recordSuccess, and survives a reload", () => {
    const store = new VerifiedModelStore({ path, debounceMs: 0, now: () => 1000 });
    expect(store.has("claude", "claude-sonnet-5")).toBe(false);
    store.recordSuccess("claude", "claude-sonnet-5");
    expect(store.has("claude", "claude-sonnet-5")).toBe(true);
    store.flush();

    // New instance = server restart: it must read the persisted file.
    const reloaded = new VerifiedModelStore({ path, debounceMs: 0 });
    expect(reloaded.has("claude", "claude-sonnet-5")).toBe(true);
    // Keyed per backend — the same id on the other backend is not verified.
    expect(reloaded.has("codex", "claude-sonnet-5")).toBe(false);
  });

  it("tracks firstSeen / lastSeen", () => {
    let t = 1000;
    const store = new VerifiedModelStore({ path, debounceMs: 0, now: () => t });
    store.recordSuccess("codex", "gpt-6-sol");
    t = 5000;
    store.recordSuccess("codex", "gpt-6-sol");
    store.flush();
    const file = JSON.parse(readFileSync(path, "utf8"));
    expect(file.schema_version).toBe(VERIFIED_MODELS_SCHEMA_VERSION);
    expect(file.models).toEqual([{ backend: "codex", id: "gpt-6-sol", firstSeen: 1000, lastSeen: 5000 }]);
  });

  it("debounces writes: many successes inside the window produce one write", () => {
    vi.useFakeTimers();
    const store = new VerifiedModelStore({ path, debounceMs: 5000 });
    store.recordSuccess("claude", "claude-opus-5-5");
    store.recordSuccess("claude", "claude-fable-5");
    // Nothing on disk until the debounce fires.
    expect(existsSync(path)).toBe(false);
    vi.advanceTimersByTime(5000);
    const file = JSON.parse(readFileSync(path, "utf8"));
    expect(file.models.map((m: { id: string }) => m.id).sort()).toEqual(["claude-fable-5", "claude-opus-5-5"]);
  });

  it("rejects ids that fail the per-backend argv validator (never persisted)", () => {
    const store = new VerifiedModelStore({ path, debounceMs: 0 });
    store.recordSuccess("claude", "<synthetic>");
    store.recordSuccess("claude", "");
    store.recordSuccess("claude", "gpt-6.1-sol"); // wrong backend shape
    store.recordSuccess("codex", "-rf");
    store.flush();
    expect(store.size()).toBe(0);
    expect(existsSync(path)).toBe(false);
  });

  it("a corrupt / foreign-schema file is ignored (starts empty, never throws)", () => {
    writeFileSync(path, "{not json");
    expect(new VerifiedModelStore({ path }).size()).toBe(0);
    writeFileSync(path, JSON.stringify({ schema_version: 99, models: [{ backend: "claude", id: "claude-x", firstSeen: 1, lastSeen: 1 }] }));
    expect(new VerifiedModelStore({ path }).size()).toBe(0);
  });

  it("drops malformed entries individually on load", () => {
    writeFileSync(path, JSON.stringify({
      schema_version: VERIFIED_MODELS_SCHEMA_VERSION,
      models: [
        { backend: "claude", id: "claude-opus-5-5", firstSeen: 1, lastSeen: 2 },
        { backend: "claude", id: "bad id", firstSeen: 1, lastSeen: 2 },
        { backend: "nope", id: "claude-x", firstSeen: 1, lastSeen: 2 },
        "garbage",
      ],
    }));
    const store = new VerifiedModelStore({ path });
    expect(store.size()).toBe(1);
    expect(store.has("claude", "claude-opus-5-5")).toBe(true);
  });

  it("a write failure is swallowed (observation is best-effort)", () => {
    // Parent path is a FILE → mkdir/rename fails.
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "x");
    const store = new VerifiedModelStore({ path: join(blocker, "verified-models.json"), debounceMs: 0 });
    store.recordSuccess("claude", "claude-opus-5-5");
    expect(() => store.flush()).not.toThrow();
    expect(store.has("claude", "claude-opus-5-5")).toBe(true);
  });
});

describe("process-wide store slot", () => {
  it("is null until the server wires one (tests never get the real path)", () => {
    expect(getVerifiedModelStore()).toBeNull();
    const store = new VerifiedModelStore({ path });
    setVerifiedModelStore(store);
    expect(getVerifiedModelStore()).toBe(store);
  });
});
