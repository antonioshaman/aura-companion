---
name: karpathy
origin: aura
description: Four behavioural principles to reduce common LLM coding mistakes — surface assumptions, keep it simple, edit surgically, drive by verifiable goals. Apply when writing, reviewing, or refactoring code.
user-invokable: true
args:
  - name: focus
    description: Optional area to bias the principles toward (e.g. "review", "planning", "refactor")
    required: false
---

Four principles, derived from [Andrej Karpathy's observations](https://x.com/karpathy/status/2015883857489522876) on LLM coding pitfalls and packaged by [forrestchang/andrej-karpathy-skills](https://github.com/forrestchang/andrej-karpathy-skills) (MIT). Apply them as a behavioural checklist before and during non-trivial code work.

**Tradeoff:** these principles bias toward caution over speed. For trivial edits (typos, obvious one-liners), use judgement.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them — don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If 200 lines could be 50, rewrite.

The test: would a senior engineer call this overcomplicated? If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd write it differently.
- If you notice unrelated dead code, mention it — don't delete it.

When your changes create orphans:
- Remove imports/vars/functions that YOUR change made unused.
- Don't remove pre-existing dead code unless asked.

The test: every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step work, write the brief plan with a verify step per item:

```
1. [step] → verify: [check]
2. [step] → verify: [check]
3. [step] → verify: [check]
```

Strong success criteria let the loop close itself. Weak criteria ("make it work") force constant clarification.

## How this skill is used

- **`/prime` auto-loads** the Karpathy patterns (`pat-karpathy-001..004` in `patterns.jsonl`) when the focus matches `karpathy`, `behavioural`, `meta`, `planning`, `simplicity`, `scope-control`, or `tdd`. They surface as a compact checklist alongside other relevant knowledge.
- **`/karpathy [focus]`** explicitly loads the full text of all four principles into the current session — useful before starting a non-trivial change, a code review, or a refactor.
- **`/learn`** can re-confirm a Karpathy principle when it visibly shaped a decision; that bumps `helpfulCount` on the matching pattern entry instead of duplicating it.
- **`/self-reflect`** treats violations of these principles as signal: a PR with churn beyond the user's request gets logged as a `surgical-changes` near-miss; a 200-line solution to a 50-line problem gets logged as a `simplicity` near-miss.

## Working in success-criteria mode

When the user gives a vague task, do not start coding. Restate it as a goal first:

> User: "make the search faster"
> Agent: "Faster how — response time, throughput, or perceived speed? Current p50 is ~500ms. If response time, I'll add an index on `title`, target <100ms, verify with a benchmark test. Confirm?"

When the user gives a clear task, write the plan with verify steps before touching code:

> 1. Add `idx_messages_session_id` migration → verify: `bun run migrate` succeeds, EXPLAIN shows index used
> 2. Update query in `messages-store.ts` → verify: existing tests pass, new test for index path passes
> 3. Run full suite → verify: `bun run test` green

## Attribution

The four principles are from [Karpathy's tweet](https://x.com/karpathy/status/2015883857489522876) and the curated [andrej-karpathy-skills](https://github.com/forrestchang/andrej-karpathy-skills) repo (MIT). This skill is the Aura-side wrapper; the principles themselves are not ours.
