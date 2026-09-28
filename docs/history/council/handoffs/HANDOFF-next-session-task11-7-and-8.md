# Handoff — Task 11 subsections #7 + #8

## Where origin/main is

```
2c9cb93  fix(council): emit half_respawned for post-grace pair recovery (#53)
904affd  feat(council): auto-proceed Task 11 foundation — recorder origin, sticky token, denylist module (#51)
df38e7f  fix(council): archive pair routes through coordinator.archiveGroup (EC-2) (#50)
```

## In flight

- **PR #54** — Task 11.6 (cross-tab user-frame observer + `noteUserMessage` production caller). Branch `feat/auto-proceed-wire-up`. Open. Test-locally green (342/342). Wait for CI green + human review.

## Queue for next session

### Subsection 11.7 — Idle-kill clock split (delicate; do FIRST when fresh)

**Goal:** Synthetic frames must NOT advance the idle-kill clock.
Otherwise auto-proceed keeps a session alive forever.

**Current write sites** for `session.lastCliActivityTs = Date.now()`:
- `web/server/ws-bridge.ts:540` (`onBrowserMessage` callback — incoming CLI→browser)
- `web/server/ws-bridge.ts:898` (`onActivityUpdate` callback passed to `ClaudeAdapter` ctor)
- `web/server/ws-bridge.ts:1261` (`startIdleKillWatchdog` initialization reset)
- `web/server/ws-bridge-codex.ts:40` (Codex adapter equivalent)

**Design:**
1. Add `noteUserActivity(session)` / `noteSyntheticActivity(session)` methods on WsBridge.
   - `noteUserActivity` updates `lastCliActivityTs`.
   - `noteSyntheticActivity` is no-op for the clock; may update a separate diagnostic counter.
2. Dispatch logic at each call site: query `idleTimerManager.isSyntheticTurnInFlight(sessionId)`.
   - true → `noteSyntheticActivity` (idle clock skipped)
   - false → `noteUserActivity` (idle clock advances)
3. **EC-6 static-grep canary** test: regex-extract function bodies via Bun's `import.meta` / fs reads, assert `session\.lastCliActivityTs\s*=` matches ONLY inside `noteUserActivity` body. Template: PR #50's `archiveSession` canary (see `feedback_static_grep_canary_regex_over_substring`).

**Dependencies:** WsBridge needs reference to `idleTimerManager`. Pass it through constructor or setter.

**Risk:** This is the god-module surface — `ws-bridge.ts` already at high complexity. Push helper functions to a sibling file (`web/server/ws-bridge-activity-tracker.ts`?) if the in-file refactor crosses ~30 lines added. Per `feedback_file_level_coverage_gate_cascade`: don't bloat ws-bridge.ts's coverage requirements.

**Tests required:**
- 100 synthetic frames in sequence do NOT advance `lastCliActivityTs`
- One user frame DOES advance `lastCliActivityTs`
- EC-6 static-grep canary as described above

### Subsection 11.8 — Wire synthetic-frame stub + 4 cleanup paths

**Goal:** Replace `index.ts` stub `sendSyntheticFrame: () => ({ok:false, error:"synthetic-send-not-wired-task-11"})` with real `wsBridge.sendOrchestratorSyntheticFrame(sid, body)`.

**Steps:**
1. Add `WsBridge.sendOrchestratorSyntheticFrame(sessionId, body)` — mirror of `sendObserverWakeFrame` but with `origin:"server:auto-proceed"` recorder marker. Goes through ClaudeAdapter's outbound FIFO queue (`enqueueOutboundFrame(kind:"synthetic", body)`).
2. `index.ts` (line 141, near `sendSyntheticFrame: () => {...}`) — replace stub.
3. **Cleanup paths** (4 sites — all use the foundation modules from PR #51):
   - `claude-adapter.ts` `can_use_tool` handler:
     ```
     if (idleTimerManager.isSyntheticTurnInFlight(sid) && isToolUseDeniedForSynthetic(toolName, toolInput))
       → deny with denialMessageForSynthetic(...)
     ```
   - `claude-adapter.ts` `result`-frame NDJSON observer: call `idleTimerManager.noteTerminalResultFrame(sid)` on each result frame.
   - `session-orchestrator.ts` `session:exited` handler: call `idleTimerManager.clearPendingSyntheticTurn(sid)`.
   - `session-orchestrator.ts` `archiveSession` council branch (added in PR #50): call `idleTimerManager.clearPendingSyntheticTurn(group.primary.sessionId)`.

**Tests required:**
- Race-regression (5-step: fire → user-frame → can_use_tool DENY → result-frame → can_use_tool ALLOW)
- Denylist + sticky-token composition (Bash:git push denied during synthetic; allowed when no synthetic)

## Memory rules active

- `feedback_call_site_presence_not_just_symbol_export` — verify each foundation surface (denylist, sticky token, FIFO queue) gets its production caller in #8
- `feedback_static_grep_canary_regex_over_substring` — EC-6 canary anchoring discipline (function body, not literal substring)
- `feedback_file_level_coverage_gate_cascade` — push complexity to sibling files if ws-bridge.ts gets too large
- `feedback_partial_fix_passed_as_complete` — verify ALL 4 cleanup paths in #8 wire-up, not just the first one or two

## Не trogать

- PR #54 in-flight — let it merge naturally after CI + human review.
- Council pair `grp_e81a5ef...` — alive and active post-recovery; pair recovery validated end-to-end via PR #53 fix (see journal at 02:31:23).
- Skill `/council-review-aura` — still queued for AFTER all three 11.6/7/8 PRs land, per Scenario B from earlier this session.

## Pre-dispatch gates for next session

1. `gh pr view 54` — verify state (open / merged / closed).
   - If MERGED → branch fresh `feat/auto-proceed-wire-up-7` from origin/main for subsection 7.
   - If OPEN → stack subsection 7 on top of current branch.
2. Probe runtime ports: `ss -tlnp | grep -E ":3456|:3457"`. Default to 3456 for any REST probe.
3. `git pull --ff-only origin main` before branching.
