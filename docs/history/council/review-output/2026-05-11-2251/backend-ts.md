# Bun + Hono + TypeScript Backend Review — Council Mode Phases D-G

**Reviewer lens:** Carmack × Matteo Collina × Bun/Hono.
**Files in scope:**
- `web/server/routes.ts` (council branches in `/sessions/create` and `/sessions/create-stream`)
- `web/server/session-orchestrator.ts` (`createCouncilGroup`, bus subscriptions, council watcher lifecycle)
- `web/server/ws-bridge.ts` (`broadcastToGroup`)
- `web/server/event-bus-types.ts` (`group:review` and other Council Mode event variants)

Conventions honoured: AP-1..3 and EC-1..9 are NOT re-flagged.

---

## P1 — Fix Now

### P1-1: `startCouncilWatchers` swallows lazy-import failure silently; watchers never start and abort is unreachable

- **File:** `web/server/session-orchestrator.ts:379-409`
- **Principle:** Backend P1 (programmer-vs-operational errors) and P5 (resource lifecycle).
- **What's wrong:** `startCouncilWatchers` wires `councilWatchers.set(...)` *before* it kicks off `import("node:path").then(...)`. The `.then` callback installs both `watchCheckpoints` and `watchReviews` and attaches their `.catch(...)` handlers — but the outer `import(...)` chain has **no terminal `.catch`**. If the dynamic import rejects (e.g. transient esbuild/bundler glitch, future module-path refactor, FS error inside a packaged distribution), the rejection becomes a silent unhandled promise rejection that Bun will crash on by default. Worse: the map entry is already populated, so `councilWatchers.has(sessionGroupId)` returns `true` forever and a second `startCouncilWatchers` call is a no-op — yet **no watcher is actually running**, and `stopCouncilWatchers` does call `entry.abort.abort()` but there are no listeners attached to the signal yet.
- **Consequence:** The group is created (REST returns 200), the browser thinks it's in council mode, the orchestrator's checkpoints land on disk — and nothing emits `group:checkpoint` or `group:review`. The observer panel sits silent forever. From the outside, this looks like "observer never wakes" rather than a startup error.
- **Fix:** Either (a) attach a terminal `.catch` on the dynamic-import chain that logs structurally and calls `this.stopCouncilWatchers(sessionGroupId)` so the half-installed entry is removed and the next call retries, or (b) eliminate the lazy import entirely (`node:path` has near-zero cost; see P3-3 below) and run the watcher setup synchronously inside `startCouncilWatchers`.

### P1-2: Council pairing branch returns *before* shape contract is documented or tested — REST response shape diverges from non-council create

- **File:** `web/server/routes.ts:201-206` vs `211`.
- **Principle:** Backend P8 (type safety at the boundary) and P2 (validate at boundary, document at response).
- **What's wrong:** The non-council `/sessions/create` returns `c.json(result.session)` — a flat `SdkSessionInfo`. The council branch returns `c.json({ sessionGroupId, primary, observer })` — a wrapper object with two `SdkSessionInfo` instances. There is no shared TypeScript response type bound to this endpoint, no JSDoc on the route documenting the two shapes, and no Zod/valibot at the Hono boundary that would let a typed client narrow on the discriminator. A future browser-side `await api.createSession(...)` that doesn't first check `councilMode` will read `result.sessionId` as `undefined` and crash downstream. The `400` status is cast `as any` (line 194, 199) — that cast hides the fact that `c.json`'s second arg is a `ContentfulStatusCode` literal union; with that gone, a typo (`400.0`, `4002`) would not be caught.
- **Consequence:** Silent client-side drift. The SSE branch at line 252-260 emits yet a *third* shape (`sessionId` flat + `sessionGroupId` + `observerSessionId`) — three distinct response contracts off one logical endpoint, none of them locked down by types.
- **Fix:** Declare a `CreateSessionResponse` discriminated union in `session-types.ts` keyed on `councilMode` (or a `kind: "single" | "council"` tag), tighten the `c.json(_, status)` call sites by typing the status literal, and add a JSDoc comment on `/sessions/create` enumerating both response shapes. The SSE `done` payload should reuse the same wrapper rather than inventing a third flat shape.

### P1-3: `companionBus.emit("group:review", ...)` and `group:checkpoint` cannot be awaited — a throwing listener becomes an unhandled rejection on a durable broadcast path

- **File:** `web/server/session-orchestrator.ts:312-346, 422-478`.
- **Principle:** Backend P1 (swallowed rejection on broadcast paths is P1).
- **What's wrong:** Each listener registered on `companionBus.on("group:checkpoint" | "group:review" | "group:created" | "group:exited" | "group:degraded", ...)` is an *async-shaped* handler (the body calls `wsBridge.broadcastToGroup` which is sync, so today it's fine — but the surrounding bus's emit semantics are fire-and-forget). The `handleCouncilReview` body at line 430-479 is sync, but it computes `findings.map((f, idx) => ...)` and `result.downgrades.map((d) => ...)` with no try/catch — if `randomBytes(8)` throws (entropy exhaustion is rare but documented) the whole listener throws, and the watcher caller in `watchReviews` (which invoked `onReview` from inside its FS callback) has no upstream try/catch either. The unhandled exception kills the watcher's read loop without releasing its `AbortController` signal listeners, **and** prevents the `group:review` from being broadcast. The browser sees nothing, the watcher is dead, and no log line is written.
- **Consequence:** A single transient throw in the review-pickup pipeline wedges the observer pane for the rest of the group's life. There is no recovery — `stopCouncilWatchers` will be called on `group:exited`, but the entry is already half-broken.
- **Fix:** Wrap the body of `handleCouncilReview` (and `handleCouncilCheckpoint`) in `try { ... } catch (err) { log.error("session-orchestrator", "...", { sessionGroupId, error: ... }); }` so a single bad payload doesn't take down the watcher. Separately, audit `companionBus.on` invocations on the group surface: the bus already isolates handlers per the comment at line 213-214 — confirm that contract via a regression test and document it in `event-bus.ts`.

---

## P2 — Fix Soon

### P2-1: SSE error path emits `event: "error"` but never closes the stream with a terminal token

- **File:** `web/server/routes.ts:227-244`.
- **Principle:** Backend P4 (WS/stream discipline) — applies equally to SSE.
- **What's wrong:** The council SSE branch writes a single `event: "error"` SSE frame and returns. Hono's `streamSSE` will close the response when the handler returns, which is fine — but the browser's `EventSource` will *auto-reconnect* on close-without-explicit-terminator and POST the same body again. The non-council SSE branch has the same issue (line 274-279), but that's pre-existing and out of scope; for the council branch, a duplicate POST will re-validate the allow-list, see the pairing is invalid again, and emit the same `error` event in a loop until the browser closes the EventSource.
- **Consequence:** A user with a typo'd pairing label can spin up a tight retry loop until they close the tab. Not a crash, but a wasted CPU cycle and noisy log.
- **Fix:** Emit a `done` or `terminal` event after the error frame so the browser's `onerror` handler can close cleanly, and document the EventSource retry behaviour on this endpoint. Alternatively: switch to fetch-streaming (`Response` body) which doesn't auto-reconnect.

### P2-2: `parsePairingLabel` defined inline inside `createCouncilGroup` Promise.all — duplicates allow-list with route handler, increases drift surface

- **File:** `web/server/session-orchestrator.ts:518-524` vs `web/server/routes.ts:193, 226`.
- **Principle:** Backend P2 (validate at the boundary) + P8 (type safety).
- **What's wrong:** The pairing allow-list is checked in **three** places — once at `routes.ts:193` (`!== "claude+claude" && !== "claude+codex"`), again at `routes.ts:226` (same literal check), and again inside `createCouncilGroup`'s `parsePairingLabel` (with subtle structural difference — it accepts any `claude/codex × claude/codex` cross-product, four combinations not two). A future addition (e.g. `gemini+claude`) will likely update one or two of the three sites and leave the third stale. The route-layer checks are strict (two values) while the orchestrator-layer parser is permissive (four values gated only by `isSupportedPairing`).
- **Consequence:** Either dead code (the orchestrator's wider parser is gated to a narrower input by the route) or silent inconsistency (a future route relaxation lets a pairing the parser accepts but the route allow-list still rejects, depending on which file the developer edits). Convention EC-5 (strict on discriminator) is observed but split-brain.
- **Fix:** Move `parsePairingLabel` + the allow-list into `backend-provider.ts` (it already owns `isSupportedPairing`) and call from one place. The route handler then delegates to a single named guard: `validateCouncilPairing(body.councilPairing)`. Test it with the exact strings the route accepts.

### P2-3: `c.json({ error: ... }, status as any)` casts away Hono's literal status union

- **File:** `web/server/routes.ts:194, 199, 209` (and the rest of the file, but the council branches are in scope).
- **Principle:** Backend P8 (catch typing) + P2 (clean error responses).
- **What's wrong:** `result.status` is `number` (from `CreateCouncilGroupResult`'s `status: number` field); Hono expects `ContentfulStatusCode`. The `as any` cast bypasses the check entirely. A handler that returns `result.status = 200` from a coordinator (impossible today, but no type prevents it) would `c.json(error, 200)` — a 200 with an error body. Per Backend P2, error responses should also exclude internal detail; `result.error` here is built from `err.message` on the coordinator side, which may include internal paths.
- **Consequence:** The "validate at the boundary" guarantee is paper-thin. Any future code path that produces a non-error-status into `result.status` ships a malformed error response.
- **Fix:** Narrow `CreateCouncilGroupResult["status"]` to the literal union `400 | 404 | 500 | 503`. Drop the `as any`. If the orchestrator emits a non-listed status, fail-loud in development.

### P2-4: `intentionalKills` set never gets the observer's session ID when `createCouncilGroup` rolls back the first half — race window violates EC-2

- **File:** `web/server/session-orchestrator.ts:541-569`.
- **Principle:** EC-2 (group-aware kills mark BOTH IDs intentional before either kill executes) — flagged here because the wiring in scope is the new council path.
- **What's wrong:** When the second spawn fails, the coordinator (per AP-1) calls the injected `kill(sessionId)` to roll back the first half. That `kill` shim (line 566-568) calls `this.killSession(sessionId)`, which calls `launcher.kill(...)` directly without first adding the ID to `intentionalKills`. The `companionBus.on("session:exited", ...)` listener at line 238 will fire `scheduleProactiveRelaunch(sessionId)` for the first half before `killSession` returns. That's exactly the cross-listener race EC-2 was written to prevent — but EC-2 says "BOTH IDs must be present in intentionalKills *before either kill executes*", and the council path's spawn-rollback marks neither.
- **Consequence:** Spawn-rollback can immediately trigger a proactive relaunch of the half that just got killed, leaving an orphan CLI process. The coordinator returns "failed" but a CLI is running in the background, attached to a `sessionGroupId` that no longer exists.
- **Fix:** Before invoking `kill` on rollback, the coordinator (or its `kill` shim) must mark both `primary.sessionId` and the would-be observer's id as intentional. The route here is to widen the `kill` shim signature to accept an optional second ID, or add a `markIntentionalForGroup(group)` call before either kill.

### P2-5: `broadcastToGroup` silently skips missing-session ids — no observability

- **File:** `web/server/ws-bridge.ts:154-160`.
- **Principle:** Backend P6 (structured logging — every silent drop has an observability cost).
- **What's wrong:** `broadcastToGroup` iterates `sessionIds` and `continue`s past any id whose session isn't in `this.sessions`. The JSDoc explicitly says "missing-session ids are skipped silently." That's correct behaviour for the `group:exited` race documented in the orchestrator (line 296-303) — but it's also the same code path that would silently swallow a bug where the orchestrator computes the wrong id set. A `log.debug` (not warn — this is expected on `group:exited`) would let the operator distinguish "expected dropped frame on teardown" from "frame addressed to a session that should exist but isn't tracked."
- **Consequence:** Two distinct failure modes are indistinguishable in logs. Debugging "observer panel never received `group_checkpoint`" becomes archaeology.
- **Fix:** Emit a structured `log.debug("ws-bridge", "broadcastToGroup skipped missing session", { sessionId, msgType: msg.type })` on the skip path. Cheap and one-line.

### P2-6: `handleCouncilReview` correlates downgrades to findings by *index*, but maps over `result.findings` which is the same array — fragile to future re-ordering

- **File:** `web/server/session-orchestrator.ts:450-469`.
- **Principle:** Backend P8 (type safety) + indirectly Beck on parallel-async fakes keyed by input id.
- **What's wrong:** The `findings.map((f, idx) => ...)` uses `idx` to look up a `result.downgrades.find((d) => d.index === idx)`. The downgrade-array maps via `findings[d.index]?.id ?? <fallback>` — i.e. the same index is the join key in both directions. This works *only* if neither array is filtered or reordered between `validateObserverFindings` returning and this loop running. If `validateObserverFindings` is ever refactored to filter findings (e.g. drop ungroundable ones rather than downgrade them), the indices diverge silently. The fallback `?? \`fnd_${randomBytes(8).toString("hex")}\`` masks the divergence — the browser receives a downgrade chip with a fresh random id that matches no finding row.
- **Consequence:** A future grounding-validator change that filters findings produces orphan downgrade chips in the FindingsLog with no way to trace which finding they belonged to.
- **Fix:** Have `validateObserverFindings` return findings already keyed by a stable id (computed inside the validator), so the join doesn't depend on array position. Or assert `result.downgrades.every(d => d.index < result.findings.length)` and fail-loud on violation.

---

## P3 — Consider

### P3-1: `console.log` / `console.warn` in `doCreateSession` violates EC-9 spirit where they cover the council-path codepaths

- **File:** `web/server/session-orchestrator.ts:623, 629, 687, 713, 729, 863, 880, 893, 901, 1273, 1276, 1287, 1292` (orchestrator path also taken on each half of a council spawn).
- **Principle:** EC-9 (group-lifecycle log lines must be structured JSON with `event` + `sessionGroupId` + role).
- **What's wrong:** EC-9 was written for the group-lifecycle surface. `doCreateSession` is now called twice per council group, with `body.sessionGroupId` and `body.sessionGroupRole` populated — but the existing `console.warn`/`console.log` calls inside that function don't include those fields. The new code in scope (council branches in `createCouncilGroup`, `handleCouncilCheckpoint`, `handleCouncilReview`, watcher catch blocks) correctly uses `log.warn` with structured fields — but the older `console.*` calls in `doCreateSession` *are now on the group-lifecycle surface* when invoked from the council path.
- **Consequence:** A git fetch failure during council-pair spawn lands in logs as unstructured `[orchestrator] git fetch failed (non-fatal): ...` with no `sessionGroupId`, breaking the EC-9 invariant for the council branch only.
- **Fix:** Either (a) refactor `doCreateSession`'s `console.*` calls to `log.*` with structured fields including `sessionGroupId`/`sessionGroupRole` when present, or (b) explicitly carve `doCreateSession` out of EC-9's scope and document that the convention covers only files listed in EC-9's origin. (a) is the lower-drift choice.

### P3-2: `coordinator.kill` shim doesn't await Bun.spawn lifecycle — fire-and-forget on rollback

- **File:** `web/server/session-orchestrator.ts:566-568`.
- **Principle:** Backend P1 (programmer errors crash, operational errors handled).
- **What's wrong:** The injected `kill: async (sessionId) => { await this.killSession(sessionId); }` does await — that's fine. But `killSession` itself awaits `launcher.kill` and then calls `containerManager.removeContainer(sessionId)` synchronously. If `removeContainer` throws (Docker daemon stalls), the throw propagates back through the coordinator into `createCouncilGroup`'s catch, which converts it to a `status: 500` response. The orphan-from-the-rollback (the *other* half that did spawn) may not have been killed yet — the coordinator's contract per AP-1 is to roll back atomically, but the kill of the first half can fail noisily in the middle.
- **Consequence:** Rare, but a Docker stall during council-pair rollback leaves an orphan first-half session running with a `sessionGroupId` whose other half never spawned.
- **Fix:** Wrap `containerManager.removeContainer` in `killSession` with try/catch and log structurally — the kill of the CLI process has already succeeded by that point, and container-cleanup failure should not poison the kill's return.

### P3-3: `await import("node:path")` inside `startCouncilWatchers` — cost-free lazy import for cosmetic reasons

- **File:** `web/server/session-orchestrator.ts:379`.
- **Principle:** Backend P9 (Bun-specific behaviour).
- **What's wrong:** `node:path` is a built-in Bun module loaded eagerly into Bun's runtime regardless. The lazy dynamic import adds a microtask boundary (which is what created the bug in P1-1 above) and gains *zero* startup cost — `node:path` is not on disk, not bundled, not parsed by user code. The comment "avoid pulling node:path into the hot initialize() path for non-council sessions" is incorrect: `node:path` is already imported eagerly by `routes.ts` (`import { join, dirname } from "node:path"` line 6), `cli-launcher.ts`, `recorder.ts`, and many more — adding a top-level `import { join } from "node:path"` to `session-orchestrator.ts` has no measurable cost.
- **Consequence:** Cosmetic micro-optimisation that introduces a race-prone async-during-listener-registration pattern (see P1-1).
- **Fix:** Promote to a top-level `import { join } from "node:path"`. Delete the `.then` chain. `startCouncilWatchers` becomes fully synchronous and the abort/cleanup story is straightforward.

### P3-4: Middleware-ordering is correct, but un-asserted by test

- **File:** `web/server/routes.ts:69-167` vs `185-294`.
- **Principle:** Backend P3 (middleware ordering).
- **What's wrong:** The auth middleware at line 147 (`api.use("/*", ...)`) is registered *before* `/sessions/create` at line 185 and `/sessions/create-stream` at line 216 — correct. The council branches sit inside those handlers, so they are protected. There is no regression test that *asserts* the council routes refuse an unauthenticated request, though, and a future reorder (e.g. someone moves `registerSettingsRoutes` above the auth middleware) would silently un-protect them.
- **Consequence:** Currently safe; defence-in-depth gap.
- **Fix:** Add a one-line test in `routes.test.ts` that hits `POST /sessions/create` with `councilMode: "council"` and no auth header and asserts 401.

### P3-5: `event-bus-types.ts`'s `group:review` payload duplicates `BrowserObserverFinding[]` and `BrowserObserverDowngrade[]` shape via dynamic `import("./session-types.js")` — couples event-bus types to wire types

- **File:** `web/server/event-bus-types.ts:108-114`.
- **Principle:** Backend P8 (type safety at the boundary).
- **What's wrong:** The bus event carries pre-hydrated `BrowserObserverFinding[]` (server-assigned ids, downgrade flags) — i.e. the bus payload **is** the wire payload's payload. If the wire shape grows a new field (e.g. `severity_color`), the bus type acquires it transitively; subscribers that don't broadcast to the wire (e.g. a future metrics subscriber) would still see the wire-specific field. This is the inverse of the usual separation between domain events and wire events.
- **Consequence:** Wire/domain coupling. Tomorrow's metrics or audit subscriber to `group:review` gets dragged into wire-shape changes.
- **Fix:** Define a small `ObserverFindingDomainShape` in `council-types.ts` (without browser-specific fields like `downgradeReason`), use it on the bus, and have the wire-fanout listener in `session-orchestrator.ts` perform the small domain → wire mapping. Cheap, decouples, prevents bus-shape drift driven by UI requirements.

---

## Summary

| Severity | Count |
|----------|-------|
| P1       | 3     |
| P2       | 6     |
| P3       | 5     |

The Council Mode wiring is structurally sound — coordinator decoupling (AP-1), state-machine SoT (AP-2), and the watcher tear-down via `group:exited` are all in place. The remaining issues cluster around three themes:

1. **Async-error discipline on listeners and lazy imports** (P1-1, P1-3, P3-2, P3-3) — every promise on the council surface should have either a terminal `.catch` or be replaced with sync code. The lazy `node:path` import is the single bug-attractor; deleting it fixes P1-1 and P3-3 simultaneously.
2. **REST contract gaps** (P1-2, P2-1, P2-3) — three response shapes for one logical endpoint with no unified type; SSE error path can spin; status casts hide drift.
3. **Cross-half kill safety** (P2-4) — the coordinator's spawn-rollback path does not satisfy EC-2's "mark BOTH intentional first" invariant.

P1-1 and P2-4 are the only two I'd consider release-blocking; the rest are tightening work that can land in a follow-up.
