# Kent Beck — Test Quality Review

PR #91 (`feat/dynamic-claude-models`, commit `fdf88e0`). Files reviewed: every test file in scope + the corresponding source surfaces. Findings stay in the test lane.

Headline: ~89 net new `it()` blocks (NOT the claimed 60 — count check below). Strong parser/sort coverage, strong APG keyboard coverage, clean fixture-replay. Two material gaps land at **P1** (EC-22 emit-path assertions explicitly called out by the PLAN as a watchpoint, AND the entire disk-cache subsystem is unrendered behaviourally). The HomePage rewrite weakens the consumer-contract assertion. The Composer extension is acceptable. The reset-helper paranoia is fine.

---

## P1 — Fix Now

### P1-Beck-1: EC-22 emit-path coverage is NOT delivered — PLAN watchpoint missed

`anthropic-models-cache.test.ts` does NOT assert ANY structured-log emission. `grep "log\.\|event:"` against the test file returns zero hits.

The PLAN's "Risks & Watchpoints" explicitly states:
> **EC-22 emit-path coverage:** Every structured log line in Task 6 (`hit | miss | stale | refresh | fetch_failed | parse_failed | schema_mismatch | fingerprint_mismatch`) requires a behavioural assertion test in Task 7. Typecheck pin is not sufficient.

The source emits at least 10 distinct `event` strings: `anthropic-models.{no-key, cache.hit (memory & disk variants), cache.miss, upstream.success, upstream.auth-failed, upstream.unavailable, upstream.parse-failed, stale-served, cache.write-failed, pagination-needed}`. Zero of these are asserted to fire. This is the canonical "the red step is the proof" failure — the code compiles, the discriminated union switch is exhaustive, but a future refactor that swaps `event: "anthropic-models.cache.hit"` for `event: "anthropic.cache.hit"` will silently break operator forensic-triage and every dashboard / log search built on those names. Pair with a `vi.spyOn(log, "info")` + `vi.spyOn(log, "warn")` per outcome branch, asserting the `event` name + at least `key_fingerprint` shape.

This is the same gap as `feedback_council_documented_contract_canary` — JSDoc + plan invariants are doku, not enforcement. Pull the invariant into a test or it silently regresses.

### P1-Beck-2: Disk cache subsystem is behaviourally unrendered

`writeDiskCache`, `readDiskCache`, the EC-7 `assertCachePathInBounds`, the 5 distinct `DiskReadResult` reasons (`enoent`, `parse`, `schema`, `fingerprint-mismatch`, `stale`), the Persistence R3 **stale-served-on-upstream-fail** fallback, and the 0o600 mode + atomic-write contract — none are directly tested. `__deleteDiskCacheForTests` was added because the orchestrator test inadvertently pollutes the real disk path, proving the disk path IS being exercised — but it's exercised silently, with no assertion on the file's existence, contents, schema_version, fingerprint, or mode bits.

Tests missing (named by behaviour, not method):
1. *Cold start with disk-only cache returns `source: "disk"` and warms memory.* (warm-start path)
2. *Upstream 500 + disk-stale-beyond-ceiling returns `source: "disk"` not `upstream-unavailable`.* (Backend R2 / Persistence R3 stale-served — load-bearing for availability)
3. *Disk cache with mismatched schema_version → cache-miss + re-fetch (NOT silent migration).*
4. *Disk cache with mismatched fingerprint → cache-miss + re-fetch (key rotation invalidation persists across restart).*
5. *Disk write payload does NOT contain raw apiKey bytes (Persistence R3 — substring of last 8 chars).*
6. *`has_more: true` upstream response logs `pagination-needed` canary.*

These are not edge cases — they are the documented contract of Task 4 + 5. Risk-calibrated coverage (Beck Principle 4): the cache is the highest-risk module in this PR per the PLAN's own "Most critical expert domain: Persistence-FS combined with Hunt — the cache invalidation predicate is the load-bearing correctness invariant." Heavy testing on the pure parser (~25 tests across envelope + per-item + sort + fingerprint) is inversely proportional to the risk profile.

### P1-Beck-3: HomePage rewrite weakened consumer-contract assertion

The deleted test `"fetches dynamic models for codex backend"` asserted that `mockApi.getBackendModels` produced `"GPT Custom"` and the label rendered. The new test `"renders dynamic models from the settings-slice when the slice is populated"` mutates `mockStoreState.dynamicBackendModels` directly and asserts the label renders.

The new test no longer proves the **lifecycle wiring**: `HomePage.tsx:271-273` runs `useEffect(() => { void loadBackendModels(backend); }, [backend, loadBackendModels])` on mount AND backend-switch. The mock `loadBackendModels: vi.fn(async () => undefined)` exists in `mockStoreState` but is never asserted-called. A regression that drops the `useEffect` (e.g., a refactor that lifts the mount-load to a global app effect) would pass this test silently with the slice pre-warmed.

This is exactly Beck Principle 2 / Desideratum **Specific** failure: the test no longer pins behaviour, it pins a render snapshot. Cross-reference `feedback_verify_test_bodies_not_just_names` and `feedback_call_site_presence_not_just_symbol_export` — symbol exists in mock + asserts on output but the call site is unverified. Add `expect(mockStoreState.loadBackendModels).toHaveBeenCalledWith("codex")` to the rewritten test.

The settings-slice tests prove the *action's lifecycle*, but the **consumer-contract** (HomePage actually invokes it on mount + on backend-switch) is now unowned across the suite. The two together are not equivalent to the one deleted test.

---

## P2 — Fix Soon

### P2-Beck-4: PR description claims "60 new tests" — actual delta is ~89

`git diff main..HEAD | grep "^+ *it("` count by file:
- `anthropic-models-cache.test.ts`: 55 new
- `routes.test.ts`: 5 new (1 deleted)
- `settings-slice.test.ts`: 5 new
- `backends.test.ts`: 9 new (7 `pickSessionDefaultModel` + 2 icon)
- `HomePage.test.tsx`: 1 new (1 deleted, REWRITTEN — net 0)
- `ModelSwitcher.test.tsx`: 14 new (1 rewritten in-place)
- `Composer.test.tsx`: 0 new (mock-extension only)

= 55 + 5 + 5 + 9 + 0 + 14 + 0 = **88 new** (+1 rewritten = 89 net additions/changes). The 60-count claim under-states; this isn't padding (each test asserts a distinct branch) but accuracy matters for PR descriptions — auditors trust the count.

### P2-Beck-5: Aura a11y triad is satisfied on `ModelSwitcher` but `BlockerBanner`-style state-by-state axe coverage is partial

The PR adds 4 axe scans on `ModelSwitcher`:
1. Closed (existing)
2. Open with static fallback (existing)
3. Open with dynamic list (Task 15 — NEW)
4. (No 4th distinct state)

Missing axe-scan states the source supports:
- **Open with no-key footnote rendered** (`showNoKeyHint === true`) — footnote is a new DOM subtree (`<div className="border-t ... text-cc-muted">Add an API key...</div>`) inside the listbox. Not axe-scanned. The "render hint" test in the no-key-footnote describe block doesn't run axe.
- **Open with current model NOT in dynamic list** (custom-model fallback at `ModelSwitcher.tsx:84-85`) — custom model option uses `icon: "?"`, a different DOM shape. Not axe-scanned.
- **Open after `End` jumps activeIndex to last** — verifies aria-activedescendant remains valid for axe under keyboard interaction. Not axe-scanned.

Per `quality-testing.md` Principle 7: "For modal/banner components, run axe on all reachable states." The dropdown IS a banner-class component (state machine: closed/open/open-with-hint/open-with-custom). Add axe to at least the no-key-footnote-visible state — that's a NEW DOM subtree this PR introduces. **P2** not P1 because the footnote is trivial markup, but the floor mandates state-by-state.

### P2-Beck-6: Single-flight test is beautiful — but doesn't pin the "lock-released-on-reject" invariant

`"collapses N concurrent cold-cache requests to ONE upstream fetch"` at line 557 is genuinely good (real Promise, manual resolve, asserts call count = 1, asserts all three resolutions return ok). However, the inflight-map's `finally`-delete is what guarantees that a FAILED concurrent batch doesn't pin subsequent requests to a dead promise. No test covers: "N concurrent → upstream rejects → inflight lock is cleared → next request re-fetches." Without it, a refactor that moves the `inflightFetches.delete` outside `finally` (e.g., only in success branch) goes green.

Add: after a single-flight rejection (e.g., upstream 500), a subsequent `getAnthropicModels` call must observe the cleared lock and retry the fetch. The orchestrator's `inflightFetches` lifecycle is otherwise asserted only on the happy path.

### P2-Beck-7: Fixture-coupled "Latest" badge cardinality is acceptable, but the rationale should land in a comment

`expect(badges).toHaveLength(3)` at `ModelSwitcher.test.tsx:229` is structurally coupled to the `dynamicClaude` fixture (4 models across opus/opus/sonnet/haiku tiers, current selection on opus-4-7 → 3 visible badges since the selected one is suppressed). The current comment says "Exactly 3 'Latest' badges (one per tier...). Opus 4.7 must NOT carry the badge" which IS clear. **Marginally acceptable.** A future refactor that adds a 4th tier (e.g., `claude-flash`) plus a 5th badge would correctly red-flag; a fixture change that adds another opus entry would also red-flag (correct — Latest cardinality IS the property under test).

No action — flagged for completeness because the PR prompt asked. Leave as-is; the assertion isn't theatre.

### P2-Beck-8: `routes.test.ts` mock of cache module defaults to `{ kind: "no-key" }` — NOT an error-only-paths smell

The PR prompt asks whether `vi.mock("./anthropic-models-cache.js", () => ({ getAnthropicModels: vi.fn(async () => ({ kind: "no-key" })) }))` is a Beck-warned "mocks configured only for failure" pattern.

It is NOT. `no-key` is the most common operator state for fresh installs, and three of the five new route tests explicitly override via `mockResolvedValueOnce` to cover `ok`, `upstream-auth`, `upstream-unavailable`. The default-no-key choice covers the EC-17 fail-CLOSED test by reusing the default, which is exactly the case where the default IS the happy path under test. Acceptable.

---

## P3 — Consider

### P3-Beck-9: `__resetMemoryCacheForTests` + `__resetInflightForTests` + `__deleteDiskCacheForTests` are called in BOTH `beforeEach` AND `afterEach`

`beforeEach` is the contract — `afterEach` is defensive belt-and-braces. Neither incorrect nor canonical; matches the "test author got burned by cross-test pollution mid-run" signature (the explanation in `__deleteDiskCacheForTests`'s JSDoc says exactly this). **Acceptable.** The defensive double-reset costs ~microseconds per test and provides a future-safety floor for tests that throw mid-execution (where `beforeEach` of the NEXT test would still run, but cleanup of the failed test wouldn't). Leave as-is.

### P3-Beck-10: ModelSwitcher Escape-key rewrite is STRONGER, not weaker

The original `fireEvent.keyDown(window, { key: "Escape" })` no longer matches the implementation — the new APG-conformant code listens via `onKeyDown` on the listbox div, not via a global window handler. The new test (`fireEvent.keyDown(listbox, ...)`) matches the live event path. Without this rewrite the test would have been vacuously passing against the new code (the global Escape would no-op). **No finding.** This is a healthy realignment — flagged because the PR brief asked.

### P3-Beck-11: Composer mock-extension-only change is acceptable

Composer renders ModelSwitcher; lifting state into the store means Composer's mock must include `dynamicBackendModels: {}` + `anthropicApiKeyConfigured: null` for the mounted child to read defaults without crashing. No new test cases needed — Composer's own behaviour is unchanged, and the child's behaviour is owned by `ModelSwitcher.test.tsx`. The mock floor is the minimum needed to keep the existing Composer tests green. Acceptable.

### P3-Beck-12: Recording-exclusion canary (Hunt R5) is a static-grep test, NOT a behavioural one

The test at line 629 reads `recorder.ts` source and asserts no `anthropic-models-cache` or `api.anthropic.com` substring. Per the PLAN ("Recording exclusion (Hunt R5): Task 7 includes a regression test that COMPANION_RECORD=1 produces no recordings line containing the API key") this is meant to be a runtime regression test, not a source-string grep. Static-grep is the right idiom for "feature not wired" (`feedback_call_site_presence_not_just_symbol_export`); the named PLAN expectation was end-to-end. **Not raising to P2** because the static-grep IS load-bearing — wiring the cache through the recorder would touch one of those two literal strings — but a fuller "with COMPANION_RECORD=1, no recording line contains the API key suffix" test would catch a recorder fan-out via a side channel (e.g., via a generic outbound `fetch` interceptor). Consider for follow-up.

### P3-Beck-13: `parseAnthropicModelsResponse` per-item drop tests use a `_` rename + `void _;` to silence "unused" — acceptable per file convention, but a comment explaining "we explicitly omit display_name / created_at to test the polymorphic-by-spec path" would help future readers more than the syntactic dance.

Cosmetic; no action needed.

---

## Summary

| Severity | Count | Headline |
|----------|-------|----------|
| P1 | 3 | EC-22 emit-path coverage missing; disk-cache subsystem behaviourally unrendered; HomePage lifecycle no longer asserted |
| P2 | 5 | 89 vs claimed 60 test count; partial state-by-state axe; single-flight reject path; one trivial nit; one non-finding |
| P3 | 5 | Defensive double-reset; Escape rewrite is stronger; Composer mock acceptable; recording-exclusion is static-grep; cosmetic |

**Test Desiderata scoring** on the new suite as a whole (Beck Principle 11):
- **Behavioural**: ~8/10 — parser/sort/keyboard/single-flight are excellent; disk + structured-log surfaces drop the score.
- **Structure-insensitive**: ~9/10 — almost all assertions use `getByRole` + behaviour; Latest-badge cardinality is the one structural coupling.
- **Specific**: ~7/10 — the EC-22 gap means failures map to "something broke in the cache module" not "the `event` field renamed."
- **Predictive**: ~7/10 — disk + stale-served untested means a production regression on Persistence R3 / Backend R2 (the *availability beats freshness* invariant) ships green.

**The "AI agent cheating" signature scan (Beck Principle 10) is clean** — no `.skip` accumulation, no `.toBeTruthy()` on complex returns, no weakened assertions in the cache test file. The HomePage rewrite is the closest to a cheat-signal (assertion direction changed in the same commit as the consumer code), but the rewrite is technically *justified* by the lifecycle move into the slice. Still a weakening per P1-Beck-3.

**Production-logic-duplicating assertions check**: no instances found. `expect(r.models[0].label).toBe("Opus 4.7")` uses literal expected values throughout; the fixture-replay test uses known fixture content. Good discipline.

**Risk-calibrated coverage**: inverted in the cache module. ~25 tests on the pure parser (low-risk, easy to reason about) vs zero tests on the disk-cache subsystem (high-risk, load-bearing for the operator's "Anthropic was down for an hour but Aura kept serving stale" invariant). Reallocate — the parser is already over-tested for what it does.
