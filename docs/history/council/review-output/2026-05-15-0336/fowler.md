# Fowler — Refactoring Review

Scope: `ws-bridge.ts` (+166 LOC this PR, now 1698 LOC), `claude-adapter.ts` (+126 LOC this PR, now 1342 LOC), `index.ts` (620 LOC bootstrap seam).

Economic test applied throughout: "Will this slow us down in the next few months?" If no, lowered or dropped.

---

## FINDING 1

- **Title:** `WsBridge` is now eight concerns deep — the extracted helpers prove the bones of a split, but the bridge keeps absorbing new responsibilities
- **File:** `/root/aura-companion/web/server/ws-bridge.ts`
- **Principle:** Principle 6 — Missing boundaries where they matter (different parts changing for different reasons should be separated); Principle 7 — Fear-zones in the codebase
- **Severity:** P2
- **What's wrong:** The bridge has already had ingest/persist/publish/controls/replay/stream-status carved into sibling `ws-bridge-*.ts` modules, yet the class still owns: (1) session map + lifecycle, (2) CLI WS handlers, (3) browser WS handlers, (4) idle-kill watchdog (lines 1384-1438), (5) browser heartbeat (lines 1346-1382), (6) disconnect debounce, (7) AI validation (lines 932-993), (8) Council group hydration (lines 1249-1279, 339-352, 311-337), (9) auto-proceed dispatcher methods (`noteCliActivity` / `noteUserActivity` / `noteSyntheticActivity`, lines 162-190), (10) user-frame observer registry (lines 106, 209-215, 1523-1532), (11) interrupted-stream synthesis (lines 528-542, 1457-1463), (12) pending message queue (lines 1633-1647, 1649-1697), (13) two distinct synthetic-send façades (`sendObserverWakeFrame` + `sendOrchestratorSyntheticFrame`, lines 311-337). Each concern changes for a different reason. The +166 LOC this PR is the visible symptom: Task 11.6 added the observer registry, Task 11.7 added the dispatcher trio + late-inject setter, Task 11.8 added the second façade — three independent reasons-to-change all landed in the same class. The sibling extracts (`ws-bridge-persist`, `ws-bridge-publish`, etc.) show the pattern works; what's missing is a deliberate next pass.
- **Consequence:** This is the canonical fear-zone the refactoring reference names as the example. Every PR for the next two quarters that touches activity tracking, idle-kill, or Council wiring routes through this file, which makes the test file the same fear-zone (`ws-bridge.test.ts`) and inflates PR review cost. The file-level coverage gate (`feedback_file_level_coverage_gate_cascade`) compounds: any helper added here must also be backfill-tested at file granularity. The +166 LOC delta will be +200 next PR (PR #52's `enqueueOutboundFrame` FIFO is already planned to land here per the context brief). Velocity dies here unless extraction happens at a planned boundary, not opportunistically.
- **Fix:** Extract three modules along seam lines that already exist by convention: (a) `ws-bridge-idle-watchdog.ts` — owns `idleKillTimers`, `startIdleKillWatchdog` / `stopIdleKillWatchdog` / `checkIdleKill`, the heartbeat, and the dispatcher trio (`noteCliActivity` / `noteUserActivity` / `noteSyntheticActivity`); the bridge holds an instance and delegates. (b) `ws-bridge-council.ts` — owns `deriveGroupCreatedForBrowser`, `broadcastToGroup`, `markCouncilSession`, `sendObserverWakeFrame`, `sendOrchestratorSyntheticFrame`, `userFrameObservers` + `onUserFrameObserved`. (c) `ws-bridge-ai-validation.ts` — owns `handleAiValidation`. Each is a pure-extract refactor (no behaviour change, just moving the methods + their state behind a narrow seam). Do this BEFORE PR #52's `enqueueOutboundFrame` lands; that's the next +200 LOC.

---

## FINDING 2

- **Title:** Late-injection probe via setter is correct in principle but the structural cast in `index.ts` defeats the type system
- **File:** `/root/aura-companion/web/server/index.ts` (lines 99-119) + `/root/aura-companion/web/server/ws-bridge.ts` (lines 119-147)
- **Principle:** Principle 4 — Names that lie or mislead; Principle 3 — Mutable Data (hidden dependency); Principle 7 — TypeScript strictness as static analysis
- **Severity:** P2
- **What's wrong:** The probe interface is duplicated inline at three sites — `WsBridge.idleTimerProbe` field (lines 119-122), `setIdleTimerProbe` parameter (lines 141-144), `ClaudeAdapter.idleTimerProbe` field (lines 134-137) — and `index.ts` lines 108-113 uses a structural-cast escape hatch (`adapter as unknown as { orchestratorTurnState?: ... }`) to avoid importing `ClaudeAdapter`. The cast bypasses the type system on a load-bearing dispatch decision: if `ClaudeAdapter.orchestratorTurnState` is renamed or its shape changes, this site silently reads `undefined` and the `?? { kind: "in-flight" }` fallback masks it permanently. The probe pattern (mutual cycle, late-injection) is sound but the contract has no single source of truth.
- **Consequence:** A future refactor that renames `orchestratorTurnState` will pass typecheck, pass unit tests (which inject probes directly), and produce a silently broken auto-proceed in production where every session reads `in-flight` and never fires. This is the exact `feedback_call_site_presence_not_just_symbol_export` + `feedback_identity_binding_placeholder_void` failure shape, but introduced at the seam by the cast.
- **Fix:** Extract the probe interface to a named type `IdleTimerProbe` in `idle-timer-manager.ts` (where the producer lives) and import it at both consumer sites. Remove the structural cast in `index.ts` by exposing `ClaudeAdapter.getOrchestratorTurnState()` (already exists at line 1274-1285) and switching the `getSession` closure to use the accessor — that accessor is the contract surface, the field is implementation.

---

## FINDING 3

- **Title:** `sendOrchestratorSyntheticFrame` and `sendUserFrameFromServer` are 90% duplicated — the next change to one will silently diverge
- **File:** `/root/aura-companion/web/server/claude-adapter.ts` (lines 1126-1172 vs 1174-1252)
- **Principle:** Principle 5 — Shotgun Surgery; Principle 2 — Functions that lie about side effects (the only behavioural difference between the two is the `observerTurnState` gate and the recorder origin string, not visible in the names)
- **Severity:** P2
- **What's wrong:** The two methods share: transport check (`!cliSocket` + `readyState !== 1`), backpressure check, NDJSON envelope construction, newline-discipline assertion, try/catch around `cliSocket.send`, success-state mutation. They differ in exactly three places: (1) the observer-turn-state busy gate (orchestrator skips it), (2) the recorder origin string (`server:council-wake` vs `server:auto-proceed`), (3) which turn-state field they flip on success. The PR body even names the duplication ("mirror of `sendUserFrameFromServer`"). The newline-assertion is load-bearing security — `feedback_format_transformation_validation` ground — and the next time someone hardens it (e.g., tighter UTF-8 control-char filter, max-line-length check), the change must be made in TWO places or the auto-proceed path drifts open.
- **Consequence:** Direct violation of EC-5 (protocol parser hardening must apply uniformly to all producer paths). When PR #52 lands `enqueueOutboundFrame`, EITHER (a) both methods get rewritten in two parallel edits, OR (b) one gets migrated and the other becomes silent dead code. Both outcomes are worse than the merge happening now.
- **Fix:** Extract a private `sendServerOriginatedUserFrame(content: string, opts: { origin: "server:council-wake" | "server:auto-proceed"; skipTurnGate: boolean }): ObserverWakeSendOutcome`. The two public methods become 5-line wrappers that pass `opts` and update the appropriate turn-state field after a `sent` outcome. Behaviour-preserving; no test changes beyond the unit-test count delta.

---

## FINDING 4

- **Title:** `noteCliActivity` / `noteUserActivity` / `noteSyntheticActivity` naming obscures what each actually mutates
- **File:** `/root/aura-companion/web/server/ws-bridge.ts` (lines 162-190)
- **Principle:** Principle 4 — Names reveal design; "When you can't think of a good name, it's a sign of a deeper design malaise"
- **Severity:** P3
- **What's wrong:** All three methods are called for "CLI activity," but only `noteUserActivity` writes `session.lastCliActivityTs`; `noteSyntheticActivity` is intentionally empty; `noteCliActivity` is a dispatcher. The names read as a parallel set ("note an activity of kind X"), but the actual semantics are: "advance the idle-kill clock," "do nothing (placeholder for future telemetry)," and "decide between the first two based on the probe." The EC-6 canary forces the contract that only `noteUserActivity` mutates the field — the comment on line 175 says so explicitly — but the canary is the contract enforcement and the name is the documentation. A future reader sees three methods that look like they each tick a counter.
- **Consequence:** Minor velocity drag on next-quarter work near auto-proceed. Not a bug factory today because the EC-6 canary covers the invariant. But if a fourth `note*Activity` lands (e.g., `noteCronActivity`), the naming pattern will inflate naturally and the canary will need re-anchoring.
- **Fix:** Rename: `noteCliActivity` → `dispatchCliActivityTick`; `noteUserActivity` → `advanceIdleKillClock`; `noteSyntheticActivity` → `recordSyntheticActivityNoOp` (or delete the placeholder until there's an actual telemetry use — Carmack: "the function least likely to cause a problem is the one that doesn't exist"). Update the EC-6 canary regex to anchor on `advanceIdleKillClock`.

---

## FINDING 5

- **Title:** `index.ts` bootstrap is sequenced correctly but the wiring order is implicit — a future move risks resurrecting the cycle
- **File:** `/root/aura-companion/web/server/index.ts` (lines 68-174)
- **Principle:** Principle 6 — Premature modularisation (NO); but Principle 4 — Comments as deodorant (the 8-line comment block at lines 80-88 is doing the work the structure should do)
- **Severity:** P3
- **What's wrong:** Three constructors with a real ordering invariant (bridge → orchestrator → manager → inject-back-to-orchestrator → inject-back-to-bridge) are open-coded as 100+ lines of top-level statements with a paragraph-long comment explaining why. The comment is correct ("manager reads orchestrator's coordinator + ws-bridge state, orchestrator's rehydrate path calls into manager — late-injection is the cleanest pattern for that"), but the next person who refactors this file (likely under "split bootstrap into composition root" pressure) will move statements and break the cycle silently — the late-injects look like decoration, not structural ordering.
- **Consequence:** Low-probability but high-cost regression. The cycle is real (`orchestrator` references `idleTimerManager` via `setIdleTimerManager` line 165; manager closures reference `orchestrator` via `getGroupStatus` line 125-130 and `wsBridge` via `getSession` lines 95-124), and the runtime symptom of breaking it is "auto-proceed silently skipped" — exactly the failure shape the codebase has logged in `feedback_call_site_presence_not_just_symbol_export`.
- **Fix:** Extract a `composeRuntime()` function that takes the leaf dependencies (`launcher`, `sessionStore`, `wsBridge`, etc.) and returns `{ orchestrator, idleTimerManager }` after performing the wiring in the correct order with the cycle resolution localised. The composition root pattern is the standard answer; it makes the ordering invariant visible as a single function body rather than scattered statements.

---

## SUMMARY

5 findings: **2× P2, 3× P3**.

P2s are velocity-dragging now. Finding 1 (god-module split) is the strategic one — the extraction helpers already exist; what's missing is committing to the next pass before PR #52 lands. Finding 3 (duplicated synthetic-send pair) is a shotgun-surgery trap that the next protocol-hardening PR will trip. Findings 2/4/5 are hygiene that compounds.

Convention floor (AP-1, AP-3, EC-2, EC-5, EC-6, EC-7, EC-9) not re-flagged per context brief instructions.
