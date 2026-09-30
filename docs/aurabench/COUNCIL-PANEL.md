# COUNCIL-PANEL-BENCH — which council panel buys the most P1 recall per dollar (harness part 1; results pending)

B4 measured the economy dispatch policy only by replaying archived reviews
(median seats 8 → 4, but 27/49 P1s lost under the assumption that experts are
independent). The human's decision of 2026-09-29 asks for a live measurement:
6 historical PRs with known defects × 3 panels = 18 runs of
`/council-review-aura`. This file describes the offline half (cases, panels,
scoring). The live runner and the results section come in the next step.

## Cases

`web/evals/aurabench/council-panel/cases.json`: 6 merged PRs whose merged state
carried defects that a later PR fixed on the same code. The council reviews
`base..head`. Ground truth is `knownDefects`, and each entry is pinned to its fix
commit (`fixedBy`).

| Case | Diff (files / lines) | Known defects (P1) | Evidence |
|---|---|---|---|
| `pr54-auto-proceed-wireup` | 7 / 855 | 5 defects + 2 test gaps | archived review 2026-05-15-0336; fixes #55, #56, #57 |
| `pr91-dynamic-models` | 37 / 7746 | 1 defect + 3 vacuous tests | archived review 2026-06-04-1826 (burndown squashed into #91); fix #92 |
| `pr172-173-codex-init` | 7 / 451 | 2 defects + 1 test gap | council review of #172/#173 (not archived); fix #174 lists the P1s |
| `pr120-codex-review-normalize` | 5 / 266 | 1 defect | fix #122: a Codex review with any findings was still dropped |
| `pr122-codex-finding-shape` | 2 / 164 | 1 defect | fix #123: `line: 0` dropped the whole review |
| `pr189-silent-stdio-drift` | 3 / 548 | 2 defects | fixes #201 and #204, both verified on prod |

18 known defects in total, all P1. `bun run eval:council-panel verify` checks
every pin against git: base, head and fix commits resolve, every defect file
exists at head, and every fix descends from head. Result on this clone:
`6 case(s), 18 known defect(s), 0 problem(s)`.

Rejected candidates: #8 (the squash already contains the fix pass for both
archived reviews, so its P1s are absent at head), A/B docs 2026-05-17-2031 (the
reviewed commit `50a9018` is not in the repo), #193 (the defect fixed by #196
lives in `ws.ts`, which the #193 diff does not touch).

## Panels

`web/evals/aurabench/council-panel/panels.ts` computes the rosters
deterministically from the in-repo engine and the catalog snapshot
(`web/scripts/__fixtures__/council-catalog/profiles.json`). The repo
fingerprint comes from the B4 dataset.

| Panel | Rule |
|---|---|
| FULL | `composeCouncil`: the relevant cross-stack lenses are guaranteed, then candidates by rank up to 11 seats. This is what the skill seats today. |
| ECONOMY | `composeEconomyCouncil` (B4): relevance gate plus a seat budget sized from the diff; fail-closed lenses are never dropped. |
| MINIMAL | 1 primary (the best-ranked domain specialist) + `hunt` (adversarial / security). |

Output of `bun run eval:council-panel plan`:

| Case | FULL | ECONOMY | MINIMAL |
|---|---|---|---|
| pr54 | 11: dahl, abramov, ritchie, beck, fowler, hashimoto, hunt, saarinen, willison, vanrossum, brandur | beck, fowler, hunt, willison | dahl, hunt |
| pr91 | 11: dahl, abramov, saarinen, watson, friedman, ritchie, beck, fowler, hashimoto, hunt, durov | beck, fowler, hunt | dahl, hunt |
| pr172-173 | 11: dahl, abramov, ritchie, beck, fowler, hashimoto, hunt, saarinen, vanrossum, brandur, friedman | beck, fowler, hunt | dahl, hunt |
| pr120 | 11: dahl, abramov, beck, fowler, hashimoto, hunt, saarinen, willison, vanrossum, brandur, friedman | beck, fowler, hunt, willison | dahl, hunt |
| pr122 | same as pr120 | beck, fowler, hunt, willison | dahl, hunt |
| pr189 | 11: dahl, abramov, ritchie, beck, fowler, hashimoto, hunt, saarinen, vanrossum, brandur, friedman | beck, fowler, hunt | dahl, hunt |

Observations from the plan alone (before any run):

- FULL always hits the 11-seat cap. Stack-signal overlap alone (the repo fingerprint
  has `drizzle`, `docker`, …) earns seats for `brandur`, `vanrossum` and
  `hashimoto` on diffs that touch no database, Python or deploy code. This is
  the "paying for theatre" pattern B4 describes.
- ECONOMY gives no seat to any stack specialist on any case. The fail-closed
  lenses (beck / fowler / hunt / willison) already fill the budget of 3 (4 when
  willison is relevant). So ECONOMY here amounts to "the four universal lenses", and whether
  those catch protocol and process defects (#120, #122, #189) is exactly what the
  live run measures.
- MINIMAL always seats `dahl`. It has the highest rank on every case because
  this repo's fingerprint matches most of its signals.

## Run protocol (live half, next step)

`web/evals/aurabench/council-panel/prompt.ts` builds the Chair prompt. It
contains `/council-review-aura` over `git diff <base>..HEAD` and a forced roster
(exactly the listed seats, no selection engine, no add/veto/swap). The seat
result cache, the run-stats write and the checkpoint emit are switched off. It
names only the PR number, the PR's own title and the diff range. A test
checks that no defect id, summary, fix sha or distinctive keyword leaks into
the prompt.

Still to build (runner step), following the D2 harness rules:

- a sealed checkout at `head`, so that the later fix commits are not reachable
  (the same `git archive` approach as `diet-overlay.ts`);
- a COPY of the council skills and `_council-experts` in the bench HOME, with
  the port rewritten (as in FIX-D2-2). The live `~/.claude/skills` are never touched;
- the Claude token handled access-only, as in FIX-D2-CLAUDE-AUTH, and the USAGE-CEILING gate;
- per run: FINAL-REVIEW.md + expert files copied into the result, plus cost, wall time,
  number of dispatched subagents (from the stream: the Chair must dispatch
  exactly the forced seats, otherwise the run is invalid), idempotent by
  case × panel.

## Scoring

`web/evals/aurabench/council-panel/score.ts` parses the `## P1|P2|P3` → `### N.`
blocks of FINAL-REVIEW.md and their `**File**` rows. A finding is a candidate
match for a known defect when it points at one of the defect's files (the
path or a path suffix) and, in addition, either its line range overlaps the hint (±20)
or its text contains one of the defect's keywords. Per run it reports:

- recall: known defects found at any priority;
- found-as-P1: known P1s that the run also rated P1;
- unmatched P1: P1 findings matching no known defect. These are false-P1
  **candidates**, not proven false positives, because the PR may have carried
  defects nobody later fixed.

The spec requires a judge and a manual pass by the supervisor on top of this
table. Matching is only the candidate step.

Replay check (in `score.test.ts`): the archived reviews that define the
ground truth score 7/7 (pr54, review 2026-05-15-0336) and 4/4 (pr91, review
2026-06-04-1826) as P1 with zero unmatched P1. A review of a different PR
scores 0 on pr54.

## Results

Pending: the live runner and the 18 runs (under the USAGE-CEILING gate).
