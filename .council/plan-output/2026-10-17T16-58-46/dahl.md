# dahl — Bun + Hono + TS Backend / NDJSON-WS Protocol — Plan recommendations

Scope read: `context-size-suggester.ts`, `session-recovery.ts` (drift tick 577-630, `maybeFireCompactionAdvisory` 839-890), `ws-bridge.ts:361`, `session-types.ts:906-925`, `routes.ts:1212-1283` (+ `routes.test.ts:6418+`), `codex-adapter.ts` (`handleTokenUsageUpdated` 3253-3320, `isMainThread`, init `context_used_percent: 0` at 1539), `codex-turn-usage.ts`, `checkpoint-watcher.ts`, `review-watcher.ts:345-420`, `git show 31946bb9`, `web/src/ws.ts:1408-1432` (legacy frame consumer), `ContextAdvisoryBanner.tsx` (fields read).

Protocol verdict up front: **no new WS message type and no new CLI-side control flow is needed** for any of the four items. The Codex signal already crosses the JSON-RPC boundary (`thread/tokenUsage/updated` → `state.context_used_percent`) and the browser already consumes `session_update{context_advisory}`. The work is server-side decision logic, persistence shape, and FS hygiene. The one wire-visible change is the *shape* of the already-existing `context_advisory` record (R2), which must stay backward-compatible with persisted JSON and with the legacy `error` frame consumer in `ws.ts`.

Assumption stated: "disconnected" in AC2 maps onto launcher `state === "exited"` plus `wsBridge.isCliConnected(id) === false` — the launcher enum is `starting|connected|running|exited` (`cli-launcher.ts:220`); there is no `disconnected` literal.

---

## R1 — Codex signal = main-thread context-window percent, read from in-memory session state (not transcript bytes, not `messageHistory` bytes)

- **Principle:** B8 "Two protocols, one bridge — adapters produce the same internal event shape; the bridge composes, it does not switch"; A7 "no CPU-bound work on the hot path".
- **Defends AC:** AC1.
- **What to get right:** Pick candidate (a). The Codex adapter already normalises `tokenUsage.last.inputTokens + outputTokens` over `modelContextWindow` into `state.context_used_percent` for the **main thread only** (`isMainThread`, duplicate/replay-safe via `CodexTurnUsageAccumulator`), so the drift tick needs **no new adapter method and no new frame** — it reads one number off `bridgeSession.state` in O(1). Reject (b): `JSON.stringify(messageHistory)` every 15 s per session is O(history) sync CPU on the event loop, it measures Aura's bookkeeping (base64 images the handoff *strips*) rather than what the model actually holds, and it keeps growing after `codex/event/context_compacted` resets the real context — a guaranteed false positive on exactly the sessions that compact well. Rollout bytes are ~34 KB on prod; a byte ladder is dead for Codex by construction.
- **Risk if skipped:** Codex sessions either never see the banner (bytes) or see it after the CLI already compacted (history bytes), and the tick acquires a per-session serialisation cost that scales with session age.
- **Depends on:** —

## R2 — Keep the suggester pure via a ladder descriptor; record discriminated by `signal`; `milestoneBytes` stays bytes-only

- **Principle:** A8 "Type safety at the boundary — runtime shape and TS type must not drift"; B7 "tolerate unknown shapes; never let a new field break an old consumer".
- **Defends AC:** AC1 (and protects AC3's route copy).
- **What to get right:** `nextCompactionMilestone(value, lastFired, milestones, messages)` is already parametrised; the only bytes-specific leak is `advisoryActionFor` comparing against `HANDOFF_MILESTONE_MIN_BYTES`. Lift the three knobs into one exported ladder descriptor (milestones, messages, handoff-min) with the bytes ladder as default so every existing test passes unchanged, and add a percent ladder for Codex (e.g. a single handoff tier ≥ ~85-90 % — state the number in the plan and justify it from `context_used_percent` semantics, not from MB). The caller injects the measured value; the suggester never knows the source. Extend `ContextAdvisoryRecord` with `signal: "transcript_bytes" | "context_tokens"` and a generic `milestone: number`; **populate `milestoneBytes` only for the bytes signal** (make it optional in the type). This keeps `routes.ts` `contextBytes = state.context_advisory?.milestoneBytes` correct with zero change (undefined for Codex → no "> N MB" in the pickup draft) and leaves old persisted records (no `signal`) readable as bytes. The browser needs one deliberate touch: `ContextAdvisoryNotice`'s dismissal comparator and the "over N MB" header key off `milestoneBytes`; switch dismissal to `milestone ?? milestoneBytes` and hide the MB header when `milestoneBytes` is absent — say so in the plan, do not leave it implicit. For the tokens signal **do not emit the legacy `{type:"error", advisory}` frame**: `ws.ts:1420` does `current.milestoneBytes < data.advisory.milestoneBytes`, which with `undefined` is `NaN`-false and the frame is swallowed (and `break` skips the text line too). The authoritative path is `session_update{context_advisory}` from `recordContextAdvisory`; the legacy frame exists only for the bytes/`compact` tiers that have no record.
- **Risk if skipped:** Either the Codex banner reads "Session context is over 0 B" / the pickup draft says "> 85 MB", or the suggester grows an `if backend === codex` branch and stops being a pure function.
- **Depends on:** R1.

## R3 — Milestone seeding across restart is per-signal and only advances after a *successful* record

- **Principle:** A1 "swallowed rejection on durable state = P1" (here a swallowed `false` return); A6 structured logging.
- **Defends AC:** AC1, AC2.
- **What to get right:** Today `compactionAdvisoryFired.set(...)` runs **before** `recordContextAdvisory`, and that method returns `false` when `this.sessions` lacks the id (post-restart until the bridge session is loaded). Net effect: the in-memory map says "fired", nothing was persisted or broadcast, and the tier never fires again for the process lifetime — a silent loss that AC2 makes *more* likely because dead sessions are exactly the ones whose bridge session may be absent. Advance `lastFired` only when the record call returns `true` (for `compact` tiers, after the broadcast call), and on `false` emit `log.warn` `{event:"context_advisory.record_skipped", sessionId, signal, milestone, reason:"bridge_session_missing"}` so the next tick retries. Seed `lastFired` from the persisted record **only if `record.signal` matches the ladder in use** (absent `signal` ⇒ bytes). Note the Codex adapter resets `context_used_percent` to 0 at init (`codex-adapter.ts:1539`) and after `context_compacted`; with a monotonic `lastFired` this correctly never re-fires the same tier — same semantics as Claude today, document it.
- **Risk if skipped:** AC1's "surviving server restart" fails in the common post-restart window, and the failure is invisible (no log, no retry).
- **Depends on:** R2.

## R4 — Decouple the advisory from the drift gate: two gates, one stat, per-session error isolation

- **Principle:** A1 "operational errors handled, programmer errors loud"; A5/A7 "O(sessions), no extra FD or CPU per tick".
- **Defends AC:** AC2 (and AC1's Codex path).
- **What to get right:** Restructure `driftDetectorTick` so the per-session loop has an **advisory gate** (skip only `archived`; resolve the measurement: Claude → `resolveCliSessionPaths` + one `statSync`; Codex → `bridgeSession.state.context_used_percent`) that runs *before* the drift-specific gates (`backendType==="codex"`, `state`, `instanceof ClaudeAdapter`, `driftRecoveryInFlight`). Keep exactly one `statSync` per Claude session per tick — the current code already stats the jsonl in `checkDrift` *and* in `maybeFireCompactionAdvisory`; do not add a third, and do not introduce `readdirSync`. Wrap the advisory call per session so a throw for one session (programmer error, e.g. a bad record shape) is logged with `{event:"context_advisory.tick_session_failed", sessionId}` and the loop continues — today a throw inside the loop escapes to the outer `tick_failed` catch and silently starves every later session in the list for that tick. Narrow the current bare `catch {}` around `statSync`: `ENOENT`/`EACCES` are operational (skip silently, next tick retries); anything else is logged, not absorbed.
- **Risk if skipped:** A dead-but-not-archived 7 MB Claude session (the exact wedge case the banner was built for) never gets the one-click exit; one bad session hides advisory failures for all others.
- **Depends on:** R1, R3.

## R5 — Handoff filename contract: one exported anchored pattern + builder, co-located with the consumer; the route uses the builder

- **Principle:** A2 "validate at the boundary"; filename-contract convention (`OBSERVER_REVIEW_FILE_PATTERN` + `buildObserverReviewFilename`).
- **Defends AC:** AC3.
- **What to get right:** Export `HANDOFF_FILE_PATTERN` (anchored, exact: `^\.aura-handoff-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.md$`) and `buildHandoffFilename(date: Date)` from `handoff-extractor.ts` (that module already owns `buildPickupDraft`, the other consumer of the name); `routes.ts` must call the builder instead of its inline `toISOString().replace(...).slice(0,19)`. The pattern is the **only** allow-list the pruner consults; by construction it cannot match the owner's date-only `.aura-handoff-2026-10-17.md`, `.aura-handoff-2026-05-21T013747.md` (existing test fixture, no time dashes), or any `.tmp`/`.md~`. Required mutation-resistant tests: builder output matches the pattern; the three non-matching shapes above do not; a wrong-length year/`T` separator does not.
- **Risk if skipped:** Two hand-maintained copies of the timestamp format drift and the pruner either deletes the owner's notes or never matches anything.
- **Depends on:** —

## R6 — Pruner = pure selection + thin sync FS wrapper; runs after the response is decided; every deletion is a structured log line

- **Principle:** A1 "operational errors handled cleanly, never into the response"; A5 resource lifecycle; A6 structured logging; "pure decision functions stay pure".
- **Defends AC:** AC3.
- **What to get right:** Split into `selectHandoffFilesToPrune(entries, nowMs, {keep: 3, minAgeMs: 7d})` — pure over `{name, mtimeMs}` candidates, returns names, sorted by mtime with name tiebreak so the *newest N* survive and only files older than 7 days are eligible (AND, as proposed) — and `pruneHandoffFiles(cwd, sessionId)` which does one `readdirSync(cwd, {withFileTypes: true})`, filters by `HANDOFF_FILE_PATTERN` **and** `dirent.isFile() && !dirent.isSymbolicLink()`, `lstatSync` only the survivors of that filter (bounded N syscalls, no `realpath` games), unlinks the selection, and logs `log.info {event:"handoff.pruned", sessionId, cwd, file, ageMs}` per unlink and `log.warn {event:"handoff.prune_failed", sessionId, file, code}` per failure. The wrapper never throws: the route calls it only after `orchestrator.createSession` succeeded and after the 200 payload is computed, inside its own try/catch, so a cleanup failure cannot turn a successful handoff into a 500 or change the body. Keep it in the request path only (no startup sweep) as agreed. Sync FS here is acceptable: bounded by matches, single-operator, same thread discipline as the existing `writeFileSync`. Also fold in the one existing boundary leak while you are in the handler: `c.json({error: \`Cannot write handoff file: ${String(err)}\`}, 500)` ships the server path and errno to the browser — log the detail, return a generic error (A2).
- **Risk if skipped:** A transient `EBUSY`/`EPERM` on an old file turns a successful new-session spawn into a 500 that the browser reports as "handoff failed" while the session already exists.
- **Depends on:** R5.

## R7 — AC4: port 31946bb9 as a cherry-pick, extend the `CheckpointDropReason` consumers, keep the known stat-ordering limit explicit

- **Principle:** B7 "switch-without-default protocol drift defence"; EC-4 / EC-6.
- **Defends AC:** AC4.
- **What to get right:** The unmerged diff is a faithful mirror of `watchReviews` (`(file, mtimeNs)` keyed timers, `onDropped("superseded")`, `debounceMs` test seam) and should be cherry-picked, not re-typed; take `checkpoint-watcher.ts` + `checkpoint-watcher.test.ts` only (the codex-adapter/claude-adapter hunks in that commit are a different finding — leave them out of PR-C). Grep every consumer of `CheckpointDropReason` (session-orchestrator's `onDropped` wiring, any metrics switch) for exhaustive handling so the new `"superseded"` literal is counted and logged under EC-9 with `sessionGroupId`, not dropped into a default arm. Be honest in the test comments about the one limit this design shares with review-watcher: the `await stat()` inside the `for await (watch)` loop can observe the *second* write's mtime for both events when they land faster than one loop turn — then they coalesce and no `superseded` fires. That is why the test raises `debounceMs` and why the AC's "either both emit or the loss surfaces" is proven at the seam, not against raw fs.watch timing.
- **Risk if skipped:** A second checkpoint in the same phase vanishes silently and the observer never wakes (the original W17 finding), or the port lands with a drop reason no consumer counts.
- **Depends on:** —

## R8 — PR split: confirm A/B/C; order A before B is *not* required, C is independent

- **Principle:** Carmack "structure should make intended behaviour obvious".
- **Defends AC:** cross-cutting (AC1-AC4); no scope added.
- **What to get right:** PR-A (R1-R4) changes the persisted record shape and the tick; PR-B (R5-R6) touches only `handoff-extractor.ts` + `routes.ts`; PR-C (R7) is a cherry-pick. Because R2 keeps `milestoneBytes` bytes-only, PR-B's route needs nothing from PR-A — land them in any order. Only coupling: PR-A's new structured-log events and PR-B's must both follow the `event` + `sessionId` naming above so one `jq` query covers the feature.
- **Risk if skipped:** —
- **Depends on:** R2 (keeps the route independent).

---

### Explicitly not recommended (scope discipline)
- No new WS message type, no `control_request`, no `seq`/replay change: the banner rides the existing `session_update` fan-out which already preserves per-browser ordering.
- No periodic startup sweep for handoff files; no pruning across cwds.
- No change to the Claude byte thresholds or to the drift-kill decision path — the advisory gate is additive and reads the same stat.
