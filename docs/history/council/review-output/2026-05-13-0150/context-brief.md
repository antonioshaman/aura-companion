# Council Regression Review (Aura) — commit 02e28c1

## What this code is

This is the SECOND review pass on the observer auto-wake implementation. The first review (.council/review-output/2026-05-13-0100/FINAL-REVIEW.md) produced 25 findings (13 P1 + 8 P2 + 4 P3); the fix-pass closed 24/25 (P3 #25 = watchpoint only). Goal of this regression review: verify the fixes don't introduce new findings AND verify no new findings emerged from the broader change.

**DO NOT re-flag** any of the 24 fixes from the prior FINAL-REVIEW.md. Cross-reference and confirm fix lands correctly; don't redundantly flag.

**DO NOT re-flag** AP-1..AP-3, EC-1..EC-12 — these are convention floor including the NEW EC-10/EC-11/EC-12 added in the previous cycle (compile-fail exhaustiveness, wallclock-tick subscription, fs.watch pre-scan reconcile).

## Architecture (regression scope)

Same as 2026-05-13-0100 brief — observer auto-wake pipeline across:
- Server: `claude-adapter.ts` (sendUserFrameFromServer + observerTurnState), `ws-bridge.ts` (sendObserverWakeFrame seam), `session-orchestrator.ts` (dispatchObserverWake + drainPendingObserverWake + scanForMissedObserverWakes), `council-wake-sentinel.ts` (new), `observer-prompt.ts` (buildObserverWakePayload + assertWakeManifestPathAllowed), recorder schema v1→v2, `event-bus-types.ts`, `session-types.ts`, `council-types.ts`
- Frontend: `observer-panel-state.ts` (9-state ladder), `council-slice.ts`, `ws.ts`, `ObserverPanel.tsx`, `FindingsLog.tsx`, `types.ts`
- Workspace artifact: `.council/prompts/observer-system.md` (v1 with `dropped` semantic + version echo)
- New tests: `council-wake-sentinel.test.ts`, `observer-wake-fixture.test.ts`
- New fixture: `__fixtures__/observer-wake/claude-v1.jsonl`

## Fix-pass changes layered on top of original implementation

24 findings addressed (see prior FINAL-REVIEW.md for full detail). Notable structural changes from fix-pass:
- New `councilGroupBySessionId` reverse index on orchestrator (#21)
- `dispatchObserverWake` switch now exhaustive with `never` check on bridge-outcome (#23)
- StatusPill switch now exhaustive with `never` check on panel-state (#5)
- `observerTurnState` resets in BOTH `detachWebSocket` and `handleTransportClose` (#2)
- New `case "reconnecting"` in Gate 1 → queues into pendingCheckpoint (#3)
- Backpressure now queues into pendingCheckpoint (was drop) (#17)
- `markActivity` unconditional BEFORE the gates (was only on success) (#15)
- New `scanForMissedObserverWakes` runs after `reconcileCouncilGroups` (#6, EC-12)
- Wake version echo MANDATORY in handleCouncilReview (#12; missing → all NOTE)
- `wakeTimeoutMs` is now OPTIONAL on wire with frontend fallback (#9; bumped to 300s per #18)
- FindingsLog `lastIdsRef` → module-level `ANNOUNCED_FINDING_IDS_BY_SCOPE` Map keyed by `announcerScope` (#10)
- ObserverPanel `useEffect`+`setInterval` 1s clock-tick while reviewing (#4, EC-11)
- `DowngradedChip` exhaustive switch with new `wake_version_mismatch` case (#19)
- Findings slice guards fresh-array on zero-new dedup (#24)
- Sentinel cleanup on `group:exited` via new `deleteCouncilWakeSentinel` (#16)
- Sentinel write failure log bumped WARN→ERROR with incident marker (#14)
- `claim` field fence-triplet stripped at validator boundary (#22)
- 17 new tests in 2 new test files (sentinel + fixture)

Workspace artifact:
- Observer system prompt v1: `dropped` semantic moved into "Your contract" + version echo added to output spec

## Stack in scope

Bun + Hono + TS (server), React 19 + Zustand 5 + Tailwind (frontend), NDJSON over WebSocket bridge, filesystem JSON persistence with atomic-write, Vitest + vitest-axe. No Hono route changes, no Docker, no CI changes.

## Convention floor (do not re-flag — flag VIOLATIONS only)

- AP-1 Coordinator decoupled from session-orchestrator via DI
- AP-2 group-state-machine.ts is single source of truth for group lifecycle
- AP-3 council-types.ts hosts writer+reader schemas in one file
- EC-1 Observer SDK permission profile applied at spawn argv
- EC-2 Group-aware kills mark BOTH session IDs intentional first
- EC-3 Companion sessionId vs CLI cliSessionId distinct
- EC-4 Filesystem watcher debounce never silently coalesces distinct payloads
- EC-5 Protocol parsers reject unknown method/frame discriminators
- EC-6 Load-bearing protocol parsers need replay-based regression tests
- EC-7 Filesystem-access predicates inline realpath OR exposed only via wrapper
- EC-8 Reconciliation actions require sentinel-before-sweep helpers
- EC-9 Group-lifecycle log lines are structured JSON with required fields
- **EC-10 (NEW)** Discriminated-union state renderers must compile-fail on missing variants
- **EC-11 (NEW)** Wallclock-anchored derived state requires explicit clock-tick subscription
- **EC-12 (NEW)** `fs.watch`-driven pipelines require pre-scan reconcile on initialize

## Key observations

- **`session-orchestrator.ts` is now ~1850 LOC.** Prior review's P3 #25 was an explicit "size watchpoint, no action yet". Fowler — flag only if fix-pass added NEW structural complexity that pushed it past a real threshold, not the same watchpoint.
- **Two new test files exist** (`council-wake-sentinel.test.ts` 12 tests, `observer-wake-fixture.test.ts` 5 tests). Beck — review them for the same rigour the prior pass applied.
- **The fix-pass added a static-grep canary** at `observer-prompt.test.ts:436-451` (per prior review's Beck #4 rec). Beck should verify it uses `\w+` regex per memory `feedback_static_grep_canary_regex_over_substring`, not literal substrings.
- **EC-10/EC-11/EC-12 applications** are visible at 3 specific call sites: StatusPill switch (EC-10), ObserverPanel useEffect (EC-11), scanForMissedObserverWakes (EC-12). Each should compile-fail on regression — verify the `never` checks and the interval cleanup are correct.
- **EC-12 reconcile scan**: a NEW pre-scan implementation that reads + parses all checkpoint files at startup. Persistence — verify it absorbs corrupt/foreign checkpoints without crashing initialize.
- **Wake-version echo is now mandatory** (Willison #12 fix). Any historical observer that doesn't echo → all findings downgrade to NOTE. Willison + Beck — confirm the prior `observer_wake_payload_version_echo: 1` test fixture update is enough; the broader test suite shouldn't be silently relying on the old fail-open path.
- **Module-level `ANNOUNCED_FINDING_IDS_BY_SCOPE` Map** in FindingsLog (a11y #10 fix). Never freed; bounded by page lifetime. React/a11y — flag if this is a real concern given typical usage patterns.

## Automated check results

User-confirmed pre-dispatch:
- `bun run typecheck` — clean
- `bun run test` — 5621/5621 pass + 4 pre-existing skipped (no new skips, no failures)
- No axe violations (vitest-axe `toHaveNoViolations()` all green)
- No dedicated `bun run test:a11y` script; axe assertions are inline via vitest-axe.

Pre-existing harmless stderr: `Not implemented: HTMLCanvasElement's getContext()` (jsdom limit, not from this code), `/bin/sh: 1: docker: not found` (test probe for unrelated work, doesn't fail).

## Domain File Assignments

**Hunt (Security):** `web/server/session-orchestrator.ts` (cross-group check + scanForMissedObserverWakes + new mandatory echo), `web/server/observer-prompt.ts` (no changes since fix-pass; still relevant for the EC-7 wrapper), `web/server/council-wake-sentinel.ts` (delete helper added), `web/server/council-types.ts` (claim fence-triplet strip)

**Fowler (Refactoring):** `web/server/session-orchestrator.ts` (1850 LOC — re-evaluate watchpoint), `web/src/components/council/FindingsLog.tsx` (module-level Map + scope prop), `web/src/components/council/ObserverPanel.tsx` (clock-tick state)

**Bun/Hono/TS Backend:** `web/server/session-orchestrator.ts` (new exhaustiveness check on switch + reverse index + scan method + 3 listeners), `web/server/claude-adapter.ts` (markActivity reposition + turn-state resets), `web/server/ws-bridge.ts` (unchanged from fix-pass; verify), `web/server/council-wake-sentinel.ts` (delete helper), `web/server/recorder.ts` (no changes; carry-over)

**FS-JSON Persistence:** `web/server/council-wake-sentinel.ts` (delete helper added), `web/server/session-orchestrator.ts` (scanForMissedObserverWakes — reads + parses ALL checkpoint files at startup), `web/server/recorder.ts` (v2 already), `web/server/replay.ts` (unchanged), `web/server/recording-hub/hub-store.ts` (unchanged)

**Realtime/NDJSON Protocol:** `web/server/claude-adapter.ts` (sendUserFrameFromServer with markActivity reposition), `web/server/observer-prompt.ts` (buildObserverWakePayload unchanged but the fixture file is new), `web/server/__fixtures__/observer-wake/claude-v1.jsonl` (NEW canonical fixture), `web/server/observer-wake-fixture.test.ts` (NEW — verify it actually pins what it claims)

**Subprocess Lifecycle:** `web/server/claude-adapter.ts` (observerTurnState now resets in BOTH detach paths + markActivity moved), `web/server/session-orchestrator.ts` (new reconnecting case in Gate 1 queue, new scanForMissedObserverWakes recovery path)

**React/Web UI:** `web/src/components/council/ObserverPanel.tsx` (useState/useEffect/setInterval clock-tick + StatusPill exhaustive switch + announcerScope prop), `web/src/components/council/FindingsLog.tsx` (module-level Map + conditional announcer render + DowngradedChip exhaustive switch), `web/src/observer-panel-state.ts` (300s fallback constant), `web/src/store/council-slice.ts` (zero-new array guard), `web/src/ws.ts` (no further changes), `web/src/types.ts` (wake_version_mismatch union widened)

**a11y Auditor:** `web/src/components/council/FindingsLog.tsx` (module-level Map for announcer scope + conditional render of empty announcer), `web/src/components/council/ObserverPanel.tsx` (clock-tick re-render impact on SR)

**Friedman (UX):** `web/src/components/council/ObserverPanel.tsx` (StatusPill new state copy: "Review stalled" + "Reviewed (skipped N)"), `web/src/components/council/FindingsLog.tsx` (DowngradedChip new "schema mismatch — review may be stale" copy)

**Willison (LLM Pipeline):** `web/server/session-orchestrator.ts` (wake-version echo now mandatory; downgrade-on-missing path), `.council/prompts/observer-system.md` (v1 with new `dropped` semantic in contract + version echo in output spec)

**Beck (Test Quality):** `web/server/council-wake-sentinel.test.ts` (NEW, 12 tests), `web/server/observer-wake-fixture.test.ts` (NEW, 5 tests), `web/server/observer-prompt.test.ts` (12 new tests from prior fix-pass — verify static-grep canary uses `\w+`), `web/server/session-orchestrator.test.ts` (updated for mandatory echo), `web/server/recorder.test.ts` (v2 version), `web/server/ws-bridge.test.ts` (wakeTimeoutMs fixture), `web/src/observer-panel-state.test.ts` (new states), `web/src/components/council/FindingsLog.test.tsx`, `web/src/components/council/ObserverPanel.test.tsx`

**NOT dispatched** (no scope this regression):
- Saarinen (UI Quality) — no new visual surface beyond color tokens already in use
- Docker/GHA Deploy — no Dockerfile / CI / env-var changes
