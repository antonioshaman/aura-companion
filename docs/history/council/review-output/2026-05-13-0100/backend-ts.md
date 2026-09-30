# Backend (Bun + Hono + TypeScript) Council Review — Observer Auto-Wake (Story 2 AC#1)

Reviewed against `quality-backend.md` (Carmack × Collina × Bun/Hono). Scope: `claude-adapter.ts` (sendUserFrameFromServer + observerTurnState), `ws-bridge.ts` (sendObserverWakeFrame seam), `session-orchestrator.ts` (dispatch + drain + listener wiring), `council-wake-sentinel.ts`, `event-bus-types.ts`, `recorder.ts`. AP-1..AP-3 / EC-1..EC-9 not re-flagged. Protocol-byte concerns deferred to Realtime; security to Hunt; tests to Beck.

Outcome: clean wire. Async correctness, error boundaries, discriminated unions, structured logging, and Bun API usage all sound. Findings are P2 polish + one P2 logging-shape gap + a couple of P3 type-strength observations.

---

## P2 — Fix Soon

### P2-B1 — `observer:turn-done` listener reverse-mapping is O(N×N) over `councilGroupMeta`; same pattern repeats 4× in `initialize()`

**Failure mode:** Every `observer:turn-done` (one per observer turn termination) iterates `councilGroupMeta` linearly to reverse-map sessionId → groupId. The same O(N) walk is duplicated in:

- `observer:turn-done` listener (line ~410)
- `session:cli-id-received` listener (line ~452)
- `session:relaunch-failed` listener (line ~565)
- the council-half `session:exited` handler (not in review scope but adjacent)

For 1–5 council pairs the wall-clock cost is irrelevant. The problem is **structural**: the lookup is identical, repeated inline, and silently O(N²) under unbounded group growth — and the next developer adding a council bus listener will copy the loop again. Each repetition is a new place where a bug ("forgot to break", "matched primary when I meant observer") can land independently.

**Recommendation:** Lift to a single `sessionToGroupIndex: Map<string, { groupId: string; role: "orchestrator"|"observer" }>` maintained alongside `councilGroupMeta`. Update on `createCouncilGroup` / `reconcileCouncilGroups` / `group:exited`. Reverse-lookup becomes O(1). Carmack: structure should make intended behaviour obvious — one index, one mutator pair.

**Files:** `web/server/session-orchestrator.ts:410-429`, `446-510`, `560-594`, council-half `session:exited` handler.

---

### P2-B2 — `observer:turn-done` log line on drain-handler error omits `sessionGroupId` (the field most-needed for correlation)

**Failure mode:** When the `observer:turn-done` listener's try/catch fires, the warn log writes `sessionId` (the observer Companion sessionId) but no `sessionGroupId`. The reverse-map failure path returns silently with no log at all — undistinguished from a non-council `result` frame routed through the bus.

Per EC-9 / `quality-backend.md` Principle 6, every group-lifecycle log line should be queryable by `sessionGroupId`. Triage of "observer wake stuck" begins with `grep sessionGroupId=<X>`; this drain-handler error path is invisible to that query.

The same shape gap exists in the `reconnect_ok.guard_violation` / `reconnect_failed.guard_violation` paths — they log `sessionId` only because the lookup failed before `foundGroupId` was assigned. Acceptable when the lookup itself was the failure (no groupId knowable), but the **drain handler** ran AFTER `foundGroupId` was assigned, so the field is recoverable.

**Recommendation:** In `observer:turn-done` listener (line ~422), capture `foundGroupId` outside the try and include it in the catch's log payload. Same shape fix in any other listener where the variable is in scope at catch time. Leave the early-return-silent path for `foundGroupId === null` — the listener is on a high-traffic bus and emitting "non-council sessionId" warnings would be noise. But add **counter-style** metric `companion.observer_turn_done.no_group_match` for operability without per-event log spam.

**Files:** `web/server/session-orchestrator.ts:410-429`.

---

### P2-B3 — `sendObserverWakeFrame(sessionId: string, content: string)` accepts unbranded `content`; the type system is silent on whether it came from `buildObserverWakePayload`

**Failure mode:** The bridge seam's contract — "you must only call this with output of `buildObserverWakePayload`, which has already validated CR/LF/NUL + fence-triplet + bounded-token + manifest-realpath" — lives only in JSDoc on `sendUserFrameFromServer`. The TypeScript signature is `content: string`. Any future caller (refactor, new feature) can pass a raw user string and the adapter's post-stringify newline assertion is the **only** runtime defence. That assertion catches embedded `\n` but not CR alone, NUL, or fence-triplet injection — those were the producer-side gates the builder runs and never re-asserts at the adapter.

This is `quality-backend.md` Principle 8 (type safety at the boundary): the boundary between "validated wake body" and "arbitrary string" is invisible to the compiler. Per [feedback_format_transformation_validation] in the project memory ("Format-transformation layers need format-aware validators at the wrapper — producer bounded-token check covers whitespace/control, not format-specific escape chars") — the producer-side validators are at the right depth, but the wrapper's type carries no proof.

**Recommendation:** Brand the builder output: `type ObserverWakeBody = string & { readonly __observerWakeBody: unique symbol }`. `buildObserverWakePayload` returns `{ textBody: ObserverWakeBody, ... }`. `sendObserverWakeFrame(sessionId: string, content: ObserverWakeBody)`. Compile-time disprove of "could a raw user string reach the wake send" without runtime cost. Fowler's lane has this on the structural docket per the context-brief; flagging here as the **type-level** version specifically.

**Files:** `web/server/ws-bridge.ts:196`, `web/server/claude-adapter.ts:971`, `web/server/observer-prompt.ts buildObserverWakePayload` return shape.

---

### P2-B4 — `WakeDispatchOutcome.skipped.reason` and `BridgeObserverWakeOutcome.kind` overlap by string identity but not by type — refactor risk

**Failure mode:** The reasonMap at line ~1408 is the only place enforcing the translation:

```
session_unknown    → observer_unknown
adapter_missing    → adapter_missing
unsupported_backend→ unsupported_backend
```

A future bridge outcome variant (e.g. when Codex pairing lands and `unsupported_backend` should map to a new dispatcher reason like `pairing_not_implemented`) requires updating BOTH the union AND the reasonMap. The compiler will catch the missing union variant inside the `switch`, but it will NOT catch a stale `reasonMap` entry mapping to a now-removed dispatcher reason — the `as const` narrowing protects only the values listed.

Layering: `BridgeObserverWakeOutcome = ObserverWakeSendOutcome | { kind: "session_unknown" | "adapter_missing" | "unsupported_backend" }` — that's clean composition. But the dispatcher's `WakeDispatchOutcome` then **re-categorises** every bridge variant into its own skip reason. The two unions are correctly layered semantically; the mapping is just a fragile string-string table.

**Recommendation:** Either (a) keep the bridge's variant names verbatim in `WakeDispatchOutcome` (no remap; `session_unknown` is no less clear than `observer_unknown` at the call site, and removes a translation), or (b) make `reasonMap` an exhaustive `Record<BridgeOnlyKind, DispatcherSkipReason>` so a future bridge variant is a compile error here. The current `as const` object literal is close to (b) but doesn't enforce exhaustiveness — TypeScript happily accepts a partial record narrowed by the switch case labels.

**Files:** `web/server/session-orchestrator.ts:1407-1413`, `web/server/ws-bridge.ts:65-69`.

---

### P2-B5 — `sendUserFrameFromServer` post-stringify newline assertion is a producer-side tripwire, not a contract check; failure mode is silent state desync

**Failure mode:** The assertion at line ~1006 returns `{kind: "failed", error: "..."}` if `frame.includes("\n")`. Good defensive line — but the `recorder.record(...)` call at line ~1023 fires **BEFORE** the post-newline assertion runs. Sequence:

```
1. Build frame
2. Run newline tripwire — if fails, return early WITHOUT recording.   ← current order
```

Wait — re-reading: the newline assertion at line 1006 IS before the recorder call at 1023. So the recorder only records valid frames. That's correct. **But** the `try { recorder.record(...); cliSocket.send(frame + "\n") } catch { ... return failed }` block (line 1018-1032) wraps both the record AND the send. If `recorder.record` throws (disk full, recorder bug), the wake is reported as `failed` even though the frame never went to the socket — and the recorder swallows write errors internally per `SessionRecorder.record` line 145-152, so it shouldn't throw. But the contract isn't enforced at the type level. Worse failure: if `cliSocket.send` throws AFTER `recorder.record` succeeds, the on-disk recording shows an outbound frame that the observer never received. Forensic replay would then mis-attribute the cause of a stuck observer to a successful wake.

Severity is P2 because the recorder swallows internally — but the **contract** that "recorder.record never throws" lives in the SessionRecorder body, not in any signature visible from `sendUserFrameFromServer`. A future recorder refactor could break this invariant silently.

**Recommendation:** Either pull `recorder.record` outside the try (acceptable — the recorder's own try/catch already absorbs IO failures), or add a JSDoc + static-grep canary asserting `record()` never propagates. Best: change `recorder.record`'s signature to `record(...): void` (already void) with an explicit `@throws never` comment AND an inline `try { /* IO */ } catch { /* swallow */ }` per the current implementation — promote that try to a load-bearing contract. Per [feedback_council_documented_contract_canary] in the project memory: contracts in JSDoc are docs, not enforcement.

**Files:** `web/server/claude-adapter.ts:1018-1032`, `web/server/recorder.ts:128-153`.

---

## P3 — Consider

### P3-B1 — `RECORDING_HEADER_VERSIONS_ACCEPTED` is a `Set<RecordingHeaderVersion>`; runtime `has(unknown)` from JSON.parse output trips type assertion

**Failure mode:** `replay.ts:34` calls `RECORDING_HEADER_VERSIONS_ACCEPTED.has(header.version)` after `header = JSON.parse(...) as RecordingHeader`. The `as` cast is unchecked — a recording with `"version": "v2"` (string) instead of `2` (number) would pass JSON.parse, fail the runtime `has` check (returning false), and the error message would correctly fire. Good. But the `ReadonlySet<RecordingHeaderVersion>.has` method signature is `has(value: RecordingHeaderVersion): boolean` — a strictly-typed lookup that rejects `unknown` at compile time. The current code only works because of `as RecordingHeader`'s blanket coercion. A switch to a stricter parser (e.g. zod) would surface this; until then the discriminator strategy is clean but the type-system coverage is bypassed.

**Recommendation:** Wrap as `(RECORDING_HEADER_VERSIONS_ACCEPTED as ReadonlySet<number>).has(header.version)` for explicit-runtime-only intent, or parse via a runtime schema. Low priority — the back-compat reader strategy itself (versioned discriminator + accept-set) is exactly right for the v1→v2 bump.

**Files:** `web/server/replay.ts:33-38`, `web/server/recording-hub/hub-store.ts:88-93`.

---

### P3-B2 — `councilWakeSentinelPath` joins user-controlled `sessionGroupId` into a filesystem path without validator at the wrapper

**Failure mode:** `join(workspaceCwd, ".council", "state", `${sessionGroupId}-wake.json`)` will silently produce `.council/state/../../etc/wake.json` if `sessionGroupId` contains `..`. The group-id is server-generated (`grp_<hex>` per `group-authorization.ts`) so the realistic exploit surface is zero — but the **type signature is `sessionGroupId: string`**, and the EC-7 idiom (predicates that touch fs inline realpath OR are exposed only via a resolving wrapper) suggests this is the wrong shape for a hot-path writer. Per [feedback_format_transformation_validation] memory: format-transformation layers need format-aware validators at the wrapper.

**Recommendation:** Either brand `sessionGroupId` at creation (`groupAuthorization.create()` returns `GroupId & { readonly __brand: ... }`) so this function's signature compile-rejects raw strings, or inline a regex assertion (`/^grp_[a-f0-9]+$/.test(...)`) at the top of the writer. Hunt's lane has the security framing; this is the type-shape companion.

**Files:** `web/server/council-wake-sentinel.ts:62-64`, `131-143`.

---

### P3-B3 — Bus listener for `observer:turn-done` is registered idempotently in `initialize()` but not unregistered anywhere

**Failure mode:** Per CLAUDE.md the orchestrator is a singleton with `_initialized` guard, so duplicate listener registration is gated by initialize idempotency. Fine in production. But the bus has no `off()` discipline in this file — every listener attached in `initialize()` lives for the process lifetime. In tests, `companionBus` is module-level shared state; if a test instantiates two orchestrators with different bus setups (it shouldn't but the type doesn't forbid), listeners accumulate. Beck's lane on tests; flagging here only as a resource-lifecycle observation per `quality-backend.md` Principle 5.

**Recommendation:** None in production code. In test setup, document that `companionBus.removeAllListeners()` is required between orchestrator instances. Optionally: refactor to instance-scoped event emitter — out of scope for this PR.

**Files:** `web/server/session-orchestrator.ts:399-510, 519-594`.

---

## What's clean (no finding)

- **Sync correctness of `dispatchObserverWake`.** Pure-sync return, every gate logs once via `log.info`/`warn`/`error` (sync), no `await`, no floating promise. The `handleCouncilCheckpoint` callsite (line 1170) does not await — and there's nothing to await. Carmack: latency is a bug; this path is allocation-light and synchronous.
- **Try/catch shape on sentinel write.** The `writeCouncilWakeSentinel` failure path (line 1326-1334) logs and falls through to the dispatched-outcome return. The wake itself already happened, so failing the sentinel write doesn't unhook the watcher — exactly the right failure-mode discipline per `quality-backend.md` Principle 1.
- **Bun API usage.** `getBufferedAmount()` and `readyState !== 1` are both correct Bun ServerWebSocket APIs (verified against `bun-types/serve.d.ts:251, 295`). The `=== 1` magic number is fine — the WebSocket spec value (`OPEN`), commented in code as such. Bun's `ServerWebSocket.send` is synchronous and throws on closed-but-not-yet-detached, matching the try/catch wrapper's assumption.
- **`observer:turn-done` single emit / single listener.** Emit only at the `in-flight → idle` transition in `handleResultMessage` (claude-adapter.ts:755-758); non-council and browser-initiated turns never enter `in-flight`, so the bus never gets noise. Listener in `initialize()` correctly handles the empty `foundGroupId` case as a no-op rather than a warn.
- **`drainPendingObserverWake` idempotency.** Empty-queue is a no-op; safe to invoke from multiple trigger sites (`observer:turn-done`, `reconnect_ok`). The drain re-enters `dispatchObserverWake` which redoes ALL gates including sentinel — protects against drain-during-degraded races.
- **Recorder schema bump.** `RECORDING_HEADER_VERSION = 2` (writer always emits) + `RECORDING_HEADER_VERSIONS_ACCEPTED = Set([1, 2])` (readers tolerate) is the textbook back-compat versioned-discriminator pattern. Optional `origin?` field omitted by default keeps on-disk byte size minimal for the 99.9% case (browser-relayed frames). The `RecordingOrigin = "browser" | "server:council-wake"` union is correctly closed.
- **Discriminated union layering.** `ObserverWakeSendOutcome` (5 adapter variants) ⊂ `BridgeObserverWakeOutcome` (8 bridge variants = adapter ∪ {session_unknown, adapter_missing, unsupported_backend}) ⊂ `WakeDispatchOutcome` (dispatched + 9 skip reasons + failed). Each layer adds exactly the gate-reasons it owns. The `switch(bridgeOutcome.kind)` in `dispatchObserverWake` is exhaustive (covers all 8 bridge variants); a future variant would force a compile error here. Clean.

