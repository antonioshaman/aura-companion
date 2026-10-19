# Subprocess Lifecycle Expert — Council Review

**Scope:** `3dee080` squash (PR #54) Task 11 wire-up. Files reviewed:
- `web/server/claude-adapter.ts` (orchestratorTurnState + result-frame transition guard + sticky-token clear path)
- `web/server/session-orchestrator.ts` (new `session:exited` listener + `archiveSession` council branch + intentional-kill ordering)
- `web/server/idle-timer-manager.ts` (`clearPendingSyntheticTurn` / `isSyntheticTurnInFlight` / `noteTerminalResultFrame` / `noteUserMessage`)

Cross-read for context: `web/server/ws-bridge.ts` (idleTimerProbe injection + `startIdleKillWatchdog` reset path), `web/server/index.ts` (late-injection wiring).

---

## P1 — Fix Now

### P1-S1 — `isSyntheticTurnInFlight` double-lookup is a torn-read race window across module-boundary mutation
**File:** `web/server/idle-timer-manager.ts:372-375`
**Pattern (quality-subprocess Principle 2: identity verification under concurrency):**
```ts
isSyntheticTurnInFlight(sessionId: string): boolean {
  return this.states.get(sessionId)?.pendingSyntheticTurnToken !== null
    && this.states.get(sessionId)?.pendingSyntheticTurnToken !== undefined;
}
```
The accessor calls `this.states.get(sessionId)` **twice** and reads `pendingSyntheticTurnToken` from each result independently. Between the two reads, `noteTerminalResultFrame` / `clearPendingSyntheticTurn` / `disposeAll` can fire from the bus loop (Node/Bun macrotask interleaving on JIT-yielded boundaries inside the optional-chain). The second read can see `null` while the first saw a non-null token → returns `false && undefined` → `false`. The denylist gate (`claude-adapter.handleControlRequest`) then falls through to the user-facing permission UI for a tool that should have been silently denied.

More important: when no state exists at all (`states.get` → `undefined`), the expression reduces to `undefined !== null && undefined !== undefined` → `true && false` → `false`. That's correct **by accident**; if a future refactor flips the second clause to `!== null` first (a natural simplification), every never-armed session returns `true` and the denylist gate snaps shut for solo (non-council) sessions that the manager has no record of. Pure pulled-from-air invariant — exactly the contract-in-JSDoc trap that the convention floor (Aura `feedback_council_documented_contract_canary`) calls out.

**Fix:** single `const state = this.states.get(sessionId)`, then `state !== undefined && state.pendingSyntheticTurnToken !== null`. Make the never-armed-session value an explicit `false` return, not an emergent property of operator precedence.

**Severity:** P1. The race is narrow (microtask-window) but the gate is the load-bearing security primitive for unattended auto-proceed loops; the failure mode is "destructive tool ran in unattended mode without user approval." Defence-in-depth, yes — but `quality-subprocess` Principle 4 is unambiguous: silent retry/silent fail-open on the denylist gate is the most expensive class of subprocess bug.

---

### P1-S2 — `archiveSession` council branch: `clearPendingSyntheticTurn` fires AFTER `archiveGroup` awaits its kills, allowing a sticky-token re-emit window during the `--resume` race
**File:** `web/server/session-orchestrator.ts:2740-2748`

Sequence today:
1. `intentionalKills.add(group.primary.sessionId)` + `intentionalKills.add(group.observer.sessionId)` (EC-2, correct)
2. `await coord.archiveGroup(group.sessionGroupId)` — this internally calls `deps.kill(primary)` + `deps.kill(observer)`, each of which causes a `session:exited` bus emit synchronously from the launcher's `proc.on("exit", …)`.
3. **`this.idleTimerManager.clearPendingSyntheticTurn(group.primary.sessionId)` only runs AFTER the await resolves.**

The bus listener at line 508 (`companionBus.on("session:exited", ({sessionId}) => this.idleTimerManager.clearPendingSyntheticTurn(sessionId))`) DOES fire during step 2 for both halves — that's the primary defence and it works. But the council-branch explicit clear at step 3 is being sold in the PR description as an ordering belt-and-braces. It is the **opposite** of belt-and-braces:

- If a future refactor in `archiveGroup` defers the actual `deps.kill` to a `setImmediate` (a reasonable change to avoid re-entry on the bus), the synchronous `session:exited` emit no longer happens before step 3. The step-3 explicit clear then **races** with whatever async kill path emits the exit. With no kill yet, the cliSocket is still attached, idle-timer fires can still happen, and the sticky token can be re-stamped between step 3 (clear) and the actual kill (clear-by-listener).
- The JSDoc on the manager method (lines 386-406) claims `clearPendingSyntheticTurn` is the named cleanup for `(d) session archive`. The actual code path makes the bus listener at line 508 do the work; the explicit call at 2748 is redundant TODAY but a structural footgun for the next refactor.

This is the `feedback_recovery_branch_reachability` pattern: a "defence" branch that's structurally subordinate to the listener it's meant to redundantly cover.

**Fix:** Either (a) move the explicit clear to BEFORE `await coord.archiveGroup` (then the clear is unconditionally before any kill, listener handles late edge cases), or (b) delete the explicit call and document at the listener site that archive paths flow through the same listener; rely on EC-2 ordering to guarantee the clear precedes any consumer that could mis-act on the stale token.

Also note: the orchestrator-only clear (`clearPendingSyntheticTurn(group.primary.sessionId)`) implicitly assumes the **observer** half can never have a pending synthetic turn. That's true today (synthetic is orchestrator-side only, per the comment at claude-adapter.ts:1124-1126), but the assumption isn't enforced anywhere in code or test. If someone wires synthetic frames to the observer half, this archive-cleanup site silently leaves a sticky token alive on the observer's state.

**Severity:** P1. The "future-refactor footgun" framing alone is P2, but combined with the unverified observer-half assumption it tips to P1 — fix the ordering AND add an assertion or comment that ties the half-specificity to the synthetic-frame-source-half contract.

---

## P2 — Fix Soon

### P2-S1 — `--resume` replay of result-frame after server restart: in-flight → awaiting-input guard depends on `detachWebSocket` having fired first
**File:** `web/server/claude-adapter.ts:830-869` (`handleResultMessage`) + `:213-237` (`attachWebSocket`)

The PR description claims the in-flight → awaiting-input transition guard catches `--resume` result-frame replays so `noteTerminalResultFrame` doesn't double-fire on a session that was already awaiting input. The chain in question:

1. Server restart. Old CLI process survives (PID tracked, grace period).
2. Old CLI was mid-turn at restart. `orchestratorTurnState` was `in-flight` in the now-destroyed adapter instance.
3. New adapter constructed during restore. Initial `orchestratorTurnState` is `{kind:"awaiting-input", blockedByStop:false}` (per constructor field initialiser at line 187-188).
4. CLI WS reconnects → `attachWebSocket` fires → state reset to `awaiting-input` (line 225, defensive reset).
5. CLI replays its result-frame for the in-flight turn that completed during the restart blackout.
6. `handleResultMessage` checks `orchestratorTurnState.kind === "in-flight"` → false → **skips the `noteTerminalResultFrame` call entirely.**

That's correct for double-call avoidance — but it also means: **the sticky synthetic-turn token from the pre-restart fire is never cleared by the result-frame path.** The cleanup must come from elsewhere:

- The `session:exited` listener at session-orchestrator.ts:508 clears on exit. If the CLI exited and was relaunched via `--resume`, that path covers it. Good.
- But the survived-CLI-reconnect path (no exit, just WS reconnect) does NOT fire `session:exited`. The sticky token persists in the `idleTimerManager.states` Map from before the restart, then attached unchanged via... actually, the manager has no persistence — it lives in-process. So the token IS cleared by the process restart.

Wait — is it? `idle-timer-manager.ts:224-256` has a `rehydrate` method that restores `iterationCount` / `firedAt` / `cappedAt` / `lastObjectiveGateResult` from a persisted `AutoProceedTrace`, but **deliberately does NOT restore `pendingSyntheticTurnToken`** (the field is set to `null` in the literal at line 244). Good — the cross-restart clear is "implicit by virtue of in-memory-only field." But this contract is not asserted anywhere. A future change that persists `pendingSyntheticTurnToken` in the trace (to "preserve forensic correlation across restart") would silently undo the clear.

Mitigation today is sufficient. But Principle 2 of `quality-subprocess` ("track PID, but never trust PID across reboots") generalises here: the sticky-token clear-on-restart relies on a memory-only invariant that has no test asserting it. Add a test: `rehydrate(stateWithToken)` must produce `isSyntheticTurnInFlight === false`. Without it, this is a `feedback_in_memory_derived_state_reconcile_on_restart` footgun in reverse — the in-memory clear is correct, but its correctness is invisible.

**Severity:** P2. Today's behaviour is correct; the failure mode is a future refactor that doesn't realise this is load-bearing.

---

### P2-S2 — Cascading half-exits during reconnect grace: the second-half `session:exited` clears its OWN sticky token but the bus listener fires per-session, so the first-half token may already have been re-stamped by a fire that landed during the grace
**File:** `web/server/session-orchestrator.ts:508-510` (the new listener) + `:1322-1371` (the council exit listener)

Path of concern (PR #53's `half_respawned` cascade-recovery interaction):

1. Group is `active`. Orchestrator-half (sessionId=A) has a synthetic fire pending, `pendingSyntheticTurnToken=42`.
2. Observer half (sessionId=B) dies. Listener at 1322-1371 arms `reconnect` grace (45s) for the group.
3. During the grace, idle-timer-manager's gate would refuse to arm new fires (`reconnect-grace-active` is in the gate-block list at 437). Good.
4. But the EXISTING in-flight synthetic from step 1 is still pending — its sticky token is set, and its actual NDJSON frame already crossed to the CLI.
5. The orchestrator-half CLI (A) completes its turn and emits `result`. `handleResultMessage` clears the token via `idleTimerProbe.noteTerminalResultFrame(A)`. Token cleared.
6. Now: observer-half post-grace recovery via `half_respawned` re-emits `group:created` (the PR #53 fix). Group flips back to `active`. Nothing in this path touches the orchestrator's sticky token.

That works. But consider the inverse: **orchestrator-half (A) dies during the grace** (after observer was already in reconnect window). Then:
- The first-half `session:exited` listener at 508 fires for A → clears A's sticky token. Good.
- The council exit listener at 1322 detects "we're already in reconnect with a different snapshot" → both intentional + `reconnect_failed` → group degrades.
- Both halves' kills cascade. The cleanup is "fine" because both clears land.

Now consider the SAME-half-twice variant — orchestrator dies, reconnect armed for orchestrator, observer also dies inside the grace:
- B's `session:exited` listener at 508 fires → clears B's sticky token. B never had one (orchestrator-only); no-op.
- Council listener at 1322 short-circuits: both intentional, `reconnect_failed`. Reconnect timer cancelled.
- But — and this is the subtle part — the orchestrator's sticky token from before its own death is **still in `states[A].pendingSyntheticTurnToken`**. The listener at 508 fired for A's exit (step where A died), which cleared it. Confirmed.

So the cascade IS covered. But the coverage depends entirely on the bus listener at line 508 firing for **every** session exit including cascading ones. The cascade listener at 1322 itself doesn't propagate `session:exited` — it consumes the bus event and translates to `reconnect_failed`. There's no separate post-cascade `session:exited` for the half that died because of cascade; the original first-cause `session:exited` is the only one. **For the SECOND half that gets marked intentional + receives a `launcher.kill` later in the cascade flow** (line 1348-1349, the relaunchExhausted branch), does `launcher.kill` produce a real `proc.on("exit")` → `session:exited`?

Looking at the marking sequence: lines 1344-1351 mark BOTH halves intentional, then `applyEvent("half_died")`. The state machine transition doesn't kill any process — it just emits `group:degraded`. The actual second-half process keeps running until something else kills it (idle-kill, manual archive). If that second-half has a sticky synthetic token, it survives indefinitely.

The "if" is doing work — for the second half to have a sticky token, it would have to be the orchestrator (synthetic-source half). In a `claude+claude` pair the second half is the observer (synthetic doesn't apply). In `claude+codex`, same — observer is the synthetic-target-NOT half. So in practice this is unreachable today.

But the contract is fragile. **Recommendation:** in the cascade-marking blocks at 1344-1351 and 1357-1364, explicitly call `idleTimerManager.clearPendingSyntheticTurn(meta.primarySessionId)` immediately after marking intentional. Same idempotency pattern as the archive branch.

**Severity:** P2. Reachable only via a future synthetic-source extension to the observer half, but the cascade-cleanup symmetry is the kind of invariant that gets quietly violated by tactical refactors.

---

### P2-S3 — `startIdleKillWatchdog` direct mutation of `lastCliActivityTs` (line 1398) bypasses the `noteCliActivity` dispatcher; if a synthetic turn is in-flight at watchdog-arm time, the watchdog grants a full 24h grace anchored to wallclock-now even though no real user activity occurred
**File:** `web/server/ws-bridge.ts:1393-1399` + interaction with `noteCliActivity` at `:162-168`

```ts
private startIdleKillWatchdog(sessionId: string) {
  const session = this.sessions.get(sessionId);
  if (session) {
    session.lastCliActivityTs = Date.now();   // direct mutation
  }
  // ... starts 60s-tick interval
}
```

The EC-6 canary (`ws-bridge.test.ts:2903`) explicitly carves out `startIdleKillWatchdog` as an allowed mutation site alongside `noteUserActivity`. The intent: when the last browser detaches, reset the idle clock to "from this moment, give 24h." This is correct under the prior single-mutation-site invariant — the watchdog reset is unambiguous user-time accounting.

Under the Task 11.7 split, "user-time" no longer means "any CLI activity"; it means "non-synthetic CLI activity." But the watchdog reset at line 1398 mutates regardless of whether a synthetic turn is in-flight. Scenario:

1. Auto-proceed iteration N fires at T=0. `pendingSyntheticTurnToken=42`.
2. User closes the tab at T=1s. `handleBrowserClose` → `startIdleKillWatchdog` → `lastCliActivityTs = T+1s`.
3. CLI ticks activity (e.g. assistant frame) during the synthetic turn → `noteCliActivity` → probe says in-flight → `noteSyntheticActivity` → no clock advance (correct).
4. Synthetic turn completes at T=10s. Result-frame → `noteTerminalResultFrame` clears token.
5. No further CLI activity. `lastCliActivityTs` is still T+1s. Idle-kill fires at T+1s+24h.

That's actually the correct behaviour — the watchdog reset SHOULD give 24h from browser-close. The issue is the asymmetry of the EC-6 canary: it permits two writers, but only one of them is "user-time semantics." A future refactor adding e.g. a `relaunchOk` path that also resets `lastCliActivityTs` would slip the canary (mutation inside `relaunchOk` body, indistinguishable from `startIdleKillWatchdog` to a regex) and not be obvious.

More acutely: the watchdog reset's direct mutation **silently overrides** any prior `noteSyntheticActivity` no-op. If a session has been running auto-proceed for 23h59m and the user closes their tab at minute 59m45s, the watchdog gives a full fresh 24h. That's a `feedback_alert_cadence_by_impact` impedance mismatch — the auto-proceed iteration cap is the only governor on synthetic-driven runtime, and the idle-kill is no longer the bound the operator might think it is.

**Recommendation:** Either (a) route `startIdleKillWatchdog` through `noteUserActivity` so the canary is reduced to a single allowed mutation site (idiomatically a function call, not a property write — easier to regex-canary), or (b) explicitly document that "browser-close reset" is intentional even mid-synthetic-turn, and add a test asserting the 24h reset fires on browser-close-during-auto-proceed.

**Severity:** P2. The "leak path through onActivityUpdate when probe is null" the prompt asked about — that branch is safe: line 163 `if (this.idleTimerProbe?.isSyntheticTurnInFlight(...))` short-circuits to false when probe is null, falling into `noteUserActivity`. Pre-injection (between `wsBridge` construction and the `index.ts:171` call) is the only window where probe is null, and during that window no CLI subprocess has spawned yet. Concretely safe today.

---

## P3 — Consider

### P3-S1 — `noteUserMessage` advances `turnToken` but does NOT clear `pendingSyntheticTurnToken` — the JSDoc says so explicitly, but only the ArmedTimerState field doc explains why
**File:** `web/server/idle-timer-manager.ts:337-345` (the method) + `:185-202` (the field doc on `pendingSyntheticTurnToken`)

The stickiness-across-user-typing is the race defence the PR description leans on. The method docstring at 337 only says "Advances the turn token so any in-flight fire callback aborts on token re-read, and cancels the pending timer." A reader looking only at `noteUserMessage` would reasonably expect it to ALSO clear the sticky synthetic token — that's the dual to "user typed, so the auto-proceed turn is no longer authoritative."

The actual rule lives in the field comment at line 186-202 ("NOT cleared by `noteUserMessage` — user typing during a pending synthetic turn keeps the flag sticky"). The flow: orchestrator-side bus listener at session-orchestrator.ts:495-497 only calls `noteUserMessage`. Reader has to cross-reference two files to discover the invariant.

**Recommendation:** Add an explicit sentence to the `noteUserMessage` docstring: "Does NOT clear `pendingSyntheticTurnToken`; see ArmedTimerState field doc. Stickiness is the denylist gate's race defence." Same `feedback_council_documented_contract_canary` pattern as P2-S2.

**Severity:** P3 (documentation hygiene; behaviour is correct).

---

### P3-S2 — `disposeAll` (line 414-421) tears down timers but does NOT clear `pendingSyntheticTurnToken`; SIGTERM-during-synthetic leaves a stale token that "doesn't matter because process exit" — but inversion footgun on hot-reload
**File:** `web/server/idle-timer-manager.ts:414-421`

`disposeAll` is the SIGTERM-drain helper. It cancels every armed timer in one pass. It does NOT touch `pendingSyntheticTurnToken`. The justification is "the process is exiting; the field is in-memory; it doesn't matter."

That's true for production SIGTERM. It's **not** true for `bun --hot` development workflows, where the module is re-imported but the manager instance can be re-attached without process exit (Bun's HMR isn't quite as aggressive as Vite's, but the seam exists). And it's not true for any future test harness that constructs/disposes the manager multiple times.

**Recommendation:** add `state.pendingSyntheticTurnToken = null` inside the disposeAll loop. Free, idempotent, removes a future-state footgun.

**Severity:** P3.

---

### P3-S3 — `detachWebSocket` resets `orchestratorTurnState` to `{awaiting-input, blockedByStop:false}` but the in-flight → awaiting-input bus emit is gated on the previous state being `in-flight` — a transient WS flap during a synthetic in-flight turn silently drops the `orchestrator:turn-done` event
**File:** `web/server/claude-adapter.ts:249-258`

The reset on detach is defensive (Council Review 2026-05-13 Subprocess #2's lesson). Without it, an in-flight stuck across a WS flap deadlocks the dispatcher. With it, a WS flap silently transitions in-flight → awaiting-input **without firing the bus event**. The bus event drives:

- `idleTimerManager.noteTerminalResultFrame` (Task 11.8 wire at claude-adapter.ts:863) — but only via the `handleResultMessage` path, which `detachWebSocket` doesn't traverse.

So a synthetic turn that's in-flight when WS flaps:
- The CLI process is still running.
- The result-frame WILL eventually arrive when WS reattaches — but the adapter's `orchestratorTurnState` is already `awaiting-input` (from the detach reset).
- `handleResultMessage` checks `kind === "in-flight"` → false → skips `noteTerminalResultFrame`.
- **The sticky token stays set indefinitely** until the listener at session-orchestrator.ts:508 fires on actual `session:exited`.

If the WS reattaches successfully and the CLI continues healthily (no exit), the sticky token persists across the next iteration of auto-proceed. The next user-typed `can_use_tool` for a denylist tool would be silently denied because `isSyntheticTurnInFlight` still returns true. That IS the documented intended behaviour ("stickiness is the race defence") — but it persists across a now-completed synthetic turn whose result-frame transition was silently dropped by the detach reset.

**Recommendation:** In `detachWebSocket`, if the previous orchestratorTurnState was `in-flight`, also call `idleTimerProbe?.noteTerminalResultFrame(this.sessionId)` to clear the sticky token. The synthetic-turn is by definition no longer in-flight from the manager's POV when transport drops.

**Severity:** P3. Reachable but narrow: requires transient WS flap mid-synthetic-turn without process exit. Real-world frequency depends on network conditions and mobile carrier proxies. The Aura heartbeat (`BROWSER_HEARTBEAT_INTERVAL_MS = 25_000`) is for browser side, not CLI side, so this can fire on flaky CLI-WS proxies.

---

## Summary

| ID | Severity | File | One-line |
|----|----------|------|---------|
| P1-S1 | P1 | idle-timer-manager.ts:372 | `isSyntheticTurnInFlight` double-`.get` + `&&` precedence is a torn-read + future-refactor footgun on the denylist gate |
| P1-S2 | P1 | session-orchestrator.ts:2748 | `archiveSession` explicit clear runs AFTER `archiveGroup` await — listener-redundant today, race-able after any future async-kill refactor |
| P2-S1 | P2 | claude-adapter.ts:830-869 | `--resume` result-frame replay skips `noteTerminalResultFrame` correctly only because `pendingSyntheticTurnToken` is in-memory-only; no test asserts the contract |
| P2-S2 | P2 | session-orchestrator.ts:1344-1364 | Cascade-marking paths (`relaunchExhausted` + cross-half-die) mark intentional + applyEvent but don't explicitly `clearPendingSyntheticTurn`; safe today, fragile under observer-side synthetic extension |
| P2-S3 | P2 | ws-bridge.ts:1393-1399 | `startIdleKillWatchdog` direct `lastCliActivityTs =` overrides synthetic-aware split mid-auto-proceed; EC-6 canary permits two writers, only one is "user-time semantics" |
| P3-S1 | P3 | idle-timer-manager.ts:337-345 | `noteUserMessage` docstring silent on sticky-token non-clear; rule lives only in field doc |
| P3-S2 | P3 | idle-timer-manager.ts:414-421 | `disposeAll` doesn't clear `pendingSyntheticTurnToken`; HMR/test-harness reset fooprint |
| P3-S3 | P3 | claude-adapter.ts:249-258 | `detachWebSocket` reset silently swallows the in-flight → awaiting-input bus emit; sticky token persists across mid-turn WS flap without process exit |

**Conventions respected:** EC-2 (intentional ordering) verified in archive + cascade paths; EC-7 (gate re-eval at fire time) verified at idle-timer-manager.ts:481; EC-9 (structured log entries) verified across all new log sites. No convention-floor re-flags.

**Carmack synthesis:** the three filters that matter most for this PR are the denylist gate's fail-mode, the result-frame transition guard's coverage of `--resume` replay, and the cascade-cleanup symmetry. P1-S1 and P1-S2 directly threaten the first two. P2-S2 is the cascade-symmetry filter. The remainder are documentation + future-refactor footguns — small individually, structural in aggregate because the sticky-token contract spans three modules and is enforced by zero tests.
