# Phase 3α' CLOSURE HANDOFF — A/B competitive acceptance test

**Date:** 2026-05-17
**Branch:** `feat/council-v2-pipeline` HEAD `5501015`
**Scope:** 4-spec blind-judge A/B acceptance test of v2 (enriched) vs v1 (legacy) council pipelines

---

## TL;DR

**4 specs tested. v1 marginal lead: cumulative 93.0 / v2 90.5 across 4 / 24 axes (net v1 +2.5 across 4 specs).**

| Spec | v1 | v2 | Net | Winner | Judge decision |
|---|---|---|---|---|---|
| #1 composer-permission-mode-toggle | 26.0 | 23.0 | v1 +3 | v1 | `/tmp/abtest-judge-decision.md` |
| #2 council-command-stack-router | 21.0 | 23.0 | v2 +2 | TIE | `/tmp/abtest2-judge-decision.md` |
| #3 council-mode-bidirectional-pipeline | 23.0 | 22.5 | v1 +0.5 | TIE | `/tmp/abtest3-judge-decision.md` |
| #4 aura-documentation-rebrand | 23.0 | 22.0 | v1 +1 | TIE | `/tmp/abtest4-judge-decision.md` |
| **TOTAL** | **93.0** | **90.5** | **v1 +2.5** | — | — |

**Acceptance verdict (per `/tmp/phase-3-α-closure-handoff-directive.md`):** Phase 3α STRUCTURALLY COMPLETE but **SEMANTICALLY INCONCLUSIVE**. v2 enrichment did NOT produce decisive value lift over v1 across 4 diverse specs.

---

## Pipeline trade-off pattern (consistent across all 4 specs)

The judge confirmed the same structural pattern in every test:

**v1 (legacy) systematically wins on:**
- Axis 2 — multi-lens depth (more experts dispatched, broader catalog coverage)
- Axis 3 — risk surfacing (deeper architectural defect-finding)
- Axis 4 — false positive rate (tighter findings)

**v2 (patched) systematically wins on:**
- Axis 1 — spec coverage (AC discipline; v1 got axis-1 CAPPED at 1 in specs #3 and #4 for outright AC failures)
- Axis 6 — implementation quality (wired end-to-end, Carmack-economic scope)

**Net:** v1's depth-wins outpace v2's discipline-wins by ~0.6 points per spec on average. v2 patches helped move from "lose by 3" (spec #1) to "lose by 0.5–1" (specs #3, #4) — measurable improvement, but not decisive.

---

## v2 skill patches applied during the arc (Phase 3α' refactor)

After spec #1 loss, 7 patches landed in v2 skills:

1. **Plan: Spec AC verbatim block** (`council-plan-aura-v2/SKILL.md`) — extract Gherkin/MUST sentences verbatim into the brief; production-vs-DEV qualifiers preserved.
2. **Plan: Carmack-economic dispatch sizing** (replace "dispatch all 13" default with LOC tiers: ≤100 LOC → ≤5 experts, 100-500 → ≤8, >500 → 10+).
3. **Implement: AC qualifier preservation check** — each Gherkin qualifier must survive the implementation.
4. **Implement: Phase 3.5 Plan-Diff Reconciliation Gate** — each planned task must have grep-evidence in diff, or be marked `STATUS: DROPPED`.
5. **Review: Phase 5.5 P1 Self-Block Gate** — self-introduced P1 findings halt the review with explicit fix/accept/defer prompt.
6. **Review: Overlap precedence table compression** — 11-paragraph rule corpus → 10-row table.
7. **Review: Phase 7 Convention Update collapse** — skip-if-no-signal default + max-3-candidates cap.

After spec #3 TIE, 1 additional patch:

8. **Review: Cross-Cut Verification step** (added to Phase 4 synthesis) — for each invariant the diff DECLARES (regex pattern, type contract, function purity, atomic operation), grep production code for the CONSUMER(s) of that invariant. Catches the cross-module contract violations v1 surfaces and v2 historically missed.

**Effect measured:** patches moved v2 from -3 (spec #1) to -0.5..+2 band (specs #2-4). Cross-Cut Verification step (patch #8) did not produce visible additional lift between spec #3 and #4 — both remained in TIE band.

---

## What got merged to feat per spec

Per operator's plan "чтобы работа не была напрасна — apply work to prod":

- **Spec #1 (v1 won):** v1 commits `4368303` plan / `4237624` impl / `0998396` review cherry-picked. v2 loser tagged `abtest/loser-v2-composer-2026-05-17`.
- **Spec #2 (TIE):** v2 winning commits `67c9986` plan / `385f8dd` impl / `f5869e8` review cherry-picked + `d3c8512` surgical patches (Ask-First conflict gate + `/council-plan-python` dead-reference fix).
- **Spec #3 (TIE):** v2 commits `c30301b..c59eccd` cherry-picked (winning side per judge's axis-6 win) + `TASK-bidir-followups.md` captures v1's 3 verified P1 defects for next iteration.
- **Spec #4 (TIE):** v1 commits `e198449..d6d612f` cherry-picked (depth-rich content additions) + surgical overlay (`5501015`) — v2's clean Footer/Nav + brand-canary script + EC-13/EC-32 range fix.

**4 specs of real product work landed:** composer permission mode toggle, council-command stack router, council bidirectional pipeline scaffold, documentation rebrand. **feat HEAD `5501015`.**

---

## v2 skill patches: should they ship?

**Yes.** All 8 patches measurably tightened v2's failure modes:

- Patch #2 (Carmack-economic dispatch) was the most decisive — v2 stopped burning 1.5M tokens to dispatch 13 experts on a 60-LOC fix.
- Patch #5 (Phase 5.5 P1 self-block) fired ~1 of 4 times — the trigger is conservative; when it does fire, it catches real self-acknowledged ship-blockers.
- Patches #1 + #3 (spec AC discipline) collapsed v1's axis-1 advantage on AC-strict specs to zero.

The patches are committed to `~/.claude/skills/council-{plan,implement,review}-aura-v2/SKILL.md` and active for all future Aura-Council-v2 invocations.

---

## Honest finding for Phase 3β scope

v2 is **EQUIVALENT to v1 with different failure modes**, not "an order of magnitude better" as the original Phase 3α success goal stated. The two pipelines optimise for different things:

- **v1 (legacy)** — depth-first, broad multi-lens, finds architecturally cross-cutting defects, but brittle on strict AC compliance.
- **v2 (patched)** — discipline-first, Carmack-economic scope, ships wired end-to-end, but narrower review surface misses defects outside its scope.

**For Phase 3β scope decision:**

- If the next workload is **finding load-bearing defects in existing code** (audit, hardening, refactor), v1's posture is the right tool.
- If the next workload is **shipping clean spec-bound deliveries**, v2's posture is the right tool.
- If the workload mixes both, the operator should pick per-spec, not pick a single pipeline globally.

A Phase 3β `/council-plan-aura-v3` skill could be a **third posture** — Carmack-economic AC discipline (v2's strengths) + Cross-Cut Verification mandatory (v1's strengths) + a NEW "broad-scope diff-review" mode that v2 lacks. Out of scope for this closure; flagged for Phase 3β planning.

---

## Acceptance verdict

Per `/tmp/phase-3-α-closure-handoff-directive.md`:
- v1 wins or TIE → Phase 3α structurally complete, **semantically inconclusive**
- Iterate enrichment OR scope-down Phase 3β

**Operator decision recommended:** **scope-down Phase 3β** — defer further enrichment until a third pipeline posture (above) is designed. Current v2 catalog (14 experts, 142 tokens, 29 anchors, 14 mirror sets) is functional; further enrichment without methodology change yields diminishing returns.

---

## Worktree state

```bash
git -C /root/aura-companion worktree list
```

8 worktrees still on disk from 4 A/B tests. All abtest-side branches preserved as tags for retrospective:
- `abtest/loser-v2-composer-2026-05-17`
- `abtest/tie-v1-router-2026-05-17`, `abtest/tie-v2-router-2026-05-17`
- `abtest/tie-v1-bidir-2026-05-17`, `abtest/tie-v2-bidir-2026-05-17`
- (spec #4 worktrees still uncleared — `abtest/v1-docs`, `abtest/v2-docs`)

Operator may `git worktree remove ../aura-companion-v{1,2}-test{,-2,-3,-4}` and delete branches at discretion.

---

## Sign-off

Phase 3α implementation arc (14-commit catalog enrichment) was structurally CLOSED at `83d4f48` (`HANDOFF-phase-3-α-CLOSURE.md`). Phase 3α' (4-spec A/B acceptance test + iterative v2 refinement) is CLOSED at `5501015` (this handoff).

**Phase 3α + Phase 3α' total elapsed wallclock:** ~5 days (2026-05-13 to 2026-05-17), ~10M tokens cumulative across writer + validator + 4 A/B test pairs + 4 blind judges.

**Phase 3β:** scope at operator discretion, informed by the depth-vs-discipline finding above.
