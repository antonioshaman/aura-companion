# Council Plan (Aura): PR #91 Burndown — 2nd Review Findings

**Scope:** Close 15 findings from 2-го council-review-aura прохода (`.council/review-output/2026-06-04-1826/FINAL-REVIEW.md`) — 4 P1 vacuous-test / dead-code + 7 P2 visual+a11y+type + 4 P3 cleanup. Each finding cites specific file:line — no scope drift permitted.
**Context:** PR #91 (commit `8314318`) shipped 11/15 burndown findings closed cleanly. 4 P1 META-issues остались как `EC-37` violations — claim без load-bearing test/wiring. Этот burndown закрывает все 15.
**Boundaries:** Не трогать новую функциональность (`anthropic-models-cache.ts` orchestrator, ModelSwitcher APG model, sticky preference). Только точечные правки на conventions+contracts. Не bumpаем версии deps.
**Council dispatched:** 11/13 в исходном review — Subprocess и Deploy SKIPPED (no domain changes). Burndown затрагивает Backend-TS, Persistence, a11y, Beck, Friedman, Saarinen, React/Web UI.

---

## Task Sequence

### 1. Wire `parentSignal` from `c.req.raw.signal` at routes.ts call site

| | |
|---|---|
| **Domain** | Backend-TS × Carmack — `feedback_call_site_presence_not_just_symbol_export` |
| **Ref** | `references/quality-backend.md` → Principle 5 (resource lifecycle) |
| **Depends on** | — |

При `getAnthropicModels(settings.anthropicApiKey)` в `routes.ts:1586` пробрасывать второй аргумент `{ parentSignal: c.req.raw.signal }` чтобы дорожка `resolveCoalescedSignal` + `AbortSignal.any` стала live. Дополнительно — behavioural test: симулировать abort от browser-side (через `AbortController`), assertить что fetch к Anthropic прерывается до 5s timeout.

---

### 2. Widen `DynamicModelsStatus` union — добавить `"rejected-stale"` literal вариант

| | |
|---|---|
| **Domain** | Backend-TS × Fowler — Convention `EC-44` (semantic states widen union, не overload variant) |
| **Ref** | `references/quality-backend.md` → Principle 8 (type safety at boundary); `conventions.md` EC-44 |
| **Depends on** | — |

`DynamicModelsStatus = "idle" | "pending" | "resolved" | "rejected" | "rejected-stale"`. Хард-reject (нет prior data) → `"rejected"`, soft-reject (slot non-empty) → `"rejected-stale"`. Не маркировать distinct cases только через присутствие/отсутствие data field — это `feedback_council_documented_contract_canary` shape.

---

### 3. Rewrite reject-after-success test — exercise разную shape по двум branches

| | |
|---|---|
| **Domain** | Beck × Backend-TS — Convention `EC-42` (vacuous test detection) |
| **Ref** | `references/quality-testing.md` → mutation resistance |
| **Depends on** | Task 2 |

После widen union из Task 2, переписать test в `settings-slice.test.ts:312+` чтобы первый run resolved → `dynamicBackendModels[backend] = [...]`, второй run reject → assert `status === "rejected-stale"` AND `dynamicBackendModels[backend]` сохранён. Hard-reject path (no prior data) → assert `status === "rejected"` AND `dynamicBackendModels[backend] === undefined`.

---

### 4. Add behavioural test for `signalCoalesceDegradeLogged` emit + beforeEach reset call

| | |
|---|---|
| **Domain** | Beck × Backend-TS — Convention `EC-22` (typed-channel emit paths require behavioural test) + `AP-17` (module-scope flag requires reset+test+beforeEach) |
| **Ref** | `references/quality-testing.md` → mutation resistance; `conventions.md` EC-22 + AP-17 |
| **Depends on** | Task 1 |

Mock `AbortSignal.any` (через `vi.spyOn(AbortSignal, "any").mockReturnValue(undefined)` или global stub), dispatchить fetch с `parentSignal`, assertить через `findEmitWithEvent(warnSpy, "anthropic-models.signal-coalesce-degraded")`. Добавить `__resetSignalCoalesceFlagForTests()` в `beforeEach` orchestrator-suite чтобы flag не leaked between tests.

---

### 5. Apply EC-38 clamp symmetrically — `readMemoryCache:841` negative-skew fix

| | |
|---|---|
| **Domain** | Persistence × Carmack — Convention `EC-38` + `EC-43` (symmetric audit at convention-add) |
| **Ref** | `references/quality-persistence.md` → Principle 7; `conventions.md` EC-38 + EC-43 |
| **Depends on** | — |

`web/server/anthropic-models-cache.ts:841` — заменить bare `now - record.fetched_at > IN_MEMORY_TTL_MS` на `Math.max(0, now - record.fetched_at) > IN_MEMORY_TTL_MS`. Альтернатива: extract `isWithinTtl(fetched_at, now, ttlMs)` helper и call из обоих sites. Добавить test для negative-skew case (system clock backwards → cache не считается infinitely fresh).

---

### 6. Rewrite rAF autofocus test — flush rAFs synchronously, verify focus.toHaveFocus()

| | |
|---|---|
| **Domain** | Beck × a11y × Carmack — Convention `EC-42` (vacuous test detection) + `EC-37` |
| **Ref** | `references/quality-a11y.md` → Principle 1 (axe is a floor); `conventions.md` EC-42 |
| **Depends on** | — |

`ModelSwitcher.test.tsx:401-423` — заменить `listbox.focus()` simulation на `vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => { cb(0); return 0; })` чтобы rAF flushed synchronously. После `fireEvent.click(trigger)` → `await waitFor(() => expect(listbox).toHaveFocus())`. Test должен RED если кто-то снова заменит `requestAnimationFrame` → `queueMicrotask` ИЛИ удалит open-edge effect.

---

### 7. Rewrite "footnote NOT inside listbox" test — single render, scoped query через within(container)

| | |
|---|---|
| **Domain** | a11y × Beck — Convention `EC-42` |
| **Ref** | `references/quality-testing.md` → Specific desideratum; `conventions.md` EC-42 |
| **Depends on** | — |

`ModelSwitcher.test.tsx:476-491` — single render с `resetStore({ anthropicApiKeyConfigured: false })` BEFORE render. Использовать `const { container } = render(...)`. Open switcher. Получить listbox через `within(container).getByRole("listbox")`, ссылку через `within(container).getByRole("link", { name: /Add an API key/ })`. Assert `expect(listbox.contains(link)).toBe(false)`. Test RED если кто-то вернёт `<a>` внутрь listbox `<ul>`.

---

### 8. Drop `/40` opacity на listbox focus-ring — WCAG 2.4.11 (Focus Appearance AA, 3:1 contrast)

| | |
|---|---|
| **Domain** | a11y × Carmack |
| **Ref** | `references/quality-a11y.md` → Principle 2 (visible focus indicator) |
| **Depends on** | — |

`ModelSwitcher.tsx:280` — заменить `focus:ring-cc-primary/40` на `focus-visible:ring-2 focus-visible:ring-cc-primary` (без opacity). Альтернатива — удалить focus-ring override полностью, дать global `:focus-visible` outline (`index.css:347-351`) применяться. Verify через инспектор: composited color `#d97757` × 100% over `#262624` дает 3:1+.

---

### 9. Differentiate footnote hover styling от option-row hover — visual hierarchy

| | |
|---|---|
| **Domain** | Friedman × Saarinen — `references/quality-ux.md` P6 (lists drive action) + `references/quality-ui.md` (noise vs hierarchy) |
| **Ref** | `references/quality-ux.md` Principle 6 |
| **Depends on** | — |

`ModelSwitcher.tsx:330-334` — заменить `hover:text-cc-fg hover:bg-cc-hover transition-colors` на `hover:underline` (без bg change). Добавить `border-t-2` (вместо `border-t`) для визуального разделителя listbox от footer.

---

### 10. Sticky-preserved stale model → drop "?" glyph + add explanatory tooltip

| | |
|---|---|
| **Domain** | Friedman × Carmack — Trust through reasoning visibility |
| **Ref** | `references/quality-ux.md` Principle 9 |
| **Depends on** | — |

`ModelSwitcher.tsx:104-108` — fallback option construction: drop `icon: "?"`, заменить на `icon: ""`. Добавить `title={\`Model "${currentModel}" not in current available list — preserved from your saved preference\`}` на trigger button чтобы hover/SR-announcement объяснял почему glyph пустой.

---

### 11. Apply codebase overlay convention к ModelSwitcher dropdown — `bg-cc-card border-cc-border rounded-[10px]`

| | |
|---|---|
| **Domain** | Saarinen × Carmack — Component visual consistency |
| **Ref** | `references/quality-ui.md` → component visual consistency |
| **Depends on** | — |

`ModelSwitcher.tsx:270` — заменить outer wrapper className `bg-cc-bg border-cc-separator rounded-lg` на `bg-cc-card border-cc-border rounded-[10px]`. Это согласует с `CouncilToggle`, `Composer`, `LinearAgentEditor`, `Playground` overlays.

---

### 12. Add activeIndex clamp effect — guard mid-open dynamic-list shrink

| | |
|---|---|
| **Domain** | a11y × Friedman cross-ref — React/Web UI architecture |
| **Ref** | `references/quality-frontend.md` (state invariants) |
| **Depends on** | — |

`ModelSwitcher.tsx:174-180` — добавить отдельный `useEffect` с deps `[models.length]` (НЕ `[models]` identity), который clampит `activeIndex` к `Math.min(activeIndex, models.length - 1)` или сбрасывает в `0` если `models.length === 0`. Защищает от `models[activeIndex] === undefined` crash при mid-open Settings save.

---

### 13. Add underline link affordance к footnote — WCAG 1.4.1 (Use of Color)

| | |
|---|---|
| **Domain** | a11y |
| **Ref** | `references/quality-a11y.md` → WCAG 1.4.1 |
| **Depends on** | Task 9 |

`ModelSwitcher.tsx:330-334` — добавить `underline decoration-dotted decoration-cc-muted/40` (или просто `underline`) at rest, не только на hover. Координируется с Task 9 (hover differentiation) — финальный selector: `underline decoration-dotted hover:underline hover:decoration-solid`.

---

### 14. Add `aria-hidden="true"` к decorative SVGs (chevron + checkmark)

| | |
|---|---|
| **Domain** | a11y |
| **Ref** | `references/quality-a11y.md` → decorative element labeling |
| **Depends on** | — |

`ModelSwitcher.tsx:252-254` (trigger chevron) и `:308-310` (selected checkmark) — добавить `aria-hidden="true"` на оба `<svg>`. SR не объявляет "graphic, Switch model button".

---

### 15. Narrow `atomic-write.ts` chmod catch + warn log on bypass

| | |
|---|---|
| **Domain** | Backend-TS × Persistence × Hunt convergence |
| **Ref** | `references/quality-backend.md` → Principle 7 (errors are evidence) |
| **Depends on** | — |

`atomic-write.ts:41-43` — заменить bare swallow на `try { chmodSync(...) } catch (e) { log.warn({ event: "atomic-write.chmod-failed", dir, error_name: (e as Error).name }); }`. Альтернатива: skipать chmod если path не под `COMPANION_HOME` (передавать flag в `writeAtomicJson`). Не absorbим EACCES/EPERM/ENOENT молча.

---

## Risks & Watchpoints

- **Beck — EC-42 contract:** каждый rewrite test (Task 3, 6, 7) MUST go RED при mental revert производственного fix'а. Перед `bun run test` мысленно revert каждую защиту → если test всё равно green → test vacuous, переписать.
- **Backend-TS — EC-43 symmetric audit:** Task 5 закрывает EC-38 violation. После fix запустить `git grep -E "now\s*-\s*\w+\s*>\s*"` чтобы убедиться других sibling sites с тем же shape нет. Если есть — добавить в Task 5 или новую задачу.
- **a11y — JSDOM rAF flush:** Task 6 — `vi.spyOn(window, "requestAnimationFrame")` нужен `mockRestore()` в afterEach иначе leaks между tests. Pair с `feedback_parallel_test_fakes_keyed_by_input`.
- **Backend-TS — `AbortSignal.any` runtime presence:** Task 1 + 4 — `AbortSignal.any` появился в Bun 1.0+ (поддерживается). Если запускается под старым runtime — fallback path. Проверить runtime canary в `getAnthropicModels`.
- **React — JSX-escape sticky tooltip:** Task 10 — `currentModel` идёт в `title` attribute, не в DOM text. JSX-escape applies, но MDN советует не доверять — проверить что `title="..."` не ломается на model id с символами `< > & "`.

## External Setup Required

| # | What | Why | Blocking task |
|---|------|-----|---------------|
| — | None | All changes in-repo | — |

## Summary

| # | Task | Domain | Depends on |
|---|------|--------|------------|
| 1 | Wire `parentSignal` в routes.ts:1586 | Backend-TS | — |
| 2 | Widen `DynamicModelsStatus` union | Backend-TS × Fowler | — |
| 3 | Rewrite reject-after-success test | Beck × Backend-TS | 2 |
| 4 | Add `signalCoalesceDegradeLogged` test + beforeEach reset | Beck × Backend-TS | 1 |
| 5 | EC-38 clamp на `readMemoryCache:841` | Persistence | — |
| 6 | Rewrite rAF autofocus test (flush sync + verify focus) | Beck × a11y | — |
| 7 | Rewrite "footnote NOT inside listbox" test | a11y × Beck | — |
| 8 | Drop `/40` opacity focus-ring (WCAG 2.4.11) | a11y | — |
| 9 | Differentiate footnote hover styling | Friedman × Saarinen | — |
| 10 | Sticky stale model → drop "?" + tooltip | Friedman | — |
| 11 | Apply codebase overlay convention к dropdown | Saarinen | — |
| 12 | activeIndex clamp effect | a11y × React | — |
| 13 | Footnote underline link affordance | a11y | 9 |
| 14 | `aria-hidden` на chevron + checkmark SVGs | a11y | — |
| 15 | Narrow atomic-write chmod catch + warn log | Backend × Persistence | — |

## Verdict

**Самый critical architectural fix — Task 1 (wire parentSignal).** Это распутывает dead-on-arrival surface — `resolveCoalescedSignal` + `signalCoalesceDegradeLogged` flag + `__resetSignalCoalesceFlagForTests` существуют в коде, но никогда не reached в production. После Task 1, Task 4 (тест emit-path) становится actually testable. Альтернатива — revert этой surface, но реальная P2-BT-1 угроза (browser cancel → server keeps hitting Anthropic) остаётся unfixed. Wire-up cheaper чем revert.

**Самый embarrassing fix — Task 5 (EC-38 symmetric clamp).** Конвенция EC-38 была добавлена ПЕРВЫМ review burndown и СРАЗУ нарушена на sibling site в том же файле. Classic `feedback_symmetric_path_missing_transformation`. EC-43 теперь codified чтобы предотвратить повтор.

**Beck owns burndown chair.** 3 из 4 P1 — vacuous tests. EC-42 (vacuous-test detection) — convention этого review. Каждый rewritten test должен mutation-test-pass: mental revert production fix → test goes RED. Если нет — test не контракт-pin, удалить.

**Order:** Start с Task 1 (одна строчка wire) → Task 4 (зависит от 1) → Task 2 → Task 3 (зависит от 2) → Task 5 (1 LOC + 1 тест) → bulk visual cluster Task 6-11 → P3 cleanup 12-15. Task 15 (atomic-write) last — narrow scope, low risk.
