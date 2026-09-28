# Backend TS Review — Council Mode (paired sessions)

Reviewer: Bun + Hono + TypeScript Backend Expert
Scope: 6 files (session-group-coordinator, group-reconciliation, checkpoint-watcher, atomic-write, backend-provider, codex-envelope)
Reference: `quality-backend.md` (Carmack × Collina × Bun/Hono)

Findings below are in-lane for backend quality: async/error discipline, resource lifecycle, structured logging, validation at boundaries, CPU/event-loop blocking, Bun idioms. Out-of-lane items deliberately omitted: persistence atomicity invariants (FS-JSON's lane), security/IDOR (Hunt's lane), protocol drift (Realtime's lane), subprocess race semantics (Subprocess's lane).

---

## P1 — Fix Now

### P1-BE-1 — Synchronous fs+fsync syscalls in `atomic-write.ts` block the Bun event loop on every checkpoint emission

**File**: `web/server/atomic-write.ts:18-52`
**Principle**: Quality-backend Principle 7 ("async correctness — the event loop is not magic"); Principle 9 (Bun idioms).
**Concrete failure mode**:
`writeAtomicJson` is the hot-path writer for every checkpoint the orchestrator emits. It is built entirely on `mkdirSync` / `openSync` / `writeSync` / `fsyncSync` / `renameSync` / `closeSync`. `fsyncSync` in particular blocks until the kernel returns from the underlying disk flush — on a rotational disk or a contended SSD that can be tens of milliseconds. Every other in-flight HTTP request, WebSocket frame, recorder write, and timer on the Bun event loop is paused for the duration. Under sustained checkpoint pressure (or a sluggish workspace volume), this presents as cliff-edge tail-latency on the WS bridge during phase boundaries — exactly the moments when the user is most engaged.

`node:fs/promises` exposes async equivalents for all six of these calls (`mkdir`, `open` + `fileHandle.write/sync/close`, `rename`). The work doesn't change — it just moves off the loop thread. Mirrors the watcher's already-async readFile in `checkpoint-watcher.ts`. The recommendation here is to switch the function to `async` and `await` each step.

---

### P1-BE-2 — `writeSync(fd, json)` does not handle partial writes; truncated tmp file can land before rename

**File**: `web/server/atomic-write.ts:33`
**Principle**: Quality-backend Principle 1 (operational errors must crash, not silently produce inconsistent state).
**Concrete failure mode**:
Node's `fs.writeSync(fd, string)` returns the number of bytes actually written, which per POSIX may be **less than `json.length`** under signal interruption, EINTR, or filesystem pressure — particularly with larger 256 KB payloads on slower filesystems. The current code calls `writeSync` once, ignores the return value, calls `fsyncSync`, and then `renameSync` over the target. If the write was short, the tmp file is fsynced and renamed in a truncated state. Observers parse the file via `parseCheckpointPayload`, which returns `null` and silently drops the event — the watcher logs "invalid-schema" but the orchestrator believes the checkpoint shipped. Phase boundary is silently lost.

The fix is the standard write-loop: track bytes written, slice the remainder, retry until `written === total`. Also worth pairing with the async migration in BE-1.

---

### P1-BE-3 — `void readAndEmit(...)` swallows rejection if `readFile` throws synchronously inside the microtask before its own try/catch runs

**File**: `web/server/checkpoint-watcher.ts:57`
**Principle**: Quality-backend Principle 1 (swallowed rejections on durable broadcast paths).
**Concrete failure mode**:
The watcher schedules `void readAndEmit(opts.directory, file, opts.onCheckpoint, onDropped)` from inside a `setTimeout` callback. `readAndEmit` is async and its body is wrapped in try/catch around the readFile and the handler. However:

1. The `void` discards the returned promise, so any rejection that *escapes* `readAndEmit` (e.g. a future code change adds an `await` before the try/catch, or a synchronous throw at the top of `readAndEmit` before the try begins) becomes an unhandled rejection — Bun (like Node ≥15) crashes the process by default on unhandled rejection, which is the *correct* behaviour for programmer errors but here it would crash the server on every malformed event. The discipline is to attach a tail-catch: `readAndEmit(...).catch((e) => onDropped(\`unexpected: \${String(e)}\`, file))`.
2. More immediately: `onCheckpoint` is typed `(payload) => void | Promise<void>`. The handler is awaited inside `readAndEmit`'s inner try/catch, so a thrown handler is caught and routed to `onDropped`. Good. But if a handler is *fire-and-forget* (returns void synchronously but starts a background promise the caller leaks), the watcher cannot observe its failure. Document this contract on `onCheckpoint`, or document that handlers MUST return a Promise that settles after all their work completes.

The first half is the P1; the second is documentation hygiene that prevents a future P1.

---

## P2 — Fix Soon

### P2-BE-4 — Silent swallow of subprocess-kill failure in spawn rollback and archive paths in `session-group-coordinator.ts`

**File**: `web/server/session-group-coordinator.ts:122-127`, `153-162`
**Principle**: Quality-backend Principle 1 (swallowed errors on durable state); Principle 6 (structured logging).
**Concrete failure mode**:
Two distinct kill-paths silently `try { await this.deps.kill(...) } catch {}`:

- **Rollback after observer-spawn failure** (line 122-127): if the observer spawn throws, the orchestrator's `kill` is attempted and any failure is swallowed. The accompanying comment ("Rollback failure is best-effort — the original error is what the caller cares about; swallowing here preserves it") is exactly the failure mode `quality-backend.md` warns against — the original error is preserved but a live, headless orchestrator subprocess now exists with no one tracking it. The group record is never added to `this.groups`, so `archiveGroup` cannot find it; `findBySessionId` cannot find it. The subprocess is permanently orphaned until the parent server exits.
- **Sequential kill in `archiveGroup`** (line 153-162): both kill calls silently swallow with `/* swallow */`. The state machine transitions to `archived` regardless. A user who sees "group archived" in the UI has no signal that one or both halves are still running.

Both should emit a structured log line (`event: "group_kill_failed", sessionGroupId, role, error: ...`) and ideally bubble enough metadata to a higher-level reconciler. The original error is preservable via `Error.cause` or an `AggregateError` — Bun and TS support both. Per memory `feedback_outbox_close_all_paths`: every exit path must close its row; this is the moral equivalent for subprocess accounting.

---

### P2-BE-5 — Tmp file leak in `writeAtomicJson` when `renameSync` fails

**File**: `web/server/atomic-write.ts:31-39`
**Principle**: Quality-backend Principle 5 (resource lifecycle — every open requires a corresponding close, every staging file requires a corresponding cleanup).
**Concrete failure mode**:
The write-and-fsync sequence is wrapped in `try/finally` to close the fd. But `renameSync(tmp, target)` lives **outside** that try/finally. If rename fails (target dir gone, EXDEV across mount, EACCES), the `.tmp` file stays on disk. The fd was already closed by the inner finally, so no FD leak — but the file accumulates. Over time the `.council/checkpoints/` directory fills with `.<rand>.tmp` orphans. The watcher correctly ignores them (`file.startsWith(".")`), so they're silent leaks.

Fix: wrap the rename in its own try/catch that `unlinkSync(tmp)` on failure before re-throwing.

---

### P2-BE-6 — `checkpoint-watcher.ts` reads the entire file before applying size cap

**File**: `web/server/checkpoint-watcher.ts:80`, cross-ref `council-types.ts:103`
**Principle**: Quality-backend Principle 7 (CPU-bound work in request paths); Principle 8 (validation at the boundary).
**Concrete failure mode**:
`readAndEmit` calls `readFile(path, "utf-8")` with no size limit, then hands the raw buffer to `parseCheckpointPayload`, which checks `raw.length > COUNCIL_ARTIFACT_MAX_BYTES` (256 KB) and returns `null` past that limit. By the time the cap is checked, the entire file has been allocated and decoded to UTF-16 in V8/JSC. An adversarial or buggy writer (the orchestrator's safety net is `atomic-write`'s own pre-cap, but the watcher will read *any* `.json` that appears in the watched dir, including ones placed there by some other tool) can drop a 1 GB file. The watcher's fire-and-forget read pulls 1 GB of memory before refusing it.

Fix: `stat(path)` before `readFile`, refuse if `stats.size > COUNCIL_ARTIFACT_MAX_BYTES * 2` (a small slack for envelope overhead), log via `onDropped("oversize: <bytes>", file)`. Alternatively use `createReadStream` with a hard cap.

This is also why the watcher's `JSON.parse` synchronously blocks the event loop for the full payload — at 256 KB it's tolerable; at 1 GB the loop is gone.

---

### P2-BE-7 — `console.warn` is the default log surface in `checkpoint-watcher.ts`; no per-session/group context anywhere in the new code

**Files**: `web/server/checkpoint-watcher.ts:42`, `web/server/session-group-coordinator.ts` (entirely silent), `web/server/group-reconciliation.ts` (entirely silent)
**Principle**: Quality-backend Principle 6 (structured logging — Pino-style, JSON to stdout, per-session context).
**Concrete failure mode**:
- The watcher's default `onDropped` is `console.warn(\`[checkpoint-watcher] dropped ${file}: ${reason}\`)`. No timestamp, no session group id, no checkpoint id, no level field. Three watchers running concurrently (three groups) produce indistinguishable log lines.
- `SessionGroupCoordinator` emits **zero** log lines across spawn, spawn-rollback, state transition, and archive. The entire group lifecycle is invisible to ops.
- `group-reconciliation.ts`'s `writeArchiveTombstone` is silent on success and silent on failure (it can throw from `writeAtomicJson`, but the call site here doesn't wrap it).

Recommendation: introduce a small logger (or even just a `log({ event, sessionGroupId, ... })` JSON-line helper) and thread it through these modules. Every line on the group critical path should carry at minimum `event`, `sessionGroupId`, and where applicable `sessionId` + `role`. The `ws-bridge.ts` recorder gives precedent for the JSONL-line approach already used in the codebase.

---

### P2-BE-8 — `SessionGroupCoordinator.archiveGroup` does not abort the checkpoint watcher or clear its debounce timers

**File**: `web/server/session-group-coordinator.ts:148-164` (cross-ref `checkpoint-watcher.ts:21,55`, PLAN Task 5)
**Principle**: Quality-backend Principle 5 (resource lifecycle — timers cleared on group teardown; AbortController bound to lifetime).
**Concrete failure mode**:
The reviewer brief explicitly calls out "AbortController binding on the watcher per PLAN Task 5". The coordinator does *not* own an `AbortController` for the group, nor does it call `signal.abort()` on archive. The watcher contract (`CheckpointWatcherOptions.signal`) is correct in isolation — it clears its own timers in `finally` when aborted — but nothing in the coordinator's `archiveGroup` triggers the abort. If/when a watcher is wired in for the group (the seam is documented as a follow-up), the absence of an abort hook here means timers and the `for await` loop keep running after the group's subprocesses are dead.

The seam is missing now and easy to forget later. Either:
1. Add an `abortController: AbortController` field to `GroupRecord`, abort it in `archiveGroup` before the kills (with the same care as the state-machine transition that already precedes kills), or
2. Add a `teardown: () => void` callback list on `GroupRecord` that the watcher-wiring task can push into.

Per CLAUDE.md's self-learning protocol: this is the historical "болтается" anti-pattern's natural habitat — a watcher attached to a process that has long since died.

---

### P2-BE-9 — `parseCodexFrame` rejects valid JSON-RPC frames: array-form params and string/null ids

**File**: `web/server/codex-envelope.ts:43-44`, `:72`, `:79`
**Principle**: Quality-backend Principle 8 (type/validator drift) — but here the validator is **stricter than the protocol**, which is the inverse risk.
**Concrete failure mode**:
JSON-RPC 2.0 permits:
- `params` to be either a structured value (object) **or an ordered list (array)**. `isObject(parsed.params)` in lines 72 and 79 returns false for arrays, so any Codex request/notification using positional params is silently dropped (returns `null`).
- `id` to be a string, a number, or `null` (the latter is required for error responses to unmatched requests). `isValidId` accepts only `Number.isInteger(id) && id >= 0`.

If Codex's wire format happens to use only object params and non-negative integer ids today, the parser works — but the validator's narrowness exceeds the protocol's contract. A Codex CLI update that switches to positional params or strings would silently drop every frame at the watcher, surface as "Codex stopped responding" without a log line (since `parseCodexFrame` returns null with no `onDropped` hook), and be very hard to triage.

Two options, in order of preference:
1. **Widen the validator** to spec: `params: object | array`, `id: number | string | null` (with bounded length on strings).
2. **Document the subset** explicitly — both in the file's top comment and via an `onDropped` callback parameter mirroring `checkpoint-watcher.ts`, so a stricter-than-spec rejection produces a visible signal rather than silence.

Cross-ref `Realtime/NDJSON Protocol Expert` for protocol-drift lane (deferred to that reviewer); the backend-quality concern here is the silence + no `onDropped` hook, which is a P2 observability gap on its own.

---

### P2-BE-10 — `group-reconciliation.ts:writeArchiveTombstone` doesn't validate `workspaceRoot` / `sessionGroupId` before joining a filesystem path

**File**: `web/server/group-reconciliation.ts:77-88`
**Principle**: Quality-backend Principle 2 (validate at the boundary); Principle 8 (validation matches type).
**Concrete failure mode**:
`writeArchiveTombstone(workspaceRoot, sessionGroupId, ...)` does `join(workspaceRoot, ".council", "ARCHIVED")` and writes the tombstone with `session_group_id` as a payload field. Both arguments are typed `string` and trusted unconditionally. If `sessionGroupId` is empty, contains path separators, NUL bytes, or surrogate-pair garbage, those flow into the tombstone payload and through `JSON.stringify` unchanged. If `workspaceRoot` is empty or `..`, the resolved path points at the wrong place.

The coordinator generates ids via `randomBytes(16)` so the hot-path input is safe, but the function is exported and a future caller (reconciliation from disk state, IPC, a test) could pass in a string from an untrusted source. Hard-reject empty / overlong / non-pattern-matching `sessionGroupId` at the top of the function (per memory `feedback_no_sentinel_user_id_fallback`: hard-reject on missing/malformed identity, never fall through). Same for `workspaceRoot`'s absolute-path discipline.

---

## P3 — Consider

### P3-BE-11 — `getBackend()` and the `BackendProvider` interface in `backend-provider.ts` are functionally dead code in this batch

**File**: `web/server/backend-provider.ts:11-28`
**Principle**: Quality-backend Principle 10 (epistemic humility — don't ship seams that nothing yet uses).
**Note**: The PLAN names Task 4 as "the structural keystone — if it leaks branching back into session-orchestrator.ts, every future change reasons about paired vs solo." But this batch only ships the manifest (`SUPPORTED_PAIRINGS`, `isSupportedPairing`). `getBackend` is exported but unreferenced. `BackendProvider`'s only members (`backendType`, `binaryName`) duplicate information already present in `cli-launcher.ts`'s codex branches. Until the seam actually replaces those branches, this file is a documentation artifact more than a seam — easy to mistake for "this is how spawn dispatches" when in fact spawn still goes through cli-launcher's existing `if (backendType === "codex")`. Either drop the unused exports or wire one call site through `getBackend` so the seam isn't speculative.

---

### P3-BE-12 — `codex-envelope.ts`'s control-char rejection misses 0x7F (DEL) and Unicode line/para separators

**File**: `web/server/codex-envelope.ts:33-41`
**Note**: `isValidMethod` rejects `charCode < 0x20` but allows 0x7F (DEL) and the 0x80–0x9F C1 control range (which would be present in poorly-encoded payloads). Doesn't affect functionality today since legitimate methods are ASCII, but the defence-in-depth comment overstates the strictness. Either tighten to `^[A-Za-z0-9_.\-/]+$` (codex methods follow a known shape) or update the comment to be accurate.

---

### P3-BE-13 — `SessionGroupCoordinator.findBySessionId` is O(n) linear scan

**File**: `web/server/session-group-coordinator.ts:171-178`
**Note**: For small N this is irrelevant. But ws-bridge will likely call `findBySessionId` on every frame from every session to route group events. At 50 concurrent groups the scan is ~50 comparisons per frame — fine. At 500+ groups it starts to show on profiles. Cheap fix: maintain an inverse index `Map<sessionId, sessionGroupId>` alongside `groups`. Worth a comment marking the contract.

---

### P3-BE-14 — `checkpoint-watcher.ts` catches only AbortError by name; doesn't use `signal.reason` for diagnostics

**File**: `web/server/checkpoint-watcher.ts:62-64`
**Note**: The catch narrows via `(err as { name?: string } | null)?.name !== "AbortError"`. This works but loses `signal.reason` (the abort cause) on the way through. If/when the coordinator (per BE-8) starts aborting with a reason like `"group_archived"` or `"server_shutdown"`, the watcher could surface that in a final log line: `log({ event: "watcher_aborted", reason: signal.reason })`. Currently the shutdown is silent.

---

### P3-BE-15 — `node:fs/promises.watch` vs `node:fs.watch` — Bun-vs-Node behavioural caveat not documented

**File**: `web/server/checkpoint-watcher.ts:1`
**Note**: Bun's `fs.watch` does not behave identically to Node's on every platform (recursive watching, debounce, rename event ordering all differ subtly). The comment block already notes "Some platforms fire two events for one atomic rename — coalesce them" — good — but the file doesn't pin behavioural assumptions to a Bun version or document any cross-runtime testing. Cross-ref FS-JSON lane (where the watcher reliability finding likely lives in more detail); from a Bun-idiom standpoint, a one-line comment naming the Bun version this was validated under prevents a regression on Bun upgrade.

---

## Summary

| Severity | Count |
|----------|-------|
| P1 | 3 |
| P2 | 7 |
| P3 | 5 |
| **Total** | **15** |

Recurring themes:
1. **Sync fs APIs on the hot path** (atomic-write entirely) — the single highest-leverage refactor: async the writer.
2. **Silent swallow of cleanup failures** (coordinator kill paths, atomic-write tmp leak, codex parser nulls without onDropped) — these are the "looks fine in tests, mystery in production" set; every one needs structured logging.
3. **Missing structured logging across the entire new group-lifecycle surface** — no `event`, no `sessionGroupId`, no `role` on any log line that does exist (all `console.warn`).
4. **Watcher/timer lifecycle not yet bound to group lifecycle** (BE-8) — easy to forget in the next task; the seam should be added now.
