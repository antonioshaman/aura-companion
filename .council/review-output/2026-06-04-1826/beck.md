# Kent Beck — Test Quality Review (2nd pass — post-burndown)

PR #91 (`feat/dynamic-claude-models`), burndown commit `9d922c0`. Files reviewed: every test file the burndown added or extended + the corresponding source surfaces. Findings remain in the test lane.

Headline: the burndown materially closes my P1-Beck-1 (EC-22 emit-path) and P1-Beck-3 (HomePage lifecycle). P1-Beck-2 (disk-cache subsystem) closes for the load-bearing R3 path (stale-served-on-upstream-fail is now red-on-regress) — good. P2-Beck-6 (single-flight reject) closes cleanly. Two new concerns surface: (a) the new `signalCoalesceDegradeLogged` module-scope flag is asserted by zero tests and the test-reset helper is called by zero tests — process-lifetime test leakage trap; (b) the `loadBackendModels` reject-after-success defence is structurally vacuous, the test passes whether the defence is there or not (mutation-resistance gap on the test that purports to pin the EC-41 invariant). Both raised P2.

---

## Prior-finding verification

### P1-Beck-1 (EC-22 emit-path coverage) — CLOSED with one nit

The "EC-22 emit-path coverage — Council P1 #4" describe block at `anthropic-models-cache.test.ts:668` adds 9 tests, each spying `log.info` / `log.warn`, walking `.mock.calls`, and asserting `data.event === "anthropic-models.<specific>"`. The `findEmitWithEvent` helper narrows to `Record<string, unknown> | undefined` and tests do `expect(data).toBeDefined()` plus, for the load-bearing cases (`cache.hit`, `upstream.success`), explicit field assertions on `source`, `key_fingerprint`, `model_count`, `cache_age_ms`, `http_status`, `elapsed_ms`. The "no apiKey leak" test at line 802 scans both spies' full call arrays for the literal `sk-ant-test-deadbeef` and the suffix `deadbeef` — strong defence-in-depth, not lenient.

**Verdict: closes the finding.** The earlier failure shape ("refactor renames `anthropic-models.cache.hit` → `anthropic.cache.hit` and ships green") now reds because the event-string literal is asserted per outcome branch.

**Residual nit (P3-Beck-9 below):** the `findEmitWithEvent` helper does NOT match on `call[0]` (the `module` argument). A non-cache-module emit elsewhere with the same `event` string would pass. Since the cache module currently owns all `anthropic-models.*` events, this is fine today; flagged for future-readers.

### P1-Beck-2 (disk-cache subsystem unrendered) — CLOSED for the load-bearing path

The "Disk cache subsystem behavioural coverage — Council P1 #5" describe block at line 816 adds 8 tests. Critical ones:

- *Warm-start*: cold memory + valid disk record returns `source: "disk"` AND warms memory cache (next call without fetching gets `source: "memory"`, fetch not called). Pins the warm-start contract.
- *Fingerprint-mismatch*: simulated key rotation across "restart" (memory cleared, disk persists) → `reason: "fingerprint-mismatch"`. Pins the cache-invalidation predicate.
- *Stale*: 25h-old record → `reason: "stale"`. Pins the 24h ceiling.
- *Stale-served-on-upstream-fail* (line 941): 30h-old disk + upstream 500 → returns `source: "disk"` AND fires `anthropic-models.stale-served`. **This is the load-bearing R3 "availability beats freshness" invariant I called out as the P1 risk.** Now pinned.
- *Persistence-R3 reject-on-key-bytes* (line 881): `writeDiskCache` throws when the serialised payload contains the apiKey suffix bytes. Defence-in-depth caught by assertion.
- *File mode 0o600*: `stat.mode & 0o777 === 0o600` at line 982 — pins the atomic-write contract.

Schema-mismatch is NOT explicitly tested as a separate describe, but the contract is structurally analogous to fingerprint-mismatch (both read paths return a `DiskReadResult` reason; the read code is parametric over the predicate). I'd accept the omission given the rest of the surface coverage, and an eventual future schema bump is the natural follow-up moment.

**Verdict: closes the P1 finding.** The R3 stale-served path is now red-on-regression, which was the actual load-bearing invariant.

### P1-Beck-3 (HomePage lifecycle assertion) — CLOSED

`HomePage.test.tsx:998-1000` adds the assertion to the REWRITTEN test (`"renders dynamic models from the settings-slice when the slice is populated"`), not a new sibling. The `await waitFor(() => expect(mockStoreState.loadBackendModels).toHaveBeenCalledWith("codex"))` block is exactly the pin I asked for — a regression that drops the `useEffect` would now red (`loadBackendModels` mock never called with `"codex"`).

The comment block at `:993-997` is explicit about why ("regression that drops the useEffect (e.g., refactor lifting load to a global App effect) would pass with the slice pre-warmed without this"). Comment-hygiene clean.

**Verdict: closes the finding.**

### P2-Beck-4 (test count discrepancy) — CLOSED by inflation

My prior count was ~89 across the diff vs claimed 60. The burndown adds ~31 more (notably +18 in cache tests, +5 settings-slice, +6 ModelSwitcher, +2 backends). Total is now closer to ~120. Brief's "+31 since first review baseline" matches my recount. **No action.**

### P2-Beck-5 (state-by-state axe) — PARTIALLY closed

Three axe scans now exist on ModelSwitcher:
1. Closed (existing)
2. Open with static fallback (existing)
3. Open with dynamic list (added in this burndown at line 241)

**Still missing:** the "open with no-key footnote rendered" state at the `no-key footnote (Friedman R3)` describe block. That state introduces a NEW DOM subtree (`<a href="#/settings">` sibling of the listbox after the restructure) and is a distinct reachable visual state. The 3 tests in that describe block exercise the toggle, but none of them run axe.

Lowering this from P2 to P3 since the axe rule that would catch a violation in the footnote is generic and would already fire on the listbox open scan if the structural restructure introduced a violation — but flagged for completeness because the floor (Principle 7) is per-reachable-state, not per-DOM-shape.

### P2-Beck-6 (single-flight lock-released-on-reject) — CLOSED

The "Single-flight lock released on reject — Council P3 #14" describe block at line 986 adds the exact regression pin I asked for: failing fetch → upstream-unavailable → second call with NEW fetch impl fires (`successFetch` called once). A refactor that moves the `inflightFetches.delete` outside the `finally` block (e.g., only in success branch) reds because `successFetch` would observe zero calls. Clean.

### P2-Beck-7, P2-Beck-8 (no change needed) — no regression

Latest-badge cardinality unchanged; routes.test default-no-key mock unchanged. Both untouched and remain acceptable.

---

## P1 — Fix Now

(no P1 — the burndown closed all three.)

---

## P2 — Fix Soon

### P2-Beck-14: `loadBackendModels` reject-after-success "preservation defence" test is structurally vacuous

| | |
|---|---|
| **File** | `web/src/store/settings-slice.test.ts:296-315` (test); `web/src/store/settings-slice.ts:280-302` (production defence) |
| **Council** | Beck × Carmack — Mutation resistance (Principle 11) |
| **Ref** | `references/quality-testing.md` → Mutation resistance + Production-logic-duplicating assertions |

**Finding:** The test at line 297 asserts that after success → reject, `dynamicBackendModels.claude` still has length 1. The production defence at `settings-slice.ts:281-302` reads the current slot, branches on `currentSlot !== undefined && currentSlot.length > 0`, and produces different `set()` payloads in each branch. **Both branches set ONLY `dynamicBackendModelsStatus`. Neither branch touches `dynamicBackendModels`.** Removing the entire `if (currentSlot !== undefined && currentSlot.length > 0) { ... }` block — keeping only the else branch — preserves identical behaviour. The test goes green either way.

**Consequence:** The test purports to enforce EC-41 ("inflight-token guards MUST prefer success commit when newer token still pending") via the data-preservation observation, but mutates none of the actual EC-41-load-bearing code paths. A future refactor that accidentally writes `dynamicBackendModels: { ...s.dynamicBackendModels, [backend]: undefined }` into the reject handler (the actual regression shape EC-41 protects against) would red the test — good. But a refactor that strips the if-branch (perceived as dead code) goes green even though the test claims to enforce that branch's existence.

**Fix:** Either (a) collapse the production code to the single else-branch and delete the dead if-branch (then the test pins exactly the surviving behaviour, no false pretense), or (b) introduce a second test that flips a slot to `[]` first then asserts reject still preserves the empty array distinct from null/undefined — exercising the discriminator. (a) is the Beck-preferred path: simpler code, identical test, no doku-vs-code drift.

This is the `feedback_council_documented_contract_canary` shape replayed at a finer scale — the JSDoc at `:283-285` ("Defensive: if a previous successful fetch already populated the slot, leave it intact") is doku, the if-branch is non-load-bearing, the test fires regardless.

---

### P2-Beck-15: `signalCoalesceDegradeLogged` module-scope flag has zero test coverage AND zero reset-helper callers — process-lifetime test leakage trap

| | |
|---|---|
| **File** | `web/server/anthropic-models-cache.ts:579,597,612` (module-scope flag + warn-once gate + reset helper); test files: zero callers found |
| **Council** | Beck × Carmack — Test isolation + the "AI agent cheating" signature scan (Principle 10) |
| **Ref** | `references/quality-testing.md` → Test isolation + EC-22 emit-path coverage |

**Finding:** `signalCoalesceDegradeLogged` is module-scope (process-lifetime), guards a `log.warn("anthropic-models-cache", "signal-coalesce-degraded", { event: "anthropic-models.signal-coalesce-degraded", ... })` emit, and is reset by `__resetSignalCoalesceFlagForTests()`. The helper is exported but `grep "__resetSignalCoalesceFlagForTests\|signal-coalesce" web/server/*.test.ts` returns zero matches. Specifically:

1. **No EC-22 test** asserts the `anthropic-models.signal-coalesce-degraded` event fires at all (the burndown's 9 EC-22 tests cover the OTHER 10 events but skipped this 11th one).
2. **No test** calls `__resetSignalCoalesceFlagForTests()`. The flag is initialised once at module load (`false`), then any test that incidentally triggers the degraded path (e.g., a future Bun runtime missing `AbortSignal.any`, or a test that monkey-patches it away) flips the flag for the remainder of the process — silently changing whether downstream tests would see the warn fire.

**Consequence:** Two distinct problems compounding. (i) The 11th event-emit path is unrendered — exactly the gap the P1-Beck-1 burndown addressed for the other 10 emits, but missed this one. (ii) The reset-helper exists but is unused — Beck Principle 11's "Test author got burned by cross-test pollution" signature, but with no enforcement. If a future test exercises the degraded path, it will leak the flag forward and any subsequent test attempting to assert the warn fires will silently pass against a stale `signalCoalesceDegradeLogged = true` state.

**Fix:** Add an EC-22 test in the existing "EC-22 emit-path coverage" describe block: monkey-patch `(AbortSignal as any).any = undefined` before the call, invoke `getAnthropicModels`, assert `warnSpy` saw `event: "anthropic-models.signal-coalesce-degraded"`. Call `__resetSignalCoalesceFlagForTests()` in the `beforeEach` / `afterEach` of any describe block whose tests CAN drive the degraded path (today: none, but the pattern is what matters — pre-empts the regression).

Alternative: if the warn is considered low-value (degraded-mode is operational-but-not-broken), delete the flag and the helper. Either commit fully to behavioural assertion or delete the dead reset surface.

---

### P2-Beck-16: Hostile-fixture droppedItems assertion `>= 5` admits future-fixture-drift false-pass

| | |
|---|---|
| **File** | `web/server/anthropic-models-cache.test.ts:1049`; `web/server/fixtures/anthropic-models-response-hostile.json` |
| **Council** | Beck × Carmack — Specific assertions over weakened thresholds (Principle 2) |
| **Ref** | `references/quality-testing.md` → Specific Desideratum |

**Finding:** The test asserts `expect(parsed.droppedItems).toBeGreaterThanOrEqual(5)`. The fixture has 6 entries: 1 baseline + 5 hostile. Expected drop count is exactly 5. A `>=` bound passes if a future fixture refresh accidentally drops the baseline as well — exactly the regression class the test should catch (the baseline survival is the canary that the parser still accepts known-good input).

The test does assert `expect(ids).toContain("claude-opus-4-7")` (line 1040) which independently catches baseline drop, so the practical risk is bounded today. But the `>=` bound on a tightly-known count is the kind of weakened assertion `feedback_no_ignore_failing_test_diagnose_first` is on watch for.

**Consequence:** Cosmetic today (the `ids.toContain` line catches the load-bearing case). But two months from now when somebody extends the fixture with a 7th-hostile-entry without updating the `>=`, the test silently widens. The fixtures/README.md table is the source of truth for cardinality — the test should pin to that table.

**Fix:** Change `toBeGreaterThanOrEqual(5)` to `toBe(5)`. Document in a code comment that `5 = (fixture.data.length - 1 baseline)`. If the fixture grows, the README.md table updates, the test goes red on count drift, the author re-reads the table — the right authoring loop.

---

## P3 — Consider

### P3-Beck-17: `findEmitWithEvent` helper does not gate on `module` arg — multi-module event-string collision goes silent

The helper walks `spy.mock.calls`, picks `call[2]` (the `data` arg), and matches `data.event`. `log.info` signature is `(module, msg, data?)` — the `module` argument is ignored. Today the cache module is the only emitter of `anthropic-models.*` events; if a future caller emits an `anthropic-models.*` event from `routes.ts` or elsewhere, a test that expected the cache module to emit it would pass even if the cache module went silent. Cheap fix: extend the helper to match `call[0] === "anthropic-models-cache" && call[2]?.event === event`. Cosmetic; flagged because the cache's event-string namespace is currently informal (no shared registry).

### P3-Beck-18: P2-Beck-5 axe coverage now 3-of-4 reachable states — add the 4th

The "open with no-key footnote rendered" state is the only reachable visual state the dropdown supports that's still unscanned. The 3 footnote describe-block tests render that state — adding `const { axe } = await import("vitest-axe"); ... expect(await axe(container)).toHaveNoViolations()` to one of them is ~3 lines. The footnote's `<a href="#/settings">` is a NEW DOM subtree on this PR; the floor is per-reachable-state.

### P3-Beck-19: Double-reset discipline preserved — acceptable

The new burndown tests follow the existing `beforeEach` + `afterEach` reset pattern (`__resetMemoryCacheForTests` + `__resetInflightForTests` + `__deleteDiskCacheForTests`). Reasoning unchanged from P3-Beck-9 (prior pass): defensive belt-and-braces, costs microseconds, future-safety floor. The new disk-cache describe block correctly extends the pattern.

### P3-Beck-20: Composer mock extension is acceptable (and now documents the transitive coupling)

The `loadBackendModels: vi.fn(async () => undefined)` addition at `Composer.test.tsx:130` is the minimum needed to keep Composer tests green when the child ModelSwitcher fires `loadBackendModels` on mount. The comment at `:127-129` correctly documents the transitive coupling. No new test cases needed.

### P3-Beck-21: Fixture README + hostile-entry count are aligned today, but the alignment is hand-maintained

`fixtures/README.md` table lists 6 entries (indices 0..5); fixture has 6 entries; test assertion is `>= 5` (see P2-Beck-16). The hand-maintained alignment is fragile but acceptable for an internal fixture. If this surface grows, consider generating the README from the JSON's entries' metadata via a small script. Today: no action.

---

## Summary

| Severity | Count | Headline |
|----------|-------|----------|
| P1 | 0 | (prior 3 P1 all closed) |
| P2 | 3 | settings-slice reject-defence is structurally vacuous; signalCoalesceDegradeLogged untested + unreset; hostile-fixture droppedItems `>=` weakens to fixture drift |
| P3 | 5 | findEmitWithEvent module-arg gap; 4th axe state; double-reset discipline; Composer mock acceptable; fixture README alignment fragile |

**Closed:** 3/3 P1 (EC-22 emit-path, disk-cache subsystem incl. stale-served, HomePage lifecycle pin). 4/5 P2 (count discrepancy, single-flight reject, fixture cardinality non-finding, routes.test mock non-finding). P2-Beck-5 (state-by-state axe) PARTIALLY closed — third axe state added, no-key-footnote state still unscanned (downgraded to P3-Beck-18).

**New concerns introduced by burndown:** 2 (P2-Beck-14 vacuous reject defence; P2-Beck-15 untested signal-coalesce warn + dead reset helper). Neither is a regression on the prior code — both are gaps introduced by the burndown's own new surface area.

**Test Desiderata scoring on the post-burndown suite (Beck Principle 11):**
- **Behavioural**: ~9/10 — EC-22 + disk-cache + single-flight reject all behaviourally pinned. The settings-slice reject-defence is the holdout (pins data, not the defence itself).
- **Structure-insensitive**: ~9/10 — unchanged; almost all `getByRole`-based assertions. Latest-badge cardinality remains the lone structural coupling, acceptable per P2-Beck-7.
- **Specific**: ~8/10 — event-string assertions land with named events + key fields. `toBeDefined()` on the helper return is slightly lenient (only fires on absence of the event entirely, not on shape drift); compensated by the per-test field assertions on critical events. `>= 5` hostile drops is the one outright lenient assertion.
- **Predictive**: ~9/10 — disk + stale-served pinned; single-flight reject pinned; lifecycle on HomePage pinned. Cardinal P1-Beck risk in prior pass (R3 availability-beats-freshness) is now red-on-regression.

**The "AI agent cheating" signature scan is clean for the burndown's NEW tests.** No `.skip` accumulation in the new files; no `.toBeTruthy()` on complex returns; no obviously weakened assertions. The vacuous reject-defence test (P2-Beck-14) is NOT a cheat in intent — the author clearly meant to enforce the data-preservation invariant — but it IS a structural false-pretense the burndown should fix.

**Production-logic-duplicating assertions check:** clean. Event names asserted as literal strings (good); field values asserted with literal expected values; no `.toBe(model.id)` against re-computed `model.id` shapes.

**Risk-calibrated coverage is now well-aligned.** The R3 stale-served + R1 inflight-clobber + EC-22 emit-path were the three load-bearing surfaces of this PR. All three are now pinned. The pure-parser overcoverage observation from the prior pass stands but is not actionable — the tests are correct, just dense; ripping them out would be regression theatre.

**Bottom line:** burndown is a solid recovery on the test surface. Three of three prior P1s genuinely closed (no JSDoc-vs-code drift on the closures). Two new P2s introduced — both small, both isolated to the burndown's own new surface, both fixable in a follow-up PR without re-touching the production code.
