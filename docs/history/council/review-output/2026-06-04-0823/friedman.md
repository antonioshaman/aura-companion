# Friedman (UX Quality) — Review of PR #91

Scope: `web/src/components/ModelSwitcher.tsx`, `web/src/components/HomePage.tsx`, `web/src/components/SettingsPage.tsx`.

UX lane only — visual aesthetics deferred to Saarinen; ARIA / keyboard semantics deferred to a11y. Items already explicitly addressed in PLAN-aura-dynamic-model-list.md "Risks & Watchpoints" (sticky-vs-dynamic[0] arbitration rule, EC-22 emit-path test list, recording exclusion, Hunt pre-auth oracle, Fowler stretch, Codex move) are NOT re-flagged.

---

## P1 — Trust break: sticky preference silently dropped at backend switch

**File**: `web/src/components/HomePage.tsx:246-264`

**Symptom**: `switchBackend(newBackend)` calls

```
setModel(pickSessionDefaultModel(newBackend, dynamicForNew));
```

with `stickyPreference` arg **omitted**. The signature in `web/src/utils/backends.ts:182-194` is `(backend, dynamic?, stickyPreference?)` — when sticky is undefined the helper falls to `dynamic[0]` (newest snapshot).

**UX consequence**: A user who explicitly pinned `claude-opus-4-7` in Settings ("Anthropic Model" field, `SettingsPage.tsx:758-768`) clicks the Codex tile, comes back to Claude, and finds the New-Session form has silently swapped them onto `claude-opus-4-8` (or whichever Anthropic publishes next). This is the exact P9 "every time a user discovers a mistake, it's a small betrayal of trust" pattern from the reference doc — the user typed a model name in Settings as a deliberate preference, and a backend toggle invisibly overrides it. The discovery moment is delayed: token bill arrives at month end on a model the user didn't choose; or the assistant's behaviour is subtly different and the user can't reproduce a result they got yesterday.

**Why this is P1 and not P2**: the plan's "Risks & Watchpoints" explicitly named the sticky rule (line 219 of PLAN — *"Sticky vs dynamic[0] (Frontend R1, Friedman R1): When `settings.anthropicModel === 'claude-opus-4-7'` AND dynamic includes both 4-7 and 4-8, `pickSessionDefaultModel` returns 4-7 (sticky wins). Test explicitly."*) AND surfaced sticky-preference plumbing as parked in the context-brief observation 6. The contract is documented. Implementation does not honour it. The reference doc Principle 9: "Trust compounds slowly, breaks fast." Data-consistency drift between Settings (where the user stated their choice) and New Session (where it's ignored) is the textbook trust-erosion pattern.

**Scope decision tension**: brief says "parked per plan." But the plan's Watchpoints section did NOT park it — it required a test. Parking the *plumbing* means the test cannot be written. The current state is a regression against documented intent, not deferred work. Either (a) call site passes `settings.anthropicModel` (slice's `anthropicModel` field if present, else trip the settings fetch), or (b) the plan's Watchpoints text needs an explicit "Friedman-R1 deferred to follow-up; user-visible regression accepted for one milestone" annotation so reviewers don't keep flagging.

**Recommendation**: pipe `useStore.getState().settings?.anthropicModel ?? null` into the third arg at HomePage.tsx:253. If the settings-slice doesn't yet carry this field, this PR should add it (it's already touching the slice).

---

## P2 — Latest badge vs Selected check: same row can carry both meanings, current impl suppresses one

**File**: `web/src/components/ModelSwitcher.tsx:245-254`

**Symptom**: The badge logic reads `{isLatest && !isSelected && <span>Latest</span>}` — the `&& !isSelected` clause **hides "Latest" from the row the user is currently on**.

**UX consequence**: When the user is already on the newest model (`claude-opus-4-8`), they open the dropdown and see no "Latest" badge anywhere on the Opus tier. They cannot tell from the dropdown alone whether (a) they're on the latest, (b) there is no latest tracked, or (c) the badge feature is broken. The signal is most useful precisely when the user is NOT on it (so they know they're behind); the suppression rule was correct intent. But the cost is that "currently using the latest" — a positive trust signal worth showing — disappears. P9 from the reference doc: "no confidence indicators where helpful."

**Why this is P2 not P1**: the user can still complete model selection. But this is a 3-line fix that adds meaningful trust signal: show "Latest" on the selected row too (it's compatible with the checkmark — two distinct facts). Or, swap the checkmark slot to render `Latest ✓` together when both true. Either resolves the ambiguity.

**Secondary concern — semantic ambiguity of the word**: "Latest" reads to some users as "most recently used by me" (browser-tab metaphor) rather than "newest snapshot Anthropic published." A dev tool audience will probably read it as newest-published in context, but the badge has no tooltip explaining the term. Suggested copy: tooltip `title="Newest snapshot Anthropic publishes for this tier"` on the badge `<span>` — the badge already has a stable visual slot, adding hover-context costs nothing.

---

## P2 — Footnote link is not actionable; users in the dropdown cannot reach Settings

**File**: `web/src/components/ModelSwitcher.tsx:263-267`

**Symptom**:

```
<div className="px-3 py-2 border-t border-cc-separator text-[11px] text-cc-muted">
  Add an API key in Settings to see more models.
</div>
```

is plain text — no `<a>`, no `onClick`, no visible underline, no `cursor-pointer`. The word "Settings" reads like a navigation target but isn't one.

**UX consequence**: A new user with no Anthropic key opens the model dropdown mid-session, sees 3 fallback models, reads the footnote, and now has to (a) remember the suggestion, (b) close the dropdown, (c) find the Settings entry in some other surface (sidebar / top-bar / `#/settings` hash they don't know about), (d) navigate there, (e) scroll to the Anthropic section. Each step is a chance to lose the user. The reference doc Principle 7: "Settings buried without clear path — if the user can't find them from the home view in <3 clicks, they're hidden." From the dropdown, Settings is reachable in zero clicks — but only if the footnote becomes a button or link.

**Recommendation**: render the footnote as `<a href="#/settings">Add an API key in Settings to see more models.</a>` with `text-cc-primary hover:underline` styling, and `onClick={() => setOpen(false)}` so the dropdown closes before navigation. Cost: 2 lines.

**Adjacent concern**: footnote is silent on the path that triggers the *interesting* sub-case — key configured but Anthropic upstream unavailable. Both states render the same dropdown. See P3 below.

---

## P2 — Silent upstream-failure fallback is a trust-erosion path the plan parked but the reference doc resists

**File**: `web/src/components/ModelSwitcher.tsx:58-62` and the settings-slice's status handling

**Symptom**: When `dynamicModels === undefined` AND `anthropicConfigured === true`, no signal whatsoever appears in the dropdown — same UI as the no-key user, no "couldn't reach Anthropic," no retry button, no last-fetch timestamp.

**UX consequence**: Reference doc Principle 9 — "AI validator denies a tool. The user sees 'denied' with no explanation. They lose trust in the validator." Same shape: a user who DID configure a key sees only the static 3 models during an Anthropic outage or transient 503 with no signal that the system tried and failed. Their working model — "I configured the key, so I see all models" — silently inverts without notification. On next session they wonder if their key got revoked, dig into Settings, find it valid, get confused.

**Scope-text tension**: PR brief says "Plan scope said this is intentional; Friedman R7 disagreed in plan." This means Friedman R7 *was* a finding at plan time, and was overruled (not addressed). The reference doc Principle 2 lists "five screen states: blank, loading, partial, error, ideal" as a P1 in primary views; this collapses error into ideal, which is the regression the doc warns about. I'm re-flagging per the brief's invitation ("worth re-flagging?") — the right answer might still be parked, but it should be parked **explicitly** in the Risks & Watchpoints section with a token that says "Friedman R7 overruled; revisit if upstream outages become frequent." The current state is implicit deferral, which means a future contributor reading the code can't tell whether this is intentional or an oversight.

**Minimum acceptable signal short of full error state**: a `title` on the trigger button that surfaces last-fetch state — `"Latest list fetch: 12 minutes ago"` when stale, `"Couldn't refresh model list from Anthropic"` when current attempt failed. Tooltip-only; doesn't add a state pill; doesn't violate the scope's "silent fallback" intent because the dropdown UI itself doesn't change. Implementation cost: one selector on `dynamicBackendModelsStatus` + `lastFetchAt` from the slice (if not present, this PR is the right surface to add it).

---

## P2 — Dropdown rebuilds under the user's hand after Settings save

**File**: `web/src/components/SettingsPage.tsx:205-207` × `web/src/components/ModelSwitcher.tsx:52-53`

**Symptom**: `onSave` in SettingsPage calls `loadBackendModelsSlice("claude")` after a key save. The settings-slice updates `dynamicBackendModels.claude` on resolve. ModelSwitcher anywhere in the tree subscribes via `useStore((s) => s.dynamicBackendModels[backendType])` and re-renders on slice mutation.

**UX consequence**: The Settings page is reachable from in-session navigation (`SettingsPage.tsx:288-299` "Back" button returns to the previous session) and may be opened in an embedded surface (`embedded` prop). If the user has the Settings page open *embedded* alongside a session with an open ModelSwitcher dropdown — or, more plausibly, navigates back to a session that was actively streaming — the dropdown list mutates mid-interaction. The user's `activeIndex` may now point at a different row's model (index N was "haiku-4-5" before refresh, may be "opus-4-8" after if the server re-sorted).

The reference doc Principle 3: "Never freeze the interface on a single input" speaks to NOT blocking input, but the corollary applies — don't rearrange the input target out from under the user. A dropdown shifting under an active keyboard navigation is mid-interaction disruption.

**Why this is P2**: probability is low — Settings save followed by an open dropdown in the same window in <100ms requires specific multi-tab or embedded-Settings configurations. But the failure mode (user presses Enter, commits a different model than they were aiming at) is a P9 trust break.

**Recommendation**: in ModelSwitcher's `useEffect` that initialises `activeIndex` on open, also re-resolve `activeIndex` when `models.length` changes while open — find the previously-active model by value (not index) and restore the cursor onto its new index, or close the dropdown if the previously-active value is no longer present. Treats the user's keyboard cursor as a value-anchor, not a position-anchor.

---

## P3 — Five-state mapping for the dropdown collapses three into one; document the choice in code

**File**: `web/src/components/ModelSwitcher.tsx:52-62`

**Symptom**: Per the brief's enumeration — blank (N/A), loading (silent — static shown), partial (N/A), error (silent — static shown), ideal (dynamic). Loading and error both collapse onto the static fallback. The reference doc says all five states need designed treatment for primary views.

**UX consequence**: Acceptable for this scope, but two of three "collapsed" states have meaningfully different user models:
- **Loading**: user just opened a fresh tab; key is configured; will get the live list in ~200ms. Showing static for 200ms then mutating to dynamic is a flicker.
- **Error (key configured)**: see P2 above — silent.
- **No key**: footnote renders.

The current rendered surface treats all three as one. The plan accepted this, so it's not a fix-now item. The recommendation here is **inversion-canary commentary**: add a code comment at the `dynamicModels ?? getModelsForBackend(backendType)` site documenting WHICH of the five Hurff/Friedman states each `undefined` value represents and why they collapse. A future contributor will otherwise read this as "we forgot loading state" and add a spinner that flickers on every dropdown open. The comment is the durable defence against that regression.

(This is the same shape as the plan's existing aria-live regression-by-absence canary, but for UX state semantics.)

---

## Out of scope but noting

The "Anthropic Model" free-text input in SettingsPage (`SettingsPage.tsx:761-768`) is the sticky-preference's authoring surface. It is a free-form text field with no validation against the live model list, no dropdown autocomplete from `dynamicBackendModels.claude`. Reference doc Principle 5: a typed model name is one typo away from a default-model-mismatch the user can't see at session creation. **Not flagging as P1/P2 for this PR** because the field predates this PR; but post-this-PR, the dynamic list IS available client-side, and the natural follow-up is to convert this input to a combobox over `dynamicBackendModels.claude`. Worth a follow-up issue.

---

## Summary

| # | Sev | Theme |
|---|-----|-------|
| 1 | P1 | Sticky preference dropped at switchBackend (plumbing parked but contract documented; regression against PLAN watchpoint) |
| 2 | P2 | "Latest" badge suppressed on currently-selected row; semantic ambiguity of the word |
| 3 | P2 | No-key footnote is non-clickable text, breaks 3-click rule to Settings |
| 4 | P2 | Silent upstream-fail fallback (re-flag per brief invitation) — minimum: tooltip surface |
| 5 | P2 | Dropdown list rebuild under active keyboard interaction after Settings save |
| 6 | P3 | Document five-state collapse with inversion-canary comment |

Three P2s and one P1 are the load-bearing items. P1's resolution is the single line `, settings.anthropicModel` at HomePage.tsx:253 — the plan's own watchpoint demands it, and the implementation omits it. Either fix it in this PR or amend the Risks & Watchpoints section to acknowledge the deferral so the next reviewer doesn't re-flag.
