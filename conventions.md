# Project Conventions

Accepted patterns and enforced conventions from council reviews. The council reads this file before every review to avoid re-flagging resolved decisions.

---

## Accepted Patterns

These are intentional — do not flag as findings.

### AP-1: Coordinator decoupled from session-orchestrator via dependency injection

**Pattern:** `web/server/session-group-coordinator.ts` consumes spawn/kill through injected `SessionSpawner` / `SessionKiller` callbacks and never imports `session-orchestrator.ts` directly. Group lifecycle composes on top of the existing single-session machinery without branching it.
**Origin:** Fowler — Council Review 2026-05-11-1953
**Rationale:** This is the structural keystone (PLAN Task 4) that keeps the single-session happy path unbranched; collapsing it would force every future change to reason about paired vs solo.

---

### AP-2: `group-state-machine.ts` is single source of truth for group lifecycle status

**Pattern:** Group status is a discriminated union (`pairing | active | degraded | archived | reconnecting`) mutated only through a pure `transition(state, event)` function. Callers consume `GroupRecord.status` directly; they do not introduce parallel booleans (`isDegraded`, `isOperable`, etc.) or re-derive lifecycle facts inline.
**Origin:** Fowler — Council Review 2026-05-11-1953
**Rationale:** Eliminates the "three diverging boolean expressions in three files" anti-pattern the union was designed to prevent.

---

### AP-3: `council-types.ts` hosts both writer- and reader-side schemas in one file

**Pattern:** `CheckpointPayload` (orchestrator-emitted) and `ObserverReviewPayload` (observer-emitted) live in the same module alongside their parsers and the shared `COUNCIL_SCHEMA_VERSION`. Validators reject schema drift on either side from one place.
**Origin:** Fowler — Council Review 2026-05-11-1953
**Rationale:** Non-speculative because two consumers exist on day one; the shared file prevents writer/reader drift that would otherwise be silent.

---

## Enforced Conventions

These must be followed — flag violations as findings.

### EC-1: Observer SDK permission profile must be applied AT spawn (in argv), with a boot-time canary

**Convention:** The observer subprocess's `allowedTools`, `disallowedTools`, and `permissionMode` from `getObserverSpawnOverrides(backendType)` must be passed through `SessionSpawner` → `LaunchOptions` → spawn argv at process-creation time. Runtime/post-spawn injection is not enforcement. Server bootstrap must invoke `assertObserverToolPolicyConsistent()` so a future allow-list edit that overlaps the deny list goes red at startup.
**Origin:** Subprocess Lifecycle × Hunt × Willison × Beck — Council Review 2026-05-11-1953 (finding #1, cross-ref #7, #8)
**Principle:** `references/quality-subprocess.md` → Principle 1; `references/security.md` → Principle 7

---

### EC-2: Group-aware kills must mark BOTH session IDs as intentional before either kill executes

**Convention:** Before calling `kill(primary)` or `kill(observer)` on a paired session group, BOTH IDs must be present in `session-orchestrator.intentionalKills` (or via the injected `markIntentional()` surface on `SessionKiller`). Coordinator-internal status flips alone are insufficient — they do not gate `scheduleProactiveRelaunch`. Tests must exercise the cross-listener race (fake spawner emitting `session:exited` on the first kill).
**Origin:** Subprocess Lifecycle — Council Review 2026-05-11-1953 (finding #2)
**Principle:** `references/quality-subprocess.md` → Principle 3

---

### EC-3: Coordinator types must distinguish Companion `sessionId` from CLI `cliSessionId`

**Convention:** Anywhere the coordinator, group records, or reconciliation actions reference "the observer's ID" or "the primary's ID", the type must carry `sessionId` (Companion routing UUID) AND `cliSessionId?: string` (CLI's `--resume` token, populated after `system.init`). Never collapse both concepts into one string slot. Relaunch paths that need a resume token must read it from the launcher's live record, not from coordinator-owned state.
**Origin:** Subprocess Lifecycle — Council Review 2026-05-11-1953 (finding #3)
**Principle:** `references/quality-subprocess.md` → Principle 5

---

### EC-4: Filesystem watcher debounce must never silently coalesce distinct payloads

**Convention:** Any debounce on a filesystem watcher (currently `checkpoint-watcher.ts`) must guarantee that every payload that crossed the rename barrier is either read-and-emitted OR read-and-dropped-with-reason via `onDropped`. Debouncing by filename alone is forbidden when two distinct payloads can land on the same path within the window — use `(file, mtime|size|content-hash)` keying or read inside the debounce window and emit per distinct payload. Required test: two `writeAtomicJson` calls to the same path within the debounce window emit both payloads (or log the drop).
**Origin:** FS-JSON Persistence × Beck — Council Review 2026-05-11-1953 (finding #4)
**Principle:** `references/quality-persistence.md` → Principles 1, 4

---

### EC-5: Protocol parsers reject unknown METHODS and FRAME SHAPES; tolerate polymorphic-by-spec FIELDS

**Convention:** Codex JSON-RPC and Claude NDJSON parsers must reject frames whose discriminator (method name, type tag) is outside the known set. They must NOT reject legitimate polymorphic shapes within a known frame: JSON-RPC `id` may be `string | number | null`; `params` may be `object | array | omitted`. Strict-on-discriminator + permissive-on-polymorphic-fields is the correct shape. Every `return null` rejection must invoke an `onDropped(reason, frame)` hook — silent rejection is forbidden.
**Origin:** Realtime/NDJSON Protocol — Council Review 2026-05-11-1953 (finding #5)
**Principle:** `references/quality-realtime.md` → Principle 7

---

### EC-6: Load-bearing protocol parsers require replay-based regression tests against captured recordings

**Convention:** Every parser that sits on the bridge's protocol boundary (currently `claude-adapter.ts`, `codex-envelope.ts`; future: any new envelope/adapter module) must have a regression test that loads a captured `~/.companion/recordings/*.jsonl` fixture and feeds each line through the parser, asserting non-null typed output. Hand-crafted JSON literals do not substitute. Fixtures live under `web/server/fixtures/` and are refreshed when the upstream CLI ships a protocol change.
**Origin:** Realtime/NDJSON Protocol — Council Review 2026-05-11-1953 (finding #6)
**Principle:** `references/quality-realtime.md` → Principle 7

---

### EC-7: Filesystem-access predicates must inline path resolution or only be reachable through a resolving wrapper

**Convention:** Allowlist/denylist predicates that take a path argument (currently `isObserverWriteAllowed`; future: any analogous helper) must either call `realpathSync` internally (climbing to nearest existing parent for non-existent paths) OR be NOT exported directly — only an `assertObserverCanWrite`-style wrapper that performs realpath + predicate as one unit may be exported. Defence by JSDoc convention is forbidden for security boundaries.
**Origin:** Hunt — Council Review 2026-05-11-1953 (finding #9)
**Principle:** `references/security.md` → Principle 7

---

### EC-8: Reconciliation actions require sentinel-before-sweep helpers

**Convention:** Every reconciliation action that mutates group state (`archive_dead`, `mark_orphan`, `relaunch_observer`) must have a `writeAtomicJson`-backed sentinel-write helper (`writeArchiveTombstone`, `writeOrphanMarker`, `writeRelaunchIntent`, etc.). The caller pattern is: decide → writeMarker → act → (optionally) deleteMarker. A crash between writeMarker and act must leave the next reconciliation looking at the marker and resuming idempotently. Silent swallow of action-side failures (`try { ... } catch { /* swallow */ }`) is forbidden — emit a structured log line with `event`, `sessionGroupId`, `role`, and propagate via `Error.cause` / `AggregateError`.
**Origin:** FS-JSON Persistence × Bun/Hono/TS Backend — Council Review 2026-05-11-1953 (finding #11, cross-ref persistence P2-4)
**Principle:** `references/quality-persistence.md` → Principle 3; `references/quality-backend.md` → Principle 1

---

### EC-9: Group-lifecycle log lines must be structured JSON with required context fields

**Convention:** Every log call on the group-lifecycle surface (`session-group-coordinator.ts`, `checkpoint-watcher.ts`, `group-reconciliation.ts`, future group code) must use a structured logger emitting JSON with at minimum `event` + `sessionGroupId` + (where applicable) `sessionId` + `role`. `console.log` / `console.warn` are forbidden in production paths on this surface. A child-logger pattern bound at group-creation time is the canonical wiring.
**Origin:** Bun/Hono/TS Backend — Council Review 2026-05-11-1953 (finding #15)
**Principle:** `references/quality-backend.md` → Principle 6

---

### EC-10: Discriminated-union state renderers must compile-fail on missing variants

**Convention:** Any UI component that switches on a discriminated-union state (e.g. `ObserverPanelState`, `SessionPhase`, group lifecycle pills) must include a `const _: never = state;` (or equivalent exhaustiveness check) in the `default` branch. Adding a new variant to the union without extending the switch must fail typecheck rather than silently render an empty header. The pattern is mandatory on any state-pill, status-banner, or stage-indicator component whose union has ≥3 variants.
**Origin:** Friedman (UX Quality) — Council Review 2026-05-13-0100 (finding #5)
**Principle:** `references/quality-ux.md` → Principle 2 (Design all five screen states)

---

### EC-11: Wallclock-anchored derived state requires an explicit clock-tick subscription

**Convention:** Any derived state whose transition is gated on `nowMs > someDeadline` (e.g. `reviewing → reviewing-stalled` at `lastCheckpointAt + wakeTimeoutMs`, idle-kill timers, grace-window expiries) must be paired with either (a) a `setInterval` / `useTimer` subscription that re-renders periodically, or (b) a server-emitted deadline-fired event the client consumes via `ws.ts`. Pure derivation alone is structurally unreachable in production because the component re-renders only on state changes — not on the wallclock passing through a deadline. Option (b) is preferred because it preserves the "single mutation channel via ws.ts" discipline; option (a) is acceptable when the deadline is short (< 30s).
**Origin:** React/Web UI — Council Review 2026-05-13-0100 (finding #4)
**Principle:** `references/quality-frontend.md` → Principle 1 (single source of truth for derived state)

---

### EC-12: `fs.watch`-driven pipelines require an explicit pre-scan reconcile on initialize

**Convention:** Any pipeline that depends on `fs.watch` events to drive durable state mutation (council checkpoint→wake, review-watcher→grounding, future filesystem-driven flows) must implement a scan-on-initialize reconciler that enumerates pre-existing files in the watched directory, compares them against the persisted sentinel state, and fires the corresponding action for any gap. `fs.watch` is event-only post-attach — it does NOT replay existing files on watcher start. A pipeline that promises "restart-idempotent" behaviour without the scan ships green but loses state across crashes. The reconciler must be idempotent (the sentinel-before-sweep wrapper from EC-8 is the canonical pattern).
**Origin:** FS-JSON Persistence — Council Review 2026-05-13-0100 (finding #6)
**Principle:** `references/quality-persistence.md` → Principle 7 (Replay determinism)

---
