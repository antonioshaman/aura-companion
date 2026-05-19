<!-- handoff-schema: v1 -->

# HANDOFF: Phase 3β sub-0 PLANNING CLOSURE — council PLAN synthesised + committed; sub-1 writer-tmux ready

**Status:** ✅ Phase 3β planning phase CLOSED. PLAN + 5 expert subplans landed via `/council-plan-aura-v2` dispatch (5-of-10 council subagents, runtime-pruned per dec-008). Next writer session picks up at sub-1: PLAN file commit anchor → `lerdorf` authoring → `colvin` authoring → sub-1 HANDOFF.

**Date:** 2026-05-18
**Worktree:** `/tmp/aura-phase3beta/` (isolated from `/root/aura-companion/`)
**Branch:** `feat/council-phase-3-beta-catalog` (tracking `origin/main`)
**Aura-companion HEAD before this commit:** `20291d7` (PR #68 merge)
**Aura-companion HEAD after this commit:** `240a24b` (sub-0 PLAN commit)
**Skills repo HEAD (runtime-canonical, unchanged this phase):** `a593c16 feat(router): Phase 0 stack detection on 3 suffixless skills`

---

## commits[]

| # | SHA | Subject | Files |
|---|---|---|---|
| 1 | `240a24b` | `docs(council): Phase 3β council PLAN — sub-0 planning closure` | 6 markdown files in `.council/plan-output/2026-05-18-phase-3-beta/` (PLAN + 5 subplans), 679 insertions |

**Net diff:** +679 / -0 lines across 6 files. No code changes. No skills-repo changes this commit. No `conventions.md` changes yet (EC-34/EC-35 amendment is sub-4 scope).

---

## decisions[] (ratified at planning gate)

### D9 — 5-expert dispatch (drop beck, per runtime probe dec-008)

Operator's PICKUP recommended 6-expert dispatch (fowler/beck/hunt/willison/ritchie/hashimoto). Runtime probe of `~/.claude/skills/_council-experts-v2/beck/` revealed review-only mirror shape (no `plan-aura.md`; only `review.md` + `review-aura.md`). Per dec-008, mirror shape is runtime-mechanical determinant; PICKUP claim was hypothesis only. Operator confirmed drop via AskUserQuestion → 5-expert dispatch landed. beck test-quality lens re-enters Phase 3β at review-time (sub-X closure council reviews), not at plan-time.

### D10 — Promote BOTH EC-34 (tension-pair, structural) AND EC-35 (D7 shell-paste, empirical), Option A

Operator confirmed via AskUserQuestion. Both candidates met their thresholds: EC-34 per spec Section F design principle; EC-35 per 7-commit zero-drift sequence N3.08..N3.14 (NR8). Sub-4 lands EC-34/EC-35 amendment as ITS OWN atomic commit per fowler recommendation 2 (two-hat discipline — separates amendment from content commits).

### D11 — Phase 7 council checkpoint emit silent-skipped (workspace mismatch)

`/api/sessions` probe returned 174 sessions; one orchestrator at cwd=`/root/aura-companion` (sid `6510e4ec`, group `grp_5f5c7a7a`, the operator's live Aura CLI session). Writer-tmux cwd = `/tmp/aura-phase3beta/` (isolated worktree). Per skill Phase 7 step 2 (zero matches on `cwd == <current workspace cwd>`) → silent skip. Operator concurred and explicitly flagged that writing to `/root/aura-companion/.council/checkpoints/` would have polluted their live ObserverPanel with a synthetic event. Skip path preserved EC-2 invariant (no cross-pair side-effects).

### D12 — Atomic-per-topic commit shape for sub-0 (PLAN + subplans together; HANDOFF separate)

PLAN file + 5 subplan files committed atomically as `240a24b` (one council-output topic). This HANDOFF lands as a SEPARATE second commit (closure-handoff topic, distinct from PLAN content per Phase 3α pattern + EC-32).

### D13 — PICKUP-phase-3-beta.md remains untracked on this branch

PICKUP file is operator-controlled (authored by in-CLI orchestrator session per its own L113). NOT part of the council PLAN's commit scope. Stays untracked. Operator may commit / amend / archive it separately if desired; writer-tmux does not author it into branch history.

---

## inherited_corrections[]

The following Phase 3α decisions/corrections are CARRIED through Phase 3β unchanged. Do NOT re-flag in any sub-phase. Validator pipeline will check for accidental drift.

### From Phase 3α CLOSURE (D1..D8 + NR1..NR9)

- **D1** Option A manual cp for new B2 entries (cp-mirrors.py TARGET_ALLOWLIST blocks new seed-new). 8 new Phase 3β experts use manual `cp canonical mirror1..mirrorN`. C12 sha256 is byte-identity gate.
- **D2 / dec-007** Path-3 hybrid depth (per-section 67-83L floor, 6 sub-paragraphs per principle including `Detection signal in code review:`). Applies to all 8 new `quality-<id>.md`.
- **D3 / NR2** Per-section scaling — 2-section commits land 134-167L; 3-section commits land 213L+. Per fowler recommendation 6: cap at 3 §-sections per ref doc; resist 4th section bloat.
- **D4** Asymmetric mirror sets (4 of 4 shapes covered Phase 3α). Phase 3β will likely add non-aura (lerdorf, colvin) and full-panel (torvalds/unclebob/evans/hickey/majors/sridharan). No new shape introduced.
- **D5** Detection-signal sub-paragraph in every principle. Applies to all 8 new ref docs.
- **D6** Memory propagation as universal-charge to writer session.
- **D7 / dec-009 / EC-35-candidate** Shell-paste discipline for numerical claims in briefs/HANDOFFs/commit bodies. NOW being promoted to convention floor as EC-35 in sub-4.
- **D8 / dec-008** Runtime panel-file probe is canonical for mirror-shape determination. PLAN's hypothesis table is HINT ONLY. Sub-phase entry must include `ls ~/.claude/skills/<panel>/agents/<id>/` after dispatcher files land (per fowler recommendation 3).
- **NR1** cp-mirrors.py TARGET_ALLOWLIST refactor REMAINS DEFERRED to Phase 3-C housekeeping. EC-34/EC-35 amendment in sub-4 should include footnote per hashimoto recommendation 4.
- **NR8** D7 → EC-35 promotion candidate (now ratified via D10 Option A).
- **NR9** Markdown line-count via Edit tool — paragraph vs sentence delta. When hitting line-count floors, decompose expansion into new paragraphs (not extending existing).

### From convention floor (AP-1..AP-14, EC-1..EC-33)

All hold unchanged. EC-30 (≤100k working tokens per session), EC-31 (writer-tmux + reader-validator pipeline), EC-32 (HANDOFF per phase), EC-33 (runtime wins on disagreement) are the load-bearing four for Phase 3β.

### From dec-010 council-skill scope threshold

Phase 3β fits "≥15 commits or catalog seats" → mandatory full council protocol from start. THIS HANDOFF closes the council-plan stage. Sub-1..sub-4 each end with `/council-review-aura-v2` before sub-PR push (PR per sub-phase per dec-010 hybrid mode C). The 5-of-10 dispatch shape from sub-0 applies symmetrically at review time (per pat-013 zero-domain-skip).

### From dec-011 Phase 3γ skill-surface unification

Out of Phase 3β scope. Captured in PLAN's "Boundaries" section. Phase 3γ writer reads Phase 3β FINAL CLOSURE + dec-011 + Phase 0 router commit `a593c16`.

---

## next_phase_scope (sub-1 writer pickup brief)

### Pickup-prompt for sub-1 writer-tmux

```
This worktree is /tmp/aura-phase3beta/ on branch feat/council-phase-3-beta-catalog.

Read in order:
1. /tmp/aura-phase3beta/HANDOFF-phase-3-β-sub-0-planning-CLOSURE.md (this file)
2. /tmp/aura-phase3beta/.council/plan-output/2026-05-18-phase-3-beta/PLAN-phase-3-β-implementation.md
3. /tmp/aura-phase3beta/.council/plan-output/2026-05-18-phase-3-beta/subplan-{fowler,hunt,willison,ritchie,hashimoto}.md
4. /tmp/aura-phase3beta/PICKUP-phase-3-beta.md (orchestrator-authored, untracked)
5. /tmp/aura-phase3beta/conventions.md
6. /root/aura-companion/HANDOFF-phase-3-α-CLOSURE.md (read-only — Phase 3α reference, do not edit)

You are the Phase 3β sub-1 writer. Your task scope is PLAN tasks 1+2:
  Task 1: lerdorf seed-new (5 atomic skills-repo commits)
  Task 2: colvin seed-new (5 atomic skills-repo commits)
  Then write HANDOFF-phase-3-β-sub-1-CLOSURE.md.

Apply cross-cutting watchpoints A+B+C+D from the PLAN at EVERY atomic commit.

EC-30 budget: ≤100k working tokens this session. Phase 3α empirics: sub-1 ran ~85-105k.

If validator-tmux is not available, self-validate per-commit with verify-catalog.sh
+ D7 shell-paste discipline. Operator decision needed (see PLAN External Setup #2).

DO NOT touch /root/aura-companion/. DO NOT run bun run dev / make dev in this
worktree (races the running orchestrator CLI on port 3457).
```

### Skills affected — restart required (per EC-33)

NONE this phase. No new skill directory created at `~/.claude/skills/` top level. (Sub-1 will create `~/.claude/skills/_council-experts-v2/lerdorf/` and `colvin/` — these are catalog data dirs under an existing skill family, not new top-level skills. The Phase 0 router skills are unchanged.)

### Validator brief shape for sub-1's first commit

Per PLAN EC-31 Validator-brief shape section. First validator brief will be `/tmp/phase-3-beta-N3.15-validator-brief.md` (numbering continues Phase 3α's N3.01..N3.14 chronology; sub-1 lerdorf opens at N3.15).

### Open external-setup items requiring operator decision

| # | Item | PLAN ref |
|---|------|---------|
| 1 | Operator confirms validator-tmux availability OR accepts self-validate-only mode for sub-1 | PLAN External Setup #2 |
| 2 | Operator confirms NO concurrent Aura CLI orchestrator session edits `~/.claude/skills/_council-experts-v2/` during Phase 3β | PLAN External Setup #3 + ritchie §A.1 serialization |

### Sub-phase budget projection (Phase 3α empirics × Phase 3β commit count)

| Sub-phase | Expected commits | Token budget |
|---|---|---|
| **sub-0 (THIS, closed)** | 2 (PLAN commit `240a24b` + this HANDOFF) | ~55k actual (this writer session) |
| **sub-1** | ~13 (lerdorf 5 + colvin 5 + 2 anchor + 1 HANDOFF) | ~95-115k expected |
| **sub-2** | ~13 (torvalds 5 + unclebob 5 + 2 axis + 1 HANDOFF) | ~100-120k expected |
| **sub-3** | ~13 (evans 5 + hickey 5 + 2 axis + 1 HANDOFF) | ~100-120k expected |
| **sub-4** | ~14 (majors 5 + sridharan 5 + 2 axis + 1 amendment + 1 FINAL) | ~110-130k expected |
| **TOTAL** | ~55 atomic commits | ~460-540k cumulative across 4-5 writer sessions |

**Cumulative envelope:** each session ≤125k (≤12.5% of 1M-window per session, well within EC-30 budget).

---

## Writer session totals (this sub-0 invocation)

| Metric | Value |
|---|---|
| Writer-tmux sessions | 1 (this) |
| Atomic commits | 2 (`240a24b` PLAN + the HANDOFF commit to follow) |
| Files added | 6 (PLAN + 5 subplans) + 1 (this HANDOFF) |
| Net diff | +679 / -0 (commit 1); +~190 / -0 (commit 2, this HANDOFF) |
| Council subagents dispatched | 5 of 10 (fowler/hunt/willison/ritchie/hashimoto) |
| Subagent token-usage (approx, from Task returns) | ~58k + 67k + 62k + 71k + 67k ≈ 325k cumulative subagent tokens (well within per-subagent 1M window) |
| Chair token-usage (approx, this writer session) | ~75-90k projected (within EC-30 ≤100k) |
| Decisions ratified | 5 (D9..D13) |
| Recommendations collected | 27 raw → 10 sequenced tasks + 4 cross-cutting watchpoints (within ≤15-task cap) |
| Validator pipeline | NOT YET invoked — sub-0 planning closure does not require EC-31 reader-validator (no skills-repo commits, no canonical artifact changes). Sub-1 first commit opens the validator-brief pipeline at `/tmp/phase-3-beta-N3.15-validator-brief.md`. |
| Carmack filter applied | Yes — all 27 raw recommendations evaluated; none rejected as scope-creep; convergent recommendations collapsed (hunt #1 + hashimoto #1 atomic-sha-256; ritchie §A.1 + hashimoto #2 serial-writer + pre-commit-gate) |
| Phase 7 council-checkpoint emit | Silent-skipped per D11 |
| EC-30 status | Green (this session well under 100k) |

---

## Sign-off

- Planning writer (this session, Claude Code under `/council-plan-aura-v2`): PLAN synthesised, 5 subplans authored, council recommendations attributed task-by-task per skill Phase 5/6.
- Council subagents (5): all returned substantive recommendations (no "no recommendations" responses); all anchored to AC1..AC9; principle citations to each expert's `quality-<id>.md` honored.
- Operator: confirmed 5-expert dispatch (D9), Option A EC-34/EC-35 dual promotion (D10), Phase 7 silent-skip alignment (D11).
- Sub-0 PLANNING CLOSURE: complete ✅

### Phase 3β progress checkpoint

- ✅ **sub-0 (planning):** PLAN + 5 subplans + this HANDOFF — landed
- ⏳ **sub-1 (lerdorf + colvin unpaired bootstrap):** awaiting next writer-tmux invocation per pickup-prompt above
- ⏳ **sub-2 (torvalds paired ritchie + unclebob paired fowler):** awaiting sub-1 closure
- ⏳ **sub-3 (evans paired fowler + hickey paired beck):** awaiting sub-2 closure
- ⏳ **sub-4 (majors paired hashimoto + sridharan paired majors + EC-34/EC-35 amendment + FINAL CLOSURE):** awaiting sub-3 closure

**~55 atomic commits across 4 sub-phases × 4-5 writer sessions projected.** Phase 3β catalog target: 22 v2 expert seats with EC-34 (structural) + EC-35 (empirical) convention-floor amendments codified.

---

**Next operator action:** review this HANDOFF + PLAN + 5 subplans; confirm sub-1 pickup-prompt scope OR request adjustments. If approved → spawn sub-1 writer-tmux on this branch with the pickup-prompt embedded above. Validator-tmux availability decision pending (External Setup #2). End of sub-0 closure.
