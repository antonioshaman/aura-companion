# React/Web UI Frontend Review (SECOND PASS) — Carmack Council

**Reviewer:** React 19 + Zustand + Tailwind Web UI Expert
**Stack:** React 19 / Vite 6 / Tailwind 4 / Zustand 5
**Date:** 2026-06-04 (second pass — post-burndown)
**Scope:** PR #91 burndown commit `9d922c0`, frontend-only.
**Files reviewed:**
- `web/src/components/ModelSwitcher.tsx`
- `web/src/components/HomePage.tsx` (Task 10 hunk @ ~250-260)
- `web/src/components/CronManager.tsx` (Task 10 hunk @ 848-862)
- `web/src/components/SettingsPage.tsx` (hydrate + save paths)
- `web/src/store/settings-slice.ts`
- (cross-ref) `web/src/utils/backends.ts` + `backends.test.ts` for P1-2 pin

**Convention floor honoured (not re-flagged):** EC-1..EC-41, AP-1..AP-16
(per context-brief §"Accepted conventions"), including the 6 added in
Phase 7 of the first review. PLAN-aura-dynamic-model-list "Risks &
Watchpoints" parked items (Fowler R4 separate slice, sticky-vs-dynamic[0]
test invariant) NOT re-flagged.

**Out of scope (other lanes):** a11y (focus contract pins now live in
ModelSwitcher.test — those are a11y's lane; this review treats the React
mechanism only — `requestAnimationFrame`, `wasOpenRef`, dep arrays),
visual design (Saarinen), UX flow (Friedman).

---

## First-pass burndown verification

| # | First-pass finding | This-pass status | Notes |
|---|---|---|---|
| P1-1 | `s.sdkSessions.find()` whole-store selector identity churn | **NOT CLOSED — still present, but downgraded by FINAL** | `ModelSwitcher.tsx:34-36` unchanged. FINAL-REVIEW removed this from the P1 cluster (Friedman's P1#1 sticky preference took the slot). See **NEW P2-1** below. |
| P1-2 | `pickIcon` Codex position-dependent fallback | **CLOSED** | `backends.ts:38` returns `""`. Regression pin lives at `backends.test.ts:59-86` (two tests: empty-icon on generic, stable-across-reorder). Good. |
| P2-1 (1st pass) | Two parallel write paths to `sdkSessions.model` | **NOT TOUCHED** — `ModelSwitcher.tsx:103-120` unchanged. Re-asserted as still-a-smell at **NEW P3-1**. Burndown did not pick this up and FINAL didn't escalate it; standing by the prior recommendation but P3 (silent UI lie during failure window, not data corruption). |
| P2-4 (1st pass) | ModelSwitcher missing `loadBackendModels` mount | **CLOSED** | `ModelSwitcher.tsx:66-69` adds the effect. Test pin at `ModelSwitcher.test.tsx:462-468` (mount fires `loadBackendModels("claude")`). JSDoc/code disagreement closed. See **NEW P2-2** for the re-render-per-pair concern this introduces. |
| P2-5 (1st pass) | Sticky preference not wired at call sites | **CLOSED** | `HomePage.tsx:257-260` pulls `storeSnapshot.anthropicModel` and passes as third arg. `CronManager.tsx:854-861` mirrors. Slice extension (`anthropicModel` field + `selectAnthropicModel` + hydrate-on-save path) all present. Both call sites use `useStore.getState()` snapshot rather than subscribing — correct for an imperative one-shot (no need to re-run switchBackend on slice change). |
| P2-6 (1st pass) | `queueMicrotask` autofocus + `models` dep race | **CLOSED** with caveat | `ModelSwitcher.tsx:169-182`: `queueMicrotask` → `requestAnimationFrame`; `wasOpenRef` open-edge tracker added. Comment correctly explains intent. Caveat captured at **NEW P3-2** (dep array still names `models` + `currentModel`, but the new `wasOpenRef` guard short-circuits the re-fire — so the deps are now noise that exhaustive-deps demands, not a bug. Worth a one-liner extraction). |
| P3-1 (1st pass) | Work before codex early-return | **NOT TOUCHED** | `ModelSwitcher.tsx:34-194` still runs all selectors/memos before the `:231` early-return. Free perf win, still on the table. Re-flagged as P3 below (**NEW P3-3**). |
| P3-2 (1st pass) | Slice JSDoc widened invariant | **PARTIALLY CLOSED** | Slice header `settings-slice.ts:1-21` is unchanged ("Holds only flags the server owns"). The field-level JSDoc at `:88-104` does acknowledge the cohesion stretch and cites Fowler R4 parking. Acceptable — header drift is the lighter sin and the field-level call-out is honest. Closing as good-enough; would still gently nudge to update the header on a follow-up. |
| P3-3 (1st pass) | `undefined`-vs-empty discriminator conflation | **NOT CLOSED — semantics RELOCATED, NOT FIXED** | `settings-slice.ts:280-302` introduces "soft-rejected" (status=`rejected` but data preserved) AND the original empty→undefined→fallback path still exists at `:252` (`fetched.length > 0 ? toModelOptions(fetched) : undefined`). The discriminator is now THREE-valued at the data slot (`undefined` = never-fetched / fetched-empty / fetched-rejected-and-no-prior-data) but only TWO-valued at the status slot (`rejected` may mean "no data" OR "stale data preserved"). See **NEW P2-3** — this is a real regression vector from the burndown. |

---

## Items the context-brief asked me to spot-check in the new code

### 1. `loadBackendModels` catch has two return paths — clean or drift-prone?

`settings-slice.ts:280-302`. Reading literally:

- Token-superseded short-circuit at `:280` (pure no-op, status untouched).
- Inside `set(...)`: if `currentSlot !== undefined && currentSlot.length > 0` → status="rejected", data preserved. Else → status="rejected", data still `undefined`.

The two branches return DIFFERENT shapes (one keeps `dynamicBackendModels`
out of the partial, the other also does — they're actually identical
in shape: both write only `dynamicBackendModelsStatus`). The conditional is
load-bearing only as a comment-level distinction ("soft-rejected" vs
"true-rejected"). The two SET writes have the same effect; they could be
collapsed to a single `set` that always writes only the status, and the
branch would disappear. As-shipped: drift risk is real but small — a
future contributor "improves" the soft-rejected branch by adding a
sentinel like `dynamicBackendModels: { ...s.dynamicBackendModels, [backend]: prior }`
(which is a noop) and the asymmetry suddenly matters. **Recommendation:**
collapse the two branches to one `set` writing only the status field;
move the discriminator into a log line if you want to preserve the
intent. Counts as **NEW P3 below** (P3-4).

### 2. `wasOpenRef.current = false` cleanup on `!open` — React 19 concurrent races?

`ModelSwitcher.tsx:169-182`. The pattern is sound. Concurrent rendering in
React 19 may re-run renders but effects don't fire mid-render — the
useEffect body runs in the commit phase. The `wasOpenRef = false` write
in the `!open` branch is idempotent (already false when not open most
of the time) and the `if (wasOpenRef.current) return` guard correctly
prevents double-fire on the false→true edge even if the effect runs twice
under StrictMode double-invoke. **No concern.** One small note: the
cleanup IS in the body, not in a returned cleanup function, so if open
flips true→true→true (e.g., a forced re-render while open) the effect
fires per render but the body's `if (wasOpenRef.current) return` short-
circuits. Correct.

### 3. Mount-effect `loadBackendModels` in council-mode pairs — re-render storm?

`ModelSwitcher.tsx:66-69`. The selector `useStore((s) => s.loadBackendModels)`
returns the action function reference, which is stable across the store's
lifetime (Zustand state-creator returns the function once at
createStore time, never recreated). So the dep `loadBackendModels` is
identity-stable; the effect fires only on `backendType` change. Two
ModelSwitchers (one per pair half) each fire ONE mount call, both
collapse server-side via the inflight token + cache. **No render storm
from this hook.** Cross-ref the older P1-1 (`sdkSessions.find` selector
identity) — that's a separate concern that the burndown didn't address.

### 4. Settings hydration on save — double-write race?

`SettingsPage.tsx:202-216`. Sequence: `api.updateSettings()` resolves →
`setConfigured(res.anthropicApiKeyConfigured)` (React local state) →
`setSaved(true)` → `hydrateSettingsSlice({...})`. The slice mutation is
synchronous Zustand `set` from inside the same microtask continuation.
There's no concurrent second write window. Two observations:

- `hydrateSettings` does NOT update `anthropicApiKeyConfigured` from the
  same payload because `res.anthropicApiKeyConfigured` is passed but
  `setProviderConfigured` is NOT also called on this path. Compare with
  the providers-save handler at `SettingsPage.tsx:723-728` which does
  call `setProviderConfiguredSlice`. The Anthropic-save path goes
  through `hydrateSettings` only, which DOES write
  `anthropicApiKeyConfigured` (line 188-191 of slice). So
  `setProviderConfigured` would be redundant here. **No race, no
  double-write.** Comment at SettingsPage.tsx:207-216 correctly
  describes the intent.

### 5. Tests for the `hydrate-on-save` path

`settings-slice.test.ts:266-292` covers anthropicModel string/null/omit/
non-string. Does NOT cover the SettingsPage post-save path specifically
(no test mounts SettingsPage and asserts `useStore.getState().anthropicModel`
post-save). The SettingsPage test mocks `useStore`, so the
`hydrateSettingsSlice` call is a `vi.fn` and the slice never sees the
post-save payload through the component path. Acceptable — the contract
of `hydrateSettings` is well-tested in the slice file, and the
SettingsPage's call-site is a one-liner that just forwards to the slice.
If a future contributor refactors the SettingsPage save handler, the
slice tests catch any regression in `hydrateSettings` itself. **OK.**

### 6. EC-37 self-application check (call site presence)

`git grep "selectAnthropicModel\|anthropicModel" web/src --include='*.ts*'`
shows:
- Slice exports `selectAnthropicModel` (settings-slice.ts:336)
- Both production call sites (HomePage, CronManager) read via
  `useStore.getState().anthropicModel` directly — they do NOT use the
  exported `selectAnthropicModel` selector.

This is fine for the imperative one-shot usage (switchBackend, opt-click
handler — neither needs to subscribe). But it makes the `selectAnthropicModel`
export dead code today — no caller imports it. Counts as a minor smell
captured at **NEW P3-5** below (consistency with the other narrow
selectors at `:315-329` which DO have call sites via `useStore(selector)`).

---

## NEW findings introduced or surfaced by the burndown

### P2-1 (NEW) — `s.sdkSessions.find()` selector identity churn STILL present

**Where:** `web/src/components/ModelSwitcher.tsx:34-36`

The first review filed this as P1; FINAL downgraded by omitting it (the
P1 cap was already at 7 and Friedman's sticky preference displaced it).
The burndown did NOT address it. Reading the current file:

```ts
const sdkSession = useStore((s) =>
  s.sdkSessions.find((sdk) => sdk.sessionId === sessionId) || null,
);
```

**Why this matters now:** the burndown ADDED a new mount-time effect
(`ModelSwitcher.tsx:66-69`) that subscribes to `s.loadBackendModels`,
and a new `dynamicBackendModels[backendType]` subscription at line 52.
Every ModelSwitcher instance now has FOUR store subscriptions
(`sdkSessions.find`, `sessions.get`, `cliConnected.get`,
`dynamicBackendModels[bt]`, `loadBackendModels`, `anthropicApiKeyConfigured`
= 6 actually). Council-mode pairs render two ModelSwitchers side-by-side.
Any optimistic-update commit to `sdkSessions` (handler at line 113-117 in
ModelSwitcher itself) creates a brand-new array → both ModelSwitchers
re-evaluate ALL six selectors. The `find()` selector returns a NEW
identity match every time (the `|| null` operator + `find` together; if
`find()` returns the same SdkSessionInfo object, Zustand's default
`Object.is` would short-circuit, but a `sdkSessions.map(...)` upstream
mutates THAT entry too — the inner object identity changes).

**Recommendation:** wrap with `useShallow` over `(sdkSession?.backendType, sdkSession?.model)`
since those are the only two fields read, OR derive `sdkSession` outside
the subscription via a Map selector. The selector identity-churn class
is the canonical React 19 + Zustand pitfall — flagged for this lane
because it's exactly the surface the burndown widened.

**Severity:** P2 — same arguments as first-pass P1-1 (council-mode top
bar is the most-rendered surface this product ships), but de-escalated
to P2 to respect FINAL's prior judgement that it doesn't block ship.

---

### P2-2 (NEW) — Mount-effect re-fire on `backendType` switch can race late-resolving inflight

**Where:** `web/src/components/ModelSwitcher.tsx:67-69`

The new mount effect fires `loadBackendModels(backendType)` on every
`backendType` change. The dep array correctly includes `backendType` so
a backend switch re-fires the load. Slice action increments the inflight
token per call. Sequence to consider:

1. User on a Claude session. ModelSwitcher mounts. Effect fires
   `loadBackendModels("claude")`, token claude=1.
2. SettingsPage rapidly updates from elsewhere → backend-derived
   `sdkSession.backendType` flips claude → codex (rare but possible via
   `setSdkSessions` from another component, e.g., a session-reload
   route).
3. Effect re-fires with `backendType="codex"`, token codex=1.
4. Claude-1 resolves AFTER codex-1 — slice writes claude data. Token
   guard passes (`inflightModelLoadTokens.claude === 1`).
5. UI is rendering codex models but the SLICE now has the stale claude
   data populated.

In practice, the bug doesn't materialise because step 2 is unusual and
`dynamicBackendModels[backendType]` is keyed by backend, not by session.
But the new `useEffect(() => { loadBackendModels(backendType) }, [backendType, loadBackendModels])`
in ModelSwitcher is the FIRST in-the-loop caller that fires `load` with
two different `backendType` values from the same component instance —
HomePage's mount fetch fires once per backend choice in the form;
CronManager same. ModelSwitcher fires once per session's backend, and
two ModelSwitchers in a pair fire once each.

**Recommendation:** the slice's inflight-token guard is per-backend, not
per-caller — which is correct, since multiple consumers should collapse
to one upstream fetch. The race is benign (stale-but-typesafe data
populated for a backend the user just left). Mention only as a future-
contributor note: if you ever add a "session-scoped" model list (e.g.,
per-CLI-version), the inflight key MUST widen. Today: **OK as-is**, but
the JSDoc at `settings-slice.ts:132-148` should mention that the
`backend` token is the dedup unit, and switching backends mid-pending
intentionally allows BOTH backends' fetches to commit independently.

**Severity:** P2 (documentation / future-proofing only — no current bug).

---

### P2-3 (NEW) — "Soft-rejected" status now ambiguous: discriminator unification incomplete

**Where:** `web/src/store/settings-slice.ts:252` + `:280-302`

The burndown introduced the "soft-rejected" semantics to fix P2 #9 (EC-41
inflight-clobber). The fix is correct for the originally-cited race: a
flake on the SECOND call after a SUCCESS preserves last-known-good data.
But the new state-machine has three observable shapes:

| Data slot | Status slot | Meaning |
|---|---|---|
| `undefined` | `idle` | Never fetched |
| `undefined` | `pending` | Fetching (no prior data) |
| `[...]`    | `pending` | Fetching (have prior data) |
| `undefined` | `resolved` | Fetched empty list (line 252: `fetched.length > 0 ? ... : undefined`) |
| `[...]`    | `resolved` | Happy path |
| `undefined` | `rejected` | Fetch failed AND no prior data |
| `[...]`    | `rejected` | Soft-rejected — fetch failed BUT prior data preserved |

That's seven shapes from a discriminated-union surface that started with
four states. The selector at `:349-354` returns only the data slot; the
selector at `:357-362` returns only the status. No selector composes
both. **Consumers reading via the existing selectors cannot distinguish
"fetched empty" from "never fetched" — the P3 from the first pass
RELOCATES rather than resolves.** ModelSwitcher consumes only
`dynamicBackendModels[backend]` (line 52) so today it conflates "empty
upstream" with "no fetch attempted" → silent static fallback in both
cases.

The aggregation is harmless for ModelSwitcher's current behaviour
(both paths fall back to static, which is the desired UX). It matters
for:
- A future "loading skeleton" gating on data===undefined (would flash
  forever for an empty-list response).
- A future "could not reach Anthropic" inline hint gating on
  status===rejected (would falsely fire when the prior fetch succeeded
  but the next one flaked — the soft-rejected case where the user has
  GOOD data).

**Recommendation:** introduce a composite selector returning the
discriminator pair, e.g., `selectBackendModelsState(s, backend): { data, status, hasData }`
and use IT at every consumer. Document the seven-shape state-machine
in the slice header. Alternative: collapse empty-list to data=`[]`
(not `undefined`) so the data slot is the discriminator and status
is purely-informational. Today only ONE consumer exists, so the cost
of correcting is small — kicking the can to a future "loading skeleton"
PR multiplies the cost.

**Severity:** P2 — the discriminator ambiguity is a real
foot-gun for the next consumer; the first-pass P3 prediction landed.

---

### P3-1 (NEW) — Optimistic-update path still single-source-of-truth violation

(Re-flag of first-pass P2-1.) `ModelSwitcher.tsx:103-120` still routes
the optimistic `sdkSessions.model` write through `useStore.getState()`
directly from the click handler, plus a `sendToSession` WS frame, with
no ack-driven rollback path. Burndown widened the blast radius by
adding dynamic-list capability — a stale slug in the dynamic list could
be selected, sent, optimistically committed, then NEVER acknowledged
because the CLI rejects the unknown model. The UI would lie about the
model until the next `system.init` overwrites it.

**Recommendation:** unchanged from first-pass — route through a slice
action with ack-tag pattern, or at minimum add a TODO comment marking
the violation. The burndown commit was the natural place; deferring
to a follow-up is fine but the violation now spans dynamic-list cases.

**Severity:** P3 (downgraded from first-pass P2 — FINAL didn't escalate;
no user reports of CLI rejecting set_model in practice).

---

### P3-2 (NEW) — Open-effect deps `[open, models, currentModel]` now noise

**Where:** `web/src/components/ModelSwitcher.tsx:182`

With the `wasOpenRef` guard, the effect SHORT-CIRCUITS on every render
where `wasOpenRef.current === true` already (i.e., effect is no-op while
open). So the dep array's `models` and `currentModel` are present only
to satisfy exhaustive-deps for the variables READ in the body, but the
re-runs they trigger are immediately short-circuited. This is correct
behaviour, but the dep array reads as if those vars matter — they
matter only on the open-edge.

**Recommendation:** extract the open-edge handler to a callback `onOpen`
that closes over `models`/`currentModel` via refs OR captures their
"snapshot at open time" by reading inside the effect body without
declaring them as deps (would require an eslint-disable, ugly). Better:
add a comment above the dep array explaining that `models`/`currentModel`
are read on open-edge ONLY and intentionally do not re-fire the effect
mid-open (the `wasOpenRef` guard ensures that). The current comment
block at `:151-167` is good but doesn't mention the dep-array intent.

**Severity:** P3 — clarity smell only, no bug.

---

### P3-3 (NEW) — Codex early-return still does work first

(Re-flag of first-pass P3-1.) `ModelSwitcher.tsx:34-194` still subscribes
to selectors, computes `latestPerTier`, and now ALSO fires
`loadBackendModels(backendType)` from a mount effect before the
`backendType === "codex"` early-return at `:231`. Codex sessions now
incur an extra network call (resolves to a no-op cached fetch
server-side, but still a REST round-trip per ModelSwitcher mount). On a
council-mode `claude+codex` pair the codex half pointlessly fires
`loadBackendModels("codex")` and renders nothing. Cheap to fix — move
the early-return to right after backend resolution at `:41`.

**Severity:** P3 — micro-perf, free fix.

---

### P3-4 (NEW) — Catch-branch in `loadBackendModels` has unused-shape conditional

**Where:** `web/src/store/settings-slice.ts:281-302`

The two `set(...)` branches differ only in the comment naming
"soft-rejected" vs the implicit hard-rejected. Both write the same
partial state shape: `{ dynamicBackendModelsStatus: { ...s.dynamicBackendModelsStatus, [backend]: "rejected" } }`. The conditional is therefore
load-bearing only as documentation; a refactor that drops the branches
introduces no behaviour change. But if a future contributor adds a
`dynamicBackendModels` write to the soft-rejected branch (intending
to preserve data) and forgets the hard-rejected branch (intending to
clear it), the asymmetry suddenly matters and a test won't catch
"soft-rejected preserves prior data" because the prior data was
already preserved (the slot was never touched).

**Recommendation:** collapse to a single `set(...)` writing only the
status, and lift the "soft vs hard" distinction into a structured log
line (`event: "backend-models.fetch.rejected", soft: currentSlot?.length > 0`). The TEST at `settings-slice.test.ts:296-315` would still pass
(asserts data preserved + status=rejected) without the conditional
because the slot was never overwritten.

**Severity:** P3 — drift-prone shape, no current bug.

---

### P3-5 (NEW) — Exported `selectAnthropicModel` has no consumer

**Where:** `web/src/store/settings-slice.ts:336` + zero production
imports (`git grep selectAnthropicModel` returns only the export).

The burndown added the selector for parity with the other narrow
selectors at `:315-329`, but both production call sites use
`useStore.getState().anthropicModel` directly (imperative snapshot
inside `switchBackend` / click handler). Two outcomes:

- Selector is dead code today (first-pass `feedback_call_site_presence_not_just_symbol_export` shape, weaker form — the symbol's purpose IS provision-for-future-consumers, but no test asserts the selector's
  contract independently and no consumer exists).
- If a future consumer wants to subscribe to `anthropicModel` to
  re-render on slice update, they SHOULD use this selector. So it's
  documentation-as-code.

**Recommendation:** either delete the export until a subscriber needs
it (YAGNI / Fowler Principle 5 — anti-speculative-generality), OR add a
quick unit test asserting `selectAnthropicModel(s)` returns
`s.anthropicModel` so the symbol carries semantic weight beyond a
literal re-export. The first-pass `feedback_call_site_presence_not_just_symbol_export` shape applies; the burndown's plumbing went through
`getState()` rather than via the selector, so the selector is exported
but unused.

**Severity:** P3 — clarity / YAGNI.

---

## Patterns I deliberately did NOT flag

- **APG keyboard model correctness on the new restructured DOM** — a11y
  Auditor's lane. The wrapper-vs-listbox restructure is a structural
  fix that's their territory.
- **`requestAnimationFrame` over `queueMicrotask`** — the React 19
  concurrent-rendering reasoning is a11y / behavioural correctness, not
  React architecture. The codebase precedent (`CouncilToggle.tsx`) was
  cited correctly; the swap matches established patterns.
- **`<a href="#/settings">` footnote** — Friedman/a11y lane; the
  rendered structure is correct and the test pin exists at
  `ModelSwitcher.test.tsx:493-501`.
- **Sticky preference test coverage** — Beck's lane; the slice test at
  `settings-slice.test.ts:266-292` is solid.
- **Module-scope inflight token (1st-pass P2-2)** — first review filed
  as P2 around the multi-tab claim; FINAL didn't escalate. Burndown
  added test-reset helper. Still intra-tab dedup only; multi-tab
  semantics fall to server-side single-flight (which IS correct). No
  new finding here.

---

## Verdict for this lane

**The burndown closes 4 of 6 lane-relevant findings cleanly, partially
addresses 1, and leaves 1 untouched.**

- **CLOSED CLEANLY:** P1-2 (pickIcon, with regression pin), P2-4
  (ModelSwitcher mount fetch, with test pin), P2-5 (sticky preference
  wired through HomePage + CronManager + slice + SettingsPage hydration
  on load AND save), P2-6 (rAF + wasOpenRef React-idiomatic).
- **PARTIALLY CLOSED:** P3-2 slice JSDoc — field-level comment updated,
  header invariant statement unchanged (acceptable).
- **NOT TOUCHED:** P1-1 selector identity churn (FINAL downgraded
  rather than fixed; **re-flagged as NEW P2-1**), first-pass P2-1
  optimistic-update single-source-of-truth violation (**re-flagged as
  NEW P3-1**), P3-1 work-before-codex-early-return (**re-flagged as
  NEW P3-3**).
- **REGRESSED IN SEMANTICS:** P3-3 undefined-vs-empty discriminator —
  the soft-rejected fix RELOCATES the ambiguity rather than resolves
  it (**flagged as NEW P2-3**).

**The most interesting new finding is P2-3** — the "soft-rejected"
state semantics fix the EC-41 inflight-clobber race correctly, but
introduce a 7-shape state machine where consumers reading either
selector independently cannot recover the full state. This compounds
the first-pass P3-3 (undefined-vs-empty) rather than resolving it. A
follow-up composite selector + slice header update is the right
fix; the current shape ships hidden risk for the next "loading
skeleton" or "could not reach upstream" consumer.

**The mount-effect addition (P2-4 fix) is correct but widens the per-
session re-render budget** without addressing the underlying
selector-identity-churn from P1-1. Six store subscriptions per
ModelSwitcher × two ModelSwitchers per council pair × every CLI
tool-call republishing `sdkSessions` = a measurable hot path that the
burndown did not touch. The first-pass P1-1 reasoning still holds; only
the priority changed.

**The sticky preference plumbing (P2-5 fix) is clean and well-tested.**
Both call sites correctly read `useStore.getState().anthropicModel`
imperatively at the switchBackend / opt-click moment (subscription
isn't needed for one-shot defaults). The slice's `hydrateSettings` does
the right thing on both initial load AND post-save paths. The
SettingsPage hydration on save is non-racy (synchronous Zustand `set`
in the same microtask continuation as the React local-state writes).

**No P1 blockers from this lane.** Two new P2s flagged; three new P3s.
P2-1 (selector churn) is the load-bearing concern for council-mode
performance and should be addressed in the next slice-cohesion PR. P2-3
(soft-rejected semantics) should be addressed before the next consumer
of the dynamic-models slice ships. Everything else can wait.
