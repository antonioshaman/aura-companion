# FS-JSON Persistence Review — Council Mode

Reviewer: Filesystem JSON-Store Persistence Expert (Carmack chair)
Scope: `atomic-write.ts` (+ test), `checkpoint-watcher.ts` (+ test), `group-reconciliation.ts` (+ test)
Cross-refs: `council-types.ts` (validator + size cap), user memory `feedback_outbox_close_all_paths`.

Overall: the atomic-write implementation is the strongest piece of new code in this batch — tmp+rename in the same directory, fsync the fd, fsync the parent dir, sized cap, randomised tmp name, no cross-FS hazard. Test coverage proves the contract (round-trip, parent mkdir, oversize rejected, no orphan tmp, atomic overwrite). The watcher is correct for the happy path but trades durability for liveness in a few spots that the PLAN's "highest-leverage quality task" framing should make us re-examine. Reconciliation is a pure decision function with tombstone-before-sweep semantics — the right shape — but the "mark-then-sweep" promise is only half kept: the deciding caller is not in this batch, so the **per-decision** persistence claim cannot be verified from the files under review (flagged as scope-bound below).

Six findings. Breakdown: 1 × P1, 4 × P2, 1 × P3.

---

## P1 — Findings

### P1-1 — Watcher debounce coalesces *write+delete+rewrite* on the same filename, can drop the second payload

**File:** `web/server/checkpoint-watcher.ts:53-60`
**Severity:** P1
**Failure mode:** silent loss of an emitted checkpoint.

The debounce map is keyed by `file` only — there is no sequence guard tied to file identity. The orchestrator can legitimately write `plan.json` twice in rapid succession (the test `overwrites an existing target atomically` already proves writes can land back-to-back). When two atomic writes complete within 150 ms — common on a fast machine because `rename` + parent-fsync take well under that — `fs.watch` typically fires two `change` events for `plan.json`. The handler does `clearTimeout(existing); setTimeout(..., 150)` which **restarts the window** instead of preserving the first event. The single emitted read happens at the *end* of the second debounce — so when payloads A and B were both emitted within 150 ms, the watcher reads only B. A is lost.

Concrete data-loss: if the orchestrator emits checkpoint `seq=5` then immediately re-emits with `seq=6` to correct a slip, only `seq=6` ever reaches the observer. The observer never reviews `seq=5`. The orchestrator does not know, because the watcher acks nothing.

This is mitigated only if the orchestrator never writes two payloads to the same filename within ~150 ms. Nothing in the contract guarantees that. The atomic-write tests deliberately do exactly that case.

**Fix shape:** key the debounce on `(file, mtime|size)` and on each event capture a snapshot of the just-read content so a *first* emission is never dropped; or read inside the debounce window once per event and emit on every distinct payload-hash. Either way the invariant must be "every checkpoint that crossed the rename barrier was either read-and-emitted or read-and-dropped-with-reason" — never silently ignored.

Tests do not currently cover the "two atomic writes within debounce" race; they should.

---

## P2 — Findings

### P2-1 — Watcher `readFile` happens *before* the size cap is checked — a 1 GiB attacker file is loaded into memory before being rejected

**File:** `web/server/checkpoint-watcher.ts:80` → `council-types.ts:103`
**Severity:** P2
**Failure mode:** memory-pressure DoS against the watcher process.

`readAndEmit` calls `readFile(path, "utf-8")` without a byte limit, then hands the string to `parseCheckpointPayload`, which only *then* checks `raw.length > COUNCIL_ARTIFACT_MAX_BYTES` and returns null. The 256 KiB cap is enforced semantically but not at the syscall boundary. A peer process (the observer subprocess, a malicious or buggy writer, or a test fixture) that drops a 1 GiB `*.json` file into the checkpoint directory causes the watcher to allocate ~1 GiB of UTF-8 string before failing validation. Repeated drops produce a slow OOM that takes the server with it.

The unit test `rejects payloads larger than COUNCIL_ARTIFACT_MAX_BYTES` only covers the **writer** side — the writer correctly refuses to emit oversized payloads. But the **reader** has no equivalent guard for files written by someone else (e.g. the observer subprocess writing into `.council/checkpoints/` by accident, or a stale artifact left over from a previous run).

**Fix shape:** `fs.stat` the file first; if `size > COUNCIL_ARTIFACT_MAX_BYTES` call `onDropped("oversize-on-disk", file)` and return without reading. Or open and read with a bounded byte counter.

### P2-2 — Watcher has no atomic-rename `oldFilename` discipline; on Linux+inotify the `rename` event surfaces as a `change` of the *target* name — that path is fine, but the `IN_MOVED_FROM`-style suppression (sibling tmp files reported under their tmp name) is *partially* but not fully handled

**File:** `web/server/checkpoint-watcher.ts:47-51`
**Severity:** P2
**Failure mode:** wedged watcher logging or dropped checkpoint depending on platform.

The dotfile filter (`file.startsWith(".")`) suppresses events for the randomised `.<hex>.tmp` staging files used by `writeAtomicJson` — good. But `fs.watch` on Linux emits both a `rename` event for the staging file and a `rename` event for the target name when `renameSync(tmp, target)` lands. On macOS (FSEvents) and on Windows (ReadDirectoryChangesW) the eventTypes the Node abstraction surfaces are notoriously inconsistent. There is no test that pins down the **eventType** the watcher consumes — the current code ignores it entirely (`for await (const ev of watch(...))` discards `ev.eventType`).

Concrete consequence: on platforms where `fs.watch` fires a `rename` event for the *target* path **before** the rename has committed (some older Linux kernels with overlayfs, some encrypted FUSE), the watcher fires the debounce timer, reads, and may see the *previous* contents because the rename hasn't propagated yet. The 150 ms debounce mitigates this in practice but does not eliminate it.

Per the review brief: "listens for `rename`/`close_write` events ONLY (never `create` — that fires on tmp file too)". The current code listens for *all* events and filters by **filename pattern** rather than **eventType**. That works because the dotfile-tmp convention makes filename a sufficient discriminator, but it ties correctness to that naming convention being respected by every future writer (e.g. when reviews land in the same directory via a different code path).

**Fix shape:** record `ev.eventType` and emit a structured trace on first run per platform so we can verify the assumption. Add a test that uses `writeFileSync` directly (not `writeAtomicJson`) to a `*.json` file and asserts the handler still fires — that's the case `fs.watch` will report on Linux+inotify as `change` rather than `rename`, and we need to confirm we still handle it.

### P2-3 — Watcher lifecycle is bound to `signal: AbortSignal`, but there is no observable "watcher is ready" milestone — callers race against `setTimeout(50)`

**File:** `web/server/checkpoint-watcher.ts:38-68`
**Severity:** P2
**Failure mode:** lost checkpoints during session-group startup.

`watchCheckpoints` is an async generator-consumer that resolves only when the signal aborts. There is no `Promise<void>` that callers can await to know the watcher has actually subscribed to `fs.watch` — the test files all use `await new Promise(r => setTimeout(r, 50))` to "give the watcher a moment to initialise". This is a known watcher anti-pattern: the orchestrator can finish phase work and emit a checkpoint *before* the watcher's `fs.watch` has called the underlying `inotify_init1` syscall. That checkpoint is lost — it landed before the kernel was watching.

The session-group startup path (not in this batch — `session-group-coordinator.ts`) is the place this gets exposed: when a paired session is created, the coordinator should `await watcherReady` before signalling the orchestrator "OK, you may begin emitting". Without a ready milestone, the coordinator can only `setTimeout` and hope, mirroring the test files. Per memory `feedback_outbox_close_all_paths`: every state row needs every exit path closed — here the *startup* path has no edge to wait on.

**Fix shape:** expose `{ ready: Promise<void>, done: Promise<void> }`. Internally resolve `ready` after the first iteration of the `for await` is observed (which is when Node has called the underlying `watch()` syscall). Update tests to await `ready` instead of `setTimeout(50)`.

### P2-4 — `decideReconciliation` is pure, but the *commit* of the decision is not in this batch — the "sentinel-before-sweep" promise of `mark_orphan` / `archive_dead` cannot be verified from the files under review

**File:** `web/server/group-reconciliation.ts:39-88`
**Severity:** P2
**Failure mode:** stuck-canary on next restart (per memory `feedback_outbox_close_all_paths`).

`writeArchiveTombstone` atomically writes the `ARCHIVED` marker — correctly. `decideReconciliation` correctly returns four discriminated actions. **But:** the caller that takes the action is not under review. The brief asks specifically: *"each branch must persist its recovery decision BEFORE acting so the next restart is idempotent (sentinel-before-sweep)"*. From these three files we can verify:

  - `archive_dead` HAS a sentinel-write helper (`writeArchiveTombstone`) → ✓ provided
  - `mark_orphan` has NO sentinel-write helper in this file → the caller would need to write a `ORPHAN` marker before flipping group state to orphaned, and there is no shared utility for it.
  - `relaunch_observer` has NO sentinel-write helper → if the server crashes between deciding "relaunch observer" and the spawn actually succeeding, the next restart re-decides from raw PID state. PID reuse can flip the verdict.
  - `resume_pair` is a no-op, idempotent → ✓ implicitly safe

Without the consuming caller in scope, the "every branch closes the state row" invariant from `feedback_outbox_close_all_paths` is **structurally unfinished**. The pure decision function is fine; what is missing is a sibling `commitReconciliationDecision(action)` that atomically writes the per-branch sentinel **before** the side-effecting work runs.

**Fix shape:** add `writeOrphanMarker(workspaceRoot, sessionGroupId, reason)` and `writeRelaunchIntent(workspaceRoot, sessionGroupId, primarySessionId)` next to `writeArchiveTombstone`, each backed by `writeAtomicJson`. The caller pattern becomes: decide → writeMarker → act → (optionally) deleteMarker. A crash between writeMarker and act leaves the next reconciliation looking at the marker first and resuming idempotently.

---

## P3 — Findings

### P3-1 — `writeAtomicJson` uses `randomBytes(8)` (64 bits) — collision-safe but rejects no slug; an attacker who can write to the same directory can race the tmp filename, and the test does not pin this down

**File:** `web/server/atomic-write.ts:29`
**Severity:** P3
**Failure mode:** race in the (vanishingly rare) collision of two concurrent atomic writes to the same target. Not a corruption mode in practice — the rename is still atomic per filename, and `openSync(tmp, "w")` would only conflict if the rare 64-bit collision matched a second writer's tmp.

This is a hygiene note, not a finding I would block on. The fix would be `openSync(tmp, "wx")` (exclusive create) so the rare collision becomes a loud throw rather than a silent overwrite of a concurrent tmp. At 64 bits and one process the collision probability is irrelevant; if Council Mode ever runs N orchestrators against the same directory it becomes worth tightening.

`'wx'` is also the canonical "I am the only writer of this tmp" flag — using it documents the contract.

---

## Out of scope (intentionally not flagged)

- **Path traversal / slug validation on `target`**: per the brief, security is Hunt's lane unless the atomicity invariant itself is at stake. The brief flagged "slug validation on the path components before writing"; I do see that `writeAtomicJson` accepts any `target` string without slug validation, but the *caller* (e.g. `writeArchiveTombstone`) controls the path, and Hunt's review will cover the boundary check on `workspaceRoot` + `sessionGroupId`. The atomicity invariant itself is intact regardless of where the path came from.
- **Backend async error handling**: any "this throw should be awaited" finding belongs to the Bun/Hono/TS reviewer.
- **`group-state-machine.ts`** is not in the file list and is Fowler's lane for discriminated-union purity.
- **`session-group-coordinator.ts`** is the caller that would *consume* `decideReconciliation` and the `watchCheckpoints` ready milestone; without it in scope the P2-4 finding is bounded to "this batch did not ship the closing-edge helper, and the caller cannot prove the invariant from these files alone".

---

## Cross-reference summary against user memories

- `feedback_outbox_close_all_paths` — directly applied in P2-4. Every reconciliation branch must close its state row; only one branch (archive_dead) has a sentinel helper in this batch.
- `feedback_no_sentinel_user_id_fallback` — not triggered in these files (no sentinel-on-missing-identity pattern); applies to Hunt's surface.
- `feedback_verify_test_bodies_not_just_names` — I read every test body. The atomic-write tests genuinely exercise the contract. The watcher tests use a polling-on-predicate pattern (`waitFor`) that is honest about `fs.watch`'s async nature. The "drops events whose handler throws and continues processing" test does prove the second event still fires after the first throws — not a vacuous pass. The one gap is P1-1: no test for the "two atomic writes within debounce" race, which is the actual data-loss case.
