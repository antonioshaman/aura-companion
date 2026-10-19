# Council Plan (Aura): Wire `reconnecting` group state — pairs survive transient CLI ws drops + server restart partial-pair grace

**Scope:** Route group lifecycle through a bounded `reconnecting` window (default 45s, env-overridable) before a single-half drop becomes `degraded`. Cover both live-disconnect and server-restart partial-pair cases. Make CLAUDE.md's "applyEvent emits group lifecycle events" true by construction.
**Context:** Council Mode's group state machine (`group-state-machine.ts`) defines `reconnecting` + `applyEvent` entry, with full unit-test coverage, but **zero production callers**. The live `degraded` path bypasses the state machine at `session-orchestrator.ts:516`. This plan wires the dead capability and fixes the AP-2 drift along the way.
**Boundaries (out of scope):** Manual "restart observer" UI button. Multi-attempt group-level retry beyond one cycle. Countdown UI / "X seconds remaining" copy. Any new UI components. Refactor of `ws.ts` god-module beyond the new case.
**Council dispatched:** Hunt (Security), Fowler (Refactoring), Bun/Hono/TS Backend, FS-JSON Persistence, Realtime/NDJSON Protocol, Subprocess Lifecycle, React/Web UI, a11y Auditor, Saarinen (UI), Friedman (UX), Willison (LLM Pipeline), Deploy. All 12 returned actionable findings.

---

## Task Sequence

### 1. State machine side-effect channel + coordinator becomes sole lifecycle mutator

| | |
|---|---|
| **Domain** | Fowler × Carmack — *Refactoring is economic; make the wrong thing impossible* |
| **Ref** | `references/refactoring.md` → Principles 2, 4 |
| **Depends on** | — |

`transition(state, event)` becomes pure with signature `{next, busEvents, logEntries}` — the only place where bus emissions and EC-9 logs are decided. `coordinator.applyEvent()` becomes the sole mutator that drains all three. CLAUDE.md drift ("applyEvent emits group:degraded / group:exited") becomes true by construction. Trust-on-AP-2 stops being a convention floor and becomes a type-level invariant: `GroupRecord.status` is the only lifecycle field; reconnect metadata (timer handle, startedAtMs, snapshot) lives in a coordinator-private `ReconnectContext` map keyed by `sessionGroupId`. Cross-ref: Subprocess (EC-2), Backend (P5 timer hygiene), Realtime (side-effect channel feeds wire emission).

---

### 2. Bootstrap env config: `COMPANION_GROUP_RECONNECT_GRACE_MS`

| | |
|---|---|
| **Domain** | Bun/Hono/TS Backend × Carmack — *Validate at the boundary; structured logging* |
| **Ref** | `references/quality-backend.md` → Principles 2, 6 |
| **Depends on** | — |

Single load-time parse: positive integer, ≤ 600_000 cap to bound footgun typos, fallback 45_000. Inject as constructor option into `SessionGroupCoordinator`; never read `process.env` in hot path. Always log the resolved value at bootstrap as a structured `{event:"config.grace_ms.resolved", resolvedMs}` line so `running-build-vs-disk-build` style mistakes are diagnosable. Cross-ref: Deploy (doc surface in Task 15).

---

### 3. Orchestrator `session:exited` listener refactor

| | |
|---|---|
| **Domain** | Subprocess × Hunt × Fowler — *Make `intentionalKills` an absorbing state; feature envy on coordinator data* |
| **Ref** | `references/quality-subprocess.md` → Principle 4; `references/security.md` → Principle 7 |
| **Depends on** | Task 1 |

Replace the direct `companionBus.emit("group:degraded")` at `session-orchestrator.ts:499-516` with routing through `coordinator.applyEvent`. Mandatory ordering inside the new listener: (a) `if (intentionalKills.has(sessionId)) return;` as the **absolute first line** (EC-2 absorbing-kill invariant — resurrection-after-archive must be structurally impossible); (b) `if (relaunchExhaustedNotified.has(sessionId))` → emit `reconnect_failed` directly, skip the 45s grace timer entirely (no point arming a window for a session whose budget is already spent); (c) otherwise → `applyEvent({type:"reconnect_started", role, snapshot})`. Optionally extract a thin `GroupLifecycleSupervisor` for just this listener block (Fowler P5 feature-envy) — keep `session:cli-id-received` handling inline (one-line dispatch, no classification, extraction would be trivial-helper smell).

---

### 4. `session:cli-id-received` subscriber → `reconnect_ok` with identity binding

| | |
|---|---|
| **Domain** | Bun/Hono/TS Backend × Subprocess × Hunt — *Handshake-not-transport gate; bind reconnect identity* |
| **Ref** | `references/quality-backend.md` → Principles 1, 8; `references/quality-subprocess.md` → Principle 5; `references/security.md` → Principles 4, 7 |
| **Depends on** | Task 1 |

Reuse the existing `session:cli-id-received` event (verified at `event-bus-types.ts:12`, fires for both Claude `system.init` and Codex `initialize` ack — already the correct handshake-not-transport gate). Coordinator subscribes once with a **named** (not inline-closure) handler so it can be `companionBus.off`'d in `dispose()` — listener-count regression test pattern from `session-orchestrator.test.ts:391` applies. Handler is **sync** (no `async` — EventEmitter listener; async would orphan rejections). At entry: look up reconnect context by `sessionId`; assert the incoming `sessionId` matches the snapshot taken at `reconnect_started`. Mismatch → `reconnect_failed`, not a retry. This binds the reconnect to the exact half that disconnected; an unrelated CLI process race-handshaking on the same `sessionGroupId` cannot claim the slot. Wrap `applyEvent` in `try/catch`; guard-violation throws → structured warn, drop, never crash the bus.

---

### 5. `session:relaunch-failed` event + listener short-circuit

| | |
|---|---|
| **Domain** | Subprocess × Carmack — *Silent absence is the wrong primary signal* |
| **Ref** | `references/quality-subprocess.md` → Principles 4, 7 |
| **Depends on** | Task 1 |

Today `handleAutoRelaunch` returns `{ok:false}` on synchronous spawn failures (binary missing, observer-config load failure) without emitting any bus event. Without this fix, the group would drain the full 45s grace on a session that has zero chance of recovery. Add a typed `session:relaunch-failed: {sessionId, reason}` event; emit from `handleAutoRelaunch` on synchronous failure AND on `relaunchExhaustedNotified` exhaustion. Coordinator subscribes; if the group is in `reconnecting` → immediate `applyEvent({type:"reconnect_failed", role})`, cancelling the timer. The 45s window stays only as the backstop for "relaunch spawned but the new process hung silently."

---

### 6. Server-restart partial-pair grace in `reconcileCouncilGroups()`

| | |
|---|---|
| **Domain** | Subprocess × FS-JSON × Carmack — *Reconcile is decide → wait → act, not decide-and-act* |
| **Ref** | `references/quality-subprocess.md` → Principle 5; `references/quality-persistence.md` → Principle 3 (deliberate non-application) |
| **Depends on** | Task 1, Task 4 |

`reconcileCouncilGroups()` currently rejects partial pairs (one PID alive, one dead) — the surviving half becomes a lonely solo session, advertising no group. Change: when one half is PID-alive and one PID-dead, arm a grace timer on the same coordinator path (status enters `reconnecting`), allowing session-level relaunch to spawn the missing half and handshake within the window. **No `writeReconnectIntent` sentinel** — the next-boot PID snapshot is strictly more authoritative than any stale marker (PID reuse across restart can make a sentinel lie). Document this as a **deliberate** EC-8 gap in a comment in `group-reconciliation.ts` next to the four-state policy, so the next contributor doesn't add the sentinel "for symmetry" and forget the deletion paths.

---

### 7. Wire variant `group_reconnecting` — absolute deadline + surviving role + bounded payload

| | |
|---|---|
| **Domain** | Realtime/NDJSON Protocol × Hunt × Backend — *Protocol drift defence; group_id is a capability; EC-9 log content* |
| **Ref** | `references/quality-realtime.md` → Principles 4, 7; `references/security.md` → Principle 7; `references/quality-backend.md` → Principle 6 |
| **Depends on** | Task 1 |

Add `group_reconnecting` to `BrowserIncomingMessage`. Payload: `{type, sessionGroupId, survivingRole, deadlineMs}` — `deadlineMs` is an **absolute** wallclock (`Date.now() + grace`) chosen at transition time; absolute deadlines survive in-flight latency, sleeping tabs, and replay. `survivingRole` (not `deadRole`) — the UI's job is "your X is still here, waiting for Y"; the surviving half is the only side guaranteed to receive the frame. Omit `attempts` from v1 — hard-coded `1` invites future-drift; narrow shapes grow additively. The EC-9 log content for the three reconnect transitions: `event` + `sessionGroupId` + `role` + `attempts:1` + `latencyMs` — **never** `cliSessionId`, `observerPromptSha256`, or workspace absolute path (the raw recordings already carry that; duplicating to operational logs widens blast radius). `broadcastToGroup` asserts membership-at-emit-time, not subscribe-time — a browser that lost membership mid-flight cannot continue receiving reconnect frames. "We're back" on `reconnect_ok` recycles the existing synthetic `group_created` hydration variant (idempotent, already used at browser-subscribe per `ws-bridge.ts:896-995`); do not mint `group_active`.

---

### 8. Replay/seq classification + regression test

| | |
|---|---|
| **Domain** | Realtime/NDJSON Protocol × Carmack — *Sequence numbers + replay determinism* |
| **Ref** | `references/quality-realtime.md` → Principle 3 |
| **Depends on** | Task 7 |

`group_reconnecting` and the recycled `group_created` "we're back" emit must sit in the same replayability class as existing `group_degraded`/`group_created` (i.e. **replayable**), and assign seqs from the same monotonic stream. Otherwise a browser that disconnected mid-cycle and reconnects with `lastSeqSeen` could see only the resolution and end stuck in `reconnecting` forever — or only the start and end stuck after recovery. Add the integration test that drives `reconnect_started → reconnect_ok` while a browser is disconnected, reconnects with `lastSeqSeen`, and asserts the panel ends in `active`.

---

### 9. Browser `ws.ts` dispatch + `applyGroupEvent` slice reducer

| | |
|---|---|
| **Domain** | React/Web UI × Fowler — *Single mutation channel; mirror server reasoning* |
| **Ref** | `references/quality-frontend.md` → Principles 2, 4 |
| **Depends on** | Task 7 |

Add the `group_reconnecting` case to the `ws.ts` switch — body is one call to a new council-slice reducer `applyGroupEvent(sessionGroupId, event)`. Refactor existing per-status verbs (`setGroupStatus`, `setGroupDegraded`, etc.) into this single reducer mirroring the server. Symmetry with `coordinator.applyEvent`, single write path, future status additions are one-line cases. **Do not** plumb `deadlineMs` into the store (no consumer today; storing a field nobody reads becomes a stale-state lie on next cycle if not explicitly cleared). The existing `default:` arm at `ws.ts:1224-1227` (debug-log + drop) is correct for additive forward-compat; TypeScript exhaustiveness on `BrowserIncomingMessage` will catch missing cases at build time — EC-5's "reject unknown frame shapes" governs the CLI parser side, not the server→browser switch. Tests: slice reducer (`active → reconnecting → active` and `→ degraded`); ws.ts dispatch (input-keyed fake, not call-counter, per `feedback_parallel_test_fakes_keyed_by_input`); `observer-panel-state` end-to-end (the previously-unreachable branch becomes reachable).

---

### 10. Force-flush session-store debounce on group-status transitions

| | |
|---|---|
| **Domain** | FS-JSON Persistence × Carmack — *Debounce is a correctness window, not just an optimisation* |
| **Ref** | `references/quality-persistence.md` → Principle 2 |
| **Depends on** | Task 1 |

`session-store.ts:save()` debounces 150ms with no shutdown-flush, no critical-event bypass. A group-status flip followed within 150ms by SIGTERM (today's `gracefulShutdown` doesn't drain debouncers) loses the transition — UI on next boot reads a stale `reconnecting` state that no live timer will ever resolve. Add `flushAll()` to `SessionStore`. Route every group-status mutation through `saveSync` (not debounced `save`). The reconnect feature surfaces this as a new failure mode but the underlying race is pre-existing — fixing it is on the critical path.

---

### 11. `gracefulShutdown` wiring: cancel timers → flush stores → `shutdownAllGroups`

| | |
|---|---|
| **Domain** | Deploy × FS-JSON × Backend — *Healthcheck and graceful shutdown* |
| **Ref** | `references/quality-deploy.md` → Principle 8; `references/quality-persistence.md` → Principle 2 |
| **Depends on** | Task 10 |

Pre-existing P1 surfaced by Deploy review: `gracefulShutdown` at `web/server/index.ts:423-431` persists container state and exits, but **does not invoke `shutdownAllGroups`** despite that helper existing in `group-shutdown.ts`. Wire it. Order: (a) cancel every entry in coordinator's reconnect-timer map (so no fired timer races mid-archive trying to "recover" a group being torn down); (b) `SessionStore.flushAll()` (Task 10); (c) `shutdownAllGroups(coordinator, {timeoutMs})`; (d) persist container state; (e) exit. Document in the bootstrap that `--stop-timeout` ≥ shutdown-budget + reconnect-grace is required for clean reconnect-then-archive on rolling deploys.

---

### 12. Observer `lastReviewedCheckpointId` tracking + skipped-checkpoint catchup

| | |
|---|---|
| **Domain** | Willison (LLM Pipeline) × Carmack — *Context propagation: what state crosses the LLM boundary* |
| **Ref** | `references/quality-llm.md` → Principle 8 |
| **Depends on** | Task 4 |

During the reconnect window, the orchestrator may emit new `.council/checkpoints/<phase>.json` files the observer never read. When the observer comes back via `--resume`, today's `buildObserverContextManifest` diffs the latest checkpoint against the *immediately prior* on disk — silently bucketing the skipped phase's paths as `carried` (MAY-read) instead of `delta` (MUST-read). Persist `observerLastReviewedCheckpointId` per group; update on each `handleCouncilReview` validation. On `reconnect_ok` (and on `reconcileCouncilGroups()` partial-pair resolution), pass last-reviewed (not adjacent prior) as `previous` to `buildObserverContextManifest`. Emit structured EC-9 log `event:"council.observer.catchup"` with `lastReviewedCheckpointId` + `skippedCheckpointIds[]` + `caughtUpCheckpointId` on any non-trivial gap. UI-visible catchup marker is a Watchpoint (out of scope).

---

### 13. a11y polite live-region announcement on pill transition + behavioural tests

| | |
|---|---|
| **Domain** | a11y Auditor × Carmack — *Live regions, deliberately* |
| **Ref** | `references/quality-a11y.md` → Principles 1, 3, 4 |
| **Depends on** | Task 9 |

The `reconnecting` pill is becoming reachable; today's render has visible text + `aria-busy="true"` + decorative `aria-hidden` spinner — accessible name is fine, but transitions are silent. Wrap StatusPill in `role="status"` (or add an associated `aria-live="polite"` + `aria-atomic="true"` region) so a screen-reader user hears **one** announcement when `active → reconnecting` fires and **one** when it resolves to `active` or escalates to `degraded` — not on every render, not assertively (that role belongs to `BlockerBanner`/`DegradedBanner`). Keep the spinner decorative; never add `role="status"` or `aria-label` to the spinner itself — three concurrent signals for one state produces "loading loading loading." Behavioural tests in `ObserverPanel.test.tsx`: accessible name flips, spinner remains `aria-hidden`, live-region fires exactly once per transition (assert call-count, not "at-least-once"), focus is NOT moved on transition (active-element invariant), `toHaveNoViolations()` runs on BOTH the reconnecting render and post-resolve render.

---

### 14. `cc-info` color token for `reconnecting` pill

| | |
|---|---|
| **Domain** | Saarinen × Carmack — *Color via tokens; semantic roles distinct* |
| **Ref** | `references/quality-ui.md` → Principles 3, 5 |
| **Depends on** | Task 9 |

`ObserverPanel.tsx:80-82` currently paints the `reconnecting` pill in `text-cc-warning` / `border-cc-warning` — the **same** token as `degraded` at lines 122-123. Same color, different semantics (transient recovery vs settled error), separated only by motion. Swap `reconnecting` to `cc-info` (already defined; same family as `spawning` at lines 68-70 — transient-in-progress is the right semantic peer). Keep the existing `border-2 + border-X/30 + border-t-X + animate-spin` recipe at the default 1s linear cadence — the project's spinner convention; bespoke slow-down would drift this pill alone from every other spinner in the app.

---

### 15. Doc surface: env var + CLAUDE.md drift fix

| | |
|---|---|
| **Domain** | Deploy × Carmack — *Operator visibility; docs match code* |
| **Ref** | `references/quality-deploy.md` → Principle 4 |
| **Depends on** | Task 2 |

Add `COMPANION_GROUP_RECONNECT_GRACE_MS` to the canonical env-vars table in `docs/reference/cli-and-api.mdx` (lines 48-52 — next to the existing four `COMPANION_*` rows): type (positive integer ms), default (`45000`), one-line semantics. The `.env.example` files are E2E/PostHog-only and do NOT need an entry. Update CLAUDE.md: the line "`applyEvent` on the coordinator's state machine emits `group:degraded` / `group:exited`" is currently false; after Task 1 it becomes true — leave the line, but verify it after merge per `feedback_trust_diff_not_prose`.

---

## Risks & Watchpoints

- **Friedman — copy insufficient:** "Observer reconnecting" is a tooltip-less label, not an explanation. First-time users have no signal what reconnected, why, or how long. Out of scope this PR; **follow-up Linear ticket** to expand to "Observer process dropped — relaunching, findings paused" with subtle activity indicator (animated dot, not a countdown).
- **Friedman — no countdown = "is it stuck?":** Without a deadline visualisation, the pill is static for up to 45s. Acceptable v1 trade-off. **Follow-up:** at minimum a low-frequency activity indicator (pulsing dot / indeterminate progress on pill border) before any literal countdown — anxiety theatre is worse than ambiguity.
- **Friedman — `degraded`-after-`reconnect_failed` indistinguishable:** Same visual end-state and copy as fresh `degraded`. Users who watched the 45s recovery window will assume no attempt was made. **Follow-up:** differentiate the `DegradedBanner` content when prior state was `reconnecting` (e.g. "Reconnect attempt failed" line above the existing copy).
- **Saarinen — pill-row reflow:** `ObserverPanel.tsx:228` row has no `min-width`; transitions swap dot ↔ spinner + copy + conditional timestamp, producing visible jitter. **Follow-up:** reserve `min-width` sized to widest pill copy so the header doesn't reflow per checkpoint cycle.
- **a11y — `prefers-reduced-motion`:** `animate-spin` (spawning, reconnecting) and `animate-pulse` (reviewing) have no `motion-reduce:` variant. Pre-existing for `spawning`/`reviewing`; this PR makes the missing handling more frequently triggered. **Follow-up:** add `motion-reduce:animate-none motion-reduce:opacity-70` (or a static visual difference) to all three indicators, preserving state distinction for sighted users.
- **Subprocess — two-process window during `--resume` relaunch:** `cli-launcher.relaunch()` `Promise.race([proc.exited, setTimeout(2000)])` proceeds without confirming the old process died. The `proc.exited.then` handler at `cli-launcher.ts:758` has no "is this still the active process" guard. Under group-level grace, a stale exit from the dead process can arrive mid-handshake of the new one, ping-ponging `session:exited → reconnect_started → session:exited → reconnect_failed` while the new process is healthy. Pre-existing race; this PR does **not** widen it but adds visibility. **Follow-up:** tag each `Bun.Subprocess` with a monotonic spawn-instance id and guard the `proc.exited.then` handler against stale exits.
- **Willison — recording header tagging:** Each spawn writes a fresh JSONL file; reconnect → 2+ files for one logical observer session. Replay tests / post-hoc audits cannot reassemble a reconnect timeline. **Follow-up:** header line for observer recordings carries `sessionGroupId` + `sessionGroupRole:"observer"` + `observerPromptSha256` + monotonic `spawnAttempt`.
- **Willison — replay-corpus negative case:** No captured fixture today for "observer dropped mid-review then resumed." **Follow-up:** capture (or synthesise) JSONL pair where observer's recording ends mid-frame and a second recording picks up the same `checkpointId`; Vitest replay asserting exactly one validated review fans out, finding ids byte-stable, EC-9 supersession log fires once.
- **Deploy — ws.ts coverage cascade:** `web/src/ws.ts` is 1403 lines; the file-level coverage gate at `coverage-gate.yml:35-92` will re-evaluate the whole file when this PR adds the new case. Pre-PR: run `bun run test -- --coverage` locally, confirm `ws.ts` ≥ 80%. If under, the right answer is **not** to weaken the gate or exempt the file — extract the new case body into a sibling file `web/src/ws/handle-group-reconnect.ts` so only that small file is gated.
- **Deploy — HEALTHCHECK design intent:** No HEALTHCHECK exists today; no false-fail introduced. **Document for future:** `reconnecting` group status MUST count as healthy. Healthcheck must read `isReady` + bridge bind, never a group-status fan-out.
- **Hunt — rate-limit single cycle:** "one cycle only" is locked as policy; enforce as a **hard counter** in the state machine event payload, not a convention. After `reconnect_failed → degraded`, `disconnect_detected` on a `degraded` group is no-op-with-log, never re-entry — a flaky CLI flapping every 44s cannot park the server in a forever-reconnecting state.

---

## External Setup Required

| # | What | Why | Blocking task |
|---|------|-----|---------------|
| 1 | Optional: set `COMPANION_GROUP_RECONNECT_GRACE_MS` in deploy env if non-default grace is desired | Default 45_000 is sane for the locked scope; only operators tuning their reconnect tolerance need this | Task 2 (loader) + Task 15 (docs) |

Otherwise: all tasks implementable within the codebase. No new dependencies, no new ports, no new CI matrix expansion.

---

## Summary

| # | Task | Domain | Depends on |
|---|------|--------|------------|
| 1 | State machine side-effect channel + coordinator becomes sole mutator | Fowler | — |
| 2 | Bootstrap env config `COMPANION_GROUP_RECONNECT_GRACE_MS` | Bun/Hono/TS | — |
| 3 | Orchestrator `session:exited` listener refactor (intentionalKills first, exhausted skip, applyEvent) | Subprocess × Hunt × Fowler | 1 |
| 4 | `session:cli-id-received` subscriber → `reconnect_ok` with identity binding | Backend × Subprocess × Hunt | 1 |
| 5 | `session:relaunch-failed` event + short-circuit | Subprocess | 1 |
| 6 | Server-restart partial-pair grace in `reconcileCouncilGroups` (no sentinel) | Subprocess × FS-JSON | 1, 4 |
| 7 | Wire variant `group_reconnecting` + bounded payload + EC-9 log content | Realtime × Hunt × Backend | 1 |
| 8 | Replay/seq classification + reconnect-during-disconnected-browser test | Realtime | 7 |
| 9 | Browser `ws.ts` dispatch + `applyGroupEvent` slice reducer | React × Fowler | 7 |
| 10 | Force-flush session-store on group-status transitions | FS-JSON | 1 |
| 11 | `gracefulShutdown` wiring: cancel timers → flush → `shutdownAllGroups` | Deploy × FS-JSON × Backend | 10 |
| 12 | Observer `lastReviewedCheckpointId` tracking + skipped-checkpoint catchup log | Willison | 4 |
| 13 | a11y polite live-region announcement + behavioural tests | a11y | 9 |
| 14 | `cc-info` color token for `reconnecting` pill | Saarinen | 9 |
| 15 | Doc surface: env var in `cli-and-api.mdx` + verify CLAUDE.md drift line | Deploy | 2 |

---

## Verdict

The single most important architectural decision is **Task 1** — making `transition()` return a side-effect channel and `coordinator.applyEvent()` the sole mutator. Every other task either depends on it or stands to drift again without it. The CLAUDE.md drift this PR retires ("applyEvent emits group lifecycle events") is the symptom; the cause is that the state machine and the bus emission were physically separate, and convention floors don't enforce themselves. Task 1 makes them physically one — every future status, every future event, ships its bus emit and EC-9 log atomically because there's no other path.

Start at Task 1. After it, Tasks 2/3/4/5/7/10 are highly parallelisable. Save Tasks 8, 9, 13, 14 for the second wave (they all need Task 7 or 9 landed first).

**Pair-agent value:** during build, the Subprocess expert is the most useful sounding board for Tasks 3-6 (the `intentionalKills`/`relaunchExhaustedNotified`/two-process race surface is unforgiving and a single missed guard recreates the bug this PR was supposed to retire). For Task 9, the React expert pair is helpful but lower-stakes — the rendering side has fewer rake handles.
