# DIET-AB — pre-diet vs post-diet control files (harness; results pending)

Direct measurement of the diet: same task, same code, same Aura variant; only
the agent's standing context differs. Decision of 2026-09-29 (replaces
A3-recheck). This file describes the harness; the results section is filled
by the run step.

## What is swapped

`web/evals/aurabench/harness/diet-overlay.ts` removes every owned path from the
sealed task checkout and writes the chosen version instead. Task code is not
touched. The overlay is committed before `bun install` and the agent, so it
never counts toward the agent's diff.

| Owned path | before (`74a539d`, main at diet start) | after (`diet/main`, pinned sha) |
|---|---|---|
| `CLAUDE.md` (+ `AGENTS.md` symlink) | 33 262 B | 9 263 B + `docs/architecture/*`, `docs/conventions/*` |
| `.council/prompts/observer-system.md` | 13 865 B | 4 262 B |
| `.agents/knowledge` | KB as of 74a539d | KB as of diet/main |
| `.agents/skills`, `.claude/skills`, `skills-lock.json` | incl. `self-improvement` | without it |
| `.learnings/` | prod copy (from the A1 archive `docs/history/learnings/`) | absent |
| `SELF-LEARNING.md` | as of 74a539d | as of diet/main |

Byte counts are from a smoke run on task `archived-session-cli-survives-restart`.

The Aura instance reads the observer prompt from the workspace, so the overlay
also switches the observer prompt. The pre-diet prompt writes the old review
format, which the server still parses (B1 transition).

## Guards

- **Leak.** The overlay commits are later than every task's merge commit, so
  they contain the reference fix. Files are exported with `git archive` in the
  main repo and unpacked with `tar`. No object from those commits enters the
  cell; a test checks this with `git cat-file -e`.
- **One overlay per bench root.** The cell key does not include the overlay.
  The runner refuses to start (exit 2) if `results/cells.jsonl` holds a record
  with a different overlay, or no overlay.
- **Aura variants only.** `--diet-overlay` combined with A/B returns exit 2; a
  naked cell with an overlay becomes a `harness_error`.
- **Pinned refs.** `after` is resolved to a full sha at start
  (`--diet-after-ref`, default `diet/main`). A moved `diet/main` trips the reuse
  guard; pass the sha to keep going.

## Recorded per cell

- `diet_overlay`: `{version, ref, learnings_ref?, files, claude_md_bytes, observer_prompt_bytes}`.
- `metrics.context_first_call`: prompt tokens of the orchestrator's first
  model call (input + cache read + cache write), i.e. the standing-context
  size. Claude only; observer calls are excluded.
- Confounds on every overlay cell: the overlay postdates the task (KB entries
  may describe the fix, on both sides). On `before` cells also: the
  user-level self-improvement `UserPromptSubmit` hook (in the real
  `~/.claude/settings.json`) is not reproduced.

## Run (after D2-full stage 1; same USAGE-CEILING gate)

10 tasks (mix of easy/medium/hard, chosen from stage-1 results) × C, D, H × {before, after} = 60 cells, 1 rep:

```bash
cd web && env $(env | grep -oE '^AURA_[A-Z_]+' | sed 's/^/-u /') NODE_OPTIONS=--max-old-space-size=2560 \
  bun run eval:aurabench bench --bench-root /home/auracomp/aura-diet/bench/diet-ab/before \
  --diet-overlay before --diet-after-ref <diet/main sha> --variants C,D,H --reps 1 --task-ids <10 ids> \
  --timeout-min 60 --timeout-min-class architecture=120 --wt-root /home/auracomp/aura-diet/wt-cells
# the same with --bench-root …/diet-ab/after --diet-overlay after
```
