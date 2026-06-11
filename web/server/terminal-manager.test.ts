import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TerminalManager } from "./terminal-manager.js";
import {
  readTerminalSidecar,
  listTerminalSidecarIds,
} from "./terminal-runtime-sidecar.js";

// These tests validate the provenance-sidecar lifecycle the boot-reconcile
// reaper depends on: spawn() writes `<terminalId>.terminal.json`; kill()
// removes it synchronously. Bun.spawn is stubbed (vitest runs under Node,
// where the global is absent) and the mock proc carries `process.pid` so the
// real `readProcessStartMs` returns a non-null anchor — otherwise spawn()
// correctly skips the sidecar (null start = unverifiable provenance).

const mockTerminal = { write: vi.fn(), resize: vi.fn(), close: vi.fn() };

function mockProc() {
  return {
    pid: process.pid,
    exitCode: 0,
    kill: vi.fn(),
    // Never resolves — we drive teardown explicitly via kill().
    exited: new Promise<number>(() => {}),
    terminal: mockTerminal,
  };
}

const mockSpawn = vi.fn(() => mockProc());
vi.stubGlobal("Bun", { spawn: mockSpawn });

const isLinux = process.platform === "linux";
const d = isLinux ? describe : describe.skip;

let terminalsRoot: string;
let workdir: string;
let mgr: TerminalManager;

beforeEach(() => {
  vi.clearAllMocks();
  terminalsRoot = mkdtempSync(join(tmpdir(), "term-mgr-side-"));
  workdir = mkdtempSync(join(tmpdir(), "term-mgr-cwd-"));
  mgr = new TerminalManager(terminalsRoot);
});

afterEach(() => {
  rmSync(terminalsRoot, { recursive: true, force: true });
  rmSync(workdir, { recursive: true, force: true });
});

d("TerminalManager — sidecar lifecycle", () => {
  // A host terminal writes a `host`-kind sidecar whose pid matches the live
  // process, giving the reaper the provenance it needs to verify later.
  it("writes a host sidecar on spawn", () => {
    const id = mgr.spawn(workdir, 80, 24);

    const result = readTerminalSidecar(terminalsRoot, id);
    expect(result.kind).toBe("present");
    if (result.kind === "present") {
      expect(result.payload.terminalId).toBe(id);
      expect(result.payload.kind).toBe("host");
      expect(result.payload.pid).toBe(process.pid);
      expect(listTerminalSidecarIds(terminalsRoot)).toContain(id);
    }
  });

  // A docker terminal carries the `docker` kind so the reaper picks host-
  // side-client kill semantics (FLAG B).
  it("writes a docker sidecar when a containerId is supplied", () => {
    const id = mgr.spawn(workdir, 80, 24, { containerId: "deadbeefcafe" });

    const result = readTerminalSidecar(terminalsRoot, id);
    expect(result.kind === "present" && result.payload.kind).toBe("docker");
  });

  // kill() must remove the provenance synchronously so boot-reconcile never
  // re-discovers a terminal that was cleanly torn down in this process.
  it("removes the sidecar on kill", () => {
    const id = mgr.spawn(workdir, 80, 24);
    expect(readTerminalSidecar(terminalsRoot, id).kind).toBe("present");

    mgr.kill(id);
    expect(readTerminalSidecar(terminalsRoot, id).kind).toBe("absent");
    expect(listTerminalSidecarIds(terminalsRoot)).not.toContain(id);
  });
});

describe("TerminalManager — reclamation seam", () => {
  // `has` / `activeTerminalIds` feed the reaper's isLocallyTracked guard so a
  // periodic reconcile never reaps a terminal the running process owns.
  it("reports tracked terminals via has() and activeTerminalIds()", () => {
    const id = mgr.spawn(workdir, 80, 24);
    expect(mgr.has(id)).toBe(true);
    expect(mgr.activeTerminalIds()).toContain(id);
    expect(mgr.has("never-spawned")).toBe(false);
  });

  // A freshly-spawned terminal has no browser attached → it is a reclamation
  // candidate immediately (the in-memory orphanTimer would otherwise reap it).
  it("lists browserless terminals as reclaimable", () => {
    const id = mgr.spawn(workdir, 80, 24);
    expect(mgr.getReclaimableTerminals()).toContain(id);
  });

  // reapTerminal delegates to the same teardown as kill: instance gone, sidecar
  // deleted, and the return value reports whether it acted.
  it("reapTerminal kills the instance and removes its sidecar", () => {
    const id = mgr.spawn(workdir, 80, 24);
    expect(mgr.reapTerminal(id)).toBe(true);
    expect(mgr.has(id)).toBe(false);
    expect(readTerminalSidecar(terminalsRoot, id).kind).toBe("absent");
    // Reaping an unknown id is a no-op that reports it did nothing.
    expect(mgr.reapTerminal("never-spawned")).toBe(false);
  });
});
