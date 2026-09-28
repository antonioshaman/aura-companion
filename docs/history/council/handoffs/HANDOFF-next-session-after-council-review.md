# Handoff — Next session (after Council Review 2026-05-15-0336 closure)

## What just shipped (last 8 commits on main)

```
36c3fc8 docs(council): archive review-output 2026-05-15-0336 + fix #6 table mismatch (#58)
38dfdb1 fix(council): exhaustive BridgeObserverWakeOutcome switch + never tripwire (#57)
fcbc784 test(council): backfill behavioural tests for review 2026-05-15-0336 (#56)
e9e22ca fix(council): defensive hardening from review 2026-05-15-0336 (5 P1 fixes) (#55)
3dee080 feat(council): auto-proceed Task 11 wire-up — 11.6 + 11.7 + 11.8 integration (#54)
2c9cb93 fix(council): emit half_respawned for post-grace pair recovery (#53)
904affd feat(council): auto-proceed Task 11 foundation — recorder origin, sticky token, denylist module (#51)
df38e7f fix(council): archive pair routes through coordinator.archiveGroup (EC-2) (#50)
```

This session closed:
- **OBS-STOP-1**: `handleCLIOpen` unconditional kickoff race that silently dropped `appendSystemPrompt` from any caller (session-creation-service, agent-executor, session-orchestrator). Buffered onto `session.pendingSystemPromptInjection`, consumed by kickoff into ONE well-formed initialize. PR #55.
- **CR-1**: Denylist gate fail-CLOSED on `idleTimerProbe===null` (was fail-OPEN). 3-expert convergence. PR #55.
- **CR-2**: Synthetic-send orchestrator turn-state gate moved inside adapter (TOCTOU close). PR #55.
- **CR-3**: `isSyntheticTurnInFlight` torn-read fix (single-read + explicit short-circuit). PR #55.
- **CR-4**: Exhaustive `BridgeObserverWakeOutcome` switch + `never` tripwire (EC-15). PR #57.
- **CR-5**: `archiveSession` clear moved BEFORE `await archiveGroup`. PR #55.
- **CR-6**: Replay test for `server:auto-proceed` recorder origin (2 cases). PR #56.
- **CR-7**: 2/3 session-orchestrator wiring behavioural tests (`onUserFrameObserved` forwarding + `session:exited` cleanup). PR #56. Third site (archiveSession council branch) deferred.
- **OBS-WARN-3**: FINAL-REVIEW.md #6 table-vs-body Council attribution alignment. PR #58.

## What's queued (in priority order)

### P1 — Beck P1.4 race-regression integration test (highest leverage open finding)

The deferred 5-step interleaving test from the council review. Component coverage cannot stand in for it — the surface under test is **cross-module probe state desync**: bridge probe says synthetic-in-flight, but adapter's closure captured a stale probe at construction; idle-timer-manager's pending token survives result-frame because adapter's transition guard short-circuits.

**Test shape (recommended):**
```ts
describe("Task 11 auto-proceed cross-module race regression", () => {
  // FakeClock + spy on noteTerminalResultFrame + spy on noteUserMessage
  // 5 steps:
  //   1. Arm idle timer + fire → assert isSyntheticTurnInFlight=true
  //   2. Inject browser user-frame via routeBrowserMessage → assert flag STILL true (stickiness)
  //   3. Inject can_use_tool for Bash:git push → assert behavior:"deny" sent to CLI
  //   4. Inject terminal result-frame → assert noteTerminalResultFrame fires, flag flips false
  //   5. Inject another can_use_tool for Bash:git push → assert browser permission_request fires (gate now open)
});
```

Likely lives in a new `web/server/auto-proceed-race-regression.test.ts` to avoid bloating the god-modules' test files. ~80-120 LOC.

### Council P2s still open (5)

- **#8 god-module split** — extract `ws-bridge-idle-watchdog.ts`, `ws-bridge-council.ts`, `ws-bridge-ai-validation.ts` BEFORE PR #52 lands. Pure refactor.
- **#9 probe interface drift** — export `IdleTimerProbe` type from `idle-timer-manager.ts`; import at 5 sites. Per EC-14.
- **#10 denylist coverage prose mismatch** — gate comment claims "destructive operations" but list is 4 publish-to-others entries. Sync prose or widen list.
- **#11 non-string `tool_name` fail-CLOSED** — add `if (typeof toolName !== "string") return true` at top of `isToolUseDeniedForSynthetic`.
- **#12 `injectUserMessage` server-origin observer-fire** — thread `origin: "browser" | "server:cron" | "server:agent" | ...` through `routeBrowserMessage`. Per EC-16. **Sequence with CR-6 origin pattern per OBS-WARN-2.**

### Council P3s (3)

- **#13** `detachWebSocket` cleanup on mid-flap (~3 LOC)
- **#14** denial-message markdown injection (strip backticks, ~3 LOC)
- **#15** ZW-class characters bypass denylist (~5 LOC + comment)

### Other open work (pre-existing 4 P1s)

These pre-date this council review:
- `feedback_aura_observer_panel_no_rest_bootstrap` — UI doesn't bootstrap findings from REST; reconnect replays `group_created` but not `group_review`/`group_checkpoint`
- `feedback_aura_browser_flicker_grey_under_bus_storm` — render storm under degraded + relaunch
- `feedback_aura_dev_prod_dual_bun_port_confusion` — two bun processes on 3456 + 3457 with INSTANCE-LOCAL in-memory state
- ~~`feedback_aura_half_respawned_zero_emit_recovery_void`~~ — CLOSED by PR #53

### PR #52 still open elsewhere

PR #52 (Task 11.1+11.2 outbound FIFO queue) was opened in a prior session and **still open**. When it merges, follow-up: route `sendOrchestratorSyntheticFrame` through `enqueueOutboundFrame(kind:"synthetic", ...)`. The exhaustive switch in `index.ts` (CR-4 fix) will break-compile when the new `{kind:"queued"}` variant is added — that's intentional, signals the wire-up gap.

## Runtime state at handoff time

**Production server (port 3456):**
- Bun PID 1507312 (pre-restart) — will be killed if user restarts service
- Service restart activates new code from main, including all 4 just-merged PRs

**Council pair `grp_e81a5ef8c55a741db574fbe59f7fb1a7`:**
- orchestrator PID 1509060 (cliSessionId `02d3d783-01ca-4dbb-bb7a-c48e6c500ab6`)
- observer PID 1509277 (cliSessionId `b589b05f-bd5c-46ff-9431-9ee498ad2e9b`)
- workspace `/root/aura-companion`
- Survived 2 reconnect cycles + production-validated PR #53's `half_respawned` emit at 02:31:23

**Observer review on FINAL-REVIEW.md**: landed at 03:51 with 2 STOPs (both addressed in this session's PRs) + 3 WARN + 1 NOTE + 6 INFO. File at `.council/reviews/council-review-claude-observer.md` (committed in PR #58).

## Re-probe gates BEFORE doing anything in next session

Per `feedback_handoff_narrative_vs_runtime_state` — this handoff WILL drift; verify before acting:

```bash
# 1. main HEAD matches expectation
git log --oneline -1 origin/main
# expected: 36c3fc8 (or newer if anything merged since)

# 2. Production port
ss -tlnp 2>/dev/null | grep -E ":3456|:3457"
# 3456 is prod (target for all council POSTs); 3457 is dev `bun --watch`

# 3. Active pair status (3-layer)
curl -fsS http://localhost:3456/api/sessions | python3 -c "
import sys,json
data=json.load(sys.stdin)
sessions = data.get('sessions',data) if isinstance(data,dict) else data
for s in sessions:
  if isinstance(s,dict) and s.get('state')=='connected' and s.get('sessionGroupId') and s.get('cwd')=='/root/aura-companion':
    print(f\"  group={s.get('sessionGroupId')} role={s.get('sessionGroupRole')} sid={s.get('sessionId')}\")
"

# 4. State-machine status (per feedback_aura_council_pair_three_layer_liveness)
sudo journalctl --since "5 min ago" -u aura-companion.service \
  | grep -E "group\.reconnect_(started|failed|ok)|group\.degraded|group\.half_respawned"
# last event determines current status

# 5. Check open PRs
gh pr list --repo antonioshaman/aura-companion --state open --limit 10
```

## Memory rules active and load-bearing

These hit hardest this session — read them before plunging:

- `feedback_agent_polls_ci_doesnt_wait_for_user` — `gh pr checks <N>` autonomously; never write "let me know when CI green"
- `feedback_verify_staged_files_match_implicated_set` — after `git add`, `git diff --cached --stat` against mental list (lost ws-bridge.test.ts in PR #54 → had to ship ffb48d3 fix-commit)
- `feedback_aura_council_pair_three_layer_liveness` — process/transport/state-machine each desync independently
- `feedback_state_machine_third_tier_liveness` — universal version
- `feedback_handoff_narrative_vs_runtime_state` — probe before honoring handoff
- `feedback_multi_expert_convergence_promotion` — 3+ experts on one root cause = structural truth, promote severity
- `feedback_static_grep_canary_regex_over_substring` — EC-6 / EC-19 canaries anchor on function name, brace-counted body
- `feedback_call_site_presence_not_just_symbol_export` — symbol exists + unit-tested ≠ wired in production
- `feedback_recovery_branch_reachability` — recovery transitions need explicit producer emit (not just transition table)
- `feedback_process_ancestry_check_before_parent_restart` — walking `/proc/$$/stat` ancestry before `systemctl restart aura-companion.service`

## Conventions in conventions.md (don't re-flag in reviews)

Existing floor: AP-1..AP-4, EC-1..EC-19 (this session added AP-4 + EC-14..EC-19).

## How to resume

1. Run the runtime probes above first.
2. If main HEAD is unchanged: pick from queue (recommend Beck P1.4 race-regression test).
3. If you find the queue surprising (e.g. user said "fix #11" earlier), grep `.agents/knowledge/`, `.learnings/`, `memory/` BEFORE assuming "no context" — this session's memories propagated.
4. Council pair `grp_e81a5ef...` should still be alive after server restart (reconcile boot-path will register both halves as active). If it's degraded, my new `half_respawned` emit at `session:cli-id-received` should recover it automatically on the next handshake — that's exactly what PR #53 fixes.

## Not in scope for next session

- Do NOT auto-merge any further PR without user consent for that specific PR.
- Do NOT touch `feedback_aura_observer_panel_no_rest_bootstrap` family without explicit user prompt — those are 4 separate hotfix branches each.
- Do NOT chase the 4 stale HANDOFF-*.md files in repo root unless user references them — they're prior-session artifacts that may be superseded by this one.

## End of handoff
