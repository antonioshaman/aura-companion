# COUNCIL-PANEL-BENCH — which council panel buys the most P1 recall per dollar (harness ready; results pending)

B4 measured the economy dispatch policy only by replaying archived reviews
(median seats 8 → 4, but 27/49 P1s lost under the assumption that experts are
independent). The human's decision of 2026-09-29 asks for a live measurement:
6 historical PRs with known defects × 3 panels = 18 runs of
`/council-review-aura`. This file describes the offline half (cases, panels,
scoring) and the live runner. The results section comes after the live runs.

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

## Run protocol (live half)

`web/evals/aurabench/council-panel/prompt.ts` builds the Chair prompt. It
contains `/council-review-aura` over `git diff <base>..HEAD` and a forced roster
(exactly the listed seats, no selection engine, no add/veto/swap). The seat
result cache, the run-stats write and the checkpoint emit are switched off. It
names only the PR number, the PR's own title and the diff range. A test
checks that no defect id, summary, fix sha or distinctive keyword leaks into
the prompt.

The runner (`web/evals/aurabench/council-panel/run.ts`, `eval:council-panel run`)
follows the D2 harness rules. One run = case × panel × rep:

1. **Sealed checkout** (`sealed.ts`). `base` and `head` are materialised with
   `git archive` in the main repo and committed into a fresh `git init` as two
   commits, `base' → head'`. No fetch, no history, so no object of a later fix
   commit reaches the checkout. Archived council artefacts are removed from
   BOTH trees: `.council/{review-output,handoffs,implementation-logs,plan-output,reviews,abtest}`
   and `docs/history`. This matters: the head of #91 carries
   `.council/review-output/2026-06-04-1826/`, the very review that defines #91's
   known defects. Smoke on this clone for pr91: 2 commits in the checkout, no
   `2026-06-04-1826` object, the fix tree of #92 absent; the reviewed diff went
   from 37 files to 23 (the 14 dropped are review artefacts). The prompt
   names the sealed base. Repo-shipped skills (`.agents/skills`,
   `.claude/skills`) are scrubbed too: the CLI loads them from the checkout,
   and the repo's `harden` shares its name with a real user skill, so the first
   live run was `invalid_isolation`. No case diff touches these directories.
2. `bun install --frozen-lockfile` in `web/` (best effort; a failure is a
   confound, since reviewers may want to run tests).
3. **Skill copy in a per-run HOME.** `council-review-aura` and
   `_council-experts` are copied (dereferenced) from the real
   `~/.claude/skills`, which is only read. Every `localhost:3456` is rewritten
   to `127.0.0.1:9` (nothing listens there, so the checkpoint-emit probe fails
   and the phase is skipped). The skill spells its paths `~/.claude/skills/…`,
   so both `HOME` and `CLAUDE_CONFIG_DIR` point into the run home. Run-stats
   and the result cache (`~/.companion/…`) would land there too, never in
   prod's dataset.
4. **Chair**: `claude -p` with the pinned model (default `claude-opus-5-5`),
   `--strict-mcp-config`, `--include-hook-events`, and the bare access token
   in `CLAUDE_CODE_OAUTH_TOKEN`. The refresh token never leaves
   `~/.claude/.credentials.json` (P6/FIX-D2-CLAUDE-AUTH).
5. **Evidence and validity** (`dispatch.ts`). From the Chair's stream-json,
   every top-level `Agent`/`Task` call is one dispatch. Its seat is read from the
   prompt: the output path `review-output/<TS>/<seat>.md`, else the catalog
   path. The seated set must equal the forced set, otherwise the status is
   `invalid_roster`. The init frame must list `council-review-aura` and no
   other user skill, no plugin, no MCP server and no hook event; the run home
   must hold no credentials file afterwards. Otherwise the status is
   `invalid_isolation`. No FINAL-REVIEW.md gives `no_review`. Only `completed`
   runs are `valid`.
6. **Record**: one JSONL line per run in `<bench-root>/council-panel/results.jsonl`.
   It holds the forced seats, the dispatch check, per-seat expert files, the
   score (recall, found-as-P1, unmatched-P1 candidates), cost / tokens / turns,
   wall time, isolation evidence and the prompt sha. Artifacts go to
   `<bench-root>/council-panel/runs/<case>/<panel>-<rep>/`: prompt, raw
   transcript, the copied review directory, and the run home.

The loop is idempotent by `case|panel|rep`, and a recorded run of any status
is not redone. It uses the same gates as the D2 driver: the USAGE-CEILING hold
(15-min recheck); the Claude token must outlive the run timeout + 10 min;
a fatal gate (prod OAuth dead) is confirmed 3× and then exits 4. A usage
limit sleeps until the reset and retries the same run. Memory below 1.5 GB
waits. Checkouts live under `--wt-root`, outside the bench root and the repo.

Command for the 18 live runs (only after D2-full stage 1, under the same gate):

```bash
cd web && env $(env | grep -oE '^AURA_[A-Z_]+' | sed 's/^/-u /') NODE_OPTIONS=--max-old-space-size=2560 \
  bun run eval:council-panel run --bench-root /home/auracomp/aura-diet/bench \
  --wt-root /home/auracomp/aura-diet/wt-cells --reps 1 --timeout-min 90
```

Start with `--max-runs 1` and check the first record: `status`, the init-frame
skills, and `dispatch.seated`.

Smoke (2026-10-01, after the skill scrub): `pr54|FULL|1` → `completed`, valid,
isolated (init skills: `council-review-aura` plus CLI built-ins only, builtin
plugins, no MCP, 0 hook events), 11/11 seats dispatched, 11/11 expert files,
recall 5/7, 549 s. The aborted pre-fix record is kept in
`bench/council-panel/invalid-smoke-20261001/`, outside the results file.

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

Pending: the 18 live runs (under the USAGE-CEILING gate, after D2-full stage 1).
