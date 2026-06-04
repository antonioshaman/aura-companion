# Context Brief for Aura Council Review (2nd pass — post-burndown)

## What this code does

This is the **second council review** of PR #91 (`feat/dynamic-claude-models`). The first review at `.council/review-output/2026-06-04-0823/FINAL-REVIEW.md` produced 15 findings (7 P1 / 6 P2 / 2 P3). Commit `9d922c0` claims to have closed all 15. **This review's job is to verify the burndown actually addressed each finding without introducing new regressions.**

The PR's underlying scope unchanged from the first review: replace hardcoded Claude model triplet with a live Anthropic `/v1/models` cache (server + frontend lift + APG-conformant ModelSwitcher dropdown).

## Architecture

Same as first review (`.council/review-output/2026-06-04-0823/context-brief.md`). The burndown commit added/modified:

- **New module-scope state** in `anthropic-models-cache.ts`:
  - `signalCoalesceDegradeLogged: boolean` — once-per-process warn flag (P2 #11 fix)
  - `resolveCoalescedSignal()` helper extracted from inline `?? signal` pattern
  - `__resetSignalCoalesceFlagForTests()` reset helper added
- **New slice surface** in `settings-slice.ts`:
  - `anthropicModel: string | null` field (sticky preference — P1 #1)
  - `selectAnthropicModel(s)` selector
  - `hydrateSettings` now accepts + validates `anthropicModel`
  - `loadBackendModels` rejection no longer clobbers known-good data (P2 #9)
- **DOM restructure** in `ModelSwitcher.tsx`:
  - Dropdown is now `wrapper > listbox + sibling footnote` (was: `listbox > footnote-as-child`). P2 #12 a11y fix.
  - `wasOpenRef` tracker added; `queueMicrotask` → `requestAnimationFrame` (P1 #3 fix)
  - Click-outside handler now rAF-restores focus to trigger (P1 #2 fix)
  - New `useEffect` fires `loadBackendModels` on mount (P2 #13 fix)
- **Atomic-write hardening** in `atomic-write.ts`:
  - `mkdirSync` now passes `mode: 0o700`
  - Best-effort `chmodSync(dir, 0o700)` after creation (umask-defensive)
  - Affects ALL writers (env profiles, council artifacts, settings.json)
- **New test infrastructure**:
  - `findEmitWithEvent` helper in `anthropic-models-cache.test.ts` for log-spy assertions
  - `vi.spyOn(log, "info"/"warn")` discipline in two new describe blocks
  - 18 new behavioural tests on the cache module (EC-22 emit-path + disk-cache subsystem)
  - 6 new behavioural tests on ModelSwitcher (focus contract + mount lifecycle + footnote a11y)
  - 5 new tests on settings-slice (sticky preference hydration + inflight-clobber defence)
  - 2 new tests on backends.ts (stable-identity pin)
  - 1 new fixture `anthropic-models-response-hostile.json` exercising parser reject branches

## Stack in use within scope

Same as first review — no new stack surfaces introduced. The burndown is structurally additive (no deletions, no protocol changes).

**Untouched in this PR** (do NOT re-review): `ws-bridge.ts`, `cli-launcher.ts`, `session-orchestrator.ts`, NDJSON/JSON-RPC adapters, council mode, recordings, subprocess spawn argv, ws auth.

## Accepted conventions (relevant subset including the 6 added by Phase 7 of the first review)

The first review's Phase 7 appended these to `conventions.md` — **DO NOT re-flag**:

- **EC-37** PLAN watchpoints demand test + `git grep` of call sites before claiming addressed
- **EC-38** Cache predicates over `Date.now()` MUST clamp negative-skew (`Math.max(0, now - past)`)
- **EC-39** Overlay dismissal MUST restore focus to trigger on EVERY dismissal path
- **EC-40** Test-only escape hatches use static `import`, NOT inline `require()` + `eslint-disable`
- **EC-41** Inflight-token guards MUST prefer success commit when newer token still pending
- **AP-16** `anthropic-models-cache.ts` 1221-LOC is structurally justified by AP-3 co-location

Plus the existing convention floor (EC-1..EC-36, AP-1..AP-15) as documented in `conventions.md`.

## Key observations (for this 2nd-pass review)

The first review's 15 findings should be verifiable as closed by reading the burndown. Reviewers should focus on:

1. **Regression check** — did the burndown introduce any NEW issues while fixing the old ones? Common shapes: tight-coupling additions, test infrastructure leaking into production, JSDoc/code drift increase.
2. **EC-37 self-application** — the burndown was supposed to address each P1 with both a test AND a call-site verification. Did the burndown's own tests + code align (e.g., is sticky preference actually called from production paths, not just unit-tested)?
3. **EC-41 application** — the inflight-clobber fix introduces "soft-rejected" semantics (status="rejected" but data preserved). Is this discriminated-union state machine clean, or does it silently leak through the cracks?
4. **Atomic-write change is transitive** — every writer that goes through `writeAtomicJson` now gets 0o700 parent dir. Did the burndown verify no test relied on the old umask-default mode?
5. **DOM restructure in ModelSwitcher** — moved footnote OUTSIDE listbox, made it `<a href="#/settings">`. Did this break any test that grepped by structural position (`within(listbox).queryBy...`)?
6. **`signalCoalesceDegradeLogged` is module-scope** — process-lifetime, not per-test. The test reset helper exists but is only useful if every test that depends on the warn calls it. Does any orchestrator test inadvertently consume the warn flag from a prior test?
7. **`resolveCoalescedSignal` adds an indirection** — does it preserve the prior shape's correctness? Particularly: does the warn-once flag interact correctly with the per-test mock setup that `mockImplementation(() => undefined)`s the `log.warn` global?
8. **Hostile fixture** — the new fixture deliberately includes invalid entries. Test assertions are documented in `fixtures/README.md`. Any drift between fixture content + README count + test assertion?
9. **EC-30 token budget** — the burndown commit is ~3818 LOC across 31 files. Should the burndown have been split into multiple commits? Per the brief's PR provenance ("not yet human-reviewed"), a multi-commit shape would be easier to bisect.
10. **EC-22 emit-path tests are behavioural** — first review demanded them; burndown delivered 9 tests using `vi.spyOn(log)`. Beck should verify: did the tests assert the right field shapes? Are any using lenient `expect.anything()` assertions that would pass on incorrect emit?

## Automated check results

- **Typecheck**: `bun run typecheck` — clean, exit 0.
- **Tests**: `bun run test` — **255 files / 6683 pass / 4 skipped**. +31 since first review baseline.
- **A11y dedicated**: `bun run test:a11y` — **41 files / 67 pass / 214 skipped (out-of-scope)** — green.

**Pre-existing failures**: none — clean baseline. Any new finding cannot attribute to prior breakage.

## Domain File Assignments

**Hunt (Security):** `web/server/anthropic-models-cache.ts` (new `resolveCoalescedSignal`, `signalCoalesceDegradeLogged` module-scope flag, clock-skew clamp), `web/server/atomic-write.ts` (parent dir mode 0o700 + chmod retrofit transitively affects every writer)

**Fowler (Refactoring):** `web/server/anthropic-models-cache.ts` (helper extraction + flag), `web/src/store/settings-slice.ts` (slice JSDoc invariant now widened with `anthropicModel` + soft-rejected status semantics), `web/src/components/ModelSwitcher.tsx` (wrapper/listbox/sibling restructure + `wasOpenRef`)

**Bun/Hono/TS Backend Expert:** `web/server/anthropic-models-cache.ts` (clamp + signal coalesce + new helper), `web/server/atomic-write.ts` (umask-vs-mode discipline + chmod best-effort), `web/src/store/settings-slice.ts` (loadBackendModels reject-clobber defence)

**FS-JSON Persistence Expert:** `web/server/anthropic-models-cache.ts` (clock skew clamp), `web/server/atomic-write.ts` (mkdirSync mode + chmod), `web/server/fixtures/anthropic-models-response-hostile.json` + `web/server/fixtures/README.md` (fixture coverage + line→reason map)

**Realtime/NDJSON Protocol Expert:** `web/server/anthropic-models-cache.ts` (parser boundary unchanged; signal coalescing is an HTTP boundary concern — verify EC-5 disciplines still hold against the new helper)

**Subprocess Lifecycle Expert:** No changes — domain returned 0 findings in first review. SKIPPED unless reviewer wants to verify hold-the-line still holds.

**React/Web UI Expert:** `web/src/components/ModelSwitcher.tsx` (focus contract, footnote restructure, mount fetch, `wasOpenRef`), `web/src/components/HomePage.tsx` + `web/src/components/CronManager.tsx` (sticky preference plumbed through call sites), `web/src/components/SettingsPage.tsx` (hydration on save), `web/src/store/settings-slice.ts` (new selector + soft-rejected status)

**a11y Auditor:** `web/src/components/ModelSwitcher.tsx` (focus contract on both dismissal paths; footnote moved OUTSIDE role="listbox"; new behavioural tests pin both)

**Saarinen (UI Quality):** `web/src/components/ModelSwitcher.tsx` (DOM restructure: dropdown wrapper now holds listbox + footnote as siblings — verify visual stacking + shadow not regressed)

**Friedman (UX Quality):** `web/src/components/ModelSwitcher.tsx` (footnote is now `<a>` link + closes dropdown on click), `web/src/components/HomePage.tsx` (sticky preference flow), `web/src/components/SettingsPage.tsx` (post-save hydration triggers list refetch)

**Willison (LLM Pipeline):** `web/server/anthropic-models-cache.ts` (hostile fixture coverage); `web/src/components/ModelSwitcher.tsx` (still renders Anthropic-controlled strings — verify no NEW XSS surface from footnote `<a>` href)

**Beck (Test Quality):**
- `web/server/anthropic-models-cache.test.ts` (+409 LOC, ~18 new tests with `vi.spyOn(log)` + disk-cache behavioural + single-flight reject pin)
- `web/server/fixtures/anthropic-models-response-hostile.json` + `web/server/fixtures/README.md` (fixture-to-test alignment)
- `web/src/store/settings-slice.test.ts` (+54 LOC, 5 new tests for sticky + inflight defence)
- `web/src/utils/backends.test.ts` (+28 LOC, 2 new tests + 1 rewritten)
- `web/src/components/ModelSwitcher.test.tsx` (+121 LOC, 6 new behavioural tests)
- `web/src/components/HomePage.test.tsx` (+9 LOC, lifecycle assertion restored)
- `web/src/components/Composer.test.tsx` (+4 LOC, mock extension)
- The corresponding source files they exercise.

**Docker/GHA Deploy:** SKIPPED — no Dockerfile / workflow / scripts changes in the burndown.

---

**Reminder for every expert:** the goal of THIS pass is to verify the burndown's claim of "15/15 closed" and to surface ANY new findings the burndown introduced. Do NOT re-flag items already addressed in the PLAN-aura-dynamic-model-list.md "Risks & Watchpoints" section. Do NOT re-flag items the conventions floor (EC-1..EC-41, AP-1..AP-16) already covers. The first review's 15 findings are documented at `.council/review-output/2026-06-04-0823/FINAL-REVIEW.md` — confirm each is closed and look for residual concerns the burndown may have introduced.
