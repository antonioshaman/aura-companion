# Handoff — Next session (post γ + tactical + #9 + #12 closure, 2026-05-15 evening)

**Branch shipped:** `chore/council-fixpass-tactical-2026-05-15` ([PR #59](https://github.com/antonioshaman/aura-companion/pull/59))

**Total: 10 commits**, 6277/6281 tests pass (+32 new behavioural rows), typecheck clean.

**CI fix-pass (`30f773d`)** added post-initial-push to address two CI failures the local Linux suite didn't catch:
- macOS path canonicalisation: test fixtures now `realpathSync(mkdtempSync(...))` so `/var/folders/` (raw tmpdir) doesn't diverge from `/private/var/folders/` (realpath) on macOS-CI
- Coverage gate on `server/github-pr.ts`: 61.36% → 94.69% via 9 new `fetchPRInfoAsync` test rows under a Bun.spawn fake-proc factory + 1 `_clearCaches` row

## Re-probe gates BEFORE doing anything

Per `feedback_handoff_narrative_vs_runtime_state` — this handoff WILL drift; verify first:

```bash
# 1. main HEAD + PR #59 state
gh pr view 59 --repo antonioshaman/aura-companion --json state,mergeable
# Expected: state OPEN (or MERGED if reviewer landed it)

# 2. Local branch state
git branch --show-current && git log --oneline -3
# Local should still be on `chore/council-fixpass-tactical-2026-05-15` OR back on main if user already merged + synced

# 3. After merge: sync local main
git checkout main && git fetch origin && git reset --hard origin/main

# 4. Production server alive
curl -fsS http://localhost:3456/api/sessions 2>&1 | head -3
# If down, the orchestrator that's running THIS session was killed; start a fresh session

# 5. Verify the council-pair sessionId for checkpoint POSTs
#    Last known: sid 2afe4c7c-ed94-4e87-bcef-1c73dfa204d9, gid grp_c00c19bdc428fd0722bc27dd63f2b3e0
#    These WILL change after server restart.
```

## What shipped in PR #59

### γ Bug B P2/P3 cleanup (6 commits — Council Review 2026-05-15-1015)

| Commit | Closes | Headline |
|---|---|---|
| `891de4e` | CR-1/2/3/4/5 (5 P1) | `observerPromptSourceLabel` dropped from EC-9 log; double-emit `session:relaunch-failed` skipped on config errors; `--append-system-prompt` argv + drift WARN gated on `!resumeSessionId`; +5 behavioural tests; SHA cross-axis pin |
| `8e5dfa2` | CR-6/7/9/10/15/16/18/19/21 (9 P2/P3) | `wrapFsError` redacts path bytes, non-Error robustness, JSDoc warning on cause; workspace bounds via `realpathSync(cwd)`; `assertExhaustiveObserverPromptSource` `never` tripwire; `clampLatencyMs` split with negative-detection; stale comment rename; tautological row delete |
| `e51ef10` | CR-12/17/20 (3 lifecycle) | `intentionalKills.add` before relaunch SIGTERM with `finally` cleanup; hard refusal on `workspace↔bundled` source-crossing (typed `observer-prompt-source-drift-refused:` reason); drift baseline snapshot moved pre-kill |
| `a90c557` | CR-13/22 (version semantics) | `BUNDLED_OBSERVER_PROMPT_SOURCE_LABEL` derived from `SCHEMA_VERSION`; `observerPromptVersion` on `SdkSessionInfo` + EC-9 log quadruplet + drift WARN; generator emits first/last 200-char body preview comment |
| `c6245c0` | CR-8/14 (canary hardening) | `event-bus-types.ts:28` documents relaunch-only contract; EC-19 canary asserts emit-site confinement; EC-19 anchor → `indexOf` literal (replaces brittle regex); sentinel canary → shape-matching regex |
| `8d52f50` | EC-21/22/23 conventions | `conventions.md` adds: (21) triplet single-source rule, (22) typed-channel emit behavioural-test mandate, (23) path-bytes redaction in log/event payloads |

### Tactical batch (1 commit — 5 P2/P3 in one go)

| Commit | Closes | Headline |
|---|---|---|
| `e69488c` | #10/#11/#13/#14/#15 | Prose alignment ("destructive" → "publish-to-others"); fail-CLOSED on non-string `toolName`; `detachWebSocket` clears `pendingControlRequests`; backtick-strip in denial message; ZW-class char stripping in denylist prefix-match |

### Architectural (2 commits — convention compliance)

| Commit | Closes | Headline |
|---|---|---|
| `d08ea96` | #9 (EC-14) | `IdleTimerProbe` exported from producer; 4 inline duplicate shapes replaced (canary caught a 4th site beyond the handoff's "3 sites" estimate); `IdleTimerManager implements IdleTimerProbe` for structural enforcement |
| `7fe8942` | #12 (EC-16) | Server-origin discriminator (`server:cron \| server:agent \| server:rest`) threaded through `injectUserMessage` → `routeBrowserMessage`; userFrameObservers skip server-driven frames; 3 callers (cron-scheduler, linear-agent-bridge, system-routes) tagged |

## What's queued (in priority order)

### Defer to dedicated maintenance window (NOT this-session-safe)

- **β catalog refactor** (`specs/council-experts-catalog.md`) — touches `/home/auracomp/.claude/skills/` which is shared global infra across 13+ projects, NOT git-versioned. Required preconditions: `git init ~/.claude/skills/` + verify no Claude pipelines mid-flight elsewhere. Memory entry: `feedback_shared_global_infra_refactor_requires_dedicated_window`.
- **α stack router** (`specs/council-command-stack-router.md`) — same shared-infra constraint; pair with β in the same window.

### Architectural work (carries server-restart risk)

- **#8 god-module split** — extract `ws-bridge-idle-watchdog.ts`, `ws-bridge-council.ts`, `ws-bridge-ai-validation.ts` from the 1733-line `ws-bridge.ts`. Pure refactor BUT: (a) any regression breaks downstream-everything, (b) production server restart kills the orchestrator running the session, can't restart-test from inside. Best done from outside the live Aura pair (e.g., a fresh terminal, no active council pipeline).

### Pre-existing P1s (investigation-heavy)

- **observer-panel-no-rest-bootstrap** — UI doesn't bootstrap findings from REST on reconnect; replays `group_created` but not `group_review`/`group_checkpoint`. Frontend React/REST work. Memory: `feedback_aura_observer_panel_no_rest_bootstrap`.
- **browser-flicker-grey-under-bus-storm** — render storm under degraded + relaunch. Frontend perf. Memory: `feedback_aura_browser_flicker_grey_under_bus_storm`.
- **dev-prod-dual-bun-port-confusion** — two bun processes on 3456 + 3457 with INSTANCE-LOCAL in-memory state. Needs server restart + careful investigation; same restart-from-inside hazard. Memory: `feedback_aura_dev_prod_dual_bun_port_confusion`.

### Other open work

- **Bug C rapesha Connection timeout** — diagnosed partially in a prior session; specific to the `rapesha` workspace (not Aura Companion code). Different project.
- **PR #82 display fix** — sidebar PR display bug; needs server restart to take effect; deferred.

## Conventions floor (now includes EC-21/22/23 — do NOT re-flag)

- AP-1..AP-4 (prior)
- EC-1..EC-19 (prior)
- EC-20 — Producer↔consumer path/filename conventions live as exported constants
- **EC-21** — Documented log/event triplet fields must derive from a single source — never independent optional spreads
- **EC-22** — Typed-channel event emit paths require behavioural-assertion tests
- **EC-23** — Filesystem paths in log/event payloads MUST be `(present, depth)` pair, SHA, or sentinel — never raw bytes

## Memory entries added this session (universal)

- `feedback_provenance_features_hard_refuse_on_source_crossing` — drift WARN-only on source-class transitions = info leakage; hard-refuse + operator ack
- `feedback_shared_global_infra_refactor_requires_dedicated_window` — shared `~/.claude/skills/` etc refactors need dedicated window + git baseline

## Runtime state at handoff time

- **PR #59 OPEN** on `antonioshaman/aura-companion`, base `main`, head `chore/council-fixpass-tactical-2026-05-15`
- **Council pair** (will change after server restart):
  - orchestrator session: `2afe4c7c-ed94-4e87-bcef-1c73dfa204d9`
  - group: `grp_c00c19bdc428fd0722bc27dd63f2b3e0`
  - workspace: `/root/aura-companion`
- **Checkpoints emitted this session**: sequence 30 (review), 31 (γ fix-pass), 32 (γ defensive+lifecycle+version+canary), 33 (tactical+#9+#12)
- **Active conventions**: AP-1..AP-4, EC-1..EC-23

## How to resume

```bash
# 1. Sync local with merged PR
git checkout main && git fetch origin && git reset --hard origin/main

# 2. Read this handoff first
cat HANDOFF-next-session-2026-05-15-evening.md

# 3. Pick from queue — pre-existing P1s are the natural next-batch since
#    they're all aura-stack code and don't need server restart for the
#    investigation phase (only the fix phase might).

# 4. If continuing in council mode:
#    /council-plan-aura then /council-implement-aura then /council-review-aura
#    per item. The tactical-batch idiom (5 small items in 1 commit) is
#    available for fixes ≤5 LOC each.
```

## Session statistics

- Wallclock: ~3 hours
- Commits: 9
- Files touched: 13 production + 8 test + 3 docs (conventions.md, memory entries)
- Net LOC: +625 / −95 across production + tests
- Test rows added: +22 behavioural
- Memory entries: 2 new universal patterns
- Checkpoints: 4 emitted (30/31/32/33)

EOF