# Context Brief for Aura Council Review — Observer Auto-Wake (Story 2 AC#1)

## What this code does

Closes Council Mode Story 2 AC#1: when the orchestrator writes a valid checkpoint file to `.council/checkpoints/<phase>.json`, the server now pushes a typed `user` NDJSON frame to the observer's CLI socket so it actually wakes and produces a review. Before this change, the observer was correctly spawned with system prompt + tool allowlist but sat idle indefinitely with `cliSessionId=null` — the only prior cycle was manually triggered (filename `manual-wake-aura-rebrand.json`). Scope: claude+claude pairing only; Codex pairing explicitly deferred.

## Architecture

Server-side pipeline (new path through 24 files):

1. **`web/server/checkpoint-watcher.ts`** (existing) — atomic-write + LRU-dedup boundary; emits validated `CheckpointPayload`.
2. **`web/server/session-orchestrator.ts handleCouncilCheckpoint`** — captures payload, emits `group:checkpoint` bus event, then synchronously calls new `dispatchObserverWake` (the keystone).
3. **`dispatchObserverWake`** (Task 3) — pure-sync method: 5 gates in order — Gate 0 sentinel idempotency, Gate 1 group-status=active (AP-2), Gate 2 builder validation, Gate 3 bridge send, then outcome→EC-9 log mapping. Returns discriminated `WakeDispatchOutcome` (8 skip reasons).
4. **`web/server/observer-prompt.ts buildObserverWakePayload`** (Task 1, 7) — pure builder; takes `(checkpoint, manifest, workspaceRoot)`; validates CR/LF/NUL + fence-triplet at the format-transformation boundary; runs realpath containment via `assertWakeManifestPathAllowed` (EC-7 wrapper); returns `{textBody, sha256, droppedPaths}`.
5. **`web/server/ws-bridge.ts sendObserverWakeFrame`** (Task 3) — single sessionId→ClaudeAdapter narrowing seam; returns `BridgeObserverWakeOutcome`.
6. **`web/server/claude-adapter.ts sendUserFrameFromServer`** (Task 2) — adapter-level send with three strict gates (turn-state, transport, backpressure), post-stringify `\n` assertion, NDJSON line-discipline tripwire. Tracks `observerTurnState: idle|in-flight`; flips on outbound wake, flips back on inbound `result` frame + emits `observer:turn-done` bus event.
7. **`session-orchestrator drainPendingObserverWake`** (Task 4) + listener on `observer:turn-done` (Task 4 wire) + listener on `reconnect_ok` (Task 5) + drop on `group:degraded` (Task 5).
8. **`web/server/council-wake-sentinel.ts`** (Task 6, NEW) — per-group sidecar `.council/state/<groupId>-wake.json` via `writeAtomicJson` for restart idempotency (EC-8 sentinel-before-sweep).
9. **`web/server/recorder.ts`** (Task 8) — schema bumped v1→v2 with optional `origin: "server:council-wake"` field; readers in `replay.ts` + `recording-hub/hub-store.ts` tolerate both versions (`RECORDING_HEADER_VERSIONS_ACCEPTED`).

Frontend pipeline:

10. **`web/src/observer-panel-state.ts`** (Task 11) — promotes `reviewing` to load-bearing (bounded by `lastCheckpointAt + wakeTimeoutMs`); adds `reviewing-stalled` (past deadline) and `queued-dropped` (supersededCheckpointIds non-empty) variants; priority ladder grew from 7 to 9 states.
11. **`web/src/store/council-slice.ts`** (Task 11) — `appendObserverReview` captures `supersededCheckpointIds` into `GroupRecord.recentlySupersededCheckpointIds`.
12. **`web/src/ws.ts`** (Task 11) — propagates `wakeTimeoutMs` from `group_created` and `supersededCheckpointIds` from `observer_review`.
13. **`web/src/components/council/ObserverPanel.tsx`** (Task 11) — passes `nowMs` to deriver.
14. **`web/src/components/council/FindingsLog.tsx`** (Task 12, a11y) — row container changed `aria-live="polite"` → `"off"`; added visually-hidden polite summary announcer via `useRef`-tracked seen-ids set; new pure `buildFindingsReviewSummary` (singular/plural-aware).

Wire protocol additions (additive fields, optional except `group_created.wakeTimeoutMs`):
- `group_created.wakeTimeoutMs: number` (required)
- `group_degraded.reason?: "observer_exited"|"wake_send_failed"|"reconnect_failed"` (optional; not yet emitted)
- `observer_review.supersededCheckpointIds?: string[]` (optional)

Observer prompt v1 (`.council/prompts/observer-system.md`) — `observer_wake_payload_version_echo` field added to output JSON spec; `handleCouncilReview` validates echo against `OBSERVER_WAKE_PAYLOAD_VERSION`, mismatch → all findings → NOTE + new downgrade reason `wake_version_mismatch`.

## Stack in use within scope

Bun + Hono backend (no Hono route changes — pure WS-bridge work). NDJSON protocol writer/reader. Filesystem JSON persistence (sentinel + recorder). React 19 + Zustand 5 frontend (panel state machine). Vitest + vitest-axe. NOT in scope: Hono routes, REST endpoints, Docker, CI workflows, env vars (kill-switch deliberately rejected by deploy council in plan).

## Accepted conventions (from `conventions.md` v as of TIMESTAMP)

- AP-1 Coordinator decoupled from session-orchestrator via DI
- AP-2 group-state-machine is single source of truth for group lifecycle
- AP-3 council-types.ts hosts writer+reader schemas in one file
- EC-1 Observer SDK permission profile applied at spawn argv
- EC-2 Group-aware kills mark BOTH session IDs intentional first
- EC-3 Companion sessionId vs CLI cliSessionId distinct
- EC-4 Filesystem watcher debounce never silently coalesces distinct payloads
- EC-5 Protocol parsers reject unknown method/frame discriminators
- EC-6 Load-bearing protocol parsers need replay-based regression tests
- EC-7 Filesystem-access predicates inline realpath OR exposed only via resolving wrapper
- EC-8 Reconciliation actions require sentinel-before-sweep helpers
- EC-9 Group-lifecycle log lines must be structured JSON with required context fields

These were honoured during implementation. Reviewers should NOT re-flag them.

## Key observations

- **481 LOC added to `session-orchestrator.ts`** (it grew from ~1200 to ~1700 lines). Two new private methods (`dispatchObserverWake`, `drainPendingObserverWake`), one bus listener (`observer:turn-done`), substantial additions inside existing listeners (`group:degraded`, `reconnect_ok`, `group:review`). The god-module trajectory is worth examining — Fowler's economic test should be applied.
- **Single new module:** `web/server/council-wake-sentinel.ts` (~150 LOC). Self-contained read/write helpers with own schema; follows AP-3 colocation pattern.
- **WakeDispatchOutcome discriminated union** with 8 skip reasons is the keystone for testability — every dispatcher branch lands in exactly one EC-9 log line.
- **Recorder schema v1→v2 with back-compat readers** (Task 8) — readers in `replay.ts` and `hub-store.ts` updated to accept both versions; ALL historical recordings still load.
- **Observer system prompt** (`.council/prompts/observer-system.md`) is now load-bearing for the version-echo contract — version-mismatch downgrade is server-side defence against silent schema drift.
- **Frontend state machine** grew from 7 to 9 ladder slots; `reviewing` is now bounded by a real timeout (`wakeTimeoutMs`) rather than a heuristic; existing tests needed `nowMs` parameter to stay deterministic.
- **a11y cadence response** in `FindingsLog.tsx`: `aria-live="polite"` → `"off"` on the row container + sibling visually-hidden summary announcer. Closes the "every checkpoint queues 3-8 announcements" SR flood.
- **No new env vars, no Dockerfile changes, no CI changes** — pure in-codebase implementation per deploy council's "ship without kill-switch" recommendation.
- **Test additions:** 12 new tests for builder + realpath wrapper + static-grep canary in `observer-prompt.test.ts`; 2 new tests for stalled+queued-dropped in `observer-panel-state.test.ts`; 2 new tests for cadence-aware a11y in `FindingsLog.test.tsx`; 1 fixture update in `recorder.test.ts`; 1 fixture update in `ws-bridge.test.ts`; 1 fixture update in `ObserverPanel.test.tsx`. Total new tests: 12; total in suite still passing: **5604 + 4 skipped**.

## Automated check results

**All green:**
- `bun run typecheck` — clean (no TypeScript errors)
- `bun run test` — 223 test files, 5604 tests pass + 4 pre-existing skipped (no new skips, no failures)
- No dedicated `bun run test:a11y` script exists; axe assertions are inline via `vitest-axe` `toHaveNoViolations()` and they pass as part of the main test run.

Pre-existing harmless stderr in test runs: `Not implemented: HTMLCanvasElement's getContext()` (jsdom limitation, not from my code), `/bin/sh: 1: docker: not found` (test that probes docker on CI, absent in this env, doesn't fail).

## Domain File Assignments

**Hunt (Security):** `web/server/observer-prompt.ts`, `web/server/claude-adapter.ts` (sendUserFrameFromServer), `web/server/session-orchestrator.ts` (dispatchObserverWake + sentinel path), `web/server/council-wake-sentinel.ts`, `web/server/council-types.ts` (new validators)

**Fowler (Refactoring):** `web/server/session-orchestrator.ts` (god-module growth), `web/server/council-wake-sentinel.ts` (new module), `web/server/observer-prompt.ts` (builder size + EC-7 wrapper), `web/server/claude-adapter.ts` (turn-state placement)

**Bun/Hono/TS Backend Expert:** `web/server/claude-adapter.ts`, `web/server/ws-bridge.ts` (sendObserverWakeFrame), `web/server/session-orchestrator.ts` (handler shape), `web/server/council-wake-sentinel.ts`, `web/server/event-bus-types.ts`, `web/server/recorder.ts`

**FS-JSON Persistence Expert:** `web/server/recorder.ts`, `web/server/replay.ts`, `web/server/recording-hub/hub-store.ts`, `web/server/council-wake-sentinel.ts`, `web/server/session-orchestrator.ts` (sentinel I/O coupling)

**Realtime/NDJSON Protocol Expert:** `web/server/claude-adapter.ts` (sendUserFrameFromServer + observerTurnState + handleResultMessage), `web/server/ws-bridge.ts` (sendObserverWakeFrame), `web/server/observer-prompt.ts` (wake body shape), `web/server/session-orchestrator.ts` (handleCouncilCheckpoint), `web/server/session-types.ts`

**Subprocess Lifecycle Expert:** `web/server/claude-adapter.ts` (turn-state), `web/server/session-orchestrator.ts` (dispatch + drain + reconnect/degraded handling)

**React/Web UI Expert:** `web/src/observer-panel-state.ts`, `web/src/store/council-slice.ts`, `web/src/ws.ts`, `web/src/components/council/ObserverPanel.tsx`, `web/src/components/council/FindingsLog.tsx`, `web/src/types.ts`

**a11y Auditor:** `web/src/components/council/FindingsLog.tsx`, `web/src/components/council/ObserverPanel.tsx`

**Friedman (UX Quality):** `web/src/components/council/ObserverPanel.tsx`, `web/src/observer-panel-state.ts` (new state machine variants + their UX implications)

**Willison (LLM Pipeline):** `web/server/observer-prompt.ts` (wake body builder), `web/server/session-orchestrator.ts` (version-mismatch downgrade), `.council/prompts/observer-system.md`

**Beck (Test Quality):** `web/server/observer-prompt.test.ts`, `web/server/recorder.test.ts`, `web/server/ws-bridge.test.ts`, `web/src/observer-panel-state.test.ts`, `web/src/components/council/ObserverPanel.test.tsx`, `web/src/components/council/FindingsLog.test.tsx`, AND their source files

**NOT dispatched** (no in-scope surface):
- Saarinen (UI Quality) — no new visual surface; existing tokens/components untouched
- Docker/GHA Deploy — no Dockerfile, no CI workflow, no env var changes
