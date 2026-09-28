# Handoff — Next session

## Queued: /council-review-aura over Task 11 integration PR

User chose Scenario B (council-review-aura over the upcoming Task 11
wire-up integration PR) on 2026-05-15T02:15Z. **Do not dispatch the
council until the Task 11 PR exists.**

## Pre-dispatch gates (verify in order before invoking the skill)

1. **PR #53 (`fix/council-half-respawned-recovery-emit`) merged into main.**
   - Probe: `gh pr view 53 --repo antonioshaman/aura-companion --json state,mergedAt`
   - If `state != MERGED` → block. Reason: the runtime recovery emit must
     be present in main before observer-feedback loop in council-review
     workflow can fire on a freshly-spawned pair.

2. **Server restart applied.**
   - Probe: compare `systemctl show -p ActiveEnterTimestamp aura-companion.service`
     against PR #53 mergedAt — must be later.
   - If not → ask user to restart, OR proceed if user accepts skipping
     verification.

3. **Task 11 wire-up integration PR exists.**
   - Probe: `gh pr list --repo antonioshaman/aura-companion --head 'feat/auto-proceed-wire-up*' --state open`
   - If zero PRs → block. The skill needs a concrete diff to scope to.
     User's plan is HANDOFF-task11-wireup.md subsections 6, 7, 8.
   - Scope should default to `git diff main..HEAD` of that branch.

4. **Fresh active council pair available** (or skip Phase 8 of the skill).
   - Probe: `curl -s http://localhost:3456/api/sessions | python3 -c ...`
     filtering for `state=connected, sessionGroupRole=orchestrator,
     sessionGroupId set, cwd=/root/aura-companion`. Find the most recent.
   - Cross-check coordinator status via journalctl event log (`group.*`)
     — per 3-layer liveness rule: don't trust `state=connected` alone.
   - If pair status is anything other than `active`, the skill's Phase 8
     checkpoint POST will be refused. Either spawn fresh pair via UI OR
     accept that Phase 8 silently no-ops (skill still completes Phases
     0-7).

## Scope hint for the skill

Expected reduced council (~8-10 of 13 experts) based on Task 11 surface:
- Backend (Bun/Hono/TS): ws-bridge, claude-adapter, session-orchestrator
- Realtime/NDJSON Protocol: ws-bridge, claude-adapter, session-types
- Subprocess Lifecycle: session-orchestrator, claude-adapter, recorder
- Persistence: idle-timer-manager trace persistence (if touched)
- Fowler (Refactoring): god-module risk on ws-bridge.ts + claude-adapter.ts
- Willison (LLM): claude-adapter recorder origin / synthetic frame handling
- Beck (Test Quality): race-regression test, multi-tab single-firer, idle-kill split, denylist+sticky-token composition
- Possibly React/UI if Task 11 touches frontend (subsection 6 / 7 / 8 are server-side per handoff — likely zero React files in scope)

Should NOT spawn (zero domain files expected in scope):
- Hunt (Security): unlikely — Task 11 is internal lifecycle, not auth surface
- Saarinen / Friedman / a11y: server-side scope, no .tsx files expected
- Docker/GHA: unlikely unless Task 11 touches Dockerfile / workflows

## Why this is the right scope (not PR #53)

PR #53 is small (4 files, +257/-8) and already de-facto reviewed via:
- Self-review during implementation
- Observer-side independent diagnosis converging on same root cause
- Two empirical POST verifications confirming the gap
- EC-6 static-grep canary preventing regression

Task 11 wire-up will cross god-module surfaces (ws-bridge, claude-adapter)
and lifecycle invariants (sticky token, FIFO queue, idle-kill split). It's
the prototypical case for a structured multi-expert review.

## Universals propagated this session

- `feedback_state_machine_third_tier_liveness.md` propagated to 10 sibling
  project memory dirs. Aura-companion has its own project-specific version
  (`feedback_aura_council_pair_three_layer_liveness.md`).

## Active P1s open (4 prior + 1 new = 5)

1. `feedback_aura_observer_panel_no_rest_bootstrap` — REST bootstrap for findings
2. `feedback_aura_browser_flicker_grey_under_bus_storm` — render storm
3. `feedback_aura_dev_prod_dual_bun_port_confusion` — dual bun process
4. `feedback_aura_council_pair_three_layer_liveness` (also documented)
5. `feedback_aura_half_respawned_zero_emit_recovery_void` — **PR #53 closes this one**

After PR #53 merges, item 5 transitions from open to closed-in-main.

## Not in scope for next session

- Auto-dispatching /council-review-aura before gate-checks above are met.
- Merging PR #53 — user must say "merge" explicitly.
- Spawning fresh council pair — user action (UI New Session → Council toggle).
