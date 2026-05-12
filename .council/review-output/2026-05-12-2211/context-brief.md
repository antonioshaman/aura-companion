# Context Brief for Aura Council Review

## What this code does

Wires the previously-dead `reconnecting` group state in Council Mode so paired orchestrator + observer CLI sessions survive transient CLI ws drops AND server restart partial-pair gaps. Replaces the immediate `active → degraded` jump on `session:exited` with a bounded grace window (default 45s, env-overridable). Resolution paths: `session:cli-id-received` (handshake-not-transport gate) for happy-path recovery, `session:relaunch-failed` for deterministic failures, timer expiry for silent hangs. Frontend ObserverPanel pill flips through the previously-unreachable `reconnecting` state.

## Architecture

Server pipeline (post-change):
- `group-state-machine.ts` — pure state machine + new `deriveSideEffects(prev, next, event)` returning `{busEvents, logEntries}`.
- `session-group-coordinator.ts` — `applyEvent` is now sole lifecycle mutator (drains side effects); new `ReconnectContext` map + `armReconnect` / `cancelReconnectTimer` / `getReconnectContext` / `registerExternalGroup` / `listGroupIds`; `archiveGroup` routes through `applyEvent({user_archived})`.
- `session-orchestrator.ts` — long-lived coordinator field + `pendingCouncilCall` per-call context; rewired `session:exited` listener (intentionalKills first → relaunchExhausted skip → second-half-died → armReconnect); new `session:cli-id-received` reconnect_ok subscriber with identity binding (`ctx.snapshotSessionId === sessionId`); new `session:relaunch-failed` listener short-circuit; partial-pair grace in `reconcileCouncilGroups`; `lastReviewedCheckpointId` tracking + catchup log on `reconnect_ok`; emits new `session:relaunch-failed` from `handleAutoRelaunch` (budget exhausted + sync spawn error); `GROUP_RECONNECT_GRACE_MS` env config with validation [1, 600_000].
- `event-bus-types.ts` — added `session:relaunch-failed`, `group:reconnecting` events.
- `session-types.ts` — added `group_reconnecting` wire variant `{type, sessionGroupId, survivingRole, deadlineMs}` (absolute wallclock, no `attempts` v1).
- `session-store.ts` — added `flushAll(pending)`.
- `ws-bridge.ts` — added `flushSessionStorePendingSync()`.
- `index.ts` — `gracefulShutdown` now async; cancel timers → flush stores → `shutdownAllGroups(8s budget)` → existing container persist. (Closes pre-existing P1: `shutdownAllGroups` was never called.)

Browser pipeline:
- `ws.ts` — added `case "group_reconnecting":` → `setGroupStatus(id, "reconnecting")`. `deadlineMs` intentionally dropped (YAGNI).
- `components/council/ObserverPanel.tsx` — reconnecting pill: swapped `cc-warning` → `cc-info` (distinct from `degraded`); added `role="status"` + `aria-atomic="true"` (polite live region).

## Stack in use within scope

Present: Bun + Hono + TS strict, Bun.serve WebSocket bridge, React 19 + Zustand 5 + Tailwind 4, Vitest + vitest-axe, filesystem JSON persistence (session-store), structured logging (`logger.ts` → `log.info(module, msg, fields)`), `companionBus` typed EventEmitter.

Absent in this scope: no new HTTP routes, no new fs writes beyond the existing session-store, no new CLI args, no CodeMirror/xterm touch, no markdown rendering, no AI-validator changes, no Codex JSON-RPC parser changes.

## Convention floor (do NOT re-flag)

AP-1, AP-2, AP-3, EC-1 through EC-9 from `conventions.md` apply. AP-2 (`group-state-machine.ts` is single source of truth) is **the** convention this PR is structurally enforcing — `applyEvent` becomes the sole mutator; `deriveSideEffects` is the pure decisions function; no parallel-status booleans introduced.

## Deliberate scope OUT — already noted as Watchpoints in the plan

Reviewers MUST NOT re-flag these (each is a deferred follow-up):
- "Observer reconnecting" copy insufficiency / countdown UI / degraded-after-failed-reconnect indistinguishability
- StatusPill row reflow (`min-width` reservation)
- `prefers-reduced-motion` on `animate-spin`/`animate-pulse` (pre-existing across multiple pills)
- Two-process race during `--resume` relaunch (pre-existing)
- Recording header tagging (sessionGroupId/spawnAttempt/promptSha)
- Replay-corpus negative case for mid-review crash
- Manifest skipped-checkpoint fold (the deeper Willison ask; Task 12 deliberately partial — surface the gap via catchup log, don't rewrite the manifest builder)
- `applyGroupEvent` slice reducer merge in browser (per-status verbs deferred per Task 9 deviation)
- `ws.ts` coverage gate cascade
- HEALTHCHECK design intent

## Key observations

1. **Concurrency exposure during implementation:** two other agent pairs were modifying the same files (`group-state-machine.ts`, `session-group-coordinator.ts`, `event-bus-types.ts`) in parallel. System reminders intermittently showed stale snapshots that read as rollbacks. Disk state + typecheck stayed consistent throughout; verified via Bash grep at every suspect point. No work lost.
2. **`pendingCouncilCall` per-call context** — the coordinator's spawn/kill callbacks are bound once at first `getOrCreateCoordinatorSync`, but each `createCouncilGroup` call sets `this.pendingCouncilCall` in try/finally so the callback reads fresh state per invocation. The callback throws explicitly if invoked outside that window. Defensive; covers the second-create-call regression.
3. **`deadlineMs` is absolute wallclock** — Realtime expert's specific Q on Task 7: not relative; this matters for replay across browser disconnect.
4. **Identity binding on reconnect_ok** — Hunt's specific recommendation: snapshot `sessionId` at `reconnect_started`, validate match on `session:cli-id-received`. Mismatch → log warn, drop, do NOT cancel grace.
5. **No `writeReconnectIntent` sentinel** — FS-JSON deliberate gap. Documented inline in `reconcileCouncilGroups`. PID snapshot on next boot is strictly more authoritative than a stale marker (PID reuse can lie).

## Automated check results

- **Typecheck:** ✅ clean (`tsc --noEmit` exit 0).
- **Server tests:** ✅ 3132 passed across 116 files (from final implementation-log run prior to this review; Phase 0 retest in flight).
- **Council UI tests:** ✅ 22 ObserverPanel tests including the new behavioural a11y test (`role="status"` + `aria-atomic` + `cc-info` className + spinner aria-hidden + axe-clean).
- **Pre-existing failures (NOT introduced by this PR, NOT in scope):** 61 cases in `Composer.test.tsx` from unstaged in-progress edits to `Composer.tsx` referencing missing store field `s.connectionStatus`. Reviewers MUST NOT flag this as a finding.

## Domain File Assignments

**Hunt (Security):**
- `web/server/session-orchestrator.ts` (identity binding on reconnect_ok; intentionalKills ordering; structured-log content for EC-9 leakage)
- `web/server/session-group-coordinator.ts` (`armReconnect` rate-limit one-cycle counter; `cancelReconnectTimer` discipline)
- `web/server/event-bus-types.ts` (new event payload shapes)
- `web/server/index.ts` (gracefulShutdown ordering)

**Fowler (Refactoring):**
- `web/server/group-state-machine.ts` (`deriveSideEffects` pure function; AP-2 enforcement)
- `web/server/session-group-coordinator.ts` (sole-mutator pattern; `enactBusEvent`/`enactLogEntry` extraction)
- `web/server/session-orchestrator.ts` (listener accumulation in `wireGroupListeners` / `initialize`; god-module trajectory)

**Bun/Hono/TS Backend Expert:**
- `web/server/session-orchestrator.ts` (env parse + structured log on resolved value; async listener discipline on `session:cli-id-received` / `session:relaunch-failed`; timer lifecycle)
- `web/server/index.ts` (async gracefulShutdown; dynamic-import discipline)
- `web/server/session-group-coordinator.ts` (Bun timer hygiene in `armReconnect`)
- `web/server/event-bus-types.ts` (typed event surface)

**FS-JSON Persistence Expert:**
- `web/server/session-store.ts` (`flushAll` semantics; debounce-window correctness)
- `web/server/ws-bridge.ts` (`flushSessionStorePendingSync` pending-snapshot mapping)
- `web/server/index.ts` (shutdown flush ordering vs `shutdownAllGroups`)
- `web/server/session-orchestrator.ts` (deliberate `writeReconnectIntent` non-sentinel — verify EC-8 gap is defensible)

**Realtime / NDJSON Protocol Expert:**
- `web/server/session-types.ts` (`group_reconnecting` wire variant shape)
- `web/server/ws-bridge.ts` (broadcast ordering; replay class for new variant)
- `web/server/ws-bridge.test.ts` (replay regression test correctness)
- `web/src/ws.ts` (browser dispatch; forward-compat default arm)

**Subprocess Lifecycle Expert:**
- `web/server/session-orchestrator.ts` (full listener wiring — `session:exited`, `session:cli-id-received`, `session:relaunch-failed`; relaunchExhausted gate; intentionalKills semantics; partial-pair grace)
- `web/server/session-group-coordinator.ts` (`armReconnect` grace timer; `ReconnectContext` snapshot)
- `web/server/event-bus-types.ts` (new `session:relaunch-failed` event)

**React/Web UI Expert:**
- `web/src/ws.ts` (dispatch case; default arm; deadlineMs drop discipline)
- `web/src/components/council/ObserverPanel.tsx` (status pill render; AP-2 derive-from-status)

**a11y Auditor:**
- `web/src/components/council/ObserverPanel.tsx` (`role="status"` + `aria-atomic` + `aria-busy` + spinner aria-hidden combination)
- `web/src/components/council/ObserverPanel.test.tsx` (behavioural a11y test depth)

**Beck (Test Quality):**
- `web/server/group-state-machine.test.ts` (Beck F2 full transition table preservation under new event shape)
- `web/server/session-orchestrator.test.ts` (replaced "drives group:degraded" → two new tests; partial-pair grace test; mock vs real-coordinator usage; assertion strength)
- `web/server/ws-bridge.test.ts` (new replay regression test for `group_reconnecting`)
- `web/src/components/council/ObserverPanel.test.tsx` (new behavioural a11y test)
- The above source files they test (cross-reference)

**Saarinen / Friedman / Willison / Deploy:** SKIPPED. No visual-token changes beyond `cc-warning → cc-info` (which a11y owns for contrast and which the test asserts); no UX flow changes (panel already supported the state); no LLM pipeline changes (no AI-validator, claude-adapter, or recording touch); no Dockerfile/workflow changes (env var added to docs only, not infrastructure).

## Council coverage

8 experts dispatched: Hunt, Fowler, Bun/Hono/TS Backend, FS-JSON Persistence, Realtime/NDJSON Protocol, Subprocess Lifecycle, React/Web UI, a11y Auditor, Beck.

Saarinen, Friedman, Willison, Deploy explicitly NOT dispatched — their domains have no in-scope changes worth a full review.
