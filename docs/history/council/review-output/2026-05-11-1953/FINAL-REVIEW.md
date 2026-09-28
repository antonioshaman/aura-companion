# Council Review (Aura): Council Mode — Paired Orchestrator + Observer Sessions (Tasks 1–9 of `PLAN-council-mode-paired-sessions.md`)

**Scope:** 22 new TypeScript files (~2,176 LOC, 11 source + 11 test) in `web/server/` plus 2 markdown docs. Implements: shared schema (`council-types.ts`), coordinator (`session-group-coordinator.ts`), backend seam (`backend-provider.ts`), atomic-write durability (`atomic-write.ts`), FS watcher (`checkpoint-watcher.ts`), restart reconciliation (`group-reconciliation.ts`), state machine (`group-state-machine.ts`), observer SDK permissions (`observer-permissions.ts`), observer write-allowlist (`observer-write-policy.ts`), group authorization (`group-authorization.ts`), Codex JSON-RPC envelope parser (`codex-envelope.ts`).

**Context:** Council Mode pairs an orchestrator CLI subprocess with an observer CLI subprocess sharing one workspace; the observer wakes on filesystem checkpoints to review the orchestrator's work. This batch lays the foundations. UI (Task 15), event-bus fanout (Task 12), observer system prompt (Task 13), grounding/synthetic-injection (Task 14), and graceful-shutdown/inotify-pool (Task 10) are NOT in this scope and were not flagged as gaps.

**Council dispatched:** Hunt (9 findings), Fowler (3), Bun/Hono/TS (15), FS-JSON Persistence (6), Realtime/NDJSON (11), Subprocess Lifecycle (8), Willison (7), Beck (11). React/Web UI, a11y, Saarinen, Friedman, Docker/GHA NOT dispatched — zero files in scope. **Raw total: 70 findings.** Synthesized to **15** after Carmack-filter dedup.

**Automated checks:** ✅ typecheck (`bun run typecheck`) ✅ tests (`bun run test`, all 11 new test files green) ✅ a11y (`bun run test:a11y`). No pre-existing failures.

---

## P1 — Fix Now

### 1. Observer SDK permission profile is defined but never applied at spawn — the entire observer security boundary is dead code

| | |
|---|---|
| **File** | `web/server/observer-permissions.ts:25-53` + `web/server/session-group-coordinator.ts:39-46,107` |
| **Council** | Subprocess Lifecycle × Carmack — Principle 1 ("Use the type system as armour") |
| **Ref** | `references/quality-subprocess.md` → Principle 1 |

**Finding:** `getObserverSpawnOverrides()` returns `{ allowedTools, disallowedTools, permissionMode }` but zero call sites in the repo invoke it. The `SessionSpawner` contract in `session-group-coordinator.ts` has no path for `allowedTools` / `disallowedTools` / per-role permission overrides, so the observer half spawns with the same `permissionMode` and full tool surface as the orchestrator (including `Bash`). The doc-comment "applied at spawn" is false. `assertObserverToolPolicyConsistent()` is also exported but never invoked from server bootstrap.

**Consequence:** The observer subprocess starts with full agent privileges in every code path the coordinator would ever execute — the PLAN's "irreversible security decision" rides on a contract that exists only in JSDoc.

**Fix:** Add `allowedTools?`, `disallowedTools?`, `permissionModeOverride?` to `SessionSpawner` opts; have `SessionGroupCoordinator.createGroup` apply `getObserverSpawnOverrides()` for the observer half only and propagate through `LaunchOptions` into the spawn argv (`cli-launcher.ts:520-554` for claude, `:758-762` for codex — note codex doesn't accept `--allowedTools`; see finding #7). Wire `assertObserverToolPolicyConsistent()` into server bootstrap. Add a behavioural test: invoke `coord.createGroup(...)` with a fake spawner that records argv and asserts the observer call's argv contains the deny terms and lacks `Bash`. Cross-ref: Hunt #2, Willison #7, Beck #15 (test-side coverage gap).

---

### 2. `archiveGroup` does not mark BOTH session IDs as intentional kills before either kill runs — first kill triggers proactive relaunch of the other half mid-teardown

| | |
|---|---|
| **File** | `web/server/session-group-coordinator.ts:148-164` |
| **Council** | Subprocess Lifecycle × Carmack — Principle 2 ("Track PID, but never trust PID across reboots") and Principle 3 (Signals) |
| **Ref** | `references/quality-subprocess.md` → Principles 2-3 |

**Finding:** `archiveGroup` flips `g.status = "archived"` (internal coordinator state only) then calls `kill(primary)` then `kill(observer)`. The status flip does NOT touch `session-orchestrator.intentionalKills`, which is the actual gate consulted by `scheduleProactiveRelaunch`. When the first kill resolves, `session:exited` fires → keepalive sees the OTHER half with `intentionalKills.has(observerId) === false` → schedules a 3-second proactive relaunch → 3 seconds later the observer is killed by the second kill, then relaunched, then killed again. The pair tears down half-zombie.

**Consequence:** Deterministic teardown race on every archive: orphan subprocesses, doubled relaunch counters, and a window where the "archived" group is actually running.

**Fix:** Change `SessionKiller` signature to `(sessionId, opts?: { intentional?: true }) => Promise<void>` (or add a sibling `markIntentional(sessionId)` injection). Mark BOTH IDs intentional BEFORE either `kill()`. Add a test using a fake spawner that emits `session:exited` on kill and assert the second kill is reached without an intervening relaunch.

---

### 3. `--resume` IDs are conflated with Companion session IDs at the coordinator boundary

| | |
|---|---|
| **File** | `web/server/session-group-coordinator.ts:30-46`, `web/server/group-reconciliation.ts:35` |
| **Council** | Subprocess Lifecycle × Carmack — Principle 5 (`--resume` semantics) |
| **Ref** | `references/quality-subprocess.md` → Principle 5 |

**Finding:** The existing launcher carefully separates `SdkSessionInfo.sessionId` (Companion routing UUID) from `cliSessionId` (CLI's internal ID used for `--resume`, only populated after `system.init`). The coordinator collapses this: `SpawnedSession`, `GroupRecord.{primary,observer}`, and `relaunch_observer.primarySessionId` carry only one string slot. If the observer crashes pre-`system.init` and a relaunch path forwards `record.observer.sessionId` to `--resume`, the CLI receives the Companion UUID as a resume token, rejects it, exits in <5s, exhausts the 3-retry budget on a misuse-not-failure.

**Consequence:** Reconnect path fails by design on the unhappy edge; the failure looks like "Codex stopped responding" because the cause is upstream of the symptom.

**Fix:** Differentiate at the type level. `GroupMember { sessionId; backendType; cliSessionId?: string }` with explicit accessor that reads from the launcher's live record. Or simpler: the coordinator never owns a resume token — when it needs to relaunch a half, dispatch through `SessionOrchestrator.relaunchSession()` and let the launcher pull `cliSessionId` from its persisted state.

---

### 4. Watcher debounce silently drops the first of two atomic writes to the same filename within 150 ms

| | |
|---|---|
| **File** | `web/server/checkpoint-watcher.ts:53-60` |
| **Council** | FS-JSON Persistence × Carmack — Principle 5 ("Rotation invariants — bound storage without losing meaning") applied to event coalescing |
| **Ref** | `references/quality-persistence.md` → Principle 4 (line discipline) and `quality-realtime.md` → Principle 1 (line splitting) |

**Finding:** The debounce map is keyed by `file` only with no sequence guard. The atomic-write tests already exercise back-to-back writes to the same target. When two atomic writes complete within 150 ms (`rename` + parent-fsync take well under that), `fs.watch` typically fires two events; the handler does `clearTimeout(existing); setTimeout(..., 150)`, which RESTARTS the window rather than preserving the first event. The emitted read at the end of the second window reads only the second payload. The first checkpoint is silently lost.

**Consequence:** Concrete checkpoint loss when the orchestrator emits `seq=5` then re-emits `seq=6` to correct a slip — the observer never reviews `seq=5` and the orchestrator does not know because the watcher acks nothing.

**Fix:** Key the debounce on `(file, mtime|size)` and capture the just-read content snapshot per event so a first emission is never dropped; or emit on every distinct payload-hash. The invariant must be "every checkpoint that crossed the rename barrier was either read-and-emitted or read-and-dropped-with-reason" — never silently ignored. Add the missing test for "two atomic writes within debounce" race. Cross-ref: Beck P2.4 (test gap).

---

### 5. Numeric-only Codex `id` rejects JSON-RPC 2.0 spec — half the legal `id` space is silently dropped

| | |
|---|---|
| **File** | `web/server/codex-envelope.ts:43-45,69-101` |
| **Council** | Realtime/NDJSON Protocol × Carmack — Principle 7 (Protocol drift — required-field strictness on optional/polymorphic shapes) |
| **Ref** | `references/quality-realtime.md` → Principle 7 |

**Finding:** JSON-RPC 2.0 §4 permits `id` to be string, number, or null (notifications/error-to-unmatched). `isValidId` accepts only non-negative integers. The moment a future Codex version emits `"id":"abc-uuid"` (Codex *has* shipped UUID-shaped ids in past releases), every such frame returns `null` and is silently dropped. There is no telemetry hook on `return null` — drift looks identical to "CLI stopped responding." Same class of strictness applies to `params: array` form and omitted `params` (P2-RT-1 in the Realtime expert's file).

**Consequence:** A Codex update that switches to UUID ids (or to positional/array `params`, or to legitimate notifications without `params`) takes the bridge silent across the board. No log line, no upstream signal — just a dead Codex pairing.

**Fix:** Widen `id` to `string | number` at the parser layer; namespace at the router layer (Task 12). Widen `params` to `object | array` (or document the subset explicitly in the file header). Emit a structured drop-with-reason on every `return null` so silent-rejection has a fingerprint. The reject-on-unknown principle (correct for METHODS and FRAME SHAPES per Hunt) must NOT extend to polymorphic-by-spec FIELDS.

---

### 6. No replay-based regression test against captured Codex JSON-RPC recordings

| | |
|---|---|
| **File** | `web/server/codex-envelope.test.ts` (entire file) |
| **Council** | Realtime/NDJSON Protocol × Carmack — Principle 7 (no replay test on load-bearing protocol) |
| **Ref** | `references/quality-realtime.md` → Principle 7 |

**Finding:** `codex-envelope.ts` is the strict typed parser every Codex JSON-RPC frame must pass through. The recorder system writes `~/.companion/recordings/*.jsonl` and `replay.ts` exists specifically to load and filter them. Yet the test suite is 100% hand-crafted JSON literals — zero fixtures loaded from a real Codex transcript. The realtime reference doc names this exact gap as P1: "A recording-based regression test catches CLI version drift before users do."

**Consequence:** Every Codex frame shape the author didn't think of (the four already documented above plus future drift) will be silently dropped on day one with no test that would have caught it. Combined with finding #5, the parser is calibrated to "what the author imagined" not to "what Codex actually emits."

**Fix:** Capture a clean Codex transcript via the existing recorder, commit it under `web/server/fixtures/codex-frames.jsonl`, write a loop test that feeds each line through `parseCodexFrame` and asserts non-null + typed shape. Pair with finding #5's `onDropped` hook so future drift is observable. This is also the template for an analogous Claude-NDJSON replay test, which is missing too — flag as a follow-up convention candidate (see Phase 7).

---

### 7. Observer permission profile is Claude-tool-only — `claude+codex` observer would spawn with zero enforcement

| | |
|---|---|
| **File** | `web/server/observer-permissions.ts:25-46` |
| **Council** | Willison (LLM Pipeline) × Carmack — Principle 6 (Design for model portability) |
| **Ref** | `references/quality-llm.md` → Principle 6 |

**Finding:** `OBSERVER_ALLOWED_TOOLS` and `OBSERVER_DISALLOWED_TOOLS` are populated with Claude Code tool names (`Read`, `Grep`, `Bash`, `WebFetch`, etc.). Codex uses a different tool namespace (`shell`, MCP tool URIs). When finding #1 is fixed and `getObserverSpawnOverrides()` is applied symmetrically to a Codex observer: the Claude-shaped allowlist matches nothing Codex emits (either bricked or — depending on SDK semantics — silently runs unconstrained); the denylist's `"Bash"` does not block Codex's `shell` tool, breaking the LFI trifecta at the network leg.

**Consequence:** The `claude+codex` pairing (the value-prop of independent failure modes) ships its observer with the security boundary broken specifically for the experimental case where it matters most.

**Fix:** Make `getObserverSpawnOverrides(backendType)` a function of backend type — return Claude-shaped lists for `claude`, Codex-shaped lists for `codex` (with `shell`, WebFetch-equivalent, network tools explicitly denied). Add a denylist-conflict test for the Codex shape. Until both shapes land, the spawn site MUST refuse to start a Codex observer rather than ship an unenforced profile.

---

### 8. Observer denylist static-grep canary doesn't cover Task / `mcp__*` indirection vectors

| | |
|---|---|
| **File** | `web/server/observer-permissions.ts:39-46` |
| **Council** | Hunt (Security) × Carmack — Principle 5 (Shrink the attack surface) + Principle 1 (If it's syntactically possible, it statistically exists) |
| **Ref** | `references/security.md` → Principles 1, 5 |

**Finding:** The denylist covers Bash/network/notebook but omits `Task` (subagent spawn — inherits or refreshes the permission set, the textbook denylist bypass), `mcp__*` (arbitrary MCP server tool URIs — `mcp__filesystem__write_file` or `mcp__shell__exec` are reachable if user MCP config exposes them), `SlashCommand`, `ExitPlanMode`. Allowlist-by-absence works only if the SDK treats `allowedTools` as authoritative; if it ever merges allow+deny (or a future SDK update flips precedence), unlisted indirection tools stay open. The file's "static-grep canary" claim is therefore overstated.

**Consequence:** A prompt-injected observer reaches `Task` → spawns a subagent with default tools → that subagent has `Bash`. Two `permissionMode: "default"` prompts en route are exactly the kind a prompt-injected orchestrator-side LLM auto-approves.

**Fix:** Add `Task`, `SlashCommand`, `ExitPlanMode`, and `mcp__*` to `OBSERVER_DISALLOWED_TOOLS` (or a prefix-match check in `assertObserverToolPolicyConsistent`). Update the file-header comment to enumerate which indirection vectors the canary covers. Cross-ref: Willison's same finding for an LLM-pipeline framing.

---

## P2 — Fix Soon

### 9. `observer-write-policy` predicate's `realpath` contract is documented in JSDoc, not enforced in code — fail-open by construction

| | |
|---|---|
| **File** | `web/server/observer-write-policy.ts:11-18` |
| **Council** | Hunt (Security) × Carmack — Principle 7 (Broken access control) |
| **Ref** | `references/security.md` → Principle 7 |

**Finding:** The predicate is correct GIVEN its inputs are real-path-resolved. The doc-comment says callers must `realpathSync` first. Per user memory `feedback_no_sentinel_user_id_fallback`, defence-by-convention rots. A future caller who passes a raw target path forward sees `${WS}/.council/observer/escape` accepted with `escape` as a symlink to `/etc`.

**Fix:** Inline `realpathSync` inside the predicate (climbing to nearest existing parent for non-existent paths), OR introduce `assertObserverCanWrite(target, workspaceRoot)` that does realpath + predicate as one unit and require callers go through it (do not export the bare predicate).

---

### 10. `atomic-write.ts` is fully synchronous — every checkpoint blocks the Bun event loop on `fsyncSync`

| | |
|---|---|
| **File** | `web/server/atomic-write.ts:18-52` |
| **Council** | Bun/Hono/TS Backend × Carmack — Principle 7 (Async correctness — the event loop is not magic) |
| **Ref** | `references/quality-backend.md` → Principle 7 |

**Finding:** `writeAtomicJson` uses `mkdirSync`/`openSync`/`writeSync`/`fsyncSync`/`renameSync`/`closeSync` end-to-end. `fsyncSync` blocks until kernel returns from disk flush — tens of ms on rotational disks or contended SSDs. Every in-flight HTTP request, WS frame, recorder write, and timer pauses for the duration. Watcher's read side is already async; writer is the asymmetric blocker. Also: `writeSync(fd, json)` ignores the bytes-written return value — under EINTR or filesystem pressure a short write produces a fsynced+renamed truncated tmp file that parses as `null` downstream.

**Consequence:** Cliff-edge tail-latency on the WS bridge during checkpoint phase boundaries — exactly the moments the user is most engaged. Plus rare-but-real silent payload loss from short writes.

**Fix:** Switch to `node:fs/promises` end-to-end; `await` each step. Add a write-loop that tracks bytes written and slices the remainder until `written === total`. Add a test that asserts oversize input rounds-trip without short-write corruption (or use a `vitest` `fs` mock to simulate a short write and assert the loop completes).

---

### 11. Silent swallow of subprocess-kill failures in spawn-rollback and archive paths — leaves orphan subprocesses

| | |
|---|---|
| **File** | `web/server/session-group-coordinator.ts:122-127,153-162` |
| **Council** | Bun/Hono/TS Backend × Carmack — Principle 1 (Programmer errors are crashes — operational errors are handled, never silently swallowed) |
| **Ref** | `references/quality-backend.md` → Principle 1; cross-ref `references/quality-persistence.md` → Principle 3 (sentinel-before-sweep) |

**Finding:** Two distinct paths silently swallow kill failures with `/* swallow */` comments: (a) rollback after observer-spawn failure — the original error is preserved per the comment, but a live headless orchestrator subprocess now exists with no record in `this.groups`, permanently orphaned until parent exit; (b) `archiveGroup` sequential kills — both calls swallow, state machine transitions to `archived` regardless, user sees "group archived" with no signal that one or both halves still run. Combined with Persistence P2-4: `mark_orphan` and `relaunch_observer` reconciliation actions have no sentinel-write helper analogous to `writeArchiveTombstone`, so the "every branch closes its state row" invariant (memory `feedback_outbox_close_all_paths`) is structurally unfinished.

**Fix:** Emit a structured log line (`event: "group_kill_failed", sessionGroupId, role, error: ...`) and propagate via `Error.cause` or `AggregateError`. Add sibling helpers `writeOrphanMarker` and `writeRelaunchIntent` to `group-reconciliation.ts`, backed by `writeAtomicJson` — caller pattern becomes "decide → writeMarker → act → (optionally) deleteMarker," so a crash between writeMarker and act leaves the next reconciliation resuming idempotently.

---

### 12. Watcher reads the entire file before applying the 256 KiB size cap — 1 GiB DoS surface

| | |
|---|---|
| **File** | `web/server/checkpoint-watcher.ts:80`, `web/server/council-types.ts:103` |
| **Council** | FS-JSON Persistence × Carmack — Principle 1 (Atomic write or it didn't happen, applied to read-side bounds) |
| **Ref** | `references/quality-persistence.md` → Principle 1 |

**Finding:** `readAndEmit` calls `readFile(path, "utf-8")` with no size limit; `parseCheckpointPayload` checks `raw.length > COUNCIL_ARTIFACT_MAX_BYTES` AFTER decoding. A 1 GiB file dropped into the watched directory (by the observer subprocess, a stale artifact, a buggy peer process) is fully loaded into V8/JSC memory before being rejected. The orchestrator-side writer enforces the cap, but the watcher reads any `.json` that lands.

**Fix:** `fs.stat` first; if `stats.size > COUNCIL_ARTIFACT_MAX_BYTES * 2` (small envelope slack), call `onDropped("oversize-on-disk", file)` and return without reading. Or use a bounded `createReadStream`. Cross-ref: Backend BE-6 (same root cause).

---

### 13. `archiveGroup` does not abort the checkpoint watcher / no AbortController binding on the group lifecycle — historical "болтается" anti-pattern's natural habitat

| | |
|---|---|
| **File** | `web/server/session-group-coordinator.ts:148-164`, cross-ref `web/server/checkpoint-watcher.ts:21,55` and `web/server/checkpoint-watcher.ts:38-68` |
| **Council** | Bun/Hono/TS Backend × Carmack — Principle 5 (Resource management — connections, streams, cleanup) |
| **Ref** | `references/quality-backend.md` → Principle 5 |

**Finding:** The PLAN's Task 5 explicitly required AbortController binding between coordinator and watcher. `archiveGroup` does NOT own an `AbortController` for the group, does NOT call `signal.abort()` on archive. The watcher's own teardown contract (clears timers in `finally` when aborted) is correct in isolation, but nothing in the coordinator triggers the abort. When the watcher integration lands (deferred to a later task), the seam will silently keep timers and the `for await` loop running past subprocess death. Compounded by Persistence P2-3: there is no observable "watcher ready" milestone — tests use `setTimeout(50)` as a stand-in, so the startup race (checkpoint emitted before kernel watches) has no defensible edge to wait on.

**Fix:** Add an `abortController: AbortController` field to `GroupRecord`. In `archiveGroup`, `abort()` before the kills (with the same care as the state-machine transition that already precedes kills). Expose `{ ready: Promise<void>, done: Promise<void> }` on `watchCheckpoints` — internally resolve `ready` after the first iteration of the `for await` is observed. The coordinator awaits `ready` before signaling "OK, you may emit."

---

## P3 — Consider

### 14. `BackendProvider` interface and named singletons are speculative — only one of four exports has a real consumer

| | |
|---|---|
| **File** | `web/server/backend-provider.ts:11-28` |
| **Council** | Fowler (Refactoring) × Carmack — Principle 5 (Speculative Generality) |

Only `SUPPORTED_PAIRINGS` / `isSupportedPairing` / `BackendPairing` have a day-one caller (the coordinator). `BackendProvider`, `CLAUDE_BACKEND`, `CODEX_BACKEND`, `getBackend(type)` are dead code; the four `if (backendType === "codex")` sites in `cli-launcher.ts`/`cron-scheduler.ts`/`agent-executor.ts`/`routes/system-routes.ts` still branch inline. The interface today carries only `backendType` + `binaryName` — the actual divergence (spawn args, env, sandbox flags, model defaults, prompt shape) isn't there, so the real migration will have to break the interface. Carmack's rule: two implementations is fine; three needs a registry, two does not. Drop the unused exports and re-introduce in the same PR that replaces the `cli-launcher.ts` branches.

---

### 15. No structured logging on the entire new group-lifecycle surface

| | |
|---|---|
| **File** | `web/server/checkpoint-watcher.ts:42` (only `console.warn`), `web/server/session-group-coordinator.ts` (entirely silent), `web/server/group-reconciliation.ts` (entirely silent) |
| **Council** | Bun/Hono/TS Backend × Carmack — Principle 6 (Structured logging — observability as correctness) |

The watcher's default `onDropped` is `console.warn` with no timestamp, level, sessionGroupId, role, or event field. Three concurrent watchers (three groups) produce indistinguishable log lines. The coordinator emits ZERO log lines across spawn, spawn-rollback, state transition, and archive — the entire group lifecycle is invisible to ops. Reconciliation's `writeArchiveTombstone` is silent on success and silent on failure (it can throw from `writeAtomicJson`, but the call site doesn't wrap it). Introduce a minimal `log({ event, sessionGroupId, role?, sessionId?, ... })` JSON-line helper and thread it through. Every line on the group critical path should carry at least `event` + `sessionGroupId`.

---

## Summary

| # | Finding | Severity | Council | Fix effort |
|---|---------|----------|---------|------------|
| 1 | Observer SDK profile dead code (not wired to spawn) | P1 | Subprocess | ~40 LOC + 2 tests |
| 2 | archiveGroup intentional-kills race | P1 | Subprocess | ~15 LOC + 1 test |
| 3 | `--resume` vs Companion ID conflated | P1 | Subprocess | ~20 LOC across coordinator types |
| 4 | Watcher debounce drops same-filename first payload | P1 | FS-JSON Persistence | ~10 LOC + 1 test |
| 5 | Codex `id` numeric-only rejects JSON-RPC 2.0 spec | P1 | Realtime/NDJSON | ~10 LOC + 3 tests + onDropped plumbing |
| 6 | No replay-based test on Codex protocol parser | P1 | Realtime/NDJSON | fixture capture + ~20 LOC test |
| 7 | Observer profile Claude-only; Codex observer unenforced | P1 | Willison | ~30 LOC (split profiles) + 1 test |
| 8 | Denylist canary misses Task / `mcp__*` indirection | P1 | Hunt × Willison | ~5 LOC + test |
| 9 | observer-write-policy realpath contract docs-only | P2 | Hunt | ~10 LOC (assertObserverCanWrite wrapper) |
| 10 | Atomic-write fully synchronous; blocks event loop | P2 | Backend | ~50 LOC (async migration) + short-write loop |
| 11 | Silent swallow of subprocess-kill failures + missing sentinels | P2 | Backend × Persistence | ~40 LOC across coordinator + reconciliation |
| 12 | Watcher reads before size cap (DoS surface) | P2 | Persistence | ~10 LOC + test |
| 13 | No AbortController binding; no watcher-ready milestone | P2 | Backend × Persistence | ~30 LOC across coordinator + watcher |
| 14 | BackendProvider interface speculative — dead exports | P3 | Fowler | ~20 LOC delete + 1 file rename |
| 15 | No structured logging on group lifecycle | P3 | Backend | ~50 LOC threading a logger helper |

**Totals:** 8 P1, 5 P2, 2 P3.

## Verdict

The structural keystone landed: `SessionGroupCoordinator` consumes spawn through dependency injection and never imports `session-orchestrator.ts`. The state machine is a single source of truth. The schema correctly hosts both sides of the writer/observer contract. Atomic-write itself is correct (same-dir tmp+rename, fsync fd, best-effort parent-dir fsync, sized cap, randomised tmp). Tests are Beck-friendly: behaviour-on-realistic-inputs, low mock count, system-boundary mocks only, no `.skip` debt, no mock-built-never-injected. Reading the test corpus is the strongest endorsement this batch carries.

**The single highest-priority fix is #1 — observer SDK permission profile not wired to spawn.** Five experts independently flagged variants. The entire observer security argument rests on a contract that exists only in JSDoc; until the seam is closed, every other observer-security finding (#7, #8, #9, #11's orphan paths) is a refinement of a boundary that doesn't yet bite.

**The single most critical Council expert for this codebase right now is the Subprocess Lifecycle Expert.** Three of eight P1s sit in their lane (#1, #2, #3) and each is a deterministic correctness gap rather than a "might happen at scale" concern. The teardown race in #2 fires on every archive. The `--resume` confusion in #3 fires on every observer reconnect. The dead-code seam in #1 fires every time anyone tries the feature. These are not concerns about whether the feature scales — they are concerns about whether the feature works.

**The single most critical Council expert for the next batch (Task 12 event-bus + Task 14 grounding) is Realtime/NDJSON.** Findings #5 and #6 will compound the moment ws-bridge integration begins: the Codex parser pre-commits a routing approach (binary parse-or-null with no telemetry), and Task 12's fanout layer will inherit that silent-drop posture. Fixing #5 and #6 before Task 12 lands is cheaper than retro-fitting.

Carmack would ship — but only after #1–#8. Each P1 is a deterministic bug, not a future-scale worry. The remaining P2/P3 work is well within the project's normal cadence; the architecture is sound.

---

## Findings Breakdown by Expert

| Expert | P1 | P2 | P3 | Total | Key Areas |
|--------|----|----|----|----|-----------|
| Hunt (Security) | 0→1 (cross-ref) | 1 | — | 2 | denylist canary gaps, realpath docs-only |
| Fowler (Refactoring) | — | — | 1 | 1 | BackendProvider speculative generality |
| Bun/Hono/TS Backend | — | 4 (incl. cross-ref) | 1 | 5 | sync fs blocking loop, silent kill swallow, no abort binding, no structured logging |
| FS-JSON Persistence | 1 | 2 (incl. cross-ref) | — | 3 | debounce-drops-payload, watcher read-before-cap, sentinel-before-sweep partial |
| Realtime/NDJSON Protocol | 2 | — | — | 2 | numeric-only id, no replay test |
| Subprocess Lifecycle | 3 | — | — | 3 | dead observer profile, intentional-kills race, --resume conflation |
| Willison (LLM Pipeline) | 1 + cross-ref | — | — | 2 | Claude-only profile, denylist canary indirection vectors |
| Beck (Test Quality) | — | (cross-ref) | — | 0 (folded) | test-side parallels to #1, #4 — see beck.md for 11 additional findings |
| **TOTAL** | **8** | **5** | **2** | **15** | |

**Note on Beck:** Beck's 11 findings are folded into cross-references on #1 and #4 because they are test-side parallels of the production gaps. The standalone Beck file (`.council/review-output/2026-05-11-1953/beck.md`) lists them all, including 3 P3 signals (impl-derived literal pinning notes) worth reading before the next batch.

**Review output written to:** `.council/review-output/2026-05-11-1953/FINAL-REVIEW.md`

**Expert output files:**
- Hunt: `.council/review-output/2026-05-11-1953/hunt.md` (9 findings)
- Fowler: `.council/review-output/2026-05-11-1953/fowler.md` (3 findings)
- Bun/Hono/TS: `.council/review-output/2026-05-11-1953/backend-ts.md` (15 findings)
- FS-JSON Persistence: `.council/review-output/2026-05-11-1953/persistence.md` (6 findings)
- Realtime/NDJSON: `.council/review-output/2026-05-11-1953/realtime.md` (11 findings)
- Subprocess Lifecycle: `.council/review-output/2026-05-11-1953/subprocess.md` (8 findings)
- Willison: `.council/review-output/2026-05-11-1953/willison.md` (7 findings)
- Beck: `.council/review-output/2026-05-11-1953/beck.md` (11 findings)
