# React/Web UI Review — PR #68 (Council Mode REST bootstrap)

**Reviewer:** Dan Abramov (React/Web UI lens)
**Scope:** `web/src/App.tsx`, `web/src/store/council-slice.ts`, `web/src/components/ProjectGroup.tsx`, `web/src/api.ts`, `web/src/ws.ts`
**Branch:** `feat/council-mode-bootstrap-rest` against `origin/main`
**Verdict:** clean — no P1, no P2; three P3 observations worth noting for the record but none block merge

---

## Headline

The PR is a textbook expression of three React disciplines acting in concert: state minimization (live WS state is the source of truth; REST is just a bootstrap snapshot, never re-overwriting), server-client boundary clarity (one typed wire shape produced by `buildBrowserGroupRecord`, parsed against `GroupRecord` on the client; the boundary is named in `BrowserGroupRecord` and respected on both sides), and synchronization-thinking effects (the new `useEffect` keyed on `isAuthenticated` synchronises the council slice with the server's snapshot whenever the auth state changes, rather than running once-at-mount with stale-closure semantics). The idempotency contract in `hydrateGroups` is the load-bearing invariant — and it's both implemented and tested correctly. The `ProjectGroup` prop-plumbing fix is exactly the kind of bug the renderer's invariants would have surfaced earlier with a stricter typed `getCouncilInfo` callback signature; the widening + spread is correct and complete (the only two call sites — `ProjectGroup.tsx:112` and `Sidebar.tsx:216` — both spread `council.role` now).

---

## P3-1 — `useEffect` bootstrap re-fires on logout→re-login against retained council state

**Severity:** P3
**File:** `web/src/App.tsx:190-202` (paired with `web/src/store/auth-slice.ts:27-30`)

**Finding:** The new bootstrap effect's dependency array is `[isAuthenticated]`, so the effect re-runs every time the auth flag flips false→true. The `logout()` action only clears `authToken` + `isAuthenticated`; it does NOT clear the council slice (`groups`, `groupBySessionId`, `findings`, `groundingDowngrades`). On re-login, the bootstrap effect re-fires and re-hydrates on top of the prior session's residual state. The idempotency contract in `hydrateGroups` means this does not corrupt the store — incoming groups already present are skipped (live WS wins), and the no-mutation short-circuit at `council-slice.ts:276` preserves map identity so no spurious re-render fires. But groups that were ARCHIVED server-side during the logged-out interval still linger in the store as ghosts, because there's no "groups not in this snapshot get evicted" pass — the semantics are insert-only.

**Consequence:** A user who logs out, waits for an admin to archive a council pair, then logs back in will see the archived pair in their Sidebar with stale role glyphs until the next `group_exited` WS frame arrives (which it won't, because the group is already exited). Low-impact in practice because Aura is single-user single-machine; the issue would matter more in a multi-tenant deployment where logout means "different user logs in".

**Fix:** This is a property of the broader logout flow (`api.getSettings` at line 167-175 has the same shape — fires on auth flip with no clearing pass). Two options at the appropriate scope: (a) extend `logout()` to call a council-slice `clearAllGroups` action so re-login starts from a clean snapshot; (b) change `hydrateGroups` from insert-only semantics to "set this collection as authoritative" with explicit eviction of groups not in the snapshot. Option (a) is the simpler/safer one and matches the "live WS wins" contract — the post-login snapshot is the authoritative state of the world. Out of scope for this PR; surface as a follow-up.

---

## P3-2 — Bootstrap fetch is not cancellable; concurrent re-fires can race in resolution order

**Severity:** P3
**File:** `web/src/App.tsx:190-202`

**Finding:** The bootstrap effect's body fires `api.fetchGroups()` and uses no `AbortController` or `cancelled` flag in cleanup. If `isAuthenticated` flips true→false→true in rapid succession (e.g. a token-refresh path or a logout-relogin during the first request's flight), two `fetchGroups()` calls are in flight and either may resolve first. Both will call `hydrateGroups` on the global store. Because `hydrateGroups` is idempotent (skip on duplicate, no-op on empty), no state corruption occurs and no spurious re-render fires from the second resolution — but the fetch itself is wasted work, and a forensic `[app] fetchGroups bootstrap failed` warn may emit twice on a network-flake path. StrictMode in development also runs effects twice and triggers two fetches on first mount; the production runtime is single-fire.

**Consequence:** Cosmetic / debugging-noise only — `hydrateGroups` absorbs the redundancy cleanly. Worth tightening only if a future refactor changes `hydrateGroups` to non-idempotent semantics; the idempotency contract is the load-bearing protection here.

**Fix:** If tightening is desired later, the synchronization-discipline idiom is a `let cancelled = false` flag in the effect body, set on cleanup (`return () => { cancelled = true; }`), guarded inside the `.then` resolver. Matches the existing pattern at `App.tsx:139-149` (`getChangedFiles` cancel-flag). Out of scope for this PR — the idempotency makes it unnecessary today.

---

## P3-3 — `hydrateGroups` initialization-bucket parity drifts from `upsertGroup` if either is refactored

**Severity:** P3
**File:** `web/src/store/council-slice.ts:249-278` (paired with `:233-247`)

**Finding:** `hydrateGroups` and `upsertGroup` share the exact same group-insertion path (set the group record, set the two reverse-index entries, ensure findings + downgrades buckets exist). The two implementations are independently coded and structurally parallel; both must stay in lockstep. Today they agree, and `hydrateGroups`'s no-mutation short-circuit + duplicate-skip is a strict subset of `upsertGroup`'s overwrite-always behaviour — so the AP-3 "one assembly site" discipline that the server-side `buildBrowserGroupRecord` keystone enforces is not mirrored on the client. If a future change adds a new derived bucket (say, a new map keyed by `sessionGroupId` for some new feature), the maintainer must remember to thread it through BOTH `upsertGroup` and `hydrateGroups`.

**Consequence:** Coupling-by-convention rather than coupling-by-construction. The first miss ships a UI bug where REST-bootstrapped groups behave subtly differently from live-WS-arrived ones on the new feature. Low likelihood today, but the surface area is the bug shape this PR's server-side helper specifically avoided.

**Fix:** Extract a shared `insertGroupIntoCollections(groups, bySessionId, findings, downgrades, group)` helper that both actions call. The helper performs the four-map insertion atomically. `upsertGroup` always calls; `hydrateGroups` calls inside the `!groups.has(g.sessionGroupId)` branch. This mirrors the AP-3 discipline at the slice layer. Out of scope for this PR — the convention floor item (AP-X: multi-producer wire shapes route through one assembly site) is already a candidate Phase 7 promotion; the client-side analogue could be a sibling convention.

---

## Verified disciplines (no findings, recording the positive checks)

- **`useEffect` dependency array correctness** — `[isAuthenticated]` is the complete and correct dependency set. The effect body reads only `isAuthenticated` from React state and calls module-level `api.fetchGroups()` + `useStore.getState().hydrateGroups()`. No prop or state value is captured under a stale-closure. `App.tsx:190-202` passes the synchronization-thinking discipline cleanly.
- **No race with Sidebar's own selectors** — Sidebar does not poll for groups; it reads `useStore((s) => s.groupBySessionId)` and `useStore((s) => s.groups)` reactively. The bootstrap-effect dispatch and the live WS dispatch both flow into the same Zustand store; both selectors return new values on the same `set()` call, and Zustand 5's `useSyncExternalStore` integration with React 18's automatic batching produces ONE render per `set()` regardless of how many selectors are subscribed. Confirmed in `web/package.json:103` (`"zustand": "^5.0.0"`).
- **Reference-preservation logic on no-op path** — `council-slice.ts:253` (empty input short-circuit returning `{}`) and `council-slice.ts:276` (all-duplicate short-circuit returning `{}`) both correctly avoid creating new `Map(s.groups)` copies that would change reference identity and re-render every council-state subscriber. Zustand's `set({})` semantics — empty patch is a no-op for shallow-equality subscribers — is the load-bearing invariant; honoured here.
- **`ProjectGroup` callback widening is non-breaking** — The original signature was `{ pairing?, unreadStops? }`; the widened signature is `{ pairing?, unreadStops?, role? }`. Both extant call sites in the codebase (`Sidebar.tsx:790,805,820,847` plus the internal `CollapsibleSessionList` at `Sidebar.tsx:180`) construct via `councilInfoFor()` which returns the full triple. There are no consumers that destructure `{ pairing, unreadStops }` while spreading rest — `git grep` confirms only the two assignment-style consumers. The widening is purely additive; no caller misses the new field.
- **Defensive `data.status ?? "active"` fallback in `ws.ts:1194`** — Server-side change is additive (the `status` field is required in the new wire variant, always emitted via the helper). The fallback is structurally unreachable today but valuable for buffered messages crossing a redeploy boundary. Belt-and-braces; correct.
- **Idempotency-against-present-groups test coverage** — `council-slice.test.ts:236-274` ("does NOT overwrite groups already in the store — live WS wins") pins the load-bearing invariant explicitly, including the asymmetric runtime fields (`lastCheckpointAt`, `observerReviewing`, `lastCheckpointSeq`) that REST does NOT carry. `council-slice.test.ts:296-303` ("empty input is a true no-op") and `council-slice.test.ts:305-312` ("input where every group is already present is a true no-op") both assert `expect(after.groups).toBe(before.groups)` — exact reference-identity preservation, the right shape for testing the no-op contract. `council-slice.test.ts:330-385` (hydrate-then-WS sequence test) covers the realistic mount ordering and confirms no double-insert or role swap.
- **Integration regression test exercises full reactive chain** — `glyph-after-reload.test.tsx:180-251` covers the bug state, the fix state, AND the realistic mid-render hydrate arrival. The last test in particular is the canary that catches the renderer's invariants: a hydrate dispatched while the Sidebar is already mounted MUST trigger re-render, which it does via the Zustand selector subscription. The rendering-mental-model discipline is honoured.

---

## Notes on the carry-forward `deadRole` gap

The context brief flagged that `GroupRecord` doesn't persist `deadRole`, so a reload during a degraded pair would lose deadRole context. From the React-UI lens: the `BrowserGroupRecord` wire shape DOES carry `deadRole?` (`session-types.ts:577`), but `buildBrowserGroupRecord` at `browser-group-record.ts:50-58` doesn't populate it. The frontend defaults to `"observer"` in the panel-state deriver via `?? "observer"`. This is the right place to fix it — extend the helper's input parts to optionally carry `deadRole`, and have `getAllGroupsForBootstrap` pull it from the coordinator's degraded-state context if present. Out of PR #68 scope as the brief confirms; recording the React-side observation for the follow-up.

---

## Summary

Zero P1 / P2. Three P3 observations all about the broader logout/cancellation/AP-3-on-client patterns, none of which this PR introduces or worsens. The PR ships a structurally-honest server-client boundary (one wire shape, one helper, parsed against a typed contract), a correctly-idempotent dispatch (with reference-preservation on the no-op path), and a complete prop-plumbing fix surfaced by integration test discipline. The renderer's invariants are respected throughout.
