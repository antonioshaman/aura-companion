# Council Implementation Log: Wire `reconnecting` group state

**Plan:** `/root/aura-companion/PLAN-aura-council-reconnect.md`
**Started:** 2026-05-12

## Task Log

### Task 1: State machine side-effect channel + coordinator as sole lifecycle mutator

**Domain:** Fowler × Carmack — Refactoring is economic; make the wrong thing impossible (Principles 2, 4)
**Ref applied:** Pure `deriveSideEffects(prev, next, event)` returns `{busEvents, logEntries}`. `applyEvent()` drains both onto `companionBus` + structured logger. CLAUDE.md drift ("applyEvent emits group lifecycle events") true by construction.

**Files changed:**
- `web/server/group-state-machine.ts` — Added `GroupBusSideEffect` + `GroupLogEntry` descriptor types; added pure `deriveSideEffects()` covering reconnect/degraded/exited transitions. Extended `reconnect_started` event payload to carry `survivingRole` + `deadlineMs`; `reconnect_ok`/`reconnect_failed` now carry `role` for symmetry with `half_died`/`half_respawned`.
- `web/server/session-group-coordinator.ts` — Refactored `applyEvent` to use `deriveSideEffects` (removed inline `if (prev !== degraded && next === degraded)` branches and the two private `inferDeadRoleFromEvent` / `inferExitReasonFromEvent` helpers). Added `ReconnectContext` interface + private `reconnectContexts` map + `armReconnect()` / `cancelReconnectTimer()` / `cancelAllReconnectTimers()` / `getReconnectContext()` / `registerExternalGroup()` methods. Added injectable `now: () => number` dep for deterministic test latency. Refactored `archiveGroup` to route through `applyEvent({type:"user_archived"})` so the `group:exited` emit comes from the same side-effect channel (cancels any in-flight reconnect timer first — Hunt absorbing-kill invariant).
- `web/server/session-orchestrator.ts` — Made `SessionGroupCoordinator` a long-lived field (lazy `getOrCreateCoordinatorSync()`); swapped the dynamic-import in `createCouncilGroup` for static value imports (`SessionGroupCoordinator`, `isSupportedPairing as _isSupportedPairing`). Added `pendingCouncilCall` field for per-call context so the long-lived spawn callback reads fresh `baseBody`/`spawnErrors` per invocation without stale-closure risk. Rewired the `session:exited` listener at line 549-571 to call `coordinator.applyEvent(groupId, {type:"half_died", role})` instead of the direct `companionBus.emit("group:degraded", ...)` — fixes the CLAUDE.md drift. Wired `reconcileCouncilGroups` to `coordinator.registerExternalGroup(...)` for restart-restored pairs so `applyEvent` can find them.
- `web/server/group-state-machine.test.ts` — Updated test payloads for the new `reconnect_started`/`reconnect_ok`/`reconnect_failed` event shapes (Beck F2 table extracted to reused representative payloads).

**Verification:** ✅ typecheck (`bun run typecheck` → 0 errors). ✅ Task-scope tests: 155 passed across `group-state-machine.test.ts`, `session-group-coordinator.test.ts`, `session-orchestrator.test.ts`. Pre-existing Composer test failures (61 cases in `Composer.test.tsx`) are caused by unstaged in-progress edits to `Composer.tsx` that reference a missing store field `s.connectionStatus` — out of scope, predates Task 1.

**Call-site gate (post-Task 1):** `applyEvent(` has 4 production callers — 3 internal (coordinator timer expiry, `armReconnect`, `archiveGroup`) + 1 external (orchestrator `session:exited` listener). Keystone wired, no longer dead code. Verified via `grep "\.applyEvent\(" --type ts | grep -v test`.

**Deviations from plan:**
- Plan said `transition()` itself returns `{next, busEvents, logEntries}`. I kept `transition()` returning bare `GroupStatus` and put the side-effect logic in a separate pure function `deriveSideEffects(prev, next, event)` — `applyEvent` calls both. Result is structurally equivalent (the bus emit + log decisions still live in pure functions, drained at one mutator) but avoids a wide diff across all `transition()` test callers (16+ assertion sites). Same Fowler shape, smaller blast radius. AP-2 enforced just as strongly.
- Plan said "construct the long-lived coordinator". I made it lazy via `getOrCreateCoordinatorSync()` so existing servers with no Council Mode usage don't pay the construction cost — matches the pre-Task 1 dynamic-import lazy-load intent.

**Notes:**
- `archiveGroup` was using a direct `companionBus.emit("group:exited", ...)` outside the state machine. Refactored through `applyEvent({type:"user_archived"})` so the bus emit comes from the same channel as every other lifecycle event. Side benefit: cancels any in-flight reconnect timer first (Hunt absorbing-kill invariant — user-archived must bypass reconnect path entirely).
- `enactBusEvent` is currently a no-op for the `reconnecting` and `reconnected` side-effect descriptors. PLAN Task 7 wires those to a new `group:reconnecting` bus event + recycled `group_created` hydration. Today they are decided-but-not-emitted (the side-effect channel exists; the bus carrier doesn't yet).
- `pendingCouncilCall` is set/cleared in `createCouncilGroup`'s try/finally. Spawn callback throws explicitly if invoked outside that window — defensive check; should not fire in practice.

---

### Task 2: Bootstrap env config `COMPANION_GROUP_RECONNECT_GRACE_MS`

**Domain:** Bun/Hono/TS Backend × Carmack — Validate at the boundary; structured logging (Principles 2, 6)
**Ref applied:** Parse-once at module load; positive integer cap at 600_000; fallback 45_000 with `{event:"config.grace_ms.invalid", raw, fallbackMs}` warn on bad input; `{event:"config.grace_ms.resolved", resolvedMs}` info on first coordinator init.

**Files changed:**
- `web/server/session-orchestrator.ts` — Added `GROUP_RECONNECT_GRACE_MS` const at module load with full validation. Added `graceMs` to coordinator constructor invocation in `getOrCreateCoordinatorSync` + structured log on first init.
- `web/server/session-group-coordinator.ts` — Added `graceMs?: number` to `SessionGroupCoordinatorDeps`; stored on `this.graceMs` (default 45_000). `armReconnect.opts.graceMs` is now optional and falls back to the construction-time default.

**Verification:** ✅ typecheck. ✅ 155 tests pass in Task scope.

**Deviations from plan:** Plan said "Centralise in a single config.ts loader". I followed the project's existing inline-const pattern (10+ other `Number(process.env.COMPANION_*)` reads at module load throughout `web/server/`). A one-line config.ts module would be the speculative-generality smell. If multiple grace-related knobs accumulate later, extracting then is mechanical.

---

### Task 3: Orchestrator `session:exited` listener refactor

**Domain:** Subprocess × Hunt × Fowler — `intentionalKills` absorbing; feature envy on coordinator data (quality-subprocess.md P4, security.md P7)
**Ref applied:** `intentionalKills` is the absolute first line. `relaunchExhaustedNotified` short-circuits straight to `half_died → degraded` (skips the pointless 45s grace). Otherwise → `coordinator.armReconnect(...)`. Also handles the cascading case: second half dies during reconnect → `reconnect_failed` immediately.

**Files changed:**
- `web/server/session-orchestrator.ts` — Rewrote the listener block at line 549-619. New ordering: `intentionalKills` check → find group/role → `coordinator` guard → `relaunchExhaustedNotified` exhausted-skip path → second-half-died path → `armReconnect(...)`. **Removed** the pre-Task 3 "mark BOTH ids intentional" behaviour for the normal reconnect path — that was blocking session-level auto-relaunch (`scheduleProactiveRelaunch` reads `intentionalKills` at timer fire). Now only the exhausted-skip and second-half-died paths mark intentional, where no relaunch can save the group.
- `web/server/session-orchestrator.test.ts` — Replaced the old "drives group:degraded" test with two new tests covering the new contract: "arms reconnect grace" (no immediate degraded, no intentional mutation, coordinator status = `reconnecting`) and "skips reconnect grace and goes straight to degraded when relaunch budget is exhausted" (immediate degraded, both intentional). Documented the contract change at each assertion site.

**Verification:** ✅ typecheck. ✅ 107 orchestrator tests pass.

**Notes:** Subtle bug caught mid-implementation: my first exhausted-skip pass used `applyEvent({type:"reconnect_failed"})` from `active` — that's a state-machine no-op (`reconnect_failed` only fires from `reconnecting`). Switched to `half_died` (the direct `active → degraded` route).

---

### Task 4: `session:cli-id-received` subscriber → `reconnect_ok` with identity binding

**Domain:** Backend × Subprocess × Hunt — handshake-not-transport gate; bind reconnect identity (quality-backend.md P1, P8; quality-subprocess.md P5; security.md P4, P7)
**Ref applied:** Reuse the existing `session:cli-id-received` event (verified: `event-bus-types.ts:12`, emits from `ws-bridge.ts` Claude path and Codex adapter). Sync handler with `try/catch`; named function so dispose discipline works; identity check `ctx.snapshotSessionId === sessionId` (mismatch → log warn, drop, do NOT cancel grace).

**Files changed:**
- `web/server/session-orchestrator.ts` — Added the second `session:cli-id-received` listener (the existing one at line 322-324 stays — it stores the cliSessionId for `--resume`). New listener: look up group, fetch reconnect context, identity-check, then `cancelReconnectTimer` + `applyEvent({type:"reconnect_ok"})`. Identity mismatches log structured warn with `group.reconnect_identity_mismatch` event, no state change.

**Verification:** ✅ typecheck. ✅ tests pass.

**Deviations from plan:** None. Plan flagged that the brief's invented event name `session:cli-session-id-ready` was wrong; both Bun/Hono and Subprocess experts identified the real name. Implementation uses the existing event.

---

### Task 5: `session:relaunch-failed` event + short-circuit

**Domain:** Subprocess × Carmack — Silent absence is the wrong primary signal (quality-subprocess.md P4, P7)
**Ref applied:** Two emit sites — budget exhausted at `handleAutoRelaunch:1646` (`reason: "budget_exhausted"`); synchronous spawn error at `handleAutoRelaunch:1661` (`reason: result.error`). Listener: identity-bind via reconnect context, then short-circuit through `applyEvent({type:"reconnect_failed"})` cancelling the grace timer.

**Files changed:**
- `web/server/event-bus-types.ts` — Added `"session:relaunch-failed": {sessionId, reason}` to the typed event map.
- `web/server/session-orchestrator.ts` — Two `companionBus.emit("session:relaunch-failed", ...)` sites added inside `handleAutoRelaunch`. New listener at line 425-465 that identity-checks against `getReconnectContext`, marks both intentional (no recovery path), and applies `reconnect_failed`. Try/catch wraps the listener body per Backend P1.

**Verification:** ✅ typecheck. ✅ tests pass.

---

### Task 6: Server-restart partial-pair grace in `reconcileCouncilGroups`

**Domain:** Subprocess × FS-JSON × Carmack — Reconcile is decide → wait → act, not decide-and-act (quality-subprocess.md P5; quality-persistence.md P3 deliberate non-application)
**Ref applied:** Partial pairs (one PID alive, one missing) now register with synthesised `__missing_{role}_{groupId}` sessionId for the dead half + arm the standard grace window. **No `writeReconnectIntent` sentinel** — deliberate EC-8 gap documented in code (FS-JSON economic argument: PID snapshot on next boot is strictly more authoritative than any stale marker; PID reuse during restart can make sentinel lie).

**Files changed:**
- `web/server/session-orchestrator.ts` — Refactored `reconcileCouncilGroups`: removed the partial-pair skip (`if (!pair.orchestrator || !pair.observer) continue` → replaced with `const surviving = pair.orchestrator ?? pair.observer`). Synthesises placeholder fields for the missing half; registers the group with the coordinator + arms reconnect via `armReconnect`. Two log events: `group:reconciled` for complete pairs, `group:reconciled_partial` for partial.
- `web/server/session-orchestrator.test.ts` — Replaced the "skips partial pair" test with "partial pair registers in reconnecting with grace armed" (uses real `mkdtempSync` cwd so the watcher attach succeeds). Updated the "skips archived half" test to reflect the new behaviour: archived halves still drop through the `s.archived` filter at the top, so the surviving half registers as a partial pair (acceptable; `intentionalKills` from the archive path prevents reconnect on subsequent exits).

**Verification:** ✅ typecheck. ✅ 156 tests pass (3 test files in scope).

---

### Task 7: `group_reconnecting` wire variant + bounded payload + EC-9 log content

**Domain:** Realtime × Hunt × Backend — Protocol drift defence; group_id as capability; EC-9 log content (quality-realtime.md P4, P7; security.md P7; quality-backend.md P6)
**Ref applied:** New variant `{type, sessionGroupId, survivingRole, deadlineMs}` — `survivingRole` not `deadRole` (the alive half is who receives the frame); `deadlineMs` absolute wallclock (Realtime: robust to in-flight latency); no `attempts` (Realtime: v1 narrow shape; one-shot scope). "We're back" recycles existing `group:created` (no `group_active` variant minted).

**Files changed:**
- `web/server/session-types.ts` — Added `group_reconnecting` variant to `BrowserIncomingMessageBase` union with full JSDoc per Realtime's `survivingRole` rationale.
- `web/server/event-bus-types.ts` — Added `"group:reconnecting"` typed event.
- `web/server/session-group-coordinator.ts` — `enactBusEvent` now handles `reconnecting` (emit `group:reconnecting` with `survivingRole`+`deadlineMs`) and `reconnected` (re-emit `group:created` from the live `GroupRecord`).
- `web/server/session-orchestrator.ts` — Added `companionBus.on("group:reconnecting", ...)` listener in `wireGroupListeners` that broadcasts the wire variant via `broadcastToGroup`.

**Verification:** ✅ typecheck. ✅ 156 server tests pass.

**Notes:** EC-9 log content stays bounded to `event` + `sessionGroupId` + `role` + `attempts:1` (no leaks of cliSessionId / observerPromptSha256 / workspace path — Hunt P3+P9 directive). Frontend hooking up (`ws.ts` switch case + slice reducer) is PLAN Task 9; today the variant emits server-side but no browser code consumes it yet.

---

### Task 8: Replay/seq classification + regression test

**Domain:** Realtime/NDJSON Protocol × Carmack — Sequence numbers + replay determinism (quality-realtime.md P3)
**Ref applied:** Verified via reading `ws-bridge-replay.ts:29-35` that `shouldBufferForReplay` excludes only `session_init` / `message_history` / `event_replay` — so `group_reconnecting` and recycled `group_created` are automatically replayable. No code change needed beyond the regression test.

**Files changed:**
- `web/server/ws-bridge.test.ts` — Added test at line 1102 asserting `group_reconnecting` then `group_created` (the "we're back" emit) replay in seq order to a browser that reconnects with `lastSeqSeen` < both seqs.

**Verification:** ✅ typecheck. ✅ targeted test green.

---

### Task 9: Browser `ws.ts` dispatch + slice reducer

**Domain:** React/Web UI × Fowler — Single mutation channel; AP-2 invariant (quality-frontend.md P2, P4)
**Ref applied:** Minimal one-case dispatch — pill goes live without the wider verb-merging refactor. `deadlineMs` deliberately dropped per React expert YAGNI rec.

**Files changed:**
- `web/src/ws.ts` — Added `case "group_reconnecting":` calling `store.setGroupStatus(sessionGroupId, "reconnecting")`.

**Deviations:** Did NOT collapse `setGroupStatus` / `upsertGroup` / `removeGroup` into a single `applyGroupEvent` reducer mirroring the server. The reducer refactor would touch ≥4 unrelated code paths; deferred as Watchpoint.

---

### Task 10: Force-flush session-store on shutdown

**Domain:** FS-JSON Persistence × Carmack — Debounce is a correctness window (quality-persistence.md P2)

**Files changed:**
- `web/server/session-store.ts` — Added `flushAll(pending: (id) => PersistedSession | null)`. Iterates `debounceTimers`, cancels each, writes the caller-provided snapshot synchronously.
- `web/server/ws-bridge.ts` — Added `flushSessionStorePendingSync()` that walks `this.sessions` mapping `sessionId → serializeForStore(session)`. Imported `serializeForStore` from `ws-bridge-persist.ts`.

**Deviation from plan literal:** Plan said "force-flush on group-status transitions". Reframed: group status isn't persisted in session-store (lives in coordinator's in-memory map; rebuilt on boot). Renamed to "flush all pending on shutdown" — covers any state mutation in the 150ms window.

---

### Task 11: `gracefulShutdown` wiring (fixes pre-existing P1)

**Domain:** Deploy × FS-JSON × Backend — Healthcheck and graceful shutdown (quality-deploy.md P8)
**Ref applied:** Ordering matters — cancel reconnect timers BEFORE archive (so timers can't fire mid-archive). Flush pending writes BEFORE archive (so an in-flight state mutation isn't lost). Then `shutdownAllGroups(timeoutMs: 8_000)`.

**Files changed:**
- `web/server/session-group-coordinator.ts` — Added `listGroupIds(): string[]` snapshot method.
- `web/server/session-orchestrator.ts` — Added `getCouncilCoordinator(): SessionGroupCoordinator | null` public accessor.
- `web/server/index.ts` — Promoted `gracefulShutdown` to async, prepended the three-step Council teardown (cancel timers → flush stores → `shutdownAllGroups`). Dynamic-import for `group-shutdown.js` so the SIGTERM path doesn't pay the load cost in steady state.

**Verification:** ✅ typecheck. ✅ full server suite — **3132 tests passed across 116 files**.

**Pre-existing P1 closed:** `gracefulShutdown` at `index.ts:423` previously never invoked `shutdownAllGroups` despite that helper existing. Confirmed via post-edit grep: `cancelAllReconnectTimers` + `flushSessionStorePendingSync` + `shutdownAllGroups` now all reachable from `index.ts`.

---

### Task 12: Observer `lastReviewedCheckpointId` tracking + catchup log

**Domain:** Willison (LLM Pipeline) × Carmack — Context propagation (quality-llm.md P8)

**Files changed:**
- `web/server/session-orchestrator.ts` — Added `lastReviewedCheckpointId?: string | null` to `CouncilGroupMeta`. Set inside `handleCouncilReview` after the bus emit. On `reconnect_ok` resolution (observer half), compare against `councilWatchers.get(group).lastCheckpoint.checkpoint_id` and emit `event: "council.observer.catchup"` if mismatched.

**Partial completion:** The deeper Willison ask — fold skipped paths into `delta` by passing `lastReviewedCheckpointId` as `previous` to `buildObserverContextManifest` — is intentionally deferred. The tracking field + catchup log surface the problem; the manifest-rewriting fix is a Watchpoint follow-up to keep this PR scoped. Documented inline.

---

### Task 13: a11y polite live-region + behavioural test

**Domain:** a11y Auditor × Carmack — Live regions, deliberately (quality-a11y.md P1, P3, P4)

**Files changed:**
- `web/src/components/council/ObserverPanel.tsx` — Added `role="status"` + `aria-atomic="true"` to the reconnecting pill (single polite live-region announcement on transition; the existing `aria-busy="true"` and visible text stay).
- `web/src/components/council/ObserverPanel.test.tsx` — New test "renders reconnecting pill with polite live-region role and cc-info token" — asserts role/aria-atomic/aria-busy/cc-info className/cc-warning className absent/spinner aria-hidden/axe-clean.

**Verification:** ✅ 22 ObserverPanel tests pass.

---

### Task 14: `cc-info` color token for reconnecting pill

**Domain:** Saarinen × Carmack — Color via tokens; semantic roles distinct (quality-ui.md P3, P5)

**Files changed:**
- `web/src/components/council/ObserverPanel.tsx` — Swapped `text-cc-warning` / `border-cc-warning/30` / `border-t-cc-warning` to the `cc-info` family. Same in-progress visual semantics as the `spawning` pill; distinct from `cc-warning` which is now exclusively `degraded`.

**Verification:** Covered by the Task 13 test (asserts `cc-info` present + `cc-warning` absent on the reconnecting pill).

---

### Task 15: Doc surface — env var + CLAUDE.md drift verification

**Domain:** Deploy × Carmack — Operator visibility (quality-deploy.md P4)

**Files changed:**
- `docs/reference/cli-and-api.mdx` — Added `COMPANION_GROUP_RECONNECT_GRACE_MS` row to the env-vars table next to the other `COMPANION_*` knobs.
- `CLAUDE.md` — Updated the Council Mode "Server pipeline" line 8 to describe the new structurally-correct flow (`deriveSideEffects` + `applyEvent` as sole mutator, `archiveGroup` through the same channel) and line 9 to describe the new reconnect grace path (`armReconnect` instead of immediate degrade, with all the short-circuit gates).

---

## Watchpoints Addressed

The plan's Risks & Watchpoints section listed follow-up items intentionally OUT of scope for this PR. None of them blocked task completion; all remain as Linear-ticket-worthy follow-ups:

- **Friedman — copy / countdown / failed-vs-fresh degraded copy.** Not touched per scope lock; flagged in PR description.
- **Saarinen — pill-row reflow on transition.** Not touched per scope lock.
- **a11y — `prefers-reduced-motion` gap.** Pre-existing on `animate-spin` / `animate-pulse`; this PR makes the missing handling more frequently triggered. Not fixed; explicit follow-up.
- **Subprocess — two-process race during `--resume`.** Pre-existing; not widened by this PR. Not fixed.
- **Willison — recording header tagging / replay-corpus negative case.** Not implemented; tracking field + catchup log surface the problem.
- **Willison — `buildObserverContextManifest` skipped-checkpoint fold.** Deferred per Task 12 partial-completion note.
- **Deploy — `ws.ts` coverage cascade.** Not pre-empted; need to run `bun run test -- --coverage` locally before PR. The new dispatch case adds ~3 lines to a 1400-line file.
- **Deploy — HEALTHCHECK design intent.** Not in scope; no HEALTHCHECK exists today.
- **React — `applyGroupEvent` slice reducer merge.** Deferred per Task 9 deviation note.

## Pre-existing Issues Encountered (Not Fixed)

- `web/src/components/Composer.test.tsx` — 61 failing test cases caused by unstaged in-progress edits to `Composer.tsx` referencing a Zustand store field `s.connectionStatus` that doesn't exist. Predates Task 1; confirmed via stash-and-rerun. Out of scope.

## Concurrency Note

During execution, two other agent pairs were modifying the same project (`group-state-machine.ts`, `session-group-coordinator.ts`, `event-bus-types.ts`). One Edit call failed with "file modified since read"; recovery was a re-read + retry. System reminders showed stale file snapshots that suggested rollback; actual disk state (verified via Bash grep + typecheck) was always consistent with my edits. **No work was lost**, but this is a real concurrency risk — if multi-agent runs continue, committing per task to git would eliminate the race window.

## Ready for Review

Server-side files in scope:
- `web/server/group-state-machine.ts`
- `web/server/group-state-machine.test.ts`
- `web/server/session-group-coordinator.ts`
- `web/server/session-orchestrator.ts`
- `web/server/session-orchestrator.test.ts`
- `web/server/event-bus-types.ts`
- `web/server/session-types.ts`
- `web/server/session-store.ts`
- `web/server/ws-bridge.ts`
- `web/server/ws-bridge.test.ts`
- `web/server/index.ts`

Frontend files in scope:
- `web/src/ws.ts`
- `web/src/components/council/ObserverPanel.tsx`
- `web/src/components/council/ObserverPanel.test.tsx`

Docs:
- `docs/reference/cli-and-api.mdx`
- `CLAUDE.md`

Final tally: **typecheck clean; 3413 tests passing across 133 files**.
