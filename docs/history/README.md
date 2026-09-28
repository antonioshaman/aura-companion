# Process history archive

Frozen process documents. **This is history, not current rules.** Nothing here is an
active convention, plan, or contract — if a statement here conflicts with `CLAUDE.md`,
`conventions.md`, or the code, the live source wins.

Archived by step **P1/C2** of `specs/aura-meta-diet.md` so that repo-wide searches stop
surfacing closed handoffs as if they were present-tense guidance. Git history is preserved
(`git mv`); use `git log --follow <path>` to trace a document back to its original location.

## Layout

| Path | Contents | Previous location |
|---|---|---|
| `docs/history/*.md` | 30 root-level process docs: `HANDOFF-*`, `PLAN-*`, `BUG-*`, `TASK-*`, `SESSION-*`, `CLOSURE-*`, `IMPLEMENTATION-LOG-*`, `SWEEP-HANDOFF`, `CODEX-SUPERVISOR-AUTO-RESUME` | repository root |
| `docs/history/council/handoffs/` | 51 Council Mode handoff / closure documents | `.council/handoffs/` |
| `docs/history/council/review-output/` | 14 committed council review batches (per-expert findings + `FINAL-REVIEW.md`) | `.council/review-output/` |
| `docs/history/council/plan-output/` | Council plan artefacts (phase-3β sub-plans, validator briefs, commit attestations) | `.council/plan-output/` |
| `docs/history/council/implementation-logs/` | Council implementation logs | `.council/implementation-logs/` |

## What did NOT move

Runtime paths are untouched — moving them would break the server or the council skills:

- `.council/prompts/observer-system.md` — loaded at observer spawn (`web/server/observer-prompt.ts`).
- `.council/checkpoints/`, `.council/reviews/`, `.council/state/`, `.council/eval/` — live
  Council Mode filesystem protocol (written and watched at runtime).
- `.council/review-output/<TIMESTAMP>/` — still the **write target** for new `/council-review`
  batches (gitignored). Only the previously committed batches were archived here; the skills'
  output path is unchanged.
- `.council/abtest/`, `.council/IMPLEMENTATION-CONTEXT-stability-audit.md` — outside the C2 scope.

## Reference-update policy

References to the moved documents were rewritten on **live surfaces only** — source, tests,
CI workflows, `scripts/`, `specs/`, `.agents/knowledge/`, and `CLAUDE.md`. Cross-references
*inside* the archive keep their original prose: rewriting them would edit the historical
record these files exist to preserve.
