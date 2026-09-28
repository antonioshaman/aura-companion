# Council Plan (Aura): Observer Auto-Wake on Checkpoint Write

**Scope:** Close Council Mode Story 2 AC#1 — when the orchestrator writes a valid checkpoint file, the server pushes a `user` NDJSON frame to the observer's CLI socket so the observer runs its one-shot review-and-emit contract. The existing review-watcher pipeline takes over from there. claude+claude pairing only.

**Context:** Today both halves of a Council pair spawn correctly (verified live via `ps -p PID -o cmd`: observer carries `--append-system-prompt`, `--allowedTools Read Grep Glob Write`, `--disallowedTools Bash Edit …`, `observerPromptSha256` stamped on `SdkSessionInfo`). But `handleCouncilCheckpoint` (`web/server/session-orchestrator.ts:997-1025`) only emits `group:checkpoint` to the bus → browsers; nothing pushes a `user` message into the observer CLI socket. Grep `web/server/` for `sendToCli|cliSocket\.send|forwardManifest|invokeObserver` returns zero matches. Observer sits idle with `cliSessionId=null` forever; the one successful prior review on disk was triggered by a hand-rolled `manual-wake-aura-rebrand.json` (got-010 in `.agents/knowledge/gotchas.jsonl`). This plan closes the last load-bearing gap in Council Mode.

**Boundaries:** Out of scope — Codex pairing (deferred to separate plan once `codex+claude` envelope is reviewed); auto-checkpoint emit from orchestrator skills (orthogonal feature); cross-turn observer memory; observer-tab composer removal/repurposing (Friedman flagged it; treat as scope creep here, file a separate UX task); interrupt-mid-review via `control_request: interrupt` (subprocess council rejected as too much surface area).

**Council dispatched (13):** Hunt, Fowler, Bun/Hono/TS Backend, FS-JSON Persistence, Realtime/NDJSON Protocol, Subprocess Lifecycle, React/Web UI, a11y Auditor, Saarinen (clean — no UI surface), Friedman, Willison, Docker+GHA Deploy (clean — no deploy surface), Beck. **11 of 13 returned active recommendations.**

---

## Task Sequence

### 1. Wake payload schema + pure builder

| | |
|---|---|
| **Domain** | Willison × Backend × Fowler × Hunt × Carmack — *Echo discipline + AP-3 colocation + boundary defence* |
| **Ref** | `references/quality-llm.md` → Principle 8 (Context propagation); `references/refactoring.md` → Principle 2 (Extract pure logic); `references/quality-backend.md` → Principle 8 (Type at the boundary); `references/security.md` → Principle 1 (NDJSON line-discipline injection) |
| **Depends on** | — |

Define `ObserverWakePayload` in `council-types.ts` alongside `CheckpointPayload`/`ObserverReviewPayload` (AP-3 writer+reader colocation). First key is `observer_wake_payload_version: 1`, then echo fields verbatim (`session_group_id`, `checkpoint_id`, `phase`, `checkpoint_seq`) so the observer copy-pastes them into its review rather than hallucinating. Add `buildObserverWakePayload(checkpoint, manifest)` as a pure function colocated with `buildObserverContextManifest` in `observer-prompt.ts`; returns `{textBody: string, sha256: string}` — body-text only, envelope-agnostic so a future Codex backend reuses the same body. Body shape is hybrid: short imperative preamble in plain English → single ` ```json ` fenced block carrying the manifest → single-sentence directive terminator. Per-semantic-category validators at the builder boundary (`isBoundedToken` for `phase`, `isIsoTimestamp` for timestamps, `isBoundedText` for free-form). Reject any manifest field containing a literal ` ``` ` triplet, CR, LF, or NUL byte — that's the format-transformation-validation seam from prior memory. Hard cap on entries per section and total serialised content bytes; on overflow, refuse with EC-9 log entry rather than truncate.

### 2. Adapter: server-direction send seam + observer turn-state tracking

| | |
|---|---|
| **Domain** | Fowler × Realtime × Subprocess × Backend × Carmack — *Named seam; turn boundaries are protocol-level, not heuristic* |
| **Ref** | `references/refactoring.md` → Principle 4 (names reveal design); `references/quality-realtime.md` → Principle 1 (NDJSON framing); `references/quality-subprocess.md` → Principle 2 (PIDs lie; identity must be confirmed at the protocol boundary) |
| **Depends on** | Task 1 |

Add `ClaudeAdapter.sendUserFrameFromServer(content: ObserverWakeFrameContent): WakeDispatchOutcome` — the new server-direction seam. Naming the method explicitly (`FromServer`, not `sendUser`) makes the unusual provenance visible at every call site; do NOT widen `WsBridge.broadcastToGroup` for CLI direction (god-module trajectory). The method wraps the existing `sendToBackend` NDJSON writer, with three additions: (a) **boundary assertion** that the serialised line contains no embedded `\n` before `cliSocket.send` appends one; (b) **bufferedAmount check** — refuse send (return `{kind:"failed", reason:"backpressure"}`) when over a 1MB threshold, never queue in JS; (c) **markActivity touchpoint** so the wake counts toward idle-kill timer reset (otherwise an observer working continuously via auto-wake gets killed at 4h). Track `observerTurnState: "idle" | "in-flight"` per-session in the adapter: flip to `in-flight` on outbound `user` send, flip to `idle` on inbound `result` NDJSON frame (the documented turn terminator). Pre-first-turn (cliSessionId null) counts as `idle`. **Cross-ref:** session_id field is `""` on the very first wake to an observer; on subsequent wakes the builder reads the observer's now-known `cliSessionId` — two-state builder, not one.

### 3. Orchestrator dispatchObserverWake — sync, gated, structured-logged

| | |
|---|---|
| **Domain** | Backend × Fowler × Hunt × Subprocess × Carmack — *Sync handler with discriminated-outcome logging* |
| **Ref** | `references/quality-backend.md` → Principles 1, 7, 8 (sync handler discipline, async correctness, type at boundary); `references/refactoring.md` → Principle 6 (premature modularisation); `references/security.md` → Principle 7 (assertions as tripwires) |
| **Depends on** | Tasks 1, 2 |

Add `private dispatchObserverWake(sessionGroupId, payload): WakeDispatchOutcome` on `SessionOrchestrator`, called from `handleCouncilCheckpoint` after the existing `companionBus.emit("group:checkpoint", ...)` line. **Stays sync** — no async leak, no floating promise. Order: (a) resolve observer's `sessionId` via the coordinator's group record (single source of truth, AP-1 DI through injected deps — do NOT reach into `wsBridge.sessions`); (b) three strict gates — `cliSocket open` AND `group state ∉ {reconnecting, degraded, archived}` (AP-2) AND `observerTurnState === "idle"`; (c) wrap the send in try/catch that maps three outcome kinds to `WakeDispatchOutcome = {kind:"dispatched"} | {kind:"skipped", reason:"observer_unknown"|"socket_disconnected"|"group_not_active"|"observer_busy"} | {kind:"failed", error:string}`; (d) **one EC-9 structured log line per outcome** — `event ∈ {group.observer_wake_dispatched | group.observer_wake_skipped | group.observer_wake_failed}` plus `sessionGroupId + observerSessionId + checkpointId + sequence + reason?`. The cross-group-leakage assertion (Hunt): at send time, assert the resolved `cliSocket` belongs to the same group whose watcher fired — mismatch must throw, not fall back. Cross-ref: send-failure is logged but does NOT mark the half degraded directly (see Task 5 for lifecycle integration).

### 4. Mid-turn 1-slot newest-wins queue on `councilWatchers` entry

| | |
|---|---|
| **Domain** | Subprocess × Fowler × Carmack — *Newest-wins matches the EC-4 filesystem-watcher idiom* |
| **Ref** | `references/quality-subprocess.md` → Principle 4 (Auto-relaunch — bounded, not silent); `references/refactoring.md` → Principle 3 (minimise + contain state) |
| **Depends on** | Tasks 2, 3 |

When `dispatchObserverWake` finds `observerTurnState === "in-flight"`, do NOT drop. Stash `pendingCheckpoint: CheckpointPayload | null` on the existing `councilWatchers[sessionGroupId]` entry — same lifecycle as the watcher pair, clears on group teardown for free, never on the adapter (would be feature envy, breaks AP-1). On new checkpoint arrival while a slot is occupied, **overwrite** (newest-wins) and emit a structured `event:"council.checkpoint.superseded"` log mirroring `checkpoint-watcher.ts`'s `onDropped("superseded")` idiom — `{sessionGroupId, role:"observer", droppedCheckpointId, supersededByCheckpointId}`. Drain hook: when the adapter flips `observerTurnState` back to `idle` (Task 2), emit a coordinator event that the orchestrator listens for to dispatch the pending wake. Slot stays in-memory only (Persistence #3) — the canonical checkpoint file on disk is the durable source; the sentinel (Task 6) is the cross-restart safety net.

### 5. Reconnect-aware drain + send-failure handling

| | |
|---|---|
| **Domain** | Subprocess × Backend × Carmack — *Failure semantics align with AP-2 state machine, never short-circuit it* |
| **Ref** | `references/quality-subprocess.md` → Principle 2 (PIDs lie; observe lifecycle, don't synthesise); `references/quality-backend.md` → Principle 6 (structured logging) |
| **Depends on** | Tasks 3, 4 |

Two related lifecycle integrations. **(a) Reconnect grace + queued wake:** if observer dies between checkpoint arrival and send (or during send), AP-2 transitions group to `reconnecting`. Keep `pendingCheckpoint` populated; on `reconnect_ok` (group → active) drain it (the checkpoint file on disk is unchanged, observer is stateless on its side); on `reconnect_failed` (group → degraded) drop the slot with EC-9 log `{event:"council.wake.dropped", reason:"group_degraded"}`. A new checkpoint arriving during `reconnecting` overwrites the slot (newest-wins consistent with Task 4). **(b) Send-failure:** on `cliSocket.send` throw, do NOT synthesise a fake `session:exited` and do NOT immediately mark degraded. Log EC-9 `{event:"council.wake.send_failed", socketReadyState, observerTurnState}`, keep the pendingCheckpoint slot populated, and let the actual socket-close handler in `ws-bridge.ts` fire `session:exited` naturally — that path already routes through `coordinator.armReconnect` (45s grace, EC-2/EC-3 honoured). Mark-degraded-on-send-throw is wrong: a transient WebSocket blip would permanently demote a working observer.

### 6. Restart-idempotent wake via sentinel on disk

| | |
|---|---|
| **Domain** | Persistence × Carmack — *EC-8 sentinel-before-sweep applied to wake durability* |
| **Ref** | `references/quality-persistence.md` → Principles 3, 7 (sentinel, replay determinism) |
| **Depends on** | Task 3 |

Write a per-group sidecar `.council/state/<groupId>-wake.json` via `writeAtomicJson` AFTER each successful wake send, carrying `{schemaVersion:1, lastWokenCheckpointId, lastWokenAtIso}`. On `SessionOrchestrator.initialize()`, after restoring `councilWatchers`, reconcile: read the highest-sequence checkpoint file present in `.council/checkpoints/` for each group; compare against the sentinel; if there's a gap (checkpoint landed but observer never woke), fire one wake on resume. The handler must also check `payload.checkpoint_id` against the persisted `lastWokenCheckpointId` BEFORE dispatch, so the watcher's in-memory LRU rehydration after restart doesn't thunder-herd re-wake the observer across every historical checkpoint. Workspace-scoped (visible alongside checkpoints/reviews) rather than `$TMPDIR`-scoped (survives host wipes; pairs with the artifacts it tracks).

### 7. Realpath-bound manifest paths at builder boundary

| | |
|---|---|
| **Domain** | Hunt × Carmack — *EC-7 idiom extended to outbound manifest content* |
| **Ref** | `references/security.md` → Principle 1 (path traversal); EC-7 |
| **Depends on** | Task 1 |

Inside `buildObserverWakePayload`, before serialising any path from `delta`/`carried` into the manifest body, resolve via `realpathSync` (climbing to nearest existing parent for non-existent paths) and assert containment in the workspace root. Drop paths that escape with EC-9 log `{event:"council.wake.path_traversal_dropped", offendingPath, sessionGroupId}`. Don't trust the observer's `--allowedTools` profile or its system prompt to refuse — the prompt is advisory, the filesystem boundary is mechanical. The wrapper-vs-direct rule from EC-7 applies: only `assertWakeManifestPathAllowed(path, workspaceRoot)`-style helpers are exported; the predicate is never callable without the realpath.

### 8. Recorder schema bump — `origin` annotation

| | |
|---|---|
| **Domain** | Persistence × Willison × Carmack — *Replay determinism distinguishes server-internal from user-originated sends* |
| **Ref** | `references/quality-persistence.md` → Principle 4 (append-only logs); `references/quality-llm.md` → Principle 4 (recording-based replay) |
| **Depends on** | — |

Today the recorder writes `{ts, dir, raw, ch}`. A browser-relayed `user` frame and the new server-synthesised wake frame both land as `{dir:"out", ch:"cli"}` — indistinguishable on replay. Add an optional `origin?: "browser" | "server:council-wake"` field, written at the recorder boundary using the raw provenance string from the caller (never re-serialised from a parsed object — preserve raw-string discipline). Bump recorder header `schemaVersion` so replay tooling can branch. Forward-compat: omitted field defaults to `"browser"` for the historical norm.

### 9. Wire-level extensions — three additive fields

| | |
|---|---|
| **Domain** | Realtime × React/Web UI × Frontend × Carmack — *Extend existing channels, never fork* |
| **Ref** | `references/quality-realtime.md` → Principle 7 (tolerate polymorphism); `references/quality-frontend.md` → Principle 4 (`ws.ts` is the single mutation channel) |
| **Depends on** | Tasks 3, 4, 5 |

Three additive payload fields, no new wire types: (a) `group_degraded.reason?: "wake_send_failed" | "observer_exited" | …` — discriminant on the existing `group_degraded` message so the panel can surface why; (b) `observer_review.supersededCheckpointIds?: string[]` — populated when Task 4's queue dropped checkpoints between the previous review and this one, lets the panel show "checkpoint X was skipped (superseded)"; (c) `group_created.wakeTimeoutMs: number` — server publishes the wake-to-review timeout the frontend's state deriver uses to detect stalls. EC-5 (tolerate polymorphic-by-spec fields) covers older clients ignoring unknown fields; the `ws.ts` switch needs no new cases.

### 10. Observer prompt v1 → v1.1 + review version-mismatch handling

| | |
|---|---|
| **Domain** | Willison × Persistence × Carmack — *Schema-version sentinel works only with both writer and reader updated* |
| **Ref** | `references/quality-llm.md` → Principle 4 (validator on output); `references/quality-persistence.md` → Principle 8 (JSON shape evolution) |
| **Depends on** | Task 1 |

Update `.council/prompts/observer-system.md` header to `<!-- observer-system-prompt v1.1 -->` and add to the contract: "Echo `observer_wake_payload_version` back as a top-level key in your `ObserverReviewPayload`". Extend `ObserverReviewPayload` schema in `council-types.ts` with `observer_wake_payload_version_echo?: number` (optional for backward read of v1 reviews). `handleCouncilReview` validates the echo against the version it sent; mismatch downgrades all findings to NOTE with EC-9 log `{event:"observer.schema_mismatch", expected, actual}`. Without this loop closure, a future v2 wake against a v1 prompt would silently misparse — exactly the kind of semantic drift Principle 4 names.

### 11. Frontend state machine — promote `reviewing` to load-bearing; add `reviewing-stalled` and `queued-dropped` variants

| | |
|---|---|
| **Domain** | React/Web UI × Friedman × Carmack — *Five-screen-states accuracy under new cadence* |
| **Ref** | `references/quality-frontend.md` → Principle 1 (derived state — single source of truth); `references/quality-ux.md` → Principle 2 (design all five screen states) |
| **Depends on** | Task 9 |

In `observer-panel-state.ts`, replace the heuristic `reviewing` derivation with a real interval bounded by `wakeTimeoutMs` (from Task 9). Two new discriminated variants in the panel-state union: (a) `{kind:"reviewing-stalled", since, expiresAt}` — fall through when `nowMs > expiresAt` and no `observer_review` arrived, instead of silently reverting to `sleeping` (closes the recovery-branch-reachability failure mode); (b) `{kind:"queued-dropped", droppedCheckpointIds, currentReviewingCheckpointId}` — appears when `supersededCheckpointIds` is non-empty on the latest review. Mirror these in `ObserverPanel`'s status pill copy. Existing priority ladder slots `reviewing-stalled` above `reviewing` (it's a real failure), `queued-dropped` below `reviewing` but above `sleeping` (it's contextual annotation). Each finding row in `FindingsLog` gets a small attribution label rendering its source checkpoint (id+phase) — data is already present via the deterministic `fnd_<hex>` id derivation, just unsurfaced.

### 12. a11y cadence response — FindingsLog summary announcer + BlockerBanner dedupe

| | |
|---|---|
| **Domain** | a11y × Carmack — *Polite live regions degrade gracefully under high cadence; assertive regions must not spam* |
| **Ref** | `references/quality-a11y.md` → Principle 3 (live regions, deliberate announcement); Principle 4 (focus management) |
| **Depends on** | Task 11 |

`FindingsLog` flips `aria-live` from `"polite"` to `"off"` on the row container (keep `role="log"` for navigation semantics — JAWS/NVDA expose log landmarks). Add a sibling visually-hidden `<div role="status" aria-live="polite" aria-atomic="true">` that announces ONE summary per review event (e.g. *"Observer review complete: 1 blocker, 2 warnings"*); this collapses 3-8 announcements per checkpoint into 1 actionable line. Drop the `aria-label` count-mutation from the log container (avoids double-fire on NVDA+Firefox). `BlockerBanner` keeps `role="alert" aria-live="assertive"` but gains a `key={finding.id}` discipline — same finding id across consecutive checkpoints does not re-announce; only a new finding fires. Regression-pin the no-focus-move invariant: test that typing into Composer while a new STOP arrives keeps `document.activeElement === composerTextarea`.

### 13. Test pack — pure unit + concurrent + canary + EC-6 fixture

| | |
|---|---|
| **Domain** | Beck × Realtime × Carmack — *Boundary mocks; structure-insensitive assertions; one fixture for the round-trip* |
| **Ref** | `references/quality-testing.md` → Principles 1, 2, 3, 6, 11; EC-6 |
| **Depends on** | Tasks 1-5 |

Four test additions, all in `web/server/session-orchestrator.test.ts` plus one sibling file for the pure builder. (a) **Exhaustive handler table** — extend the existing `vi.mocked(deps.wsBridge.broadcastToGroup)` pattern with a new `sendToCli` deps mock; one `it()` per row covering `active+idle → dispatched`, `degraded → skipped`, `reconnecting → skipped`, `mid-turn → queued+supersede-log`, `out-of-order → no dispatch`, `send-throws → log+watcher-still-armed`. Assertions on literal payload shape (no `objectContaining` shortcuts) per Principle 6. (b) **Pure builder unit** — own file `observer-prompt.test.ts` extension; literal expected strings for minimal/empty-delta/max-size-boundary/special-char-paths; handler test imports the real `buildObserverWakePayload` (not re-derives) so payload-format edits ripple only through the builder tests. (c) **Concurrent cross-contamination** — `Promise.all([handleCouncilCheckpoint(g1, p1), handleCouncilCheckpoint(g2, p2)])` with the `sendToCli` mock keyed by `sessionGroupId` (not call counter — per memory `feedback_parallel_test_fakes_keyed_by_input`); assert no cross-write. (d) **Static-grep canary** — read `session-orchestrator.ts` source as a string at test time, regex-match the body of `handleCouncilCheckpoint` for the wake call site (regex over `\w+`, not literal substring per memory rule); catches the call-site-disappearance failure mode (`feedback_recovery_branch_reachability` and `feedback_call_site_presence_not_just_symbol_export` siblings). (e) **EC-6 fixture** — capture one wake send into `~/.companion/recordings/<observerSessionId>_*.jsonl`, pin under `web/server/__fixtures__/observer-wake/claude-v1.jsonl`, write a parser test asserting line splits cleanly on `\n`, parses to one JSON object, `type==="user"`, `message.content[0].type==="text"`, body contains exactly one ` ```json ` fence, fenced content `JSON.parse`s, parsed object validates against `CheckpointPayload`. **Skip** a separate replay-style integration test — the wake is outbound, not parsed by Aura; that's the wrong tool for the surface.

---

## Risks & Watchpoints

- **Realtime — per-receiver send-queue future-proofing:** today only the wake fires server→observer, but `interrupt` and `set_permission_mode` are documented Claude Code paths. When the second server→observer send-site lands, ALL outbound observer sends must go through a per-session async queue (drain-in-order, single in-flight). Don't build it now — cheap to add when needed, premature today. **Watch:** the day a second sender appears, this is P1.
- **Fowler — `pendingCouncilCall` cross-contamination (out of this scope, but adjacent):** prior council review #2 flagged `this.pendingCouncilCall` as shared mutable. Task 4's `pendingCheckpoint` lives on `councilWatchers[id]` — per-group, no cross-contamination — by design. **Watch:** if a future refactor moves it to an orchestrator-level map, audit the concurrent-call test still pins it.
- **Hunt — recorder dir perms inherit:** existing `~/.companion/recordings/` policy (0700, per-user) covers the wake frames added by Task 8. **Watch:** if a future iteration adds richer wake content (excerpts of file contents — Willison's "DON'T do this in v1"), re-evaluate the recorder exposure surface.
- **Friedman — observer-tab composer is now a dead end:** with auto-wake live, the observer composer is permanently disabled and confusing. **Out of this plan's scope** — file as separate UX cleanup (remove or add explainer card affordance).
- **Willison — propose convention `EC-10`** post-merge: "outbound LLM wake messages carry a payload-version sentinel as the first JSON key and a plain-English preamble before the fenced manifest." Capture in `conventions.md` once Task 1 lands, so future wake-style features (e.g. orchestrator wake-other-pair) inherit the discipline.
- **Beck — canary regex must use `\w+` placeholders, not literal substrings:** memory `feedback_static_grep_canary_regex_over_substring` applies. A canary like `/wsBridge\.broadcastToGroup/` survives a rename; `/broadcastToGroup/` does not.
- **Saarinen — visual cadence calibration is a UX question, not a visual one:** if post-merge the status pill flicker on fast `reviewing → blocker-found → reviewing` cycles is jarring, the answer is debouncing on the derivation side (Task 11), not visual-token churn.

---

## External Setup Required

No external setup required. All tasks can be implemented within the codebase. No new dependencies, no new env vars, no Dockerfile or CI changes. Deploy council explicitly confirmed non-impact across Dockerfile / env / GHA hardening / CI gates / SIGTERM / reproducibility / recording rotation.

---

## Summary

| # | Task | Domain | Depends on |
|---|------|--------|------------|
| 1 | Wake payload schema + pure builder | Willison × Backend × Fowler × Hunt | — |
| 2 | Adapter: server-direction send + turn-state | Fowler × Realtime × Subprocess × Backend | 1 |
| 3 | Orchestrator dispatchObserverWake — sync, gated, logged | Backend × Fowler × Hunt × Subprocess | 1, 2 |
| 4 | Mid-turn 1-slot newest-wins queue | Subprocess × Fowler | 2, 3 |
| 5 | Reconnect-aware drain + send-failure handling | Subprocess × Backend | 3, 4 |
| 6 | Sentinel-on-disk for restart idempotency | Persistence | 3 |
| 7 | Realpath-bound manifest paths | Hunt | 1 |
| 8 | Recorder schema bump — `origin` annotation | Persistence × Willison | — |
| 9 | Wire-level extensions (3 additive fields) | Realtime × React/Web UI | 3, 4, 5 |
| 10 | Observer prompt v1.1 + review version check | Willison × Persistence | 1 |
| 11 | Frontend state machine + finding attribution | React/Web UI × Friedman | 9 |
| 12 | a11y cadence response | a11y | 11 |
| 13 | Test pack (handler + builder + concurrent + canary + EC-6 fixture) | Beck × Realtime | 1-5 |

## Verdict

The most important architectural decision is the **AP-1-style DI seam at adapter level (`sendUserFrameFromServer`) paired with the `WakeDispatchOutcome` discriminated union** (Tasks 2-3). Together they make the feature testable as a pure unit (no real sockets, no integration shape) AND keep the orchestrator decoupled from socket internals — Fowler's "names reveal design" and Backend's "type at the boundary" both lean on this seam. Get it wrong (raw `cliSocket.send` from the orchestrator, or a generic `string` return from dispatch) and the next reviewer cannot grep for the only server-initiated CLI write surface.

Backend is the **most critical lane** — 4 of 13 tasks touch the orchestrator handler. Start with **Task 1 (foundation type + pure builder)**: zero deps, unlocks Tasks 2, 3, 7, 10, 13 in parallel. Tasks 4-6 are the lifecycle layer that follows; Tasks 8-12 are independent wire and frontend wiring that can run in parallel after Task 9 lands.

**Pair-agent suggestion during build:** Subprocess + Beck together on Tasks 4-5 — the mid-turn queue + turn-done detection via `result` frame is the trickiest piece and is exactly where the "test what might break" Principle pays off. Hunt should review Tasks 1+7 together post-implement (NDJSON CR/LF discipline + realpath are the two boundary-defence surfaces).
