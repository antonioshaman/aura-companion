# BUG: Council Mode group records not bootstrapped on browser reload — no ☼/☽ glyphs after reload

> **RESOLVED in PR #68** (`feat(council): REST bootstrap for Sidebar glyph after browser reload`, 2026-05-18) — `GET /api/groups` REST endpoint + App.tsx bootstrap `useEffect` chain (`isAuthenticated → fetchGroups → hydrateGroups`). Glyphs now render on browser reload across all Council pair sessions. See PR diff and `CLOSURE-council-mode-v2.md` for the operator-decided path. Note: this BUG doc recommends Path A (enrich `/api/sessions`) but the operator picked **Path B** (dedicated `/api/groups` endpoint with shared `buildBrowserGroupRecord` helper) per `CLOSURE-council-mode-v2.md` — that tradeoff (one new endpoint vs. mutating an existing one) was preferred for shape-isolation between sessions and groups.

**Reported:** 2026-05-17 (operator session, repro on razumai_space_bot pair and brahmanos pair)
**Severity:** P0 (sibling of `BUG-council-mode-spawn-failure-resume-empty-state.md`, different mechanism)
**Symptom:** Council Mode pair sessions in the Sidebar do NOT show the ☼/☽ glyph + " · orchestrator" / " · observer" suffix after a browser reload (or sometimes on first creation), even though commit `ec93eab feat(sidebar): council role decoration on session rows` is in production.

## Root cause (verified via REST + source grep)

The Sidebar renders the glyph via:
```ts
// Sidebar.tsx:228
<SessionItem councilRole={council.role} ... />

// councilInfoFor:
let role: "orchestrator" | "observer" | undefined;
if (group.primarySessionId === sessionId) role = "orchestrator";
else if (group.observerSessionId === sessionId) role = "observer";
```

`SessionItem` renders the glyph iff `councilRole` is truthy:
```tsx
// SessionItem.tsx:260
{councilRole && (
  <span data-testid="council-role-glyph" ...>
    {councilRole === "orchestrator" ? "☼" : "☽"}
  </span>
)}
```

The `group` record (with `primarySessionId` + `observerSessionId`) is populated in the browser's Zustand store EXCLUSIVELY by the `group:created` event handler (`web/src/store/council-slice.ts:223`):

```ts
case "group:created":
  groupBySessionId.set(group.primarySessionId, group.sessionGroupId);
  groupBySessionId.set(group.observerSessionId, group.sessionGroupId);
```

**There is NO REST endpoint to fetch groups on browser load.** Verified:
- `GET /api/groups` → 404
- `GET /api/session-groups` → 404
- `grep -rn "fetchGroups\|fetchSessionGroups\|loadGroups\|api/groups\|api/session-groups" web/src/` returns ZERO hits.

The `/api/sessions` response DOES include `sessionGroupId` and `sessionGroupRole` per-session (verified live for razumai_space_bot pair `grp_858cbe82...`), but the **group record itself** (with paired sibling sessionIds) is server-side only.

## Sequence that produces the bug

1. User creates Council Mode pair → server emits `group:created` event with full group record (primarySessionId, observerSessionId, sessionGroupId).
2. The event reaches the browser **only if** the browser's WS is connected at emit time. If the browser reloads after pair creation, OR if the WS was momentarily disconnected during create, the `group:created` event is lost (`feedback_create_event_broadcast_races_client_connect`).
3. On reload, browser fetches `/api/sessions` (gets sessions with `sessionGroupId` references) but has no path to fetch the group record.
4. `councilInfoFor(sessionId)` → looks up `group` in `groupBySessionId` map → not found → returns `role: undefined`.
5. `SessionItem` receives `councilRole={undefined}` → `{councilRole && (...)}` falsy → glyph not rendered.
6. UI shows session pair without the decoration the spec mandates.

This is also why the right-pane Observer panel shows "Awaiting first checkpoint" with no group context — the panel cannot derive the pair shape from the browser store.

## Fix shape (3 paths)

**Path A — add group records to `/api/sessions` response (smallest change, preferred):**
- In `routes.ts` `GET /api/sessions`, for each session with a `sessionGroupId`, enrich the session record with `primarySessionId` + `observerSessionId` + the full group record fields needed by the Sidebar.
- Browser's existing reload bootstrap (which already fetches sessions) becomes sufficient — no new endpoint needed.
- One server-side change, one client-side change (derive group records from session list on bootstrap).

**Path B — add dedicated `GET /api/groups` endpoint:**
- New endpoint returns all active groups with full records.
- Browser fetches it on init alongside `/api/sessions`.
- Cleaner semantically (groups are first-class), but more surface area + two-fetch race possible.

**Path C — server-side reconcile on WS connect:**
- When browser WS connects, server replays `group:created` events for all live groups.
- Costlier (replay on every reconnect), and depends on browser state machine handling replay correctly.

**Recommendation:** Path A. ~5-line server change + ~10-line client change.

## Files to change (Path A)

- `web/server/routes.ts` — enrich `/api/sessions` response with per-session group fields (or include a top-level `groups` array in the response).
- `web/server/session-types.ts` — extend the wire shape if needed.
- `web/src/store/council-slice.ts` — derive group records from session list bootstrap.
- Regression test: integration test that creates a council pair, reloads, asserts the glyph renders on both halves.

## Cross-reference

- Spawn-side deadlock: `BUG-council-mode-spawn-failure-resume-empty-state.md` (observer cliSessionId=null on `--print` mode, server-side wake-zero needed).
- This bug: client-side bootstrap gap (group records not derivable from REST on reload).
- Both are P0; fix together in a single hotfix sprint if scoped to one branch (`fix/council-mode-bootstrap`), OR sequentially in two branches.

## Live evidence preserved

- razumai_space_bot pair `grp_858cbe82...` showed both halves connected, orchestrator with `cliSessionId=7b270ba7...`, observer with `cliSessionId=null` (combination of BOTH P0s on the same pair).
- Sidebar UI for the same pair: no ☼/☽ glyphs (this bug — group not bootstrapped).
- Bundle `web/dist/assets/index-Bc7_lLt9.js` rebuilt 2026-05-17 23:07 with `councilRole` + glyph code present — code is shipped, bootstrap is missing.

## Tracking

P0 hotfix scope. Phase 3β session should start with BOTH this bug AND the spawn-deadlock bug as the first user-visible failures to close. Estimated combined fix ≤4h in dedicated tmux worktree with regression tests for both.
