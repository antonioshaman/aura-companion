# Backend Quality Review — Bun + Hono + TypeScript

Reviewer: Bun + Hono + TypeScript Backend Expert (Carmack × Collina × Bun/Hono synthesis)
Scope: `web/server/ws-bridge.ts`, `web/server/session-orchestrator.ts`, `web/server/index.ts`
Stack: Bun 1.0+ + Hono 4.7 + TypeScript strict
Convention floor (AP-1/2/3, EC-1/2/5/6/7/9/13) — NOT re-flagged.

---

## Verdict on the four lane questions

1. **Late-injection null-window** — Structurally closed. `wsBridge.setIdleTimerProbe(...)` at `index.ts:171` runs synchronously BEFORE `Bun.serve(...)` (line 324), so no WS event can route to `routeBrowserMessage`/`attachBackendAdapter`/`handleCLIOpen` before the probe lands. The closures captured by `new ClaudeAdapter` (`ws-bridge.ts:1032-1035`) read `this.idleTimerProbe` lazily — `?? false` / `?? noop` covers the null state safely. `wsBridge.restoreFromDisk()` doesn't construct adapters (`backendAdapter: null` at line 374). `cronScheduler.startAll()` (line 499) and `agentExecutor.startAll()` (line 504) which call `injectUserMessage → routeBrowserMessage` run AFTER `orchestrator.initialize()` (line 199), so observers are registered by then. **No production code path can call `sendOrchestratorSyntheticFrame` before `setIdleTimerProbe` lands.**

2. **Event-listener registration timing for cross-tab user frames** — Closed. `companionBus.on("session:exited", ...)` and `wsBridge.onUserFrameObserved(...)` both register inside `orchestrator.initialize()` (lines 495-510). `initialize()` runs at index.ts:199, before Bun.serve, before any bus emit can fire. No live session can exit between bridge construction and `initialize()` because `launcher.restoreFromDisk()` (line 263 of cli-launcher.ts) mutates `info.state` without emitting `session:exited`. **No cross-tab user frame can land before the observer is registered in production.**

3. **Idempotency truth of `clearPendingSyntheticTurn`** — Verified. `idle-timer-manager.ts:402-406` reads `this.states.get(sessionId); if (!state) return; state.pendingSyntheticTurnToken = null;` — yes idempotent on never-armed sessions, yes idempotent on repeat calls (same field reassigned null). The comment at `session-orchestrator.ts:2747` ("Idempotent — calling twice is a no-op") is accurate. `noteTerminalResultFrame` is structurally identical (same body modulo doc), so the dual-cleanup path in `archiveSession` is safe.

4. **Throw-isolation in `routeBrowserMessage` observer-fire** — Verified. `ws-bridge.ts:1523-1532` wraps each observer call in its own try/catch INSIDE the for-loop. A throwing observer is caught, logged via `log.warn`, and the loop continues to the next observer. Control then falls through to `appendHistory(session, userMessage)` at line 1540 unconditionally. **History append always happens regardless of observer outcome.** This is the documented and tested contract.

---

## Findings (P1/P2/P3)

### P2-1 — `injectUserMessage`/`injectMcpSetServers` fire `userFrameObservers` outside a real browser context, eagerly advancing the auto-proceed turn-token without a user typing

**File:** `web/server/ws-bridge.ts:1229-1247`, `web/server/agent-executor.ts:224`, `web/server/cron-scheduler.ts:151`, `web/server/linear-agent-bridge.ts:361`, `web/server/routes/system-routes.ts:225`
**Failure mode:** `injectUserMessage(sessionId, content)` calls `routeBrowserMessage(session, {type:"user_message", content})` which, in the `msg.type === "user_message"` branch (line 1516), fires every observer in `userFrameObservers`. Production observer is `IdleTimerManager.noteUserMessage` which calls `state.turnToken += 1` and `state.timer?.cancel()`. So a cron-scheduled prompt, an agent-executor prompt, a Linear-bridge bridge message, or a REST `POST /sessions/:id/message` injection ALL count as "user typed" for auto-proceed purposes. For a council pair where the orchestrator is being driven by cron or agent automation, this silently cancels every armed auto-proceed timer and increments the turn-token on every injection — exactly the behaviour the synthetic-frame split was designed to PREVENT for `server:auto-proceed`-originated frames.
**Concrete consequence:** A cron-driven session that fires every 5 minutes will never reach auto-proceed because every injection resets the turn-token. The user sees auto-proceed as broken for cron+council pairs without any diagnostic.
**Severity rationale:** Validation gap at boundary (Principle 2) + clock-axis asymmetry. Type/intent drift between "server-originated injection" (should be invisible to auto-proceed) and "browser-originated frame" (should be visible).
**Recommendation:** Either (a) thread an `origin: "browser" | "server:cron" | "server:agent" | "server:linear" | "server:auto-proceed"` flag through `routeBrowserMessage` so observers can filter (mirrors the recorder origin pattern already documented in CLAUDE.md), OR (b) fire `userFrameObservers` only inside `handleBrowserMessage` (which truly originates from a browser socket) and skip the fire in the inject* helpers. The latter is the smaller diff; the former is the more honest model.

### P2-2 — `noteUserActivity` on Codex backends bypasses the synthetic-aware split because Codex adapters aren't wired through the same idleTimerProbe DI

**File:** `web/server/ws-bridge.ts:1018-1036` (Claude path) vs `web/server/cli-launcher.ts:1028`/`1240` (Codex path)
**Failure mode:** The narrow probe is only injected into `new ClaudeAdapter(...)` constructor at `ws-bridge.ts:1018`. Codex adapters are constructed in `cli-launcher.ts` and attached via `companionBus.on("backend:codex-adapter-created", ...) → wsBridge.attachBackendAdapter` (session-orchestrator.ts:664-666). The bridge's `attachBackendAdapter` path correctly routes CLI activity through `this.noteCliActivity(session)` (ws-bridge.ts:662), which queries the bridge's own `idleTimerProbe` — so the activity-callback side IS synthetic-aware. HOWEVER: `sendOrchestratorSyntheticFrame` early-returns `unsupported_backend` for Codex (ws-bridge.ts:333-336), and Codex adapter has no `pendingSyntheticTurnToken` concept. So for `claude+codex` council pairs where the orchestrator is Codex, the auto-proceed pipeline degrades to "fire is impossible" rather than "fire skipped with structured reason."
**Concrete consequence:** Mixed-backend council pairs silently never auto-proceed when the orchestrator is Codex. The CLAUDE.md "All features must be compatible with both Codex and Claude Code" rule isn't met for orchestrator-Codex; needs an explicit UI gating affordance OR a fire-skip log carrying `reason=codex_orchestrator_unsupported`.
**Severity rationale:** Cross-backend compatibility gap; documented limitation but not surfaced.
**Recommendation:** In `IdleTimerManager.fire()`, before calling `sendSyntheticFrame`, check the session's backend type and skip with structured log `{event:"idle-timer.fire-skipped", reason:"codex_orchestrator_unsupported"}`. Alternatively, document in the auto-proceed PLAN that Task 11 ships claude-orchestrator-only.

### P3-1 — Observer-throw log line missing `event` field (EC-9 spirit)

**File:** `web/server/ws-bridge.ts:1527-1530`
**Failure mode:** `log.warn("ws-bridge", "userFrameObserver threw", { sessionId, error: String(err) })`. EC-9 (convention floor) requires structured JSON log lines with `event` + `sessionGroupId` + `sessionId` + `role` for group-lifecycle events. This isn't strictly a group-lifecycle event, but it IS a load-bearing failure mode for the auto-proceed pipeline that should be queryable. Without an `event` key the line is grep-only.
**Concrete consequence:** Production debugging of "why didn't auto-proceed fire" requires fuzzy substring search instead of `jq 'select(.event=="ws-bridge.user-frame-observer-threw")'`.
**Recommendation:** Add `event: "ws-bridge.user_frame_observer_threw"` to the log object.

### P3-2 — `error: String(err)` loses stack trace and `Error.cause` chain at observer-throw site

**File:** `web/server/ws-bridge.ts:1529`
**Failure mode:** `error: String(err)` produces e.g. `"Error: foo"` — drops the stack, drops `Error.cause`, drops the original constructor name for non-`Error` throws. Per Carmack/Collina Principle 8, catch with `unknown`, narrow with `instanceof Error`, log `err.stack` and `err.message` separately. This file already does the right thing elsewhere (e.g. line 654-658 uses `err instanceof Error ? err.message : String(err)` and structured `event`).
**Recommendation:** Match the existing pattern in session-orchestrator.ts:531-535 (`event`, `sessionId`, `error: err instanceof Error ? err.message : String(err)`). Optionally log `stack: err.stack` at debug level.

### P3-3 — `idleTimerProbe` field-level type declared inline on three surfaces (WsBridge field, `setIdleTimerProbe` param, `new ClaudeAdapter` opts) — drift risk

**File:** `web/server/ws-bridge.ts:119-122, 140-144, 1032-1035` plus `web/server/claude-adapter.ts:134-136, 195-198`
**Failure mode:** The probe interface `{ isSyntheticTurnInFlight(sid: string): boolean; noteTerminalResultFrame(sid: string): void }` is hand-redeclared at five sites. If a future task adds `noteUserMessage` or similar to the probe (mirroring the 11.7→11.8 widening called out in context-brief.md), at least one of the five copies WILL drift first. The context-brief explicitly references `feedback_verify_staged_files_match_implicated_set.md` lesson from `ffb48d3` — same risk class.
**Recommendation:** Hoist to a named type `export type IdleTimerProbe = { ... }` in `idle-timer-manager.ts` (which is the source of truth) and `import type { IdleTimerProbe }` at the three call sites. One declaration, four imports.

### P3-4 — `getSession` adapter narrowing via `as unknown as { orchestratorTurnState?: ... }` is structural-cast-around-cycle

**File:** `web/server/index.ts:108-113`
**Failure mode:** To avoid importing `ClaudeAdapter` from index.ts (cycle: index → ClaudeAdapter → wsBridge → index via the probe), the code does `(adapter as unknown as { orchestratorTurnState?: ... })?.orchestratorTurnState`. This is a runtime-only narrowing — a future rename of `orchestratorTurnState` on ClaudeAdapter won't fail typecheck here. Comment acknowledges this and points at `wsBridge.sendObserverWakeFrame`'s instance-check pattern, but the chosen escape is weaker.
**Concrete consequence:** Drift of the field name on ClaudeAdapter silently breaks the manager's `getSession` closure — manager sees `undefined` and skips fires with `reason=in-flight` (the safe default), so failure mode is "auto-proceed silently never fires."
**Recommendation:** Either (a) hoist `OrchestratorTurnState` type to a non-cycle module (e.g. `session-types.ts`) and use `IBackendAdapter` interface narrowing, OR (b) add an EC-6 static-grep canary asserting the field name on ClaudeAdapter source matches the structural cast in index.ts. The canary is the cheap fix.

### P3-5 — `setIdleTimerProbe(null)` is documented as a safe re-arm but has no production caller and no test for the re-arm path

**File:** `web/server/ws-bridge.ts:140-147`
**Failure mode:** The setter accepts `null` and the noteCliActivity dispatcher correctly handles `this.idleTimerProbe?.isSyntheticTurnInFlight(...)` returning undefined as "not synthetic → advance the clock." But nothing in production ever calls `setIdleTimerProbe(null)` — it's documented as "idempotent; calling with `null` re-arms the safe-default branch" but if that path ever ships as the recovery for a misbehaving manager, behaviour is untested.
**Recommendation:** Either remove the `null` parameter form (probe is required at runtime) and tighten the signature to `setIdleTimerProbe(probe: IdleTimerProbe): void`, OR add a unit test that exercises the `setIdleTimerProbe(null) → noteCliActivity → advance clock` path. The former is the smaller surface; mirrors the principle "don't ship code paths you don't test."

---

## Architectural notes (not findings — context for future passes)

- **Wiring-order discipline.** index.ts:89-174 contains a careful 5-step dance (orchestrator-with-noop-manager → real-manager-closing-over-orchestrator → setIdleTimerManager → setIdleTimerProbe → initialize). The comments explain WHY at each step. This is high-quality late-injection hygiene; the only structural concern is that it's all in one giant top-level script. If the file grows past ~700 lines (currently 620), consider extracting into a `bootstrap.ts` module with a named function `wireAuraServer({...})`. Not a finding for this PR.
- **Cyclic dependency between manager and orchestrator is real.** Manager needs `getSession`/`getGroupStatus` closing over the orchestrator + bridge; orchestrator's rehydrate calls into the manager. Late-injection is the correct fix here — alternatives (Lazy<T>, proxy) would push the cycle off the type system. Documented in the field-level JSDoc; good.
- **`session:exited` is now subscribed by THREE separate listeners in `initialize()`** (agent-executor handoff, exit-callbacks fan-out, state-machine terminated transition, scheduleProactiveRelaunch, clearPendingSyntheticTurn at 508, plus the council-half reconnect ladder at 1322). The bus isolates each handler's throw via `companionBus.on`, but the multi-listener pattern is harder to follow than a single dispatch function. Acceptable cost for now — consider documenting in CLAUDE.md that `session:exited` has 5+ listeners with explicit fanout order requirements.

---

## Summary

- 0 × P1 findings.
- 2 × P2 findings (cross-tab observer firing for server-originated injects; cross-backend codex orchestrator silent unsupported).
- 5 × P3 findings (logging metadata polish, type extraction, static-grep canary, null-arg unused path).

The four lane questions all check green. The late-injection pattern is hygienic; the observer-throw isolation correctly preserves history append; `clearPendingSyntheticTurn` idempotency is verified against the manager source; structured logging is present on the new error paths (with the P3-1 polish above). No null-window risk in production.
