# Realtime / NDJSON Protocol Review — Council Mode Phases D-G

Scope: `web/server/ws-bridge.ts` (broadcastToGroup), `web/server/session-types.ts` (5 new BrowserIncomingMessage variants), `web/server/event-bus-types.ts` (group:review event), `web/src/ws.ts` (5 new switch cases).

Conventions honoured: EC-1..9, AP-1..3 not re-flagged.

---

## P1 — Fix Now

### P1-R1: `group:exited` and `group:degraded` are wired as listeners but never emitted — group exit/degrade messages never reach the browser

**Where:** `web/server/session-orchestrator.ts:295-310` registers listeners that fan `group_exited` / `group_degraded` to browsers; `web/server/session-group-coordinator.ts:174-202` (`archiveGroup`) does the state transition and kills, but does NOT call `companionBus.emit("group:exited", ...)`. No `emit("group:degraded", ...)` exists anywhere in the server (`grep -rn 'emit.*group:'` returns only `group:created`, `group:checkpoint`, `group:review`).

**Why it matters:** The orchestrator's comment at `session-orchestrator.ts:276-279` declares the emitters "live in the coordinator's archive path / state machine," but no such emit call exists. Two of the five new wire variants (`group_exited`, `group_degraded`) are dead protocol surface — they compile, type-check, and have client-side handlers that update Zustand, but no browser will ever see them at runtime. When the user archives a Council pair, the browser's `groups` map is never cleared by `removeGroup`; when one half dies, the surviving half's UI never enters degraded mode. The store leaks records across the session lifetime and the BlockerBanner / DegradedBanner UX never engages.

**Fix:** Emit `companionBus.emit("group:exited", { sessionGroupId, reason })` from `archiveGroup` (after both kills, with `reason: "user_archived"`) and from the group state machine on `both_halves_died` / shutdown paths. Emit `companionBus.emit("group:degraded", { sessionGroupId, deadRole })` from the state-machine transition that flips `pairing|active → degraded` (currently the coordinator transitions status but does not bridge to the bus). Add a replay-based test: feed the coordinator a synthetic half-death and assert `group_degraded` reaches the bridge.

**Severity rationale (Principle 7 — protocol drift / Principle 4 — fan-out):** the wire contract claims to deliver these messages; the runtime does not. This is silent protocol drift between declared types and observable behaviour — the exact class of bug `WEBSOCKET_PROTOCOL_REVERSED.md` exists to prevent.

---

### P1-R2: `handleCouncilCheckpoint` overwrites `entry.lastCheckpoint` with no sequence monotonicity check — stale checkpoint wins grounding

**Where:** `web/server/session-orchestrator.ts:419-428`. The handler does `if (entry) entry.lastCheckpoint = payload;` unconditionally. The CheckpointPayload carries `sequence: number` but it is consumed only for the outbound `group:checkpoint` emission, never gated.

**Why it matters:** `handleCouncilReview` reads `entry.lastCheckpoint?.artifact_paths` as the authoritative "modified files" set for grounding (line 433). The checkpoint watcher is a filesystem watcher with debounce + atomic-rename — under load (two `writeAtomicJson` calls within the debounce window with different mtimes, or a rename-race where an older payload lands after a newer one because the filesystem reorders inode-vs-name visibility), the OLDER checkpoint's `artifact_paths` can become the grounding ground-truth for the NEXT review. STOPs whose evidence sits in the newer phase's manifest would then be downgraded to NOTE because the stale checkpoint's manifest doesn't list them — silently flipping the user-facing severity of legitimate STOPs to "ungrounded note." Conversely, an older checkpoint that re-fires (e.g. observer re-spawn re-reads the directory) replaces a richer newer manifest with an older subset.

**Fix:** Reject out-of-order sequences in `handleCouncilCheckpoint`:
```ts
if (entry && (entry.lastCheckpoint == null || payload.sequence > entry.lastCheckpoint.sequence)) {
  entry.lastCheckpoint = payload;
} else if (entry) {
  log.warn("session-orchestrator", "dropping out-of-order checkpoint", {
    sessionGroupId, incomingSeq: payload.sequence, lastSeq: entry.lastCheckpoint?.sequence,
  });
  return; // don't emit group:checkpoint either — stale event
}
```
Also reject the outbound `group:checkpoint` emission for stale sequences so the browser store's `recordCheckpoint` monotonicity guard (`council-slice.ts:256`) is the second line of defence, not the first. Add a test: emit checkpoints with sequences `[1, 3, 2]`, assert `lastCheckpoint.sequence === 3` after all three land and that `group:checkpoint` fired twice (not three times).

**Severity rationale (Principle 3 — sequence numbers / Principle 7 — drift):** the server is the seq authority; if the server itself doesn't enforce monotonicity, the client's monotonicity guard is a courtesy, not a contract — and worse, the grounding decision (which is non-reversible — downgrade is destructive) uses the stale manifest.

---

## P2 — Fix Soon

### P2-R1: `broadcastToGroup` silently skips missing sessions on `group_exited` — the surviving half never learns the pair was torn down

**Where:** `web/server/ws-bridge.ts:154-160`. The doc comment explicitly states "Missing-session ids are skipped silently." This composes with `session-orchestrator.ts:299-303`, which builds the `ids` array by scanning `this.launcher.listSessions()` for sessions whose `sessionGroupId` matches.

**Why it matters:** Consider the `both_halves_died` path (per `event-bus-types.ts:79-82`): both halves are already removed from the launcher's session map by the time `group:exited` would fire. `listSessions()` returns empty for that group → `broadcastToGroup([], ...)` is a no-op → no browser hears about the teardown. The same hazard applies when one half died seconds before the user archives: only one session id is in `listSessions`, the other browser tab (if the user happened to be looking at the dead half's stale UI) gets no signal.

The silent-skip is correct for `group_checkpoint` (a session that's already gone has no consumer); it is WRONG for `group_exited`, which is precisely the moment when the browser most needs to clean up state for sessions that just disappeared.

**Fix:** For `group_exited` specifically, keep a server-side last-known membership snapshot (the coordinator's `GroupRecord` already has `primary.sessionId` and `observer.sessionId` at archive time). Pass the coordinator-known ids to the bus, not the live `listSessions` reverse-scan. Independently, change `broadcastToGroup`'s silent-skip into a structured-log debug emission (EC-9) for the `group_exited` path — silent drops on lifecycle events are forbidden per EC-5's "every rejection must invoke an onDropped hook" rule. This dovetails with P1-R1: once `group:exited` actually emits, this fix matters.

---

### P2-R2: `default` branch in `ws.ts` switch logs at `console.debug` — protocol drift on a load-bearing wire is invisible

**Where:** `web/src/ws.ts:1224-1227`.

**Why it matters:** When the server adds a sixth Council variant (Phase H, future Codex pairings, observer-side action requests, etc.) and the client hasn't been rebuilt, the message lands in `default` and the user sees `console.debug` output — which is filtered out of most dev consoles by default (Chrome's default Info level hides Verbose). This is the exact protocol-drift footgun Principle 7 calls out: "new CLI features become invisible." `quality-realtime.md` Principle 7 calls for `info` level minimum. EC-5 requires explicit "onDropped(reason, frame)" semantics; `console.debug` is below that bar.

**Fix:** Change to `console.warn` (or route through a structured client logger). Add a TypeScript exhaustiveness check in the default by asserting `const _exhaustive: never = data` for `BrowserIncomingMessageBase` — this gives compile-time backstop for new variants. The runtime warn is still needed for cross-version drift (server newer than client at runtime).

---

### P2-R3: Server-assigned finding ids are non-stable across restart — client dedup on `wire.id` is weak

**Where:** `web/server/session-orchestrator.ts:451` assigns `id = fnd_<randomBytes(8).hex>` per call to `handleCouncilReview`. `web/src/store/council-slice.ts:278-283` dedups `appendObserverReview` by checking `prior.map(f => f.id)` against incoming `wire.id`.

**Why it matters:** The server's review-watcher LRU (`web/server/review-watcher.ts:124-129`) dedups on `(checkpoint_id, observer_provider)` — that's the actual idempotency boundary. The per-finding `id` is freshly random on every emission, so:
- On a server restart, the watcher LRU is reset, the same review file is re-read, fresh random ids are minted, and the client dedups nothing (`wire.id` is new). The client's `appendObserverReview` happily appends duplicate findings for the same (checkpoint, provider) review.
- If the server emits the same review twice in-process (it doesn't today, but the contract permits it), the client's dedup catches NOTHING because both emissions have fresh ids.

The client dedup as written is only effective for a literal browser-side reconnect that triggers an event-replay buffer push of an event already sent in the same server-process lifetime — a narrow window.

**Fix:** Derive the finding `id` deterministically from `(sessionGroupId, checkpointId, evidence_path, severity, claim-hash)` so the same finding payload yields the same id across server restarts. Then the client dedup actually catches restart-replays. Alternatively, lift the dedup to `(checkpointId, fingerprint)` on the client side and drop `id` from the dedup key. Either path closes the gap; the current setup is "two dedup layers that protect against different but overlapping failure modes, where the inner layer (server LRU) is process-lifetime-scoped." The PLAN's claim "server-side already via stable id" is not honoured — `randomBytes` is the opposite of stable.

---

### P2-R4: `group:created` happens-before `group:checkpoint` / `observer_review` is not enforced — coordinator emits in order but listener fanout is non-atomic

**Where:** `session-orchestrator.ts:588` emits `group:created` AFTER `startCouncilWatchers(group.sessionGroupId, primaryInfo.cwd)` returns. `startCouncilWatchers` (line 371) lazy-imports `node:path` via dynamic `import("node:path").then(...)` — the watcher setup runs on the next microtask. Meanwhile `group:created` emits synchronously on the bus before the watchers are armed.

**Why it matters:** The orchestrator promises (per the brief's "group_created MUST arrive before any group_checkpoint or observer_review for that group") that the browser sees `group_created` first so `upsertGroup` runs before `recordCheckpoint` / `appendObserverReview` (which both short-circuit with `if (!existing) return {};`). The current ordering is *probably* fine because the FS watchers can't possibly detect a sentinel before `import('node:path')` resolves — but it relies on an implicit happens-before that isn't documented anywhere and that a future refactor (e.g. moving the import to the top of the file) would silently break by making the watcher race the bus emission.

The bus itself is synchronous, so on a single emit, all listeners run to completion before the next emit. But `group_checkpoint` fan-out is driven by a separate event from a separate source (filesystem) — there is NO bus-level ordering guarantee between `group:created` (orchestrator-emitted) and the first `group:checkpoint` (watcher-emitted). If the watcher fires before the orchestrator's `group:created` listener finishes its `broadcastToGroup` to the browser, the browser sees `group_checkpoint` first and drops it (the store's `recordCheckpoint` returns `{}` when `groups.get(sessionGroupId)` is undefined → checkpoint lost).

**Fix:** Either (a) emit `group:created` BEFORE `startCouncilWatchers` so the listener fires and the broadcast queues into Bun's send buffer before any FS event can race; or (b) make the watchers buffer their first emission until `group:created` is acknowledged. (a) is simpler. Add a test that uses a synchronous fake FS watcher that emits a checkpoint INSIDE its setup call to validate the ordering — current tests can't catch this race because real `fs.watch` doesn't fire until next tick.

---

## P3 — Consider

### P3-R1: `broadcastToGroup` iterates two sessions sequentially, but the publish-pipeline's `broadcastToBrowsers` does not signal per-socket backpressure — a slow consumer doesn't block another, but neither does the bridge see it

**Where:** `web/server/ws-bridge-publish.ts:55-61`. The per-socket loop does `ws.send(json)` synchronously; failures are caught and the socket is dropped from the set. Bun's `ws.send` returns void and queues bytes into the OS socket buffer.

**Per the PLAN watchpoint** ("two CLI subprocesses doubling inbound could let one slow consumer stall the other"): with Bun's sync send, browsers cannot block each other at the application layer. The orchestrator-half browser and observer-half browser are independent sessions with independent `browserSockets` sets, and `broadcastToGroup` iterates them sequentially — but each call returns instantly. So the watchpoint as stated is closed.

**However:** there is no visibility into per-socket buffer pressure. Bun exposes `ws.bufferedAmount` (Node-compat WebSocket); the bridge could surface a warn when bufferedAmount > N MB for any socket in `broadcastToGroup`, to catch the case where a backgrounded mobile tab is silently accumulating MB of Council payload. Not urgent; consider for an observability pass.

---

### P3-R2: `keep_alive` cadence unchanged on group endpoints — verified

**Where:** `web/server/ws-bridge.ts:1003` (`BROWSER_HEARTBEAT_INTERVAL_MS = 25_000`), `broadcastBrowserHeartbeat` iterates ALL sessions globally and sends `{type:"keep_alive"}` to every browser. Council group endpoints (per-session WebSockets) are no different — both halves' browsers receive the global heartbeat. `ws.ts:1125-1128` handles `keep_alive` as a no-op state-change.

**Verified clean:** no group-specific heartbeat path, no cadence drift, no risk of the group path bypassing the heartbeat.

---

### P3-R3: `group:review` and `group:checkpoint` listeners on the bus do not survive `companionBus.removeAllListeners` if a future reset is added

**Where:** `session-orchestrator.ts:280-346` registers five `companionBus.on(...)` handlers at construction. No corresponding `companionBus.off` exists. The bus is a singleton; if a test or shutdown path ever calls `removeAllListeners`, all five Council fanouts go silent until a fresh orchestrator is constructed.

**Marginal:** existing single-session listeners on the same file have the same shape; this is the established pattern. Flagging only because the new code expands the listener count by ~5x relative to lifecycle complexity (group lifecycle adds events that already-running listeners need to keep listening for across the whole server's lifetime). A `dispose()` method on `SessionOrchestrator` that holds the `off` handles would be a future-proofing nicety.

---

## Summary

- **2 P1**: `group:exited`/`group:degraded` never emitted (entire wire variants are dead surface); checkpoint sequence not enforced server-side, grounding can use stale manifest.
- **4 P2**: silent skip on missing sessions for `group_exited`; `console.debug` on unknown variants below EC-5 visibility bar; non-stable finding ids weaken restart-replay dedup; `group:created` happens-before `group:checkpoint` is implicit, fragile to refactor.
- **3 P3**: no per-socket backpressure visibility; heartbeat cadence verified clean; bus listener disposal not modelled.

The two P1s are the load-bearing fixes — without them, the Council Mode wire contract is observably incomplete (P1-R1) and the grounding decision can be poisoned by FS-watcher ordering (P1-R2). Neither failure mode is currently caught by tests because both involve cross-component sequencing that the existing fakes don't model.
