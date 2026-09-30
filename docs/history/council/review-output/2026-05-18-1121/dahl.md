# dahl — Bun + NDJSON/WS Protocol Review — PR #68

**Scope:** `web/server/ws-bridge.ts`, `web/server/session-types.ts`, `web/src/ws.ts`, `web/server/routes.ts`

**Verdict:** Protocol surface is correctly extended. The keystone refactor — three producers funnelled through `buildBrowserGroupRecord` — eliminates the drift class this PR set out to close. Wire-shape migration handling is defensive on the client side. A few specific concerns below; none are blockers for landing.

---

## P2-1 — Buffered legacy `group_created` frames replay without `status` after server upgrade

**Severity:** P2
**File:** `/tmp/aura-pr68-bootstrap-fix/web/server/session-types.ts:411` (variant declaration), `/tmp/aura-pr68-bootstrap-fix/web/server/ws-bridge-replay.ts:29-35` (replay inclusion policy)

**Finding:** The brief asked me to verify the assumption that `ws-bridge`'s event buffer is in-memory only. It is not. `sequenceEvent` (`ws-bridge-replay.ts:45-61`) pushes every replayable browser event into `session.eventBuffer`, which is persisted to disk via `persistSession` (`session-store.ts:39` declares `eventBuffer?: BufferedBrowserEvent[]` on `PersistedSession`, loaded back on restore at `ws-bridge.ts:375`). `shouldBufferForReplay` excludes only `session_init`, `message_history`, and `event_replay` — `group_created` IS replayed. A pre-PR-#68 server that emitted a `group_created` frame without `status`, then crashed/upgraded onto PR #68 code, will replay that legacy frame to the next reconnecting browser inside an `event_replay` envelope. The wire-variant TypeScript type now marks `status` as required, but the runtime payload is genuinely missing the field. There is also a clear precedent in this codebase for the opposite choice: PR #61's Task 9 made `wakeTimeoutMs` OPTIONAL on this exact variant with the rationale "Required would break event-buffer replay for clients holding a pre-Task-9 `group_created` frame" (see the JSDoc at `session-types.ts:421-426`). PR #68 broke that precedent for `status` without addressing it.

**Consequence:** During a server upgrade window across an active Council Mode session, a buffered `group_created` frame replays to the reconnected browser carrying no `status` field. The frontend defensive fallback (`data.status ?? "active"` at `ws.ts:1194`) papers it over, so the UX is correct — but the type contract is violated at runtime. More worryingly, the JSDoc on `ws.ts:1190-1193` calls the fallback "structurally unreachable" — that is wrong; the path IS reachable for exactly the legacy-replay scenario the wire-variant change is supposed to be additive against. Future readers reading "structurally unreachable" may remove the fallback in a cleanup PR; the next legacy-replay window then mounts the panel with `status: undefined` and the store stores a malformed `GroupRecord`.

**Fix:** Either (a) follow the Task 9 precedent — mark `status` optional on the wire variant, treat the server emitter as always populating it (which it does, by going through `buildBrowserGroupRecord`), and document the client-side fallback as a real legacy-replay safety net; OR (b) correct the JSDoc at `ws.ts:1190-1193` to reflect that the fallback IS reachable for cross-version replay, NOT structurally unreachable, so future cleanup passes leave it alone. (a) is the cleaner choice — it makes the wire-variant migration genuinely additive in the sense Task 9 already established.

---

## P3-1 — Switch-case dispatch does not validate the discriminator enum on `status`

**Severity:** P3
**File:** `/tmp/aura-pr68-bootstrap-fix/web/src/ws.ts:1180-1235` (`case "group_created"`)

**Finding:** The client-side `case "group_created"` reads `data.status ?? "active"` and passes the value directly into `store.upsertGroup` without checking it belongs to the typed union (`"pairing" | "active" | "degraded" | "archived" | "reconnecting"`). Server-side strict TypeScript catches drift at the emit site, but the runtime wire payload could carry any string — a hostile message, a future server version with a new status not yet known to this client, or wire corruption. Reference doc Principle B7 (Protocol drift): "Discriminator field used in a switch without default silently drops new message types. New CLI features become invisible." This is a near-cousin: a new server-side `status` value would silently flow into the store and into the panel-state deriver, which may then fall through its priority ladder to an unintended state. The outer `switch (data.type)` does have a default branch (`ws.ts:1306`) — good. The nested `data.status` field does not have an equivalent validation gate.

**Consequence:** A future server adds a new `status` value (e.g. `"draining"` for shutdown). Older clients with this dispatch silently store the unknown value. The panel-state deriver's exhaustive-switch may throw, or worse, fall through to an unintended branch. Low likelihood, but the cost of guarding is one `if` statement.

**Fix:** Either narrow `data.status` against the known enum at the boundary with a default to `"active"` and a structured `console.warn` for unknown values, or let TypeScript enforce exhaustiveness on the consumer (panel-state deriver) with a `never`-typed default that crashes loudly. The reference doc's Principle A8 (discriminated union without exhaustive switch) explicitly calls this out as P2 for the outer discriminator; treating the nested status union with the same discipline is consistent.

---

## P3-2 — `deriveGroupCreatedForBrowser` synthetic hydration hardcodes `status: "active"` — race with REST bootstrap on degraded/reconnecting reload

**Severity:** P3
**File:** `/tmp/aura-pr68-bootstrap-fix/web/server/ws-bridge.ts:1265-1302`

**Finding:** The synthetic hydration path in `ws-bridge` returns `null` when the counterpart session is not registered in `this.sessions`. For a pair in `degraded` (one CLI dead, session removed from map) or `reconnecting` (CLI exited, in 45s grace, session removed), the synthetic path returns null and the REST bootstrap is the only source. That works correctly. BUT for a pair that is genuinely active when the browser reconnects, the synthetic path emits `status: "active"`. If the REST bootstrap (`useEffect` on `App.tsx:189`) lands BEFORE the WS opens — which is the normal ordering — `hydrateGroups` inserts the record with the coordinator's authoritative status. Then the WS opens, the bridge sends the synthetic frame, and `upsertGroup` (NOT `hydrateGroups` — `case "group_created"` calls `store.upsertGroup` which DOES clobber) overwrites the freshly-hydrated record. In the all-active case this is a no-op (status was already "active"). In the corner case where REST bootstrap returned `status: "active"` but the coordinator transitioned to `degraded` between REST snapshot and WS open, the synthetic hydration would lock the client back to "active" while waiting for the live `group_degraded` push to correct it. Window is small (one round-trip) but observable.

**Consequence:** Transient mislabel of the panel pill on the orchestrator's reload during a state transition. Self-correcting on the next live `group_degraded` / `group_exited` push, so user-visible duration is sub-second in practice.

**Fix:** `deriveGroupCreatedForBrowser` already has access to the orchestrator's coordinator through the orchestrator instance, but the bridge intentionally avoids that dependency (per the JSDoc at `ws-bridge.ts:1259-1264`: "no orchestrator dependency is needed"). Cleanest minimal fix: change the synthetic frame's emit semantics to NOT overwrite an existing store record — either add an `isSynthetic: true` field to the wire variant the client treats like `hydrateGroups` (insert-only), OR have the bridge skip synthetic emit entirely when the REST bootstrap is wired (since REST + live push are now sufficient). The current refactor preserved the helper-determinism floor; this is a follow-up worth filing as a small task, not a blocker.

---

## P3-3 — REST endpoint has no input validation but also no inputs — clean

**Severity:** P3 (informational, no action)
**File:** `/tmp/aura-pr68-bootstrap-fix/web/server/routes.ts:496-499`

**Finding:** Reference doc Principle A2 calls for input validation at the Hono boundary. The new `GET /api/groups` route takes no path params, no query string, no body. The only input is the auth header, validated by the `/api/*` middleware at `routes.ts:155-175` (registered BEFORE this route, so middleware order is correct). The handler delegates entirely to `orchestrator.getAllGroupsForBootstrap()` and wraps the snapshot. No injection surface. No path-traversal surface. Symmetric to the existing `GET /api/groups/:groupId/findings` from PR #61 (which validates `groupId` because it indexes a map; this endpoint indexes nothing). Auth-inherit-from-mount is the established pattern across `web/server/routes.ts`. No finding — calling it out so a future reader doesn't add validation theatre.

**Consequence:** None.

**Fix:** None.

---

## Cross-cutting observation — keystone refactor lands cleanly

The three producers (`session-orchestrator.ts:1195-1213` live push listener, `session-orchestrator.ts:2978-2989` REST snapshot, `ws-bridge.ts:1287-1300` synthetic hydration) now share the `buildBrowserGroupRecord` helper at `web/server/browser-group-record.ts:50-59`. Field ordering, pairing concatenation, and `wakeTimeoutMs` constant cannot drift across these three call sites because there is only one assembly site. The legacy `?? "claude"` backend-type fallback is preserved per call site at the input layer where it semantically belongs (only the orchestrator and bridge paths have raw launcher data; the coordinator's `GroupRecord` already carries resolved backend types). This is the cleanest version of the multi-producer-fan-in pattern I have seen on this codebase, and the brief's nomination for an `AP-X` convention (multi-producer wire shapes route through one assembly site) is well-supported.

Replay/seq interaction is correct: `sequenceEvent` runs at broadcast time, AFTER the helper composes the frame, so the new `status` field is sequenced and buffered like any other wire field. The wire variant change is additive on the server side (the helper guarantees emit), defensive on the client side (`?? "active"` fallback) — modulo the P2-1 wire-typing question above. No protocol-strictness gate breaks. No fan-out ordering concern. No keep-alive cadence interaction.
