# Subprocess Lifecycle Review — Observer Auto-Wake (Story 2 AC#1)

Reviewer: Subprocess Lifecycle Expert
Files reviewed:
- `/root/aura-companion/web/server/claude-adapter.ts` (observerTurnState; sendUserFrameFromServer; handleResultMessage)
- `/root/aura-companion/web/server/session-orchestrator.ts` (dispatchObserverWake + drainPendingObserverWake + reconnect_ok drain + group:degraded drop)

Convention floor honoured: AP-1..AP-3, EC-1..EC-9 not re-flagged. EC-1 spawn argv wasn't touched in this change; not flagged.

---

## P1-S1 — Observer turn-state is not reset on CLI socket disconnect → permanently stuck `in-flight` after mid-turn drop

**Where:** `claude-adapter.ts` `detachWebSocket` (lines 183–188) and `handleTransportClose` (lines 229–231) clear `cliSocket` but do NOT touch `observerTurnState`. `disconnect()` (lines 210–222) likewise.

**Failure mode:**

1. Server sends wake frame at T=0 → `observerTurnState = "in-flight"`.
2. Observer CLI crashes/disconnects at T=2s, BEFORE any `result` NDJSON frame is read.
3. `detachWebSocket` fires → `cliSocket = null`, `disconnectCb` fires, `session:exited` fires.
4. Orchestrator's `session:exited` listener (line 930) reaches `armReconnect` because the half is NOT in `intentionalKills` (this is a crash, not a user kill).
5. Group transitions to `reconnecting`. Coordinator's reconnect grace window is armed (45s default).
6. New observer CLI re-handshakes within the window → `session:cli-id-received` fires → `coord.applyEvent({type:"reconnect_ok"})` → group back to `active`. Drain on `reconnect_ok` (line 501) calls `drainPendingObserverWake`.
7. **But the same `ClaudeAdapter` instance survives the reconnect** (it's stored on the session, not re-created — see `ws-bridge.ts:830` `if (session.backendAdapter instanceof ClaudeAdapter)`). Its `observerTurnState` is still `"in-flight"` from the dead turn at step 1.
8. `drainPendingObserverWake` → `dispatchObserverWake` → bridge → `sendUserFrameFromServer` Gate 1 → returns `{kind:"busy"}` → dispatcher takes the `case "busy"` branch and re-queues the SAME checkpoint into `pendingCheckpoint`.
9. The new observer never receives a wake; the pump is dead until the user manually intervenes. Worse, the user has no UI affordance: the panel shows `active` (state machine is correct) but no `reviewing` because no wake fired.

**Severity rationale:** This is exactly the "silent infinite stuck state" pattern Principle 3 of the reference doc flags as P1. It survives reconnect (which the design explicitly recovers from for transport-level drops). The orphan-state problem is invisible to the state machine because the lifecycle source-of-truth is at the coordinator, not the adapter.

**Fix direction:** reset `observerTurnState = "idle"` in `detachWebSocket` (definitely) and `handleTransportClose` (definitely). The new turn-state can only be `idle` after socket drop — any frame mid-flight was lost with the socket. Document the invariant on `observerTurnState` JSDoc: "Reset to `idle` on socket detach. The next wake attempt across a fresh socket starts a fresh turn."

Sibling concern (`council-wake-sentinel.ts` durable record): the sentinel records "we already sent a wake for checkpoint X" by id. After the socket drop + reconnect, the dispatcher re-tries the queued checkpoint — but if Gate 0 (sentinel check at line 1224) fires for the SAME id, it returns `already_woken` and skips. So the queued checkpoint is dropped silently. Reset+re-dispatch would also need to clear the sentinel for the dead-turn checkpoint, OR the wake-version-echo must tolerate "I never saw the original wake". Recommend: reset `observerTurnState` AND clear `entry.pendingCheckpoint` on socket detach for a council observer half — let the next checkpoint file write be the next wake trigger. Sentinel-on-disk still protects against true cross-restart re-emission.

---

## P1-S2 — Checkpoint arriving DURING `reconnecting` is silently dropped, not deferred to `pendingCheckpoint`

**Where:** `dispatchObserverWake` Gate 1 (lines 1239–1257) checks `groupRecord.status !== "active"` and returns `{kind:"skipped", reason:"group_not_active"}`. The `bridgeOutcome.kind === "busy"` branch (lines 1353–1385) is the ONLY path that writes to `entry.pendingCheckpoint`. A `group_not_active` return enqueues nothing.

**Failure mode:**

1. Group is in `reconnecting` (observer dead, grace timer running).
2. Orchestrator writes checkpoint file for phase N+1 → `checkpoint-watcher` fires → `handleCouncilCheckpoint` (line 1135).
3. `entry.lastCheckpoint` is overwritten to phase N+1 (lines 1153–1154); `previousCheckpoint` captures phase N. **This mutates the manifest authority record.**
4. `dispatchObserverWake` runs → Gate 1 → `group_not_active` → returns with reason `group_not_active`. **The payload is not retained anywhere.**
5. Observer reconnects → `reconnect_ok` → `drainPendingObserverWake` → no `pendingCheckpoint` → no-op.
6. Observer never wakes for phase N+1. Phase N+1's review is never produced. The state machine is healthy; the user sees `active` with no `reviewing` activity.

The contextual brief explicitly asked: "What about a checkpoint arriving DURING reconnecting?" — the answer in the code is "silently dropped." This conflicts with the design intent of the 1-slot newest-wins queue (`pendingCheckpoint`), whose entire purpose is to retain checkpoints arriving during periods of observer unavailability. The `busy` path defers to drain; the `reconnecting` path does not. The asymmetry is a real lifecycle gap.

Worse: the lastCheckpoint mutation in step 3 corrupts the recovery view. On reconnect, the manifest re-derivation at the next observer wake will compute the delta `(phase N+1) → (phase N+2)` — phase N+1's modified-files set is permanently lost from the grounding history.

**Severity rationale:** "Stuck session class" (Principle 4) — a transient reconnect window can silently swallow checkpoints, with no user-visible signal that anything was lost. Symmetrical with the `busy → pendingCheckpoint` queueing semantic; the asymmetry is a defect.

**Fix direction:** Move the `pendingCheckpoint` retention upstream — in `dispatchObserverWake`, when Gate 1 fails with reason `group_not_active` AND the group status is `reconnecting` specifically, push the payload into `pendingCheckpoint` (with the same supersession-log accounting as the `busy` branch). `drainPendingObserverWake` on `reconnect_ok` already exists and will fire on the queued payload.

The `degraded` case must still drop (line 836 `group:degraded` drop is correct — observer is gone for this server lifetime). `pairing` and `archived` should also drop (no observer to wake). Only `reconnecting` is the case where retention is correct.

---

## P2-S1 — `markActivity` on outbound wake is correctly at the cliSocket I/O layer, BUT does not register activity if the send is gated out

**Where:** `sendUserFrameFromServer` (lines 971–1039). `this.onActivityUpdate?.()` fires at line 1037, AFTER the successful `cliSocket.send`. The `onActivityUpdate` callback is wired at `ws-bridge.ts:836` to `() => { session.lastCliActivityTs = Date.now(); }`. The idle-kill watchdog reads `session.lastCliActivityTs` (line 1225 `ws-bridge.ts`). Confirmed: this is the cliSocket I/O layer, NOT the browser layer. Touchpoint correct.

**Subtle concern:** If a wake is queued via the `pendingCheckpoint` slot (Gate 1 reconnecting path per S2, or `busy` path), the queue dwell time does not register as activity. A pathological scenario:

- Observer mid-turn at T=0 (`in-flight`, `lastCliActivityTs` recent).
- Observer turn drags for 3h 50m without producing a `result` (very long tool chain). `lastCliActivityTs` keeps updating because tool_progress / assistant frames count (line 493 — every non-keepalive bumps activity).
- Observer turn finishes at T=3h 55m → `result` → state flip → drain.
- Drain re-dispatches. Send succeeds → `lastCliActivityTs` resets again. Safe.

But: if the turn drags through a CLI crash (mid-turn drop), `lastCliActivityTs` last bumped at the last assistant/tool_progress frame. The session-orchestrator's idle-kill listener skips observers (line 608 `if (info.sessionGroupRole === "observer") return`). So observer is exempt regardless. Good.

**Confirmation:** the markActivity touchpoint IS at the cliSocket I/O layer (the bridge's `session.lastCliActivityTs` updater). The brief's question is answered correctly. The 4h idle-kill is also explicitly bypassed for observer-role sessions (line 608) — wake-every-5-minutes argument is moot because observers are not idle-killed at all. Both the activity-touchpoint AND the role-exempt guard are present; defense in depth.

**Severity:** P2 / informational. No bug; raising as a P2 to surface that the activity-touchpoint is technically redundant with the role-exempt guard. If a future maintainer removes one ("the other covers it"), they should know both exist for a reason — the activity touch is for any future role-agnostic idle gate (e.g. wake-source quotas).

---

## P2-S2 — Observer `pendingCheckpoint` is not persisted across server restart; relies on on-disk checkpoint file being re-read by the watcher

**Where:** `pendingCheckpoint` lives only in the in-memory `CouncilWatcherEntry` (line 207). Server restart clears it. The watcher rearms in `reconcileCouncilGroups` (line 729 `startCouncilWatchers`) and will re-emit the most recent checkpoint file via the file watcher.

**Failure mode:** marginal — the orchestrator's checkpoint files are durable on disk and the LRU dedup is built around `(file, mtimeNs)`. After restart, the watcher's first scan will re-emit the most recent `.json` file in `.council/checkpoints/`; `handleCouncilCheckpoint` will then re-call `dispatchObserverWake` for it; Gate 0 sentinel check (line 1224) catches duplicate-wake-after-already-sent; the dispatcher returns `already_woken` and skips.

**Concern:** If the in-memory `pendingCheckpoint` was for a NEWER sequence than the durable sentinel records, restart drops the newer payload. Example:

- T=0: phase N wake dispatched, sentinel records `last_woken_checkpoint_id = N`.
- T=1: phase N+1 file arrives, observer busy with N → queued in `pendingCheckpoint` (in-memory). Sentinel NOT updated.
- T=2: server restart.
- T=3: watcher rearms, re-reads the most recent file. The newest file on disk is phase N+1's; watcher emits it; Gate 0 sentinel mismatch (sentinel says N, payload is N+1) → falls through → dispatched → fresh wake. OK actually.

So the file-on-disk + sentinel-on-disk dual is enough to recover the queued wake intent. The persistence story is correct, but the `pendingCheckpoint` slot itself is a deliberate AP-3-style in-memory tier above durable on-disk state. Document it. (This issue is feedback_in_memory_derived_state_reconcile_on_restart territory — reconcile fires implicitly via the watcher's first-emit.)

**Severity:** P2 / informational — verifying the design is sound, not flagging a defect. The user's own memory note on "In-memory map/set populated only inside one event handler → lost on restart" applies in spirit; here the recovery is implicit via filesystem replay, which is correct but undocumented.

---

## P3-S1 — `result` is the correct per-turn terminator; choice validated against the protocol spec

**Where:** `claude-adapter.ts` `handleResultMessage` (lines 746–763) flips state on the `result` NDJSON frame. The alternative considered was `assistant.stop_reason` per the brief.

**Validation:** `CLIResultMessage` in `session-types.ts` (line 136) has `subtype: "success" | "error_during_execution" | "error_max_turns" | "error_max_budget_usd" | "error_max_structured_output_retries"`. All terminal turn outcomes — including error cases — carry a `result` frame. `assistant.stop_reason` can be `"tool_use"` (mid-turn tool calls) or `"end_turn"` (turn complete pending result frame), so it is NOT a reliable terminator. The council's choice of `result` over `stop_reason` is correct.

**Not validated against actual recorded sessions in this review.** The recorder JSONL files under `~/.companion/recordings/` would conclusively prove that `result` always terminates a turn (no recorded turn ends without one). I did not load recordings during this review — recommend Beck (Test Quality) add a replay-based test that asserts "every observed turn ends with exactly one `result` frame, and `result` is the LAST frame in the turn-bracket" as the canonical EC-6 protocol invariant. Until such a test exists, the choice is correct-by-spec but unvalidated-by-replay.

**Severity:** P3 / informational. Action item: replay-based regression test as Beck's responsibility.

---

## P3-S2 — State flip ordering: `observerTurnState = "idle"` THEN `companionBus.emit("observer:turn-done")` THEN `browserMessageCb`

**Where:** `handleResultMessage` lines 755–762.

**Ordering analysis:**

1. `observerTurnState = "idle"` — synchronous mutation.
2. `companionBus.emit("observer:turn-done", ...)` — synchronous emit; listeners are sync (the listener at session-orchestrator.ts:410 is sync, calls `drainPendingObserverWake` which is sync).
3. The drain → `dispatchObserverWake` → `sendUserFrameFromServer` → Gate 1 reads `observerTurnState` → reads `"idle"` (because step 1 already flipped). Send succeeds → flips back to `"in-flight"` (line 1036).
4. `browserMessageCb?.()` — fires AFTER the drain re-flipped to `"in-flight"`.

Subtle observation: the browser receives the `result` frame AFTER the next wake has already been dispatched in-flight to the CLI. From the browser's perspective, the `observer_review` payload arrives, the next observer turn has already started server-side. There is NO browser-visible window where the panel is `sleeping` between two turns under a drain. This is the design intent (continuous-wake-on-checkpoint-burst), but worth confirming the frontend's panel-state derivation handles "result arrives after a fresh in-flight" correctly. The brief shows `reviewing` state is bounded by `lastCheckpointAt + wakeTimeoutMs`; if a new wake fires before the previous result reaches the browser, `lastCheckpointAt` updates first (via `group:checkpoint`) and the panel stays in `reviewing` cleanly. Not a defect — flagging only as a non-obvious ordering invariant.

**Severity:** P3 / informational. Ordering is correct, atomic, and subscriber-safe. Document on `observerTurnState` JSDoc: "Mutation happens BEFORE the bus emit so a synchronous subscriber observes the post-flip state."

---

## Non-findings (verified, not flagged)

**EC-2 preservation on the wake-pipeline:** `dispatchObserverWake` does NOT touch `this.intentionalKills` on ANY of its outcome paths (verified by grep over lines 1194–1440 — zero matches). Send-failure (`case "failed"`, lines 1427–1438) logs at error severity, returns the outcome, and exits — no `intentionalKills.add()`, no fake `session:exited` emission, no `group:degraded` emit. Subprocess Council Rec 6 explicitly honored: "do NOT mark the half degraded directly" comment at lines 1188–1192 matches the implementation. EC-2 invariant (archive/delete marks BOTH ids intentional first) is unchanged.

**Idle-kill at 4h for observer:** Twice-protected. (a) Observer-role check at line 608 short-circuits the `session:idle-kill` listener before any kill happens. (b) The wake itself bumps `lastCliActivityTs` (line 1037 → `onActivityUpdate` → bridge:836). An observer that wakes every 5 minutes will not be idle-killed; an observer that never wakes also will not be idle-killed because of the role exemption. Both layers are defensive — neither is redundant in isolation if the other is removed without care.

**`group:degraded` drop of `pendingCheckpoint`:** Correctly clears the slot (lines 836–848). Logs `event=council.wake.dropped` with reason `group_degraded`. The dropped checkpoint id is captured in the structured log — operator can recover the missed wake by manual file replay if needed.

**`reconnect_ok` drain of `pendingCheckpoint`:** Fires only when `ctx.deadRole === "observer"` (line 484). Orchestrator-half reconnect does not trigger the drain — correct, because the orchestrator-half is the WRITER of checkpoints, not the consumer; nothing in `pendingCheckpoint` is observer-bound during an orchestrator-only reconnect. (But see S2 above for the case where the OBSERVER half is mid-reconnect AND a NEW checkpoint arrives during that window — that's the dropped path.)

---

## Summary

| Finding | Severity | Class |
|---------|----------|-------|
| S1: turn-state not reset on socket disconnect → permanent `in-flight` after mid-turn drop | **P1** | Stuck-session, lifecycle |
| S2: checkpoint during `reconnecting` silently dropped, not deferred | **P1** | Lifecycle gap, asymmetric with `busy` path |
| S2.1: markActivity correctly at cliSocket layer; double-protected with role-exempt | P2 | Informational |
| S2.2: `pendingCheckpoint` not persisted; implicit recovery via watcher replay | P2 | Documentation |
| S3.1: `result` is correct terminator; not yet validated against recordings | P3 | Beck follow-up |
| S3.2: state-flip → emit → browserMessageCb ordering is atomic, subscriber-safe | P3 | Documentation |

Two P1s land on the same root cause class: observer half's lifecycle state across socket-drop boundaries. The `pendingCheckpoint` slot is the right design for `busy`; it should symmetrically cover `reconnecting`. The `observerTurnState` field needs explicit reset on socket detach. Both fixes are surgical (5–10 LOC each) and unlock the design's intended behaviour without changing the public contract.
