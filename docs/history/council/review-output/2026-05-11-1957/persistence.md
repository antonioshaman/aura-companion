# FS-JSON Persistence Review — Council 2026-05-11-1957

Reviewer: FS-JSON Persistence Expert (Carmack Council)
Scope: `web/server/atomic-write.ts`, `web/server/council-types.ts`, `web/server/checkpoint-watcher.ts`, `web/server/group-reconciliation.ts`
Lens: filesystem durability, atomicity, crash-recovery, replay determinism, schema evolution.

---

## P1 — Fix Now

### F1. Tombstone is "mark" with no "sweep" — no recovery path consumes it

- **File:** `web/server/group-reconciliation.ts:66-88`
- **Principle:** Principle 3 (Sentinel rows / close every state on every exit path) — also Principle 8 (schema versioning).
- **Severity:** P1
- **What's wrong:** `writeArchiveTombstone` writes `.council/ARCHIVED` atomically and the docstring claims "A crash between mark and sweep leaves a consistent archived-but-not-yet-swept state that the next reconciliation can detect and finish idempotently". There is no sweep code in any file under review and no reader of `.council/ARCHIVED` exists. `decideReconciliation` does not consult it, the watcher does not consult it, and the file name is a fixed `ARCHIVED` (single slot) so writing a second tombstone for a different `sessionGroupId` silently overwrites the first one. The tombstone is the mark half of a mark-then-sweep protocol whose sweep half is missing.
- **Consequence:** (a) Multiple archived groups in the same workspace lose their tombstones to last-writer-wins. (b) Crash between tombstone write and directory cleanup leaves orphan checkpoint files that the watcher will happily re-emit on restart — the very torn-purge the comment promises to prevent. (c) The "archived but not yet swept" state is unreachable in practice, so the recovery guarantee is documented but not implemented.
- **Fix:** Either (i) make the tombstone path per-group (e.g. `.council/archived/<sessionGroupId>.json`) so multiple archives coexist, then implement the sweep step that reads tombstones on startup, deletes the matching `.council/checkpoints/*` and `.council/reviews/*` files, then unlinks the tombstone last — or (ii) downgrade the docstring claim until the sweep half lands.

---

### F2. No schema_version on `TombstonePayload` — silent drift on next migration

- **File:** `web/server/group-reconciliation.ts:72-87`
- **Principle:** Principle 8 (JSON shape evolution — version every schema).
- **Severity:** P1
- **What's wrong:** Every other persistent council artifact in this PR carries `schema_version: typeof COUNCIL_SCHEMA_VERSION` and is parsed through a validator that rejects unknown versions. `TombstonePayload` has only `session_group_id` and `archived_at`. The file is the future sweep loop's input — when its shape evolves (e.g. adding `archive_reason` to distinguish `neither_alive` from manual archive), an old reader silently lacks the field and may take the wrong cleanup branch.
- **Consequence:** First migration after this lands will require either a flag-day rewrite of all tombstones or an unversioned reader that defaults blindly. Defaulting on a tombstone is dangerous — it gates destructive cleanup.
- **Fix:** Add `schema_version: typeof COUNCIL_SCHEMA_VERSION` to `TombstonePayload`, write a `parseTombstonePayload` mirror of the two existing parsers, reject unknown versions.

---

### F3. `.tmp` filename predicate is too narrow vs. watcher's dotfile filter — staged tmps survive in the directory

- **File:** `web/server/atomic-write.ts:29` and `web/server/checkpoint-watcher.ts:48`
- **Principle:** Principle 1 (Atomic write or it didn't happen) — boundary discipline between writer and reader.
- **Severity:** P1
- **What's wrong:** The writer's tmp name is `.${randomBytes(8).toString("hex")}.tmp`. The watcher filters with `file.startsWith(".") || !file.endsWith(".json")`. These two filters happen to agree only because the tmp name begins with `.`. If a future caller passes `target` ending in non-`.json` (the function is generic — see the tombstone, which writes `.council/ARCHIVED` with no extension) the directory accumulates orphan tmp files when the process crashes after `openSync` but before `renameSync`, with no cleanup pass. Worse: `writeArchiveTombstone` writes to `.council/ARCHIVED` (no extension) — if the watcher were ever pointed at that directory, the watcher's `!file.endsWith(".json")` rule would also filter the legitimate tombstone, defeating its own purpose.
- **Consequence:** (a) Orphan `.<hex>.tmp` accumulation after crashes — visible disk growth in `.council/checkpoints/`. (b) The two filenames (writer tmp vs reader allowlist) are coupled by convention with no shared constant — a refactor of one without the other silently breaks atomicity guarantees.
- **Fix:** Hoist the tmp suffix and the reader allowlist to a shared constant in `council-types.ts` (e.g. `COUNCIL_TMP_PREFIX = "."`, `COUNCIL_TMP_SUFFIX = ".tmp"`). On watcher startup, sweep stale tmp files older than N seconds. Document that `writeAtomicJson` requires the target name to be one the reader will accept.

---

### F4. `writeAtomicJson` does not sweep the tmp file on rename failure

- **File:** `web/server/atomic-write.ts:31-51`
- **Principle:** Principle 3 (close every state on every exit path) — applied to staged tmps as transient "open" state.
- **Severity:** P1
- **What's wrong:** The `try/finally` around `openSync`/`writeSync`/`fsyncSync` closes the fd but does NOT `unlink` the tmp file on any failure path. If `renameSync(tmp, target)` throws (EXDEV cross-device, EACCES, ENOSPC, or interrupted by SIGTERM between `closeSync` and `renameSync`), the tmp file remains on disk. Each retry creates a fresh `.<rand>.tmp` because the name is randomised — there is no fixed staging name that gets overwritten.
- **Consequence:** Long-running orchestrator that hits transient `ENOSPC` on a busy filesystem leaks one tmp per failed write. The directory grows unboundedly with `.deadbeef.tmp`, `.cafebabe.tmp`, … . The watcher correctly ignores them but `fs.watch` still fires events for them, pumping CPU and the dropped-event log.
- **Fix:** Wrap from `openSync` through `renameSync` in a single `try` that unlinks `tmp` in the `catch` (best-effort, swallow ENOENT). On success, the rename consumes the tmp so the unlink is a no-op.

---

## P2 — Fix Soon

### F5. Watcher has no event dedup by content / checkpoint_id — same checkpoint re-emitted on every metadata touch

- **File:** `web/server/checkpoint-watcher.ts:38-69`
- **Principle:** Principle 3 (idempotency on state transitions) + Principle 7 (replay determinism).
- **Severity:** P2
- **What's wrong:** Debounce is keyed only by `filename`. `fs.watch` fires `change` events for any metadata write (mtime/atime touch, `chmod`, `chown`, partial rewrite). If the orchestrator re-emits the same checkpoint (idempotent retry — same `checkpoint_id`, same `sequence`), the watcher reads + parses + invokes `onCheckpoint` again. There is no dedup on `checkpoint_id` inside the watcher itself; that duty is pushed to the handler. Comparable: the schema defines `checkpoint_id` as "stable id … used by observer for dedup" but the watcher discards that affordance one layer above.
- **Consequence:** Observer sees the same checkpoint N times under common conditions (e.g. editor saving to inspect, antivirus touching the file, the orchestrator legitimately retrying). Every duplicate burns one observer turn. With Claude Code costs and rate limits per turn, this is a tangible burn.
- **Fix:** Maintain a small LRU keyed by `checkpoint_id → emitted_at` inside the watcher; skip emit when `(checkpoint_id, emitted_at)` is unchanged from last emit. Bound to ~256 entries. Document that the handler may still receive a duplicate after a watcher restart.

---

### F6. `parseCheckpointPayload` reuses `MAX_FINDINGS` (50) as the cap for `artifact_paths` — wrong axis, latent surprise

- **File:** `web/server/council-types.ts:118`
- **Principle:** Principle 8 (schema validation discipline) + Principle 4 (structure should make intent obvious).
- **Severity:** P2
- **What's wrong:** Line 118: `if (parsed.artifact_paths.length > MAX_FINDINGS) return null;`. The constant is `MAX_FINDINGS = 50` — defined for observer review findings, not for orchestrator artifact paths. A phase that legitimately lists 51 changed files (e.g. a large refactor checkpoint) gets silently rejected as `invalid-schema` by the watcher with no diagnostic. The mismatch is invisible at the call site.
- **Consequence:** Silent drop of legitimate large checkpoints. The watcher logs `dropped <file>: invalid-schema` — there is no telemetry distinguishing schema-version mismatch from path-list overflow.
- **Fix:** Introduce `MAX_ARTIFACT_PATHS` (separate constant) and use it here. Have validators return a tagged failure reason (`"too-many-paths" | "bad-version" | "bad-phase" | …`) rather than `null` so `onDropped` can log the actual cause.

---

### F7. `isBoundedString` rejects strings containing any space — `emitted_at` ISO timestamps break if anyone ever uses RFC 3339 with space separator

- **File:** `web/server/council-types.ts:70-72, 116, 150`
- **Principle:** Principle 8 (validators must reject loudly for the right reason) + Principle 7 (replay determinism / round-trip).
- **Severity:** P2
- **What's wrong:** `isBoundedString` is also used to validate `emitted_at` and `reviewed_at`. RFC 3339 allows `2026-05-11 19:57:00Z` (space) as well as `2026-05-11T19:57:00Z` (T). `Date.prototype.toISOString()` always uses `T` so the current writers are fine, but the validator is the contract: a future producer (different runtime, different language) emitting RFC 3339 space-form would fail validation silently. Worse, `isBoundedString` is a generic "non-empty, bounded, no-space" predicate masquerading as "general bounded string" — calling it for both `session_group_id` (where no-space is sensible) and `emitted_at` (where no-space is incidentally true but not intentional) couples two unrelated rules.
- **Consequence:** Subtle protocol incompatibility. Drops are silent and look like schema-version mismatch.
- **Fix:** Split: `isBoundedToken` (no whitespace) for IDs vs `isBoundedTimestamp` (parses with `Date.parse`, ISO 8601 shape regex) for timestamps. Reject `NaN` from `Date.parse`.

---

### F8. No `schema_version` bump path — first migration must rewrite all files in place

- **File:** `web/server/council-types.ts:11-12, 102-131, 137-178`
- **Principle:** Principle 8 (version every schema, and have a migration story).
- **Severity:** P2
- **What's wrong:** `COUNCIL_SCHEMA_VERSION = 1 as const` and both parsers reject anything but version 1. There is no `parseCheckpointPayloadV1`/`V2` split, no fallback, no upgrade function, no documented migration policy. When version 2 ships, version-1 checkpoint files on disk (left from a long-running session, or a downgrade scenario) will be rejected — the observer will silently drop them. No migration utility is present in the PR.
- **Consequence:** First schema change is a flag-day. Long-running councils that started under v1 and saw the server restart into v2 lose their entire checkpoint history. Tests/replay captures from v1 are unreplayable under v2.
- **Fix:** Document the migration policy in this file's module docblock: either (a) parsers accept a closed set of versions and explicitly upgrade in-memory, or (b) a separate `migrate-council-artifacts.ts` script runs at startup to rewrite old files. Even a one-line policy ("v1 → v2 requires running migrate script") closes the gap.

---

### F9. Watcher fires `void readAndEmit(...)` — unhandled promise rejection on rare paths

- **File:** `web/server/checkpoint-watcher.ts:55-58, 71-95`
- **Principle:** Principle 3 (close every state on every exit path) — applied to async handlers.
- **Severity:** P2
- **What's wrong:** The setTimeout callback is sync and fires `void readAndEmit(...)`. `readAndEmit` wraps `readFile` and `onCheckpoint` in try/catch that call `onDropped`, but `onDropped` itself is unguarded. If a custom `onDropped` throws (cheap mistake — log line construction does string concat with `(err as Error).message` which may be `undefined` on non-Error rejections), the rejection is unhandled and Bun's default behaviour is to terminate the process. The watcher kills the whole server.
- **Consequence:** A buggy custom `onDropped` in any caller (test, future wiring) takes the server down. Detached promises in finally-block scope are hard to grep for.
- **Fix:** Wrap the body of `readAndEmit` in an outer try/catch that swallows or logs to `console.error` directly (last-resort). Alternatively, the setTimeout callback can be `async () => { try { await readAndEmit(...); } catch {} }`.

---

### F10. `randomBytes(8).toString("hex")` for tmp suffix is overkill but harmless — fixed name would be simpler and self-cleaning

- **File:** `web/server/atomic-write.ts:29`
- **Principle:** Principle 1 (atomic write contract — simpler invariants).
- **Severity:** P2
- **What's wrong:** A random suffix means concurrent writers to the same `target` don't collide on the tmp file, but the writer is `writeAtomicJson` against `target` — concurrent writes to the same target are already a logical race that the random suffix doesn't fix (last rename wins, no ordering guarantee). The random suffix only matters if there's a desire for both tmps to coexist, which there isn't. A fixed `${target}.tmp` suffix in the same dir would self-overwrite on retry and not leak (combined with F4's unlink-on-failure).
- **Consequence:** Currently leaks (see F4). Random suffix obscures the leak by making each leak file unique.
- **Fix:** Either (a) use `${basename}.tmp` (single staging slot), or (b) keep the random suffix and rely on F4's unlink to clean up. Pick one and document why.

---

## P3 — Consider

### F11. `parseCheckpointPayload` is order-sensitive on object key iteration but tests likely don't enforce it — replay determinism caveat

- **File:** `web/server/council-types.ts:122-130`
- **Principle:** Principle 7 (replay determinism — recordings must round-trip).
- **Severity:** P3
- **What's wrong:** The parser reconstructs the payload field-by-field in a fixed order, which is good for shape but the return is then `JSON.stringify`'d at the write side with implementation-defined key order. `Bun.JSON.stringify` and `V8` agree today, but for replay tests that hash payloads, depending on key-order determinism is fragile across runtimes.
- **Consequence:** Cross-runtime replay hash drift. Negligible at current scale.
- **Fix:** If tests ever hash serialised payloads, add a `canonicalStringify(payload)` helper that sorts keys. Otherwise document the dependency.

---

### F12. `mkdirSync(dir, { recursive: true })` on every write — cheap but not free, and silently masks one class of bug

- **File:** `web/server/atomic-write.ts:20`
- **Principle:** Principle 1 (boundary discipline).
- **Severity:** P3
- **What's wrong:** The mkdir-on-every-write idiom is convenient but masks the case where `target`'s parent directory was deliberately removed (e.g. operator manually purging `.council/`). The next write silently recreates it instead of failing loud — which is fine for "first write" but obscures "I just deleted this and something is racing me".
- **Consequence:** Operator confusion in support scenarios. No data loss.
- **Fix:** Optional `createParent: boolean` flag, default `true`. Or leave as is and document.

---

### F13. Tombstone uses fixed name `.council/ARCHIVED` — collides with directory naming conventions

- **File:** `web/server/group-reconciliation.ts:82`
- **Principle:** Principle 4 (structure should make intent obvious).
- **Severity:** P3
- **What's wrong:** A file named `ARCHIVED` (uppercase, no extension) inside `.council/` looks like a marker file but the content is JSON. Tools that walk the directory (`ls .council/`, IDE file explorers, scripts that grep `*.json`) won't recognise it as JSON content. macOS HFS+ case-folding means `archived` and `ARCHIVED` collide; Linux ext4 does not. See Principle 6 case-sensitivity.
- **Consequence:** Cross-platform inconsistency, IDE confusion. No data loss.
- **Fix:** Rename to `archived.json` (or per-group `archived/<id>.json` per F1) and let the extension carry the type.

---

## Summary

No clean bill — four P1, six P2, three P3. Highest-leverage fix: pair F1 + F2 + F3 — landing the sweep half of the tombstone protocol with a versioned, per-group tombstone shape, plus shared tmp-filename constants. F4 (tmp leak on rename failure) is small but durable. The watcher and validators are in good shape relative to the persistence baseline; the gaps are in the lifecycle plumbing around them.

Findings written: 4 P1, 6 P2, 3 P3 = 13 total.
