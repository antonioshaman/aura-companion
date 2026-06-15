# Eval memory

Durable, append-only JSONL logs the post-hoc Evaluator writes and mines across
runs. Distinct from `~/.companion/recordings/` (raw protocol capture) — this is
*scored* memory: what the harness concluded, when, and why.

All logs in here are **append-only JSONL, last-write-wins by record `id`** (the
same idiom as `parseLabelLog`): re-recording an entry with the same id supersedes
the earlier line on read instead of duplicating it. Blank lines are ignored;
malformed lines are skipped, never thrown.

## `regressions.jsonl` — CI-gate baseline drifts

Written by `eval:replay --ci --record-regressions` (OPT-IN; the default gate
stays pure — no clock, no writes — so only its exit code is load-bearing). One
record per detected drift of the synthetic fixture corpus from `ci-baseline.json`.

Schema (`memory/regression-log.ts`, `EVAL_REGRESSION_VERSION = 1`):

| field | meaning |
|---|---|
| `eval_regression_version` | format version (`1`) |
| `id` | `reg_<hex>` — stable hash of the sorted drift signature (idempotent) |
| `recorded_at` | server-clock ISO timestamp, injected at the call boundary |
| `fixtures_scored` | total fixtures scored in the run |
| `drifted_fixtures` | how many drifted |
| `diffs[]` | the human-readable drift lines, verbatim from `diffAgainstBaseline` |
| `git_sha` | best-effort repo HEAD at record time (optional) |

The id hashes the drift, not the clock — the same regression collapses to one
logical entry however many times it is re-recorded.

## `failures.jsonl` — golden-task failures (reserved)

Reserved for the golden-task *executor* that runs a task (`tasks/*.yaml`) against
an agent and scores the result against its rubric. That executor needs live LLM
calls and is **out of v1 (L1) scope** — the file is seeded here so the convention
path is stable for the layer that lands it. No v1 writer touches it.
