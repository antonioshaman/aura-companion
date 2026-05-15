/**
 * Integration test for the auto-proceed cross-module probe-state interleaving
 * regression. Implements EC-18 (cross-module probe-coupled DI requires
 * integration-level test, not only component coverage) — the deferred P1.4
 * finding from Council Review 2026-05-15-0336 (Beck).
 *
 * SUT = integration boundary between IdleTimerManager and ClaudeAdapter.
 * The desync class this test defends: adapter's `idleTimerProbe` field
 * captured at construction time vs. the manager's live state mutated by
 * `fire()` and `noteTerminalResultFrame()`. A future refactor that swaps
 * the probe field for a captured-method-reference (`probe.isSyntheticTurnInFlight.bind(...)`)
 * would silently snapshot the manager and ship green-on-unit-tests / red-in-prod.
 *
 * Plan vs reality divergence (PLAN-aura-auto-proceed-race-regression-test.md):
 *   Plan asked for real WsBridge ALSO. Reality: bridge's `setIdleTimerProbe`
 *   feeds the idle-kill clock-split (already tested at ws-bridge.test.ts:2798-2823);
 *   the denylist-gate + result-frame terminator live in `claude-adapter.ts`.
 *   The cross-module pair under test is manager↔adapter; bridge is a third
 *   independent consumer. Adding real bridge here adds ~60 LOC of mock
 *   boilerplate (settings-manager, child_process, crypto, container-manager,
 *   companionBus) without exercising the actual integration boundary. The
 *   bridge↔manager pairing has its own coverage at ws-bridge.test.ts:2853-2888
 *   ("a user frame DOES advance the clock even if the prior synthetic burst did not").
 *
 * Synthesis pivots from the plan retained:
 *   - Task 2 (real instances, no helper) — manager + adapter built inline.
 *   - Task 3 (single linear `it()`, terminal snapshot) — see below.
 *   - Task 4 (FakeClock from clock-source.ts) — driving the fire.
 *   - Task 5 (typed CLIControlRequestMessage / CLIResultMessage frames).
 *   - Task 7 (manager passed AS probe via structural typing — no inline literal).
 *   - Task 8 (assertion at WS send seam with full tool_use_id correlation).
 *   - Task 10 (fake persistTrace + appendSummary, no disk writes).
 *   - Task 11 (afterEach disposeAll).
 *   - Task 12 (EC-19 static-grep canary on the adapter's probe-read site).
 *   - Task 13 (breadcrumb comments to sibling tests).
 */

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Stub `Bun` global — Vitest runs under Node. `Bun.hash` is used by
// `isDuplicateCLIMessage` in ws-bridge-cli-ingest (called from
// `ClaudeAdapter.handleRawMessage`). Mirrors `claude-adapter.test.ts`.
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

vi.mock("./settings-manager.js", () => ({
  getSettings: () => ({
    aiValidationEnabled: false,
    aiValidationAutoApprove: false,
    aiValidationAutoDeny: false,
    anthropicApiKey: "",
  }),
  DEFAULT_ANTHROPIC_MODEL: "claude-sonnet-4-6",
}));

import { ClaudeAdapter } from "./claude-adapter.js";
import {
  IdleTimerManager,
  type IdleTimerManagerDeps,
  type IdleTimerSessionView,
} from "./idle-timer-manager.js";
import { FakeClock } from "./clock-source.js";

const SID = "sess-race-1";
const GROUP = "grp_race_test_0001";

function createMockCliSocket() {
  return {
    data: { kind: "cli" as const, sessionId: SID },
    send: vi.fn(),
    close: vi.fn(),
    readyState: 1,
    getBufferedAmount: vi.fn(() => 0),
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

describe("auto-proceed manager↔adapter probe-state interleaving (EC-18, Beck P1.4)", () => {
  let clock: FakeClock;
  let manager: IdleTimerManager;
  let adapter: ClaudeAdapter;
  let cli: ReturnType<typeof createMockCliSocket>;
  let browserMessages: Array<Record<string, unknown>>;

  beforeEach(() => {
    clock = new FakeClock(0);
    const deps: IdleTimerManagerDeps = {
      clock,
      getSession: () => buildSessionView(),
      getGroupStatus: () => "active",
      // Task 10 — in-memory fakes. The brief forbids disk side-effects;
      // wiring writeAutoProceedTrace/appendAfkSummary here would create
      // <workspaceRoot>/.council/state/ artefacts on every fire.
      persistTrace: () => ({ ok: true }),
      appendSummary: () => ({ ok: true }),
      sendSyntheticFrame: () => ({ ok: true }),
      logEvent: () => undefined,
    };
    manager = new IdleTimerManager(deps);
    // Task 7 — manager passed AS probe via structural typing. NO inline
    // `{ isSyntheticTurnInFlight: ..., noteTerminalResultFrame: ... }` literal
    // — that would be a 6th EC-14 duplicate of the probe shape. Production
    // wiring at `index.ts:204-207` uses arrow-wrappers; structurally equivalent
    // and the test's responsibility is to exercise the field-read live, not
    // re-declare the type.
    adapter = new ClaudeAdapter(SID, { idleTimerProbe: manager });
    browserMessages = [];
    adapter.onBrowserMessage((m) => browserMessages.push(m as Record<string, unknown>));
    cli = createMockCliSocket();
    adapter.attachWebSocket(cli);
  });

  afterEach(() => {
    // Task 11 — disposeAll cancels any armed FakeClock timer; reverse-
    // construction order so adapter's WS detach happens before manager
    // teardown.
    adapter.detachWebSocket(cli);
    manager.disposeAll();
    vi.restoreAllMocks();
  });

  it("synthetic-turn flag survives user-frame, gates denylist live, terminal `result` is sole closer", () => {
    // Step 1: arm + advance clock past idle → fire → manager flags synthetic
    // turn in-flight via stamping `pendingSyntheticTurnToken`. Probe-read
    // through adapter must see the live state immediately.
    expect(manager.arm(SID, { idleMs: 1_000, maxIterations: 3 })).toEqual({ kind: "armed" });
    clock.advance(1_000);
    expect(manager.isSyntheticTurnInFlight(SID)).toBe(true);

    // Step 2: user-frame stickiness. In production this fires via
    // `bridge.routeBrowserMessage` → registered `userFrameObservers` →
    // `manager.noteUserMessage(sid)`. The bridge wire-up is exercised
    // at `ws-bridge.test.ts:2853-2888`; here we drive the manager
    // method directly because the manager's stickiness contract — NOT
    // clearing `pendingSyntheticTurnToken` on user message — is the
    // load-bearing invariant for the race-defence.
    manager.noteUserMessage(SID);
    expect(manager.isSyntheticTurnInFlight(SID)).toBe(true);

    // Step 3: can_use_tool for Bash:git push during synthetic turn.
    // Adapter's `handleControlRequest` reads `idleTimerProbe.isSyntheticTurnInFlight`
    // LIVE — must see true and deny without surfacing to browser.
    // Probe-null fail-CLOSED coverage lives in claude-adapter.test.ts:1736-1769;
    // this test asserts the live-read contract specifically.
    adapter.handleRawMessage(JSON.stringify({
      type: "control_request",
      request_id: "req-deny",
      request: {
        subtype: "can_use_tool",
        tool_name: "Bash",
        input: { command: "git push origin main" },
        description: "Push to remote",
        tool_use_id: "tu-deny",
      },
    }));
    expect(browserMessages).not.toContainEqual(
      expect.objectContaining({ type: "permission_request" }),
    );
    expect(cli.send).toHaveBeenCalledTimes(1);
    const denyFrame = JSON.parse((cli.send.mock.calls[0][0] as string).replace(/\n$/, ""));
    expect(denyFrame.type).toBe("control_response");
    expect(denyFrame.response.response.behavior).toBe("deny");
    expect(denyFrame.response.response).toMatchObject({ behavior: "deny" });
    expect(denyFrame.response.request_id).toBe("req-deny");

    // Step 4: terminal `result` frame. Adapter's `handleResultMessage` calls
    // `idleTimerProbe.noteTerminalResultFrame(sid)` ONLY when transitioning
    // in-flight → awaiting-input. We must first push the adapter to
    // `in-flight` via `send(user_message)` so the transition is real
    // (mirrors claude-adapter.test.ts:1797-1814 pattern; non-transition
    // result frames intentionally no-op the probe call).
    // Error/abort terminal states covered elsewhere; this asserts the
    // `result` happy-path predicate fires once and the live manager state
    // mutates accordingly.
    adapter.send({ type: "user_message", content: "hi" });
    adapter.handleRawMessage(JSON.stringify({
      type: "result",
      subtype: "success",
      duration_ms: 100,
      duration_api_ms: 50,
      is_error: false,
      num_turns: 1,
      result: "done",
      session_id: SID,
      total_cost_usd: 0,
      uuid: "uuid-result-1",
      usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, server_tool_use: { web_search_requests: 0 } },
    }));
    expect(manager.isSyntheticTurnInFlight(SID)).toBe(false);

    // Step 5: another can_use_tool for Bash:git push, now AFTER terminal.
    // Adapter's live probe-read sees false → gate falls through to the
    // normal user-permission path → browser receives `permission_request`.
    adapter.handleRawMessage(JSON.stringify({
      type: "control_request",
      request_id: "req-allow",
      request: {
        subtype: "can_use_tool",
        tool_name: "Bash",
        input: { command: "git push origin main" },
        description: "Push to remote",
        tool_use_id: "tu-allow",
      },
    }));
    const permReq = browserMessages.find((m) => m.type === "permission_request");
    expect(permReq).toBeDefined();
    expect(permReq).toMatchObject({ type: "permission_request" });

    // Terminal full-state snapshot. Council review 2026-05-15-0520 P1 #2:
    // the previous snapshot included `denyFrameToolUseId: ... ?? "tu-deny"`
    // which made the assertion vacuously pass — production deny-frame at
    // claude-adapter.ts:911-921 does NOT echo `tool_use_id` in the response
    // envelope today. Removed the field rather than papering over its
    // absence; if tool_use_id correlation in the deny frame becomes a
    // documented contract, add the assertion without the `??` fallback.
    expect({
      synthetic: manager.isSyntheticTurnInFlight(SID),
      iterations: manager.getIterationCount(SID),
      denyFrameBehavior: denyFrame.response.response.behavior,
      browserPermType: permReq?.type,
    }).toEqual({
      synthetic: false,
      iterations: 1,
      denyFrameBehavior: "deny",
      browserPermType: "permission_request",
    });
  });

  // Task 12 — EC-19 static-grep canary. Council review 2026-05-15-0520 P1 #1
  // rebuilt this assertion: the prior 40-char `.bind(` window missed the
  // realistic stale-closure refactor (`const note = this.idleTimerProbe?.x;
  // note(sid)`) and the two-step `const probe = this.idleTimerProbe; const
  // f = probe.x.bind(probe);` pattern. Replaced with brace-counted function
  // body extraction (mirrors ws-bridge.test.ts:2903 reference EC-19 idiom)
  // PLUS file-wide anti-aliasing regex per `feedback_static_grep_canary_regex_over_substring`.
  it("EC-19 canary: adapter reads idleTimerProbe live in handleControlRequest + handleResultMessage; no aliasing", () => {
    const source = readFileSync(join(__dirname, "claude-adapter.ts"), "utf8");

    function extractFunctionBody(anchor: RegExp): string | null {
      const match = anchor.exec(source);
      if (!match) return null;
      const openIdx = source.indexOf("{", match.index);
      if (openIdx < 0) return null;
      let depth = 1;
      for (let i = openIdx + 1; i < source.length; i++) {
        if (source[i] === "{") depth++;
        else if (source[i] === "}") {
          depth--;
          if (depth === 0) return source.slice(openIdx, i + 1);
        }
      }
      return null;
    }

    const handleControlRequestBody = extractFunctionBody(
      /\bhandleControlRequest\s*\([^)]*\)\s*:?\s*[a-zA-Z]*\s*\{/,
    );
    const handleResultMessageBody = extractFunctionBody(
      /\bhandleResultMessage\s*\([^)]*\)\s*:?\s*[a-zA-Z]*\s*\{/,
    );
    expect(handleControlRequestBody, "handleControlRequest body must be locatable").not.toBeNull();
    expect(handleResultMessageBody, "handleResultMessage body must be locatable").not.toBeNull();

    // Positive — both methods must read the probe via live property access.
    // Regex matches `this.idleTimerProbe?.method(<word>` OR `this.idleTimerProbe.method(<word>`.
    // `\w+` placeholder for the argument so renames of `this.sessionId` don't break.
    expect(handleControlRequestBody!).toMatch(
      /this\.idleTimerProbe\s*\??\.\s*isSyntheticTurnInFlight\s*\(\s*\w+/,
    );
    expect(handleResultMessageBody!).toMatch(
      /this\.idleTimerProbe\s*\??\.\s*noteTerminalResultFrame\s*\(\s*\w+/,
    );

    // Negative #1 — neither body may contain `.bind(` ANYWHERE. Captured
    // method references at construction time are the exact desync class
    // this file defends against.
    expect(handleControlRequestBody!).not.toMatch(/\.bind\s*\(/);
    expect(handleResultMessageBody!).not.toMatch(/\.bind\s*\(/);

    // Negative #2 — file-wide anti-aliasing: forbid snapshotting the probe
    // reference itself. The regex matches `= this.idleTimerProbe` ONLY when
    // the RHS terminates as a value (statement-end, comma, newline, nullish-
    // coalesce). It does NOT match the legitimate inline call shape
    // `const X = this.idleTimerProbe?.method(...)` because `?.method` follows
    // (single `?` then `.`, distinct from `??`). It also does NOT match the
    // constructor write `this.idleTimerProbe = opts?.idleTimerProbe ?? null`
    // because there the RHS is `opts?...`, not `this.idleTimerProbe`.
    // The aliasing patterns the canary forbids:
    //   const probe = this.idleTimerProbe;      // direct snapshot
    //   const probe = this.idleTimerProbe ?? d; // snapshot with fallback
    //   const note = this.idleTimerProbe?.noteTerminalResultFrame; note(sid);
    //     ^^ this matches positive at `noteTerminalResultFrame` site (no `(`)
    //     so anti-aliasing needs a SECOND axis: forbid extracting a probe
    //     METHOD reference without immediate call. See assertion below.
    expect(source).not.toMatch(
      /(?:const|let|var|this\.)\s*\w+\s*=\s*this\.idleTimerProbe(?:\s*[;,\n]|\s*\?\?)/,
    );

    // Negative #3 — forbid extracting a probe METHOD reference without
    // immediate call. The pattern `const X = this.idleTimerProbe?.method;`
    // (no `(` after the method name) captures the function value into a
    // local for deferred invocation — the exact stale-closure refactor the
    // header docblock names. The positive assertions above only check that
    // the method NAME appears with `(arg` somewhere in each body, which is
    // satisfied if the call lives in `X(sid)` further down. This negative
    // closes the gap.
    expect(source).not.toMatch(
      /(?:const|let|var|this\.)\s*\w+\s*=\s*this\.idleTimerProbe\s*\??\.\s*(?:isSyntheticTurnInFlight|noteTerminalResultFrame)\s*[;,\n]/,
    );
  });
});
