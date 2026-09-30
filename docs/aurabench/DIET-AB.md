# DIET-AB — pre-diet vs post-diet control files (harness ready; run launched, results pending)

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

## Run

Brought forward by the human on 2026-09-30: DIET-AB runs now, with D2-full
stage 1 paused at 96/246. Its cells stay in `bench/results/cells.jsonl`;
DIET-AB writes to its own bench roots, so nothing is overwritten.

### Task selection

The 10 tasks come from the 16 that had every variant (A–F) finished in stage 1
when D2-full was paused. "Solved" counts A–F cells with `success=true`. Minutes
and cost are the stage-1 C / D cells (on the task's historical control files).

| Tier | Task | Class | Solved A–F | C / D min | C / D $ |
|---|---|---|---|---|---|
| hard | `codex-error-notification-shown-as-drift` | bugfix | 2/6 | 4 / 7 | 0.61 / 1.33 |
| hard | `claude-adapter-outbound-queue-overflow` | feature | 3/6 | 3 / 7 | 0.66 / 1.89 |
| hard | `codex-observer-findings-dropped` | bugfix | 4/6 | 3 / 13 | 0.55 / 1.61 |
| hard | `claude-cli-stdio-transport` | architecture | 4/6 | 13 / 22 | 3.52 / 3.41 |
| medium | `archived-sessions-hold-memory` | bugfix | 5/6 | 5 / 10 | 1.09 / 2.04 |
| medium | `claude-model-switch-404-strands-session` | bugfix | 5/6 | 8 / 14 | 0.85 / 1.60 |
| medium | `council-watchers-die-silently` | architecture | 6/6 | 14 / 17 | 1.95 / 1.82 |
| easy | `claude-context-usage-meter` | ui | 6/6 | 5 / 5 | 0.71 / 1.57 |
| easy | `dedupe-assistant-avatar` | refactor | 6/6 | 7 / 8 | 0.62 / 0.96 |
| easy | `codex-session-spawns-council-pair` | debug | 6/6 | 3 / 6 | 0.43 / 1.67 |

Six of the seven classes are covered; the corpus has no `security` task.
`council-watchers-die-silently` is in the medium tier despite 6/6 because it
is the longest task in the sample. All 10 are also in the 16-task BENCH-H
sample, which runs H on the task's historical control files.

### Commands

10 tasks × C, D, H × {before, after} = 60 cells, 1 rep. `after` is pinned to
`727cd5d6fcc69c4dd232b1b7bc9ef76e0adf70b2` (diet/main at launch), so both
sides use the same post-diet files. `--state` is omitted on purpose: it would
overwrite D2-full's `cells_done`/`cells_total` in STATE. Both ceilings are 75%.

```bash
cd web && IDS=codex-error-notification-shown-as-drift,claude-adapter-outbound-queue-overflow,codex-observer-findings-dropped,claude-cli-stdio-transport,archived-sessions-hold-memory,claude-model-switch-404-strands-session,council-watchers-die-silently,claude-context-usage-meter,dedupe-assistant-avatar,codex-session-spawns-council-pair \
&& for v in before after; do \
  env $(env | grep -oE '^AURA_[A-Z_]+' | sed 's/^/-u /') AURABENCH_FIVE_HOUR_CEILING=75 AURABENCH_WEEKLY_CEILING=75 NODE_OPTIONS=--max-old-space-size=2560 \
  bun run eval:aurabench bench --bench-root /home/auracomp/aura-diet/bench/diet-ab/$v \
  --diet-overlay $v --diet-after-ref 727cd5d6fcc69c4dd232b1b7bc9ef76e0adf70b2 --variants C,D,H --reps 1 --task-ids $IDS \
  --timeout-min 60 --timeout-min-class architecture=120 --wt-root /home/auracomp/aura-diet/wt-cells || exit $?; done
```

The `before` pass runs first, and `after` starts only if `before` exits 0. The
runner is idempotent per bench root, so a rerun resumes where it stopped.
