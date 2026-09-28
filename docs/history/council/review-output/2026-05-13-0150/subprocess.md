# Subprocess Lifecycle — Regression Review

Commit 02e28c1 — second pass on observer auto-wake.

Verified fix-pass landings (no re-flag):
- `observerTurnState` reset in both `detachWebSocket` (claude-adapter.ts:193) and `handleTransportClose` (claude-adapter.ts:242). Idempotent on double-fire.
- `markActivity` (`this.onActivityUpdate?.()`) repositioned to claude-adapter.ts:993, before all three gates in `sendUserFrameFromServer`.
- New `case "reconnecting"` queue path in dispatcher at session-orchestrator.ts:1384-1411 returns BEFORE bridge call.
- `scanForMissedObserverWakes` (session-orchestrator.ts:676-736) runs after `reconcileCouncilGroups`.
- Reverse index `councilGroupBySessionId` at session-orchestrator.ts:366 populated in `createCouncilGroup` (1934-1935) and `reconcileCouncilGroups` (820-821), cleared on `group:exited` (1013-1014).
- Sentinel cleanup on `group:exited` (997-1018) deletes the wake sentinel; **does NOT touch `intentionalKills`** — EC-2 invariance preserved. Verified by grep: `intentionalKills` references at 336/549/592-593/621/1025-1086/2413-2565/2591 are unaffected by the new `group:exited` listener block.
- Drop-on-degraded for queued checkpoint at 929-941 fires for queued reconnecting-arrived checkpoints too (single `pendingCheckpoint` slot — both the new reconnecting case and the existing busy/backpressure cases write the same slot; degraded listener doesn't distinguish provenance, just drops whatever is there).

---

## NEW FINDINGS

### P2 — Race: `attachWebSocket` does not reset `observerTurnState`; out-of-order detach can deadlock the wake pump

**File**: `web/server/claude-adapter.ts:164-177` (`attachWebSocket`), interacting with `detachWebSocket` at 189-195

**Process-state failure**: `attachWebSocket` only sets `this.cliSocket = ws`; it does not reset `observerTurnState`. The detach path's stale-socket guard at line 191 (`if (this.cliSocket !== ws) return;`) silently early-returns when a new socket already attached. The reset at line 193 is then skipped.

**Race sequence**:
1. Old socket attached, `observerTurnState = "in-flight"` (mid-wake).
2. Old socket transport-level drop is buffered but close-event not yet fired.
3. CLI's exponential-backoff reconnect spawns a new socket; `attachWebSocket(newWs)` runs → `cliSocket = newWs`. State is still `in-flight`.
4. Old close-event finally fires → `detachWebSocket(oldWs)` → `this.cliSocket !== oldWs` → early return → state never reset.
5. Every subsequent wake on the new socket returns `{kind: "busy"}` forever. Dispatcher queues into `pendingCheckpoint`; queue drains on `observer:turn-done`, but that requires a `result` frame — and the wake `user` frame the new turn would need was never sent.

**Why fix-pass didn't catch this**: the reset was added to `detachWebSocket` and `handleTransportClose` (the close paths). The reciprocal — "fresh socket attaches clean" — was implicit on the assumption that close always precedes attach. In Bun's `ServerWebSocket` close-events fire synchronously when the kernel notices, but with a TCP RST or a half-open socket the new connection can complete handshake before the old close-event drains. This is exactly the case `handleTransportClose` was added for (Codex proxy drop), and the matching case for Claude is the WS-keepalive flap window.

**Suggested invariant**: `attachWebSocket` should set `this.observerTurnState = "idle"` unconditionally. A fresh socket cannot have an in-flight wake by definition — turn-state is socket-bound (per the JSDoc comment at line 144-143). Idempotent with the close-path resets.

**Severity rationale**: Same root failure class as the original Subprocess #2 (transient flap leaves adapter permanently `in-flight`); fix-pass closed two of the three doors but left the attach door open. P2 not P1 only because the existing 45s reconnect-grace + `relaunchExhaustedNotified` path tears the half down to `degraded` on persistent drop, which the orchestrator handles via the new drop-on-degraded path (929-941) — so a permanent deadlock requires the new socket to actually be the same observer's reconnect succeeding (rare but not impossible).

---

### P3 — `scanForMissedObserverWakes` mutates watcher state before checking dispatcher gates; minor info leak across skipped dispatches

**File**: `web/server/session-orchestrator.ts:723-727`

**Behaviour**: The catchup loop writes `entry.previousCheckpoint = entry.lastCheckpoint; entry.lastCheckpoint = highest;` BEFORE calling `dispatchObserverWake`. If the dispatcher skips (sentinel hit at Gate 0, or group not active at Gate 1), the watcher state remains seeded with `highest` as `lastCheckpoint`.

**Comparison to live path**: the regular `handleCouncilCheckpoint` at 1286-1287 has the same ordering (capture-prev-then-overwrite-then-dispatch). The difference is the live path runs `dispatchObserverWake` AFTER the seq-monotonic guard at 1276-1283, which is enforced by fs.watch ordering. The catchup path bypasses the live monotonic gate (it picked `highest` from a directory scan, so by construction `highest.sequence > lastCheckpoint.sequence` if `lastCheckpoint` is null at startup).

**Edge case**: server restarts twice. After Restart 1: catchup runs, seeds `lastCheckpoint = c5` (sequence 5), dispatcher hits the sentinel for c5 → skips. State now `lastCheckpoint = c5`. After Restart 2: catchup runs again, scans disk → still finds c5 as highest. Sentinel still says c5 already-woken → still skipped. No phantom: idempotent across N restarts. The seeded state is exactly what would have been seeded had the live path processed c5 originally.

**The only real ambiguity**: if catchup runs while the group is still in `pairing` (rare — `reconcileCouncilGroups` should set it to `active` first, but there's a window). Dispatcher Gate 1 returns `group_not_active` and skips the wake, but `lastCheckpoint` is now seeded. If the observer never reaches `active` (e.g. spawn-failure cascade), the seeded watcher state outlives the wake intent. This is harmless because watcher state is dropped on `group:exited` (via `stopCouncilWatchers` at 1016), and the sentinel cleanup at 1001 handles the persistence side. No leak.

**Suggested hardening (optional, not P2)**: gate the state mutation behind a check that `groupRecord.status === "active"` before seeding, so failed dispatches don't change watcher state. Symmetric with the live path's monotonic guard. Pure code hygiene — no current correctness bug.

---

### Note — activity-bump-on-all-outcomes is intentional and correct

The question asked whether `markActivity` before all 3 gates registers activity for gate outcomes it shouldn't. Walking the matrix:

- **busy** — observer is mid-turn; bumping activity is correct (orchestrator-driven work is real activity).
- **socket_disconnected** — observer's session is conceptually still `active` (state machine hasn't transitioned to `reconnecting` yet); during the transient flap window, the orchestrator producing checkpoints IS a signal the pair is alive. The 45s grace either resolves to `active` (state preserved correctly) or `degraded` (queued checkpoint is dropped via 929-941, and `group:exited` triggers idle-kill release via session teardown anyway).
- **backpressure** — observer transport is stalled but alive; activity bump is correct.
- **failed** — synchronous send-throw is typically a closed-but-not-yet-detached socket; equivalent to socket_disconnected.

For the dispatcher paths that return BEFORE calling the bridge (reconnecting at 1410, group_not_active at 1423, build_error at 1456), markActivity is NOT hit because `sendUserFrameFromServer` is never invoked. So a permanently-degraded observer does not get its idle-kill clock indefinitely refreshed by orchestrator checkpoints — the dispatcher's pre-bridge gates protect that.

**Verdict**: activity registration is correct for all gate outcomes that reach the adapter.

---

### Note — `detachWebSocket` + `handleTransportClose` co-fire is safe

For Claude adapter: `handleTransportClose` is only wired from `cli-launcher.ts:1068` for the **Codex** path (via `BackendProvider` switching). Claude adapter receives `detachWebSocket` from `ws-bridge.ts:915` on `handleCLIClose`. So the two paths don't overlap on the same adapter instance in production.

If they ever DID co-fire (defensive belt-and-braces): both set `cliSocket = null` and `observerTurnState = "idle"` — fully idempotent. The only difference is `detachWebSocket` calls `disconnectCb` and `handleTransportClose` does not. Calling `disconnectCb` once vs twice would be a bus-fanout doubling — the existing `if (this.cliSocket !== ws) return;` guard at 191 already prevents double-fire of `disconnectCb` on the legitimate stale-close path. **Not a finding.**

---

## Summary

One P2 (attach-side reset gap, symmetric to the fix-pass close-side reset) and one P3 (catchup watcher state seeded before dispatch gate — currently harmless, code-hygiene only). All the asked-about cross-cuts (queue-drop on degraded, EC-2 invariance, scan idempotency, activity-bump correctness) hold.
