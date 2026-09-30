# Context Brief for Aura Council Review — PR #68

**Branch:** `feat/council-mode-bootstrap-rest`
**Base:** `origin/main` (`d2324e9`)
**Scope:** branch diff (20 files, +1156 −21)
**Timestamp:** `2026-05-18-1121`

## What this code does

Adds a `GET /api/groups` REST bootstrap endpoint for Council Mode pair sessions so the browser can repopulate its `groupBySessionId` map on app mount — closes `BUG-council-mode-group-rest-bootstrap-gap.md`, where the Sidebar ☼/☽ glyph + `· orchestrator`/`· observer` suffix failed to render after browser reload because the live `group:created` WS push was the ONLY source of group records in the store. Six commits across server (coordinator → orchestrator wrapper → REST route), shared producer helper, and browser (api → council-slice → App.tsx mount bootstrap + integration test).

## Architecture

- **Server side (web/server):**
  - `session-group-coordinator.ts` — gains a `listAll(): GroupRecord[]` snapshot primitive
  - `session-orchestrator.ts` — gains `getAllGroupsForBootstrap(): BrowserGroupRecord[]`; the existing live `group:created` listener and the new REST bootstrap both route through the new shared helper
  - `browser-group-record.ts` (NEW) — `buildBrowserGroupRecord(parts)` is the single construction site for the `BrowserGroupRecord` wire shape across all three producers
  - `ws-bridge.ts` — `deriveGroupCreatedForBrowser` (PR #61 synthetic hydration on browser WS open) refactored to use the same helper
  - `routes.ts` — new `api.get("/groups", ...)` returning `{groups: [...]}`
  - `session-types.ts` — adds `BrowserGroupRecord` exported interface; `group_created` wire variant gains a required `status` field
- **Browser side (web/src):**
  - `api.ts` — new `fetchGroups(): Promise<{groups: GroupRecord[]}>`
  - `store/council-slice.ts` — new `hydrateGroups(groups)` idempotent action (live WS wins for already-present groups)
  - `App.tsx` — new `useEffect` keyed on `isAuthenticated` dispatching `fetchGroups → hydrateGroups`
  - `components/ProjectGroup.tsx` — widens `getCouncilInfo` signature to include `role`; plumbs `councilRole={council.role}` to `SessionItem` (closes an active-session glyph plumbing gap that pre-dated this PR)
  - `ws.ts` — `case "group_created"` now reads `data.status ?? "active"`
- **Tests:** producer-side unit tests, REST route tests, browser-side store tests including hydrate-then-WS sequence regression, plus a new cross-cutting integration test that exercises the full store → Sidebar → SessionItem reactive chain.

## Stack in use within scope

- **Bun/Hono:** new REST route on the existing api.route("/api", ...) mount
- **WebSocket NDJSON:** unchanged; the live push listener path is refactored to use the same helper, no protocol change beyond the additive `status` field on `group_created`
- **Filesystem JSON persistence:** unchanged (no new persistence sites)
- **Subprocess:** unchanged
- **React 19 + Zustand 5:** new slice action, new useEffect, no new components
- **A11y:** Sidebar tests + new integration test both render with axe-aware test infrastructure (no new components, no new aria patterns)
- **Vitest:** +6 new test files / additions; full suite 6402 → 6413 (+11 net across the 6 commits)
- **Auth:** new REST endpoint inherits the `/api/*` middleware (same as `GET /api/groups/:groupId/findings` from PR #61)

## Key observations

- The PR went through 4 atomic commits + 2 validator-mandated amendments (C1.1 mapper drift, C3.1 hydrate-then-WS sequence test) + 1 integration-test-driven bonus fix (ProjectGroup councilRole plumbing). Each had a validator brief and pass.
- Three independent producers of the `group_created` wire shape now share ONE assembly helper (`buildBrowserGroupRecord`). This is the keystone refactor — it makes drift mechanically impossible across the live push, the REST bootstrap, and the ws-bridge synthetic hydration.
- The PR is feature-additive on the server: no protocol-breaking change (the new `status` field on `group_created` is required server-side but the helper guarantees it's always emitted). Frontend defensively falls back to `"active"` for buffered legacy frames.
- Bonus bug: `ProjectGroup.tsx` had been silently dropping `councilRole` since its introduction — typed it as `{pairing?, unreadStops?}` (no role) and never spread the prop to SessionItem. Active-session pairs (the most common case) thus NEVER rendered the glyph regardless of bootstrap. The integration test surfaced this; +7/−2 fix lands the active path end-to-end for the first time.
- Carry-forward findings from validator reports (informational, not blocking):
  - **deadRole gap** — `GroupRecord` doesn't persist `deadRole`; bootstrap can't supply it. Frontend defaults to `"observer"` via `?? "observer"` in panel-state deriver. A reload during a degraded-orchestrator pair would mislabel the dead half. Out of PR #68 scope.
  - **Cross-site parity test only covers push vs REST** (not ws-bridge:1289 directly). Helper-determinism + structural-keys canary cover it indirectly.
  - **Auth enforced transitively** through `/api/*` middleware mount — no per-route check.

## Automated check results

- `bun run typecheck` — **clean** (`tsc --noEmit` exited zero).
- `bun run test -- --run` — **Test Files 249 passed (249); Tests 6413 passed | 4 skipped (6417)**. All 4 skipped are pre-existing.
- `bun run test:a11y` — **38 a11y files passed; 64 a11y tests passed** (211 non-a11y files correctly skipped).

No pre-existing failures. All gates green at HEAD `8f3e675`.

## Domain File Assignments

(Active assignments only — every file appears in ≥1 domain. Tests assigned to Beck plus the relevant production-side expert.)

- **Hunt (Security):** `web/server/routes.ts` (auth surface for new endpoint), `web/server/session-orchestrator.ts` (snapshot leak risk?), `web/server/browser-group-record.ts` (wire shape).
- **Fowler (Refactoring):** `web/server/browser-group-record.ts`, `web/server/session-orchestrator.ts` (delta), `web/server/ws-bridge.ts` (delta), `web/server/session-group-coordinator.ts` (delta), `web/server/session-types.ts`, `web/src/store/council-slice.ts`.
- **dahl (Bun + NDJSON/WS Protocol):** `web/server/ws-bridge.ts` (refactor of synthetic hydration), `web/server/session-types.ts` (wire variant `status` field addition), `web/src/ws.ts` (client dispatch with `?? "active"` fallback), `web/server/routes.ts`.
- **ritchie (Unix-discipline — §A Process / §B FS):** `web/server/session-orchestrator.ts` (coordinator-aware bootstrap), `web/server/session-group-coordinator.ts` (snapshot semantics), `web/server/browser-group-record.ts`.
- **abramov (React/Web UI):** `web/src/App.tsx` (useEffect on auth), `web/src/store/council-slice.ts` (hydrateGroups), `web/src/components/ProjectGroup.tsx` (prop plumbing), `web/src/api.ts`, `web/src/ws.ts`.
- **watson (a11y):** `web/src/glyph-after-reload.test.tsx`, `web/src/components/ProjectGroup.tsx` (any new ARIA hooks?), `web/src/App.tsx` (no new components but verify no regression).
- **saarinen (UI Quality):** `web/src/components/ProjectGroup.tsx` (visual continuity with PR #61 council badges).
- **friedman (UX Quality):** `web/src/App.tsx` (post-auth bootstrap UX — loading state? race?), `web/src/store/council-slice.ts` (idempotency contract surfacing).
- **willison (LLM Pipeline):** `web/server/session-orchestrator.ts` (delta around handleCouncilReview observerProvider — none changed but verify).
- **beck (Test Quality):** ALL `.test.ts(x)` files: `web/server/browser-group-record.test.ts`, `web/server/session-group-coordinator.test.ts`, `web/server/session-orchestrator.test.ts`, `web/server/routes.test.ts`, `web/server/ws-bridge.test.ts`, `web/server/ws-bridge-publish.test.ts`, `web/src/store/council-slice.test.ts`, `web/src/App.test.tsx`, `web/src/glyph-after-reload.test.tsx`.
- **hashimoto (DevOps cross-stack):** N/A — no `Dockerfile`, `.github/workflows/*`, `.husky/*`, or `package.json` changes in scope. **Skip dispatch** (operator-approved per Phase 3 rule "never spawn an expert whose domain has zero files in scope").

## Convention floor

Council Mode floor `AP-1..EC-13` is already binding (see `conventions.md` and CLAUDE.md). The PR's keystone refactor (single `buildBrowserGroupRecord` helper for all three producers) is a candidate for a NEW convention `AP-X: Multi-producer wire shapes route through one assembly site` — Phase 7 will offer.
