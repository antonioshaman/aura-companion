# React/Web UI Frontend Review — Carmack Council

**Reviewer:** React 19 + Zustand + Tailwind Web UI Expert
**Stack:** React 19 / Vite 6 / Tailwind 4 / Zustand 5
**Date:** 2026-06-04
**Scope:** PR #91 `feat/dynamic-claude-models` — frontend slice + components only
**Files reviewed:**
- `web/src/components/ModelSwitcher.tsx`
- `web/src/components/HomePage.tsx` (Task 10 hunk)
- `web/src/components/CronManager.tsx` (Task 10 hunk)
- `web/src/components/SettingsPage.tsx` (Task 8 trigger)
- `web/src/store/settings-slice.ts`
- `web/src/utils/backends.ts`

**Out of scope (other lanes):** a11y (APG keyboard correctness, axe), visual design
(Saarinen icon decisions), UX flow (Friedman discoverability).

**Convention floor honoured (not re-flagged):** PLAN-aura-dynamic-model-list.md
"Risks & Watchpoints" section — sticky-vs-dynamic[0] semantics, EC-22 emit-path
coverage, aria-live verify-by-absence, recording exclusion. Plan parked Fowler R4
(separate slice for `dynamicBackendModels`) — not re-flagged here.

---

## P1 — Fix Now

### P1-1 — Selector returns fresh array on every render (whole-store fan-out for `claude+claude` Council pairs)

**Where:** `web/src/components/ModelSwitcher.tsx:34-36`

```ts
const sdkSession = useStore((s) =>
  s.sdkSessions.find((sdk) => sdk.sessionId === sessionId) || null,
);
```

**Cost of getting it wrong:** `Array.prototype.find` over `s.sdkSessions` is a
selector that reads the WHOLE `sdkSessions` array identity. Anything in the app
that calls `setSdkSessions(arr.map(...))` — including the optimistic update done
inside *this same component's* `handleSelect` (line 96-101) — creates a brand-new
array, which means every mounted `ModelSwitcher` (one per session header, two
per Council pair) re-runs `find()` → re-renders. In Council Mode where two
ModelSwitchers live side-by-side, picking a model in pane A causes pane B (and
every other sidebar-listed sessionId's mount) to re-render.

This is principle 2 of quality-frontend.md: a wide selector that uses array
traversal isn't directly returning a fresh object every call, but its *referential
identity check* fires on every `sdkSessions` mutation. The fix is to either
narrow via a Map-like selector (if `sdkSessions` were keyed by id you'd select
the value), or wrap with `useStore(selector, shallow)` over a 2-field tuple,
or cache via `useShallow(s => s.sdkSessions)` and `find` outside the subscription.

The deeper issue: `sdkSessions` is an *array* used as a per-id lookup table.
Several call sites already iterate it. A separate `Map<sessionId, SdkSessionInfo>`
projection (derived in the slice, kept fresh on `setSdkSessions`) would eliminate
the linear scan on every read. **Not on this PR's plate** — but the selector
shape this PR adopts (`s.sdkSessions.find(...)`) is the bog-standard React 19 +
Zustand anti-pattern from principle 2.

**Severity:** P1 because the surface is the per-session top bar — re-rendered
on every `set_model` + every CLI tool-call (which republishes `sdkSessions`),
in council-mode UIs that are the most expensive surface this product ships.

---

### P1-2 — `pickIcon` length-dependent index for Codex stable icon assignment now varies on Claude key presence

**Where:** `web/src/utils/backends.ts:23-34` (`pickIcon`) combined with
`toModelOptions` at line 37-43 and the way `dynamicModels` is overlaid against
`getModelsForBackend(backend)` at `ModelSwitcher.tsx:53`.

```ts
function pickIcon(slug: string, index: number): string {
  if (slug.startsWith("claude-")) return "";
  for (const [key, icon] of Object.entries(MODEL_ICONS)) {
    if (slug.includes(key)) return icon;
  }
  const fallback = ["◆", "●", "◕", "✦"];
  return fallback[index % fallback.length];
}
```

**Cost of getting it wrong:** This function is invoked for BOTH backends through
the single `toModelOptions` converter (AP-14). For Codex models that don't match
the keyword map (`gpt-5.2` has no "codex"/"max"/"mini" hit) the icon is picked
by `index % fallback.length`. The index is the array position in the upstream
response. If Anthropic ever returns Codex slugs in a different order, or — more
realistically — if the cache is partially refreshed and the response now has 6
items instead of 5, the same Codex slug `gpt-5.2` may land at index 3 today and
index 4 tomorrow, flipping its icon `●` → `✦` silently. The icon is supposed to
be a *type marker* (mini/max/codex), not a position marker.

The Claude branch escapes this (returns `""` unconditionally) but the
position-dependent fallback for Codex is a regression vector waiting on a Codex
response ordering change. The `index` argument should not be load-bearing for
stable identity — either hash the slug into the fallback set or drop the
fallback entirely (display "" for unrecognised slugs is already the pattern this
PR establishes for Claude).

**Severity:** P1 for a stable-identity invariant; cost manifests on the next
Codex CLI cache refresh that reorders entries — silent, no test catches it.

---

## P2 — Fix Soon

### P2-1 — Two parallel write paths for `sdkSessions.model`

**Where:** `web/src/components/ModelSwitcher.tsx:93-101`

```ts
sendToSession(sessionId, { type: "set_model", model });
// Optimistic update: update sdkSession.model in Zustand store
const { sdkSessions, setSdkSessions } = useStore.getState();
setSdkSessions(
  sdkSessions.map((sdk) =>
    sdk.sessionId === sessionId ? { ...sdk, model } : sdk,
  ),
);
```

**Cost of getting it wrong:** Principle 4 of quality-frontend.md: `ws.ts` is the
single mutation channel for server-derived state. The component sends the WS
frame AND directly mutates `sdkSessions` from a click handler. If the CLI
rejects the model change (e.g. invalid model name from a stale dynamic list, or
the CLI version doesn't support it), the optimistic write stays — there's no
rollback path. The CLI's `system.init` (the documented authoritative source for
`runtimeSession.model`, see line 42-43) will eventually overwrite this when the
session reconnects, but during the window the UI lies about the model.

This isn't this PR's invention — the optimistic update predates the dynamic list
work — but the PR widens the blast radius: previously the dynamic list was
gated `backend !== "codex"` and the static list's three options were known-good;
now ModelSwitcher can offer any Anthropic-returned slug and the optimistic write
fires before the CLI confirms.

**Recommendation:** route optimistic updates through a slice action
(`setOptimisticModel(sessionId, model, expectedConfirmation)`) that tags the
entry, then have `ws.ts` clear the tag on `set_model_ack` OR roll back on
`set_model_failed`. At minimum: add a comment marking the optimistic write as
single-source-of-truth-violation with a TODO link to a proper ack-driven flow.

**Severity:** P2 — model UI mislabel during failure window, not data corruption.

---

### P2-2 — Module-scope `inflightModelLoadTokens` precludes multi-tab correctness AND test reset hygiene

**Where:** `web/src/store/settings-slice.ts:144-157`

```ts
const inflightModelLoadTokens: Record<BackendType, number> = {
  claude: 0,
  codex: 0,
};

export function __resetBackendModelInflightForTests(): void { ... }
```

**Cost of getting it wrong:** Two distinct issues bundled here.

**A. Multi-tab race:** The module-scope `Record` lives in the JS heap of ONE
browser tab. Two tabs open on `/settings` — both save the Anthropic key in
quick succession (or even just both mount and fire `loadBackendModels("claude")`)
— each tab has its own counter, neither sees the other's increments. The
`anthropic-models-cache.ts` server-side cache handles upstream-call dedup so
the actual Anthropic spend is bounded, but each tab independently commits its
own response into ITS OWN Zustand store. With sticky preference flowing
(Risks & Watchpoints sticky-vs-dynamic[0]), different tabs may compute different
defaults at the same moment. The module-scope claim in the JSDoc
("share[d] one canonical counter") is WRONG across tabs — only true within
one tab's component tree.

The slice JSDoc at line 137-143 even says "shared across components but not
across browser tabs" — so the team knows. Fine to defer; the comment should
read "intra-tab dedup only — multi-tab callers race independently, but the
server-side single-flight in `anthropic-models-cache.ts` bounds upstream cost."
The current wording understates the trade-off.

**B. Test reset:** `__resetBackendModelInflightForTests()` exists because
module-scope mutation is sticky across `beforeEach`. This is the canonical
escape-hatch smell — `useStore.setState({ dynamicBackendModels: {} })` works
for the slice-state reset but the *module-scope* token survives. Future
contributor adds a third backend, forgets to update the `__reset...` hard-coded
list (`claude = 0; codex = 0`), tests pass alone, fail in suite. This is the
same shape as `feedback_conftest_truncate_new_tables.md` cited in the project
MEMORY.md but for module-scope state.

**Recommendation:** Either move the token INTO the Zustand state
(`set({ inflightToken: { ...s.inflightToken, [backend]: s.inflightToken[backend] + 1 } })`)
so the existing `reset()` already clears it — or change `__reset...` to iterate
the typed `BackendType` union so new backends auto-extend.

**Severity:** P2 — the tab-scope claim discrepancy is a comment fix; the
test reset is a debt marker.

---

### P2-3 — `useMemo` dep array `[dynamicModels, models]` has redundant member that masks intent

**Where:** `web/src/components/ModelSwitcher.tsx:68-80`

```ts
const latestPerTier = useMemo(() => {
  if (dynamicModels === undefined) return new Set<string>();
  ...
  for (const m of models) { ... }
  return set;
}, [dynamicModels, models]);
```

**Cost of getting it wrong:** `models = dynamicModels ?? getModelsForBackend(backendType)`
(line 53). When `dynamicModels` is defined, `models === dynamicModels` (same
array identity). When `dynamicModels` is undefined, the early-return short-
circuits before `models` is read. So:

- If `dynamicModels` changes → `models` changes too (always).
- If `dynamicModels` is undefined → branch returns early; `models` value
  doesn't matter.
- `getModelsForBackend(backendType)` returns the SAME static constant array
  identity every call (module-scope frozen-ish), so `models` only changes when
  `dynamicModels` changes.

→ `models` in the dep array is redundant. The dep array reads as if `models`
might be a separate input that matters, but it can't be (within this hook's
control flow). React 19 + `react-hooks/exhaustive-deps` correctly lists it
because the variable is read inside the callback, but the redundancy makes the
*intent* of the memo unclear to future readers: is this memo invalidated on
backend switch (which clears `dynamicModels` via the effect at line 271 of
HomePage, but ModelSwitcher itself doesn't trigger a reload — see P2-4)?

**Recommendation:** drop `models`, use `dynamicModels` only, and inline the
iteration: `for (const m of dynamicModels) { ... }`. This makes the
"empty set when no dynamic list" branch + "iterate dynamic list otherwise"
*shape* of the function obvious without the early-return ladder.

**Severity:** P2 — clarity smell, no current bug; one-liner fix.

---

### P2-4 — Coverage gap: ModelSwitcher does NOT call `loadBackendModels` on mount

**Where:** `web/src/components/ModelSwitcher.tsx` (no `useEffect` calling
`loadBackendModels`) versus `HomePage.tsx:271-273` and `CronManager.tsx:714-716`
which both do.

**Cost of getting it wrong:** The dependency relationship is documented as
"HomePage + CronManager + ModelSwitcher concurrent mount calls collapse"
(`settings-slice.ts:130-133`), but ModelSwitcher in fact never fires the load.
Today this works *because* every code path to a session with a ModelSwitcher
goes through HomePage first (HomePage mounts, fires `loadBackendModels(backend)`,
ModelSwitcher mounts later and reads from the already-populated slice).

Failure mode: any future code path that opens a chat surface (with
ModelSwitcher) WITHOUT first rendering HomePage will have an empty dynamic list
and silently fall back to the static triplet. Today that's hypothetical —
"Continue in new session — text-only handoff" (recent commit 3412955) for
instance bypasses HomePage; verify the model picker there isn't stale. Also: a
session restored from disk after a server restart re-mounts ModelSwitcher
without an intervening HomePage mount; same issue.

The JSDoc claims ModelSwitcher is one of the concurrent callers; the code says
otherwise. Either:
- Add `useEffect(() => { void loadBackendModels(backendType); }, [backendType, loadBackendModels])`
  to ModelSwitcher (idempotent, server-side cache makes the cost zero), OR
- Hoist the fetch to a single `App.tsx` mount effect (one fetch per backend per
  session) since every consumer reads the same slice, and update the JSDoc to
  reflect single-call ownership.

**Severity:** P2 — current paths happen to work; one new entrypoint without
HomePage breaks the contract. The JSDoc/code disagreement is the canary.

---

### P2-5 — Sticky `anthropicModel` preference flagged in plan as "Risks" but never wired at the call sites

**Where:** `web/src/components/HomePage.tsx:253` and `CronManager.tsx:851-854`

```ts
setModel(pickSessionDefaultModel(newBackend, dynamicForNew));
// ...
model: pickSessionDefaultModel(opt.value, useStore.getState().dynamicBackendModels[opt.value]),
```

**Cost of getting it wrong:** Both call sites pass `dynamic` but no `sticky` —
the third positional arg defaulting to `undefined`. So when the user has
`settings.anthropicModel = "claude-sonnet-4-6"`, but the dynamic list returns
`[opus-4-8, opus-4-7, sonnet-4-6, ...]`, the default-on-backend-switch lands on
`opus-4-8` not `sonnet-4-6` — violating the sticky-preference contract the
helper was designed for.

The PR plan's "Risks & Watchpoints" section explicitly highlights this case
(*sticky-vs-dynamic[0]*) — but it's framed as "when sticky is set AND in dynamic
list, sticky wins" as a test invariant, not as "but make sure the call sites
pass it." Reading the unit tests at `backends.test.ts:303-325` confirms the
helper does the right thing **when given the argument**. The call sites don't
give it.

This is precisely the shape of `feedback_one_fix_claim_grep_literal_value.md`
in MEMORY: the plan claims "single rule site … without Fowler's signature
pollution," but if no caller passes the sticky arg, the rule site is never
exercised in production. `git grep pickSessionDefaultModel | grep -v test`
returns two call sites, both with 2 args.

**Recommendation:** Either:
- Wire `settings.anthropicModel` into both call sites (the slice already holds
  it — selector + pass through), OR
- Explicitly remove the third arg from `pickSessionDefaultModel`'s signature
  with a comment "sticky preference deferred to follow-up PR — see Plan
  Watchpoints", so future readers don't think this is wired.

The plan parks the actual wiring; the helper exists; the test asserts the
contract; no production caller reaches the contract. Verify intent and either
finish the wire or remove the dead-arg from the signature.

**Severity:** P2 — feature regression vs. older static behaviour for any user
with a saved Anthropic model preference. Silent — UI shows the wrong default,
user has to manually pick.

---

### P2-6 — `useEffect` focus side-effect via `queueMicrotask` races React 19 concurrent rendering

**Where:** `web/src/components/ModelSwitcher.tsx:123-132`

```ts
useEffect(() => {
  if (!open) return;
  const selected = models.findIndex((m) => m.value === currentModel);
  setActiveIndex(selected >= 0 ? selected : 0);
  queueMicrotask(() => {
    listboxRef.current?.focus();
  });
}, [open, models, currentModel]);
```

**Cost of getting it wrong:** Two distinct correctness concerns.

**A. `queueMicrotask` orders BEFORE React commits the next render.** When the
effect fires after `setOpen(true)`, the listbox `<div ref={listboxRef}>` is in
the DOM (the effect ran post-commit). But `setActiveIndex` queues a state
update. The `queueMicrotask` callback runs immediately, before React processes
the activeIndex state update's render. In React 19 concurrent mode (default
in apps using `createRoot`), an interrupt (e.g. a higher-priority input event)
between the effect's set call and React's reconciliation could mean the focus
fires on a `<div>` that's about to be unmounted by an `Escape` keypress that
landed in the same task. `queueMicrotask` is too eager for "I want this to
happen after React finishes."

**B. The `models` dep makes the effect re-fire on every dynamic list refresh.**
When `loadBackendModels` resolves while the dropdown is open, the effect
re-runs, resetting `activeIndex` to the position of `currentModel` in the new
list. The user was navigating via arrow keys and lands somewhere they didn't
expect. The intent of the effect is "initialise on open" — but the dep array
makes it "re-init on every list change while open." Either guard with
`if (!open) return` (already there) + a `usePrevious(open)` to detect the
edge, OR split into two effects: one for "on open transition: focus + reset
activeIndex" using a `useRef<boolean>` open-tracker, and one for "on models
change while open: clamp activeIndex into bounds without resetting."

**Recommendation A:** swap `queueMicrotask` → `requestAnimationFrame` (defers
past React's commit phase) OR wrap in `flushSync`-aware pattern, OR
acknowledge the race as best-effort. **Recommendation B:** separate
initialisation from clamping.

**Severity:** P2 — APG keyboard intent regression on async list updates;
focus may misfire under React 19 concurrent priority shifts. a11y auditor
owns the keyboard model itself; the *React 19 hooks correctness* is this lane.

---

## P3 — Consider

### P3-1 — `currentOption` and `models` computed before the codex-backend early-return

**Where:** `web/src/components/ModelSwitcher.tsx:181-183` vs. work at lines
52-86.

```ts
if (backendType === "codex" || !cliConnected || !currentOption) {
  return null;
}
```

When `backendType === "codex"`, lines 52-86 nonetheless ran: subscribed to
`dynamicBackendModels["codex"]`, computed `models = ... ?? getModelsForBackend("codex")`,
ran the `latestPerTier` useMemo, attempted to look up `currentOption`. All
wasted (the component renders null). Move the `if (backendType === "codex")
return null` higher — right after the backend resolution at line 41 — so the
selectors don't even subscribe. Reduces store-update fan-out on Codex sessions
to zero for this component.

**Severity:** P3 — micro-optimisation, but free.

---

### P3-2 — Slice JSDoc invariant says "server-authoritative facts only" — adding `dynamicBackendModels` softens this without an audit trail

**Where:** `web/src/store/settings-slice.ts:1-22` (header) vs. `dynamicBackendModels` at lines 74-90.

The slice header documents "Holds only flags the server owns — fields the
SettingsPage form input is 'the truth of' stay as component-local draft state."
`dynamicBackendModels` is a *server-derived* cache, NOT a settings *flag*. The
PLAN parked Fowler R4 (extract to `backend-models-slice.ts`) but the slice
header was not updated to widen the invariant. Future contributor reads the
header, adds a `cronJobsHydrated` boolean (server-derived, not a settings flag)
to *another* slice citing the same precedent — header invariant drift.

**Recommendation:** Either update the header to acknowledge the widened scope
explicitly ("Also holds server-derived caches that naturally trigger off
Settings save — see `dynamicBackendModels`"), or move `dynamicBackendModels`
into its own slice per Fowler R4. Currently the JSDoc lies.

**Severity:** P3 — documentation drift, not correctness.

---

### P3-3 — `dynamic !== undefined && dynamic.length > 0` is the right empty-guard, but `toModelOptions(fetched)` returns `undefined` not `[]` when fetched is empty

**Where:** `web/src/store/settings-slice.ts:229`

```ts
const models = fetched.length > 0 ? toModelOptions(fetched) : undefined;
set((s) => ({
  dynamicBackendModels: {
    ...s.dynamicBackendModels,
    [backend]: models,
  },
  ...
}));
```

The fetched-empty path writes `undefined` into the per-backend slot. Combined
with `dynamicBackendModels[backend]` selector returning `undefined`, this
means "fetched OK but server returned 0 models" is indistinguishable from
"never fetched / fetch rejected" at the consumer. The discriminator IS the
status field (`resolved` vs `idle` vs `rejected`), but no consumer reads it.
Result: an upstream regression where Anthropic returns `{"data": []}` looks
identical to "fetch never started" — silent fallback to static triplet, no
log, no canary.

If the intent is "treat empty as no list," fine — but the `dynamicBackendModelsStatus`
field exists and only tests read it. Pair the status with the data field at
the selector site, or document the conflation explicitly so a future
"loading skeleton" doesn't try to gate on `data === undefined` and discover
this ambiguity at the worst moment.

**Severity:** P3 — the discriminated-union intent leaks through the cracks
in the data/status pair.

---

## Patterns I deliberately did NOT flag

- **APG listbox keyboard model correctness** — a11y auditor's lane.
- **`useId()` correctness for stable option IDs** — Standard React 19 usage,
  no concern.
- **`tierOf` substring match** — Saarinen / domain heuristic, not architectural.
- **`scrollIntoView` optional-chain for JSDOM** — Tested annotation, intentional.
- **"Latest" badge UX** — Friedman's lane.
- **`useShallow` vs `shallow` import** — Zustand 5 deprecated `shallow` import
  path; this PR doesn't use either, so no migration concern surfaces.
- **Sticky preference semantics** — already in Plan Watchpoints (only the
  *missing wiring at call sites* is flagged as P2-5).
- **EC-22 emit-path coverage on the slice** — backend log lane, plan covered.

---

## Verdict for this lane

The PR is structurally sound on the Zustand selector + slice extension axes —
the `dynamicBackendModels` lift from local React state to slice is the right
direction (eliminates duplicate `useEffect`-fetch in HomePage + CronManager),
and the narrow selectors in `settings-slice.ts:263-301` are exemplary one-field
shape.

The two P1 findings are the load-bearing concerns:

- **P1-1 selector identity churn** is the standard React 19 + Zustand
  anti-pattern; the impact is concentrated on the council-mode top-bar
  surface, which is *the* place this product cares about render budget.
- **P1-2 `pickIcon` position dependence** for Codex is a stable-identity
  regression vector — silent, no current test catches it.

P2-5 (sticky preference not wired) is the most interesting *contract* finding:
the helper exists, the test asserts the contract, the Plan flags it in
"Risks & Watchpoints," but no production caller exercises it. Classic
`feedback_call_site_presence_not_just_symbol_export.md` shape. Either finish
the wiring or remove the dead parameter from the helper.

The Plan's claim that ModelSwitcher participates in "concurrent mount calls"
(slice JSDoc line 130-133) is contradicted by the code — ModelSwitcher does
not fire `loadBackendModels`. Either fix the contract or fix the code; the
disagreement is the canary.

Module-scope inflight token (settings-slice.ts:144) is intra-tab dedup only —
the JSDoc is too generous about its scope. Multi-tab semantics fall back to
the server-side single-flight in `anthropic-models-cache.ts`, which is fine
but should be explicit in the comment.

No P1 blocks merge if the team is OK with deferring the selector refactor and
either fixing or accepting the Codex icon position dependence. Both are
documented entries in this lane's findings; pick which to fix.
