/**
 * Council Review 2026-05-15-0520 P2 #4 — bridge-pair integration coverage
 * for the EC-18 manager↔consumer probe contract.
 *
 * The sibling `auto-proceed-race-regression.test.ts` defends the
 * manager↔ClaudeAdapter pair (denylist gate + result-frame terminator).
 * This file defends the manager↔WsBridge pair (idle-kill CLOCK-SPLIT
 * consumer of `probe.isSyntheticTurnInFlight`). EC-18 names a 3-class
 * coupling — manager produces, adapter consumes for tool gates, bridge
 * consumes for clock-split — and one sibling test per consumer is the
 * structural enforcer of the convention.
 *
 * Without this file, a bootstrap-ordering bug in `index.ts:204-207` where
 * bridge gets a different manager (or a captured snapshot at construction)
 * than adapter gets would pass:
 *   - the adapter-pair test (manager↔adapter still live-wired correctly),
 *   - the existing bridge clock-split tests at `ws-bridge.test.ts:2798-2888`
 *     (those use a STUB probe — they assert the bridge CAN read whatever
 *     probe it was handed, not that the probe is live-wired to a real
 *     manager).
 *
 * The probe surface in this file is a real `IdleTimerManager` instance.
 * Structural typing makes `setIdleTimerProbe(manager)` valid (matches the
 * production wiring shape at index.ts via arrow-wrapper). Per EC-14: no
 * inline `{ isSyntheticTurnInFlight: ..., noteTerminalResultFrame: ... }`
 * literal — that would be a 6th drift surface.
 */

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Stub `Bun` global — Vitest runs under Node. `Bun.hash` is used by
// `isDuplicateCLIMessage` in ws-bridge-cli-ingest.
if (typeof globalThis.Bun === "undefined") {
  (globalThis as any).Bun = {
    hash(input: string | Uint8Array): number {
      const s = typeof input === "string" ? input : new TextDecoder().decode(input);
      let h = 0;
      for (let i = 0; i < s.length; i++) {
        h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
      }
      return h >>> 0;
    },
  };
}

const mockExecSync = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execSync: mockExecSync }));
vi.mock("node:crypto", () => ({ randomUUID: () => "test-uuid" }));
vi.mock("./settings-manager.js", () => ({
  getSettings: () => ({
    aiValidationEnabled: false,
    aiValidationAutoApprove: false,
    aiValidationAutoDeny: false,
    anthropicApiKey: "",
  }),
  DEFAULT_ANTHROPIC_MODEL: "claude-sonnet-4-6",
}));

import { WsBridge, type SocketData } from "./ws-bridge.js";
import { SessionStore } from "./session-store.js";
import { companionBus } from "./event-bus.js";
import {
  IdleTimerManager,
  type IdleTimerManagerDeps,
  type IdleTimerSessionView,
} from "./idle-timer-manager.js";
import { FakeClock } from "./clock-source.js";

const SID = "sess-bridge-race-1";
const GROUP = "grp_bridge_race_test_0001";

function createMockSocket(data: SocketData) {
  return {
    data,
    send: vi.fn(),
    close: vi.fn(),
    readyState: 1,
  } as any;
}

function buildSessionView(): IdleTimerSessionView {
  return {
    sessionId: SID,
    sessionGroupId: GROUP,
    sessionGroupRole: "orchestrator",
    state: "connected",
    orchestratorTurnState: { kind: "awaiting-input", blockedByStop: false },
    workspaceRoot: "/work/test",
    reconnectGraceActive: false,
    councilPhase: "council-implement",
  };
}

describe("auto-proceed manager↔bridge clock-split (EC-18 bridge half)", () => {
  let bridge: WsBridge;
  let store: SessionStore;
  let tempDir: string;
  let clock: FakeClock;
  let manager: IdleTimerManager;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "bridge-race-"));
    store = new SessionStore(tempDir);
    bridge = new WsBridge();
    bridge.setStore(store);
    mockExecSync.mockReset();
    companionBus.clear();
    // Suppress console output to prevent Vitest worker teardown races
    // (ws-bridge.ts and session-store.ts log via console.*).
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    clock = new FakeClock(0);
    const deps: IdleTimerManagerDeps = {
      clock,
      getSession: () => buildSessionView(),
      getGroupStatus: () => "active",
      persistTrace: () => ({ ok: true }),
      appendSummary: () => ({ ok: true }),
      sendSyntheticFrame: () => ({ ok: true }),
      logEvent: () => undefined,
    };
    manager = new IdleTimerManager(deps);

    // The integration boundary: bridge's probe is the REAL manager via
    // structural typing. Production wiring at `index.ts:204-207` is the
    // arrow-wrapper shape `{ isSyntheticTurnInFlight: (sid) => manager.isSyntheticTurnInFlight(sid), ... }`
    // which is structurally equivalent. If a refactor ever captures the
    // probe-methods by value at this seam (`.bind(...)` or stored closure
    // in WsBridge constructor), the runtime test below catches it.
    bridge.setIdleTimerProbe(manager);
  });

  afterEach(() => {
    manager.disposeAll();
    store.dispose();
    rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("bridge's CLI-activity clock-split reads probe LIVE — synthetic-in-flight defers; post-terminator advances", async () => {
    const cli = createMockSocket({ kind: "cli", sessionId: SID });
    const browser = createMockSocket({ kind: "browser", sessionId: SID });
    bridge.handleCLIOpen(cli, SID);
    bridge.handleBrowserOpen(browser, SID);

    // Step 1: arm + fire on the REAL manager → flags synthetic-in-flight.
    // Manager's `pendingSyntheticTurnToken` flips to non-null inside
    // `fire()` after the synthetic send succeeds (deps.sendSyntheticFrame
    // returns `{ok: true}`).
    expect(manager.arm(SID, { idleMs: 1_000, maxIterations: 3 })).toEqual({ kind: "armed" });
    clock.advance(1_000);
    expect(manager.isSyntheticTurnInFlight(SID)).toBe(true);

    // Step 2: push a CLI activity frame (tool_progress) through the bridge.
    // Bridge's `noteCliActivity` consults `idleTimerProbe.isSyntheticTurnInFlight(sid)`
    // — must see true via the LIVE manager and route to `noteSyntheticActivity`
    // (no-op for the clock) rather than `noteUserActivity` (advance).
    const session = bridge.getSession(SID)!;
    const tsBeforeSyntheticBurst = session.lastCliActivityTs;
    // Real wallclock between assertions, so a legitimate advance would
    // be observable as `>` not `===`.
    await new Promise((r) => setTimeout(r, 5));
    await bridge.handleCLIMessage(cli, JSON.stringify({
      type: "tool_progress",
      tool_use_id: "tu-syn-1",
      tool_name: "Bash",
      parent_tool_use_id: null,
      elapsed_time_seconds: 1,
      uuid: "uuid-syn-1",
      session_id: SID,
    }));
    expect(session.lastCliActivityTs).toBe(tsBeforeSyntheticBurst);

    // Step 3: clear the synthetic via manager's terminal-result hook.
    // This is the OTHER probe method bridge holds; it shares the same
    // manager instance through `setIdleTimerProbe(manager)`. After the
    // call, `isSyntheticTurnInFlight` flips to false.
    manager.noteTerminalResultFrame(SID);
    expect(manager.isSyntheticTurnInFlight(SID)).toBe(false);

    // Step 4: push another CLI activity. Probe now reports false →
    // bridge routes to `noteUserActivity` → clock advances. The strict
    // assertion (`> initial`) is what catches a captured-probe regression:
    // if bridge had snapshotted the probe at construction (when it was
    // null, before `setIdleTimerProbe`), this advance would never fire.
    await new Promise((r) => setTimeout(r, 5));
    await bridge.handleCLIMessage(cli, JSON.stringify({
      type: "tool_progress",
      tool_use_id: "tu-user-1",
      tool_name: "Bash",
      parent_tool_use_id: null,
      elapsed_time_seconds: 1,
      uuid: "uuid-user-1",
      session_id: SID,
    }));
    expect(session.lastCliActivityTs).toBeGreaterThan(tsBeforeSyntheticBurst);
  });

  // EC-19 canary mirror for the bridge-side probe consumer. The bridge
  // reads `isSyntheticTurnInFlight` inside a private dispatcher method;
  // a refactor capturing the probe-method reference at construction would
  // ship green-on-unit but red-on-bootstrap-reorder. Same regex idiom as
  // the adapter-side canary at the sibling test file.
  it("EC-19 canary: bridge reads idleTimerProbe live in noteCliActivity; no aliasing", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(path.join(__dirname, "ws-bridge.ts"), "utf-8");

    function extractFunctionBody(anchor: RegExp): string | null {
      const match = anchor.exec(src);
      if (!match) return null;
      const openIdx = src.indexOf("{", match.index);
      if (openIdx < 0) return null;
      let depth = 1;
      for (let i = openIdx + 1; i < src.length; i++) {
        if (src[i] === "{") depth++;
        else if (src[i] === "}") {
          depth--;
          if (depth === 0) return src.slice(openIdx, i + 1);
        }
      }
      return null;
    }

    const noteCliActivityBody = extractFunctionBody(
      /\bnoteCliActivity\s*\([^)]*\)\s*:?\s*[a-zA-Z]*\s*\{/,
    );
    expect(noteCliActivityBody, "noteCliActivity body must be locatable").not.toBeNull();

    // Positive — probe-read goes through live property access on
    // `this.idleTimerProbe`, not via a cached local.
    expect(noteCliActivityBody!).toMatch(
      /this\.idleTimerProbe\s*\??\.\s*isSyntheticTurnInFlight\s*\(\s*\w+/,
    );

    // Negative — neither the body nor the wider file may bind a probe
    // METHOD reference to a local without immediate call. Matches the
    // adapter-side canary's two-axis anti-aliasing.
    expect(noteCliActivityBody!).not.toMatch(/\.bind\s*\(/);
    expect(src).not.toMatch(
      /(?:const|let|var|this\.)\s*\w+\s*=\s*this\.idleTimerProbe(?:\s*[;,\n]|\s*\?\?)/,
    );
    expect(src).not.toMatch(
      /(?:const|let|var|this\.)\s*\w+\s*=\s*this\.idleTimerProbe\s*\??\.\s*(?:isSyntheticTurnInFlight|noteTerminalResultFrame)\s*[;,\n]/,
    );
  });
});
