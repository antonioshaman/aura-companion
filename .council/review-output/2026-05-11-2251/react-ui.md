# React/Web UI Review — Council Mode Phase D-G

Reviewer: React 19 + Zustand + Tailwind Web UI Expert
Scope: `web/src/components/council/*`, `web/src/store/council-slice.ts`, `web/src/store/sessions-slice.ts` (cross-slice cleanup), `web/src/store/index.ts`, `web/src/observer-panel-state.ts`, `web/src/use-browser-title-alert.ts`, `web/src/use-council-shortcuts.ts`, `web/src/ws.ts` (5 new switch cases), `web/src/types.ts`, plus integration points in `App.tsx`, `ChatView.tsx`, `TopBar.tsx`, `HomePage.tsx`, `Sidebar.tsx`, `SessionItem.tsx`, `ProjectGroup.tsx`, and `Playground.tsx`.

Verdict (high-level): the work is architecturally clean and largely faithful to the React 19 + Zustand discipline encoded in `quality-frontend.md`. Derived state is in pure helpers (good). Selectors are narrow (good). The five new WS cases call slice actions, not `useStore.setState` (good). The cross-slice cleanup duplication and a couple of selector-shape choices are the substantive issues; the rest are P3 hygiene.

---

## P1 — Fix Now

### P1-1 — Two parallel write paths for Council cleanup on session removal

**Where:** `web/src/store/council-slice.ts:337-363` defines `cleanupCouncilForSession(sessionId)` that deletes `observerPanelOpen`/`observerPanelWidth`/`groups`/`groupBySessionId`/`findings`/`groundingDowngrades` and re-persists the panel maps. `web/src/store/sessions-slice.ts:112-189` re-implements the same cleanup inline inside `removeSession`, reaching across the slice boundary to read `s.groupBySessionId`, `s.groups`, `s.findings`, `s.groundingDowngrades`, mutate them, and persist via `localStorage.setItem(COUNCIL_PANEL_OPEN_KEY, …)` / `COUNCIL_PANEL_WIDTH_KEY`.

`cleanupCouncilForSession` is defined but never called anywhere in the source tree (grep confirms — only the definition site exists). All real cleanup goes through the duplicate inline branch in `removeSession`.

**Cost of getting it wrong:** This is exactly the "two parallel write paths" pattern `quality-frontend.md` flags as P1. Today the two paths happen to agree, but `cleanupCouncilForSession` ALSO returns early-on-no-groupId after persisting panel maps; the inline version unconditionally persists. The next time someone adds a field to council cleanup (say, a per-session `dismissedStopIds` bucket) they will edit `cleanupCouncilForSession` because that's where the function is documented, ship it green, and the persisted state will silently drift from the in-memory state on `removeSession`. AP-1 / EC convention discipline encodes "slice owns its own cleanup" — that contract is currently violated, just not yet visibly broken.

**Fix shape:** call `s.cleanupCouncilForSession(sessionId)` (or expose an internal helper the slice owns) from `removeSession` and remove the duplicated inline block. Either delete the unused exported function or wire it up — both is the current worst-of-both.

---

## P2 — Fix Soon

### P2-1 — `useStore((s) => s.findings)` returns the whole Map, defeating selector narrowing in three hot paths

**Where:**
- `web/src/components/Sidebar.tsx:202` (`const findings = useStore((s) => s.findings)`)
- `web/src/use-browser-title-alert.ts:34` (`const findings = useStore((s) => s.findings)`)
- The whole-Map subscription forces a re-render on ANY change to ANY group's findings.

The Sidebar then iterates EVERY session row through `councilInfoFor(sessionId)` which itself reads `findings.get(groupId)` and a fresh `dismissedStopIds` set per call. Every `observer_review` for ANY group will re-run that loop across every session row in the sidebar.

`useBrowserTitleAlert` is by design global, so the whole-Map subscription is defensible there (it MUST recompute on any change). But the Sidebar instance is a hot, frequently-rendered component, and could subscribe to a derived `councilBadgeMap` (computed at the slice level on the same events that mutate `findings`), or use `useSyncExternalStore` with a custom equality so the whole-list iteration only runs when something STOP-relevant actually moved.

**Cost of getting it wrong:** with 20+ active sessions in the sidebar, every `tool_progress`/`observer_review` triggers a full sidebar re-render that iterates every session. The render path is cheap today, but the iteration order is `O(sessions * findings_per_group)` per event. The principle from `quality-frontend.md` Principle 2 ("narrow selectors") applies — this is a P2 rather than P1 because the absolute cost is bounded by sidebar size, but the unbounded scaling is the exact pattern flagged.

### P2-2 — `findings` selector returns `findings.get(groupId) ?? []` builds a fresh `[]` on every render

**Where:** `web/src/components/council/ObserverPanel.tsx:150`:
```
const findings = useStore((s) => (groupId ? s.findings.get(groupId) : undefined)) ?? [];
```
and `web/src/components/ChatView.tsx:64`:
```
const findings = useStore((s) => (groupId ? s.findings.get(groupId) : undefined));
```

ChatView's selector returns `undefined` cleanly (stable). ObserverPanel applies the `?? []` OUTSIDE the selector, so the selector value is `undefined | readonly ObserverFinding[]` — stable, but the `[]` fallback is recreated on every render. That part is fine (the result is just used inside `deriveObserverPanelState` once per render).

The real concern is more subtle: when there are no findings yet (the common case during session warmup), the selector returns `undefined`, and the `?? []` makes the `findings` variable a fresh array every render. Then on line 168 `deriveObserverPanelState({ group, findings, dismissedStopIds })` is called with that fresh array, which is fine because the function is pure and called inline.

But on line 171, `findUnresolvedStops(findings, dismissedStopIds)` is invoked, returning the same shape; and the result is held in a local. If a future maintainer wraps this in `useMemo` keyed by `findings`, they'll be defeated by the fresh-array identity. The selector should return `readonly ObserverFinding[]` with a stable empty-array sentinel, OR the `?? EMPTY_ARRAY` constant should be hoisted out of the component. This is a P2 pre-emptively because the same selector shape is used in `Sidebar.councilInfoFor` too.

**Fix shape:** export `const EMPTY_FINDINGS: readonly ObserverFinding[] = Object.freeze([])` from council-slice and use that everywhere. Same trick for `dismissedStopIds` empty fallback.

### P2-3 — Sidebar's `councilInfoFor` is a non-memoised function dependency of `ProjectGroup`'s `getCouncilInfo` prop

**Where:** `web/src/components/Sidebar.tsx:568-582` defines `councilInfoFor` as an inline closure inside the component body (not `useCallback`). It is then passed down on lines 692, 712, 747, 793 to `ProjectGroup` and `SessionItem` mocks. On every Sidebar re-render the closure identity changes — every consuming `ProjectGroup` sees a new `getCouncilInfo` prop and (if it were memoised) would re-render. `ProjectGroup` is NOT memoised today so the cost is incurred via the cheap React reconciler, not via blown memoisation budget. But the natural follow-up — `memo(ProjectGroup)` — would be defeated silently by this.

**Cost of getting it wrong:** today the cost is the same loop running on every render. The minute someone wraps `ProjectGroup` in `React.memo` to fix sidebar re-render hotness (likely follow-up given P2-1), `getCouncilInfo` will look "always new" and the memo will be a no-op. Wrap `councilInfoFor` in `useCallback` keyed on `[groupBySessionId, groups, findings, dismissedStopIds]`. (Note: this also touches P2-1 — the four Maps as deps lock you into re-creating the callback on every findings update; better is to lift `councilInfoFor` into a `useMemo`-ed object-with-method or, ideally, derive the per-session info up-front at the slice level.)

### P2-4 — `useCouncilShortcuts` uses `document.querySelector` to find the BlockerBanner primary action

**Where:** `web/src/use-council-shortcuts.ts:67`:
```
const el = document.querySelector<HTMLElement>(`[${BLOCKER_PRIMARY_ACTION_ATTR}]`);
```
The shortcut focuses whichever DOM element matches first. This is a deliberate decoupling so the hook doesn't need to know component shape — fine in spirit — but `data-council-blocker-primary` is applied THREE times in `BlockerBanner.tsx` (lines 95, 105, 114), with conditional spreads that ensure exactly one is set per banner. If the conditional logic ever drifts (e.g. someone adds a fourth action and forgets the cascade), `querySelector` will silently take the first match in DOM order, which may not be the "primary" action the user expected.

**Cost of getting it wrong:** silent wrong-button-focuses. Add a self-assertion in the BlockerBanner test that asserts EXACTLY ONE `[data-council-blocker-primary]` attribute is rendered per banner instance — that's a Beck-F4 style canary that catches the cascade drift. (This is more a test-quality finding but lives in the React-component contract.)

### P2-5 — `useBrowserTitleAlert` mutates `document.title` in a render-time effect dependency on the whole `findings` Map

**Where:** `web/src/use-browser-title-alert.ts:45-53`. The effect runs whenever `findings` (Map) or `dismissedStopIds` (Set) change identity, which is every time the slice updates either via immutable copy. Inside the effect it re-strips the prefix from `document.title` and re-applies. On unmount it restores `baseTitleRef.current`.

Two concerns:

1. The render-time write `if (baseTitleRef.current === null && typeof document !== "undefined") { baseTitleRef.current = document.title.replace(/^\(\d+\)\s+/, ""); }` (lines 41-43) is in the render body, which is mostly fine for refs but discouraged because StrictMode double-renders make the assumption "first render captures the true base" brittle. Move into `useEffect(() => { ... }, [])` to make the lifecycle explicit, and protect against double-init.

2. If the document.title is changed by route navigation BETWEEN renders of this hook (e.g. a `<title>` mutation by some other component), the `applyTitleAlertPrefix(base, count)` call has the right intent — it re-strips before re-applying — but if `count` is 0 and the title doesn't currently carry a `(N)` prefix, the hook still writes `document.title = base` which is a redundant write. Browsers do diff `document.title` assignments so this isn't a perf bug; it's just noise the effect emits.

**Cost of getting it wrong:** the StrictMode race is the load-bearing one. In dev with React 19 StrictMode, the hook double-mounts; if the first mount sets `document.title = "(2) Aura"` and the second mount captures THAT as `baseTitleRef.current = "Aura"`, the restoration is correct. But if the order is "second mount runs before first effect completes" (which `useRef`/render-body initialisation makes possible), `baseTitleRef.current` could end up as the already-prefixed title. Move the base-capture into a `useEffect(() => { ... }, [])` to make this safe-by-design.

### P2-6 — `ObserverPanel.tsx` collapsed-rail vs expanded-panel return different DOM shapes from the same component

**Where:** `web/src/components/council/ObserverPanel.tsx:173-249`. When `open === false` the component returns `<CollapsedRail …/>` (a `<button>` with vertical text); when `open === true` it returns `<aside …>` with header/status/findings. The two are sibling-by-sibling in the App layout flexbox (`App.tsx:319-321`).

The DOM-shape switch is fine in isolation. The concern is that **the same `sessionId` keeps the same panel instance across the open/close transition only as long as React reconciler doesn't see them as different components**. They're returned from the same function component so React keeps the instance — but the internal subtree (CollapsedRail's `<button>` vs the aside's `<button>`) does fully remount on toggle. That means the `useState` inside `DegradedBanner` for `localRespawning` is destroyed every time the user collapses+expands the panel.

In practice this is benign because `DegradedBanner` only re-renders when `state.name === "degraded"`. But a future addition (e.g. an inline composer in the ObserverPanel for a user-to-observer chat) would also lose state across collapse-expand. Worth flagging: extract the rail into a sibling whose visibility is controlled via Tailwind `hidden`, so the panel subtree stays mounted. Otherwise document the unmount semantics in a comment near line 173.

### P2-7 — Five new WS switch cases are NOT exhaustively typed against the union (default branch swallows new variants)

**Where:** `web/src/ws.ts:574-1228`. The switch on `data.type` has 26+ cases including the 5 new `group_*`/`observer_review`. The final `default:` (line 1224) does `console.debug("[ws] Unhandled message type:", (data as { type: string }).type)`. There is no `never`-assertion on `data` after the switch.

`BrowserIncomingMessage` is a discriminated union from `session-types.ts`. If a future server commit adds a new `BrowserIncomingMessageBase` variant, the type checker will NOT flag the unhandled case — it falls through to `default` and gets logged at runtime only. The `quality-frontend.md` Principle 8 calls out this pattern explicitly as P2.

**Cost of getting it wrong:** silent message-drop for new server events. With the council surface specifically — where 5 new variants just landed — the risk shape is real. Pattern: add `const _exhaustive: never = data;` (or a typed helper) at the bottom of the default branch so adding a new variant in `session-types.ts` produces a TS error in `ws.ts` until the case is added.

### P2-8 — `ObserverPanel` is not wrapped in a per-section error boundary

**Where:** `web/src/App.tsx:318-322`. The ObserverPanel renders alongside ChatView/TaskPanel/Sidebar. `SectionErrorBoundary` exists (`web/src/components/SectionErrorBoundary.tsx`) and is used in `TaskPanel.tsx:1155-1157`. The `App.tsx` mount of `ObserverPanel` has no boundary wrapping.

The panel reads from a discriminated union (`ObserverPanelState`) derived from `GroupRecord + findings + dismissedStopIds`. The derivation is pure and total over its inputs — a malformed group payload from the server (e.g. `status === "degraded"` without `deadRole`) is handled by the fallback at `observer-panel-state.ts:36`. But the `FindingsLog` row rendering trusts `finding.evidence_lines` to be `[number, number]` when present; if the server emits a malformed shape (one-element array, NaN entries), the `BlockerBanner.formatEvidenceLine` could throw at the format step and crash the panel.

**Cost of getting it wrong:** today, a server-side malformed payload bricks the panel and probably the chat slot too (BlockerBanner is in ChatView). Wrap both `<ObserverPanel sessionId={…}/>` and the `<BlockerBanner …/>` slot in `ChatView` with `<SectionErrorBoundary label="Observer panel">` so a malformed finding fails the panel but the chat keeps working. `quality-frontend.md` Principle 5 is the home for this — P2 per-section boundary.

### P2-9 — Race between `removeGroup` and `setGroupStatus` is silently coalesced

**Where:** `web/src/store/council-slice.ts:235-248`. `setGroupStatus` returns `{}` if `s.groups.get(sessionGroupId)` is missing. That's intentional and matches "the server is the truth" — but the 5 new ws cases process `group_degraded` independently of `group_created`. If the server emits `group_degraded` before `group_created` (network reordering, or a session restored from disk on reconnect where `group_created` was already acked), the degraded status is dropped on the floor with no warning.

Pattern is similar in `recordCheckpoint` (line 250) and `appendObserverReview` (line 270): early-return on missing group. The server should be ordering these via the `seq` ack protocol, but `seq` ack only guarantees ORDER, not that all messages were ever received (history-merge case).

**Cost of getting it wrong:** silent loss of a degraded signal post-reconnect, leaving the panel in a stale `sleeping` or `reviewing` state. Either (a) log + warn on early-return paths (`console.warn("[council-slice] degraded for unknown group", sessionGroupId)`) so the symptom is visible, or (b) buffer late events keyed by sessionGroupId and flush on `group_created`. Today the codebase doesn't log the drop, which is the worst case — silent.

---

## P3 — Consider

### P3-1 — `CouncilToggle` outside-click handler uses `pointerdown` and lacks Escape-to-close

**Where:** `web/src/components/council/CouncilToggle.tsx:138-147`. The dropdown closes on outside `pointerdown` but not on Escape, and the dropdown trigger itself doesn't have `aria-controls` pointing to the listbox. (a11y is out of scope per task; the pure-React concern is just the Escape branch.) Add an Escape handler so keyboard users can close the dropdown without clicking outside.

### P3-2 — `formatRelativeTime` is exported from `FindingsLog.tsx` and imported elsewhere

**Where:** `web/src/components/council/FindingsLog.tsx:33-44` exports `formatRelativeTime`, which `BlockerBanner.tsx:19` and `ObserverPanel.tsx:35` import. This is fine in isolation but the pure helper is co-located with a component. As the helper is reused across three components, it would read better in `web/src/observer-panel-state.ts` (the pure-helpers module) or its own `web/src/utils/format-time.ts`. Cosmetic; pure-helper-with-tests is already there.

### P3-3 — `App.tsx` `<ObserverPanel>` mount is hidden on mobile via `hidden md:flex`

**Where:** `web/src/App.tsx:319`. On mobile the panel is unconditionally hidden. The collapsed-rail design implies it should be reachable on mobile via the same overlay pattern as TaskPanel. Could land in a follow-up; current state means mobile users with a Council session see ZERO observer state. The `useBrowserTitleAlert` does fire, so they DO get a title bump, but no way to see the findings list. (Friedman's lane; flagging from a React-composition standpoint because the responsive-class choice is a UX gap not a layout failure.)

### P3-4 — `SessionItem` prop count is now 21

**Where:** `web/src/components/SessionItem.tsx:5-28`. Two new optional props (`councilPairing`, `councilUnreadStops`) joined an already-large prop API. `quality-frontend.md` Principle 6 flags 8+ as a smell; the council additions push it deeper. Composition via a `<SessionItem.CouncilBadges>` slot would read cleaner, but the additions are clearly bounded (two scalar fields driven by a callable provided to ProjectGroup), so this is P3 not P2.

### P3-5 — `DegradedBanner` uses a controlled-vs-uncontrolled mode flag

**Where:** `web/src/components/council/DegradedBanner.tsx:38-58`. The component flips between uncontrolled local-state spinner and parent-controlled spinner via `typeof controlledRespawning === "boolean"`. This pattern is correct and well-documented in the code, but in practice every real call site SHOULD pass `isRespawning` so the parent owns the truth (the backend ack timing belongs to the parent). Today no call site passes it (Playground passes it once for demo). Consider making `isRespawning` required and removing the uncontrolled branch — fewer code paths, single source of truth.

### P3-6 — Store `reset()` does NOT reset `dismissedStopIds`'s persistent-key behaviour, but `firstRunHintDismissed` is intentionally preserved

**Where:** `web/src/store/index.ts:84-90`. The comment "observerPanelOpen / observerPanelWidth / firstRunHintDismissed are user-preferences that persist across reset" is correct. But `dismissedStopIds` IS reset, which is correct because it's per-process. Worth a comment to make the intent explicit at line 90, so a future maintainer who adds a persistence layer for `dismissedStopIds` knows why this one is in the reset list.

### P3-7 — `hydrateObserverFinding` strips `undefined` fields via conditional spread

**Where:** `web/src/store/council-slice.ts:111-130`. The hydration uses `...(wire.evidence_lines !== undefined ? { evidence_lines: wire.evidence_lines } : {})` patterns. This produces minimum-shape objects, which is fine, but six conditional spreads makes the function noisy. A future maintainer could mistake the conditional spread for some kind of validation, when it's only "don't propagate undefined keys". A short JSDoc note explaining the intent ("exact-optional-property-types compliance") would inoculate against future cargo-cult cleanups that drop the conditional spread.

---

## What I checked and did NOT find a finding on

- **No store mutation outside slice actions.** All five new WS cases (`web/src/ws.ts:1178-1222`) call slice actions (`upsertGroup`, `removeGroup`, `setGroupStatus`, `recordCheckpoint`, `appendObserverReview`) — never `useStore.setState`. Clean.
- **No `useState` mirroring of Zustand state in council components.** The localStorage echo in `HomePage.tsx:121-126` for `councilEnabled`/`councilPairing` is correct — those are FORM state, not server state. The persistence-via-store option doesn't apply because the user's pre-creation choice isn't a session-keyed concept.
- **No class components in the council surface.** Only `AppErrorBoundary` and `SectionErrorBoundary` are classes, both pre-existing and necessary (React error-boundary API).
- **No unnecessary `useMemo`/`useCallback` in `ObserverPanel`.** The three `useCallback` uses (lines 159-163) are legitimate — each is a closure passed to a child or used as a dep elsewhere.
- **Discriminated-union `ObserverPanelState` is consumed correctly.** `StatusPill` (lines 53-104) exhausts every variant; TS would catch a new variant. Good Beck-F4 + Principle 8 alignment.
- **Playground entries are self-cleaning.** `CouncilModeSection`'s `useEffect` correctly removes the seeded group on unmount (line 2946-2948); `CouncilDegradedPanelDemo` does the same (line 3071-3073). No store leak between Playground re-mounts.
- **`useCouncilShortcuts` cleanup is correct** (`return () => window.removeEventListener("keydown", handleKeyDown)` at line 72). Same for `useBrowserTitleAlert` unmount restoration (lines 57-64), modulo P2-5's StrictMode concern.
- **`message_history` and `event_replay` do not need new logic for group events.** Group events are not session-scoped (they route to multiple sessions), so they correctly DON'T appear in the `message_history` shape; the replay path handles them as ordinary message envelopes via the `handleParsedMessage` recursion. Verified at `web/src/ws.ts:1131-1148`.
- **`AppErrorBoundary` wraps the whole tree** (`web/src/main.tsx:10-15`), so a council render crash won't blank the screen unconditionally — just unmount the App subtree. The P2-8 finding is about per-section boundaries, not the global one.

---

## Severity Summary

| # | Severity | Finding |
|---|----------|---------|
| P1-1 | P1 | Two parallel cleanup paths for Council state on session removal |
| P2-1 | P2 | Whole-Map `findings` selector defeats narrowing in Sidebar + title alert |
| P2-2 | P2 | Inline `?? []` fallback in `findings` selector creates fresh-array identity per render |
| P2-3 | P2 | `councilInfoFor` is not `useCallback`-stabilised, defeats future `React.memo` |
| P2-4 | P2 | `useCouncilShortcuts` relies on first-match `data-council-blocker-primary` with no uniqueness assertion |
| P2-5 | P2 | `useBrowserTitleAlert` captures base title in render body (StrictMode race) |
| P2-6 | P2 | ObserverPanel collapsed/expanded forms unmount internal state on toggle |
| P2-7 | P2 | `ws.ts` switch lacks exhaustiveness `never` assertion at default |
| P2-8 | P2 | `ObserverPanel` and `BlockerBanner` not wrapped in `SectionErrorBoundary` |
| P2-9 | P2 | Council slice early-returns silently drop out-of-order events; no warn/log |
| P3-1..7 | P3 | Hygiene/composition — Escape on dropdown, helper colocation, mobile mount, prop count, controlled-only DegradedBanner, reset comment, hydration JSDoc |
