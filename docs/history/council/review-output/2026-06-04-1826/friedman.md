# Friedman (UX Quality) — Second Pass Review of PR #91 (post-burndown)

Scope: `web/src/components/ModelSwitcher.tsx`, `web/src/components/HomePage.tsx`, `web/src/components/CronManager.tsx`, `web/src/components/SettingsPage.tsx`.

UX lane only. Verification of first-review verdict (1 P1 + 4 P2 + 1 P3) plus new regression hunt.

---

## Burndown verification (first-review findings)

### P1 #1 — Sticky `anthropicModel` dropped at switchBackend — **CLOSED**

Verified at two call sites and at one persistence-edge site:

- `HomePage.tsx:257-260` reads `useStore.getState()` snapshot and passes `snap.anthropicModel` as the third arg when `newBackend === "claude"` (null for codex). Shape matches `pickSessionDefaultModel(backend, dynamic?, stickyPreference?)` in `backends.ts:190`.
- `CronManager.tsx:854-861` inline-callback IIFE reads the snapshot the same way and routes through `update({ backendType, model })` atomically — sticky preference now survives backend toggle in cron editor too.
- `SettingsPage.tsx:207-216` hydrates the slice with the saved `anthropicModel` immediately after `api.updateSettings` succeeds, so the next `switchBackend` reads the fresh value (no stale-slice race window between save and next mount).

The "test-exists-call-site-does-not" shape from the first review is closed. EC-37 watchpoint discipline satisfied: test + call-site verified in production code. Note `CronManager` opts for an inline IIFE rather than a hoisted helper — acceptable in a one-callback site, but if a third caller appears the IIFE pattern should be promoted (see new finding below for follow-up).

---

### P2 #2 — Latest badge suppressed on selected row + semantic ambiguity — **RE-FLAG (still open)**

**Status:** Not addressed in burndown. Code at `ModelSwitcher.tsx:302-306` retains the original `{isLatest && !isSelected && <span>Latest</span>}` — the badge still hides on the row the user is currently on, and the word "Latest" still carries no tooltip explaining whether it means "newest snapshot Anthropic published" or "most recently used by me." Re-stated as P2 in this second pass; the trust signal "you are on the newest model" is still absent precisely when it would reassure the user that no upgrade is pending.

Re-flagged because the burndown did not document the deferral as intentional in the diff (no comment, no PLAN annotation pointing reviewers at the trade-off). Per `feedback_council_documented_contract_canary`, an unstated deferral becomes an implicit forever-deferral. Either fix (drop the `!isSelected` clause OR co-render `Latest ✓` together on the selected row) or land a one-line comment naming this as a deliberate scope decision so the next reviewer doesn't reopen it.

---

### P2 #3 — Footnote not clickable — **CLOSED**

Verified at `ModelSwitcher.tsx:327-335`. Now `<a href="#/settings" onClick={() => setOpen(false)} className="block ... hover:text-cc-fg hover:bg-cc-hover transition-colors">`. The click handler dismisses the dropdown before navigation, so the user doesn't return to a session with a phantom open dropdown after the hash route fires. The `block` class makes the whole row a click target (not just the text run), aligning the hit area to the visual row.

Also verified the structural restructure: the `<a>` now sits as a sibling of the `role="listbox"` div, both inside the dropdown wrapper. SR no longer iterates it as a phantom option (the P2.1 a11y cross-ref from the first review is also resolved by the same edit).

**Sub-concern (NEW, see below):** the link's hover styling now matches the option rows almost exactly — `hover:text-cc-fg hover:bg-cc-hover` is the same hover signature as the options. Visually, the affordance may not clearly distinguish "navigate to Settings" from "select this row as a model." Captured as new finding #N1 below.

---

### P2 #4 — Silent upstream-fail fallback — **RE-FLAG (still open)**

**Status:** Not addressed. `ModelSwitcher.tsx:74-78` still derives `showNoKeyHint` purely from `anthropicConfigured === false`. The "key set but upstream failed" branch still renders the static fallback identically to the cold zero-config user — no tooltip, no `title` on the trigger surfacing fetch-state, no rejected-status indicator.

The burndown's settings-slice changes (P2 #9 fix — preserve known-good data on reject) actually improve the data-layer story (a transient flake no longer clobbers a prior good list), but the UI surface still doesn't expose this state at all. A user whose key is configured AND whose Anthropic upstream is down AND whose memory cache is empty (fresh tab post-crash) sees the same dropdown as the no-key user — minus the actionable footnote. This is strictly worse than the no-key case because the no-key user at least has a path to action.

Minimum acceptable signal short of a full error pill remains the same as the first review: `title` on the trigger button surfacing last-fetch state, or an inline non-option footnote row when the rejected-status flag is set. Re-flagged at P2.

---

### P2 #5 — Dropdown rebuilds under active keyboard nav after Settings save — **PARTIALLY CLOSED, sub-concern remains**

Verified `wasOpenRef` at `ModelSwitcher.tsx:168-182` is correctly gating the open-edge: the focus reset + activeIndex initialization fires once per false→true transition, not on every render while open. This DOES prevent the prior shape where every slice mutation re-ran the initializer and snapped focus + activeIndex back to the selected row.

However, the burndown ALSO removed `models` from this effect's dep array (lines 159-165 comment block). The rationale: keep keyboard cursor stable when the list refreshes mid-navigation. The new shape's `handleListboxKeyDown` clamps via `Math.min(i + 1, models.length - 1)` and `Math.max(i - 1, 0)` so out-of-bounds is structurally prevented.

**Sub-concern (UX, not bug):** with `models` no longer in the dep array, the cursor is now a position-anchor across list mutations, NOT a value-anchor. If models = `[opus-4-7, sonnet-4-6, haiku-4-5]` and the user has activeIndex=1 (sonnet), then a slice refresh inserts a new `opus-4-8` at index 0, activeIndex=1 now points at `opus-4-7` instead of `sonnet-4-6`. The Enter key would commit the WRONG model. This is exactly the "rearrange the input target out from under the user" shape from my first review's P2 #5 — the open-edge gate fixed the focus race but the activeIndex desync persists.

Recommendation unchanged from first review: track the previously-active model BY VALUE, re-resolve activeIndex when models length/content changes while open, fall back to closing the dropdown if the previously-active value is no longer in the list. The `wasOpenRef` gate doesn't substitute for value-anchored cursor restoration; it just stops a different bug.

Re-flagged at P2 — the trust break (user presses Enter, gets the wrong model) survives the burndown.

---

### P3 #6 — Five-state collapse documentation — **NOT ADDRESSED**

No code comment was added at the `dynamicModels ?? getModelsForBackend(backendType)` site documenting which of the five (blank/loading/partial/error/ideal) states collapse onto static. The inversion-canary commentary recommended in the first review is still absent. Re-stated at P3, same recommendation.

---

## NEW findings introduced by the burndown

### N1 — Footnote `<a>` hover styling collides with option-row affordance — **P2**

**File:** `ModelSwitcher.tsx:327-335`

**Symptom:** The footnote `<a>` now renders with `block px-3 py-2 border-t border-cc-separator text-[11px] text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors`. Compare to an option row at `ModelSwitcher.tsx:286-292`: `w-full flex items-center gap-2 px-3 min-h-[44px] text-[13px] transition-colors cursor-pointer ... hover:text-cc-fg hover:bg-cc-hover`. The hover-color signature (`text-cc-fg` + `bg-cc-hover`) is **identical**. The visual differentiators are only:

- Smaller font (`text-[11px]` vs `text-[13px]`).
- Top border (`border-t border-cc-separator`).
- Shorter min-height (no `min-h-[44px]`).
- No icon column / no trailing badge.

A confused user — particularly someone who never used the dropdown before — could read the footnote as a fourth (or N+1th) option in the list. Hovering it shows the same background highlight as hovering any model row. Clicking it dismisses the dropdown AND navigates to a new view, which is a more destructive outcome than clicking a model row (which only sets a session model).

**UX consequence:** This violates reference doc Principle 5 ("ambiguity at decision points"): two visually-similar affordances with different action models in the same overlay. The fix from the first review was correct in spirit — make it clickable — but the styling adopted from option rows imports their affordance signature.

**Recommendation:** Distinguish the link visually from option rows. Options:

- Use a different hover signature (e.g. `hover:text-cc-primary hover:underline` and DROP `hover:bg-cc-hover` — link-style underline, not row-style fill).
- Add an external-link or arrow glyph after "Settings" so the navigation intent is iconographically marked.
- Render the link inline inside a non-hoverable footnote `<div>`: `<div className="px-3 py-2 border-t text-[11px] text-cc-muted">Add an API key in <a href="#/settings" className="text-cc-primary hover:underline">Settings</a> to see more models.</div>` — only the WORD "Settings" is the link, not the whole row. This is the most familiar pattern; users have seen it on every product onboarding page.

Cost: 2 lines. The third option above is the most idiomatic and aligns with the reference doc Principle 7 (path discoverability via familiar link patterns).

---

### N2 — `pickSessionDefaultModel` snapshot-read in render-adjacent callback — **P3**

**File:** `HomePage.tsx:257-260`, `CronManager.tsx:854-861`

**Symptom:** Both call sites now read the slice via `useStore.getState()` inside an imperative callback, rather than subscribing to `anthropicModel` via `useStore((s) => s.anthropicModel)`. This is technically correct (the callback fires at click-time, so a snapshot read gives the current value), and avoids re-rendering the component when only `anthropicModel` changes.

**UX consequence:** Subtle — if `anthropicModel` is hydrated via the post-save flow (SettingsPage:211-216) WHILE the user has the HomePage form open with a Claude→Codex→Claude toggle mid-flight, the snapshot read does pick up the freshly-hydrated value. So functionally correct. BUT this pattern relies on `getState()` being current at click-time; if a future refactor introduces a stale-closure (e.g. `useEffect` capturing the callback in deps), this silently regresses to "uses model from when the component mounted." The first-review feedback `feedback_call_site_presence_not_just_symbol_export` shape applies here: snapshot reads in callbacks are correct-today, fragile-tomorrow.

**Recommendation:** Subscribe to `anthropicModel` at component level with a memoized selector (already a slice surface — `selectAnthropicModel` per the brief), pass via closure. Same end state, one fewer fragile invariant. Not a regression today; documenting the watchpoint so a future refactor doesn't drift.

P3 — defensible-as-is, not a ship blocker.

---

### N3 — Stale-preference `anthropicModel` not in dynamic list → trigger shows "?" — **P2**

**File:** `ModelSwitcher.tsx:99-101` × `backends.ts:23-39` (post-burndown pickIcon — returns `""` for unknown Claude slugs)

**Symptom:** Sticky preference flow now correctly seeds the New Session model from `settings.anthropicModel`. But: what if the user pinned `claude-opus-4-6` six months ago, Anthropic retired that snapshot, and the dynamic list now contains `[claude-opus-4-8, claude-sonnet-4-7, claude-haiku-4-6]`? The session spawns with `claude-opus-4-6`, the CLI accepts it (or rejects late), and `ModelSwitcher.tsx:99-101` falls into the synthetic `currentOption = { value: currentModel, label: currentModel, icon: "?" }` branch.

The user opens the model trigger and sees `? claude-opus-4-6 ▼` — a literal question-mark icon next to a model name that isn't in the dropdown list. No explanation. No "this model is no longer available" message. No hint that the sticky preference is stale.

**UX consequence:** This is the regression direction the burndown introduced: by preserving sticky preference across backend toggles, we ALSO preserve preferences that are no longer valid. Reference doc Principle 9: "the user types a name in Settings, six months later the system shows '?' next to it with no explanation, they wonder what's wrong with their config." The fix for P1 #1 (sticky-preference plumbing) increases the surface area where stale preferences manifest.

Worth noting the `pickIcon` "?" symptom predates this PR (it's the synthetic `currentOption` fallback's hardcoded `icon: "?"` at `ModelSwitcher.tsx:101`), but the sticky-preference plumbing makes it more reachable: previously, every backend toggle reset to `dynamic[0]` (latest), wiping stale state. Now stale state is preserved.

**Recommendation, layered:**

1. (Minimum) At the synthetic-fallback site, change `icon: "?"` → `icon: ""` to match the post-burndown Claude convention of icon-less. Trigger renders just the slug, no scary glyph. ~1 LOC.
2. (Better) When `currentModel` is non-empty AND `dynamicModels` is populated AND `currentModel` is NOT in the list, render a subtle indicator on the trigger: `title="This model may no longer be available — click to switch"` or a yellow dot. Surfaces the staleness with a path to action.
3. (Best, follow-up) In SettingsPage, when the user types `anthropicModel`, validate against `dynamicBackendModels.claude` on blur. Out-of-list values get a hint: "This model isn't in your current list — it may have been retired." Predates this PR per the first review's "Out of scope but noting" tail; the sticky-plumbing fix makes it more pressing.

P2 because the user-visible "?" with no context is a small trust break for an at-best-uncommon-but-very-confusing case, and the minimum fix (#1) is one line.

---

## Summary

| # | Sev | Status | Theme |
|---|-----|--------|-------|
| 1 | P1 | CLOSED | Sticky preference at switchBackend (HomePage + CronManager + SettingsPage hydration all verified) |
| 2 | P2 | RE-FLAG | "Latest" badge still suppressed on selected row; no tooltip on semantic ambiguity |
| 3 | P2 | CLOSED | Footnote now clickable + closes dropdown + outside listbox |
| 4 | P2 | RE-FLAG | Silent upstream-fail still indistinguishable from cold no-key state |
| 5 | P2 | PARTIAL | wasOpenRef closes focus race; activeIndex still position-anchored across list mutations |
| 6 | P3 | NOT ADDRESSED | Five-state collapse undocumented in code |
| N1 | P2 | NEW | Footnote hover-styling matches option-row affordance; risk of mis-click |
| N2 | P3 | NEW | `getState()` in callbacks is correct-today, fragile-tomorrow |
| N3 | P2 | NEW | Sticky-preference fix surfaces stale-preference "?" icon trigger with no explanation |

**Verdict on burndown:** Two of six first-review findings closed cleanly (P1 #1, P2 #3). One partially closed with a residual sub-concern (P2 #5). Three left open and re-flagged (P2 #2, P2 #4, P3 #6). Three new UX findings introduced by the burndown (N1, N2, N3) — all derive from the structural changes the burndown made, two as direct cost-of-fix consequences (N1 from the clickable-footnote affordance import, N3 from the sticky-preference plumbing reaching stale state).

**Single most load-bearing item this pass:** N3 (stale preference → "?" icon). The PR's positive UX contribution — preserving user choice across backend toggles — silently expands the blast radius of an older "?" fallback that previously got wiped on every toggle. The one-line fix (drop `icon: "?"` → `icon: ""`) is cheap; the layered staleness-surfacing is a worthy follow-up.

**Cluster theme:** the burndown's mechanical patches are correct (P1 closed, focus race closed, footnote clickable) but the **second-order UX consequences** — affordance collision (N1), stale-preference surfacing (N3), value-anchor desync (P2 #5 residual) — are exactly the class of issue that emerges when you patch the canary without revisiting the broader interaction model. The first review surfaced the immediate gaps; this pass surfaces what the patches imply.
