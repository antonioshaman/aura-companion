# Spec: Council Eval Harness

**Date:** 2026-06-14
**Status:** Draft

## Vision

Council Mode pairs an orchestrator with a live observer, which is already stronger than "one agent did the work and praised itself." But there is no measurement of whether the observer is actually *good* — whether its STOPs are right, whether it misses known bugs, whether a skill helps or just burns tokens. The Council Eval Harness adds a post-hoc **Evaluator** layer that turns Council Mode from a capable assistant into a measurable QA lab: given recorded sessions and a small golden-task suite, it scores observer precision/recall, regression, and token cost — and gates PRs on those scores. **Why now:** the project runs on two cheap subscriptions ($100 Claude Pro 5x + $20 Codex), so we cannot afford to evolve the observer blind, and we cannot afford an eval layer that itself burns the same quota on every PR. The bet: deterministic, replay-based scoring (zero LLM cost) is enough to catch observer quality regressions, with LLM judges reserved for occasional manual calibration.

## Problem Statement

Today the observer's quality is invisible. When PR #119–#121 tuned observer wake/catch-up gating, the only validation was a single live session watched by hand (`grp_473ae4de`). There is no way to answer: did this change increase false STOPs? Did it stop catching the known Council Mode race? Did a `/council-*` skill actually improve outcomes or just add token cost? SWE-Skills-Bench found 39 of 49 SE skills gave no pass-rate gain (avg +1.2%, some negative) — without measurement we risk building a beautiful, expensive ritual machine. The grounding gate (`observer-grounding.ts`) already emits structured downgrades, and the server records every session to JSONL (`replay.ts` loads them), so the ground truth exists on disk and is currently unused for scoring.

## Target Users

### User segment 1: Aura maintainer (you)
- **Context:** About to merge a PR that changes observer wake logic, prompt bundle, or grounding rules.
- **Primary need:** A pass/fail signal that the change did not regress observer precision/recall on a known corpus, costing zero subscription tokens.
- **Success looks like:** `bun run eval:replay` runs in CI and blocks the PR when observer-precision or recall drops below threshold.

### User segment 2: Aura maintainer evaluating skills/models
- **Context:** Deciding whether a skill (`/council-review`, `/prime`) or a pairing (`claude+claude` vs `claude+codex`) is worth its token cost.
- **Primary need:** A scorecard comparing quality, time, and token cost across variants — run deliberately, not on every PR.
- **Success looks like:** A markdown scorecard that shows per-metric deltas so a skill or pairing can be kept or dropped on evidence.

## Scope

### In scope (v1)
- An **Evaluator** module distinct from Observer: runs post-hoc against recordings, never live.
- **L1 deterministic scorers (zero LLM cost):** `observer-precision.ts` (precision/recall/false_stop_rate/missed_blocker_rate from grounding downgrades vs. human labels) and `cost-latency.ts` (token + latency from recording entries).
- **Eval sidecar artifact:** opt-in (env-flagged) `.council/eval/<checkpoint>.json` written at review time = `{rawObserverReview, modifiedFiles, groundingResult}`. This is the input that the WS recording does **not** carry; it is what makes grounding-gate re-runs and recall scoring possible across Aura versions. The protocol recording is left untouched.
- **Replay-runner** wrapping the existing `loadRecording`/`filterEntries` to read scores from recordings, and reading the eval sidecar to re-run the grounding gate against a checked-out version.
- **Golden-task suite of 8–12 tasks** (not 30–100) under `web/evals/tasks/*.yaml`, each with start commit, prompt, expected files/tests, expected failure modes, scoring rubric. **Synthetic/modeled fixtures are the default**; real-project recordings are optional.
- **Eval Memory** as JSONL in the existing knowledge convention: `web/evals/memory/{failures,regressions}.jsonl`, `web/evals/judge-calibration/human-labels.jsonl`, `web/evals/tasks/`.
- **`scorecard.ts`** producing a text/markdown report to stdout.
- **CI gate `eval:replay`** blocking on L1 thresholds only, scored as **"no regression vs. main's score"** rather than fixed absolute bars.
- **Interactive label-collection flow:** an AskUserQuestion / plan-mode Q&A that walks the maintainer through labeling findings (correct STOP / false STOP / missed blocker), seeded from **synthetic fixture recordings** first (real-project recordings optional), writing to `human-labels.jsonl`.

### Out of scope (v1) — future consideration
- LLM-as-judge, cross-model `eval:compare` (interface designed; execution is L2/manual, not CI).
- `eval:redteam` (promptfoo prompt-injection/leakage probes) — its own security spec.
- A/B skill testing automation (metric defined; automated with/without-skill runs deferred — they cost real quota).
- Dashboard UI.

### Non-goals
- **Not a live-path change.** The Evaluator never runs inside an active session and must not affect orchestrator/observer latency.
- **Not optimized for breadth of judges.** v1 trusts deterministic + human-labeled ground truth over many LLM opinions.
- **Not a general benchmark runner** for other repos — it scores *this* project's observer.

## Stories

### Feature area 1: Evaluator core + replay scoring

#### Story 1.1: Score observer precision/recall from a recording
**When** I have a recording of a Council session with human labels, **I want to** replay it through the grounding pipeline and get precision/recall, **so I can** know if the observer's STOPs are trustworthy.

**Acceptance Criteria:**

Given a valid recording JSONL and a matching human-labels file
When I run the replay scorer against it
Then it outputs stop_precision, stop_recall, false_stop_rate, and missed_blocker_rate with zero LLM API calls

Given a recording whose header version is unsupported or whose body is truncated
When I run the replay scorer
Then it fails with a clear error naming the file, and emits no partial score

Given a recording that has no human labels yet
When I run the replay scorer
Then it skips precision/recall, reports the recording as "unlabeled", and exits non-error so unlabeled data never silently counts as a pass

Given an eval sidecar present for a checkpoint (rawObserverReview + modifiedFiles)
When I re-run the grounding gate against the current checkout
Then recall is computed (findings the gate should have surfaced vs. human labels) and a delta is reported when the current code disagrees with the recorded groundingResult

#### Story 1.2: Score token cost and latency from a recording
**When** I review a session, **I want to** extract token usage and time-to-result from the recording, **so I can** track token_cost_per_accepted_fix without instrumenting the live path.

**Acceptance Criteria:**

Given a recording containing result/usage frames
When I run the cost-latency scorer
Then it reports total tokens and wall-clock latency derived only from recorded entries

Given a recording missing usage frames
When I run the cost-latency scorer
Then it reports tokens as "unavailable" rather than zero, so absent data is not mistaken for a free run

### Feature area 2: Golden tasks + scorecard

#### Story 2.1: Define a golden task as data
**When** I want a reproducible benchmark for a known bug class (WebSocket regression, observer false STOP, Codex contract break, session recovery), **I want to** declare it as a YAML file, **so I can** re-run it across Aura versions.

**Acceptance Criteria:**

Given a task YAML with start_commit, prompt, expected_files, expected_tests, failure_modes, and rubric
When the harness loads the tasks directory
Then each task is validated against the schema and rejected with a field-level error if incomplete

Given a task YAML referencing a start_commit that does not exist in the repo
When the harness loads it
Then it reports the bad commit and excludes the task rather than aborting the whole run

#### Story 2.2: Produce a scorecard
**When** a replay/eval run completes, **I want to** see a single scorecard, **so I can** decide pass/fail at a glance.

**Acceptance Criteria:**

Given a completed run over labeled recordings
When the scorecard renders
Then it shows each metric, its threshold, and pass/fail, in both text and markdown

Given a run where every input was unlabeled or excluded
When the scorecard renders
Then it reports "no scoreable inputs" and the CI gate treats it as a failure, not a vacuous pass

### Feature area 3: CI gate + calibration

#### Story 3.1: Gate PRs on L1 scores only
**When** I open a PR touching observer logic, **I want to** have CI run `eval:replay` and block on deterministic thresholds, **so I can** prevent silent observer regressions without spending tokens.

**Acceptance Criteria:**

Given a PR whose changes drop stop_precision or stop_recall below the configured threshold on the labeled corpus
When `eval:replay` runs in CI
Then the job fails and names the metric and the regressing recordings

Given a PR run of `eval:replay`
When the job executes
Then it makes zero LLM/subscription API calls (verifiable: no judge invocation in logs)

#### Story 3.2: Collect human labels interactively
**When** I have unlabeled recordings, **I want to** be walked through labeling each finding via a plan-mode Q&A, **so I can** build the ground-truth corpus without hand-editing JSONL.

**Acceptance Criteria:**

Given a set of unlabeled findings from synthetic fixture recordings (real-project recordings optional)
When I run the label-collection flow
Then for each finding I am asked to classify it (correct STOP / false STOP / missed blocker / note) and my answer is appended to human-labels.jsonl

Given I abandon the labeling flow midway
When I re-run it
Then already-labeled findings are skipped and only unlabeled ones are presented, so labels are never duplicated or lost

## Technical Context

- **Stack:** Bun + TypeScript, Vitest. Reuse `web/server/replay.ts`, `recorder.ts` types, `observer-grounding.ts` (`GroundingDowngrade`/`GroundingResult`), `council-types.ts`.
- **Code location (resolved):** in-repo under `web/evals/` — not a separate package/repo. Native CI, zero version-skew on the scorer-vs-current-code path. Scorers depend **only on the artifact format** (recording + eval sidecar), not on importing live `server/` modules, so they stay portable across Aura versions; only the grounding-rerun path imports a specific version's `observer-grounding.ts`. The published npm package is unaffected (`package.json` `files` ships only `bin/`, `server/`, `dist/`).
- **Execution isolation (resolved):** baseline/golden runs that spawn claude/codex run as **isolated subprocesses (own tmux/process)**, never under the dev CLI/dev server. This is a runtime concern, orthogonal to code location.
- **Eval sidecar:** emitted server-side at review time behind an env flag, into `<workspace>/.council/eval/`. Carries the grounding inputs (rawObserverReview, modifiedFiles) the WS recording omits. Off by default; does not change the protocol recording.
- **Integrations:** None new for L1. L2 judges (future) reuse the existing Claude/Codex CLI subprocess path.
- **Constraints:** L1 path makes **zero** LLM calls. Recordings read from `~/.companion/recordings/` (or `COMPANION_RECORDINGS_DIR`).
- **Existing systems:** Must interoperate with the JSONL recording format and the grounding gate's downgrade output; must not alter live `ws-bridge`/observer behavior.

## Boundaries

### ✅ Always
- New scorers and the replay-runner ship with Vitest tests, including a replay-based regression test (per EC-6) using a checked-in fixture recording.
- All eval artifacts (tasks, labels, memory) live under `web/evals/` as schema-validated YAML/JSONL.
- L1 scorers read recordings read-only and make zero LLM calls.

### ⚠️ Ask first
- Adding any LLM-judge / cross-model / red-team execution to the CI gate (default: advisory, off the blocking path).
- Adding new npm dependencies (e.g. promptfoo) for L2.
- Changing grounding-gate output shape that scorers depend on.
- Expanding the golden suite beyond ~12 tasks (each baseline run costs subscription quota).

### 🚫 Never
- Run the Evaluator inside a live session or on the orchestrator/observer hot path.
- Commit real recordings containing secrets/tokens as fixtures without redaction.
- Let an unlabeled or empty corpus produce a passing CI result.
- Modify observer/ws-bridge behavior from within the eval layer.

## Success Metrics

### Launch criteria (v1 is done when)
- `bun run eval:replay` scores a labeled fixture corpus and exits non-zero on a seeded precision regression, with zero LLM calls.
- 8–12 golden tasks load and validate; at least 4 cover distinct bug classes (WebSocket, observer false STOP, Codex contract, session recovery).
- The interactive label flow can build `human-labels.jsonl` from a real project's recordings.
- A scorecard renders in text + markdown.

### 30-day success
- The labeled corpus reaches ≥20 findings across ≥10 recordings.
- At least one real observer-logic PR is caught or cleared by the `eval:replay` gate.

## Recommended Decomposition

### Phase 1: Evaluator core + replay scoring (foundation)
- Story 1.1 + 1.2 — replay-runner + L1 scorers over existing recordings. No new infra; pure functions over `loadRecording` output.

### Phase 2: Golden tasks + scorecard
- Story 2.1 + 2.2 — task schema, loader, scorecard rendering.

### Phase 3: CI gate + calibration
- Story 3.1 + 3.2 — wire `eval:replay` into CI; build the interactive label-collection flow seeded from om_event_bot recordings.

Each phase can become its own Feature-tier spec before implementation.

## Assumptions

- Precision (observer output quality vs. labels) is computable from the recording alone — `observer_review` frames carry `findings` + `downgrades` (verified in `session-orchestrator.ts:1365-1382`). *(confirmed)*
- Recall and grounding-gate re-runs require the eval sidecar (`modifiedFiles` + rawObserverReview), since neither is in the WS recording. *(confirmed — drives the sidecar scope)*
- Baseline golden-task runs execute on this prod box (65.108.82.189) on the maintainer's subscriptions; 8–12 cap is to bound that quota cost. *(confirmed)*
- CI gate blocks L1 only, scored as "no regression vs. main"; L2 judges advisory. *(confirmed)*
- Layer name is "Council Eval Harness", directory `web/evals/`, in-repo. *(confirmed)*
- Ground-truth labels are collected interactively, seeded from synthetic fixtures first; real-project recordings optional. *(confirmed)*

## Open Questions

- Exact shape + env-flag name for the eval sidecar, and whether it should also capture the manifest `delta/carried/dropped` partition (from `buildObserverContextManifest`) or just the flat `modifiedFiles` set. (Phase 1 detail.)
- How many synthetic fixtures are enough to make a "no regression vs. main" gate stable rather than noisy on a tiny corpus? (Calibrate during Phase 3.)
- Should the sidecar be retro-fittable to existing live groups, or only emitted for new sessions once the flag ships? (Affects how fast the corpus can grow.)

---

*After implementing each phase, compare results against the acceptance criteria for that phase's stories and list any unmet requirements.*
