# AuraBench REPORT (D3) — interim, D2-full stage 1 at 97/246 cells

**Status: interim.** Written on 2026-10-02 while D2-full stage 1 is paused at
97/246 cells (human decision 2026-09-30: DIET-AB → BENCH-H → COUNCIL-PANEL
first) and BENCH-H waits for the Codex quota reset (2026-10-04 23:56 UTC).
Every number below can be regenerated from committed data with one command
(see [Reproduce](#reproduce)); when stage 1 and BENCH-H finish, rerun it and
replace the tables. The conclusions are written to the data as it stands:
**17 of 41 tasks, 1 rep per cell.**

Sources in this report:

| Block | Data | Cells / runs | Details |
|---|---|---|---|
| Ablation A–G (stage 1) | [`data/d2-stage1-cells.jsonl`](data/d2-stage1-cells.jsonl) | 103 (16 tasks × A–F, 6 × G, 1 A-only) | this file, R1–R3 |
| H (claude + Codex observer) | [`data/bench-h-cells.jsonl`](data/bench-h-cells.jsonl) | 10 (5 valid) | this file, §H; [BENCH-H.md](BENCH-H.md) |
| Diet before/after | [`data/diet-ab-cells.csv`](data/diet-ab-cells.csv), [`data/diet-ab-rerun-cells.csv`](data/diet-ab-rerun-cells.csv) | 60 + 12 | [DIET-AB.md](DIET-AB.md) |
| Council review panel size | [`data/council-panel/`](data/council-panel/) | 18 | [COUNCIL-PANEL.md](COUNCIL-PANEL.md) |

Variants: **A** naked Claude, **B** naked Codex, **C** Claude + knowledge,
**D** C + observer (claude+claude), **E** D + council skills + auto-proceed,
**F** Codex + knowledge, **G** Codex + council skills, **H** D with a Codex
observer. Models pinned: `claude-opus-5-5` (CLI 2.1.283), `gpt-5.5`
(codex-cli 0.142.5). A cell succeeds when the agent completes, every hidden
test passes and no zone test regresses.

## Method

- **Success** — share of successful cells, percentile bootstrap 95% CI over
  cells (10 000 resamples, fixed seed).
- **Aura Lift** — paired difference in per-task success rate against the
  naked variant of the same orchestrator provider (C/D/E/H vs A, F/G vs B),
  on the tasks both variants ran; bootstrap over tasks.
- **Cost** — API-equivalent USD from the Claude result frame. Codex reports
  no price: B/F/G cost is **unknown** (never averaged as 0). Mean tokens per
  Codex cell: B 1.56 M in (1.46 M cached) / 8.8 K out, F 1.61 M / 1.50 M / 8.2 K,
  G 1.03 M / 0.94 M / 6.6 K.
- **Wall clock E** — shown twice: full, and minus auto-proceed idle waits
  (fires × 120 s idle threshold; 15/16 E cells fired 3×). In the bench
  auto-proceed fires after the task is already done (pilot finding), so the
  net figure is the fair one for work time; cost and success are not adjusted.
- Cells with `harness_error` or isolation violations are excluded (stage 1:
  none; BENCH-H: 5, see §H). `timeout` counts as a failure (none occurred).
- Engine: `web/evals/aurabench/report.ts` (unit-tested).

## Results — all 17 tasks (stage 1, 1 rep)

### R1. Success, Aura Lift, cost by variant

| Variant | Label | Cells | Tasks | Success | 95% CI | Lift vs naked (pp) | Lift 95% CI | Paired tasks | Mean cost | Cost 95% CI | $ / success | Mean wall (min) |
|---|---|---:|---:|---:|---|---:|---|---:|---:|---|---:|---:|
| A | naked Claude | 17 | 17 | 16/17 (94%) | 82%–100% | — | — | — | $0.68 | $0.45–$1.03 | $0.73 | 5.3 |
| B | naked Codex | 16 | 16 | 12/16 (75%) | 50%–94% | — | — | — | unknown | — | unknown | 4.6 |
| C | Claude+knowledge | 16 | 16 | 15/16 (94%) | 81%–100% | +0 vs A | −19…+19 | 16 | $0.96 | $0.67–$1.38 | $1.03 | 5.8 |
| D | Claude+Observer | 16 | 16 | 15/16 (94%) | 81%–100% | +0 vs A | −19…+19 | 16 | $1.72 | $1.47–$2.01 | $1.83 | 10.2 |
| E | Claude+full Council | 16 | 16 | 13/16 (81%) | 63%–100% | −12 vs A | −37…+13 | 16 | $2.02 | $1.63–$2.49 | $2.49 | 17.7 |
| F | Codex+Aura | 16 | 16 | 13/16 (81%) | 63%–100% | +6 vs B | +0…+19 | 16 | unknown | — | unknown | 5.8 |
| G | Codex+Council | 6 | 6 | 6/6 (100%) | 100%–100% | +0 vs B | +0…+0 | 6 | unknown | — | unknown | 4.5 |

### R2. Success by class (successes / cells)

| Class | A | B | C | D | E | F | G |
|---|---:|---:|---:|---:|---:|---:|---:|
| architecture | 2/2 | 1/2 | 2/2 | 2/2 | 2/2 | 1/2 | 1/1 |
| bugfix | 5/6 | 4/6 | 5/6 | 5/6 | 4/6 | 5/6 | 1/1 |
| debug | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 | 1/1 |
| feature | 4/4 | 2/3 | 3/3 | 3/3 | 2/3 | 2/3 | 1/1 |
| refactor | 1/1 | 1/1 | 1/1 | 1/1 | 1/1 | 1/1 | 1/1 |
| ui | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 | 1/1 |

### R3. Layer ladder A→C→D→E (16 tasks with all four rungs)

| Rung | Adds | Success | Δ success vs previous (pp, 95% CI) | Mean cost | Δ cost vs previous (95% CI) | Wall (min) | Wall excl. auto-proceed waits (min) |
|---|---|---:|---|---:|---|---:|---:|
| A | naked Claude | 15/16 | — | $0.68 | — | 4.9 | 4.9 |
| C | + knowledge | 15/16 | +0 (−19…+19) | $0.96 | +$0.29 (+$0.21…+$0.37) | 5.8 | 5.8 |
| D | + observer (claude+claude) | 15/16 | +0 (+0…+0) | $1.72 | +$0.75 (+$0.54…+$0.94) | 10.2 | 10.2 |
| E | + council skills + auto-proceed | 13/16 | −12 (−37…+13) | $2.02 | +$0.31 (+$0.03…+$0.69) | 17.7 | 12.0 |


## Sensitivity — without `codex-observer-findings-dropped` (harness artefact)

On `codex-observer-findings-dropped` A and B pass every hidden test but
"regress" `server/observer-prompt.test.ts`. That test (line 176) reads
`.council/prompts/observer-system.md` from the repo root, and the naked
scrub deletes `.council/` from the worktree. Aura variants keep the file, so
they pass. The same test fails for C/D in DIET-AB, where the overlay swaps
the prompt. The task therefore measures which control files are present, not
the agent. It is the only task where any Aura variant beats A. Without it:

### R1s. Success, Aura Lift, cost by variant

| Variant | Label | Cells | Tasks | Success | 95% CI | Lift vs naked (pp) | Lift 95% CI | Paired tasks | Mean cost | Cost 95% CI | $ / success | Mean wall (min) |
|---|---|---:|---:|---:|---|---:|---|---:|---:|---|---:|---:|
| A | naked Claude | 16 | 16 | 16/16 (100%) | 100%–100% | — | — | — | $0.70 | $0.45–$1.06 | $0.70 | 5.4 |
| B | naked Codex | 15 | 15 | 12/15 (80%) | 60%–100% | — | — | — | unknown | — | unknown | 4.8 |
| C | Claude+knowledge | 15 | 15 | 14/15 (93%) | 80%–100% | −7 vs A | −20…+0 | 15 | $0.99 | $0.68–$1.44 | $1.06 | 6.0 |
| D | Claude+Observer | 15 | 15 | 14/15 (93%) | 80%–100% | −7 vs A | −20…+0 | 15 | $1.72 | $1.46–$2.03 | $1.85 | 10.0 |
| E | Claude+full Council | 15 | 15 | 12/15 (80%) | 60%–100% | −20 vs A | −40…+0 | 15 | $2.05 | $1.63–$2.55 | $2.56 | 17.3 |
| F | Codex+Aura | 15 | 15 | 12/15 (80%) | 60%–100% | +0 vs B | +0…+0 | 15 | unknown | — | unknown | 5.9 |
| G | Codex+Council | 6 | 6 | 6/6 (100%) | 100%–100% | +0 vs B | +0…+0 | 6 | unknown | — | unknown | 4.5 |

### R2s. Success by class (successes / cells)

| Class | A | B | C | D | E | F | G |
|---|---:|---:|---:|---:|---:|---:|---:|
| architecture | 2/2 | 1/2 | 2/2 | 2/2 | 2/2 | 1/2 | 1/1 |
| bugfix | 5/5 | 4/5 | 4/5 | 4/5 | 3/5 | 4/5 | 1/1 |
| debug | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 | 1/1 |
| feature | 4/4 | 2/3 | 3/3 | 3/3 | 2/3 | 2/3 | 1/1 |
| refactor | 1/1 | 1/1 | 1/1 | 1/1 | 1/1 | 1/1 | 1/1 |
| ui | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 | 1/1 |

### R3s. Layer ladder A→C→D→E (15 tasks with all four rungs)

| Rung | Adds | Success | Δ success vs previous (pp, 95% CI) | Mean cost | Δ cost vs previous (95% CI) | Wall (min) | Wall excl. auto-proceed waits (min) |
|---|---|---:|---|---:|---|---:|---:|
| A | naked Claude | 15/15 | — | $0.69 | — | 5.0 | 5.0 |
| C | + knowledge | 14/15 | −7 (−20…+0) | $0.99 | +$0.30 (+$0.23…+$0.38) | 6.0 | 6.0 |
| D | + observer (claude+claude) | 14/15 | +0 (+0…+0) | $1.72 | +$0.73 (+$0.51…+$0.93) | 10.0 | 10.0 |
| E | + council skills + auto-proceed | 12/15 | −13 (−40…+13) | $2.05 | +$0.32 (+$0.03…+$0.74) | 17.3 | 11.7 |


## Per task (stage 1)

✓ success, ✗N failed with N hidden tests red (✗0 = hidden green, zone
regression), · not run.

| Task | Class | A | B | C | D | E | F | G |
|---|---|---|---|---|---|---|---|---|
| `archived-session-cli-survives-restart` | bugfix | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | · |
| `archived-sessions-hold-memory` | bugfix | ✓ | ✓ | ✓ | ✓ | ✗1 | ✓ | · |
| `claude-adapter-outbound-queue-overflow` | feature | ✓ | ✗21 | ✓ | ✓ | ✗5 | ✗11 | · |
| `claude-cli-stdio-transport` | architecture | ✓ | ✗20 | ✓ | ✓ | ✓ | ✗1 | · |
| `claude-context-usage-meter` | ui | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | · |
| `claude-model-switch-404-strands-session` | bugfix | ✓ | ✓ | ✓ | ✓ | ✗3 | ✓ | · |
| `codex-error-notification-shown-as-drift` | bugfix | ✓ | ✗1 | ✗3 | ✗3 | ✓ | ✗1 | · |
| `codex-model-fallback-picks-mini` | bugfix | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `codex-observer-findings-dropped` | bugfix | ✗0 | ✗0 | ✓ | ✓ | ✓ | ✓ | · |
| `codex-session-spawns-council-pair` | debug | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | · |
| `compaction-advisory-on-jsonl-growth` | feature | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | · |
| `council-checkpoint-producer-endpoint` | feature | ✓ | · | · | · | · | · | · |
| `council-watchers-die-silently` | architecture | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `dedupe-assistant-avatar` | refactor | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `drift-detector-misses-dead-stdio` | debug | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `known-broken-claude-model-substitution` | feature | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `observer-findings-oldest-first` | ui | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |

Failures concentrate on 4 tasks. `codex-error-notification-shown-as-drift`
is solved by A and E only (1–3 hidden tests red elsewhere);
`claude-adapter-outbound-queue-overflow` fails for B, E, F (and B/F also
regress `ws-bridge.test.ts`); E alone fails `archived-sessions-hold-memory`
and `claude-model-switch-404-strands-session`.

## H — Claude orchestrator + Codex observer (BENCH-H, partial)

10 of 16 planned cells ran before the Codex quota ran out
(`data/bench-h-cells.jsonl`). 5 are `harness_error observer_dead` and are
excluded: 4 hit the Codex usage limit ("try again at Oct 4th, 2026 11:56 PM"),
1 (`claude-model-switch-404-strands-session`) died on Codex protocol drift —
`unsupported incoming notification "skills/changed"` — which is a Companion
compatibility gap with the current codex-cli, not a quota effect (ASK-FIRST).
The 5 valid cells: 5/5 success, observer `codex/gpt-5.5` in all 5,
`review_providers ∋ codex` in 4 (`claude-cli-stdio-transport` ran the observer
but produced no review), mean wall 11.3 min. D solved the same 5 tasks.
Orchestrator cost is null in all H cells (the Claude cost is not separated
from the dead/unpriced Codex half), so H cost is **unknown**. **No conclusion
on H** until the remaining 11 cells run after the quota reset.

## Layer by layer — where Aura pays off and where it does not

Each row cites R1/R3 (all tasks) or R1s/R3s (sensitivity).

| Layer | Quality effect | Cost effect | Verdict |
|---|---|---|---|
| Knowledge (A→C) | 0 pp (R3, CI −19…+19); −7 pp without the artefact task (R3s, CI −20…0) | +$0.29 per task (R3, CI +$0.21…+$0.37), ≈ +41% | **Does not pay off** on this corpus: costs more, adds no success. |
| Observer, claude+claude (C→D) | 0 pp, identical per task (R3, CI 0…0) | +$0.75 per task (R3, CI +$0.54…+$0.94), wall 5.8 → 10.2 min | **Does not pay off** in success rate. The observer reviewed in 29/32 D/E cells; its value as a guard against regressions is not visible when A already solves 15/16. |
| Council skills + auto-proceed (D→E) | −12 pp (R3, CI −37…+13); −13 pp in R3s | +$0.31 per task (R3, CI +$0.03…+$0.69); wall 17.7 min, 12.0 min net of auto-proceed waits | **Does not pay off**, the only rung with a negative point estimate; E is 3.0× A's cost (R1). |
| Codex + knowledge (B→F) | +6 pp vs B (R1, CI 0…+19) — all of it the artefact task; 0 pp in R1s | unknown (Codex unpriced); tokens ≈ equal to B | **No effect** once the artefact is removed. |
| Diet (before → after control files) | C 8/10 → 8/10; D 4/6 → 4/6 on the 3-rep rerun of the flipped tasks | −28% standing context (−9.5 K tokens), −12.4% cost on C+D (CI excludes 0), D rerun −18.8% (CI −$0.65…−$0.07 per cell) | **Pays off:** cheaper with no measured quality loss. [DIET-AB.md](DIET-AB.md) |
| Council review panel size | recall FULL 10/18, ECONOMY 10/18, MINIMAL 12/18 (CIs overlap) | $47.88 / $19.48 / $14.18 | **Smaller panel pays off:** same recall at 40% / 30% of the cost. [COUNCIL-PANEL.md](COUNCIL-PANEL.md) |

Honest summary:

1. **No measurable Aura Lift on task success.** Naked Claude (A) solved
   16/17 tasks (94%); no Aura variant beats it on any task except one that is
   a harness artefact. The corpus is near ceiling for A, so a positive lift
   could only show on the few hard tasks, and there it does not.
2. **Each Aura layer costs money and time.** C +41%, D 2.5×, E 3.0× A's mean
   cost; D and E roughly double and triple wall clock.
3. **The diet and the economy panel are the measured wins** — both are cost
   reductions without measured quality loss.
4. **What this benchmark does not measure:** long multi-session work, human
   time saved by observer findings, recovery from crashes, and tasks where
   naked agents fail. The observer's precision work (P3) is measured
   separately on a synthetic 11-finding corpus (false STOP 0.60 → 0.20 with
   banner grounding, not real-world evidence; `STATE.metrics.observer_false_stop_rate_corpus`).

## Limits and confounds

- **Small sample.** 17 tasks × 1 rep; CIs on success differences span about
  ±20 pp. Stage 2 (3 reps on tasks where variants diverge) has not run.
- **Ceiling.** A solves 94%; the corpus mostly tests whether an agent can do
  a PR-sized change, which naked Opus already does.
- **Bench directive.** D/E/H observer loop is driven by a directive appended
  to the prompt (prod relies on the `/council-*` skills), confound recorded
  on every D/E cell.
- **Unsandboxed agents.** The bench root and clone (with merge commits) are
  reachable by absolute path; recorded on every cell. No cell was found
  reading them, but it is not enforced.
- **Auto-proceed.** E's auto-proceed fires after the work is done; an
  unresolved observer STOP would hold it forever (bench never releases).
  Auto-proceed is not active in prod and was not measured as a prod feature.
- **Codex cost** is unpriced; Codex comparisons are on success and tokens only.
- **Task specs.** `claude-cli-stdio-transport`, `resume-hiccup-loses-conversation`
  and `council-lost-review-event-degrades-pair` were rewritten in CORPUS-SPEC-CHECK; stage-1 cells carry `prompt_sha256` and
  stale cells were moved out (`results/spec-superseded.jsonl`).

## Reproduce

```bash
cd web
bun run eval:aurabench report --cells ../docs/aurabench/data/d2-stage1-cells.jsonl
bun run eval:aurabench report --cells ../docs/aurabench/data/d2-stage1-cells.jsonl \
  --exclude-tasks codex-observer-findings-dropped
bun run eval:aurabench report --cells ../docs/aurabench/data/bench-h-cells.jsonl
```

The committed JSONL is the bench `results/cells.jsonl` with isolation details
reduced to violations + layer evidence and every absolute path replaced by
`<path>`; no tokens or credentials.
