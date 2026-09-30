# friedman.md — UX Quality Review of PR #68

**Reviewer:** Vitaly Friedman (UX Quality)
**Lens:** §A scanability & decision design / §B form & friction UX, with `resilient interface patterns` (five-state discipline) as the primary frame.
**Scope:** `web/src/App.tsx` (post-auth bootstrap useEffect), `web/src/store/council-slice.ts` (`hydrateGroups` idempotency contract).
**Context:** PR #68 closes `BUG-council-mode-group-rest-bootstrap-gap.md` — Sidebar dropped the ☼/☽ glyph + ` · orchestrator`/` · observer` suffix after browser reload because the live `group:created` push was the only producer of group records. The bug surfaced as sustained role-identity confusion across the whole post-reload session — until the next pair-event arrived (which might never come for an active idle pair) the user could not tell which session in the Sidebar was the orchestrator they typed into and which was the observer that read silently. The PR adds `GET /api/groups`, dispatches it from a post-auth `useEffect` in `App.tsx`, and routes the result through a new idempotent `hydrateGroups` slice action that explicitly cedes to live WS state for any group already in the map. Three independent producers (live push, REST bootstrap, ws-bridge synthetic hydration) now share one assembly helper. The PR also lands a sibling fix in `ProjectGroup.tsx` that turns the glyph-on-first-creation behaviour from "sometimes" to "always" by plumbing `councilRole` through a previously-dropped prop path.

The UX evaluation below treats the bootstrap window as a five-state surface (blank / loading / partial / error / ideal) and asks whether each regime renders meaningfully, whether the user's mental model survives the reload, and whether the new failure mode introduced by the bootstrap (REST request fails silently) is honest enough that the user can recover.

---

## Finding 1 — Role-identity restoration across reload is the right primary UX fix and the discipline is correct

**Severity:** P3 (commendation — anti-finding; documents the structural decision so it does not regress)
**File:** `web/src/App.tsx:177-202`, `web/src/store/council-slice.ts:159-279`
**Discipline:** §B resilient interface patterns (five-state discipline) + §A scanability (role-identity preservation)

**Finding.** Before this PR, a user who reloaded the tab on an active council pair landed on a Sidebar where both halves rendered as identical-looking session rows — no glyph, no role suffix, no provider badges, and (because `groupBySessionId` was empty) no ObserverPanel context, no BlockerBanner, no TopBar pair indicator. The user had to either remember which session ID they had typed into or trigger a new pair-event to refresh the store. This is a textbook violation of scanability: the surface's first-sweep job is to make the user locate "which thing am I looking at" in pre-cognitive time, and the post-reload Sidebar made that locate-step structurally impossible for the most important property of a council session (which half is which). The fix as landed restores role-identity uniformly on every authenticated mount, before the user has time to read a single label.

The structural decision deserves explicit credit: the `useEffect` is keyed on `isAuthenticated`, so the bootstrap re-runs on the precise transition where the user could not have seen the Sidebar before (pre-auth gate at `App.tsx:213-215` renders the `LoginPage` instead). That gate means the user never sees the Sidebar in its blank "no groups yet" state during the bootstrap window — they see it for the first time once the store has its initial data. The user's mental model of "I just logged in / refreshed and my session looks the way I left it" survives intact.

**Consequence.** This is the right level of intervention. A heavier alternative (synchronous SSR hydration of the group records, or blocking the App tree on a `<Suspense>` boundary keyed to the fetch) would have added complexity and a perceptible hang for the common case (no council pairs at all — the empty 200 response short-circuits at `council-slice.ts:251`). A lighter alternative (firing the fetch on first Sidebar mount instead of App mount) would have re-run on every Sidebar mount/unmount and added per-route latency. The chosen position — one App-level effect, keyed on the auth boundary the user can recognise — is the minimum sufficient intervention.

**Fix.** None required. Codify the decision in the PR description so the next reviewer who proposes "let's lift this into a Suspense boundary" knows the trade was deliberate. The `useEffect` comment block at `App.tsx:177-189` already does most of this work in-code; the PR body should echo it.

---

## Finding 2 — Loading-state flash is acceptable but unmeasured; add a smoke-test budget so future regressions surface

**Severity:** P3 (advisory — the current behaviour is fine, the absence of a measurement is the risk)
**File:** `web/src/App.tsx:190-202`
**Discipline:** §B resilient interface patterns (loading state as one of five required surfaces)

**Finding.** Between App mount and the resolution of `api.fetchGroups()`, the Sidebar renders council-pair rows WITHOUT their glyph / role suffix / provider badges, then re-renders WITH them once `hydrateGroups` fires. On a local-loopback REST request returning `{groups: [<small N>]}`, this window is typically 10–80 ms — well below the 100 ms human-perceptible-flash threshold for most users on most connections. Acceptable as designed.

However: the PR does not assert a budget anywhere. If a future change to `routes.ts` (auth middleware addition, response-size growth from new fields, a database-backed implementation replacing the in-memory `coordinator.listAll()`) pushed the bootstrap latency to 300–800 ms, the flash would become visibly distracting — the user would see the Sidebar settle twice, which on a sustained-daily-use tool reads as "the surface is slow" rather than "the surface is loading". The five-state discipline asks every surface to design for loading explicitly; here loading was implicitly designed as "imperceptible", which is correct *today* but undefended against drift.

**Consequence.** The bootstrap could silently regress to a perceptible flash and no test would catch it — the existing test (`web/src/glyph-after-reload.test.tsx`) is structural (does the glyph appear after hydration) not temporal (does the glyph appear within N ms). Future contributors removing the empty-array fast-path or adding synchronous work to `hydrateGroups` would not see the cost in CI.

**Fix.** Add a soft-budget assertion to the integration test — measure `performance.now()` at App mount, again after the first non-empty `useStore.getState().groups` selector read, and `expect(delta).toBeLessThan(250)` (or whatever threshold the team treats as the perceptible-flash floor). This is not a tight gate; it is a tripwire. Pair the assertion with a one-line PR-body note "bootstrap budget: 250 ms" so the next reviewer knows the budget exists. No UI loading placeholder is needed — introducing one would add complexity for a regime that, today, doesn't warrant it.

---

## Finding 3 — Silent error handling on `fetchGroups` failure is the right default but the recovery path is invisible to the user

**Severity:** P2 (the chosen behaviour is correct in spirit; the gap is in user-discoverable recovery)
**File:** `web/src/App.tsx:194-201`
**Discipline:** §B resilient interface patterns (error state as one of five required surfaces); anti-pattern catalogue "action-failed errors swallowed into a 3-second toast that auto-dismisses"

**Finding.** When `fetchGroups` rejects (network blip, server 500, auth middleware refusing the request), the current code logs structurally to `console.warn` and returns. The user sees nothing. The Sidebar continues to render council pairs without their glyph / suffix — i.e. the exact bug PR #68 was created to close, re-manifested for the failure regime. The brief comment block at `App.tsx:187-189` claims "live WS events still arrive on the next group_* frame, so a network blip here doesn't strand the UI" — this is true for pairs that produce future events, but is FALSE for an active idle pair on a project the user is reloading specifically because they want to resume work on it. The most common path through this code is "user reloads tab on a long-running pair to check on it" — exactly the case where no future `group:*` event is guaranteed and the bootstrap is the only signal the user gets.

The chosen behaviour (silent retry on next mount) is defensible: there is no actionable error here for the user — they did nothing wrong, the recovery is implicit (reload again), and a banner / toast on the first try would teach the user to blink past banners they cannot act on. The structural log is the right primitive for forensic grep ("council.bootstrap.fetch_failed"). What is *missing* is the user-discoverable affordance to recover when the silent retry didn't fire because the user didn't reload.

**Consequence.** A user on a flaky network sees their council pair lose its role identity after reload, has no signal that anything went wrong, has no way to ask the surface to re-try the fetch, and will assume the council feature is broken. The structural log helps the operator diagnose post-hoc but does not close the loop for the user. This is the "action-failed errors swallowed" anti-pattern in its most subtle form — the failed action wasn't even initiated by the user, so the user has no mental model that there was an action to fail.

**Fix.** Two-part, both small:

1. **Idempotent re-fetch on WebSocket reconnect.** The browser's WS client at `web/src/ws.ts` already detects reconnections (auto-reconnect path). On every successful reconnect, dispatch the same `fetchGroups → hydrateGroups` pipeline. Reconnect implies the WS was down, which is a strong correlated signal that the bootstrap fetch might have failed (same network blip). The hydrate action is idempotent by construction (`council-slice.ts:265 — if (groups.has(g.sessionGroupId)) continue`), so this cannot double-insert. This is the resilient-pattern recovery — the surface detects its own degraded state via a signal it already has and re-bootstraps without user intervention. No new affordance, no new banner.
2. **Optional, defer to v2 if scope-tight: visible-on-degraded affordance.** If the WS reconnect re-fetch ALSO fails (rare; correlated server-side outage), surface a single low-friction "couldn't load council state — retry" link in the Sidebar header. Not a modal, not a toast. A muted link the user discovers if they were looking for it. The discoverability cost is low; the recovery cost is one click.

The first sub-fix alone closes the realistic-network-blip case. The second is defence-in-depth for sustained outages.

---

## Finding 4 — Hydrate-then-WS race: the chosen WS-wins-for-mutable-fields contract is correct but the user-visible window where REST briefly wins for IMMUTABLE fields is undocumented

**Severity:** P3 (advisory — the contract is correct; the gap is in how a future reviewer will read it)
**File:** `web/src/store/council-slice.ts:246-278`, `web/src/App.tsx:190-202`
**Discipline:** §A decision design (idempotency contract surfacing); §B resilient interface patterns (partial state regime)

**Finding.** The `hydrateGroups` contract documented at `council-slice.ts:160-173` and inline at `council-slice.ts:262-265` says: live WS wins for any group already in the store, because WS-arrived records carry mutable runtime fields (`lastCheckpointAt`, `observerReviewing`, `recentlySupersededCheckpointIds`, `convergenceState`) that REST does not include. This is the right call — re-overwriting from REST would visibly regress the panel state for a tab already in sync.

What the contract does NOT spell out is the converse asymmetry: for groups in the store, REST also doesn't overwrite the IMMUTABLE fields. This matters for one specific edge case: if the live WS payload of `group:created` ever drifts from the REST payload in a non-mutable field (a bug in `buildBrowserGroupRecord`, a future field added to one path but not the other, or a wire-shape version skew between an older live frame and a newer REST schema), the contract silently picks the live version forever — even if it is the wrong one. The PR mitigates this beautifully at the producer level (one assembly helper for all three producers — finding-1 commendation), but the slice contract itself is now load-bearing on that producer-level invariant holding forever.

**Consequence.** Today this is a non-issue — `buildBrowserGroupRecord` is the single source of truth and the council review is recommending it for promotion to a new convention (`AP-X` per context brief §Convention floor). The user sees no defect today. The risk is in the next 12 months: a future contributor refactors `buildBrowserGroupRecord` and accidentally produces divergent shapes; the WS path emits the bug, the REST path doesn't, and the slice's "live wins" rule entrenches the bug across reloads. The user-visible symptom would be subtle (a field rendering wrong on reload-recovered pairs only) and the debug path would require remembering this asymmetry exists.

**Fix.** Two-line documentation enhancement at `council-slice.ts:160-173`. Add: "The producer-side invariant — all three writer paths route through `buildBrowserGroupRecord` — is load-bearing on this contract. If that invariant breaks, the live-wins rule silently entrenches the bug. The producer-side test `web/server/browser-group-record.test.ts` is the canary; do NOT weaken `hydrateGroups`'s contract without first verifying that canary still holds." No code change. This is purely a future-reviewer's contract document.

---

## Finding 5 — Bonus fix in `ProjectGroup.tsx` quietly upgrades "sometimes" to "always" — promote it from a buried bonus to an explicit user-facing improvement in the PR body

**Severity:** P3 (advisory — the fix landed; the gap is in how it is communicated)
**File:** `web/src/components/ProjectGroup.tsx:11-16,123` (out-of-scope for friedman's domain assignment per context brief §Domain File Assignments, but raised here because the UX impact is large enough to warrant explicit surfacing)
**Discipline:** §A scanability (role-identity glyph is the primary scan anchor for council pairs)

**Finding.** The original bug report scoped the regression to post-reload — "after reload, the Sidebar drops the ☼/☽ glyph". The context brief reveals (§Key observations, fourth bullet) that `ProjectGroup.tsx` had been silently dropping `councilRole` since its introduction: typed as `{pairing?, unreadStops?}` with no `role`, and never spread to `SessionItem`. The implication is that the glyph was ALSO missing for ACTIVE pairs immediately after creation, not just after reload. The integration test surfaced this; the fix (+7/−2) lands the active path end-to-end for the first time.

From a user-perception standpoint, this is the bigger fix. Reload-after-creation is a rare path (the bug only catches users who reload while a pair is active). Active-after-creation is the COMMON path — every user who creates a council pair experienced the glyph-absent state until the next pair-event refreshed the store. The bug report's wording "or sometimes on first creation" was a hint that something was off; the fix turns "sometimes" into "always" for the most common case.

**Consequence.** As shipped, the PR description risks framing this as a small bonus when in fact it is the larger UX improvement. A future contributor reading the changelog will think the reload-bootstrap was the big-ticket item; they will not learn the active-creation glyph regression was closed at the same time. If that regression returns (via a similar prop-dropping refactor on `ProjectGroup` or `SessionItem`), the next reviewer will have to rediscover the failure mode from first principles.

**Fix.** In the PR description, dedicate a one-paragraph "Bonus: active-pair glyph plumbing" section that names the bug (prop typed without `role`, never spread), names the fix file:line, names the integration test that surfaced it, and explicitly states the user-visible improvement: "council pairs now show the ☼/☽ glyph immediately on creation, not just after the next pair-event refresh." This is documentation-only; no code change. The integration test at `web/src/glyph-after-reload.test.tsx` already encodes the regression-prevention; the PR-body framing is what survives into release notes and future archaeology.

---

## Convention floor — no proposals

Council Mode convention floor (`AP-1..EC-13`) is already binding. No new UX conventions warranted from this review. The keystone refactor (single `buildBrowserGroupRecord` assembly site) is candidate for `AP-X` per the context brief's Phase 7 hook — that is structural / Fowler-domain, not UX.

---

## Summary

Five findings: one commendation (P3 anti-finding) anchoring the structural decision, one P3 advisory on loading-flash budget, one P2 on silent-error recovery via WS-reconnect re-fetch, one P3 documentation enhancement on the idempotency contract's producer-invariant dependency, one P3 PR-body framing of the active-pair glyph bonus fix. The PR closes a real and sustained UX defect with a discipline that matches the resilient-interface-patterns playbook. The remaining gaps are in resilience to the bootstrap's own failure mode (Finding 3) and in documentation of the contracts the slice now leans on (Findings 4 and 5).
