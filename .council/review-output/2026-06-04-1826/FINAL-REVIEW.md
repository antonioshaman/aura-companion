# Council Review (Aura): PR #91 — 2nd Pass (Burndown Verification)

**Scope:** Commit `9d922c0` (the 15/15 burndown) vs commit `fdf88e0` (first review baseline). 16 source/test files modified + 1 new fixture + conventions.md. The first review's findings are at `.council/review-output/2026-06-04-0823/FINAL-REVIEW.md`. This pass verifies the burndown actually closed each finding without introducing new regressions.

**Context:** The burndown claimed "15/15 findings closed." This review confirms 11 of 15 are CLEANLY closed but flags **4 P1 META-issues** where the burndown shipped fixes whose tests/wiring don't enforce what they claim. Pattern: vacuous tests, dead code, undocumented type-system extensions, call-site presence gaps — exactly the EC-37 violations the convention was added to prevent.

**Council dispatched (11/13):**
- ✅ Hunt (2 findings: 1 P2 + 1 P3 — chmod swallow scope, fingerprint flag once-per-process)
- ✅ Fowler (2 P3 — minor structural notes)
- ✅ Backend-TS (2 P2 + 4 P3 — dead `resolveCoalescedSignal`, soft-rejected union, carried P3s)
- ✅ Persistence (0 P1 + 0 P2 + 3 new P3 + 7 carry-forward — `readMemoryCache` missing EC-38, chmod swallow, fixture cardinality)
- ✅ Realtime (carry-forward P2/P3 only; helper extraction structurally neutral)
- ✅ React/Web UI (0 P1 + 2 P2 + 3 P3 — sticky plumbed cleanly, new issues from semantic extensions)
- ✅ a11y (1 P1 + 5 P2 + 6 P3 — **vacuous focus test + vacuous footnote test**, verified contrast 1.5:1)
- ✅ Saarinen (1 P2 + 2 P3 — overlay token, focus-ring clipped by overflow, hover collision)
- ✅ Friedman (0 P1 + 4 P2 + 1 P3 — P1 #1 verified closed, new sticky-stale-glyph issue)
- ✅ Willison (0 P1 + 2 P2 — carried; hostile fixture clean)
- ✅ Beck (0 P1 + 3 P2 + 5 P3 — **3 P1s genuinely closed**, 2 new vacuous tests flagged)
- ⚪ Subprocess SKIPPED (no domain changes)
- ⚪ Deploy SKIPPED (no Dockerfile/workflow changes)

---

## P1 — Fix Now

### 1. Burndown's "P1.2 rAF autofocus" test is structurally vacuous — simulates focus rather than verifying it lands

| | |
|---|---|
| **File** | `web/src/components/ModelSwitcher.test.tsx:401-423` (claims to verify) + `ModelSwitcher.tsx:169-182` (the actual rAF effect) |
| **Council** | a11y Auditor × Beck × Carmack — EC-37 (PLAN watchpoints demand BOTH test + grep) |
| **Ref** | `references/quality-a11y.md` → Principle 1 (axe is a floor); `conventions.md` EC-37 |

**Finding:** The first review's P1.2 demanded (a) switch `queueMicrotask` → `requestAnimationFrame`, AND (b) a behavioural test that the listbox actually receives focus on open. The burndown shipped (a). It did NOT ship (b). The new test at `:414` manually calls `listbox.focus()` to "model the post-rAF state" — it SIMULATES the post-focus condition rather than VERIFYING the rAF call site actually fires + focus lands. A regression where someone re-introduces `queueMicrotask` or removes the open-edge effect entirely leaves the test green.

**Consequence:** Keyboard user opens dropdown → expects to be IN it → arrow keys do nothing because focus didn't land. The test suite does not protect that path. The bug class the first review specifically flagged (focus contract gap is invisible to axe) is exactly what the burndown's test still doesn't catch.

**Fix:** Add `vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => { cb(0); return 0; })` to flush rAFs synchronously, then `fireEvent.click(trigger)` followed by `await waitFor(() => expect(listbox).toHaveFocus())`. Removes the manual `listbox.focus()` simulation; verifies the producer-side contract.

---

### 2. `resolveCoalescedSignal` is dead-on-arrival in production — no caller threads `parentSignal`

| | |
|---|---|
| **File** | `web/server/routes.ts:1586` (call site) × `web/server/anthropic-models-cache.ts:665` (ternary that's always false in prod) |
| **Council** | Backend-TS × Carmack — `feedback_call_site_presence_not_just_symbol_export` + EC-37 |
| **Ref** | `references/quality-backend.md` → Principle 5 (resource lifecycle); `conventions.md` EC-37 |

**Finding:** The burndown closed the SHAPE of the first review's P2-BT-1 (silent demote → log + parent-only fallback). But `routes.ts:1586` calls `getAnthropicModels(settings.anthropicApiKey)` with NO `deps` argument. Therefore `deps?.parentSignal === undefined` always, the ternary at `anthropic-models-cache.ts:665` always takes the timeoutController branch, and `resolveCoalescedSignal` + `signalCoalesceDegradeLogged` + `__resetSignalCoalesceFlagForTests` are never reached at runtime. Zero callers of the reset helper across the whole repo.

**Consequence:** The original P2-BT-1 failure mode ("browser cancels REST request via `c.req.raw.signal`, server keeps hitting Anthropic until 5s timeout") still ships. The fix is on the wrong axis — extra surface, extra flag, no actual behavioural change. Worst-of-both: code that LOOKS like it closes the finding but doesn't.

**Fix:** Either (a) wire `c.req.raw.signal` at the routes.ts call site (`getAnthropicModels(settings.anthropicApiKey, { parentSignal: c.req.raw.signal })`) so the burndown's fix actually does something + add a behavioural test for the dead-`AbortSignal.any` branch; or (b) revert the helper + flag and acknowledge P2-BT-1 as wontfix because production never passes parentSignal. Current state is the worst-of-both.

---

### 3. "Footnote NOT inside listbox" test is structurally vacuous — queries the wrong renderer instance

| | |
|---|---|
| **File** | `web/src/components/ModelSwitcher.test.tsx:476-491` |
| **Council** | a11y × Beck × Carmack — Beck Principle 11 (Specific desideratum) |
| **Ref** | `references/quality-testing.md` → "Specific" desideratum + EC-22 |

**Finding:** The test renders TWO `<ModelSwitcher>` instances. The first uses default `resetStore()` (anthropicApiKeyConfigured=null → no footnote at all). The second uses `resetStore({ anthropicApiKeyConfigured: false })` AFTER the first render. The test then opens the FIRST switcher (which has no footnote regardless), grabs its listbox, and asserts `listbox.querySelector('a[href="#/settings"]')` is null. That null is guaranteed by the test setup, not by the burndown's DOM restructure. A regression where someone moves the footnote BACK inside the listbox would leave this test green.

**Consequence:** The structural a11y guarantee (no phantom option inside listbox iteration) is unprotected. The first review's specific gap — "SR iterates the footnote as an option" — is still unguarded by the test suite.

**Fix:** Single render with `resetStore({ anthropicApiKeyConfigured: false })` BEFORE the render; open that switcher; find the listbox via `screen.getByRole("listbox")` AND the link via `screen.getByRole("link", { name: /Add an API key/ })`; assert `expect(listbox.contains(link)).toBe(false)`.

---

### 4. Settings-slice reject-after-success test is vacuous — both branches set identical state shape

| | |
|---|---|
| **File** | `web/src/store/settings-slice.test.ts:312+` (the new "reject after success preserves data" test) × `settings-slice.ts:259-291` (the `loadBackendModels` catch block) |
| **Council** | Beck × Backend-TS × Carmack — `feedback_council_documented_contract_canary` |
| **Ref** | `references/quality-testing.md` → Mutation resistance |

**Finding:** The slice's catch block returns the same state-update shape from BOTH branches: when `currentSlot !== undefined && currentSlot.length > 0`, it returns `{dynamicBackendModelsStatus: { ...s.dynamicBackendModelsStatus, [backend]: "rejected" }}`; the else branch returns the SAME shape. Neither branch mutates `dynamicBackendModels` at all (the rejection never wrote to it). The test asserts data is preserved AND status is "rejected" — but data preservation is automatic because the catch never writes to `dynamicBackendModels` regardless. A refactor that removes the if/else conditional entirely (since both branches do the same thing) leaves the test green.

**Consequence:** The defence the burndown intended to add doesn't exist — the catch ALREADY didn't write to `dynamicBackendModels`. The test pins a property the code structure already implied. EC-41 contract (inflight-token guards MUST prefer success over reject) is unverified.

**Fix:** Either (a) actually implement different shape: e.g., on hard-reject (no prior data), set `dynamicBackendModels[backend] = undefined` explicitly; on soft-reject (prior data exists), leave it. THEN the test has a real contract to pin. Or (b) collapse the if/else (both branches are identical) and remove the test pretending it pins behaviour that's automatic from the absence of mutation.

---

## P2 — Fix Soon

### 5. `focus:ring-cc-primary/40` verified at 1.5:1 contrast — fails WCAG 2.4.11

| | |
|---|---|
| **File** | `web/src/components/ModelSwitcher.tsx:280` (listbox `focus:ring-cc-primary/40`) |
| **Council** | a11y Auditor × Carmack — WCAG 2.4.11 (Focus Appearance, AA) |
| **Ref** | `references/quality-a11y.md` → Principle 2 (visible focus indicator) |

**Finding:** First review flagged this as P2.5 unverified; a11y 2nd-pass verified token values: `--color-cc-primary: #d97757` × 40% alpha composited over `--color-cc-bg: #262624` (dark) = ~1.5:1 contrast. WCAG 2.4.11 requires 3:1 for focus indicators. Burndown did not address.

**Fix:** Drop the `/40` opacity: `focus-visible:ring-2 focus-visible:ring-cc-primary` (no opacity), OR remove the override entirely and let the global `:focus-visible` outline at `index.css:347-351` apply.

---

### 6. "Soft-rejected" status is an undocumented discriminated-union state

| | |
|---|---|
| **File** | `web/src/store/settings-slice.ts:259-291` (catch block) + `DynamicModelsStatus` type alias |
| **Council** | Backend-TS × Fowler × Carmack — `feedback_council_documented_contract_canary` |
| **Ref** | `references/quality-backend.md` → Principle 8 (type safety at boundary); convention EC-10 |

**Finding:** Two distinct semantic states now hide behind one `"rejected"` value: **hard reject** (slot empty + fetch failed) vs **soft reject** (slot populated from prior success + latest fetch failed). The type `DynamicModelsStatus = "idle" | "pending" | "resolved" | "rejected"` doesn't carry the distinction. Comments call this "soft-rejected" but no consumer can decide between them from the status field alone — they must combine with `dynamicBackendModels[backend] !== undefined`.

**Fix:** Widen the union to `"idle" | "pending" | "resolved" | "rejected" | "rejected-stale"` OR change to `{ kind: "rejected"; hasStaleData: boolean }`. Single source of truth, type-system-enforced. ~10 LOC change.

---

### 7. `readMemoryCache` has the SAME negative-skew fail-open shape EC-38 mandates clamping (symmetric-path-missing)

| | |
|---|---|
| **File** | `web/server/anthropic-models-cache.ts:841` (memory-cache read predicate) |
| **Council** | Persistence × Carmack — `feedback_symmetric_path_missing_transformation` + EC-38 |
| **Ref** | `references/quality-persistence.md` → Principle 7; `conventions.md` EC-38 |

**Finding:** Burndown fixed `isCacheRecordValid` at line 762 with `Math.max(0, now - r.fetched_at) > ttlMs`. But `readMemoryCache:841` uses the bare shape `now - record.fetched_at > IN_MEMORY_TTL_MS` — same negative-skew fail-open bug, same fix needed. The EC-38 convention applied only at one of two symmetric sites. Classic `feedback_symmetric_path_missing_transformation`.

**Fix:** Apply the same `Math.max(0, ...)` clamp at line 841. One-line change. Or extract a shared `isWithinTtl(fetched_at, now, ttlMs)` helper called from both sites.

---

### 8. Footnote hover styling matches option-row hover — reads as a 4th selectable item

| | |
|---|---|
| **File** | `web/src/components/ModelSwitcher.tsx:330-334` (footnote `<a>` className) |
| **Council** | Friedman × Saarinen × Carmack — Visual hierarchy + UX trust |
| **Ref** | `references/quality-ux.md` → Principle 6 (lists drive action); `references/quality-ui.md` → noise vs hierarchy |

**Finding:** The footnote uses `hover:text-cc-fg hover:bg-cc-hover transition-colors` — the EXACT styling of an option row's hover state (`ModelSwitcher.tsx:293`). User scanning the dropdown sees a row that hovers identically to options; a confused user could click thinking it selects a model. The "Add an API key in Settings..." copy disambiguates after reading, but the hover affordance is wrong.

**Fix:** Differentiate the link's hover from option-row hover. Either (a) `hover:underline` only (no bg change), OR (b) a different bg token (`hover:bg-cc-active/20` or similar). Add a thicker `border-t` (2px instead of 1px) to visually separate the footer from the listbox region.

---

### 9. Sticky preference now preserves stale `claude-opus-4-6` → trigger renders `?` glyph with no explanation

| | |
|---|---|
| **File** | `web/src/components/ModelSwitcher.tsx:104-108` (fallback option construction) |
| **Council** | Friedman × Carmack — Trust through reasoning visibility (P9) |
| **Ref** | `references/quality-ux.md` → P9 (data consistency, no confidence indicators where helpful) |

**Finding:** Sticky preference plumbing (P1 #1) preserves the user's saved model. But the saved model may be one Anthropic has since deprecated (`claude-opus-4-6` not in dynamic list). The existing fallback at `ModelSwitcher.tsx:104-108` renders this as a custom option with `icon: "?"` — the trigger button shows "Opus 4.6 ?" with no explanation. User sees `?`, no tooltip, no understanding of why.

**Fix:** Drop `icon: "?"` → `""` (let the fallback be icon-less, matching the Claude column convention from Task 13). Add `title={\`Model "${currentModel}" not in current available list — preserved from your saved preference\`}` to the trigger so hover-tooltip explains the state. Cheaper alternative: just drop the `?` glyph.

---

### 10. `signalCoalesceDegradeLogged` has zero EC-22 emit test + `__resetSignalCoalesceFlagForTests` has zero callers

| | |
|---|---|
| **File** | `web/server/anthropic-models-cache.ts:559-574` (module-scope flag + helper + reset) × `web/server/anthropic-models-cache.test.ts` (zero matches) |
| **Council** | Beck × Backend-TS × Carmack — EC-22 + process-lifetime test leak |
| **Ref** | `references/quality-testing.md` → Mutation resistance; `conventions.md` EC-22 |

**Finding:** New event `anthropic-models.signal-coalesce-degraded` was added but has zero behavioural test in the suite (`grep "signal-coalesce-degraded" web/server/*.test.ts` returns nothing). The reset helper `__resetSignalCoalesceFlagForTests` is exported but `grep -n __resetSignalCoalesceFlagForTests web/server/*.test.ts` returns zero callers. Module-scope flag survives across tests in the same file run — if any future test ever triggers the degrade path, all subsequent tests inherit a true flag.

**Fix:** Add the test (mock `AbortSignal.any` to undefined via `vi.spyOn(AbortSignal, "any").mockReturnValue(undefined)` or stub on globalThis, dispatch a fetch with parentSignal, assert `findEmitWithEvent(warnSpy, "anthropic-models.signal-coalesce-degraded")` returns the event). Add `__resetSignalCoalesceFlagForTests()` to the orchestrator beforeEach so any future inadvertent test triggering the warn doesn't poison later tests.

---

### 11. ModelSwitcher dropdown uses `bg-cc-bg border-cc-separator rounded-lg` — diverges from codebase overlay convention `bg-cc-card border-cc-border rounded-[10px]`

| | |
|---|---|
| **File** | `web/src/components/ModelSwitcher.tsx:270` (outer wrapper className) |
| **Council** | Saarinen × Carmack — Component visual consistency |
| **Ref** | `references/quality-ui.md` → Component visual consistency |

**Finding:** Carried from first review. Burndown's DOM restructure left this unchanged. Precedent overlays in the codebase (`CouncilToggle`, `Composer`, `LinearAgentEditor`, `Playground`) use `bg-cc-card border-cc-border rounded-[10px]`. ModelSwitcher dropdown uses `bg-cc-bg border-cc-separator rounded-lg` — in dark mode the panel renders the same shade as the chat surface behind it, with `shadow-lg` alone carrying elevation.

**Fix:** Swap to the codebase overlay convention. One-line className edit at the wrapper.

---

## P3 — Consider

### 12. `atomic-write.ts` chmod best-effort silently swallows EACCES — too wide

| | |
|---|---|
| **File** | `web/server/atomic-write.ts:41-43` (the new chmod try/catch) |
| **Council** | Backend-TS × Persistence × Hunt convergence |

The catch absorbs FOUR distinct failure modes: legitimate cross-UID parent (intended), EACCES on immediate `dir` from umask (regression — defence silently NOT taken), EPERM on macOS SIP, ENOENT race. The wrapper is used by every writer in the codebase. The JSDoc claims "0o700 parent dir" as a defence; the catch silently downgrades; no log entry on bypass. Narrow the catch: either skip chmod for paths not under `COMPANION_HOME`, OR log a `warn` ("atomic-write.chmod-failed" with `dir`, `error_name`) before swallowing so the operator at least has a forensic trace.

---

### 13. Dropping `models` from open-edge effect deps creates a stale-activeIndex window when dynamic list arrives after open

| | |
|---|---|
| **File** | `web/src/components/ModelSwitcher.tsx:174-180` (open-edge useEffect) |
| **Council** | a11y × Friedman cross-ref |

Burndown's P1 #3 fix dropped `models` from the dep array via `wasOpenRef`. Correct for the "models change while open shouldn't reset cursor" concern. But: when `loadBackendModels` resolves WHILE the dropdown is open (Settings save with dropdown open), `models` array changes but `activeIndex` stays at the previously-selected position. If the new list has FEWER items than `activeIndex + 1`, `models[activeIndex]` is `undefined` → `handleSelect` crashes. Clamp `activeIndex` in the listbox renderer or in a separate clamping effect that depends on `models.length` (NOT on `models` identity).

---

### 14. Footnote `<a>` lacks link affordance beyond color — WCAG 1.4.1 Use of Color

| | |
|---|---|
| **File** | `web/src/components/ModelSwitcher.tsx:330-334` |
| **Council** | a11y |

The footnote is styled as plain `text-cc-muted` with no underline at rest. WCAG 1.4.1 prohibits using color alone to indicate a link. Hover state changes (`hover:text-cc-fg hover:bg-cc-hover`) provide differentiation on hover only — not for users who can't hover (touch devices, screen reader users). Add `underline` (or `underline decoration-dotted decoration-cc-muted/40`) at rest so the link affordance is visible without interaction.

---

### 15. Carried P2.2 — Chevron + checkmark SVGs still lack `aria-hidden="true"`

| | |
|---|---|
| **File** | `web/src/components/ModelSwitcher.tsx:252-254` (trigger chevron) + `:308-310` (selected checkmark) |
| **Council** | a11y |

First review's P2.2 — `grep aria-hidden web/src/components/ModelSwitcher.tsx` returns zero matches. Both decorative SVGs still bare. SR announces "graphic, Switch model button" on some combinations. Three-character add: `aria-hidden="true"` on each `<svg>`. Carried unchanged — burndown's scope was the four flagged P2s, this wasn't among them.

---

## Summary

| # | Finding | Severity | Council | Fix effort |
|---|---------|----------|---------|------------|
| 1 | Burndown's rAF autofocus test is vacuous | **P1** | a11y × Beck | ~10 LOC test refactor |
| 2 | `resolveCoalescedSignal` dead-on-arrival | **P1** | Backend-TS | ~5 LOC wire + 1 test OR revert |
| 3 | "Footnote NOT inside listbox" test vacuous | **P1** | a11y × Beck | ~10 LOC test rewrite |
| 4 | Reject-after-success test vacuous | **P1** | Beck × Backend-TS | ~15 LOC test rewrite OR collapse if/else |
| 5 | Focus-ring 40% opacity verified 1.5:1 contrast | P2 | a11y | 1 className edit |
| 6 | "Soft-rejected" undocumented union state | P2 | Backend × Fowler | ~10 LOC type widen |
| 7 | `readMemoryCache:841` missing EC-38 clamp | P2 | Persistence | 1 LOC |
| 8 | Footnote hover styling collides with option-row | P2 | Friedman × Saarinen | 1 className edit |
| 9 | Sticky preserves stale model → "?" trigger | P2 | Friedman | 1 LOC + tooltip |
| 10 | `signalCoalesceDegradeLogged` zero tests + zero reset callers | P2 | Beck × Backend-TS | ~15 LOC test |
| 11 | Dropdown bg-cc-bg vs bg-cc-card overlay convention | P2 | Saarinen | 1 className edit |
| 12 | atomic-write chmod swallow too wide | P3 | Backend × Persistence | ~5 LOC narrowing |
| 13 | Stale-activeIndex window when list arrives mid-open | P3 | a11y × Friedman | ~5 LOC clamp effect |
| 14 | Footnote `<a>` lacks link affordance beyond color | P3 | a11y | 1 className edit |
| 15 | Chevron + checkmark SVGs still lack aria-hidden | P3 | a11y | 2 attributes |

## Verdict

**The burndown closed 11 of 15 findings genuinely; the other 4 ship with the appearance of being closed but without the substance.** The pattern across findings #1-#4 is precisely what convention EC-37 was added to prevent: claiming "addressed" without the test that pins the contract AND the call-site that exercises the code. Three separate vacuous tests + one dead-on-arrival code path. This is the meta-finding worth surfacing to the developer: when the council says "demand BOTH a test and a `git grep` of production call sites," it means BOTH must be load-bearing. A test that simulates the post-condition is not a test of the contract that produces it; code with zero callers is not a fix.

**Start with #2 (`resolveCoalescedSignal` dead).** It's the most concrete — one-line wire fix at `routes.ts:1586` OR a revert. The other three P1s are test rewrites that take longer but each independently catches a future regression the current suite doesn't. **#7 (symmetric-path-missing-transformation) is the most embarrassing** — the convention EC-38 was added BY this burndown's first review and immediately violated at a sibling call site in the SAME file. Apply the clamp at line 841 in the same edit as the EC-37 burndown.

**Council member whose domain is most critical right now: Beck.** Three of the four P1s are test-quality issues. The burndown's "every claim has a test" discipline drifted into "every claim has a test-shaped artefact that ships green." Test mutation-resistance — can the test go red if the code regresses to the prior shape? — is the floor that needs holding. Beck's lane should chair the burndown of THIS review.

**Saarinen, Friedman, a11y cluster (#5, #8, #9, #11)** are visual + UX trust issues. Each is one-line edits. Bundle into a single follow-up commit after the P1s land.

**Hunt + Subprocess + Willison + Fowler + Realtime** all returned clean or carry-forward only — no NEW security, lifecycle, LLM, structural, or protocol concerns introduced by the burndown.

---

## Findings Breakdown by Expert

| Expert | P1 | P2 | P3 | Total | Key Areas |
|--------|----|----|----|----|-----------|
| Hunt (Security) | 0 | 0 | 0 | 0 | No new concerns; carried items moved to other lanes |
| Fowler (Refactoring) | 0 | 0 | 0 | 0 | Soft-rejected escalated to Backend ownership |
| Bun/Hono/TS Backend | 1 | 2 | 1 | 4 | dead `resolveCoalescedSignal`, soft-rejected union, chmod swallow |
| FS-JSON Persistence | 0 | 1 | 1 | 2 | EC-38 symmetric-path, chmod swallow (cross-ref Backend) |
| Realtime/NDJSON | 0 | 0 | 0 | 0 | Helper extraction neutral; carried items |
| Subprocess Lifecycle | – | – | – | – | NOT DISPATCHED — no domain changes |
| React/Web UI | 0 | 0 | 1 | 1 | Stale-activeIndex window |
| a11y Auditor | 2 | 1 | 2 | 5 | Vacuous focus test, vacuous footnote test, verified contrast, stale-activeIndex, link affordance, aria-hidden carry |
| Saarinen (UI Quality) | 0 | 2 | 0 | 2 | Overlay token convention + footnote hover collision (cross-ref Friedman) |
| Friedman (UX Quality) | 0 | 1 | 0 | 1 | Sticky preserves stale model → "?" glyph |
| Willison (LLM Pipeline) | 0 | 0 | 0 | 0 | No new concerns |
| Beck (Test Quality) | 1 | 0 | 0 | 1 | Reject-after-success test vacuous (cross-ref Backend) |
| Docker/GHA Deploy | – | – | – | – | NOT DISPATCHED — no domain changes |
| **TOTAL** | **4** | **7** | **4** | **15** | Within 15-finding cap |

**Review output written to:** `.council/review-output/2026-06-04-1826/FINAL-REVIEW.md`

**Expert output files:**
- Hunt: `.council/review-output/2026-06-04-1826/hunt.md`
- Fowler: `.council/review-output/2026-06-04-1826/fowler.md`
- Backend-TS: `.council/review-output/2026-06-04-1826/backend-ts.md`
- Persistence: `.council/review-output/2026-06-04-1826/persistence.md`
- Realtime/NDJSON: `.council/review-output/2026-06-04-1826/realtime.md`
- React/Web UI: `.council/review-output/2026-06-04-1826/react-ui.md`
- a11y: `.council/review-output/2026-06-04-1826/a11y.md`
- Saarinen: `.council/review-output/2026-06-04-1826/saarinen.md`
- Friedman: `.council/review-output/2026-06-04-1826/friedman.md`
- Willison: `.council/review-output/2026-06-04-1826/willison.md`
- Beck: `.council/review-output/2026-06-04-1826/beck.md`
