# AuraBench REPORT (D3)

Final report of the D2-full ablation. Every table below comes from committed,
sanitized data with the commands in [Reproduce](#reproduce).

**Stage 2 is partial for the Codex variants.** On 2026-10-09 the owner stopped
Codex in the bench (option B): the bench was using up the Codex subscription
limit at about 5 cells a day, and the owner needs that quota. Stage 2 ended at
191/234 cells. A, C, D and E have all 3 reps on the 13 stage-2 tasks. B has 2
reps on 5 of them and F on 4; the rest have 1. The 43 missing Codex cells were
not run. Comparisons involving B or F rest on fewer reps, so their CIs are
wider. Task-weighted success and every lift are computed from the reps each
task actually got.

Sources in this report:

| Block | Data | Cells / runs | Details |
|---|---|---|---|
| Ablation A–G | [`data/d2-full-cells.jsonl`](data/d2-full-cells.jsonl) | 365: stage 1 = 41 tasks × A–F × 1 (246); stage 2 = 13 tasks, reps 2–3 (A/C/D/E 104, B 5, F 4); G 6 from the pilot/probe | this file, R1–R4; [STAGE1.md](STAGE1.md) |
| H (Claude + Codex observer) | [`data/bench-h-cells.jsonl`](data/bench-h-cells.jsonl) | 16 (16 tasks × 1) | this file, §H; [BENCH-H.md](BENCH-H.md) |
| Diet before/after | [`data/diet-ab-cells.csv`](data/diet-ab-cells.csv), [`data/diet-ab-rerun-cells.csv`](data/diet-ab-rerun-cells.csv) | 60 + 12 | [DIET-AB.md](DIET-AB.md) |
| Council review panel size | [`data/council-panel/`](data/council-panel/) | 18 | [COUNCIL-PANEL.md](COUNCIL-PANEL.md) |

Variants: **A** naked Claude, **B** naked Codex, **C** Claude + knowledge,
**D** C + observer (claude+claude), **E** D + council skills + auto-proceed,
**F** Codex + knowledge, **G** Codex + council skills, **H** D with a Codex
observer. Models pinned: `claude-opus-5-5` (CLI 2.1.283), `gpt-5.5`
(codex-cli 0.142.5). A cell succeeds when the agent completes, every hidden
test passes and no zone test regresses.

## Method

- **Stages.** Stage 1 ran every task once per variant. Stage 2 added reps 2
  and 3 on the 13 tasks where variants diverged (rule in
  [STAGE1.md](STAGE1.md)). The other 28 tasks gave the same verdict for all of
  A–F: 26 all pass, 2 all fail.
- **Success (cells).** Share of successful cells, percentile bootstrap 95% CI
  over cells (10 000 resamples, fixed seed). The hard tasks have 3× the reps,
  so this share is weighted towards them.
- **Task-weighted success.** Mean of per-task success rates, bootstrap over
  tasks. Every task counts once whatever its rep count. Use this column to
  compare variants with different rep counts (B/F against A/C/D/E).
- **Aura Lift.** Paired difference in per-task success rate against the naked
  variant of the same orchestrator provider (C/D/E/H vs A, F/G vs B), on the
  tasks both ran; bootstrap over tasks.
- **Cost.** API-equivalent USD from the Claude result frame. Codex reports no
  price, so B/F/G/H cost is **unknown** (never averaged as 0). Mean tokens per
  Codex cell: B 1.57 M in (1.48 M cached) / 8.8 K out; F 1.74 M / 1.64 M / 8.9 K;
  G 1.03 M / 0.94 M / 6.6 K.
- **Wall clock E** is shown twice: full, and minus auto-proceed idle waits
  (fires × 120 s idle threshold). In the bench, auto-proceed fires after the
  task is already done (pilot finding), so the net figure is the fair one for
  work time. Cost and success are not adjusted.
- **Exclusions.** Cells with `harness_error` or isolation violations are
  excluded. Here: none. All 365 + 16 cells are `completed` with 0
  violations. Runs that hit the disk-full or Codex-quota incidents were set
  aside before the reruns (`results/disk-full.jsonl`,
  `bench-h/results/observer-dead.jsonl`; not published). `timeout` counts as
  a failure; none occurred.
- Engine: `web/evals/aurabench/report.ts`; publish filter:
  `web/evals/aurabench/publish.ts`. Both are unit-tested.

## Results — all 41 tasks

### R1. Success, Aura Lift, cost by variant

| Variant | Label | Cells | Tasks | Success | 95% CI | Reps / task | Task-weighted success (95% CI over tasks) | Lift vs naked (pp) | Lift 95% CI | Paired tasks | Mean cost | Cost 95% CI | $ / success | Mean wall (min) |
|---|---|---:|---:|---:|---|---:|---|---:|---|---:|---:|---|---:|---:|
| A | naked Claude | 67 | 41 | 55/67 (82%) | 73%–91% | 1–3 | 87% (76%–96%) | — | — | — | $0.63 | $0.51–$0.77 | $0.77 | 4.6 |
| B | naked Codex | 46 | 41 | 35/46 (76%) | 63%–87% | 1–2 | 80% (68%–93%) | — | — | — | unknown | — | unknown | 5.0 |
| C | Claude+knowledge | 67 | 41 | 56/67 (84%) | 75%–93% | 1–3 | 88% (78%–96%) | +1 vs A | −5…+7 | 41 | $0.85 | $0.71–$1.02 | $1.02 | 5.8 |
| D | Claude+Observer | 67 | 41 | 55/67 (82%) | 73%–91% | 1–3 | 87% (77%–95%) | +0 vs A | −8…+9 | 41 | $1.53 | $1.40–$1.67 | $1.87 | 9.3 |
| E | Claude+full Council | 67 | 41 | 48/67 (72%) | 61%–82% | 1–3 | 81% (70%–92%) | −6 vs A | −16…+5 | 41 | $1.82 | $1.66–$1.99 | $2.54 | 16.8 |
| F | Codex+Aura | 45 | 41 | 36/45 (80%) | 67%–91% | 1–2 | 84% (72%–94%) | +4 vs B | −6…+13 | 41 | unknown | — | unknown | 5.8 |
| G | Codex+Council | 6 | 6 | 6/6 (100%) | 100%–100% | 1 | 100% (100%–100%) | +0 vs B | +0…+0 | 6 | unknown | — | unknown | 4.5 |

### R2. Success by class (successes / cells)

| Class | A | B | C | D | E | F | G |
|---|---:|---:|---:|---:|---:|---:|---:|
| architecture | 4/5 | 1/4 | 4/5 | 4/5 | 4/5 | 1/4 | 1/1 |
| bugfix | 16/22 | 10/13 | 17/22 | 20/22 | 17/22 | 10/12 | 1/1 |
| debug | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 1/1 |
| feature | 17/19 | 10/14 | 17/19 | 15/19 | 14/19 | 10/14 | 1/1 |
| refactor | 5/8 | 3/4 | 5/8 | 5/8 | 3/8 | 4/4 | 1/1 |
| security | 4/4 | 2/2 | 4/4 | 2/4 | 1/4 | 2/2 | — |
| ui | 6/6 | 6/6 | 6/6 | 6/6 | 6/6 | 6/6 | 1/1 |

### R3. Layer ladder A→C→D→E (41 tasks with all four rungs)

| Rung | Adds | Success | Δ success vs previous (pp, 95% CI) | Mean cost | Δ cost vs previous (95% CI) | Wall (min) | Wall excl. auto-proceed waits (min) |
|---|---|---:|---|---:|---|---:|---:|
| A | naked Claude | 55/67 | — | $0.63 | — | 4.6 | 4.6 |
| C | + knowledge | 56/67 | +1 (−5…+7) | $0.85 | +$0.21 (+$0.16…+$0.26) | 5.8 | 5.8 |
| D | + observer (claude+claude) | 55/67 | −1 (−8…+6) | $1.53 | +$0.66 (+$0.57…+$0.75) | 9.3 | 9.3 |
| E | + council skills + auto-proceed | 48/67 | −6 (−13…+0) | $1.82 | +$0.26 (+$0.16…+$0.37) | 16.8 | 11.3 |

## Sensitivity — without `codex-observer-findings-dropped` (harness artefact)

On `codex-observer-findings-dropped`, A and B pass every hidden test but
"regress" `server/observer-prompt.test.ts`. That test reads
`.council/prompts/observer-system.md` from the repo root, and the naked scrub
deletes `.council/` from the worktree. The Aura variants keep the file, so
they pass. The task measures which control files are present, not the agent.
A failed it in all 3 reps. Without it:

### R1s. Success, Aura Lift, cost by variant

| Variant | Label | Cells | Tasks | Success | 95% CI | Reps / task | Task-weighted success (95% CI over tasks) | Lift vs naked (pp) | Lift 95% CI | Paired tasks | Mean cost | Cost 95% CI | $ / success | Mean wall (min) |
|---|---|---:|---:|---:|---|---:|---|---:|---|---:|---:|---|---:|---:|
| A | naked Claude | 64 | 40 | 55/64 (86%) | 77%–94% | 1–3 | 89% (80%–97%) | — | — | — | $0.64 | $0.52–$0.79 | $0.75 | 4.7 |
| B | naked Codex | 45 | 40 | 35/45 (78%) | 64%–89% | 1–2 | 83% (70%–93%) | — | — | — | unknown | — | unknown | 5.1 |
| C | Claude+knowledge | 64 | 40 | 53/64 (83%) | 73%–91% | 1–3 | 88% (78%–96%) | −2 vs A | −6…+2 | 40 | $0.87 | $0.73–$1.04 | $1.05 | 5.9 |
| D | Claude+Observer | 64 | 40 | 52/64 (81%) | 72%–91% | 1–3 | 87% (77%–95%) | −2 vs A | −10…+4 | 40 | $1.53 | $1.40–$1.69 | $1.89 | 9.3 |
| E | Claude+full Council | 64 | 40 | 45/64 (70%) | 59%–81% | 1–3 | 81% (69%–92%) | −8 vs A | −18…+1 | 40 | $1.80 | $1.64–$1.98 | $2.56 | 16.5 |
| F | Codex+Aura | 44 | 40 | 35/44 (80%) | 66%–91% | 1–2 | 84% (71%–94%) | +1 vs B | −7…+10 | 40 | unknown | — | unknown | 5.9 |
| G | Codex+Council | 6 | 6 | 6/6 (100%) | 100%–100% | 1 | 100% (100%–100%) | +0 vs B | +0…+0 | 6 | unknown | — | unknown | 4.5 |

### R2s. Success by class (successes / cells)

| Class | A | B | C | D | E | F | G |
|---|---:|---:|---:|---:|---:|---:|---:|
| architecture | 4/5 | 1/4 | 4/5 | 4/5 | 4/5 | 1/4 | 1/1 |
| bugfix | 16/19 | 10/12 | 14/19 | 17/19 | 14/19 | 9/11 | 1/1 |
| debug | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 1/1 |
| feature | 17/19 | 10/14 | 17/19 | 15/19 | 14/19 | 10/14 | 1/1 |
| refactor | 5/8 | 3/4 | 5/8 | 5/8 | 3/8 | 4/4 | 1/1 |
| security | 4/4 | 2/2 | 4/4 | 2/4 | 1/4 | 2/2 | — |
| ui | 6/6 | 6/6 | 6/6 | 6/6 | 6/6 | 6/6 | 1/1 |

### R3s. Layer ladder A→C→D→E (40 tasks with all four rungs)

| Rung | Adds | Success | Δ success vs previous (pp, 95% CI) | Mean cost | Δ cost vs previous (95% CI) | Wall (min) | Wall excl. auto-proceed waits (min) |
|---|---|---:|---|---:|---|---:|---:|
| A | naked Claude | 55/64 | — | $0.64 | — | 4.7 | 4.7 |
| C | + knowledge | 53/64 | −2 (−6…+2) | $0.87 | +$0.21 (+$0.16…+$0.27) | 5.9 | 5.9 |
| D | + observer (claude+claude) | 52/64 | −1 (−8…+6) | $1.53 | +$0.65 (+$0.56…+$0.74) | 9.3 | 9.3 |
| E | + council skills + auto-proceed | 45/64 | −6 (−13…+0) | $1.80 | +$0.25 (+$0.15…+$0.36) | 16.5 | 11.0 |

## Per task

### R4. Per task

| Task | Class | A | B | C | D | E | F | G |
|---|---|---|---|---|---|---|---|---|
| `archived-session-cli-survives-restart` | bugfix | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | · |
| `archived-sessions-hold-memory` | bugfix | 3/3 | 2/2 | 3/3 | 3/3 | 0/3 | 1/2 | · |
| `claude-adapter-outbound-queue-overflow` | feature | 3/3 | 0/2 | 3/3 | 3/3 | 2/3 | 0/2 | · |
| `claude-cli-stdio-transport` | architecture | 3/3 | 0/2 | 3/3 | 3/3 | 3/3 | 0/2 | · |
| `claude-context-usage-meter` | ui | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | · |
| `claude-model-switch-404-strands-session` | bugfix | 2/3 | 2/2 | 3/3 | 3/3 | 2/3 | 2/2 | · |
| `codex-error-notification-shown-as-drift` | bugfix | 1/3 | 0/2 | 1/3 | 2/3 | 3/3 | ✗1 | · |
| `codex-model-fallback-picks-mini` | bugfix | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `codex-observer-findings-dropped` | bugfix | 0/3 | ✗0 | 3/3 | 3/3 | 3/3 | ✓ | · |
| `codex-session-spawns-council-pair` | debug | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | · |
| `compaction-advisory-on-jsonl-growth` | feature | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | · |
| `council-checkpoint-producer-endpoint` | feature | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | · |
| `council-degraded-pair-never-recovers` | bugfix | 3/3 | ✓ | 1/3 | 2/3 | 3/3 | ✓ | · |
| `council-lost-review-event-degrades-pair` | bugfix | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | · |
| `council-observer-idle-until-first-checkpoint` | feature | 2/3 | ✗1 | 2/3 | 0/3 | 0/3 | ✓ | · |
| `council-pairing-dropdown-invisible` | ui | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | · |
| `council-seat-model-tier-decision` | feature | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | · |
| `council-watchers-die-silently` | architecture | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `dedupe-assistant-avatar` | refactor | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `drift-detector-misses-dead-stdio` | debug | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `eval-compare-variant-delta-report` | feature | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | · |
| `extract-empty-chat-state` | refactor | 0/3 | ✓ | 0/3 | 2/3 | 1/3 | ✓ | · |
| `extract-resume-indicator` | refactor | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | · |
| `known-broken-claude-model-substitution` | feature | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `observer-findings-oldest-first` | ui | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `orphan-reaper-misses-stdio-claude` | feature | ✗1 | ✗1 | ✗1 | ✗1 | ✗1 | ✗1 | · |
| `own-sandbox-image-no-upstream-registry` | refactor | 3/3 | ✗0 | 3/3 | 1/3 | 0/3 | ✓ | · |
| `recordings-store-secrets-in-clear` | security | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | · |
| `respawned-cli-forgets-last-message` | feature | 3/3 | ✓ | 3/3 | 3/3 | 3/3 | ✗0 | · |
| `resume-discards-conversation-too-eagerly` | bugfix | 3/3 | ✓ | 2/3 | 3/3 | 2/3 | ✓ | · |
| `resume-hiccup-loses-conversation` | debug | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | · |
| `session-restore-crash-on-sidecar-json` | bugfix | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | · |
| `session-schema-version` | feature | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | · |
| `sessions-lost-on-reboot-tmpdir` | feature | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | · |
| `settings-secret-field-saves-mask-dots` | security | 3/3 | ✓ | 3/3 | 1/3 | 0/3 | ✓ | · |
| `sever-self-update-and-upstream-sync` | architecture | ✗11 | ✗4 | ✗4 | ✗4 | ✗4 | ✗4 | · |
| `shutdown-loses-streaming-replies` | feature | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | · |
| `sidebar-duplicate-provider-chips` | ui | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | · |
| `sidebar-pair-chip-duplicates-backend` | ui | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | · |
| `silent-stdio-watchdog-false-positives` | feature | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | · |
| `task-panel-stale-snapshot-hint` | ui | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | · |

✓ success, ✗N failed with N hidden tests red (✗0 = hidden green, zone
regression), k/n = successes over reps, · not run.

Where the variants differ (all on the 13 stage-2 tasks):

- **E loses most.** 0/3 on `archived-sessions-hold-memory`,
  `own-sandbox-image-no-upstream-registry`,
  `settings-secret-field-saves-mask-dots` and
  `council-observer-idle-until-first-checkpoint`. A solves the first three
  3/3 and the last one 2/3. Security tasks: A 4/4, C 4/4, D 2/4, E 1/4 (R2).
- **The observer helps on a few tasks.** `codex-error-notification-shown-as-drift`
  A 1/3, D 2/3, E 3/3. `extract-empty-chat-state` A 0/3, C 0/3, D 2/3.
- **Knowledge alone hurts on one task.** `council-degraded-pair-never-recovers`
  A 3/3, C 1/3, D 2/3, E 3/3.
- **…and hurts on others.** `council-observer-idle-until-first-checkpoint`
  A 2/3, D 0/3. `own-sandbox-image-no-upstream-registry` A 3/3, D 1/3.
  `settings-secret-field-saves-mask-dots` A 3/3, D 1/3.
- **Codex (B, F)** fails `claude-adapter-outbound-queue-overflow` and
  `claude-cli-stdio-transport` in every rep. Claude A/C/D does not.
- Two tasks fail for every variant: `orphan-reaper-misses-stdio-claude` and
  `sever-self-update-and-upstream-sync`. They are corpus ceiling items, not
  variant effects.

## H — Claude orchestrator + Codex observer (BENCH-H)

16 tasks × 1 rep, all 16 cells `completed`, no isolation violations. The
observer was `codex/gpt-5.5` in all 16, and every pair produced a Codex
review (details and the review-file fix: [BENCH-H.md](BENCH-H.md)).

| Variant on the same 16 tasks | Rep 1 only | All reps | Mean wall, rep 1 (min) |
|---|---:|---:|---:|
| A naked Claude | 15/16 | 22/28 | — |
| C + knowledge | 15/16 | 26/28 | — |
| D + observer (claude+claude) | 15/16 | 27/28 | 10.2 |
| E + council + auto-proceed | 13/16 | 23/28 | — |
| **H** + observer (claude+codex) | **16/16** | — (1 rep) | 10.6 |

The engine gives H a lift of **+13 pp vs A (CI +0…+29, 16 tasks)**. Read that
with care. A's per-task rates include stage-2 reps 2–3 on the hard tasks, and
H has 1 rep. Compared rep 1 to rep 1 on the same tasks, H is 16/16 and D is
15/16: one task (`codex-error-notification-shown-as-drift`) apart. H cost is
**unknown** because the orchestrator cost is not separated from the unpriced
Codex observer. **Conclusion: a Codex observer is at least as good as a Claude
one on this sample. The data does not show it to be better.**

## Layer by layer — where Aura pays off and where it does not

Each row cites R1/R3 (all tasks) or R1s/R3s (sensitivity).

| Layer | Quality effect | Cost effect | Verdict |
|---|---|---|---|
| Knowledge (A→C) | +1 pp (R3, CI −5…+7); −2 pp without the artefact task (R3s, CI −6…+2) | +$0.21 per task (R3, CI +$0.16…+$0.26), ≈ +35% | **Does not pay off** on this corpus: costs more, no measurable success gain. |
| Observer, claude+claude (C→D) | −1 pp (R3, CI −8…+6); task-level wins and losses cancel (R4) | +$0.66 per task (R3, CI +$0.57…+$0.75); wall 5.8 → 9.3 min | **Does not pay off** in success rate. It helps on some tasks and hurts on as many. |
| Council skills + auto-proceed (D→E) | −6 pp (R3, CI −13…+0); −6 pp in R3s (CI −13…+0) | +$0.26 per task (R3, CI +$0.16…+$0.37); wall 16.8 min, 11.3 min net of auto-proceed waits | **Does not pay off.** It is the only rung whose CI almost excludes 0 on the negative side. E costs 2.9× A (R1) and loses most on security and refactor tasks (R2, R4). |
| Codex observer instead of Claude (D→H) | 16/16 vs 15/16 on the same 16 tasks, rep 1 (§H) | unknown (Codex unpriced) | **Parity**, no evidence of gain; 1 rep. |
| Codex + knowledge (B→F) | +4 pp vs B (R1, CI −6…+13); +1 pp in R1s (CI −7…+10) | unknown; tokens F ≈ B (+11% input) | **No measurable effect.** Partial reps, wide CI. |
| Diet (before → after control files) | C 8/10 → 8/10; D 4/6 → 4/6 on the 3-rep rerun of the flipped tasks | −28% standing context (−9.5 K tokens), −12.4% cost on C+D (CI excludes 0), D rerun −18.8% (CI −$0.65…−$0.07 per cell) | **Pays off:** cheaper with no measured quality loss. [DIET-AB.md](DIET-AB.md) |
| Council review panel size | recall FULL 10/18, ECONOMY 10/18, MINIMAL 12/18 (CIs overlap) | $47.88 / $19.48 / $14.18 | **Smaller panel pays off:** same recall at 40% / 30% of the cost. [COUNCIL-PANEL.md](COUNCIL-PANEL.md) |

Honest summary:

1. **No measurable Aura Lift on task success.** Naked Claude (A) solves 87%
   of tasks (task-weighted, CI 76–96%). C and D are within ±1 pp of A, with
   CIs spanning 0. E is 6 pp below A (CI −16…+5). Codex + knowledge (F) is
   +4 pp vs naked Codex (CI −6…+13). Without the artefact task, C and D are
   −2 pp vs A, E is −8 pp (CI −18…+1), and F is +1 pp vs B (R1s).
2. **Each Aura layer costs money and time.** Relative to A's mean cost: C +35%,
   D 2.4×, E 2.9×. Wall clock: D about 2× A, E about 3.6× A, or 2.5× net of
   auto-proceed waits.
3. **The full council stack (E) is the measured negative.** It loses on
   security and refactor tasks where naked Claude is reliable.
4. **The diet and the economy panel are the measured wins.** Both cut cost
   with no measured quality loss.
5. **What this benchmark does not measure:** long multi-session work, human
   time saved by observer findings, recovery from crashes, and tasks where
   naked agents fail. On 26 of 41 tasks every variant passes. The observer's
   precision work (P3) is measured separately on a synthetic 11-finding corpus
   (false STOP 0.60 → 0.20 with banner grounding; not real-world evidence).

## Limits and confounds

- **Sample size.** 41 tasks. 3 reps only on the 13 diverging tasks, and B/F
  have 1–2 there because Codex was stopped by the owner (see the top of this
  file). Success-difference CIs span about ±5–15 pp.
- **Ceiling.** A solves 87% of tasks. The corpus mostly tests whether an agent
  can make a PR-sized change, which naked Opus already does.
- **H** has 1 rep on 16 tasks, and its cost is unknown.
- **Bench directive.** The D/E/H observer loop is driven by a directive
  appended to the prompt (prod relies on the `/council-*` skills). This
  confound is recorded on every D/E/H cell.
- **Unsandboxed agents.** The bench root and clone (with merge commits) can be
  reached by absolute path. This is recorded on every cell. No cell was found
  reading them, but nothing enforces it.
- **Auto-proceed.** E's auto-proceed fires after the work is done. An
  unresolved observer STOP would hold it forever, and the bench never releases
  one. Auto-proceed is not active in prod and was not measured as a prod
  feature.
- **Codex cost** is unpriced. Codex comparisons use success and tokens only.
- **Task specs.** `claude-cli-stdio-transport`, `resume-hiccup-loses-conversation`
  and `council-lost-review-event-degrades-pair` were rewritten in
  CORPUS-SPEC-CHECK. Cells carry `prompt_sha256`, and stale cells were moved
  out before stage 1 (`results/spec-superseded.jsonl`).
- **G** has 6 cells from the pilot and probe. Stage 1 dropped it ([STAGE1.md](STAGE1.md)).

## Reproduce

```bash
cd web
# all tasks (R1–R4)
bun run eval:aurabench report --cells ../docs/aurabench/data/d2-full-cells.jsonl
# sensitivity (R1s–R3s)
bun run eval:aurabench report --cells ../docs/aurabench/data/d2-full-cells.jsonl \
  --exclude-tasks codex-observer-findings-dropped
# H next to A–G
bun run eval:aurabench report --cells ../docs/aurabench/data/bench-h-cells.jsonl,../docs/aurabench/data/d2-full-cells.jsonl
# regenerate the published data from the bench (sanitized, refuses paths/credentials)
bun run eval:aurabench export-cells --in <bench>/results/cells.jsonl --out ../docs/aurabench/data/d2-full-cells.jsonl
bun run eval:aurabench export-cells --in <bench>/bench-h/results/cells.jsonl --out ../docs/aurabench/data/bench-h-cells.jsonl
```

The committed JSONL is the bench `results/cells.jsonl` after
`aurabench/publish.ts`: isolation is reduced to violations, layer evidence and
council halves, and every absolute path becomes `<path>`. It contains no
tokens or credentials; the filter refuses to write output that does.
