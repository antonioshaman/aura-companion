# Bun + Hono + TypeScript Backend Review — Council Mode Phase A+B+C

**Reviewer lens:** Carmack × Matteo Collina × Bun/Hono — async/await discipline, TS strict-mode correctness, AbortController hygiene, fs sync/async deliberateness, validator-narrowing alignment, structured logging, resource lifecycle.
**Files in scope:** `atomic-write.ts`, `checkpoint-watcher.ts`, `session-group-coordinator.ts`, `codex-envelope.ts`, `group-reconciliation.ts`, `observer-permissions.ts`.

---

## Finding 1 — Silent kill failures in `archiveGroup` and `createGroup` rollback

- **File:lines:** `web/server/session-group-coordinator.ts:120-130, 152-162`
- **Principle:** Principle 1 — *"Programmer errors crash, operational errors are handled."* Combined with Principle 6 — structured logging.
- **Severity:** **P2**
- **What's wrong:** Three empty `catch { /* swallow */ }` (or unannotated) blocks wrap subprocess `kill()` calls — one on the rollback path of `createGroup`, two in the best-effort sequential teardown of `archiveGroup`. There is no `log.warn` / `log.error` / `onError` callback emitted, no structured event recording, no fallthrough into a dead-letter list. The project already has a structured logger (`./logger.ts` exporting `log.info/warn/error` with a module field) so the absence is not "no facility available," it is silent.
- **Consequence:** When a kill fails (process already dead, permission error, EPERM after uid change, race with self-exit, etc.) the coordinator believes the group is gone and removes it from `groups` (or never adds it). The actual subprocess survives as an orphan that no UI surface and no reconciliation tombstone records. The original error propagated to the caller in `createGroup` is the OUTER failure — the inner rollback failure is invisible. Operationally this is the worst class of bug: durable state (live PID) inconsistent with in-memory map, and no log line to grep when an operator notices an orphan `claude --sdk-url` later.
- **Fix:** Replace the three empty catches with a single private helper `safeKill(sessionId, context)` that catches, classifies, and logs via `log.warn("session-group-coordinator", "kill failed", { sessionGroupId, sessionId, context, error: ... })`. Optionally accumulate the rollback failure into the outer error via `Error.cause` so the caller sees both.

---

## Finding 2 — Watcher does not propagate abort into in-flight debounce handlers

- **File:lines:** `web/server/checkpoint-watcher.ts:38-69, 71-95`
- **Principle:** Principle 5 — *"Understand the lifecycle of every resource you allocate."* AbortController hygiene specifically called out in the brief.
- **Severity:** **P2**
- **What's wrong:** The `finally` block cancels pending debounce timers. Good. But two windows of "post-abort delivery" remain unhandled:
  1. A `setTimeout` callback that has already fired before `clearTimeout` runs (timer was scheduled to elapse at, say, t=149ms; abort hits at t=151ms; the callback ran at t=150ms and is now executing `void readAndEmit(...)` which is awaiting `readFile` and `onCheckpoint`). `readAndEmit` neither receives nor checks `opts.signal`, so `onCheckpoint(payload)` will fire AFTER the caller's `await watchCheckpoints(...)` has resolved.
  2. `void readAndEmit(...)` is fire-and-forget; if abort lands while the promise is in flight, it completes asynchronously after the watcher loop is gone.
- **Consequence:** Callers that abort the watcher and then immediately tear down dependent state (close DB, archive group, mutate observer mailbox) can race with a late `onCheckpoint` callback. The contract documented in the JSDoc says "Aborting cleanly resolves the returned promise" — but the side effect (handler invocation) is not actually quiesced. This is exactly the kind of "fixed in tests, blows up in prod" bug that AbortController hygiene exists to prevent.
- **Fix:** Pass `opts.signal` to `readAndEmit`. Check `signal.aborted` at the top of `readAndEmit` and before `await onCheckpoint(payload)`. Optionally track the in-flight promises in a `Set<Promise<void>>` and `await Promise.allSettled([...inflight])` inside the `finally` so the returned promise truly resolves only after all handlers settle.

---

## Finding 3 — Unstructured `console.warn` default in a module that should use `log.warn`

- **File:lines:** `web/server/checkpoint-watcher.ts:40-42`
- **Principle:** Principle 6 — structured logging.
- **Severity:** **P3**
- **What's wrong:** The default `onDropped` callback writes via `console.warn(\`[checkpoint-watcher] dropped ${file}: ${reason}\`)`. The project has `web/server/logger.ts` exporting a structured `log.warn(module, msg, data)` with JSON mode behind `COMPANION_LOG_FORMAT=json` and file-rotation under `~/.companion/logs/`. Other modules in the same directory (`session-orchestrator`, `cli-launcher`, `ws-bridge`, `recorder`) use it. This one module silently bypasses it — meaning watcher drops are invisible to log-file consumers and lack structured fields (sessionGroupId, directory, reason).
- **Consequence:** When an operator investigates "why is the observer not waking on checkpoints?", grepping the structured log surface returns nothing. They must know to scroll raw stdout. Drop reason (invalid-schema, read-error, handler-error, oversize) is encoded as a free-form string instead of an indexable field.
- **Fix:** Default `onDropped` should call `log.warn("checkpoint-watcher", "dropped event", { file, reason })`. Or, since the module is a leaf primitive, require the caller to always provide `onDropped` — pushing the logging decision to the wiring layer.

---

## Finding 4 — Sync fs choice in `atomic-write.ts` is correct but worth a comment for the caller side

- **File:lines:** `web/server/atomic-write.ts:18-52`
- **Principle:** Principle 7 — *"Latency is always a bug"* / Bun event-loop awareness.
- **Severity:** **P3**
- **What's wrong:** Not actually wrong — flagging deliberately, per the brief. The sync choice (`openSync`/`writeSync`/`fsyncSync`/`renameSync`) is the *right* call for an atomic durability primitive: the caller needs the rename to be visible AND fsynced before continuing, so async would just gain a context switch and a chance to interleave another writer. The fsync of the parent dir is also necessarily sync. **However**, the file-level JSDoc does not justify the sync choice, and the call site (`writeArchiveTombstone` in `group-reconciliation.ts`, the future orchestrator checkpoint emitter) is reachable from Hono request handlers. Under load (one tombstone per group archive, OK; but if checkpoint writes ever fan out to many groups per request), this blocks the event loop for the duration of two fsync calls — measurable.
- **Consequence:** A future maintainer wondering "should I make this async?" has no explanation. A future caller emitting many checkpoints in a tight loop in one request handler will discover the cost the hard way.
- **Fix:** Add a one-line comment at the top of `writeAtomicJson` documenting the sync deliberateness and the per-call event-loop cost (~one fsync of file + one fsync of dir). Document that it is **not** to be called from inside `for` loops in request handlers — batch writes belong elsewhere.

---

## Finding 5 — Loose `as Error` casts in error-message extraction

- **File:lines:** `web/server/checkpoint-watcher.ts:62, 82, 93`
- **Principle:** Principle 8 — *"Type safety at the boundary"* — catch typed as `unknown`, narrow with `instanceof Error`.
- **Severity:** **P3**
- **What's wrong:** Three patterns:
  - Line 62: `(err as { name?: string } | null)?.name` — a soft type-assert before name-check. Works in practice but lies to TS: a thrown string would slip through the check and propagate as not-AbortError correctly, so functionally OK; the cost is silenced strict-mode rigor.
  - Lines 82 and 93: `(err as Error).message` — JS can throw anything. If the readFile rejection ever yielded a non-Error (very rare but possible from a userland handler), `.message` would be `undefined` and the dropped log would say `read-error: undefined`.
- **Consequence:** Cosmetic in current Node/Bun fs error shapes (always Error subclasses) — but the pattern is the one Collina/Dodds warn about, and the project uses `unknown` + `instanceof Error` narrowing elsewhere (e.g. `cli-launcher.ts`, `recorder.ts`).
- **Fix:** Replace with `err instanceof Error ? err.message : String(err)` in the two dropped-log paths, and `err instanceof Error && err.name === "AbortError"` in the catch filter.

---

## Finding 6 — Codex envelope `id` shape narrower than JSON-RPC 2.0 (flagging for backend lens; protocol semantics out of lane)

- **File:lines:** `web/server/codex-envelope.ts:43-45`
- **Principle:** Principle 8 — type system as armour; runtime validator must match the protocol it claims to parse.
- **Severity:** **P3** (and arguably out of my lane — protocol expert should confirm)
- **What's wrong:** `isValidId` accepts only non-negative integers. JSON-RPC 2.0 §4 allows `id` to be a string, integer, or null (the latter for parse errors). The brief says the validator "validates frame shape only" so this may be intentional — Codex in practice uses integer ids. From a TypeScript-narrowing-versus-protocol-truth angle, the validator is **strict**, not just `as`-asserting — it genuinely rules out non-integer ids via `Number.isInteger`. Good. But if Codex ever returns a string id (per spec it may), the frame is dropped silently. Brief calls this out as "protocol semantics" — flagging only so the realtime-protocol reviewer doesn't miss it.
- **Consequence:** If Codex behaviour drifts, frames vanish with no log because callers "drop the message — never log-and-forward" per file comment.
- **Fix:** Out of my lane — defer to realtime/NDJSON reviewer. Backend-lens recommendation: add an optional `onRejected(raw, reason)` callback so dropped frames are observable.

---

## Summary

- 6 findings: 0 P1 / 2 P2 / 4 P3.
- No P1 backend issues. Module discipline is high — pure functions, validators return null without throw, the coordinator composes via DI, atomic-write uses proper tmp+rename+fsync.
- Top concerns: (1) silent kill-failure swallowing in the coordinator's rollback and teardown paths; (2) AbortController abort does not actually quiesce in-flight handlers in the checkpoint watcher.
- One module (`checkpoint-watcher.ts`) is the only one using raw `console.warn` while the project has a structured `log.warn` already in use across ~40 server files. Easy fix.
- `atomic-write.ts` sync choice is correct — flagging only for a docstring note about call-site responsibility.
- `codex-envelope.ts`, `group-reconciliation.ts`, `observer-permissions.ts` have no backend findings.
