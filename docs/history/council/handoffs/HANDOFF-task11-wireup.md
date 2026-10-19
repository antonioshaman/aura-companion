# Handoff — PR Task 11 integration (subsections 6, 7, 8)

Continuation of `HANDOFF-next-session-PR-2c-task11.md` after **PR #51
foundation** (recorder origin + sticky pendingSyntheticTurnToken +
denylist module) AND **PR #52 FIFO queue** (subsections 1+2) shipped.

## Where origin/main is (after PR #51 + PR #52 merge)

```
origin/main (expected after #52 merges):
  <PR #52 squash>  feat(council): auto-proceed Task 11.1+11.2 — outbound FIFO queue + asymmetric overflow (#52)
  904affd          feat(council): auto-proceed Task 11 foundation — recorder origin, sticky token, denylist module (#51)
  df38e7f          fix(council): archive pair routes through coordinator.archiveGroup (EC-2) (#50)
  bd092f0          feat(council): auto-proceed boundary validator + observer-poll failsafe (Task 10) (#49)
  ...
```

**If PR #52 is merged:** branch fresh from `origin/main` post-merge.
**If PR #52 is still in review:** branch from `origin/feat/auto-proceed-fifo-queue` and stack the integration commits on top. After #52 merges, rebase the integration branch onto main.

## What's already in the codebase (USE — do not duplicate)

- `web/server/auto-proceed-permissions.ts` — denylist + predicate + denial-message builder. Use `isToolUseDeniedForSynthetic(toolName, toolInput)` in the can_use_tool handler (subsection 5 wire-up).
- `web/server/idle-timer-manager.ts`:
  - `pendingSyntheticTurnToken` field — populated by `fire()` on success.
  - `isSyntheticTurnInFlight(sessionId): boolean` — query this in the can_use_tool handler.
  - `noteTerminalResultFrame(sid)` — call this from the adapter's `result`-frame NDJSON observer (subsection 8 wire-up).
  - `clearPendingSyntheticTurn(sid)` — call this from the orchestrator's `session:exited` / `cli_session_relaunched` / `archiveSession` paths.
- `web/server/recorder.ts` — `RecordingOrigin` includes `"server:auto-proceed"`. Pass this to `recorder.record(...)` in the synthetic-frame send path.
- `web/server/claude-adapter.ts` — outbound FIFO queue (PR #52):
  - `enqueueOutboundFrame(kind, payload): ClaudeAdapterEnqueueOutcome` — call this from `sendOrchestratorSyntheticFrame` (Task 11.8) with `kind="synthetic"`. Caller does NOT await; chain is fire-and-forget.
  - On `error: "queue-full"` (synthetic refused at saturation): EC-9-log + manager `fire()` returns `{kind:"send-failed", error:"queue-full"}`. Trace counter MUST NOT advance.
  - On `error: "queue-full-no-evictable"` (user-frame refused): bridge surfaces `protocol.frame_dropped` to originating browser socket via existing wire variant.
  - `getOutboundQueueDepth()` / `getOutboundQueueKinds()` — forensic accessors, test-only.

## Subsections still to ship (3 remaining)

### Subsection 1 — Per-session outbound FIFO queue ✅ SHIPPED in PR #52
### Subsection 2 — Asymmetric overflow policy ✅ SHIPPED in PR #52

### Subsection 6 — Single-firer gate / cross-tab union
- `wsBridge.onUserFrameObserved(callback: (sessionId: string) => void)` — fires synchronously on ANY browser socket's user-frame.
- `session-orchestrator.initialize()`: `wsBridge.onUserFrameObserved((sid) => this.idleTimerManager.noteUserMessage(sid))`.
- IdleTimerManager.fire's existing turnToken re-read IS the single-firer gate — this subsection adds the observability path only.

### Subsection 7 — Idle-kill clock split
- Enumerate ALL `session.lastCliActivityTs = Date.now()` sites in `ws-bridge.ts` (`grep -n "lastCliActivityTs\s*=" web/server/ws-bridge.ts` before refactor; same after to confirm relocation).
- Split into `noteUserActivity(sessionId)` and `noteSyntheticActivity(sessionId)` methods on ws-bridge.
- Synthetic activity does NOT advance `lastCliActivityTs` (otherwise synthetic frames extend the idle-kill clock indefinitely).
- **EC-6 static-grep canary test**: assert `session\.lastCliActivityTs\s*=` matches ONLY inside `noteUserActivity` body (use the function-body extraction pattern from PR #50's archiveSession canary). Observer v3 review WARN #2 anchoring rule.

### Subsection 8 — Wire stub → real bridge call + can_use_tool gate
- `index.ts`: replace `sendSyntheticFrame: (sessionId, body) => ({ok: false, error: "synthetic-send-not-wired-task-11"})` stub with `wsBridge.sendOrchestratorSyntheticFrame(sessionId, body)`.
- `ws-bridge.ts`: new method `sendOrchestratorSyntheticFrame(sessionId, body)` — mirror of `sendObserverWakeFrame` but with `origin: "server:auto-proceed"` recorder marker.
- **claude-adapter.ts `can_use_tool` handler**: gate with:
  ```ts
  if (idleTimerManager.isSyntheticTurnInFlight(this.sessionId)) {
    if (isToolUseDeniedForSynthetic(toolName, toolInput)) {
      return { behavior: "deny", message: denialMessageForSynthetic(toolName, toolInput) };
    }
  }
  ```
- **claude-adapter.ts `result`-frame observer**: on `result` NDJSON arrival, call `idleTimerManager.noteTerminalResultFrame(sessionId)`.
- **session-orchestrator.ts session-exited handler**: call `idleTimerManager.clearPendingSyntheticTurn(sessionId)` for the exiting session.
- **session-orchestrator.ts `archiveSession` council branch (added in PR #50)**: call `this.idleTimerManager.clearPendingSyntheticTurn(group.primary.sessionId)` after archiveGroup completes.

### Tests required (subsection 9 of the master handoff)

- **Race-regression test** (Promise-tick orchestration; PR #51's idle-timer-manager.test.ts is the right home OR a new file `auto-proceed-race-defence.test.ts`):
  1. Fire synthetic → `isSyntheticTurnInFlight=true`.
  2. Inject user-frame via wsBridge.onUserFrameObserved → flag STILL true.
  3. Inject `can_use_tool` for `Bash:git push` → DENY.
  4. Inject terminal `result` frame → flag flips false.
  5. Inject another `can_use_tool` for `Bash:git push` → ALLOW.
- **Multi-tab single-firer test** (new `ws-bridge-multi-tab.test.ts`): 2 sockets → arm timer → send user frame from tab B → advance FakeClock past `idleMs` → assert fire callback observed turnToken advanced and refused.
- **Idle-kill split test**: 100 synthetic frames in sequence do NOT advance `lastCliActivityTs`; one user frame DOES.
- **FIFO ordering test**: two near-simultaneous frames serialise.
- **Asymmetric overflow tests**: synthetic-at-saturation refused; user-at-saturation evicts oldest synthetic.

### Coverage gate (subsection 10)

- Every new file ≥ 80% line coverage in same commit.
- Modifications to `claude-adapter.ts`, `ws-bridge.ts`, `recorder.ts` — keep thin (≤ 5 lines per god-module). Push complexity to sibling files if sticky-token state logic grows (e.g. `web/server/auto-proceed-turn-state.ts`).
- File-level cascade defence per `feedback_file_level_coverage_gate_cascade`.

## Convention floor (do NOT re-flag in code review)

- AP-1 (coordinator DI-decoupled), AP-2 (state-machine = single source of truth), AP-3 (writer+reader in same file)
- EC-1 (SDK permission profile applied at spawn)
- EC-2 (group-aware kills mark BOTH intentional before kill) — PR #50 enforces this via `archiveSession` council branch.
- EC-5 (protocol parsers reject unknown shapes)
- EC-7 (filesystem path resolution through resolving wrapper)
- EC-9 (structured JSON log lines with event + sessionGroupId + sessionId + role)
- EC-13 (observer 5-min failsafe self-poll — shipped in PR #49)

## Memory rules to honour (recurring class)

- `feedback_call_site_presence_not_just_symbol_export` — verify every new symbol has a production caller. PR #51 ships the denylist module standalone but DOCUMENTS no production caller; subsection 8 wire-up MUST add the caller in claude-adapter's `can_use_tool` handler.
- `feedback_static_grep_canary_regex_over_substring` — EC-6 canaries anchored to function body via `inspect`-style extraction (see PR #50 archiveSession canary for template).
- `feedback_verify_test_bodies_not_just_names` — when adding tests for the race-regression scenario, verify mocks ARE injected, not just constructed.
- `feedback_format_transformation_validation` — denylist documented limitations are real (shell chaining + command substitution + bash-c indirection). Don't over-claim the gate's strength in PR description.
- `feedback_aura_dev_prod_dual_bun_port_confusion` — REST probes during testing default to port **3456 (prod)** when the user's UI is involved. Port 3457 = dev `bun --watch` — separate in-memory state.
- `feedback_aura_session_state_vs_process_liveness` — `/api/sessions` `state` field lies post-restart; probe `launcher.json` directly when investigating "post-restart broken state".

## Workflow

1. `git checkout main && git pull --ff-only origin main` (after PR #51 merges; if still open, branch from `origin/feat/auto-proceed-send-pipeline`).
2. `git checkout -b feat/auto-proceed-wire-up`.
3. Pre-emptive memory grep on `coverage | observer | producer | consumer | scheduled` topics (per the master handoff rule).
4. Implement subsections 1, 2, 6, 7, 8 in that order.
5. `cd web && bun run typecheck && bun run test` — green.
6. Local coverage gate: `bun run test -- --coverage` + grep coverage-summary.json for the three god-modules + new file (if extracted).
7. POST council-implement checkpoint to a FRESH council pair (the original pair `grp_4f15985bfcc15b0661e6fcbbe71daab8` is archived).
8. Wait ≥ 5 min between POSTs (`feedback_producer_emit_next_check_at_hint`).
9. Address observer findings → amend → re-POST with renamed artifact path to force re-read.
10. Commit + push + PR + `gh pr merge --squash --delete-branch` after CI green + human review.

## Not in scope for the wire-up PR

- Auto-proceed observer-side STOP resolution (Task 14 — UI zone).
- Task 2 — skill canary in `~/.claude/skills/council-*-aura/SKILL.md`.
- The four P1 findings captured this session (`feedback_aura_observer_panel_no_rest_bootstrap`, `feedback_aura_browser_flicker_grey_under_bus_storm`, `feedback_aura_dev_prod_dual_bun_port_confusion`, plus the RETRACTED `feedback_aura_council_group_reconcile_gap_post_restart`). Each is a separate hotfix branch from main.

## Pending TASK files in repo root (do not delete)

- `TASK-archive-pair-ec2-violation.md` — addressed by PR #50.
- `TASK-ui-stale-observer-and-pr-context-panel.md` — pre-existing.
- `TASK-sidebar-chip-redundancy-full-suppression.md` — pre-existing.
- `HANDOFF-next-session-PR-2c-task11.md` — the master handoff (still relevant for the wire-up subsections).
- `SESSION-2026-05-14-pause-state.md` — session-state entry point.
- `PLAN-aura-orchestrator-idle-auto-proceed.md` — master plan.
- `PLAN-tasks-10-11-boundary-and-send-pipeline.md` — PR-2c-specific plan, all WARNs/NOTEs addressed in PR #51 where applicable.

## Important runtime context

- **Production Aura** runs as `systemctl --system aura-companion.service` on **port 3456** (Main PID changes per restart). Probe via `systemctl show -p MainPID aura-companion.service`.
- A **separate dev `bun --watch`** may also be running on **port 3457**. Same workspace, same session-store, different in-memory state. Always confirm via `ss -tlnp | grep -E ":3456|:3457"` before REST probes.
- The original pair (`grp_4f15985bfcc15b0661e6fcbbe71daab8`) is archived. Spawn a fresh pair via UI for any council-implement workflow.
