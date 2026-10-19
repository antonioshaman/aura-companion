# B4 — Council expert dispatch: report and economy policy

**Spec:** `specs/aura-meta-diet.md` → Story B4 («экономный expert dispatch»).
**Engine:** `web/scripts/dispatch-policy.ts` (+ `dispatch-policy.test.ts`).
**Dataset:** `web/scripts/__fixtures__/council-dispatch/history.json`.
**Regenerate the tables:** `cd web && bun run council:dispatch-report` (a test fails if the block below drifts from the renderer).

## Data sources and their limits

- **run-stats (`COMPANION_COUNCIL_STATS_DIR`, default `~/.companion/council-stats/`)** held **1 record** at B4 time, and it is a `skill: "smoke"` record with 1 seat. The collector landed, but no real `/council-review-aura` run has written to it yet. «Run-stats за последний месяц» therefore cannot answer the question. The prod user's store under `/root` is not readable from this box's executor account.
- **Archived review output** (`docs/history/council/review-output/<id>/`, 2026-05-11 … 2026-06-04) is the only real dispatch history. 14 directories; `2026-05-12-2211` dispatched no expert and is excluded, which leaves **13 reviews**.
  - *Panel* = expert output files actually written. Historical seat names map to today's catalog ids as follows: `backend-ts`/`realtime`→`dahl`, `persistence`/`subprocess`→`ritchie`, `react-ui`→`abramov`, `a11y`→`watson`, `deploy`→`hashimoto`.
  - *Diff size* comes from `git --numstat` of the matching squash commit, counting code files only (`.council/` and root process docs excluded), or from the figure stated in the context brief. The source is recorded per row. For 4 reviews the brief gives no line total (`?`); those count as not-small (fail-closed).
  - *FINAL findings* = every `| **Council** | A × B × Carmack` attribution row in `FINAL-REVIEW.md`, with its P1/P2/P3 section. A finding counts as «kept» when at least one credited seat is on the replayed panel. 3 reviews have no attribution rows (`n/a`).
  - *Changed domains* were **annotated by the B4 executor** from each context brief (closed vocabulary). This is judgement, not measurement, and it drives which fail-closed lenses are relevant.
- The capability profiles are the frozen snapshot `web/scripts/__fixtures__/council-catalog/profiles.json`, which equals the live catalog (freshness canary). The repo fingerprint is `detectFingerprint` on this repo.

## Policy (in-repo engine)

`composeEconomyCouncil(fingerprintSignals, changedDomains, profiles, diff)`:

1. **Relevance gate.** A seat must match at least one domain the change touches. A stack-signal match alone no longer earns a seat. This was the driver of the historical 7–12 seat panels: on this repo nearly every stack specialist (`dahl`, `ritchie`, `abramov`, `watson`, `saarinen`, `friedman`, …) overlaps the repository fingerprint regardless of the diff.
2. **Seat budget from diff size.** The budget is 2 when the diff is ≤ 3 files and ≤ 150 lines with a known line count, and 3 otherwise. An unknown size always gets the larger budget.
3. **Fail-closed lenses.** Every cross-stack lens whose domain the change touches (`isGuaranteed`: `hunt` security, `fowler` refactoring/backend-architecture, `willison` llm-pipeline, `beck` test-quality) is seated **even past the budget**. The budget can only trim specialists. Every dropped candidate is returned with a reason (`no-domain-match` / `over-budget`).

## Results (generated)

<!-- dispatch-report:begin -->
| Panel | Reviews | Median seats | Distribution (seats×reviews) |
|---|---|---|---|
| Historical (dispatched) | 13 | 8 | 3×1, 4×1, 5×1, 7×1, 8×3, 10×1, 11×3, 12×2 |
| Economy policy (replayed) | 13 | 4 | 3×6, 4×7 |

| Diff size | Reviews | Historical median | Economy median | FINAL findings kept | P1 kept |
|---|---|---|---|---|---|
| S (≤5 files, ≤600 lines) | 1 | 4 | 3 | 10/13 (77%) | — |
| M | 4 | 7.5 | 3 | 19/42 (45%) | 4/9 (44%) |
| L (>20 files or >2000 lines) | 8 | 11 | 4 | 35/100 (35%) | 18/40 (45%) |
| **All** | 13 | 8 | 4 | 64/155 (41%) | 22/49 (45%) |

| Seat credited on a P1 the economy panel would not have seated | P1 findings |
|---|---|
| ritchie | 11 |
| dahl | 8 |
| watson | 3 |
| abramov | 2 |
| friedman | 2 |
| willison | 1 |

| Review | Files | Lines | Historical | Economy seats | Budget | Findings kept | P1 kept | Guaranteed missed |
|---|---|---|---|---|---|---|---|---|
| 2026-05-11-1953 | 24 | ? | 8 | beck, fowler, hunt, willison | 3 (over) | 4/15 (27%) | 2/8 (25%) | none |
| 2026-05-11-1957 | 24 | ? | 8 | beck, fowler, hunt, willison | 3 (over) | n/a | n/a | none |
| 2026-05-11-2251 | 33 | ? | 12 | beck, fowler, hunt, willison | 3 (over) | 5/15 (33%) | 2/5 (40%) | none |
| 2026-05-13-0100 | 24 | ? | 11 | beck, fowler, hunt, willison | 3 (over) | 7/25 (28%) | 5/13 (38%) | none |
| 2026-05-13-0150 | 37 | 5287 | 11 | beck, fowler, hunt, willison | 3 (over) | 8/15 (53%) | 3/3 (100%) | none |
| 2026-05-15-0336 | 7 | 855 | 7 | beck, fowler, hunt, willison | 3 (over) | 7/12 (58%) | 3/7 (43%) | none |
| 2026-05-15-beta-catalog | 143 | 3177 | 3 | beck, fowler, hunt, willison | 3 (over) | n/a | n/a | none |
| 2026-05-17-1055 | 6 | 1171 | 5 | beck, fowler, hunt | 3 | n/a | n/a | none |
| 2026-05-17-2031 | 9 | 297 | 8 | abramov, hashimoto, hunt | 3 | 5/15 (33%) | 1/2 (50%) | none |
| 2026-05-18-1121 | 20 | 1177 | 10 | beck, fowler, hunt | 3 | 7/15 (47%) | — | none |
| 2026-06-01-2026 | 4 | 552 | 4 | beck, fowler, hunt | 3 | 10/13 (77%) | — | none |
| 2026-06-04-0823 | 21 | 4621 | 12 | beck, fowler, hunt | 3 | 5/15 (33%) | 3/7 (43%) | none |
| 2026-06-04-1826 | 31 | 3818 | 11 | beck, fowler, hunt | 3 | 6/15 (40%) | 3/4 (75%) | none |
<!-- dispatch-report:end -->

## Conclusions

1. **Seats.** The replayed median drops from **8 to 4** (−50%), and the L bucket drops from 11 to 4. Every fail-closed lens with a domain match is kept («Guaranteed missed: none» in all 13 reviews).
2. **AC «median ≤ 3» is NOT met while the fail-closed rule holds.** In 7 of 13 reviews the change touches all four fail-closed domains at once (Council Mode work: security + backend architecture + LLM output + tests), so the floor itself is 4 seats. Reaching 3 requires a decision the executor may not take (see below).
3. **The cut is not free.** Only **45% of P1 findings** (22/49) and 41% of all attributed FINAL findings are credited to a seat the economy panel would have kept. The lost P1s concentrate on `ritchie` (11: process lifecycle and filesystem persistence) and `dahl` (8: protocol/backend). An attribution row credits the seat whose reference produced the finding. It does not prove that nobody else would have caught it, so 45% is a **lower bound** on recall, not an estimate. Still, the specialist seats were not «theatre» on this history: they produced most of the P1s on Council Mode changes.
4. **Recommendation.** Do not switch live council skills to the economy panel by default on this evidence. Ship it as an explicit opt-in (economy mode) and let the P6 ablation decide, together with a non-empty run-stats dataset (every real run should call `run-stats.ts record`). A cheaper lever with less recall risk is `tier-policy.ts` (cheap model tier for specialists), which is already gated on data.

## Sensitivity: narrowing `fowler` to `refactoring`

`fowler` is seated as a fail-closed lens on any `backend-architecture` change, a domain it shares with `dahl`. With `fowler.domains = [refactoring]` (live catalog change, not applied) the replayed median is **3** and P1 kept is **23/49 (47%)**: on backend changes `dahl` takes the seat and brings its P1s. This is the only variant found that meets «median ≤ 3» without dropping a fail-closed lens on a domain match. It needs a human decision because it changes the live catalog and the meaning of fowler's lane. See ASK-FIRST.

## Live skills (not modified)

`~/.claude/skills/_council-experts/selection-engine.md` and `~/.claude/skills/council-review-aura/SKILL.md` are **untouched**. The proposed prose change (an opt-in economy step pointing at `dispatch-policy.ts`) is a patch in the executor's ASK-FIRST queue, alongside the `fowler` catalog question.
