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
