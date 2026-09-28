# Handoff — Next session (post PR #59 merge + restart, 2026-05-15 late evening)

**Branch shipped:** main at `4bf73a5` (PR #59 squash-merged 19:04:43 UTC)

## Critical runtime facts

- **Aura prod (:3456) just restarted** at the end of the prior session. PID changed; my previous council orchestrator session `2afe4c7c-ed94-4e87-bcef-1c73dfa204d9` died with the restart.
- **Aura dev (:3457)** was running `bun --watch` for 26h before restart. May or may not have auto-reloaded.
- All work from prior session is on origin's branches:
  - `main` @ `4bf73a5` — γ Bug B review fix-pass + tactical batch + EC-14/16 items (merged)
  - PR #60 — Council v2 specs (open, docs-only)
  - PR #61 — Observer REST bootstrap (open, code fix)

## Re-probe gates BEFORE doing anything

```bash
# 1. Aura prod alive?
ss -tlnp 2>/dev/null | grep ":3456"
curl -fsS http://localhost:3456/api/sessions | head -c 200

# 2. Branch state
cd /root/aura-companion
git branch --show-current && git log --oneline -3

# 3. PR #60 + #61 still mergeable?
gh pr view 60 --repo antonioshaman/aura-companion --json state,mergeable
gh pr view 61 --repo antonioshaman/aura-companion --json state,mergeable

# 4. UI smoke
# Open browser → http://localhost:3456 → check:
#   - Sidebar shows correct PRs (origin's, not upstream's) — PR #82 fix
#   - Council Mode pair creation works
```

## What's on main now (PR #59 squash)

The squash combines 16 commits — full content:

### Council Review γ (Bug B P2/P3 cleanup)
- CR-1: `observerPromptSourceLabel` dropped from EC-9 log (multi-expert convergence Hunt+Fowler+Backend)
- CR-2: double-emit `session:relaunch-failed` skipped on config errors
- CR-3: `--append-system-prompt` argv + drift WARN gated on `!resumeSessionId`
- CR-4: 5 behavioural tests for side-effect emit paths
- CR-5: SHA cross-axis pin for argv content
- CR-6: workspace-bounds containment via `realpathSync(cwd)`
- CR-7: `wrapFsError` path-bytes redaction
- CR-9: non-Error throws handled in `wrapFsError`
- CR-10: `assertExhaustiveObserverPromptSource` `never` tripwire
- CR-12: `intentionalKills` marked before relaunch SIGTERM
- CR-13: version semantics — derived bundled sentinel + quadruplet
- CR-14: EC-19 anchor + sentinel canary hardening
- CR-15: stale comment renames
- CR-16: `Error.cause` JSDoc warning on path-bytes
- CR-17: hard refusal on workspace↔bundled source crossing
- CR-18: `clampLatencyMs` split with negative-detection
- CR-19: drop Windows `\\` split branch (Linux-only)
- CR-20: drift snapshot moved pre-kill
- CR-21: tautological depth test deleted
- CR-22: generator preview comment + three-gate rewording

### Tactical batch (5 small P2/P3)
- #10 prose alignment: "destructive" → "publish-to-others"
- #11 fail-CLOSED on non-string `toolName`
- #13 `detachWebSocket` clears `pendingControlRequests`
- #14 backtick-strip in denial message
- #15 ZW-class char defence in denylist

### Architectural
- #9 `IdleTimerProbe` exported (EC-14, 4 inline shapes deduped)
- #12 server-origin discriminator threaded through `injectUserMessage` (EC-16)

### Conventions adopted
- EC-21: triplet single-source rule
- EC-22: typed-channel emit behavioural-test mandate
- EC-23: filesystem paths in logs MUST be redacted

## Queue for next session

### Land-soon PRs
1. **PR #61 — REST bootstrap for ObserverPanel** — pure frontend fix; can merge after smoke test confirms PR #82 sidebar visualization works on prod.
2. **PR #60 — Council v2 specs** — docs only, no risk; merge whenever.

### Restart-blocked (gate 1)
- ✅ PR #82 visualisation — now resolved by PR #59 merge + restart (verify in smoke test)
- **#8 god-module split** — `web/server/ws-bridge.ts` (1733 lines → 3 files). Refactor; needs supervised. Fresh session.
- **dev-prod-dual-bun-port-confusion** — `:3456` + `:3457` with INSTANCE-LOCAL in-memory state. Investigation requires supervised kill+observe.

### Investigation-heavy
- **browser-flicker-grey-under-bus-storm** — memory says "Pending DevTools confirmation needed". Open browser + reproduce + capture React error class.
- **Bug C — rapesha Connection timeout** — DIFFERENT WORKSPACE (`/root/rapesha`), not Aura code. Separate session.

### Architectural (deferred to dedicated maintenance window)
- **β catalog refactor** (`~/.claude/skills/_council-experts/`) — DONE in prior session (committed to `~/.claude/skills/.git`)
- **Council v2** (catalog v2 + bidirectional pipeline) — specs in PR #60; implementation deferred to dedicated window per v2 isolation pattern

## Memory entries added this session (5 universal patterns)

1. `feedback_provenance_features_hard_refuse_on_source_crossing`
2. `feedback_shared_global_infra_refactor_requires_dedicated_window`
3. `feedback_macos_tmpdir_realpath_divergence`
4. `feedback_recursive_self_modification_needs_versioned_isolation`
5. `feedback_cherry_pick_oss_agent_framework_patterns`

Plus: re-confirmed `feedback_user_language_russian` with strict header-also-Russian update.

## Conventions floor

AP-1..AP-4 + EC-1..EC-24 (see `conventions.md`)

## Specs ready

- `specs/council-experts-catalog.md` — β catalog spec (prior session, untracked)
- `specs/council-command-stack-router.md` — α stack router spec (prior session, untracked)
- `specs/council-experts-catalog-v2-expansion.md` — v2 catalog (PR #60, committed)
- `specs/council-mode-bidirectional-pipeline.md` — v2 pipeline (PR #60, committed)

## Skills baseline

- `~/.claude/skills/.git` initialised (β catalog refactor landed, 17 expert IDs, 44 byte-identical phase files, 5 canaries C1-C5)
- All Council Mode dispatcher skills updated with `### Council panel` sections + experts list
- 17 unique IDs: hunt, fowler, beck, willison, saarinen, friedman, brandur (cross-stack); backend-ts, persistence-fs, realtime-ndjson, subprocess, frontend-react, a11y, deploy-docker-gha (Aura); telegram-ux, backend-python, brandur, deploy-vps (Python)

## Session stats

- 17 commits total across the day (14 in PR #59 + 1 spec PR + 1 frontend fix + 1 catalog refactor in skills repo)
- 3 PRs (#59 merged, #60 + #61 open)
- 5 universal memory entries
- 4 new conventions (EC-21/22/23 + EC-24)
- 2 product-tier specs (~9500 words combined)
- Catalog refactor: 6 SKILL.md from 3177 → 2271 lines (−29%)

EOF
