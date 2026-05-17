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

## Tracking

- Bug captured here for Phase 3β scope inclusion (or hotfix branch if user prioritises).
- Cross-reference: this bug class is a sibling of every failure mode the 3 cited memories describe — they collectively suggest a systemic create-time-bootstrap problem in Council Mode pair spawn, not a one-off.

**Next action:** Phase 3β session should start with this bug as the first user-visible failure to close. Hotfix path: dedicated tmux worktree + branch `fix/council-mode-spawn-bootstrap` + repro capture + targeted fix (likely 1-2 lines in `createCouncilGroup` to bootstrap from response, plus a regression integration test that asserts both halves have non-empty context after pair-spawn).
