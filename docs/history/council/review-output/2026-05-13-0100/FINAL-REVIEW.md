# Council Review (Aura): Observer Auto-Wake on Checkpoint Write — Story 2 AC#1

**Scope:** 24 files implementing the server-side observer auto-wake pipeline. Closes the central load-bearing gap in Council Mode (got-010). Implementation spans foundation types, pure builder + EC-7 wrapper, adapter seam + turn-state, orchestrator dispatch with 5-gate ladder, 1-slot newest-wins queue, reconnect-aware drain, sentinel-on-disk for restart idempotency, recorder schema bump, observer prompt v1 version-echo contract, frontend state-machine expansion (7→9 ladder slots), and a11y cadence response. Total: ~2100 LOC added across 481 lines on `session-orchestrator.ts` alone.

**Context:** This is the keystone change that makes Council Mode actually work end-to-end. Before this, the observer half spawned correctly but sat permanently idle (cliSessionId=null); the only successful prior review was hand-rolled. Five experts independently converged on the same architectural failure mode — **recovery-branch reachability**: features that ship "green" but are structurally unreachable in production. This dominates the P1 findings and is the central thing to address before merging.

**Council dispatched (11):** Hunt, Fowler, Bun/Hono/TS Backend, FS-JSON Persistence, Realtime/NDJSON Protocol, Subprocess Lifecycle, React/Web UI, a11y Auditor, Friedman (UX), Willison (LLM), Beck (Tests). Saarinen (no new visual surface) and Docker/GHA Deploy (no deploy surface) deliberately not dispatched.

---

## P1 — Fix Now

### 1. Cross-group checkpoint leakage — `handleCouncilCheckpoint` does not verify `payload.session_group_id` against the watcher's bound group

| | |
|---|---|
| **File** | `web/server/session-orchestrator.ts:1135-1170` (handleCouncilCheckpoint); `web/server/checkpoint-watcher.ts` entire file |
| **Council** | Hunt × Carmack — Principle 7 (Assertions as tripwires / access control) |
| **Ref** | `references/security.md` → Principle 7 |

**Finding:** Two council groups created against the same workspace cwd both attach watchers to the same `.council/checkpoints/` directory. The checkpoint file carries a `session_group_id` field validated by `parseCheckpointPayload`, but the handler never compares `payload.session_group_id` against the watcher's closure-bound `sessionGroupId` before invoking the dispatcher.

**Consequence:** A checkpoint emitted by group A is dispatched as a wake to group B's observer; the wake body's echo field shows `grpA` while the frame lands on `grpB`'s socket. The observer reviews code outside its own session's view; group B's sentinel records group A's `checkpoint_id`, silently poisoning B's idempotency state forever. Real cross-tenant leakage in a multi-group local-dev scenario the codebase explicitly supports.

**Fix:** At the head of `handleCouncilCheckpoint`, reject when `payload.session_group_id !== sessionGroupId` with a structured EC-9 drop log (`foreign_group_checkpoint`). Defense-in-depth: refuse to register a second watcher pointing at the same `<cwd>` at `startCouncilWatchers` entry.

---

### 2. Observer turn-state is not reset on CLI socket disconnect — permanently stuck `in-flight` after mid-turn drop

| | |
|---|---|
| **File** | `web/server/claude-adapter.ts:108-132` (attachWebSocket / detachWebSocket / handleTransportClose) |
| **Council** | Subprocess × Carmack — Principle 7 (Resource lifecycle is visible or leaked) |
| **Ref** | `references/quality-subprocess.md` → Principle 7 |

**Finding:** `observerTurnState` flips to `in-flight` on outbound wake and back to `idle` only when a `result` NDJSON frame arrives. None of `detachWebSocket`, `handleTransportClose`, or `disconnect` reset it. If the observer's CLI socket drops mid-turn (transient WS flap during a review), the adapter stays `in-flight` forever for the remaining process lifetime.

**Consequence:** Every subsequent wake attempt returns `{kind:"busy"}` regardless of actual observer state. The orchestrator's 1-slot queue fills and never drains; the `reconnect_ok` drain hook fires a dispatch that immediately re-queues. The observer is silently dead in the water across CLI transport-level reconnects (which is the common case the rest of the system was designed to recover from).

**Fix:** Reset `observerTurnState = "idle"` inside `detachWebSocket(ws)` (after the `cliSocket === ws` guard) and inside `handleTransportClose`. The contract becomes: turn-state is socket-bound; a fresh socket starts idle. Pair with a test that asserts state recovers after disconnect+reattach.

---

### 3. Checkpoint arriving during `reconnecting` is silently dropped, not deferred to `pendingCheckpoint`

| | |
|---|---|
| **File** | `web/server/session-orchestrator.ts:1182-1199` (dispatchObserverWake Gate 1 group_not_active skip) |
| **Council** | Subprocess × Carmack — Principle 2 (PIDs lie; observe protocol state) |
| **Ref** | `references/quality-subprocess.md` → Principle 2 |

**Finding:** Gate 1 returns `{kind:"skipped", reason:"group_not_active"}` when the group is in `reconnecting`. Unlike the `busy` case (which queues into `pendingCheckpoint` and drains on turn-done), the `reconnecting` skip discards the payload entirely. The drain hook on `reconnect_ok` (Task 5) only resurrects what was previously queued by `busy` — if no wake ever happened during the grace window, there's nothing to drain.

**Consequence:** Asymmetric semantics. A checkpoint during a 45s reconnect grace is lost; on recovery, the observer never gets it. The orchestrator's `lastCheckpoint` field is still mutated (line 1153-1154 runs BEFORE the dispatcher's Gate 1), so subsequent grounding uses a checkpoint the observer never reviewed.

**Fix:** When `groupRecord.status === "reconnecting"`, treat the case symmetrically to `observer_busy`: store payload in `pendingCheckpoint` with an EC-9 log distinguishing it from the busy-queue path. The existing `reconnect_ok` drain naturally picks it up.

---

### 4. `reviewing → reviewing-stalled` transition has no clock subscription — structurally unreachable in production

| | |
|---|---|
| **File** | `web/src/components/council/ObserverPanel.tsx:200-210`; `web/src/observer-panel-state.ts:80-103` |
| **Council** | React/Web UI × Carmack — Principle 1 (single source of truth for derived state) |
| **Ref** | `references/quality-frontend.md` → Principle 1 |

**Finding:** The deriver picks `reviewing-stalled` when `nowMs > lastCheckpointAt + wakeTimeoutMs`. The deriver is pure and `nowMs` is captured at render time. The panel re-renders only on state changes — checkpoint arrival, review arrival, dismiss action. **There is no `setInterval`, no `useTimer`, no clock-tick store-subscription.** In production, the panel renders `reviewing` at checkpoint arrival, then NEVER re-renders until the next checkpoint or review — meaning `reviewing-stalled` only appears coincidentally after some other state change.

**Consequence:** The state Task 11 explicitly added to "close the recovery-branch-reachability failure mode" ships green (the unit test passes by injecting `nowMs`) but is itself unreachable in production. Stuck wakes look indistinguishable from healthy reviewing. This is the exact failure mode the new state was meant to prevent — applied to itself.

**Fix:** Either (a) subscribe the panel to a 1s clock tick via `useEffect`+`setInterval` while in `reviewing` state, cleared on transition; or (b) emit a server-side wake-stalled timeout event after `wakeTimeoutMs` so the slice's state change drives the re-render. Option (b) preserves "single mutation channel via ws.ts" discipline.

---

### 5. `StatusPill` switch is non-exhaustive — `reviewing-stalled` and `queued-dropped` render as empty header

| | |
|---|---|
| **File** | `web/src/components/council/ObserverPanel.tsx` (StatusPill component) |
| **Council** | Friedman × Carmack — Principle 2 (Design all five screen states) |
| **Ref** | `references/quality-ux.md` → Principle 2 |

**Finding:** Task 11 extended `ObserverPanelState` from 7 to 9 discriminated variants. The `StatusPill` switch was not extended in lockstep. On a `reviewing-stalled` or `queued-dropped` state the switch falls through to default/empty, rendering an empty header where the pill label should be.

**Consequence:** When the stalled or queued-dropped state actually IS reached (after fixing #4), the UI silently shows a blank pill — sighted users see nothing, SR users hear nothing. The user-facing communication value of these new states is zero until the switch is exhausted. Recovery-branch-reachability defect at the render layer (sibling of #4 at the derivation layer).

**Fix:** Add `case "reviewing-stalled"` and `case "queued-dropped"` to the StatusPill switch with explicit user-facing copy. Add a TypeScript exhaustiveness check via `const _: never = state;` in the default branch — refuses to compile when a new state is added without a matching case.

---

### 6. Promised restart-gap catchup scan is missing — checkpoint→wake pipeline silently under-wakes across crashes

| | |
|---|---|
| **File** | `web/server/session-orchestrator.ts:545-595` (reconcileCouncilGroups + startCouncilWatchers) |
| **Council** | FS-JSON Persistence × Carmack — Principle 7 (Replay determinism) + EC-8 (sentinel-before-sweep — accepted convention) |
| **Ref** | `references/quality-persistence.md` → Principle 7 |

**Finding:** Plan Task 6 promised: "On `SessionOrchestrator.initialize()`, after restoring `councilWatchers`, reconcile: read the highest-sequence checkpoint file present in `.council/checkpoints/` for each group; compare against the sentinel; if there's a gap, fire one wake on resume." The sentinel write + pre-dispatch sentinel check landed, but **the reconcile scan was never implemented**. `fs.watch` only emits events for NEW filesystem activity post-attach, not for existing files. The `last_woken_sequence` field on the sentinel is dead weight without a consumer that compares it to disk state.

**Consequence:** Server crashes between checkpoint-file-write and wake-send produce a permanent gap: the observer never reviews that checkpoint. The wake is silently lost. The on-disk checkpoint is durable but unreachable from the post-restart pipeline. Story 2 AC#1's "≥95% of newly created Council Mode sessions produce at least one observer review within the first orchestrator-driven phase" success metric is compromised under realistic restart scenarios.

**Fix:** In `reconcileCouncilGroups` (around the same loop that rebuilds watcher entries), scan `.council/checkpoints/*.json` per group, parse each, find the highest-sequence valid checkpoint, compare its id+sequence against the sentinel's `last_woken_*`. On gap → enqueue a single wake via the existing dispatcher. Idempotent + EC-8-style.

---

### 7. No EC-6 replay fixture pins the wake `user` frame's on-wire shape

| | |
|---|---|
| **File** | `web/server/__fixtures__/` (missing); `web/server/claude-adapter.test.ts` (no wake fixture test) |
| **Council** | Realtime × Willison × Beck — Principle 7 (replay tests for load-bearing protocol parsers; EC-6 convention floor) |
| **Ref** | `references/quality-realtime.md` → Principle 7; `references/quality-llm.md` → Principle 4; `references/quality-testing.md` → Principle 9 |

**Finding:** Three independent experts (Realtime, Willison, Beck) converged on this. EC-6 (accepted convention) mandates replay-based fixture tests for any load-bearing protocol surface. The wake frame is the **first** server-initiated `user` NDJSON frame in the codebase and is read by the observer's stream-json parser. No captured fixture exists under `web/server/__fixtures__/observer-wake/`. The builder is tested at the unit level, but no test asserts the round-trip bytes parse cleanly back through the observer-side reader.

**Consequence:** A future change to the wake-builder's escaping logic, content-block shape, or NDJSON appending can silently produce a frame the observer parses degenerately — observer emits a review with wrong checkpoint id, browser dedup hides the symptom, the regression takes weeks to surface. EC-6 exists precisely to prevent this.

**Fix:** Capture one wake send by running a smoke test that creates a council group and writes a checkpoint. Pin the resulting JSONL line from `~/.companion/recordings/` under `web/server/__fixtures__/observer-wake/claude-v1.jsonl`. Write a vitest that loads the fixture, asserts the line parses to one JSON object with `type==="user"`, `message.content[0].type==="text"`, body contains exactly one ` ```json ` fence whose content validates against `CheckpointPayload`. Per convention floor.

---

### 8. `handleOutgoingUserMessage` (string content) vs `sendUserFrameFromServer` (array content) — asymmetric wire shape

| | |
|---|---|
| **File** | `web/server/claude-adapter.ts:275-302` (browser path, string content) vs `claude-adapter.ts:935-1040` (server path, array-of-one-text-block) |
| **Council** | Realtime × Carmack — Principle 7 (tolerate polymorphic-by-spec; reject unknown discriminators) |
| **Ref** | `references/quality-realtime.md` → Principle 7 |

**Finding:** Browser-relayed `user` frames send `message.content` as a plain `string`. Server-synthesized wake frames send `message.content` as an array containing one `{type:"text", text}` block. The Claude SDK accepts both shapes by spec, but the asymmetry between the two producers within a single adapter is undocumented and untested. No assertion pins either side.

**Consequence:** A future "normalisation" refactor that "fixes" one path to match the other could silently break the observer's parse OR the browser path's parse — neither has an explicit contract test. The observer prompt (v1) doesn't specify which shape it requires, so a tolerant CLI hides the divergence until model behaviour shifts.

**Fix:** Document the chosen shape per path with a `// content: <shape>` comment at each `JSON.stringify({...})` call site and pin both shapes with a test asserting the exact serialised form. Pair with #7's fixture. Best to converge on the array shape (canonical SDK) for the browser path too, but that's a separate refactor.

---

### 9. `wakeTimeoutMs` is REQUIRED on `group_created` — wire break for in-flight clients and event-buffer replay

| | |
|---|---|
| **File** | `web/server/session-types.ts:371-382` (group_created type, wakeTimeoutMs as required) |
| **Council** | Realtime × Carmack — Principle 7 (EC-5: tolerate polymorphic-by-spec fields; reject unknown DISCRIMINATORS, never required-field bumps without versioning) |
| **Ref** | `references/quality-realtime.md` → Principle 7 |

**Finding:** Task 9 added `wakeTimeoutMs` as a required field on the `group_created` wire frame (not optional). Older buffered `group_created` events sitting in `eventBuffer` for replay-on-reconnect now fail the type guard at the browser side (TypeScript-side narrowing) — replay path silently drops them or unsafely-casts. Other optional additions (`reason`, `supersededCheckpointIds`) were correctly marked optional; this one wasn't.

**Consequence:** On every server upgrade across the boundary, browser tabs that buffered a pre-Task-9 `group_created` frame for replay will fail to hydrate the group's `wakeTimeoutMs` (defaulted to undefined). The deriver falls back to a literal `90_000` hard-coded constant, so behaviour survives but the "server-published, frontend-derived" discipline is broken silently.

**Fix:** Make `wakeTimeoutMs` optional on the wire frame with a frontend fallback to a constant (already in the deriver via `?? 90_000`). The runtime check stays single-sourced server-side; the wire stays additive.

---

### 10. `lastIdsRef` resets across mount/unmount — re-announces existing findings on every panel collapse/expand

| | |
|---|---|
| **File** | `web/src/components/council/FindingsLog.tsx:200-220` (useRef + useEffect[findings]) |
| **Council** | a11y × Carmack — Principle 3 (ARIA live regions, announce streaming content deliberately) |
| **Ref** | `references/quality-a11y.md` → Principle 3 |

**Finding:** `lastIdsRef` is a `useRef<Set<string>>(new Set())` — initial value is fresh on every component mount. When the user collapses and re-expands the ObserverPanel (a common interaction), FindingsLog unmounts and remounts; the ref resets to empty; the useEffect runs and sees ALL current findings as "new"; the summary announcer fires with a stale count.

**Consequence:** SR users hear "Observer review complete: 3 blockers, 5 notes" every time they collapse/expand the panel — the announcement is wrong (those findings aren't new) AND disruptive. Worse than the original `aria-live="polite"` cadence problem the task aimed to fix.

**Fix:** Move `lastIdsRef` ownership into the council slice (persistent across mount cycles, keyed by sessionGroupId) — or persist the summary announcement state. Alternative: render the announcer only inside `useEffect` body that already had the previous-ids snapshot from the slice, so first-mount with prior findings = silent.

---

### 11. `dropped` semantic is taught only in the per-cycle wake body, never in the observer system prompt

| | |
|---|---|
| **File** | `.council/prompts/observer-system.md` (system prompt v1); `web/server/observer-prompt.ts:280-310` (buildObserverWakePayload body composition) |
| **Council** | Willison × Carmack — Principle 1 (LLM-shaped content; renderer is last line of defence applied to producer) |
| **Ref** | `references/quality-llm.md` → Principle 1 |

**Finding:** The observer's contract for `delta` / `carried` / `dropped` is described only in the wake body's prose preamble ("Read only paths under `delta` and `carried`; `dropped` are out of scope"). The system prompt at spawn time defines the role + output schema but never mentions the manifest sections. The wake-body description is per-cycle; the system prompt is per-spawn — they have different lifetimes.

**Consequence:** A future change to the wake body's prose (e.g. shortening for token budget) could remove the `dropped` exclusion language; the observer would then re-read dropped paths because nothing else in its training context forbids them. The grounding validator catches outputs that cite dropped paths, but the observer's READ activity (Read tool calls during the turn) is not gated server-side — it consumes the wake at the model layer and the EC-7 wrapper only filters what the WAKE shows it, not what its Read tool can access.

**Fix:** Move the `delta`/`carried`/`dropped` semantic into the observer system prompt's "Your contract" section so it ships with every spawn and survives wake-body edits. The wake body becomes a manifest carrier, not a contract carrier.

---

### 12. Version-mismatch downgrade — "absent echo is back-compat" branch is silently fail-open after migration

| | |
|---|---|
| **File** | `web/server/session-orchestrator.ts:1534-1563` (handleCouncilReview wake-echo check) |
| **Council** | Willison × Persistence × Carmack — Principle 4 (validator on output) |
| **Ref** | `references/quality-llm.md` → Principle 4 |

**Finding:** `handleCouncilReview` validates `observer_wake_payload_version_echo` only when the field is present (`if (wakeEcho !== undefined && wakeEcho !== ...)`). The Task 10 plan said this was for "back-compat with v1 reviews that predate the contract". But the producer of v1 reviews is the orchestrator-bundled observer system prompt, which WAS updated to require the echo. There is no legitimate stream of "v1 reviews" — only buggy/cheating reviews. The optionality is a fail-open for exactly the case the validator was added to catch.

**Consequence:** A future bump of `OBSERVER_WAKE_PAYLOAD_VERSION` to 2 with the v1 prompt still in place produces reviews that omit the echo (the v1 prompt doesn't teach it). The validator silently passes them. The Task 10 defense ships as decoration.

**Fix:** Make the echo MANDATORY: missing field is the same as mismatch → downgrade all findings. Document this contract in `observer-system.md`. Mark the optionality on the type as "deprecated, will become required in v1.1 of the system prompt" or remove it entirely once a migration window passes.

---

### 13. Keystone surfaces have zero direct behavioural tests — `dispatchObserverWake`, `sendUserFrameFromServer`, `council-wake-sentinel.ts`

| | |
|---|---|
| **File** | `web/server/session-orchestrator.test.ts` (no new dispatchObserverWake table); `web/server/claude-adapter.test.ts` (no sendUserFrameFromServer outcome tests); no `web/server/council-wake-sentinel.test.ts` exists |
| **Council** | Beck × Carmack — Principle 4 (test what might break — high-risk path untested) |
| **Ref** | `references/quality-testing.md` → Principle 4 |

**Finding:** Three of the most load-bearing new surfaces in this PR have no direct behavioural tests:
- `dispatchObserverWake` (8 skip reasons + dispatched + failed = 10 outcome branches) — covered only by a static-grep canary asserting the call site exists in the handler body. The behavioural happy/sad table promised by Beck's plan recommendation was not landed.
- `sendUserFrameFromServer` (5 outcome variants: sent/busy/socket_disconnected/backpressure/failed) — no test asserts any of them.
- `council-wake-sentinel.ts` is a NEW module with read/write/parse helpers and has no test file at all.

**Consequence:** The full test suite stays green at 5604/5604 across changes to these surfaces — the assertions can be silently weakened or inverted and the suite stays green. Per memory `feedback_verify_test_bodies_not_just_names`: SHIP-BLOCKER tests need bodies, not just coverage of names that happen to be referenced from integration tests.

**Fix:** Three additions: (a) extend `session-orchestrator.test.ts` with a `describe("dispatchObserverWake", ...)` block enumerating each outcome row (Beck Council Rec 1); (b) add `claude-adapter.test.ts` cases for each `ObserverWakeSendOutcome` variant with an injected mock `cliSocket` whose `readyState`/`bufferedAmount`/`send` can be staged; (c) create `council-wake-sentinel.test.ts` with read+write+parse fixture tests including the parse-returns-null-on-corruption case.

---

## P2 — Fix Soon

### 14. Sentinel write failure logs at WARN but doesn't degrade the group — second-restart double-wake hole

| | |
|---|---|
| **File** | `web/server/session-orchestrator.ts:1276-1295` (sentinel write try/catch on "sent" outcome) |
| **Council** | FS-JSON Persistence × Carmack — Principle 3 (sentinel-before-sweep on every exit path) |
| **Ref** | `references/quality-persistence.md` → Principle 3 |

**Finding:** When `writeCouncilWakeSentinel` throws (disk full, permissions), the handler logs `council.wake.sentinel_write_failed` and returns dispatched. The wake was sent but the sentinel doesn't record it. On a subsequent restart, the missing-sentinel branch falls through to "no record" → the same checkpoint can wake the observer again if the watcher re-emits.

**Fix:** On sentinel write failure, either roll back to a `skipped: sentinel_write_failed` outcome AND let the next checkpoint reattempt (idempotent), or degrade the group to a manual-intervention state with a structured incident log. The current "log and pretend" is the worst of both.

---

### 15. `markActivity` not registered when send is gated out — idle-kill timer races with wake gating

| | |
|---|---|
| **File** | `web/server/claude-adapter.ts:985-1040` (sendUserFrameFromServer — markActivity called only on success) |
| **Council** | Subprocess × Carmack — Principle 6 (idle-kill timing & race-with-attach) |
| **Ref** | `references/quality-subprocess.md` → Principle 6 |

**Finding:** `onActivityUpdate?.()` runs only inside the `kind: "sent"` branch. When the dispatcher returns busy/socket_disconnected/backpressure, no activity is registered. An observer that's been mid-turn for hours (long review) with intervening busy-gated checkpoint arrivals still ticks toward the 4h idle-kill.

**Fix:** Move `onActivityUpdate?.()` to run on every dispatcher invocation, not only on successful send. Any wake attempt — even if gated out — is evidence the orchestrator is alive and the group is producing work; activity should be registered.

---

### 16. `.council/state/<groupId>-wake.json` survives group archive — orphan sentinel accumulation

| | |
|---|---|
| **File** | `web/server/session-orchestrator.ts:archiveGroup` (no sentinel cleanup); `council-wake-sentinel.ts` (no delete helper) |
| **Council** | FS-JSON Persistence × Carmack — Principle 3 (orphan rows / sentinel cleanup) |
| **Ref** | `references/quality-persistence.md` → Principle 3 |

**Finding:** Group archive (user-initiated or shutdown) deletes the group's WS state but leaves `.council/state/<groupId>-wake.json` on disk. Over many sessions the directory accumulates orphan sentinels.

**Fix:** Add `deleteCouncilWakeSentinel(workspaceCwd, sessionGroupId)` helper. Call from the archive path AND the group-exited bus listener (same place `stopCouncilWatchers` and `councilGroupMeta.delete` already fire). Best-effort fs delete; absorb ENOENT.

---

### 17. Backpressure-as-drop has no per-group retry signal — wake is lost until next checkpoint

| | |
|---|---|
| **File** | `web/server/claude-adapter.ts:976-980` (backpressure refusal) + `web/server/session-orchestrator.ts:1232-1252` (skipped:backpressure log) |
| **Council** | Realtime × Carmack — Principle 4 (per-receiver ordering must be preserved) |
| **Ref** | `references/quality-realtime.md` → Principle 4 |

**Finding:** Backpressure returns `{kind:"backpressure"}` and the dispatcher logs+skips. There is no retry attempt and no queueing — the wake is lost until the next checkpoint write. The 1MB threshold is generous, so this rarely fires, but when it does the observer silently misses a review cycle.

**Fix:** On backpressure, store the payload in `pendingCheckpoint` (same slot as busy-gated). Add a one-shot 100ms retry timer on the watcher entry that re-attempts dispatch once when fired; on subsequent backpressure, fall through to the timeout-fires-when-next-checkpoint-arrives normal flow.

---

### 18. 90s `wakeTimeoutMs` will false-trip on legitimate long reviews (Opus + rich manifest)

| | |
|---|---|
| **File** | `web/server/council-types.ts:34` (OBSERVER_WAKE_TIMEOUT_MS) |
| **Council** | Friedman × Carmack — Principle 6 (state machines: each transition must be observable AND reasonable under load) |
| **Ref** | `references/quality-ux.md` → Principle 6 |

**Finding:** 90 seconds is a tight bound for Opus reviewing a manifest with 30+ files. Real-world Carmack-Council reviews on this same codebase have run 2-3 minutes per phase. The deriver will flip to `reviewing-stalled` for every legitimate long review, blasting false alarms.

**Fix:** Raise to 300s (5 minutes) as the v1 ship value. The bound is a UX cue, not a correctness gate — a stuck observer takes longer to surface, which is acceptable vs the false-alarm cost. Tune via incident-driven measurement.

---

### 19. `wake_version_mismatch` downgrade renders incorrect rationale chip in FindingsLog

| | |
|---|---|
| **File** | `web/src/components/council/FindingsLog.tsx` (DowngradedChip switch); `web/src/types.ts:148-150` (downgradeReason union) |
| **Council** | Friedman × Carmack — Principle 9 (trust through reasoning visibility) |
| **Ref** | `references/quality-ux.md` → Principle 9 |

**Finding:** The new `wake_version_mismatch` reason was added to the union but the `DowngradedChip` component (which renders the human-readable rationale) was not updated. Findings downgraded due to schema mismatch render a generic "downgraded" chip without explaining why, or fall through to the wrong existing label ("not in modified files").

**Fix:** Add the third case to the `DowngradedChip` switch with copy like "Schema mismatch — review may be stale". Pair with a test that renders a downgraded finding for each reason and asserts distinct chip text.

---

### 20. Empty-string `<div role="status">` on first mount risks VoiceOver "blank" announcement

| | |
|---|---|
| **File** | `web/src/components/council/FindingsLog.tsx:225-235` (summaryAnnouncer JSX with `{announcement}` initially `""`) |
| **Council** | a11y × Carmack — Principle 3 (ARIA live regions, deliberate announcement) |
| **Ref** | `references/quality-a11y.md` → Principle 3 |

**Finding:** The summary announcer renders `{announcement}` from `useState<string>("")`. Some SR engines (VoiceOver historically) announce "blank" or "empty" when a live region renders an empty string for the first time.

**Fix:** Conditionally render the announcer only when `announcement.length > 0` (i.e. omit the entire `<div>` until there's something to announce). Pair with the cross-mount-cycle fix from #10 so the announcer doesn't render-then-disappear on collapse.

---

### 21. Bus listener `observer:turn-done` reverse-mapping is O(N×N); pattern repeats 4× in `initialize()`

| | |
|---|---|
| **File** | `web/server/session-orchestrator.ts:404-422, 880-892, 1280-1295` (reverse-map loops over `councilGroupMeta`) |
| **Council** | Backend × Carmack — Principle 3 (state minimisation + index discipline) |
| **Ref** | `references/quality-backend.md` → Principle 3 |

**Finding:** Four bus listeners (`observer:turn-done`, `session:cli-id-received`, `session:exited`, and others) each iterate `councilGroupMeta` to reverse-map sessionId→groupId. Same pattern, 4 places. Each is O(active-group-count) per event.

**Fix:** Maintain a `groupBySessionId: Map<sessionId, sessionGroupId>` index on the orchestrator, populated alongside `councilGroupMeta` writes and cleared on `group:exited`. The frontend slice already has this pattern (`groupBySessionId`); mirror it server-side.

---

## P3 — Consider

### 22. `claim` field validator accepts fence-triplet and CR/LF — echo into orchestrator chat

| | |
|---|---|
| **File** | `web/server/council-types.ts:108-117` (isBoundedText), 312 (parseObserverReviewPayload uses for claim) |
| **Council** | Hunt × Carmack — Principle 1 (NDJSON line-discipline injection sibling) |

`isBoundedText` allows `\n`, `\r`, `\t` (intentional for code excerpts in claims) BUT permits backtick triplets. The observer's review `claim` field is echoed into the orchestrator's chat surface; an observer that drifts and emits a claim like ` ```bash\nrm -rf /\n``` ` renders as executable-looking markdown in the chat. The renderer already escapes via JSX, but the visual confusion is real. Consider stripping fence-triplets at the boundary OR documenting that the chat renderer must never `dangerouslySetInnerHTML` claim content.

---

### 23. `WakeDispatchOutcome.skipped.reason` and `BridgeObserverWakeOutcome.kind` overlap by string identity but not by type

| | |
|---|---|
| **File** | `web/server/session-orchestrator.ts:212-230` (WakeDispatchOutcome) + `web/server/ws-bridge.ts:62-71` (BridgeObserverWakeOutcome) |
| **Council** | Backend × Carmack — Principle 8 (Type safety at the boundary) |

`"socket_disconnected"`, `"backpressure"` appear as `BridgeObserverWakeOutcome.kind` values AND as `WakeDispatchOutcome.skipped.reason` values. The current code switches on bridge `.kind` and maps to dispatcher `.reason` via a hand-coded mapping. If one side renames, the other compiles but maps incorrectly. Extract a shared `WakeFailureReason` union both types reference, OR use TypeScript's `satisfies` to pin the mapping.

---

### 24. `findings` slice returns fresh array reference on `appendObserverReview` even when zero new findings are appended

| | |
|---|---|
| **File** | `web/src/store/council-slice.ts:285-295` (appendObserverReview's findings.set) |
| **Council** | React/Web UI × Carmack — Principle 1 (referential stability for selector cache) |

When `appendObserverReview` is called for a re-emitted review (server replay) and every finding id is already in the deduper, the loop produces an empty `newOnes` array but the slice still writes `findings.set(sessionGroupId, [...prior, ...newOnes])` — a fresh array reference with the same content. Selectors keyed on this re-render unnecessarily, including the FindingsLog summary announcer's effect. Guard: only call `findings.set(...)` when `newOnes.length > 0`.

---

### 25. `session-orchestrator.ts` size watchpoint — 481 LOC added in one change

| | |
|---|---|
| **File** | `web/server/session-orchestrator.ts` (~1700 LOC after this change) |
| **Council** | Fowler × Carmack — Principle 7 (fear-zones in the codebase) |

Not a finding yet; an explicit watchpoint. The file now hosts: group lifecycle, watcher arming, dispatcher with 5-gate ladder, drain hook, sentinel I/O, version-echo validation, 4 reverse-mapping bus listeners. At the next change touching this file, evaluate whether to extract `observer-wake-pipeline.ts` (dispatcher + drain + sentinel I/O) into its own module. The economic test fires when the next reviewer says "I'm afraid to touch this file".

---

## Summary

| # | Finding | Severity | Council | Fix effort |
|---|---------|----------|---------|------------|
| 1 | Cross-group leakage — no payload.session_group_id check | P1 | Hunt | ~10 lines + test |
| 2 | observerTurnState stuck on socket disconnect | P1 | Subprocess | ~3 lines + test |
| 3 | Checkpoint during `reconnecting` silently dropped | P1 | Subprocess | ~10 lines + test |
| 4 | `reviewing-stalled` has no clock subscription (unreachable in prod) | P1 | React | 1h: interval + cleanup |
| 5 | StatusPill switch non-exhaustive — empty header for new states | P1 | Friedman | ~20 lines + exhaustive type check |
| 6 | Restart-gap catchup scan promised but never implemented | P1 | Persistence | ~40 lines + test |
| 7 | No EC-6 replay fixture for wake frame | P1 | Realtime × Willison × Beck | 1h: capture + pin + test |
| 8 | string-content vs array-content wire asymmetry | P1 | Realtime | doc + 1 pinned test |
| 9 | `wakeTimeoutMs` required field breaks event-replay | P1 | Realtime | 1 line + fallback |
| 10 | lastIdsRef resets on collapse/expand — re-announces | P1 | a11y | move state to slice |
| 11 | `dropped` semantic missing from observer system prompt | P1 | Willison | edit prompt file |
| 12 | Version-mismatch echo silently fail-open on absent | P1 | Willison × Persistence | flip optional → required |
| 13 | Keystone surfaces zero direct tests (dispatcher + sentinel + adapter) | P1 | Beck | 3 test files, ~200 LOC |
| 14 | Sentinel write failure → second-restart double-wake hole | P2 | Persistence | error-path policy |
| 15 | markActivity not registered on gated-out send | P2 | Subprocess | move 1 call site |
| 16 | Sentinel orphan accumulation across archives | P2 | Persistence | delete helper + 2 call sites |
| 17 | Backpressure-as-drop with no retry signal | P2 | Realtime | retry timer in 1-slot queue |
| 18 | 90s wakeTimeoutMs too tight for Opus rich manifests | P2 | Friedman | 1 line + telemetry |
| 19 | `wake_version_mismatch` chip rationale wrong | P2 | Friedman | extend DowngradedChip switch |
| 20 | Empty-string role=status risks "blank" announcement | P2 | a11y | conditional render |
| 21 | Reverse-mapping O(N²) repeated 4× in initialize() | P2 | Backend | new index Map |
| 22 | `claim` validator allows fence-triplet | P3 | Hunt | strip at boundary |
| 23 | WakeDispatchOutcome / BridgeObserverWakeOutcome type drift | P3 | Backend | extract shared union |
| 24 | findings slice fresh-array on zero-new dedup | P3 | React | guard 1 line |
| 25 | session-orchestrator.ts size watchpoint | P3 | Fowler | watchpoint, no action |

## Verdict

This is a substantial, structurally-sound implementation that hits the central architectural decision (AP-1 DI seam at adapter level + WakeDispatchOutcome discriminated union) the plan called out as the keystone. The plumbing is solid: typecheck clean, 5604 tests green, EC-1 through EC-9 honoured, no convention violations.

**But it ships with a load-bearing failure mode that five independent experts converged on: recovery-branch reachability.** Tasks 6 (restart-gap scan), 11 (reviewing-stalled state), and one full half of Task 5 (checkpoint-during-reconnecting) are present in code but structurally unreachable in production. The StatusPill switch is non-exhaustive for the new states. The sentinel's `last_woken_sequence` field is dead weight without a reader. The keystone dispatcher has no behavioural tests — only a static-grep canary that catches call-site disappearance, not behaviour drift. This is the same class of defect that the Task 6 fix on the prior branch (`fix/task-6-identity-rebinding`, commit 2d2ff55) corrected for the partial-pair restart path — the pattern is now appearing in the auto-wake pipeline itself.

**Start with #1 (cross-group leakage)** — it's the only finding with concrete data-corruption potential and the fix is 10 lines. **Then #4, #5, #6, and #11 together** — those four are the recovery-branch class and they fix in one focused half-day. **Then #13** — without the dispatcher test table, every subsequent change to this pipeline carries silent-regression risk.

The most critical lane for this codebase right now is **Realtime/NDJSON Protocol** — three of the P1 findings sit in that domain (EC-6 fixture, content shape asymmetry, wire-required field), and the wake frame is the first server-initiated NDJSON path in the codebase. A pair-agent with Realtime expertise during the fix pass would catch the asymmetries the most quickly.

Carmack would say: the architecture is right, the discipline is consistent, but the recovery branches are not reachable. Ship the fix pass before the merge.

---

## Findings Breakdown by Expert

| Expert | P1 | P2 | P3 | Total | Key Areas |
|--------|----|----|----|-------|-----------|
| Hunt (Security) | 1 | 0 | 1 | 2 | cross-group leakage, claim fence-triplet |
| Fowler (Refactoring) | 0 | 0 | 1 | 1 | session-orchestrator.ts size watchpoint |
| Bun/Hono/TS Backend | 0 | 1 | 1 | 2 | reverse-map O(N²), outcome type drift |
| FS-JSON Persistence | 1 | 2 | 0 | 3 | restart-gap catchup, sentinel write failure, orphan accumulation |
| Realtime/NDJSON | 3 | 1 | 0 | 4 | EC-6 fixture, content asymmetry, wire-required, backpressure retry |
| Subprocess Lifecycle | 2 | 1 | 0 | 3 | turn-state stuck, reconnecting drop, markActivity gate |
| React/Web UI | 1 | 0 | 1 | 2 | reviewing-stalled clock, findings dedup churn |
| a11y Auditor | 1 | 1 | 0 | 2 | lastIdsRef cross-mount, empty role=status |
| Friedman (UX) | 1 | 2 | 0 | 3 | StatusPill non-exhaustive, 90s timeout, wake_version_mismatch chip |
| Willison (LLM) | 2 | 0 | 0 | 2 | dropped semantic missing, echo fail-open |
| Beck (Tests) | 1 | 0 | 0 | 1 | keystone surfaces untested (collapsed 3 P1s into 1) |
| **TOTAL** | **13** | **8** | **4** | **25** | |

**Cross-references:**
- Finding #7 (EC-6 fixture) — Realtime × Willison × Beck triple convergence
- Finding #12 (echo fail-open) — Willison × Persistence
- Findings #4 + #5 + #6 + #11 — recovery-branch-reachability cluster (React + Friedman + Persistence + Willison)

**Review output written to:** `.council/review-output/2026-05-13-0100/FINAL-REVIEW.md`

**Expert output files:**
- Hunt: `.council/review-output/2026-05-13-0100/hunt.md`
- Fowler: `.council/review-output/2026-05-13-0100/fowler.md`
- Bun/Hono/TS: `.council/review-output/2026-05-13-0100/backend-ts.md`
- FS-JSON: `.council/review-output/2026-05-13-0100/persistence.md`
- Realtime/NDJSON: `.council/review-output/2026-05-13-0100/realtime.md`
- Subprocess: `.council/review-output/2026-05-13-0100/subprocess.md`
- React/Web UI: `.council/review-output/2026-05-13-0100/react-ui.md`
- a11y: `.council/review-output/2026-05-13-0100/a11y.md`
- Friedman: `.council/review-output/2026-05-13-0100/friedman.md`
- Willison: `.council/review-output/2026-05-13-0100/willison.md`
- Beck: `.council/review-output/2026-05-13-0100/beck.md`
