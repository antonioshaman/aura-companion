# Kent Beck — Test Quality Review

PR #54 (squash `3dee080` on `main`): Task 11 auto-proceed wire-up (11.6 + 11.7 + 11.8). Three test files touched: `claude-adapter.test.ts` (+191), `ws-bridge.test.ts` (+298), `session-orchestrator.test.ts` (+1 line). Reviewed against Beck Test Desiderata + Carmack-Council quality-testing.md.

Headline: the **component-level tests are unusually strong for AI-generated work** (real socket fakes, real adapter pipeline, no .skip/.todo, no weakened assertions, no .toBeTruthy on complex returns). The EC-6 static-grep canary in 11.7 is well-constructed (function-name anchor + brace-counting, not literal substring — passes the `feedback_static_grep_canary_regex_over_substring` test). But the **call-site wiring** (orchestrator → bridge.onUserFrameObserved → idleTimerManager.noteUserMessage; session:exited → clearPendingSyntheticTurn; archive-branch cleanup) is the textbook `feedback_call_site_presence_not_just_symbol_export` / `feedback_verify_test_bodies_not_just_names` anti-pattern: mock built, never asserted. The deferred 5-step race-regression integration test is also missing, and the component coverage does NOT stand in for it cleanly because the cross-module synchronous probe-coupling is exactly the failure mode an integration test would catch.

---

## P1 — Fix Now

### P1.1 — `session-orchestrator.test.ts` mock-built-never-asserted: `onUserFrameObserved` wiring has zero behavioural coverage

**File:** `web/server/session-orchestrator.test.ts:184` — the entire diff for this file.

The only change is `onUserFrameObserved: vi.fn(() => () => {})` added to `createMockBridge()`. This is purely defensive — without it, the orchestrator constructor would crash on the new `this.wsBridge.onUserFrameObserved(...)` call. **No test anywhere asserts that `orchestrator.initialize()` actually registers a callback that forwards to `idleTimerManager.noteUserMessage`.**

`grep -n onUserFrameObserved web/server/` confirms zero `expect(mockBridge.onUserFrameObserved).toHaveBeenCalled()` style assertion exists. This is exactly `feedback_call_site_presence_not_just_symbol_export`: foundation work (IdleTimerManager `noteUserMessage` test in PR #45) shipped with unit tests but no production caller; this PR adds the production caller (orchestrator.ts:495) but adds no test that EXERCISES the new wiring, only a stub that lets the constructor not crash.

Consequence: if a future refactor moves the orchestrator's subscription line into a different code path (`#if FEATURE`, conditional gate, accidental deletion during conflict resolution), every existing test still passes, the standalone IdleTimerManager test still passes, the standalone `onUserFrameObserved` ws-bridge test still passes, but the **production turn-token never advances** on user typing → pending auto-proceed fires don't cancel → user types and the agent then auto-fires anyway. This is the same defect class shipped in feedback_partial_fix_passed_as_complete: looks green, structurally broken.

Severity P1 — high-risk wiring, false confidence, sibling defect class to the very memory the canary in 11.7 invokes.

**Specify:** Add a behavioural test in session-orchestrator.test.ts:

```ts
it("orchestrator.initialize subscribes to bridge.onUserFrameObserved and forwards to idleTimerManager.noteUserMessage", () => {
  const noteUserMessage = vi.fn();
  const captureCallback = vi.fn((cb) => { /* capture */ });
  const mockBridge = { ...createMockBridge(), onUserFrameObserved: vi.fn((cb) => { captureCallback(cb); return () => {}; }) };
  const orch = new SessionOrchestrator({ wsBridge: mockBridge, idleTimerManager: { noteUserMessage } as any, /* ... */ });
  orch.initialize();
  expect(mockBridge.onUserFrameObserved).toHaveBeenCalledTimes(1);
  // Invoke the captured callback — this is the live wiring.
  captureCallback.mock.calls[0][0]("sess-abc");
  expect(noteUserMessage).toHaveBeenCalledWith("sess-abc");
});
```

### P1.2 — `session:exited` → `clearPendingSyntheticTurn` listener untested

**File:** `web/server/session-orchestrator.ts:507-509` (new in this PR).

```ts
companionBus.on("session:exited", ({ sessionId }) => {
  this.idleTimerManager.clearPendingSyntheticTurn(sessionId);
});
```

Source-code comment justifies this as critical: "without this, a session that died mid-synthetic-turn would leave the sticky token armed; if the same sessionId were later re-used (--resume), the next can_use_tool check would falsely treat the resumed session as auto-proceed-driven."

**No test in `session-orchestrator.test.ts` asserts this listener was registered, fires on `session:exited`, or calls `clearPendingSyntheticTurn`.** The existing `session:exited` listener-count tests (lines 264, 443-454) only verify the LISTENER COUNT — they don't distinguish which handler is wired. A regression that deletes this specific listener still keeps the count ≥ 1 (the orchestrator has multiple `session:exited` handlers).

Severity P1 — security-adjacent (sticky-token residue across --resume is the exact attack the denylist gate is trying to prevent), uncovered.

**Specify:** Mock `idleTimerManager.clearPendingSyntheticTurn` as `vi.fn()`, fire `companionBus.emit("session:exited", { sessionId: "s1", exitCode: 0 })`, assert `clearPendingSyntheticTurn` was called with `"s1"`.

### P1.3 — `archiveSession` council-branch `clearPendingSyntheticTurn` untested

**File:** `web/server/session-orchestrator.ts:2747` (new in this PR).

```ts
this.idleTimerManager.clearPendingSyntheticTurn(group.primary.sessionId);
```

Same defect class as P1.2 — the source comment explicitly justifies this as belt-and-suspenders against a future refactor inverting the archive-vs-bus-emit ordering. Belt-and-suspenders code with no test is dead-on-arrival defence: it's structurally an `feedback_recovery_branch_reachability` case — the line exists but if a future refactor accidentally guards it (`if (someCondition)`) or returns earlier, no test catches it.

Severity P1 — the comment itself says "explicit cleanup here guards against any ordering being inverted by a future refactor"; the test gate for that future-refactor protection IS the missing test.

**Specify:** Add an archiveSession council-branch test that asserts `clearPendingSyntheticTurn(group.primary.sessionId)` is called.

### P1.4 — Deferred 5-step race-regression integration test is the precise gap component coverage can't fill

Context-brief paragraph 31: "5-step race-regression integration test (fire → user-frame → can_use_tool DENY → result-frame → can_use_tool ALLOW) deferred — requires full pipeline orchestration with FakeClock. Component-level coverage present."

The component coverage in claude-adapter.test.ts and ws-bridge.test.ts each test ONE node of the pipeline in isolation. The defect class that an integration test catches is the **cross-module probe state desync** — e.g. bridge probe says "synthetic-in-flight" but adapter's `isSyntheticTurnInFlight` closure (lines 1027-1029 in ws-bridge.ts) was captured at construction time with a stale null probe; OR the result-frame fires `noteTerminalResultFrame` but the orchestrator's idleTimerManager has already been re-armed by `noteUserMessage`, producing a stale-token state where the next can_use_tool gate decision is wrong.

These are exactly the surfaces that pass every component test individually and fail in the 5-step interleaving. The PR claims "component coverage is sufficient stand-in" but this is `feedback_partial_fix_passed_as_complete`: the integration boundary IS the defect surface, and shipping without that test is shipping with the highest-risk path uncovered.

Severity P1 because the production path involves synchronous probe reads from THREE classes (IdleTimerManager, WsBridge, ClaudeAdapter) coupled by late-injection — the highest-risk pattern in the codebase, and the one whose component tests provably cannot stand in for an end-to-end test.

**Specify:** Add the deferred test. FakeClock + spy on `noteTerminalResultFrame` + spy on `noteUserMessage` + drive the 5-step sequence + assert the deny→allow flip happens at the correct edge. The PR description's scope-deferral is reasonable as a PR-bounding choice but the test must land before the next PR builds atop this surface.

---

## P2 — Fix Soon

### P2.1 — `sendOrchestratorSyntheticFrame` adapter-method error paths all untested

**File:** `web/server/claude-adapter.ts:1106-1172` (new in this PR).

The method has 5 returns: `socket_disconnected` (no socket), `socket_disconnected` (readyState ≠ 1), `backpressure`, `failed` (NDJSON line-discipline violation), `failed` (send threw). The bridge wrapper at `ws-bridge.ts:328-335` adds 3 more: `session_unknown`, `adapter_missing`, `unsupported_backend`.

**Zero tests in this PR exercise any of these.** No assertion that the line-discipline check actually rejects content with embedded newline. No assertion that backpressure threshold is consulted. Compare to the parallel `sendUserFrameFromServer` which has explicit tests for backpressure + line-discipline (existing tests above the new diff).

Severity P2 — these are the failure-recording paths the EC-9 logger relies on; untested but not security-critical.

**Specify:** For each return-kind, add a one-line test exercising the trigger:
- `new ClaudeAdapter(...)` without `attachWebSocket` → expect `socket_disconnected`.
- Stub socket with `getBufferedAmount() => OBSERVER_WAKE_BACKPRESSURE_THRESHOLD_BYTES + 1` → expect `backpressure`.
- `sendOrchestratorSyntheticFrame("text with\nnewline")` → expect `failed` with line-discipline error message (NB: JSON.stringify embeds `\\n` literal, but the test should still verify the gate exists since the comment claims it does — write a test using literal `\\n` to confirm the regex actually catches the case it claims to).

### P2.2 — `index.ts` outcome→error-detail mapping untested

**File:** `web/server/index.ts:141-160` (new in this PR).

```ts
const errorDetail =
  outcome.kind === "backpressure" ? `backpressure(buffered=${outcome.bufferedAmount})`
  : outcome.kind === "failed" ? `failed(${outcome.error})`
  : outcome.kind;
```

This is the EC-9 forensic-trail formatting — it shapes the `idle-timer.fire-failed` log line that operators read in post-incident. If it drifts (e.g. `outcome.bufferedAmount` becomes a string and `${}` interpolation silently logs `"undefined"`, or a new outcome kind is added and lands in the fallthrough), there's no test gate.

Severity P2 — observability path, not user-visible until incident.

**Specify:** Extract the mapping to a pure function `mapOutcomeToErrorDetail(outcome): string` and unit-test each kind. Alternatively, inject a spy `logEvent` into IdleTimerManager and assert the string-shape format for each outcome.

### P2.3 — Real-time `await new Promise((r) => setTimeout(r, 5))` for timestamp advance — flake risk on slow CI

**File:** `web/server/ws-bridge.test.ts` — appears 4× in 11.7 dispatcher tests (lines 2785, 2812, 2845 onward).

The tests use real wall-clock sleep to ensure `Date.now()` advances between captures. On a heavily-loaded CI runner where the test suite is parallelised + node is under GC pressure, 5ms is tight. A flaky test that retries-to-green erodes signal — sibling of `feedback_alert_text_symptom_not_cause`.

The codebase already injects `ClockSource` via DI elsewhere (per CLAUDE.md PR #45 foundation work — "envelope contract + ClockSource DI + orchestrator turn-state"). Using the same pattern here would eliminate the real-time sleep.

Severity P2 — flake-risk pattern, not currently observed failing.

**Specify:** Inject the `ClockSource` into WsBridge (already an architectural seam) and use it for `lastCliActivityTs = clock.now()`. Tests then advance with `clock.advance(5)`.

### P2.4 — `result`-frame replay-defence test verifies the negative but not the boundary

**File:** `web/server/claude-adapter.test.ts:1816-1840` ("handleResultMessage does NOT call noteTerminalResultFrame when already awaiting-input").

The test feeds a result-frame from default awaiting-input state, asserts no call. Good. But there's an adjacent edge: what if the adapter receives in-flight → result-frame → another duplicate result-frame (CLI replay during reconnect)? The first should fire `noteTerminalResultFrame`, the second should NOT (now back to awaiting-input, the guard catches it). The test only exercises a single result-frame in awaiting-input state; it does not exercise the doubled-result scenario explicitly.

Severity P2 — boundary case mentioned in the source comment ("guards against double-fire on CLI reattach replay") but not directly tested.

**Specify:** `adapter.send({user_message})` → `handleRawMessage(result)` → assert call count 1; `handleRawMessage(result)` again → assert call count STILL 1 (not 2).

### P2.5 — EC-6 canary `extractFunctionBody` uses `indexOf(body)` for span-tracking — subtle fragility

**File:** `web/server/ws-bridge.test.ts:2862-2880`.

The canary extracts each function body via regex+brace-counting, then determines whether a mutation match falls inside an allowed body via `src.indexOf(body) >= match.index && match.index < indexOf(body) + body.length`. If two methods happen to have byte-identical bodies (e.g. both `{ return; }`), `indexOf` returns the same offset for both lookups, conflating which body the match belongs to.

In practice this won't trigger today (the two bodies are obviously different), but the algorithm has the fragility. The more robust pattern is to record the body's offset at extraction time (return `{body, startIdx, endIdx}`).

Severity P2 — implementation-detail of the canary itself; would only mislabel which function a match was in, not whether it was disallowed.

**Specify:** Have `extractFunctionBody` return `{body: string, start: number, end: number}` so the inAllowed check uses the recorded offset, not a re-indexOf.

---

## P3 — Consider

### P3.1 — `describe` named by method/feature instead of behaviour

**File:** All three test files.

`describe("noteCliActivity dispatcher (Task 11.7 — idle-kill clock split)")`, `describe("onUserFrameObserved (Task 11.6)")`, `describe("auto-proceed denylist gate (Task 11.8)")` — these are method-named or task-id-named. Beck's TDD-from-the-Inside-Out recommends behaviour names: `describe("when a synthetic turn is in flight")`, `describe("when the user types in a second tab")`. Task-ID prefixes are useful for archaeology but couple test organisation to PR boundaries; in 6 months the task numbers are noise.

Severity P3 — organisation, not correctness.

### P3.2 — Test-and-impl co-committed without intermediate failure evidence

**File:** Git history `git log main~1..main` shows tests + impl committed together in the squashed commit. Combined with quality-testing.md P3 signal, this is one of three usual smells (here: 1/3 — the expected values are explicitly derived from spec, not from implementation internals like UUIDs, AND there's no missing-happy-path or assertion-free pattern). Calling it out per the principle but it does NOT compound into a P1 here.

Severity P3 — signal-only, no action.

### P3.3 — No replay-based fixture for the `result` NDJSON frame

**File:** `web/server/claude-adapter.test.ts:1782-1796`.

The result-frame is hand-crafted JSON: `{type:"result", subtype:"success", duration_ms:1, ...}`. Per quality-testing.md Principle 9, the Aura recorder is a free fixture library and protocol parsers SHOULD be tested with replay-based fixtures. The adapter has existing replay-based tests elsewhere in this file; the new tests opted for inline. Not a defect, but inconsistent with the project's documented EC-6 conventions for protocol modules.

Severity P3 — would tighten realism, low ROI.

---

## What this test set does well (counter-evidence to AI-cheating concerns)

To be fair to the implementation:

1. **Expected values are spec-derived, not implementation-derived.** No UUID-shaped expectations, no exact-millisecond timing assertions. The denial-message regex is permissively anchored on `auto-proceed`, the discriminated-union assertions use exact-shape `{kind: "in-flight"}` which is the spec contract, not an internal token.
2. **Real socket fakes** (`makeCliSocket`, `makeBrowserSocket`) drive the adapter through its real pipeline — `handleCLIMessage` → `parseNDJSON` → `routeBrowserMessage`. This is not mock-heavy theatre; the mocks are at the WebSocket transport boundary which is the right boundary.
3. **Multiple-observer + error-isolation test** (`s-uf-6`) is exactly the kind of negative-space test most AI-generated suites omit — it verifies the try/catch wrap actually works.
4. **EC-6 canary is well-anchored** (function-name regex + brace-counting per `feedback_static_grep_canary_regex_over_substring`), survives renames of parameter / access modifier / return-type annotation, and the inline JSDoc explains the design choices honestly.
5. **The "no probe configured → gate falls open" test** is the right risk-calibrated test: it verifies the safe-default explicitly rather than assuming it.
6. **No .skip / .todo / xit / weakened assertions** introduced. Pre-existing `.toBeDefined()` hits in ws-bridge.test.ts are outside this PR's diff.

The component-level coverage is significantly above the LLM-test-quality floor. The defects are all at the **integration seam** — exactly the surface that AI-generated test suites systematically under-cover because integration assertions require holding more context than a single function.

---

## Decision summary

| Severity | Count |
|----------|-------|
| P1 | 4 |
| P2 | 5 |
| P3 | 3 |

**Recommend merge with P1 follow-up issue.** The component-level tests are strong enough to ship the PR (they would catch most regressions of the individual functions). The integration-level gaps (P1.1–P1.4) are real false-confidence risks and should be closed in a follow-up before the next PR builds atop this surface. The deferred 5-step race-regression integration test (P1.4) is the highest-leverage missing test in the entire auto-proceed plan because it is the only test that catches cross-module probe-state desync — exactly the defect class the late-injection architecture invites.

The EC-6 canary is well-designed and is a legitimate model for future similar invariants in this codebase.
