# HANDOFF: Council Mode v2 — Phase 2a complete → Phase 2b entry

## Состояние на 2026-05-16 (after N3)

- **Branch:** `feat/council-v2-pipeline` (в `/root/aura-companion`). Без новых коммитов в aura-companion — Phase 2a живёт исключительно в skills repo.
- **Skills repo HEAD:** `98c271d` (Phase 2a-N3 complete). Все git-команды от auracomp: `sudo -u auracomp git -C /home/auracomp/.claude/skills <cmd>` (или напрямую если уже auracomp; identity passes via `GIT_AUTHOR_*` / `GIT_COMMITTER_*` env vars — `git config` is OFF-LIMITS per the safety rule).
- **Archive tag (rollback target):** `council-v1-archive-20260516` (unchanged; pre-Phase-2 baseline).
- **Predecessor HANDOFF:** `/root/aura-companion/HANDOFF-phase-2-after-plan.md`.
- **Plan output:** `/tmp/phase-2-council-plan-output.md` (still valid; one empirical claim corrected — see below).

## Phase 2a complete: 3/3 commits

| Sub-phase commit | SHA | Sub-task | Lands |
|---|---|---|---|
| N1 | `5e4e831` | A (γ + person-named IDs) | 3 placeholder dirs `_council-experts-v2/{dahl,ritchie,hashimoto}/meta.yaml`; `EXPECTED_COUNT` 17→20 in verify-catalog.sh |
| N2 | `ede752b` | B (B1/B2 hybrid) | `_council-experts-v2/hashimoto/references/.gitkeep` (B2 canonical scaffold; dahl/ritchie stay B1 = no catalog-side `references/` dir) |
| N3 | `98c271d` | D (stack tags) | `_council-experts-v2/hashimoto/meta.yaml` stack `[aura]` → `[common]`; dahl + ritchie ratified `[aura]` by being unchanged |

Sub-tasks **C** (semantic-coverage canary) and **E** (deletion atomicity) intentionally deferred — C lands in Phase 2c (Task 7), E in Phase 2d (Task 10).

**Validator briefs** (writer-tmux + reader-validator pattern; one-line writer report convention per `feedback_validator_pipeline_one_line_report`):
- `/tmp/phase-2a-N1-validator-brief.md` — PASS
- `/tmp/phase-2a-N2-validator-brief.md` — PASS
- `/tmp/phase-2a-N3-validator-brief.md` — PASS with one inherited correction (next section)

verify-catalog.sh: 9/9 canaries green throughout (Phase 2a steady-state EXPECTED_COUNT = 20).

## Inherited correction surface (validator catch 2026-05-16 evening)

**Council plan + Phase 2a-N2/N3 commit bodies + plan-validation BOTH missed this.**

The Phase 2 council plan + N2 + N3 commit bodies assume **hashimoto cross-stack = 6 dispatcher seats** (3 Aura + 3 non-aura). Empirical reality on skills repo HEAD `98c271d`:

```
$ grep -nE "(deploy-docker-gha|deploy-vps)" /home/auracomp/.claude/skills/council-*-v2/SKILL.md
council-plan-aura-v2/SKILL.md:164:- deploy-docker-gha
council-plan-v2/SKILL.md:158:- deploy-vps
council-review-aura-v2/SKILL.md:226:- deploy-docker-gha (Docker + GitHub Actions Deploy)
council-review-v2/SKILL.md:216:- deploy-vps
```

**Actual seat-count = 4 across 4 dispatchers** (plan-aura, plan, review-aura, review). **Zero seats in `council-implement-*-v2`** — Phase 1 deliberately omitted deploy-* from implement-* panels (rationale: implement panels are smaller, focused on the post-decision build step).

### Implications for Phase 2c/2d (writer of those phases MUST honour)

- **Phase 2c Task 7 (semantic-coverage canary):** no change to count; per-token whitelist counts are per-source-expert principle-count, not per-mirror.
- **Phase 2c Task 8 (supply-chain hardening):** path-allowlist regex applies to 4 mirrors, not 6. No scope change — the regex shape doesn't depend on mirror count.
- **Phase 2c Task 9 (`_ref-mirrors.lock` sha256 attestation):** `mirror-paths[]` for hashimoto carries 4 paths, not 6.
- **Phase 2d Task 10 (atomic deletion sequence):**
  - Step 2 cp-target count for hashimoto = 4 mirrors (NOT 6).
  - Step 5 panel-list cutover happens in 4 dispatchers (plan-aura, plan, review-aura, review). `council-implement-*-v2` panels stay untouched in Phase 2d.
  - **Post-cutover verification gate:** `grep hashimoto council-*-v2/SKILL.md | wc -l == 4` (NOT 6). Update Phase 2d's commit-message gate accordingly.
- **DO NOT add hashimoto to council-implement-*-v2 panels.** That's scope creep:
  - The panel-list is the SoT for seating.
  - The `[common]` tag = routing CAPABILITY, NOT a mandate to seat in every dispatcher.
  - Phase 1's decision to omit deploy-* from implement-* stands until a separate spec changes it.

### Where this affects the N2/N3 commit bodies (informational, not blocking)

- N2 commit body says "Mirror count at build time: 6 (3 Aura + 3 non-aura dispatchers each seat hashimoto by panel-list inclusion)" — **wrong**. Actual: 4 (Aura×2 plan+review + non-aura×2 plan+review). The B2 architectural decision is unchanged (hybrid B1/B2, B2 for hashimoto only) — just the cp-count claim was inflated.
- N3 commit body's verification gate `grep hashimoto council-*-v2/SKILL.md | wc -l == 6` — **wrong**, should be `== 4`.
- **No re-commit / amend needed** for N2/N3: the architectural decisions (B2 + `[common]`) hold either way (cp-count=4 still > 3 fowler-threshold for B2-warranted; `[common]` still correct as routing-capability). The wrong count is a future-implementation-detail claim, not a load-bearing rationale. Writer of Phase 2c/2d reads THIS HANDOFF for the correct count and proceeds.

### Why this slipped past validator pre-N3

- Plan output, my Phase 2 plan validation, AND the N2/N3 commit-body authoring all assumed "3 Aura + 3 non-aura = 6" without grepping the actual SKILL.md panel-lists for the seating count of deploy-* today. The assumption looked symmetric and reasonable; reality was asymmetric because Phase 1 already chose not to seat deploy-* in implement-*.
- **Validator caught it post-N3 by running the actual empirical check.** The catch is captured as a universal-applicability memory feedback (see "KB catches" section).

## Phase 2b entry — first action

**Next session:** new tmux session (e.g. `aura-v2-p2b`), new Claude instance, reads:
- THIS HANDOFF.
- `/tmp/phase-2-council-plan-output.md` (Tasks 4, 5, 6 sections).
- Original Phase 2 entry HANDOFF (`/root/aura-companion/HANDOFF-phase-2-after-plan.md`) — still useful for the broader 4-sub-phase split table.

### Phase 2b scope (3 medium commits)

| Sub-phase commit | Task | Lands |
|---|---|---|
| 2b-N1 | Task 4 — `quality-dahl.md` | Bun/Hono runtime surface + 9 NDJSON/WS protocol clusters; preserve framework-agnostic `quality-backend.md` (REWRITE Principle 9 to framework-neutral; migrate Bun-specific items into `quality-dahl.md`). Path: dispatcher-side per B1 (lives at `council-{plan-aura,review-aura,implement-aura}-v2/references/quality-dahl.md` × 3 copies; cp manually). |
| 2b-N2 | Task 5 — `quality-ritchie.md` | Two-lens partition: literal `## §A Process lifecycle` + `## §B Filesystem persistence` headers (canary asserts both present — Phase 2c Task 7). Path: dispatcher-side per B1, same 3-copy Aura cluster. |
| 2b-N3 | Task 6 — `quality-hashimoto.md` | 10 deploy-docker-gha principles verbatim (severity table P1/P2/P3 byte-for-byte to prevent silent severity downgrade) + 6 compensate-authored VPS-systemd facets, each with footnote `(compensate-authored from deploy-docker-gha perspective; deploy-vps native review pending)` per willison REC-6. Anchor each VPS facet in named memory feedback IDs (`feedback_systemctl_edit_drops_below_marker`, `feedback_service_user_vs_config_user_divergence`, `feedback_check_supervisor_before_kill`, `feedback_running_build_vs_disk_build`). Path: catalog-side per B2 at `_council-experts-v2/hashimoto/references/quality-hashimoto.md` (replacing the N2 `.gitkeep`). |

### Phase 2b verification

- After each commit: run `bash _council-experts-v2/.verify/verify-catalog.sh` — must stay green.
- After 2b-N2 (ritchie): grep for the two literal headers in the new ref:
  ```
  grep -cF '## §A Process lifecycle' _council-experts-v2/ritchie/references/quality-ritchie.md  # or dispatcher seat per B1
  grep -cF '## §B Filesystem persistence' _council-experts-v2/ritchie/references/quality-ritchie.md
  ```
  Both must return ≥1. Phase 2c canary will enforce this mechanically.
- After 2b-N3 (hashimoto): grep for the compensate-authored footnote on each VPS facet:
  ```
  grep -cF "(compensate-authored from deploy-docker-gha perspective; deploy-vps native review pending)" \
    _council-experts-v2/hashimoto/references/quality-hashimoto.md
  ```
  Must return 6 (one per VPS facet). Enforced by Phase 2c canary.
- After 2b-N3: confirm `quality-backend.md` post-Task-4 rewrite contains ZERO `Bun.serve|Hono|web/server` strings (vanrossum co-tenancy invariant — see Risks in plan output).

### Phase 2b path conventions (per B1/B2 hybrid ratified in N2)

- **dahl** (B1, cp-count=3 Aura dispatchers): canonical lives at each dispatcher seat. Author edits 3 mirrors in single PR. `feedback_skill_refs_copy_not_symlink` is the controlling pattern.
- **ritchie** (B1, cp-count=3): same.
- **hashimoto** (B2, cp-count=4 dispatchers per the inherited correction): canonical at `_council-experts-v2/hashimoto/references/quality-hashimoto.md`. Phase 2b-N3 writes canonical ONLY; cp to 4 dispatcher seats is Phase 2c Task 8 (the build runner) responsibility.

### Phase 2b deferred from Phase 1c (still pending)

Per the original HANDOFF-phase-2-after-plan.md §"Known gaps / open items":
- **Phase 1 deferred output-file refs:** 6 stale ref paths in `council-review-v2` (lines 245, 246, 376, 377) and `council-review-aura-v2` (lines 255, 392) cite OLD source IDs (`telegram-ux.md`, `backend-python.md`, `a11y.md`) post-rename. Phase 2b ref authoring is the natural landing point — fix as part of the relevant 2b-N commit when the dispatcher's `references/` is touched.
- **review-aura split id↔filename:** `frontend-react` renamed to `abramov`; filename was `react-ui.md`. Decision: rename to `abramov.md` for willison REC-4 person-named consistency. Land as part of 2b cleanup.

## Validator pipeline pattern (unchanged)

- Writer tmux: Phase 2b Claude. All artifacts → `/tmp/`. Chat report = ONE LINE per `feedback_validator_pipeline_one_line_report` ("phase 2b-NX done, brief @ /tmp/phase-2b-NX-validator-brief.md").
- Reader validator: parallel Claude session. Picks up `/tmp/` briefs, validates, PASS/FAIL with corrections.
- Multi-artifact step → `/tmp/phase-2b-artifacts.txt` index file. Chat: "phase 2b done, indexed @ /tmp/phase-2b-artifacts.txt" (only after all 3 commits if you want a single hand-off line; otherwise per-commit one-liners).
- Never inline-dump diff / brief / log / plan-output in chat.

**Validator empirical-claim discipline** (new this round — see KB catches): writer's empirical claims (counts, seat numbers, file-presence) MUST be verified by actually grepping the relevant files BEFORE landing in commit message. Validator MUST do the same independently (not trust writer's claim). The seat-count=6 miss could have been caught pre-N2 if either had grepped today's panel-lists.

## KB catches captured this round (memory propagation pending — see /self-reflect)

- **Validator-self-grep-format-variations** (NEW from N3 validation post-run):
  > "Validator empirical-claim discipline applies to validator's own grep patterns. Narrow patterns (e.g. `grep -nE 'REC-5'`) miss equivalent formats (`## RECOMMENDATION 5:`, `**REC 5:**`, etc.). Before crying fabrication on zero-match greps, try ≥2 format variations. Universal sibling of `trust-diff-not-prose` and `runtime-check-applies-symmetrically`."
  > To-promote as `feedback_validator_self_grep_format_variations.md`. UNIVERSAL — propagate to all `/home/auracomp/.claude/projects/*/memory/` dirs (and conceptually to any other-user `/root/.claude/projects/*/memory/` dirs if such exist with write access).

- **Seat-count-asymmetry-from-Phase-1-not-mirrored-in-Phase-2-plan** (NEW from this HANDOFF correction):
  > Cross-phase planning must grep the actual current state, not assume symmetry. Phase 1's deliberate omission of deploy-* from implement-* panels was load-bearing context Phase 2's brief authors and source-experts both missed. Empirical-claim gate at brief-authoring time would have caught it.
  > To-promote as `feedback_cross_phase_planning_grep_dont_assume_symmetry.md`. Project-specific (council-mode-v2-coupled) — NOT universal; keep in this project's memory only.

## Session wrap protocol

- This session: writer of Phase 2a (3 commits, 3 briefs, this HANDOFF, KB catches captured).
- Phase 2a sign-off: validator PASS on all 3 commits with one inherited correction documented above.
- Next session: writer of Phase 2b. Cadence: one sub-phase per session per HANDOFF-phase-2-after-plan.md §"4 sub-phase split".
- Skills repo `feat/council-v2-pipeline` doesn't exist — Phase 2 lives on `master` of the skills repo. aura-companion `feat/council-v2-pipeline` branch is for spec/HANDOFF documentation only (no new aura-companion commits in Phase 2a).
- This HANDOFF lives in aura-companion repo so successor session has stable read path; consider `git add HANDOFF-phase-2a-after-N3.md` in aura-companion at session end (writer judgement — separate aura-companion commit, NOT a Phase 2a deliverable).
