# DIET-AB — pre-diet vs post-diet control files (results)

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

## Results (run finished 2026-10-01)

60/60 cells recorded, every one `completed`, 0 isolation violations, 0
harness errors. Per-cell data: [`data/diet-ab-cells.csv`](data/diet-ab-cells.csv)
(no paths, no secrets). One rep per cell: read every success delta below as
anecdotal; only token and cost deltas are backed by paired intervals.

### H is not valid: the Codex observer never ran

In all 20 H cells (both sides) the Codex observer's first turn failed with
HTTP 400 `The 'claude-opus-5-5' model is not supported when using Codex with a
ChatGPT account` (bench recordings, 20/20 Codex sessions). Council create
forwards one `model` to both halves, so the Codex half received the Claude
pin. The harness recorded this only as a confound (`codex observer ran model
claude-opus-5-5`) and still scored the cell. H here is "Claude orchestrator +
bench directive + dead observer", not claude+codex. It is excluded from every
conclusion below. Codex token counts were also never reported, so H cost is
null in 18/20 cells. This must be fixed before BENCH-H, which runs the same
variant (STATE step `FIX-H-MODEL`).

### Standing context (orchestrator, first model call)

| Variant | before (tokens) | after (tokens) | Δ |
|---|---|---|---|
| C | 33 936 (mean) | 24 416 (mean) | −9 521 (−28.1%) |
| D | 34 423 | 24 902 | −9 522 (−27.7%) |

The drop is the same on every task (paired 95% CI [−9 526, −9 516] for C), so
it is the control files, not the task. That is ≈ 9.5 K fewer tokens loaded
on every session start.

### Cost, tokens, time (sum over the 10 tasks, paired by task)

| Variant | Metric | before | after | Δ | paired mean Δ per task, 95% bootstrap CI |
|---|---|---|---|---|---|
| C | cost, $ | 9.31 | 8.36 | −10.2% | −0.095 [−0.196, +0.008] |
| C | prompt tokens (in + cache) | 11.01 M | 9.77 M | −11.2% | −124 K [−286 K, +40 K] |
| C | wall clock, min | 77.5 | 83.4 | +7.6% | +0.59 [−0.05, +1.18] |
| D | cost, $ | 17.06 | 14.74 | −13.6% | −0.232 [−0.499, +0.027] |
| D | prompt tokens (in + cache) | 18.26 M | 16.04 M | −12.2% | −222 K [−623 K, +158 K] |
| D | wall clock, min | 90.5 | 105.1 | +16.1% | +1.46 [−0.50, +3.76] |
| C+D | cost, $ | 26.37 | 23.10 | **−12.4%** | −0.164 **[−0.312, −0.024]** |
| C+D | wall clock, min | 168.0 | 188.5 | +12.2% | +1.03 [−0.02, +2.25] |

Turns and tool calls did not move (C −3.8% / −4.7%, D −2.5% / −1.7%, CIs
span zero). Cost is the only metric whose pooled CI excludes zero. Wall clock
went up, not down, but its CI touches zero; `after` ran later in the day
(06:47–13:51 UTC vs 22:24–06:47 UTC) on a box shared with prod, and the
cell clock includes test runs, so it is not attributed to the diet.

### Quality (hidden tests)

| Variant | before solved | after solved |
|---|---|---|
| C | 8/10 | 8/10 |
| D | 9/10 | 7/10 |
| C+D | 17/20 | 15/20 |

Same 2 tasks fail for C on both sides (`codex-error-notification-shown-as-drift`,
`codex-observer-findings-dropped`). The D drop is two flips, both on tasks
that 5/6 and 3/6 variants solved in stage 1:

- `archived-sessions-hold-memory` (D after): 392/393; the hidden test's mock
  has no `wsBridge.rehydrateSessionMemory`, the method the agent called.
- `claude-adapter-outbound-queue-overflow` (D after): 102/106; the queue
  stores JSON-encoded frames where the hidden tests expect raw strings.

Both are shape mismatches with the reference implementation, not missing
behaviour, and 2 discordant pairs out of 20 is far from significant (exact
McNemar p = 0.5). One rep cannot tell a 10-point drop from noise either way.
`codex-observer-findings-dropped` fails in all 6 C/D/H cells with the same
regression (`server/observer-prompt.test.ts`) on both sides, so it is a task
property, not a diet effect.

### Verdict

- **Saves:** ≈ 9.5 K standing-context tokens per session (−28%), ≈ 12% of
  API-equivalent cost on C+D (CI excludes zero).
- **Does not save:** turns, tool calls, wall clock (no measurable change).
- **Quality:** no evidence of a regression for C (8 → 8). D lost 2 of 9 on
  shape mismatches; inconclusive at 1 rep. A3-recheck's "> 5 p.p. regression
  is a blocker" cannot be decided on 10 tasks × 1 rep: the observed D drop is
  20 p.p., but p = 0.5. Recommendation: rerun D on the two flipped tasks ×
  3 reps on both sides before D3 quotes a quality number (cheap: 12 cells).
- **H:** no data (see above).

## D rerun (human decision 2026-10-01, ASK #27)

Before D3 quotes a quality number, D is rerun on the two tasks that flipped
(`archived-sessions-hold-memory`, `claude-adapter-outbound-queue-overflow`)
× 3 reps × {before, after} = 12 cells, Claude only (D is claude+claude).

- Fresh bench roots `bench/diet-ab-rerun/{before,after}`: the 1-rep cells
  above stay untouched and are not reused, so every side has 3 new reps.
- `after` is pinned to the same `727cd5d6fcc69c4dd232b1b7bc9ef76e0adf70b2`
  as the first run, so the two runs compare the same post-diet files.
- Both ceilings 75%, `--state` omitted (D2-full counters stay as they are).

```bash
cd web && IDS=archived-sessions-hold-memory,claude-adapter-outbound-queue-overflow \
&& for v in before after; do \
  env $(env | grep -oE '^AURA_[A-Z_]+' | sed 's/^/-u /') AURABENCH_FIVE_HOUR_CEILING=75 AURABENCH_WEEKLY_CEILING=75 NODE_OPTIONS=--max-old-space-size=2560 \
  bun run eval:aurabench bench --bench-root /home/auracomp/aura-diet/bench/diet-ab-rerun/$v \
  --diet-overlay $v --diet-after-ref 727cd5d6fcc69c4dd232b1b7bc9ef76e0adf70b2 --variants D --reps 3 --task-ids $IDS \
  --timeout-min 60 --timeout-min-class architecture=120 --wt-root /home/auracomp/aura-diet/wt-cells || exit $?; done
```

Results (success per rep, cost, verdict: regression or noise) are added here
when the 12 cells are in.
