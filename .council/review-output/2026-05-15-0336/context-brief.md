# Context Brief — Council Review (Aura): Task 11 wire-up integration

**Scope:** Merge commit `3dee080` on `main` — squash of PR #54 covering Task 11 wire-up subsections 11.6 + 11.7 + 11.8.
**Diff base:** `main~1..main` (one squash commit; 7 files changed, +843/-12 net).

## What this code does

The auto-proceed pipeline (PLAN-aura-orchestrator-idle-auto-proceed) fires synthetic user-frames into the orchestrator-half CLI of a Council pair when the orchestrator turn flips to `awaiting-input` with no STOP blocker AND idle-timer fires without user activity. This PR wires three foundation surfaces (shipped in PRs #45–#51 with unit tests but **zero production callers**) into actual call sites:

- **11.6** — `WsBridge.onUserFrameObserved` cross-tab single-firer + production caller for `IdleTimerManager.noteUserMessage`.
- **11.7** — Idle-kill clock split (synthetic-aware): `noteCliActivity` dispatcher routes CLI-activity callbacks through `idleTimerProbe.isSyntheticTurnInFlight`. Synthetic turns no longer extend the 24h idle-kill clock. EC-6 static-grep canary enforces single-source mutation.
- **11.8** — Replace `index.ts` `sendSyntheticFrame` stub with real `WsBridge.sendOrchestratorSyntheticFrame` (recorder origin `server:auto-proceed`); plus 4 cleanup paths: `can_use_tool` denylist gate, result-frame sticky-token cleanup, `session:exited` listener, `archiveSession` council-branch hook.

## Architecture

Server-side only (`web/server/`). Touches three high-risk surfaces:
- **`ws-bridge.ts`** — god-module per `feedback_file_level_coverage_gate_cascade`; the central message router with dual-WS bridge. 11.6 adds observer registry + fire site in `routeBrowserMessage`. 11.7 adds late-injected `idleTimerProbe` + 4 dispatcher methods (`noteCliActivity`, `noteUserActivity`, `noteSyntheticActivity`, `setIdleTimerProbe`) + replaces 2 mutation sites. 11.8 adds `sendOrchestratorSyntheticFrame` façade.
- **`claude-adapter.ts`** — second god-module; the Claude Code NDJSON protocol layer. 11.8 extends constructor opts with `idleTimerProbe` DI, adds `sendOrchestratorSyntheticFrame` method (parallel of `sendUserFrameFromServer`), adds denylist gate in `handleControlRequest` `can_use_tool`, adds sticky-token cleanup in `handleResultMessage`.
- **`session-orchestrator.ts`** — lifecycle owner. 11.6 subscribes `onUserFrameObserved → noteUserMessage`. 11.8 adds `session:exited` listener for `clearPendingSyntheticTurn` + `archiveSession` council-branch hook.
- **`index.ts`** — process bootstrap. 11.7 calls `wsBridge.setIdleTimerProbe(...)`. 11.8 replaces the synthetic-frame stub with real bridge call mapping `BridgeObserverWakeOutcome` → manager's `{ok, error}` shape.

## Stack in use within scope

Hono is NOT touched (no new routes). Vitest tests use existing helpers (`makeControlRequestMsg`, `createMockSocket`, `makeCliSocket`, `makeBrowserSocket`). Bun.serve, JSON-RPC, Codex adapter: NOT touched (ws-bridge-codex.ts is `@deprecated`; production codex routes through unified `attachBackendAdapter` in ws-bridge.ts). Persistence (session-store / recorder / env-manager): NOT touched. Frontend (React / Zustand / Tailwind): NOT touched. Docker / GHA: NOT touched.

## Key observations

- The probe interface widened mid-PR (11.7 had 1 method `isSyntheticTurnInFlight`; 11.8 added `noteTerminalResultFrame`). A forgotten `git add` on `ws-bridge.test.ts` shipped 11.7 → 11.8 with stale test stubs; caught by CI typecheck, fixed in `ffb48d3`. Lesson logged: `feedback_verify_staged_files_match_implicated_set.md`.
- The denylist (`auto-proceed-permissions.ts`) is a **string-match defence-in-depth filter**, NOT a hardened sandbox. Cannot catch shell-escapes (`bash -c '...'`), command substitution, chained operators. Documented limitation in the module + PR description.
- `sendOrchestratorSyntheticFrame` in ClaudeAdapter does a **direct NDJSON send** mirror of `sendUserFrameFromServer`, NOT routed through PR #52's `enqueueOutboundFrame` FIFO queue (still open at merge time). Documented scope-limit in PR body; follow-up planned once #52 lands.
- 5-step race-regression integration test (fire → user-frame → can_use_tool DENY → result-frame → can_use_tool ALLOW) deferred — requires full pipeline orchestration with FakeClock. Component-level coverage present.
- The state-machine recovery work in PR #53 (`half_respawned` zero-emit gap) was production-validated on the same Council pair end-to-end at 02:31:23 UTC before this PR shipped.

## Automated check results

- `bun run typecheck`: green
- `bun run test`: 240/240 files, 6179/6183 tests pass (4 pre-existing skipped — unrelated)
- CI on `ffb48d3` (final commit before squash-merge): 7/7 gates pass (test ubuntu/macos, platform ubuntu/macos, quality, a11y, coverage)
- No new TS errors, no new test failures, no new axe violations introduced

## Domain File Assignments

**Hunt (Security):** `web/server/claude-adapter.ts` (denylist gate — defence-in-depth or false security?), `web/server/auto-proceed-permissions.ts` (predicate + denial message builder — referenced from 11.8 call site, NOT in scope diff but should be cross-checked for the gate's actual coverage).

**Fowler (Refactoring):** `web/server/ws-bridge.ts` (god-module — +166 lines this PR; the cumulative growth is the concern, not this PR alone), `web/server/claude-adapter.ts` (god-module — +126 lines), `web/server/index.ts` (cohesion at the bootstrap seam).

**Bun/Hono/TS Backend Expert:** `web/server/ws-bridge.ts` (handler shape on `routeBrowserMessage`, error handling in dispatcher methods, late-injection pattern hygiene), `web/server/session-orchestrator.ts` (event listener registration in `initialize()`, idempotent cleanup paths), `web/server/index.ts` (wiring order discipline — manager constructed AFTER bridge then injected back).

**Realtime / NDJSON Protocol Expert:** `web/server/claude-adapter.ts` (new `sendOrchestratorSyntheticFrame` — line-discipline assertion, backpressure gate, transport state check, NDJSON envelope shape match with `sendUserFrameFromServer`), `web/server/ws-bridge.ts` (façade method, outcome-type mapping).

**Subprocess Lifecycle Expert:** `web/server/claude-adapter.ts` (orchestratorTurnState mutations on synthetic send + result-frame transition guards), `web/server/session-orchestrator.ts` (`session:exited` listener + `archiveSession` cleanup; idempotency claims on `clearPendingSyntheticTurn`).

**Willison (LLM Pipeline):** `web/server/claude-adapter.ts` (the denylist gate is the LLM-side safety mechanism; review against Willison Principle on AI-validator discipline + deterministic-fallback patterns), `web/server/ws-bridge.ts` (recorder origin `server:auto-proceed` distinction).

**Beck (Test Quality):** `web/server/claude-adapter.test.ts` (6 new 11.8 cases), `web/server/ws-bridge.test.ts` (6 11.6 cases + 5 11.7 cases + 1 EC-6 canary), `web/server/session-orchestrator.test.ts` (mock bridge extension). Read the source files they test (3 god-modules) to evaluate coverage adequacy + AI-cheating signals (mock-built-never-injected, weakened assertions, .skip accumulation).

## Convention floor — do NOT re-flag

Per `conventions.md` + Aura's `CLAUDE.md`:
- **AP-1** Coordinator decoupled from session-orchestrator via DI.
- **AP-2** `group-state-machine.ts` is single source of truth for group lifecycle status.
- **AP-3** Writer+reader schemas colocated.
- **EC-1** Observer SDK permission profile applied at spawn argv.
- **EC-2** Group-aware kills mark BOTH session ids intentional BEFORE either kill executes.
- **EC-5** Protocol parsers reject unknown methods/frame shapes.
- **EC-6** Static-grep canaries regex-anchored to function body, not literal substring.
- **EC-7** Filesystem-access predicates inline path resolution OR resolving-wrapper-only.
- **EC-9** Structured JSON log lines with `event` + `sessionGroupId` + role.
- **EC-13** Observer 5-min failsafe self-poll.

Do not re-flag these — they're floor, not target.
