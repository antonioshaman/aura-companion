# AuraBench prompt re-review (P6/FIX-D2-5, 2026-09-28)

## Why

Pilot 1 was declared invalid partly because task prompts gave the solution away in plain English. A spot check found the problem in 2 of 5 prompts:
- `deaf-session-after-server-restart` (#184) named both guard conditions and the exception, which is the whole fix;
- `ask-user-question-answers-dropped` (#82) said "keyed by each question's full text", which is both the cause and the fix;
- `council-degraded-pair-never-recovers` (#53) gave step-by-step instructions.

The deterministic leak check (`leak.ts`) only catches code identifiers, so it could not see any of these. Requirement: re-review all 47 prompts. A prompt describes the observable symptom or requirement, not the cause and not the fix steps. An LLM judge compares each prompt with the PR diff; the prompt is rewritten or the task excluded. In addition, hidden tests run 3× on the merge commit, and flaky tasks are excluded.

## Method

- **Judge**: `bun run eval:aurabench judge` (`prompt-judge.ts`).
  - Runs `claude -p` (`claude-opus-5-5`) with no tools and no user or project settings, with its cwd outside the repo.
  - Structured output, schema `JUDGE_JSON_SCHEMA`: verdict `clean | rewrite | exclude`, plus issues `cause | fix | contract_is_fix | underspecified`, each with a verbatim quote.
  - Input: the prompt, the "required interface" (new names the hidden tests use, from `leak.ts`), the base→merge source diff and the hidden-test diff.
  - The reply parser is fail-closed. A `clean` verdict that lists a cause or fix issue is rejected, not coerced.
- **Calibration**: the rubric quotes the three rulings above (rubric v1).
  - A first, uncalibrated pass judged #82 `clean`, which contradicts the human ruling. It was discarded, the rubric was calibrated, and all 47 prompts were judged again. The uncalibrated pass is not in `prompt-review.jsonl`.
- **Rewrites**: by the executor, guided by each flagged quote. Each rewrite:
  - keeps the symptom;
  - restates acceptance criteria as observable behaviour;
  - keeps every test-pinned contract the repo cannot reveal, labelled "Contract pinned by the tests" where it would otherwise read as a hint;
  - drops the diagnosis and the fix mechanism.

  Every rewrite was judged again until `clean` (rounds r2, r3). The deterministic `eval:aurabench leak` check was re-run after each round and passes 43/43.
- **Exclusion**: verdict `exclude`, i.e. a passable prompt would have to state the fix.
- **Stability**: `bun run eval:aurabench stability` (`flake.ts`) runs the hidden tests 3× on the merge commit in a throwaway worktree. **47/47 passed 3/3**, so no task was excluded as flaky.
- **Gates** (`loader.test.ts`, no LLM or git needed in CI):
  - every committed task has a `clean` verdict for the **sha256 of its current prompt** under the current rubric version, so editing a prompt without re-judging fails the test;
  - every task has a 3/3 stability verdict for its merge commit.

## Result

**25 kept, 18 rewritten, 4 excluded → 43 tasks** (minimum 30):
- feature 13, bugfix 10, ui 7, debug 4, refactor 4, architecture 3, security 2;
- every class is still covered.

| task | judge rounds (issue kinds) | merge runs | outcome |
|---|---|---|---|
| `archive-council-pair-kills-one-half` | r1: exclude (cause, contract_is_fix, fix) | 3/3 | **excluded** |
| `archived-session-cli-survives-restart` | r1: rewrite (cause, fix) → r2: clean | 3/3 | rewritten |
| `archived-sessions-hold-memory` | r1: clean | 3/3 | kept |
| `ask-user-question-answers-dropped` | r1: exclude (contract_is_fix, fix) | 3/3 | **excluded** |
| `claude-adapter-outbound-queue-overflow` | r1: clean | 3/3 | kept |
| `claude-cli-stdio-transport` | r1: rewrite (cause, fix) → r2: clean (underspecified) | 3/3 | rewritten |
| `claude-context-usage-meter` | r1: clean | 3/3 | kept |
| `claude-model-switch-404-strands-session` | r1: rewrite (cause, fix, underspecified) → r2: clean | 3/3 | rewritten |
| `codex-error-notification-shown-as-drift` | r1: rewrite (cause) → r2: clean (underspecified) | 3/3 | rewritten |
| `codex-model-fallback-picks-mini` | r1: clean | 3/3 | kept |
| `codex-observer-dies-not-initialized-race` | r1: exclude (cause, contract_is_fix, fix) | 3/3 | **excluded** |
| `codex-observer-findings-dropped` | r1: rewrite (fix) → r2: rewrite (underspecified) → r3: clean | 3/3 | rewritten |
| `codex-session-spawns-council-pair` | r1: clean | 3/3 | kept |
| `compaction-advisory-on-jsonl-growth` | r1: rewrite (fix) → r2: clean | 3/3 | rewritten |
| `council-checkpoint-producer-endpoint` | r1: rewrite (fix) → r2: clean | 3/3 | rewritten |
| `council-degraded-pair-never-recovers` | r1: rewrite (cause, fix, underspecified) → r2: clean (underspecified) | 3/3 | rewritten |
| `council-lost-review-event-degrades-pair` | r1: rewrite (cause, fix) → r2: clean | 3/3 | rewritten |
| `council-observer-idle-until-first-checkpoint` | r1: rewrite (fix) → r2: clean (underspecified) | 3/3 | rewritten |
| `council-pairing-dropdown-invisible` | r1: rewrite (cause) → r2: rewrite (cause) → r3: clean | 3/3 | rewritten |
| `council-seat-model-tier-decision` | r1: clean | 3/3 | kept |
| `council-watchers-die-silently` | r1: rewrite (fix) → r2: clean | 3/3 | rewritten |
| `deaf-session-after-server-restart` | r1: rewrite (cause, fix) → r2: clean | 3/3 | rewritten |
| `dedupe-assistant-avatar` | r1: clean | 3/3 | kept |
| `drift-detector-blind-on-underscore-cwd` | r1: rewrite (cause, underspecified) → r2: exclude (contract_is_fix) | 3/3 | **excluded** |
| `drift-detector-misses-dead-stdio` | r1: rewrite (cause, fix) → r2: clean | 3/3 | rewritten |
| `eval-compare-variant-delta-report` | r1: clean | 3/3 | kept |
| `extract-empty-chat-state` | r1: clean | 3/3 | kept |
| `extract-resume-indicator` | r1: clean | 3/3 | kept |
| `known-broken-claude-model-substitution` | r1: clean | 3/3 | kept |
| `model-switcher-label-lags` | r1: rewrite (fix) → r2: clean (underspecified) | 3/3 | rewritten |
| `observer-findings-oldest-first` | r1: clean | 3/3 | kept |
| `orphan-reaper-misses-stdio-claude` | r1: clean | 3/3 | kept |
| `own-sandbox-image-no-upstream-registry` | r1: clean | 3/3 | kept |
| `recordings-store-secrets-in-clear` | r1: clean | 3/3 | kept |
| `respawned-cli-forgets-last-message` | r1: clean | 3/3 | kept |
| `resume-discards-conversation-too-eagerly` | r1: clean | 3/3 | kept |
| `resume-hiccup-loses-conversation` | r1: rewrite (fix) → r2: clean | 3/3 | rewritten |
| `session-restore-crash-on-sidecar-json` | r1: clean | 3/3 | kept |
| `session-schema-version` | r1: clean | 3/3 | kept |
| `sessions-lost-on-reboot-tmpdir` | r1: clean | 3/3 | kept |
| `settings-secret-field-saves-mask-dots` | r1: rewrite (cause, fix) → r2: clean | 3/3 | rewritten |
| `sever-self-update-and-upstream-sync` | r1: clean | 3/3 | kept |
| `shutdown-loses-streaming-replies` | r1: rewrite (fix) → r2: clean | 3/3 | rewritten |
| `sidebar-duplicate-provider-chips` | r1: clean | 3/3 | kept |
| `sidebar-pair-chip-duplicates-backend` | r1: clean | 3/3 | kept |
| `silent-stdio-watchdog-false-positives` | r1: clean | 3/3 | kept |
| `task-panel-stale-snapshot-hint` | r1: clean | 3/3 | kept |

Raw data:
- [`prompt-review.jsonl`](prompt-review.jsonl): 68 verdict records across all rounds, with quotes, reasons and prompt hashes;
- [`stability.jsonl`](stability.jsonl): one record per task.

The old prompts can be recovered from git history (the parent of this commit).

## Caveats

- The judge is an LLM of the same family as the agents under test. Calibration anchors it to the human rulings, but "clean" means "no issue this judge found", not "provably leak-free".
- Some prompts keep contracts that point at existing code because the hidden tests pin them, e.g. `scanForMissedObserverWakes("failsafe")`, `normalizeCodexObserverReviewRaw`, and the structural no-`overflow`-clip check. Each is labelled as a test contract. The judge accepted them as unavoidable. They still narrow the search compared with a pure symptom report.
- `underspecified` notes on clean verdicts are minor gaps the judge accepted, for example a store action the test spies on that the agent would naturally find. They can cost an agent a pass even with a correct fix. That hurts every variant equally, so it reduces lift sensitivity but does not bias it.
