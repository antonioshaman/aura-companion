# BUG: Council Mode pair-spawn shows "session failed" then resume creates empty-context pair

**Reported:** 2026-05-17 (operator session, manual reproduction on SpiritMiner project)
**Severity:** P1 — Council Mode spawn flow is the entry point; broken UX here gates all Council Mode adoption.
**Repro reliability:** at least once on a fresh SpiritMiner workspace; not yet reproduced systematically.

## What the user saw

1. **Created a Council Mode session** for SpiritMiner project via "New Session" form with Council Mode toggle on.
2. **Long hang at spawn**, then a "session failed" error message appeared in the Aura Companion UI.
3. **Clicked "resume" / similar button** in the Aura panel (exact label not captured — possibly the relaunch / reconnect affordance on a failed pair).
4. **Both halves got created** (orchestrator session ID appeared in sidebar; observer session ID appeared as paired sibling).
5. **NEITHER half had a primary context window / first message visible** in chat.
6. **Browser refresh + retype the original task** into the orchestrator → orchestrator started working.
7. **Observer state never verified** post-refresh — operator did not switch to observer half to check if it picked up the checkpoint.

## What's unknown

- Was the initial spawn TIMEOUT (cli-launcher couldn't get CLI handshake within grace) or HARD FAILURE (codex-not-installed / port collision)?
- After "resume", did `applyCouncilObserverSpawnConfig` actually run for the observer half? (Server log line `council.observer-prompt.bundled-fallback` or workspace-source variant)
- Was `group:created` event broadcast BEFORE the browser was connected? (Race per `feedback_create_event_broadcast_races_client_connect`.)
- Why was the orchestrator's first user message lost? Did the browser send it before WS was ready?
- After refresh + retype, did the orchestrator actually fan a `group:checkpoint` to the observer? Or is the observer still in "awaiting first checkpoint" state forever?

## Hypothesis pointers (from existing memory)

Three feedback memories describe failure modes that match this symptom set:

1. **`feedback_create_event_broadcast_races_client_connect`** — create-time pub/sub events fired before client connect → `broadcast(emptySet)` drops event silently. The "no primary context window" symptom is exactly what happens when `group:created` + the first orchestrator system message are emitted before the browser's WS handshake completes. **Fix idea:** bootstrap from the create response (deterministic) instead of relying on the broadcast.

2. **`feedback_in_memory_derived_state_reconcile_on_restart`** — in-memory derived state populated only inside one event handler is lost on restart even when persistent base survives. After "session failed" + resume, the group record may exist in `session-store.json` but `councilGroupMeta` (in-memory) may be empty until `reconcileCouncilGroups()` runs on next initialize. **Fix idea:** the resume path must call the same reconcile logic the cold-boot path does.

3. **`feedback_protocol_handshake_vs_transport_state`** — `state=connected` is transport open, not protocol-ready. The "session failed" message may fire because the UI checks transport-only readiness while the protocol handshake (CLI's `system { type: "init", session_id: ... }` frame) is still pending. **Fix idea:** gate the "ready" UI signal on the handshake-result field (`cliSessionId`), not on socket state.

The combination matches: spawn races client connect (#1), resume creates the pair but the in-memory bootstrap is incomplete (#2), and the "session failed" message is premature because protocol-ready vs transport-ready conflation (#3).

## Files to inspect

- `web/server/session-orchestrator.ts` — `createCouncilGroup` (pair spawn entry), `reconcileCouncilGroups` (restart recovery)
- `web/server/session-group-coordinator.ts` — `spawnGroup` (rollback semantics: observer-spawn failure kills orchestrator)
- `web/server/cli-launcher.ts` — `applyCouncilObserverSpawnConfig` (observer prompt + permission profile injection)
- `web/server/ws-bridge.ts` — `broadcastToGroup` (event fanout to both halves' browsers)
- `web/src/ws.ts` — client-side `group_*` / `observer_review` switch cases
- `web/src/store/council-slice.ts` — group record bootstrap from REST create response vs broadcast

## Repro plan (to capture proper failure mode)

1. Stop any running Aura Companion server. Tail server log to file.
2. Open fresh browser tab. Open DevTools → Network → WS panel.
3. Start Aura Companion server. Wait until ready.
4. Create Council Mode session for a Python or Bun project that has never been used before (SpiritMiner-like fresh workspace).
5. Capture: server log lines (especially `council.pair-spawn.*`, `council.observer-prompt.*`, EC-9 structured `event` lines), browser WS frames, exact UI error string, time-to-failure in seconds.
6. If "resume" button appears: click it; capture the new server log lines + WS frames + UI state.
7. Check observer half: switch to observer in sidebar; verify if chat is empty, if there's any system / wake message, if the observer's `.council/reviews/` has a file landed.
8. If still broken: `curl http://localhost:3456/api/sessions` to inspect server-side state — does the group record exist? Does `councilGroupMeta` contain the group? Are both halves `state: "connected"`?

## Provisional severity rationale

- Council Mode is THE differentiating feature of Aura Companion v2; spawn-failure UX poisons first impressions.
- "Session failed" → manual refresh + retype → works is a "wash, rinse, repeat" footgun that operators will hit every Council Mode session until fixed.
- Observer half going silent (operator's working theory: never picked up) means the pair is one-directional in production — defeating Phase 3α' Council Mode investment.

## ✅ Live repro captured 2026-05-17 22:47 — ROOT CAUSE FOUND

Reproduced live on SpiritMiner project, session "Bright Nova" (group `grp_f1e01155c40d5364592646356b8daede`). Server-side state via `GET /api/sessions`:

| Half | `state` | `cliSessionId` | `pid` | `etime` |
|---|---|---|---|---|
| Orchestrator (`72b3e201...`) | `connected` | `a27eae40-...` ✓ | 2572559 | 2:09 alive |
| Observer (`52af8c9d...`) | `connected` | **`null`** ❌ | 2572627 | 2:09 alive |

**Observer process is alive but `cliSessionId` is null after 2h+. Process argv shows `--print` (i.e. `-p` non-interactive mode).**

This is the smoking-gun intersection of TWO existing memory rules:

1. **`feedback_noninteractive_cli_handshake_emit_on_input`** — "Non-interactive CLIs (`-p`, `--print`) emit identity field (cliSessionId, ReadyForQuery-equivalent) **only AFTER first input** — gating a smoke test on it deadlocks." Observer is invoked with `--print` and waits for its first wake-frame before emitting `system { type: "init", session_id: ... }`.

2. **`feedback_protocol_handshake_vs_transport_state`** — "`state=connected` = transport open, не protocol-ready. Gate UI/tests on the handshake-result field (cliSessionId, ReadyForQuery, initialize-ack), не на socket state." Server-side `state: "connected"` for the observer is true (transport open) but `cliSessionId: null` means protocol-not-ready. UI's "Reconnecting…" banner is the group-aware status fired because one half is protocol-unready.

### The deadlock chain

```
Server: spawns observer with --print -p
   ↓
Observer (CLI): waits for first input before emitting cliSessionId
   ↓
Server: tracks observer state="connected" but cliSessionId=null
   ↓
Group-state-machine: one half not protocol-ready → group treated as degraded/reconnecting
   ↓
UI: "Reconnecting…" banner on orchestrator; observer pane "Awaiting first checkpoint"
   ↓
Server: never sends observer a wake-frame because the group is degraded
   ↓
Observer: never gets first input → never emits cliSessionId → loop forever
```

The orchestrator-half user-message also gets lost because the UI's send-gate sees the group is "reconnecting" and either drops the send or queues it indefinitely.

### Fix shape (1 of 3 paths)

**Path A — server-side wake-zero on spawn (preferred):**
- After spawning the observer with `--print`, immediately send a minimal "wake_zero" frame (empty/sentinel checkpoint with `observer_wake_payload_version` and a no-op `delta`) to unstick the CLI handshake.
- Observer then emits `cliSessionId`, group reaches "active", normal flow resumes.
- This matches `feedback_in_memory_derived_state_reconcile_on_restart` recovery shape.

**Path B — gate group-ready differently:**
- Group-state-machine should NOT require observer's `cliSessionId` to mark "active". Observer's `state="connected"` (transport ready) is sufficient because the observer's protocol handshake is by design event-driven (only fires on wake).
- Decouple "observer ready to receive wakes" (transport-state) from "observer has emitted identity" (handshake-state).

**Path C — switch observer to interactive mode (probably wrong):**
- Drop `--print -p` from observer spawn argv. Use the interactive long-running session shape.
- Cost: blows up the observer's "one cycle, one review file out" contract (the entire SDK design assumes `-p`).
- Don't do this; Path A or B are correct.

### Concrete files to change (Path A — minimum-change fix)

- `web/server/cli-launcher.ts` — `applyCouncilObserverSpawnConfig`: after spawn, send a wake-zero frame via the bridge.
- `web/server/ws-bridge.ts` — add a `sendObserverWakeZero(sessionId, sessionGroupId)` helper that emits a minimal valid `observer_wake` frame.
- `web/server/session-group-coordinator.ts` — `spawnGroup`: call `sendObserverWakeZero` after observer half lands in transport-connected state.
- Regression test: integration test that spawns a Council Mode pair, asserts both halves reach `state="connected"` AND `cliSessionId != null` within ≤5s.

### Forensic data preserved

- Live `GET /api/sessions` snapshot above
- Observer process argv (lots of detail — see Phase 3β hotfix worktree commit)
- Both PIDs were alive at 22:47 with 2:09 etime — proves long-running deadlock, not transient timeout

## Tracking

- Bug captured here for Phase 3β scope inclusion (or hotfix branch if user prioritises).
- Cross-reference: this bug class is a sibling of every failure mode the 3 cited memories describe — they collectively suggest a systemic create-time-bootstrap problem in Council Mode pair spawn, not a one-off.

**Next action:** **HOTFIX-class** — this is P0 not P1. Council Mode pair-spawn is structurally deadlocked on every fresh project. Recommended path: dedicated tmux worktree + branch `fix/council-mode-observer-wake-zero` + Path A fix above + the regression test. Estimated ≤2h with the live repro evidence above.
