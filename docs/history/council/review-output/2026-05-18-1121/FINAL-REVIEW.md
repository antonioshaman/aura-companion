# Council Review (Aura): PR #68 — `feat/council-mode-bootstrap-rest`

**Scope:** branch diff `origin/main..HEAD` (6 commits, 20 files, +1156 −21). Closes `BUG-council-mode-group-rest-bootstrap-gap.md` end-to-end.
**Context:** Adds `GET /api/groups` REST bootstrap so the browser repopulates `groupBySessionId` on mount; refactors the three independent `group_created` producers (live push, REST snapshot, ws-bridge synthetic hydration) to share one assembly helper (`buildBrowserGroupRecord`); plumbs `councilRole` through `ProjectGroup.tsx` so active-pair glyph render lands end-to-end for the first time.
**Council dispatched:** Hunt, Fowler, dahl, ritchie, abramov (React/UI), watson (a11y), saarinen, friedman, willison, beck. hashimoto skipped (no DevOps surface touched).

---

## P1 — Fix Now

_No P1 findings. Six commits, ten experts, zero blockers._

---

## P2 — Fix Soon

### 1. Buffered legacy `group_created` frames replay without `status` after server upgrade

| | |
|---|---|
| **File** | `web/server/session-types.ts:411`, `web/src/ws.ts:1180-1224` |
| **Council** | dahl × Carmack — Protocol drift / Wire-shape additive-migration |
| **Ref** | `references/dahl.md` → B7 (Protocol drift on switch defaults) + Principle on additive wire migrations |

**Finding:** The session event buffer is persisted (`session-store.ts:39 — eventBuffer?: BufferedBrowserEvent[]`) and rehydrated on restart (`ws-bridge.ts:375`). A pre-PR-#68 server that buffered a `group_created` frame, then upgrades onto this PR's code, will replay that legacy frame (no `status` field) to the reconnecting browser inside an `event_replay` envelope. The new wire variant declares `status` REQUIRED, contradicting the runtime payload. The JSDoc at `ws.ts:1190-1193` calls the client-side `?? "active"` fallback "structurally unreachable" — wrong; it IS reachable for exactly the cross-version replay scenario.

**Consequence:** Wire contract violated at runtime during the upgrade window. A future cleanup pass reading "structurally unreachable" will likely delete the fallback; the next legacy-replay window then stores a malformed `GroupRecord` with `status: undefined`.

**Fix:** Mirror the Task 9 precedent established for `wakeTimeoutMs?` (`session-types.ts:421-426`): make `status` OPTIONAL on the `group_created` wire variant, and rewrite the `ws.ts` comment to call the fallback a real legacy-replay safety net (not unreachable). One `?` in the type + one rewritten paragraph.

---

### 2. App.tsx bootstrap useEffect — the chain motivating this PR — has no end-to-end test

| | |
|---|---|
| **File** | `web/src/App.tsx:190-202`, `web/src/App.test.tsx:96` |
| **Council** | beck × Carmack — Call-site-presence canary (untested wiring) |
| **Ref** | `references/beck.md` → empirical test discipline / reachability gaps |

**Finding:** The bootstrap chain is `isAuthenticated → useEffect → api.fetchGroups → useStore.getState().hydrateGroups`. Every link is individually covered (api unit / reducer unit / integration calls `hydrateGroups` directly), but the bridging `useEffect` has no test. `App.test.tsx` only adds `fetchGroups: vi.fn().mockResolvedValue({groups: []})` so existing render tests don't break — no assertion that `fetchGroups` was called, no assertion that the store receives the result. The integration test in `glyph-after-reload.test.tsx` bypasses App.tsx entirely.

**Consequence:** A future refactor that drops the bootstrap useEffect, changes its deps to a stale value, or accidentally gates it behind another condition will type-check and pass every existing test — silently re-opening `BUG-council-mode-group-rest-bootstrap-gap.md` in production. Canonical `feedback_call_site_presence_not_just_symbol_export` shape.

**Fix:** Add one test to `App.test.tsx`: render `App` in an authenticated state, await microtasks, assert (a) `mockApi.fetchGroups` called once, (b) the store's `groups` map contains the mock-returned record. ~15 lines. Do NOT widen the integration test to mount App — its job is store ↔ Sidebar.

---

### 3. ProjectGroup.tsx modified without sibling `.test.tsx` (CLAUDE.md mandate violation)

| | |
|---|---|
| **File** | `web/src/components/ProjectGroup.tsx:13-18, 120-123` (no test file present) |
| **Council** | watson × Carmack — Component-modification test mandate |
| **Ref** | `references/watson.md` → §B WCAG operationalization + CLAUDE.md test-mandate gate |

**Finding:** CLAUDE.md states: "Every new or modified frontend component in `web/src/components/` must have an accompanying `.test.tsx` file with at minimum: a render test, an axe accessibility scan (`toHaveNoViolations()`), and tests for any interactive behavior." `ProjectGroup.tsx` was modified in this PR (signature widened, new `councilRole` prop spread to `SessionItem`), and `web/src/components/ProjectGroup.test.tsx` does not exist. The behaviour ("given `getCouncilInfo` returns a role, that role reaches SessionItem") is enforced only transitively through `glyph-after-reload.test.tsx`.

**Consequence:** Future regressions to ProjectGroup that silently drop the `councilRole` spread (same bug class this PR closes) would not trigger a component-scoped failure. The integration test does catch it today, but at a wider blast radius and slower bisect.

**Fix:** Add `web/src/components/ProjectGroup.test.tsx`: (a) mock `getCouncilInfo` returning `{role: "orchestrator", pairing: "claude+codex"}` → assert glyph + suffix testids render; (b) symmetric observer case; (c) `getCouncilInfo` returns `undefined` → assert glyph + suffix branch skipped; (d) `toHaveNoViolations()` axe scan.

---

### 4. `?? "claude"` defensive fallback duplicated at two of three helper call sites

| | |
|---|---|
| **File** | `web/server/session-orchestrator.ts:1209,1213`, `web/server/ws-bridge.ts:1289,1293` |
| **Council** | Fowler × Carmack — Feature Envy / Duplicated Logic across helper consumers |
| **Ref** | `references/fowler.md` → P-1 (Duplicated logic across call sites of an extracted helper) |

**Finding:** The pre-refactor pairing-label assembly carried both field-selection AND a defensive fallback for "launcher hasn't propagated backendType yet". The refactor pulled field-selection into `buildBrowserGroupRecord` but left the `?? "claude"` fallback duplicated at the push listener and ws-bridge synthetic hydration call sites. The third site (REST bootstrap) doesn't need the fallback because coordinator records guarantee `backendType`. The helper's contract is now an implicit "caller MUST resolve fallback" — a documentation invariant, not a type-system one.

**Consequence:** A fourth producer added six months from now will likely replicate the bug-class the helper was extracted to prevent — either omit the fallback (producing `pairing: "undefined+undefined"`) or replicate the literal `"claude"`, drifting if the safe-default ever changes.

**Fix:** Widen `BrowserGroupRecordParts` to accept `backendType: BackendType | undefined` and apply the `?? "claude"` inside the helper with JSDoc explaining it covers launcher-propagation-lag. Eliminates the duplication AND the inline `as BackendType` casts at the call sites (Fowler P3-4 collapses into this fix).

---

### 5. Silent error handling on `fetchGroups` failure has no user-discoverable recovery

| | |
|---|---|
| **File** | `web/src/App.tsx:194-201`, `web/src/ws.ts` (reconnect handler) |
| **Council** | friedman × Carmack — Resilient interface patterns (error state as one of five required surfaces) |
| **Ref** | `references/friedman.md` → §B resilient interface patterns / anti-pattern "action-failed errors swallowed" |

**Finding:** When `fetchGroups` rejects (network blip, server 500, auth refused), the code logs to `console.warn` and returns. The user sees nothing. The Sidebar continues to render council pairs without their glyph/suffix — i.e. the exact bug PR #68 closes, re-manifested for the failure regime. The comment "live WS events still arrive on the next group_* frame" is TRUE for pairs that produce future events, but FALSE for an active idle pair — exactly the case where the bootstrap is the only signal the user gets.

**Consequence:** On a flaky network, the user reloads, sees their council pair lose its role identity, has no signal anything failed, has no way to retry, and will assume the council feature is broken.

**Fix:** Dispatch the same `fetchGroups → hydrateGroups` pipeline on every successful WebSocket reconnect (the WS client at `web/src/ws.ts` already detects reconnect). Reconnect implies the WS was down, which is a strong correlated signal that the original bootstrap fetch might have failed in the same blip. `hydrateGroups` is idempotent — this cannot double-insert.

---

## P3 — Consider

### 6. Single-tenant invariant load-bearing for the snapshot helper but undocumented at the call site

| | |
|---|---|
| **File** | `web/server/session-orchestrator.ts:2972-2991`, `web/server/session-group-coordinator.ts:498-504` |
| **Council** | Hunt × Carmack — Forward-looking blast-radius hygiene |

`getAllGroupsForBootstrap` returns every live group across the process; correct under Aura's current single-tenant contract (same posture as `GET /api/sessions`). If a future multi-operator deployment lands without retrofitting a tenant filter, this endpoint becomes a forensic enumeration disclosure of operator-B's pair metadata to operator-A. Add an inline `// SINGLE-TENANT INVARIANT:` comment at both `getAllGroupsForBootstrap` and `coordinator.listAll` so the next reviewer cannot miss it.

---

### 7. Codify the "prompt-provenance fields stay out of the wire shape" invariant on the helper

| | |
|---|---|
| **File** | `web/server/browser-group-record.ts:1-58` |
| **Council** | willison × Carmack — Structured outputs / parse-or-fail boundary |

`buildBrowserGroupRecord` is now the natural site a future contributor reaches for to add a new field (e.g. "Sidebar: show which prompt version is active"). The current PR carries zero prompt-provenance fields, but the convention isn't codified. Add a one-line comment "Forbidden fields: observerPromptSha256, observerPromptSource, observerProvider, observerModel — prompt and model provenance stay server-side per the observer-spawn isolation contract (EC-1)" plus a producer-side test asserting the exact set of helper output keys, so a future field addition mechanically fails CI.

---

### 8. Suffix + glyph + asymmetric provider chip triple-encode role on `claude+codex` pairs

| | |
|---|---|
| **File** | `web/src/components/SessionItem.tsx:260-333` |
| **Council** | saarinen × Carmack — Visual hierarchy discipline (separate levers, separate semantics) |

After this PR's `ProjectGroup` plumbing fix, an active orchestrator in a `claude+codex` pair renders three signals for the same semantic: amber ☼ glyph, `" · orchestrator"` suffix, and the asymmetric CODEX provider chip (whose presence-by-side encodes role). PR #61's ProviderBadges design intent is the chip; Item 17 (2026-05-15) added glyph+suffix BEFORE PR #61. Now all three ship together on the same row. Decide which signal owns the semantic and demote the other two — saarinen's recommendation is to make the suffix `sr-only` (a11y intact, visual decluttered) and let the glyph + chip carry the visible role distinction. Worth raising for next-iteration polish; not introduced by this PR.

---

### 9. Meta-row chip cluster has grown to 5 potential elements on 260px sidebar

| | |
|---|---|
| **File** | `web/src/components/SessionItem.tsx:282-343` |
| **Council** | saarinen × Carmack — Low-friction workflows |

BackendBadge + Docker icon + cron icon + provider chip + unread count can all co-occur on the meta row. At default 260px sidebar width, the cwd (which the user reads to disambiguate same-named sessions across projects) gets pushed below the visibility floor on containerized council pairs. Cap the chip cluster with a `max-w-[120px] overflow-hidden` and overflow-tooltip the hidden chips. Doesn't change semantics; recovers cwd readability. Not strictly a PR #68 fix — chips pre-date it — but this PR makes the row crowding a daily case rather than an edge.

---

### 10. Integration test asserts visual-channel only; accessible-text channel uncovered

| | |
|---|---|
| **File** | `web/src/glyph-after-reload.test.tsx:213-227` |
| **Council** | watson × Carmack — Assistive-technology coverage |

The test queries the role suffix via `getAllByTestId("council-role-suffix")` and asserts on `el.textContent` — both visual-channel reads. The glyph is `aria-hidden="true"` by design (decorative); the SIBLING suffix is the load-bearing accessible-name carrier. If a future refactor wrapped the suffix in `aria-hidden`, `textContent` would still pass and the screen-reader regression would ship. Add a parallel `screen.getByText(/· orchestrator/i)` accessible-query assertion alongside the testid query.

---

### 11. `deadRole` not on `GroupRecord` — bootstrap mislabels which half died on reload

| | |
|---|---|
| **File** | `web/server/session-group-coordinator.ts:93-105`, `web/server/browser-group-record.ts:50-58` |
| **Council** | ritchie + Hunt + willison × Carmack — Truthfulness of the snapshot response |

The `BrowserGroupRecord` interface optionally types `deadRole?`, the `group_degraded` live push correctly populates it, but `GroupRecord` itself doesn't persist it. A browser reloading mid-`degraded` pair sees `status: "degraded"` without `deadRole`; the frontend defaults to `?? "observer"` — mislabels the surviving half when the orchestrator died. Live `group:degraded` push corrects it within seconds of reload. Carry-forward from validator reports; the fix is to add `deadRole?` to `GroupRecord`, set it on the `degraded` transition, forward through `buildBrowserGroupRecord`. Out of PR #68 scope but worth filing as a follow-up.

---

### 12. `getAllGroupsForBootstrap` conceptually belongs nearer the coordinator

| | |
|---|---|
| **File** | `web/server/session-orchestrator.ts:2972-2991` |
| **Council** | Fowler × Carmack — Misplaced Method |

The 3353-line orchestrator god-module pre-dates this PR. The new method has zero behavioural ties to the orchestrator's responsibilities — pure data fan-in over `coordinator.listAll()`. Lives there for the legit "REST talks to orchestrator" convention. When a second bootstrap-shaped method lands (deadRole repair, archived-window snapshot), promote to a focused `council-bootstrap.ts` next to `browser-group-record.ts`. §A economic-refactor frame says: leave it until then.

---

### 13. Cross-site parity test covers only `claude+codex`, not the common `claude+claude` case

| | |
|---|---|
| **File** | `web/server/session-orchestrator.test.ts:3879-3909` |
| **Council** | beck × Carmack — Empirical test design |

The keystone-invariant cross-site parity test seeds `claude+codex`. The structural-keys canary in `browser-group-record.test.ts` partially covers `claude+claude` but doesn't compare across producers. Either add a second cross-site parity test for `claude+claude` (~20 lines), or extend the existing test to seed two groups (one of each pairing) and run the parity loop twice. Option B is fewer lines and matches realistic production state (multiple groups, mixed pairings).

---

### 14. Bootstrap useEffect re-fires on logout→re-login against retained council state

| | |
|---|---|
| **File** | `web/src/App.tsx:190-202`, `web/src/store/auth-slice.ts:27-30` |
| **Council** | abramov × Carmack — Synchronization-thinking effects |

`logout()` clears auth but not the council slice. On re-login the bootstrap re-fires; `hydrateGroups` idempotency protects from corruption but groups archived during the logout interval linger as ghosts. Single-user-single-machine deployment makes this low-impact today. If multi-tenant ever lands: extend `logout()` to call a council-slice `clearAllGroups` action, OR change `hydrateGroups` to "set this collection as authoritative" with explicit eviction. Out of PR #68 scope.

---

### 15. `status: "active"` literal at two of three call sites is a load-bearing unguarded invariant

| | |
|---|---|
| **File** | `web/server/session-orchestrator.ts:1215`, `web/server/ws-bridge.ts:1298` |
| **Council** | Fowler × Carmack — Parameter-is-constant smell with comment-anchored invariant |

The push listener and ws-bridge synthetic hydration both pass `status: "active"` because they only fire when the group is active. Defensible and well-commented today. If a future change adds a state-machine reconnect transition that re-fires the push, the literal `"active"` will lie. Pair this with an EC-6-style canary test on the push listener verifying it only fires on `pairing → active` and `reconnecting → active` transitions, so a future regression trips a test rather than a runtime mis-label.

---

## Summary

| # | Finding | Severity | Council | Fix effort |
|---|---------|----------|---------|------------|
| 1 | Buffered legacy `group_created` replay missing `status` | P2 | dahl | 2 lines (`?` in type) |
| 2 | App.tsx bootstrap useEffect untested | P2 | beck | ~15 lines (one test) |
| 3 | ProjectGroup.test.tsx missing (CLAUDE.md mandate) | P2 | watson | ~40 lines (new test file) |
| 4 | `?? "claude"` fallback duplicated at 2 of 3 call sites | P2 | Fowler | ~5 lines (helper internalises) |
| 5 | `fetchGroups` failure has no recovery path | P2 | friedman | ~10 lines (WS-reconnect refetch) |
| 6 | Single-tenant invariant undocumented | P3 | Hunt | 2 lines (comment) |
| 7 | Prompt-provenance forbidden-fields invariant uncodified | P3 | willison | ~10 lines (comment + test) |
| 8 | Triple-encoding of role on claude+codex rows | P3 | saarinen | design review |
| 9 | Meta-row chip overflow on narrow widths | P3 | saarinen | ~3 lines (max-w) |
| 10 | Integration test misses accessible-text channel | P3 | watson | ~2 lines (extra query) |
| 11 | deadRole not on GroupRecord — bootstrap mislabel | P3 | ritchie+Hunt+willison | follow-up PR |
| 12 | getAllGroupsForBootstrap misplaced | P3 | Fowler | defer until 2nd consumer |
| 13 | Cross-site parity test covers only claude+codex | P3 | beck | ~20 lines |
| 14 | Bootstrap re-fires on re-login against ghosts | P3 | abramov | follow-up |
| 15 | `status: "active"` literal unguarded at 2 sites | P3 | Fowler | ~15 lines (canary test) |

**Totals: 0 P1, 5 P2, 10 P3.**

## Verdict

The PR is shipping-quality. Six commits including two validator-mandated amendments and one integration-test-driven bonus fix. Zero P1. The single most important thing to address before push is **finding 1 (dahl — buffered legacy replay)**: a two-line type change that mirrors the established Task 9 precedent and protects against an upgrade-window mislabel. The next two — **finding 2 (beck — App.tsx useEffect untested)** and **finding 3 (watson — ProjectGroup.test.tsx missing)** — are project-policy obligations rather than runtime bugs but are similarly cheap (~15 + ~40 lines).

The keystone refactor — three producers funnelled through `buildBrowserGroupRecord` — is the structurally strongest piece of work in this PR. dahl called it "the cleanest version of the multi-producer-fan-in pattern I have seen on this codebase". It deserves promotion to a convention (Phase 7 candidate).

The council member whose domain was most critical here was **dahl (Bun + NDJSON/WS Protocol)** — the only one who caught that the eventBuffer is persisted and that the wire-variant migration silently breaks the Task 9 precedent. Carmack would say: keep the parts of the change that close the bug, fix the type-vs-runtime contradiction before push, and don't ship the misleading "structurally unreachable" comment.

---

## Findings Breakdown by Expert

| Expert | P1 | P2 | P3 | Total | Key Areas |
|--------|----|----|----|----|-----------|
| Hunt (Security) | 0 | 0 | 1 | 1 | single-tenant invariant |
| Fowler (Refactoring) | 0 | 1 | 2 | 3 | helper fallback dup, status literal, misplaced method |
| dahl (Bun/NDJSON/WS) | 0 | 1 | 0 | 1 | buffered replay wire shape |
| ritchie (§A+§B Unix) | 0 | 0 | 0.5 | 0.5 | deadRole carry-forward (shared) |
| abramov (React/UI) | 0 | 0 | 1 | 1 | re-login ghost state |
| watson (a11y) | 0 | 1 | 1 | 2 | ProjectGroup test missing, integration test query |
| saarinen (UI Quality) | 0 | 0 | 2 | 2 | triple-encoding, chip overflow |
| friedman (UX Quality) | 0 | 1 | 0 | 1 | WS-reconnect re-fetch recovery |
| willison (LLM Pipeline) | 0 | 0 | 1 | 1 | prompt-provenance invariant codification |
| beck (Test Quality) | 0 | 1 | 1 | 2 | App useEffect untested, parity test coverage |
| **TOTAL** | **0** | **5** | **~10** | **15** | |

**Review output written to:** `.council/review-output/2026-05-18-1121/FINAL-REVIEW.md`

**Expert output files:**
- Hunt: `.council/review-output/2026-05-18-1121/hunt.md`
- Fowler: `.council/review-output/2026-05-18-1121/fowler.md`
- dahl: `.council/review-output/2026-05-18-1121/dahl.md`
- ritchie: `.council/review-output/2026-05-18-1121/ritchie.md`
- React/Web UI (abramov): `.council/review-output/2026-05-18-1121/react-ui.md`
- a11y (watson): `.council/review-output/2026-05-18-1121/a11y.md`
- saarinen: `.council/review-output/2026-05-18-1121/saarinen.md`
- friedman: `.council/review-output/2026-05-18-1121/friedman.md`
- willison: `.council/review-output/2026-05-18-1121/willison.md`
- beck: `.council/review-output/2026-05-18-1121/beck.md`
