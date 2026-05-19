# Council Pair Layout Stability

**Status:** Draft · **Owner:** TBA · **Tier:** Feature

## Problem

When a Council Mode pair (orchestrator + observer) is running, the **entire app shifts vertically upward inside the browser viewport**. The top of the UI (TopBar, "+" new-session button, sidebar header) scrolls off-screen and becomes unreachable. The vacated area at the bottom of the viewport shows the browser's default gray background — a "dead band" ranging from a thin 30–50px strip up to ~60% of the viewport height in the worst case. The bug is observed:

- ONLY when a Council pair (observer + orchestrator) exists in the session list.
- When the user is viewing a mono session: layout is correct.
- When the user switches from a mono session to a pair half: the upward shift fires (sometimes small, sometimes up to ~60% of viewport).
- When no mono session is present and only the pair exists: the symptom is more severe / persistent.

This is **not a horizontal width shift**. It is a **vertical viewport / document-scroll defect**: the document or its containing block becomes taller than the visible viewport, the browser scrolls the page upward, and the `fixed inset-0` root container is laid out against a containing block that overflows the visible area.

The bug has recurred after multiple prior fixes touching adjacent surfaces: PR #76 (iOS standalone PWA html height — gated workaround), PR #577 (home input shifts), PR #25 (council dropdown overflow). The current `web/src/index.css` comment block (lines 365–393) literally documents this failure mode: *"creates an equal gap at the bottom where the html background shows through"* and *"html TALLER than the viewport — which causes a dead band below the Composer"*. PR #76 fixed the iOS-PWA path by gating the workaround behind `@media (display-mode: standalone)`. The current bug is the SAME symptom under a different trigger — a regular browser tab on `http://65.108.82.189:3456/`, with the gate confirmed not matching and the workaround confirmed not firing.

**Confirmed ruled out (pre-Discovery checks completed):**

- **Deployment is not stale.** The deployed bundle at `65.108.82.189:3456/assets/index-CyKDO_0l.css` matches `web/dist/assets/index-CyKDO_0l.css` byte-for-byte. The PR #76 `@media (display-mode: standalone)` gate is present in the served CSS. The user's display-mode is `browser` (regular tab), not `standalone`, so this rule cannot fire on their viewport.

**Primary suspects (to be confirmed in Discovery):**

1. **html / body height contract breach via an inner descendant.** `index.css` locks `html { overflow: hidden }` and `body { height: 100%; overflow: hidden }`. Some descendant of the `fixed inset-0` root in `App.tsx:222` is forcing `document.documentElement.scrollHeight > clientHeight` when ObserverPanel mounts — most likely because an inner flex chain is missing `min-h-0` and lets its content push the row beyond `100%`. The `fixed inset-0` root is then laid out against a containing block taller than the visible viewport, and the browser scrolls the document upward.
2. **ObserverPanel as the height-forcing child.** The panel's `<aside>` (`ObserverPanel.tsx:351`) carries `h-full flex flex-col`. The interior stacks: header (`shrink-0`), status row (`shrink-0`), DegradedBanner (`shrink-0`, conditional), reviewing-stalled banner (`shrink-0`, conditional), first-run hint (`shrink-0`), FindingsLog (`flex-1 min-h-0 overflow-y-auto`). If multiple `shrink-0` banners mount simultaneously and their combined height exceeds the column, the `flex-1 min-h-0` contract can break and push the column taller than its parent's `h-full`.
3. **Composer wrap on narrower main column.** When ObserverPanel mounts, ChatView's column narrows from full-width to `~viewport - 320px - sidebar - taskpanel`. The Composer (or any bottom-anchored element in ChatView) may wrap to additional lines, pushing the message-feed area beyond viewport. If the chain `ChatView → MessageFeed/Composer` is missing a `min-h-0` somewhere, the overflow propagates upward to the document.
4. **Modal / overlay mount races.** `SessionLaunchOverlay` / `DockerUpdateDialog` / `OnboardingModal` / `UpdateOverlay` use `fixed inset-0`. If any of them mount/unmount during a council `group:created` event handler, their teardown may leave a transient `position: fixed` element off-viewport that scrolls the document.
5. **Sidebar / TaskPanel inline-vs-fixed switch at md:/lg: breakpoints.** Both the Sidebar (`App.tsx:232`) and TaskPanel (`App.tsx:376`) toggle between `fixed inset-y-0` (mobile) and `relative` (desktop) via Tailwind's `md:`/`lg:` modifiers. If a user's viewport sits at the breakpoint boundary OR the breakpoint switch fires during a council state change, transient state may include both panels `fixed` simultaneously without a `relative` flex sibling, breaking the row.
6. **`fixed inset-0` containing-block escape.** A descendant with `transform`, `filter`, `perspective`, or `will-change` other than the default creates a new containing block for `position: fixed` descendants. If ObserverPanel or a banner inside the main row introduces such a property, child `fixed` elements (modals, banners) may be laid out against the new containing block instead of the viewport — producing the off-screen scroll appearance.

## Discovery (mandatory before fix)

Before writing fixes, the implementing agent must produce a short root-cause report covering:

1. **Confirm reproduction on the user's setup.** Open `http://65.108.82.189:3456/` in a regular browser tab (Chrome / Firefox / Safari). Confirm `window.matchMedia('(display-mode: standalone)').matches === false`. Confirm `Array.from(document.styleSheets).flatMap(s => Array.from(s.cssRules)).filter(r => r.cssText.includes('display-mode')).length === 1` — the gate is present in the served CSS. Reproduce the symptom with a Council pair running.
2. **Capture the symptom numerically.** Across these transitions — Home → pair-half, mono → pair-half, pair-half → Home, pair-half → other-pair-half — record before/after values of: `window.scrollY`, `window.visualViewport.offsetTop`, `document.documentElement.scrollHeight - clientHeight`, `document.body.scrollHeight - clientHeight`, and `document.querySelector('[data-testid="topbar"]').getBoundingClientRect().top`. Document which transition produces which numeric shift.
3. **Identify the first element where `scrollHeight > clientHeight`.** With the symptom reproduced, walk the DOM from `documentElement` down breadth-first; find the first element where `scrollHeight > clientHeight`. Capture its tag/role/data-testid, computed `min-height`, `height`, `max-height`, `overflow`, `display`, `position`, and flex-context. The structural cause sits at this element or one level up.
4. **Check for unexpected containing-block creation.** Walk descendants of the `fixed inset-0` root; identify any element with computed `transform !== 'none'`, `filter !== 'none'`, `perspective !== 'none'`, `will-change` containing `transform`/`filter`/`perspective`, or `contain: layout/paint/strict`. Any such element creates a new containing block for `position: fixed` descendants — confirm whether modals (`SessionLaunchOverlay`, `DockerUpdateDialog`, `OnboardingModal`, `UpdateOverlay`) mounted inside that subtree get laid out against the new containing block rather than the viewport.
5. **Test the ObserverPanel banner-stack hypothesis.** Force the worst-case panel state: `degraded` + first-run hint visible + `reviewing-stalled-banner` mounted simultaneously (use Playground to mock this if live state can't be reached). Measure `aside.scrollHeight` vs `aside.clientHeight`. If overflow, the `FindingsLog` `flex-1 min-h-0` contract is breaking under the worst-case stack — fix at the FindingsLog parent or at one of the `shrink-0` siblings.
6. **Test the Composer wrap propagation.** With ObserverPanel open at default width, type into the Composer until it wraps to ≥5 lines. Measure ChatView's outer container `scrollHeight` vs `clientHeight`. If overflow, ChatView's vertical flex chain is missing a `min-h-0`.
7. **Test the breakpoint switch.** Resize the window slowly across the `md:` (768px) and `lg:` (1024px) breakpoints with a Council pair running. Confirm whether the Sidebar / ObserverPanel / TaskPanel transition between their `fixed` and `relative` modes cleanly, or whether any intermediate frame has all three `fixed` simultaneously.
8. **Test the layered conditional render hypothesis (low priority — most likely NOT the cause for the vertical-shift symptom, but documents the cleanup opportunity).** Confirm whether the `App.tsx:345` wrapper gate (`currentSessionId && isSessionView`) plus the `ObserverPanel:334` internal `if (!group) return null` together produce a mounted-but-null state, and whether collapsing this to a single derived predicate eliminates any transient layout state during navigation.

The fix must address the SINGLE structural cause identified in the report. A CSS-only patch (sprinkled `min-height: 0`, `transform: translateY(0)`, additional `overflow: hidden` on a parent above the problem element) is not a fix — every prior recurrence was exactly that kind of patch.

## Job Stories

### Story 1 — The top of the UI is always reachable

**When** I have a Council pair running and I switch between sessions (mono, pair half, Home), **I want** the top of the app — TopBar, the "+" new-session button, sidebar header, and global controls — to remain visible inside the browser viewport at all times, **so I can** continue operating the app without losing access to its primary controls.

**Acceptance criteria**

1. **Given** a Council pair is running and any session route is open, **when** the route finishes rendering, **then** `document.querySelector('[data-testid="topbar"]').getBoundingClientRect().top` is `≥ 0` and `≤` the safe-area inset top (i.e. the TopBar is fully within the visible viewport).
2. **Given** a Council pair is running, **when** I navigate mono → pair half, **then** `window.scrollY` and `window.visualViewport.offsetTop` both equal `0` after the transition settles.
3. **Given** a Council pair is running and the pair half is open, **when** I attempt to interact with the "+" new-session button in the sidebar, **then** the button is hit-testable (returned by `document.elementFromPoint(buttonCenterX, buttonCenterY)`).
4. **Given** any session route, **when** the route is rendered, **then** `document.documentElement.scrollHeight === document.documentElement.clientHeight` (html is not taller than the viewport).
5. **Given** any session route, **when** the route is rendered, **then** `document.body.scrollHeight === document.body.clientHeight` (body is not taller than the viewport).
6. **Given** a Council pair is running, **when** the user is on Home with no mono session, **then** no gray "dead band" is visible at the bottom of the viewport (the bottom edge of the app root touches the bottom of the visible viewport, within ±1px).

### Story 2 — ObserverPanel mounts and unmounts without moving the rest of the UI vertically

**When** the ObserverPanel mounts (entering a pair half), unmounts (leaving a pair half), expands from rail, or collapses to rail, **I want** no element outside the panel to shift vertically, **so I can** keep my place in the chat / Home without the screen jumping.

**Acceptance criteria**

1. **Given** Home is displayed and a pair exists, **when** I click into the orchestrator half (ObserverPanel mounts), **then** TopBar's `getBoundingClientRect().top` value is unchanged before vs after the mount.
2. **Given** the orchestrator half is open with the panel mounted, **when** I navigate back to Home (panel unmounts), **then** TopBar's `getBoundingClientRect().top` is unchanged.
3. **Given** the panel is open at width W, **when** I collapse it to the rail, **then** no element outside the panel changes its `getBoundingClientRect().top`.
4. **Given** the panel header has `DegradedBanner` + first-run hint + `reviewing-stalled-banner` simultaneously visible (a worst-case stack), **when** the panel renders, **then** the aside's `scrollHeight === clientHeight` (the panel does not overflow its column).
5. **Given** no pair exists for the current session, **when** the session view renders, **then** the ObserverPanel does not contribute any DOM that affects layout (verifiable via DOM snapshot comparison with the same view in the no-pair fixture).

### Story 3 — BlockerBanner and Composer changes stay inside ChatView

**When** a STOP finding arrives (BlockerBanner mounts) or the Composer wraps to additional lines, **I want** the rest of the page — including TopBar position and viewport scroll — to stay stable, **so I can** trust that pair-driven content doesn't break the global layout.

**Acceptance criteria**

1. **Given** a STOP arrives and `BlockerBanner` mounts in the PermissionBanner slot, **when** it appears, **then** TopBar's `getBoundingClientRect().top` is unchanged and `window.scrollY === 0`.
2. **Given** the Composer is one line tall, **when** I type enough content to make it wrap to 5 lines, **then** TopBar and the sidebar remain in their original viewport positions; only the message-feed scrollable area shrinks to accommodate.
3. **Given** ChatView is the active route with the panel open, **when** I measure `document.querySelector('[data-testid="chatview"]').scrollHeight` and `clientHeight`, **then** they are equal (the ChatView column does not overflow).
4. **Given** a pair is created while I am on Home, **when** the sidebar updates with pair badges, **then** the HomePage content position is unchanged and no viewport scroll occurs.

### Story 4 — Pair lifecycle events don't move the rest of the UI

**When** a pair is created, archived, or transitions to `degraded` / `reconnecting`, **I want** lifecycle banners (DegradedBanner, reviewing-stalled-banner) to render without moving the rest of the app, **so I can** trust pair-mode as an additive UX.

**Acceptance criteria**

1. **Given** a pair half is open, **when** the group transitions to `degraded` and `DegradedBanner` mounts inside the panel header, **then** TopBar position and `window.scrollY` are unchanged.
2. **Given** a pair half is open with the panel mounted, **when** the pair archives (`group:exited`) and the route falls back to Home, **then** the unmount completes in a single reflow with no transient viewport scroll.
3. **Given** a pair exists but the current route is a non-session page (Settings, Agents, etc.), **when** the route renders, **then** the ObserverPanel does not render at all and the page layout matches the no-pair baseline.

## Boundaries

### ✅ Always
- Enforce the invariant in code AND in tests: `document.documentElement.scrollHeight === clientHeight` AND `document.body.scrollHeight === clientHeight` at all times for every session route.
- Identify and remove the single descendant that pushes the document taller than the viewport. The fix lives at that element (or one level up), not in a parent's `overflow: hidden` shim.
- Verify the PR #76 standalone-mode gate (`@media (display-mode: standalone)`) fires only on actual iOS PWA installs — if it matches in Chromium standalone window or any non-iOS-PWA context, narrow the gate further (e.g. add platform sniff or pair with `@supports` / specific UA test).
- Add a regression test (Vitest + jsdom or Playwright via `agent-browser`) that asserts: after each transition (Home, mono, pair-half, switch back), `getBoundingClientRect().top` of `[data-testid="topbar"]` is `0` (or ≤ safe-area inset top) AND `window.scrollY === 0`.
- Add a `PerformanceObserver` (`layout-shift`) assertion in the regression test: zero significant layout-shift entries during Home → pair-half → mono → pair-half → Home transitions.
- Update the Component Playground (`web/src/components/Playground.tsx`) with a scenario that mocks a Council pair + ObserverPanel in its worst-case header stack (degraded + first-run hint + reviewing-stalled all visible).
- Run `bun run typecheck` + `bun run test` after every substantive change; both must pass.
- Verify the fix in a browser via `agent-browser` against the live dev server with a pair-and-mono fixture; capture before/after viewport screenshots.
- Read prior fix context (PRs #76, #577, #25) to avoid regressing those cases. Specifically: the iOS-PWA-status-bar workaround MUST still function on actual iOS PWA installs.
- Mark TopBar with `data-testid="topbar"` and ChatView with `data-testid="chatview"` (if not already) so the regression tests have stable selectors.

### ⚠️ Ask first
- If the fix requires narrowing the `@media (display-mode: standalone)` gate further (e.g. UA sniff for iOS), confirm — that touches a deployed iOS PWA workaround and risks regressing that platform.
- If the fix requires moving the ObserverPanel wrapper out of `App.tsx` into a new layout-level component, surface the proposed structure first.
- If `observerPanelWidth` / `observerPanelOpen` persistence needs schema changes, confirm before touching `store/council-slice.ts`.
- If a CSS Grid migration of the main-area row is needed, confirm — that is broader than this spec.
- If the discovery identifies the build-vs-source / Service Worker layer as the primary cause (rather than source-code defect), pause and confirm scope — that's a deployment fix, not a UI refactor.
- If the discovery identifies the FindingsLog `flex-1 min-h-0` chain or the Composer wrap as the cause and the fix requires touching message-feed virtualization, confirm before refactoring.

### 🚫 Never
- Never paper over the shift with CSS-only shims (`min-height: 0` sprinkled on parents, `transform: translateY(0)`, `position: sticky` on TopBar, additional `overflow: hidden` on a parent above the problem element) without removing the structural cause — every prior recurrence was exactly this kind of patch.
- Never remove or weaken existing tests for `ObserverPanel`, `ChatView`, `HomePage`, `Sidebar`, or the iOS PWA `pt-safe` behaviour.
- Never delete the PR #76 gate without a replacement — the underlying iOS PWA status-bar issue still exists for that platform.
- Never change panel per-session open/width persistence semantics — PR #68 bootstrap relies on them.
- Never introduce a `useLayoutEffect` that measures and writes layout values on every render (feedback-loop anti-pattern).
- Never use `window.scrollTo(0, 0)` or `scrollIntoView` to "fix" the symptom — that masks the cause and leaves the underlying overflow in place.
- Never gate the fix behind a feature flag or fallback path — the bug is a recurrence, not a feature.
- Never modify server-side code (`web/server/`), the WS pipeline, council slice business logic, or any non-layout client logic in this spec's scope.

## Non-goals

- Mobile layout below `md:` breakpoint. The current `hidden md:flex` gate on the panel wrapper stays; mobile uses a different layout strategy.
- Visual redesign of the panel (status pill copy, banner palette, ProviderBadges).
- Touching `web/server/`, group state machine, observer prompt, or any backend module.
- Performance optimisations unrelated to layout stability.
- Replacing the PR #76 iOS PWA status-bar workaround with a different approach — it stays; the bug is that its gate is too broad, not that the workaround itself is wrong.

## Confirmed facts (set during scoping; do NOT re-question)

- **Access mode:** the user opens `http://65.108.82.189:3456/` in a regular browser tab. Not an installed PWA. Not iOS Safari standalone.
- **Symptom axis:** vertical. The entire app shifts upward inside the browser viewport, TopBar and the "+" new-session button go off-screen, a gray "dead band" appears at the bottom (30–50px in mild cases, up to ~60% of viewport in worst cases). This is NOT a horizontal width shift.
- **Trigger:** the symptom only fires when a Council pair (orchestrator + observer) exists. With a mono session and no pair, the layout is correct.
- **Aggravator:** the symptom is more severe / persistent when no mono session is present alongside the pair. Switching mono → pair-half reliably triggers a visible jump (sometimes small, sometimes large).
- **Deployment state:** the served bundle at `65.108.82.189:3456/assets/index-CyKDO_0l.css` matches `web/dist/assets/index-CyKDO_0l.css` byte-for-byte. The PR #76 `@media (display-mode: standalone)` gate IS present in the served CSS. Bundle staleness is ruled out as the cause.
- **PR #76 gate behaviour:** in a regular browser tab, `display-mode` is `browser`, not `standalone`, so the `html { min-height: calc(100% + env(safe-area-inset-top)) }` rule does NOT fire on the user's viewport. This rule is NOT the cause.

## Assumptions (unconfirmed — verify in Discovery)

- A Service Worker may still be registered from an earlier session even though the bundle hashes match. Discovery should check `navigator.serviceWorker.getRegistrations()` and confirm the registered SW (if any) is serving the same content hash as the live request — but expect this to be a no-op since the hashes already agree.
- The user's reproduction sequence is roughly: load the URL with a Council pair already existing OR create a pair while looking at Home, then navigate to a session. Discovery should confirm whether ObserverPanel mount (entering a pair half) is the precise trigger, or whether merely having a pair in the sidebar (without navigating to it) is enough.
- The bug also reproduces in local dev (`bun run dev` against `http://localhost:5174/`) — this would make iteration faster than testing only against the remote VPS. Confirm or deny early in Discovery.

## Success metrics

- After fix: `document.documentElement.scrollHeight === clientHeight` AND `document.body.scrollHeight === clientHeight` for every session route, with and without a Council pair, with and without ObserverPanel mounted, in dev AND in the production deployment.
- After fix: TopBar `getBoundingClientRect().top` is `0` (or ≤ safe-area inset top) at all times on every session route.
- After fix: zero gray "dead band" at the bottom of the viewport in any state.
- After fix: zero `PerformanceObserver` `layout-shift` entries attributable to ObserverPanel mount/unmount during the navigation regression script.
- Discovery report identifies a SINGLE structural root cause and the fix removes it (no "multiple cosmetic issues" framing).
- The PR #76 iOS PWA workaround still functions on an actual iOS PWA install (verified or documented as a manual smoke test).
- All pre-existing tests pass; new regression tests cover all four job stories.

## Self-verification footer

After implementing, compare results against each acceptance criterion above and list any unmet requirements. Specifically: (1) attach the discovery report with the named structural cause; (2) re-run the regression test and capture before/after values of `documentElement.scrollHeight`, `body.scrollHeight`, `window.scrollY`, and `TopBar.getBoundingClientRect().top` at each transition; (3) list any `layout-shift` entries that fire during the test; (4) confirm the fix is structural (not a CSS-only shim) by pointing to the removed overflow source or the narrowed gate; (5) confirm the iOS PWA path still works (manual smoke or documented out-of-scope).
