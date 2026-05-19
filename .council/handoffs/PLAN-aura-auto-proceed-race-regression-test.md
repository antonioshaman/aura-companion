# Council Plan (Aura): P1 Beck P1.4 — auto-proceed cross-module probe-state interleaving regression test

**Scope:** One new server-side Vitest integration test file `web/server/auto-proceed-race-regression.test.ts` (~80-120 LOC) catching cross-module probe-state desync across `IdleTimerManager` ↔ `WsBridge` ↔ `ClaudeAdapter`, deferred from Council Review 2026-05-15-0336 (finding #7, P1.4 from Beck — closes EC-18).
**Context:** The auto-proceed pipeline couples three classes via late-injection probe DI (AP-4). Component-level tests cover each class in isolation but cannot catch the integration boundary where the bridge probe says `synthetic-in-flight=true` while the adapter's closure captured a stale probe at construction time. This test is the first concrete enactment of EC-18.
**Boundaries:** Test-only. No production code changes. No god-module split (#8), no `IdleTimerProbe` named export (#9), no origin threading (#12) — those are separate queue items.
**Council dispatched:** Beck (P1.4 owner — 10 recs), Realtime/NDJSON (5), Backend (5), Persistence (4), Willison (4), Fowler (4), Friedman (1). Hunt, Subprocess, React, a11y, Saarinen, Deploy: "no recommendations — out of lane" (confirmed coverage).

---

## Task Sequence

### 1. File placement, name, and single-`describe` shape

| | |
|---|---|
| **Domain** | Fowler × Beck — Refactoring P6 "Architecture earns its boundaries" + Testing organisation |
| **Ref** | `references/refactoring.md` → P6; `references/quality-testing.md` → P5 organise by behaviour |
| **Depends on** | — |

The file lives at `web/server/auto-proceed-race-regression.test.ts` — sibling of `auto-proceed-orchestrator-bindings.test.ts`, NOT folded into `ws-bridge.test.ts` or `session-orchestrator.test.ts`. EC-18 is the reason-to-change: when the cross-module probe contract evolves, this file changes, and only this file. Drop the word "race" from the describe title — under FakeClock the interleaving is deterministic; "race" invites flake-tolerant retries. The describe should encode three asserted invariants: (a) flag stickiness across orthogonal inbound, (b) denylist gate consults LIVE probe state, (c) terminal `result` frame is the sole closer.

---

### 2. Bootstrap wiring with real instances — inline, no `buildTestPair()` helper

| | |
|---|---|
| **Domain** | Fowler — Refactoring P1+P2 (economy + speculative generality) |
| **Ref** | `references/refactoring.md` → P1, P2 |
| **Depends on** | Task 1 |

Construct REAL `IdleTimerManager`, `WsBridge`, `ClaudeAdapter` in `beforeEach`. Wire via `orchestrator.setIdleTimerManager()` + `wsBridge.setIdleTimerProbe()` per AP-4. Sequence and setter names must be visible top-to-bottom — no helper file (`auto-proceed-integration-harness.ts`) until a SECOND test in this family exists and the two construction sequences agree on shape. Rule of Three governs the extraction trigger.

---

### 3. Single linear `it()` with 5 step comments, terminal-state snapshot

| | |
|---|---|
| **Domain** | Beck × Fowler — Testing P5 + Refactoring P2 |
| **Ref** | `references/quality-testing.md` → P5; `references/refactoring.md` → P2 |
| **Depends on** | Task 1 |

The 5 steps are one causal chain; split into five `it()` calls creates hidden ordering coupling and breaks "passes alone, fails in suite" diagnostic clarity. Use comment markers `// Step N:` as paragraph breaks. End the test with ONE full-state snapshot assertion (`isSyntheticTurnInFlight`, `iterationCount`, last CLI outbound frame, last browser outbound frame) — piecewise asserts tempt selective relaxation. Step 2 (flag still true after browser user-frame) is the load-bearing mutation-resistance gate; mark it explicitly.

---

### 4. FakeClock from `clock-source.ts` — no `vi.useFakeTimers`

| | |
|---|---|
| **Domain** | Beck — Testing P2 (test seams mirror production seams) |
| **Ref** | `references/quality-testing.md` → P2 |
| **Depends on** | Task 2 |

The production seam is `ClockSource` DI; `vi.useFakeTimers` mocks a different surface entirely and de-tests the wiring. Pass `new FakeClock(0)` into `IdleTimerManagerDeps.clock`. Advance via `clock.advance(idleMs)`. Verify no `vi.useFakeTimers()` / `vi.setSystemTime()` calls exist anywhere in the file — those would invert the seam and reduce the test to parallel-reality theatre.

---

### 5. Typed frame construction from `session-types.ts` exports

| | |
|---|---|
| **Domain** | Realtime × Backend × Beck — convergent (3-expert structural truth) |
| **Ref** | `references/quality-realtime.md` → P7 protocol drift; `references/quality-backend.md` → P8 type safety at boundary; `references/quality-testing.md` → mutation resistance |
| **Depends on** | Task 2 |

Bind every CLI-direction frame to the EXACT type from `session-types.ts` — `can_use_tool` is a `CLIControlRequestMessage` with `request.subtype="can_use_tool"`, `request.tool_name`, `request.input`, `request.tool_use_id` (nested one level, NOT flat). `result` is `CLIResultMessage` with all required fields. Declare frames as `const req: CLIControlRequestMessage = {...}` so schema bumps fail compile rather than the test passing against a fake shape. The deny path in `claude-adapter.ts` reads `msg.request.tool_name` — flat-shape hand-rolling would trigger the gate by accident and tell nothing about real CLI behaviour.

---

### 6. CLI-side frames enter through NDJSON line-split, not parsed-message handler

| | |
|---|---|
| **Domain** | Realtime/NDJSON — P1 line-splitting fidelity |
| **Ref** | `references/quality-realtime.md` → P1 |
| **Depends on** | Task 5 |

Feed `can_use_tool` and `result` frames as `JSON.stringify(frame) + "\n"` through the same `ClaudeAdapter` socket message handler a real CLI subprocess uses. Calling `routeCLIMessage` (or worse, `handleControlRequest`) directly short-circuits the buffer+line-split+dedup+protocol-drift-default path — the test would pass even if NDJSON framing regressed. Browser-side frames continue to enter at `WsBridge.routeBrowserMessage` (correct already per scope).

---

### 7. Spy strategy — observer-only spies on prototype; prefer public-state observation

| | |
|---|---|
| **Domain** | Fowler × Backend × Beck — convergent (3-expert) |
| **Ref** | `references/refactoring.md` → P4 names reveal design; `references/quality-backend.md` → Bun-specific; `references/quality-testing.md` → P3 mock almost nothing |
| **Depends on** | Task 2 |

Three rules: (a) never fabricate a probe-shaped literal `{ isSyntheticTurnInFlight: ..., noteTerminalResultFrame: ... }` — that becomes a 6th EC-14 inline duplicate; (b) `vi.spyOn(manager, "noteUserMessage")` only as an observer-spy (no `mockImplementation`) — but PREFER reading `manager.isSyntheticTurnInFlight(sid)` and `manager.getIterationCount(sid)` as public-state observation, not call-shape coupling; (c) verify the production wiring calls methods through live property access — if the bridge captured `probe.isSyntheticTurnInFlight.bind(probe)` at construction, `vi.spyOn` on the prototype is a no-op and the test silently de-spies. Where prototype-spy is shaky, assert via outbound WS frames or public flag state.

---

### 8. Assertion surface — outbound WS frames at the boundary, full `tool_use_id` correlation

| | |
|---|---|
| **Domain** | Beck × Backend × Friedman — convergent (3-expert) |
| **Ref** | `references/quality-testing.md` → P3+P6; `references/quality-backend.md` → P2 boundary validation; `references/quality-ux.md` → P9 trust through consistent observable state |
| **Depends on** | Task 7 |

Capture outbound frames at the WS `send` seam (reuse the inline stub pattern from `ws-bridge.test.ts:2805-2876`). For step 3: assert `behavior: "deny"` AND `tool_use_id === <id from request>` — weak `toContain("deny")` would pass on cross-correlation bugs (right action, wrong target). For step 5: assert browser `permission_request` carries correct `tool_use_id` and tool spec. The user experience IS the broadcast frame; internal flag state and broadcast output can drift independently (Friedman).

---

### 9. Async drain discipline — `await` every bridge entry, no microtask hand-waving

| | |
|---|---|
| **Domain** | Backend — Async TS error discipline (P7) |
| **Ref** | `references/quality-backend.md` → P7 |
| **Depends on** | Task 2 |

`routeBrowserMessage` and `claude-adapter`'s message handler are async with durable side-effects (probe flag write, recorder, broadcast). Every step `await`s the entry point directly — never substitute `await Promise.resolve()` microtask drain or `vi.runAllTimersAsync` for awaiting the I/O. Step 2's user frame must be fully drained before step 3's `can_use_tool` enters, otherwise probe-read ordering becomes ambiguous and the test asserts against an interleaving production never sees.

---

### 10. Inject fakes for `persistTrace` + `appendSummary` — no disk side-effects

| | |
|---|---|
| **Domain** | FS-JSON Persistence — P3 close every state, P9 don't build on filesystem assumptions |
| **Ref** | `references/quality-persistence.md` → P3, P9 |
| **Depends on** | Task 2 |

`IdleTimerManagerDeps.persistTrace` and `appendSummary` MUST be in-memory capture fakes — wiring the real `writeAutoProceedTrace` / `appendAfkSummary` would create `<workspaceRoot>/.council/state/<group>-auto-proceed-trace.json` and `-afk-summary.md` artefacts on every fire (the brief says test-only; persistence side-effects contradict that). Pattern: copy the `realManagerDeps()` shape from `auto-proceed-orchestrator-bindings.test.ts` but with no-op writers. Do NOT call `wsBridge.setRecorder(...)` — keeping the default `recorder = null` ensures no JSONL recording is written under `~/.companion/recordings/`.

---

### 11. `afterEach` teardown — `disposeAll` + reverse-construction order

| | |
|---|---|
| **Domain** | Backend × Persistence — convergent |
| **Ref** | `references/quality-backend.md` → P5 resource lifecycle; `references/quality-persistence.md` → P3 |
| **Depends on** | Task 2 |

`IdleTimerManager.disposeAll()` cancels every armed timer in one pass (line 425-432 of source) — call in `afterEach` BEFORE rebuilding the harness. Teardown order: adapter detach → bridge dispose → manager `disposeAll` → FakeClock reset. Track every constructed instance in `let` declared at describe scope so a `beforeEach` throw still hits teardown. This is non-negotiable even under FakeClock — a future swap to `SystemClock` would otherwise turn the test into the "passes alone, fails in suite" canary it's supposed to catch.

---

### 12. EC-19 static-grep canary — `routeBrowserMessage` reads probe LIVE, not via captured reference

| | |
|---|---|
| **Domain** | Beck — Testing mutation resistance + EC-19 |
| **Ref** | `references/quality-testing.md` → structure-insensitive assertions; conventions.md EC-19 |
| **Depends on** | Task 7 |

Add one canary `expect` reading the source of `WsBridge.routeBrowserMessage` (or the function reachable from it that consults the probe) via the `inspect.getSource`-style FS read. Regex over `\w+` placeholders per `feedback_static_grep_canary_regex_over_substring`: `probe(?:Manager)?\.isSyntheticTurnInFlight\(\s*\w+\s*\)` and similar for `noteTerminalResultFrame`. Catches a future refactor caching `const probe = idleTimerProbe` at module top — re-introduces stale-closure class while runtime test still passes because cache is populated post-bootstrap. Runtime + canary together close the door.

---

### 13. Breadcrumb comments for adjacent invariants — keep this file scoped

| | |
|---|---|
| **Domain** | Willison — LLM P3 (gate by rule first) + P8 (validator boundary visibility) |
| **Ref** | `references/quality-llm.md` → P3, P8 |
| **Depends on** | Task 3 |

Three single-line comments inside the test body, each pointing to a sibling test that covers an adjacent invariant: (a) at step 3, `// Probe-null fail-CLOSED coverage lives in auto-proceed-permissions.test.ts`; (b) in the test docstring, `// This test bypasses boundary-validator.ts deliberately; validator-decision coverage in <sibling>`; (c) at step 4, `// Error/abort terminal states covered in <sibling>; this asserts the documented terminal predicate fires once`. The breadcrumbs prevent a future refactor from deleting "redundant" assertions in the wrong file and silently uncovering the most dangerous regression class for EC-17.

---

## Risks & Watchpoints

- **Realtime/NDJSON — Codex parity (P8):** The probe interface is CLI-agnostic, but `claude-adapter.ts` is the only call site exercised here. A `claude+codex` pairing's auto-proceed safety has zero integration signal. **Follow-up:** schedule a sibling `auto-proceed-race-regression-codex.test.ts` after this lands. Optionally rename this file to `-claude` suffix at write-time to make the gap visible.

- **Realtime/NDJSON — Replay-based corpus (P7+EC-6):** This test SHOULD synthesise frames (Willison wins on SUT-axis argument — state-machine, not parser). A separate `auto-proceed-protocol-shape.test.ts` based on a recorded JSONL slice of a real auto-proceed cycle is warranted to catch CLI version bumps that rename `subtype` or wrap fields. **Out of scope** for this 80-120 LOC file.

- **Backend — Structured-log assertions (P6):** Probe-state transitions deserve EC-9 structured log lines, but coupling that assertion into this file inverts the diagnostic value. **Out of scope.** Add `auto-proceed-log-canary.test.ts` if/when needed.

- **Persistence — Recorder env contamination (P5):** If a future change wires `wsBridge.setRecorder(...)` in the test, `~/.companion/recordings/` will be created on the developer's machine and a 5-minute cleanup interval will survive `afterEach`. **Mitigation:** explicitly assert `wsBridge.recorder === null` after construction; document this in a comment near the bootstrap.

- **Fowler — Helper extraction trigger:** If a second integration test in this family arrives, extract a harness file ONLY when both call sites' actual needs agree on shape. Premature extraction creates a parallel-but-different wiring API to `auto-proceed-orchestrator-bindings.test.ts`'s inline setup.

- **Beck — LOC ceiling:** 80-120 LOC budget for one describe. If the implementation crosses 150 LOC, the smell is "this test asserts too many things" — split into two describes (e.g. "stickiness across user frames" vs "denylist gate liveness"), not extract harness.

---

## External Setup Required

No external setup required. All tasks can be implemented within the codebase. No new env vars, no new CI gate, no Dockerfile change, no new dependencies.

---

## Summary

| # | Task | Domain | Depends on |
|---|------|--------|------------|
| 1 | File placement + name (no "race" word) | Fowler × Beck | — |
| 2 | Bootstrap real instances, no helper | Fowler | 1 |
| 3 | Single linear `it()`, 5 step comments, terminal snapshot | Beck × Fowler | 1 |
| 4 | FakeClock from clock-source.ts | Beck | 2 |
| 5 | Typed frame construction from session-types | Realtime × Backend × Beck | 2 |
| 6 | CLI frames via NDJSON line-split | Realtime | 5 |
| 7 | Observer-only spies; prefer public state | Fowler × Backend × Beck | 2 |
| 8 | Assert outbound WS frames + tool_use_id correlation | Beck × Backend × Friedman | 7 |
| 9 | Async drain discipline | Backend | 2 |
| 10 | Fake persistTrace + appendSummary; recorder=null | Persistence | 2 |
| 11 | afterEach disposeAll + reverse-construction | Backend × Persistence | 2 |
| 12 | EC-19 static-grep canary for live probe read | Beck | 7 |
| 13 | Breadcrumb comments to sibling tests | Willison | 3 |

## Verdict

The most important architectural decision in this plan is **Task 5 + Task 7's convergent insistence on real wire-shape types and observer-only spies on real instances** — this is the difference between a test that defends EC-18's actual integration boundary versus a test that passes against a fictional shape. The closest domain expert is Kent Beck (this IS his finding); the implementer should start with Task 1+2 (file shape + bootstrap), then Task 5 (frame typing) before any assertion is written — letting the types drive shape correctness before mocking discipline is layered on. If a council pair agent is valuable during build, surface Beck's `quality-testing.md` reference as the implementation orienting text.

Cross-module probe-state desync IS the defect surface for cross-class probe wiring (`feedback_cross_module_di_integration_test`). This plan implements EC-18; it does NOT extend it.
