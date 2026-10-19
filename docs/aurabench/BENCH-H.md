# BENCH-H — Council with a Codex observer (D ↔ H)

Variant H is D with a different observer: the orchestrator is Claude (as in D),
the observer is Codex. This is how the production pair runs. Everything else
is the same as D: knowledge and observer layers on, observer loop on, no
council skills, no auto-proceed (`variants.ts`; a test asserts H ≡ D except
for id, label and pairing). So D ↔ H compares only the observer provider.

Decision of 2026-09-29; brought forward by the human on 2026-09-30, ahead of
the rest of D2-full stage 1. This file pins the sample and the launch command.
The results section is filled in by the step that closes the run.

## Prerequisite: FIX-H-MODEL

All 20 H cells in DIET-AB were invalid: council create passed the orchestrator
model (`claude-opus-5-5`) to both halves, and the Codex observer failed every
turn with HTTP 400. Fixed in PR #283 (`56edfbb`): the observer gets
`observerModel=gpt-5.5`, and a Council cell whose observer never completed a
turn is recorded as `harness_error` / `observer_dead`. A one-cell smoke
(`dedupe-assistant-avatar|H|1`) completed with 2 Codex reviews. The bench
instance runs from `diet/main` at or after `56edfbb`.

## Sample

The 16 tasks for which D2-full stage 1 already holds a D cell (all with A–F
complete). One repetition each, 16 cells.

| Task | Class | D (stage 1) |
|---|---|---|
| archived-session-cli-survives-restart | bugfix | pass |
| archived-sessions-hold-memory | bugfix | pass |
| claude-model-switch-404-strands-session | bugfix | pass |
| codex-error-notification-shown-as-drift | bugfix | fail |
| codex-model-fallback-picks-mini | bugfix | pass |
| codex-observer-findings-dropped | bugfix | pass |
| claude-adapter-outbound-queue-overflow | feature | pass |
| compaction-advisory-on-jsonl-growth | feature | pass |
| known-broken-claude-model-substitution | feature | pass |
| claude-context-usage-meter | ui | pass |
| observer-findings-oldest-first | ui | pass |
| drift-detector-misses-dead-stdio | debug | pass |
| codex-session-spawns-council-pair | debug | pass |
| claude-cli-stdio-transport | architecture | pass |
| council-watchers-die-silently | architecture | pass |
| dedupe-assistant-avatar | refactor | pass |

D solved 15 of 16, so H can show at most a loss on success; cost, time and
what the observer catches are the main readouts.

## Run

```bash
cd web && IDS=<the 16 ids above> && \
  env $(env | grep -oE '^AURA_[A-Z_]+' | sed 's/^/-u /') \
  AURABENCH_FIVE_HOUR_CEILING=75 AURABENCH_WEEKLY_CEILING=75 \
  NODE_OPTIONS=--max-old-space-size=2560 \
  bun run eval:aurabench bench --bench-root /home/auracomp/aura-diet/bench/bench-h \
    --variants H --reps 1 --task-ids $IDS \
    --timeout-min 60 --timeout-min-class architecture=120 \
    --wt-root /home/auracomp/aura-diet/wt-cells
```

- Own bench root `bench/bench-h`: D2-full cells in `bench/results/cells.jsonl`
  are not read or written. `--state` is omitted so the D2-full counters in
  STATE stay as they are (paused at 97/246).
- Same usage ceilings as DIET-AB (75% weekly, 75% five-hour), same timeouts as
  stage 1 (60 min, 120 for architecture).
- The driver runs this as `bench.active_runner_cmd`; the cell is idempotent, so
  a restart continues where it stopped.

## Checks when closing the step

- 16/16 cells recorded; no `observer_dead`; isolation violations 0.
- Each cell: `isolation.council_halves.observer.backend = codex`, model
  `gpt-5.5` (off-pin model → confound), `isolation.layer_evidence.review_providers`
  contains `codex`.
- Confound to report: D cells ran on earlier `diet/main` commits
  (2026-09-28 … 09-30); H runs on `56edfbb` or later. Task code and agent
  context are the task's historical checkout in both cases; only the Aura
  server differs.

## Results (closed 2026-10-08)

16/16 cells recorded, all `completed`. The 5 earlier `observer_dead` cells
(Codex quota, 2026-10-01) were moved to `results/observer-dead.jsonl` and
re-run. Isolation violations 0 in every cell, the real `~/.codex` unchanged in
every cell, `council_halves.observer` = `codex` / `gpt-5.5` in every cell.

**Review evidence.** The recorded `layer_evidence` shows a Codex review in
12/16 cells. The other 4 (`claude-cli-stdio-transport`,
`codex-error-notification-shown-as-drift`, `codex-model-fallback-picks-mini`,
`observer-findings-oldest-first`) show `reviews: 0`. This is a harness defect,
not a missed review. In those cells the Codex observer wrote the review file
itself and left the group out of the name (`bench-implement-codex-observer.md`),
and `readLayerEvidence` only counted names that contain the group id. The
instance log (`bench/bench-h/instance.log`) shows both checkpoints of each of
those 4 pairs reviewed (`observer.invocation.completed` plus
`observer_wrote_file`). Fixed in this step: a review file with no group id in
its name is counted for the cell's pair (one pair per cell worktree). The
recorded JSONL is left as written.

**Confound: observer model.** Session frames record `gpt-5.5` for the
observer half in every cell. The `observerModel` in the invocation log comes
from the review file, which the observer writes itself, and says `gpt-5` or
`gpt-5-codex` in 10/16 cells. Read it as the model's self-report, not as a
fallback.

### D ↔ H, same 16 tasks, 1 repetition

| Task | Class | D | H | D min | H min | D turns | H turns | H observer runs | H findings | H grounded STOP |
|---|---|---|---|---|---|---|---|---|---|---|
| archived-session-cli-survives-restart | bugfix | pass | pass | 13.6 | 12.5 | 40 | 23 | 3 | 2 | 0 |
| archived-sessions-hold-memory | bugfix | pass | pass | 9.7 | 10.2 | 44 | 28 | 2 | 1 | 0 |
| claude-adapter-outbound-queue-overflow | feature | pass | pass | 6.8 | 6.9 | 19 | 14 | 2 | 1 | 0 |
| claude-cli-stdio-transport | architecture | pass | pass | 22.1 | 18.5 | 50 | 55 | 2 | 1 | 1 |
| claude-context-usage-meter | ui | pass | pass | 5.5 | 8.1 | 20 | 15 | 2 | 1 | 0 |
| claude-model-switch-404-strands-session | bugfix | pass | pass | 13.7 | 13.6 | 34 | 22 | 3 | 1 | 0 |
| codex-error-notification-shown-as-drift | bugfix | **fail** | pass | 7.4 | 12.3 | 31 | 23 | 2 | 2 | 1 |
| codex-model-fallback-picks-mini | bugfix | pass | pass | 5.8 | 10.8 | 14 | 12 | 2 | 0 | 0 |
| codex-observer-findings-dropped | bugfix | pass | pass | 13.0 | 7.2 | 25 | 12 | 3 | 3 | 0 |
| codex-session-spawns-council-pair | debug | pass | pass | 6.4 | 6.6 | 24 | 16 | 2 | 0 | 0 |
| compaction-advisory-on-jsonl-growth | feature | pass | pass | 6.6 | 7.1 | 28 | 16 | 2 | 0 | 0 |
| council-watchers-die-silently | architecture | pass | pass | 17.5 | 12.3 | 29 | 42 | 3 | 2 | 0 |
| dedupe-assistant-avatar | refactor | pass | pass | 8.5 | 10.2 | 18 | 15 | 2 | 0 | 0 |
| drift-detector-misses-dead-stdio | debug | pass | pass | 10.4 | 11.8 | 41 | 26 | 3 | 1 | 0 |
| known-broken-claude-model-substitution | feature | pass | pass | 9.3 | 7.6 | 39 | 15 | 2 | 0 | 0 |
| observer-findings-oldest-first | ui | pass | pass | 6.4 | 13.6 | 17 | 17 | 2 | 0 | 0 |

- Success: D 15/16, H 16/16. One task, one repetition: this does not show a
  difference. `codex-error-notification-shown-as-drift` is in the stage 2
  re-run list, so H gets more repetitions there.
- Wall clock: median D 8.9 min, H 10.5 min (sum 162.7 vs 169.3).
- Turns: median D 28.5, H 16.5. Tool calls: median D 26.5,
  H 33.5. Turn and tool-call counts in H include the observer half, so they
  are not a like-for-like measure of the orchestrator's effort.
- Observer: 37 Codex runs, 15 findings, 2 grounded STOPs.
- Cost: D $27.46 API-equivalent for the 16 cells. H has no cost figure
  because the Codex half does not report one. Token counts are not
  comparable: H adds Codex input tokens, which count cached input, while
  D's `tokens_in` excludes the cache.
- Confound (pinned above): D ran on 2026-09-28…09-30 `diet/main`, H on
  2026-10-01…10-08 `diet/main` (at or after `56edfbb`).
