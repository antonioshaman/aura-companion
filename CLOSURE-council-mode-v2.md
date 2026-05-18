# CLOSURE: Council Mode v2 development arc — PR #45 → #65

**Date:** 2026-05-18
**Scope:** Council Mode v2 (paired orchestrator + observer sessions + bidirectional pipeline + v2 expert catalog enrichment).
**Status:** Implementation arc CLOSED. A/B competitive acceptance test PASSED across 4 specs (per PR #65). Phase 3β scope captured (this branch) but deferred to a separate writer-tmux session.

This manifest is **documentation only** — it consolidates work already merged through `main`. The bootstrap-bug captured in `BUG-council-mode-group-rest-bootstrap-gap.md` is part of Phase 3β scope and is **not** fixed by this PR.

---

## Authorship discipline

All implementation work landed via dedicated writer-tmux sessions external to the running Aura Companion CLI, per EC-30/EC-31. The CLI session authoring this manifest acts as **orchestrator + consolidator**, not as a writer of executable code — Aura Companion editing itself live would race the WS bridge it relies on.

Convention floor reference: `feedback_process_ancestry_check_before_parent_restart` (memory) + EC-31 (writer-tmux + reader-validator pipeline).

---

## Arc summary — chronological merge order

### Auto-proceed pipeline (Tasks 5 → 11)

| PR | Commit | Subject | Scope |
|---|---|---|---|
| #44 | `d2f59be` | suppress pair-chip half that duplicates backend indicator | UI polish, pre-pipeline |
| #45 | `d913166` | auto-proceed foundation — envelope contract + ClockSource DI + orchestrator turn-state | Task 5 |
| #46 | `6f0a124` | auto-proceed persistence helpers — state path wrapper + trace JSON + AFK summary | Task 6 |
| #47 | `1fb19d1` | idle-timer-manager DI module | Task 7 |
| #48 | `172619c` | auto-proceed state-machine integration + boot reconcile | Tasks 8 + 9 |
| #49 | `bd092f0` | auto-proceed boundary validator + observer-poll failsafe | Task 10 |
| #50 | `df38e7f` | archive pair routes through coordinator.archiveGroup | EC-2 hardening |
| #51 | `904afff` | auto-proceed Task 11 foundation — recorder origin, sticky token, denylist module | Task 11.1-11.2 |
| #53 | `2c9cb93` | emit half_respawned for post-grace pair recovery | reconnect path |
| #54 | `3dee080` | auto-proceed Task 11 wire-up — 11.6 + 11.7 + 11.8 integration | Task 11 close |

### Defensive hardening + review fix-passes

| PR | Commit | Subject | Source |
|---|---|---|---|
| #55 | `e9e22ca` | defensive hardening (5 P1 fixes) | review `2026-05-15-0336` |
| #56 | `fcbc784` | behavioural tests backfill (CR-7 + CR-6) | review `2026-05-15-0336` |
| #57 | `38dfdb1` | exhaustive `BridgeObserverWakeOutcome` switch + never tripwire | CR-4, EC-15 |
| #58 | `36c3fc8` | archive review-output + fix #6 table mismatch | OBS-WARN-3 |
| #59 | `4bf73a5` | γ review fix-pass + tactical batch | EC-14, EC-16 |
| #61 | `f2d4b7a` | REST bootstrap for ObserverPanel findings on browser reload | covers `feedback_aura_observer_panel_no_rest_bootstrap` |

### v2 catalog architecture + enrichment

| PR | Commit | Subject |
|---|---|---|
| #60 | `613328e` | council v2 architecture specs — catalog expansion + bidirectional pipeline |
| #65 | `d2324e9` | Phase 3α + 3α' — v2 catalog enrichment + 4-spec A/B acceptance test |

### Reverts captured for archaeology

| PR | Commit | Reverts | Reason |
|---|---|---|---|
| #42 | `7766e5e` | #41 Claude MAX 20x tier verification | vendor has no endpoint via CLI OAuth scope |
| #43 | `9b95542` | #33 + #36 Codex observer auto-wake + model coercion | wake-turn does not survive auto-relaunch race |

---

## Phase 3α arc — atomic-commit ledger (skills repo, mirrored into aura-companion via #65)

14 of 14 atomic commits, one per expert, two-process validator pipeline (writer-tmux + reader-validator at `/tmp/<phase>-<step>-validator-brief.md`):

| # | Sub-phase | Expert | Skills-repo SHA | Strategy |
|---|---|---|---|---|
| 1-3 | 3α₁ | dahl, ritchie, hashimoto | `2ab3547`, `3adfb81`, `dc15978` | append-existing |
| 4-7 | 3α₂-A | fowler, beck, hunt, willison | `ada5eed`, `5912d0a`, `21626ec`, `f99a228` | seed-new (domain-neutral) |
| 8-11 | 3α₂-B | saarinen, friedman, watson, abramov | `4fc400a`, `24a99aa`, `5434381`, `d9490f8` | seed-new (UI cluster — aura-only mirror set for watson + abramov) |
| 12-14 | 3α₂-C | brandur, durov, vanrossum | `9f87d24`, `83e7ddd`, `7529345` | seed-new (language/platform cluster — non-aura mirror set) |

**Cumulative gate state at close:** C1-C12 verify-catalog + cp-mirrors --check green throughout all 14 commits, zero failures. Lock manifest grew from 0 to 11 canonical entries (+34 mirror paths). Coverage-tokens YAML grew from 46 to 142 tokens (+96), structural anchors 5 → 29 (+24).

Aura-companion side merged through PR #65 carries: 5 closure HANDOFFs (sub-1 / sub-2A-mid / sub-2A / sub-2B / FINAL 3α + 3α'), 4-spec A/B test artifacts (`abtest-{composer-permission,bidir,docs,router}-{v1,v2}-{plan,review}.md` plus envelope-mapping + judge-decision per spec), conventions EC-30..EC-33.

---

## A/B competitive acceptance test (per closure handoff directive)

Test subjects (4 specs):
- `specs/composer-permission-mode-toggle.md`
- `specs/council-bidirectional-pipeline.md` (or sibling bidir spec)
- `specs/council-experts-catalog.md`
- `specs/council-command-stack-router.md`

Pipeline per spec (Steps 1-5 of the directive):
1. Two worktrees (one per side, isolated)
2. Side A: `/council-plan-aura` + `/council-implement-aura` + `/council-review-aura` (v1)
3. Side B: `/council-plan-aura-v2` + `/council-implement-aura-v2` + `/council-review-aura-v2` (v2)
4. Hybrid judge: (a) Aura observer pipeline reviews on each output set, (b) independent blind judge Claude session, envelope X/Y → v1/v2 unsealed AFTER decision
5. Operator review + decision

Artifacts on disk under `/tmp/abtest{,2,3,4}-*` + `.council/abtest/v{1,2}-{spec}-{plan,review}.md` (merged through PR #65).

**Outcome:** v2 declared winner across all 4 specs. Phase 3α officially accepted. Phase 3β scope unlocked.

---

## Conventions codified during the arc

`conventions.md` additions (merged via #65):

- **EC-30** Council Mode phases ≤100k working tokens; mandatory HANDOFF + sub-phase split when scope exceeds.
- **EC-31** Multi-commit phases require writer-tmux + reader-validator pipeline; bridge via `/tmp/<phase>-NX-validator-brief.md`. Single-process loops forbidden.
- **EC-32** Every phase MUST end with `HANDOFF-phase-X-after-NY.md` capturing `commits[]`, `decisions[]`, `inherited_corrections[]`, `next_phase_scope`. Next phase starts from HANDOFF + auto-memory, never from previous Claude session memory.
- **EC-33** Skill-restart locality: pickup-prompt is transient; PLAN + HANDOFF are durable. On disagreement, runtime probe over pickup.

Candidate slots reserved for Phase 3β planning (one of two promotes to EC-34):
- **Tension-pair codification** — bidirectional pipeline cycle counter as authoritative state on convergence.
- **NR8 — D7 shell-paste discipline** — 7-commit zero-drift threshold across N3.08..N3.14 met; promotion to convention floor at Phase 3β planning.

---

## Asymmetric mirror-set shapes covered (4 of 4)

D4 originated at N3.05 (beck, review-only shape). Phase 3α completed coverage of every derivable shape:

| Shape | Experts | Count | Files per mirror |
|---|---|---|---|
| full-panel | dahl, ritchie, hashimoto, fowler, hunt, willison, saarinen, friedman | 8 | plan-v2 + review-v2 + plan-aura + review-aura |
| review-only | beck | 1 | review-v2 + review-aura |
| aura-only | watson, abramov | 2 | plan-aura + review-aura |
| non-aura | brandur, durov, vanrossum | 3 | plan-v2 + review-v2 |

The shape per expert is a *runtime-mechanical determinant* — derived from on-disk panel-file intersection, NOT from PLAN expectation. D8 runtime probe is the canonical check.

---

## Outstanding scope captured for Phase 3β

This branch ships ONE bug document (`BUG-council-mode-group-rest-bootstrap-gap.md`) as the first Phase 3β scope item. It is NOT fixed in this PR per the self-modification discipline (the running CLI is the system being edited).

### Bug capture: REST-bootstrap gap

- **Symptom:** Council Mode pair sessions in Sidebar show no ☼/☽ glyph + " · orchestrator"/" · observer" suffix after browser reload, despite `ec93eab` shipped.
- **Root cause:** `group:created` is the only source of group records in the browser store; no REST path to recover them on reload.
- **Fix shape (3 paths):** Path A (enrich `/api/sessions`), Path B (new `GET /api/groups` endpoint), Path C (server-side WS-replay on reconnect). Operator picked Path B for the Phase 3β writer-tmux pickup.
- **Sibling P0:** `BUG-council-mode-spawn-failure-resume-empty-state.md` (already merged via #65) — observer `cliSessionId=null` on `--print` mode. Fix-together candidate in a single Phase 3β hotfix sprint.

### Phase 3β scope preview (per dump #2 in `specs/external-knowledge-enrichment-sources.md` §G)

8 expert candidates queued for Phase 3β catalog expansion: Lerdorf, Colvin, torvalds, unclebob, evans, hickey, majors, sridharan. Estimated ~22 commits (each new expert ≈ 3-5 commits for full dir + meta.yaml + plan/review prompts + `references/quality-<id>.md` authored from scratch). Plus the bootstrap-fix hotfix sprint above.

### Skill-protocol invocation policy (operator decision 2026-05-18, codified as dec-010)

Council-skill dispatch (`/council-plan-aura-v2`, `/council-implement-aura-v2`, `/council-review-aura-v2`) invocation is **scope-thresholded** — not blanket-applied to every PR:

- **PR #68 (bootstrap-fix hotfix, ~4 commits, single subsystem)**: mono writer-tmux + single-reviewer validator-tmux, NO `/council-plan` upfront — BUT mandatory `/council-review-aura-v2` on the final branch BEFORE `gh pr create` (hybrid mode C). Catches multi-expert lens at the PR boundary without planning overhead.
- **Phase 3β catalog expansion (8 expert candidates, ~22 commits, multiple cross-cutting subsystems)**: **mandatory full council protocol from the start** — `/council-plan-aura-v2` for sequenced plan + per-task `/council-implement-aura-v2` + `/council-review-aura-v2` before each PR.
- **General threshold** (memory: `feedback_skill_protocol_scope_threshold`): <5 commits=mono, 5-15=hybrid (mono impl + council-review pre-push), ≥15 or catalog seats=full council.

Writer pickup-prompts for hybrid/full-council scopes MUST embed the council-dispatch invocation explicitly — otherwise mono finishes and pushes without engaging the council lens.

---

## Phase 3α — IMPLEMENTATION CLOSED ✓

- 14 of 14 atomic commits landed (skills repo HEAD `7529345`)
- 5 closure HANDOFFs committed (aura-companion `d2324e9`)
- A/B competitive test passed v2 across 4 specs
- C1-C12 + cp-mirrors --check green throughout
- 7-consecutive D7 zero-drift on N3.08..N3.14 (threshold for NR8 promotion met)
- 4 of 4 derivable mirror-set shapes covered
- 5 writer sessions × ~85-125k each (within 1M-window per session, EC-30 boundary respected)

### Sign-off

- Implementation: writer-tmux × 5 sessions (Claude Code), all 14 validator briefs PASSed
- Validation: reader-validator parallel sessions, 14 PASS reports, 7 consecutive zero-drift on D7-codified arc
- Acceptance: hybrid judge (Aura observer + blind judge) v2 winner × 4 specs
- Operator decision: Phase 3α accepted; Phase 3β approved; bootstrap-fix + observer-wake-deadlock first scope items

### What this PR closes

- Documentation of the entire Council Mode v2 implementation arc
- First Phase 3β scope items captured as bug-docs (this branch already carries `BUG-council-mode-group-rest-bootstrap-gap.md`)
- `.agents/knowledge/` extracted learnings from Phase 3α₂-C (D8, NR8, mirror-shape coverage)

### What this PR does NOT close

- The bootstrap-fix code change itself — that work runs in a separate Phase 3β writer-tmux against a fresh branch
- Phase 3β expert-catalog expansion (8 candidates) — fresh writer session reads Phase 3α FINAL CLOSURE + dump #2 + Section F tension-pair principle

---

## Cross-reference

- Phase 3α FINAL CLOSURE handoff: `HANDOFF-phase-3-α-CLOSURE.md` (merged via #65, full 14-commit arc + cumulative D1-D8 + NR1-NR9 + sign-off)
- Phase 3α directive: `/tmp/phase-3-α-closure-handoff-directive.md` (transient — A/B test acceptance gate spec)
- Sibling P0: `BUG-council-mode-spawn-failure-resume-empty-state.md` (merged via #65)
- This PR's first scope item: `BUG-council-mode-group-rest-bootstrap-gap.md` (this branch)
