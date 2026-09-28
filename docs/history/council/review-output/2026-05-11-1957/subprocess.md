# Subprocess Lifecycle Review — Council Mode Phase A+B+C

Scope: `session-group-coordinator.ts`, `backend-provider.ts`, `observer-permissions.ts`, `group-reconciliation.ts`. These modules are **not yet wired into `cli-launcher.ts`** — the coordinator takes injected `spawn`/`kill` functions, so this review evaluates the **shape of the coordination contract** rather than live subprocess semantics. Findings target the contract gaps that will produce wrong subprocess state when wiring happens.

---

## P1 Findings

### P1-1. `disallowedTools` denylist is decorative — the CLI never receives it

**File**: `web/server/observer-permissions.ts:39-46, 56-72`
**Cross-ref**: `web/server/cli-launcher.ts:520-540` (no `--disallowedTools` emission anywhere)
**Principle**: P1 — "spawn is not exec" (every argument must be validated *and reach the child*); also P10 — "know your gaps".

**What's wrong**: `ObserverSpawnOverrides` advertises a triplet `{ allowedTools, disallowedTools, permissionMode }` and `getObserverSpawnOverrides()` returns a populated `disallowedTools: [Bash, BashOutput, KillShell, WebFetch, WebSearch, NotebookEdit]`. But `cli-launcher.ts` — the file this will wire into — only emits `--allowedTools` and `--permission-mode`; it has zero handling for `--disallowedTools` (`grep -n disallowedTools server/cli-launcher.ts` returns nothing). When wiring lands, `disallowedTools` will be silently dropped on the floor for the Claude backend.

The module's own doc comment claims "omitting a tool from `OBSERVER_ALLOWED_TOOLS` already denies it, but the explicit `OBSERVER_DISALLOWED_TOOLS` list acts as a static-grep canary." That framing depends on the CLI honouring the allowlist as **exclusive** (only what's listed is callable). If the CLI's `--allowedTools` is **additive** to its built-in default toolkit (which is how Claude Code historically behaves — the flag *adds* auto-approve, it does not *restrict* the available set), then **neither** list actually constrains the observer: the allowlist isn't restrictive, the denylist isn't delivered. The observer would inherit the full agent toolkit, and the Hunt P5 "shrink the attack surface" rationale in the module header is violated.

**Consequence**: A prompt-injected observer in a same-uid, same-cwd pair could shell-out via `Bash`, exfiltrate via `WebFetch`, or use `KillShell` to crash the orchestrator — exactly the things `OBSERVER_DISALLOWED_TOOLS` was meant to prevent. Worst case is silent: tests pass (the canary `assertObserverToolPolicyConsistent` only checks that the lists are disjoint, not that the denylist reaches the CLI), the coordinator looks correct in isolation, and the security property fails in production.

**Fix**: Confirm Claude Code's `--allowedTools` semantics — is it allow-list-only or auto-approve-additive? If the latter, observer enforcement must use a *different* mechanism (permission-mode hook returning deny for non-allowed tools, OR `can_use_tool` ACL on the server side filtering by sessionGroupRole). If the former, document that fact in the file header and remove `disallowedTools` from `ObserverSpawnOverrides` since it is unreachable. Either way, add a wiring-time assertion in `cli-launcher.ts` that the observer-role spawn path actually emits a flag for every entry in `disallowedTools`, or fail the spawn. The static-grep canary should be regex-grep of the cli-launcher source confirming a `--disallowedTools` emission site exists, not just an in-file disjoint-set check.

---

### P1-2. `decideReconciliation` trusts `aliveByPid` — no identity confirmation against PID reuse

**File**: `web/server/group-reconciliation.ts:9-64`
**Principle**: P2 — "Track PID, but never trust PID across reboots."

**What's wrong**: The prompt explicitly asked whether "primary alive but PID-reuse confusion" is in scope. The four-state policy treats `aliveByPid: true` as truth and dispatches `resume_pair` or `relaunch_observer` accordingly. The header comment acknowledges "fallible (PID reuse), but sufficient when the alternative is 'guess'" — but this is exactly the case where guessing is *worse than declaring dead*. PID reuse after server restart means the kernel has handed the old CLI's PID to (say) the user's shell or a webhook process; `process.kill(pid, 0)` returns success; `decideReconciliation` returns `resume_pair`; the coordinator later sends `SIGTERM` to the unrelated process at archive time. Cross-ref `cli-launcher.ts:1171,1181` — kill paths go straight to `proc.kill("SIGTERM")` / `"SIGKILL"`.

The `RestartState` type has a single `aliveByPid: boolean` field. There is no place to plumb a verification result (ppid match, `/proc/<pid>/comm` match, identity-exchange-completed). This means **identity confirmation cannot be added without a type-level breaking change**, which earns a P1 over a "soft" P2: the contract shape itself forecloses the correct fix.

**Consequence**: On `resume_pair`, the bridge attaches to the wrong process; messages disappear into a Firefox process or a sibling agent. On `relaunch_observer`, the system trusts a wrong-process orchestrator and pairs a fresh observer with garbage. On `archive_dead` triggered later, the wrong PID gets SIGTERM'd. Quality-subprocess P2 explicitly flags PID-only reconnect as P1: "PID-only reconnect on server restart" → "Severity P1".

**Fix**: Make `RestartState` carry an `identity: { ppidMatches: boolean; commMatches: boolean; identityExchangeCompleted: boolean }` substructure. `decideReconciliation` should refuse to return `resume_pair` unless at least one strong identity check (identity-exchange) and one weak check (ppid or comm match) both pass; degrade to `archive_dead` or `mark_orphan` on identity mismatch. Document the verification protocol as part of this module's contract so the wiring task in Phase D cannot accidentally pass `aliveByPid: true` from a bare `kill -0`.

---

### P1-3. `createGroup` rollback has no SIGTERM→SIGKILL escalation and no timeout on cleanup `kill`

**File**: `web/server/session-group-coordinator.ts:88-131`
**Principle**: P3 — "SIGTERM grace, SIGKILL fallback"; P4 — "Auto-relaunch must be bounded".

**What's wrong**: When observer spawn fails after primary spawn succeeded, the catch path does `await this.deps.kill(primarySpawn.sessionId)` and swallows any error. The contract on `SessionKiller` is `(sessionId: string) => Promise<void>` — no timeout, no signal-escalation semantics, no `force` flag. If the underlying kill implementation:

  1. Sends SIGTERM and waits for the process to exit (the normal pattern), and
  2. The just-spawned CLI is unresponsive to SIGTERM (mid-startup, in a syscall, blocked on stdin handshake) —

then `kill` hangs forever. The `await` in the catch block hangs forever. The error from `observerSpawn` is never thrown. The caller's `await coord.createGroup(...)` hangs forever. The browser sees a stuck "creating session" state, and the orphan primary CLI continues to run, consuming Anthropic quota, listening on the SDK WebSocket for inputs that will never come.

The same defect applies to `archiveGroup` (lines 148–164): two sequential `await this.deps.kill(...)` calls with no per-call timeout. If `kill` of primary hangs, the observer is never killed — the primary half is the live, dangerous one (full agent toolkit) and exactly the one whose hang prevents observer cleanup.

The prompt asked explicitly: "what if BOTH spawn-and-then-cleanup-kill fail? what if kill is slow/hangs?" The current contract has no answer.

**Consequence**: A slow kill leaves an orphan primary CLI alive with no group record (because the catch block runs before `groups.set`). The orphan is invisible to the coordinator (`findBySessionId` won't find it), invisible to the user (no UI surface), and only the underlying SessionOrchestrator (whatever the injected `spawn` wired to) knows about it. This is the classic "spawn succeeded, container failed to finish init, can't reach it to kill it" orphan class — exactly what Carmack P7 ("resource lifecycle is visible or it's leaked") warns about.

**Fix**: Extend `SessionKiller` to `(sessionId: string, opts?: { timeoutMs?: number; force?: boolean }) => Promise<{ exited: boolean }>`. In `createGroup` rollback, call `kill(id, { timeoutMs: 5000, force: true })` — SIGTERM, wait 5s, SIGKILL, return. If even SIGKILL doesn't reap within another short window, write a tombstone entry recording the orphan PID/sessionId so the next reconciliation can sweep it. In `archiveGroup`, run the two kills in parallel (`Promise.allSettled`) with the same timeout contract — sequential await means one hang blocks the other indefinitely.

---

## P2 Findings

### P2-1. `archiveGroup` is state-idempotent but not side-effect-idempotent

**File**: `web/server/session-group-coordinator.ts:148-164`
**Principle**: P7 — "Zombie reaping — the launcher is the parent" / lifecycle visibility.

**What's wrong**: The prompt asked to verify idempotency of `archiveGroup` on a re-archive — "is it a no-op? It is — verify discipline." Strictly: the state transition is idempotent (`transition("archived", { user_archived }) → "archived"`) and the function returns `true` again. But the *kill calls still fire* on the second invocation. `kill("sessionId-already-dead")` will typically throw "no such session" inside the orchestrator, which the coordinator silently swallows. If the kill implementation has side effects (recording-close, event emission, log line, increment of "kill count" metric) those fire twice. If the implementation re-emits a `session.exited` event on a second kill, downstream watchers fire spurious half_died events on an already-archived group (the state machine swallows them, but the noise is real).

**Consequence**: Doubled event traffic on re-archive, doubled log lines, potential confusion when investigating "why did this kill fire on a dead session?" An archive endpoint that's safe to retry from the UI is a feature; doubled side effects undermine that.

**Fix**: Early-return when `g.status === "archived"` BEFORE entering the kill section. The state machine has already provided the discriminator; use it.

---

### P2-2. `createGroup` failure does not clean up partial state inside the injected spawner

**File**: `web/server/session-group-coordinator.ts:93-130`
**Principle**: P7 — exit handler / cleanup discipline.

**What's wrong**: On observer-spawn failure, the coordinator does NOT call `groups.set(sessionGroupId, ...)`. Good. But the primary spawner has already executed its full side-effect chain — wrote session JSON to disk (`session-store`), opened a recording file (`recorder.ts`), registered a PID, possibly subscribed to checkpoint-watcher events on `sessionGroupId`. The catch block calls `kill(primarySpawn.sessionId)` to terminate the process, but there is no contract guarantee that `kill` *also* unwinds: session-store entry, recording file FD, watcher subscription on the now-doomed groupId. The recording file especially — Principle 8 says "recording file not closed on subprocess exit" is P2 — would be left as an open FD with a sessionId nobody remembers. The eventual rotation manager will see an orphan file.

Furthermore, `sessionGroupId` was generated by this function; if `kill` doesn't tear down watchers tagged with it, a stale group-id is registered against a checkpoint sentinel directory that no group will ever reach the "active" state to consume.

**Consequence**: After a single observer-spawn failure: one orphan session-store entry, one orphan recording file (possibly mid-rotation), one orphan watcher subscription keyed to a sessionGroupId that no longer exists. Multiply by retries, and disk + watcher state grow without bound.

**Fix**: `createGroup` rollback must call a full-cleanup variant, not just `kill`. Either `SessionKiller` is contractually defined to do full cleanup (document + test it), or the coordinator takes an additional `cleanup(sessionId, sessionGroupId)` dependency that drops watcher subs and finalises the recording. The simpler choice is to require `kill` to be a destructor, not a signal-sender — name it `dispose` if that better signals intent.

---

### P2-3. `decideReconciliation` ignores the "both alive but split-brain" state

**File**: `web/server/group-reconciliation.ts:33-64`
**Principle**: P5 — "`--resume` semantics — session ID continuity, not state."

**What's wrong**: The four-state matrix assumes the only failure modes are "did the process survive". But there is a fifth real state: **both processes alive, BUT they disagree on group state or the orchestrator has moved on to phase N+1 while the observer is still reviewing phase N**. After a server restart, the bridge reconnects both halves and calls `resume_pair`; the state machine flips to `active`; meanwhile the orchestrator is writing checkpoint N+2 while the observer is consuming N+1. The reconciliation policy has no mechanism for "halves resumed, verify they're at the same logical phase" — that's deferred to "Phase D wiring" and not contractually anchored here.

Quality-subprocess Principle 5 (state drift after resume): "After resume, re-send the canonical state (model, permission mode) from the persisted session JSON to align the CLI." For Council Mode the canonical state includes `lastCheckpointSeen` per role; without it, the observer can either replay all checkpoints (wastes tokens, fires already-handled findings) or skip ahead (loses safety review of phases it missed). Neither is correct without explicit reconciliation.

**Consequence**: After a restart, observers either re-review work they already reviewed (Anthropic quota waste, duplicate findings spammed to UI) or silently skip work they should have reviewed (the orchestrator did something risky during the gap and no observer found it). The latter is the more dangerous failure mode and harder to detect.

**Fix**: Extend `RestartState` with `primary.lastCheckpointWritten` and `observer.lastCheckpointConsumed`. Add a fifth action to `ReconciliationAction`: `{ type: "resume_pair_with_replay"; sessionGroupId: string; replayFrom: number }`. The four-state policy collapses into a five-state policy where "both alive AND in sync" is `resume_pair` and "both alive but observer behind" is `resume_pair_with_replay`. Out-of-scope for Phase A-C wiring, but the *contract* must accommodate it now — adding a discriminant later is a breaking change to every caller.

---

## P3 Findings

### P3-1. `findBySessionId` is O(n) — silent quadratic on session-exit storms

**File**: `web/server/session-group-coordinator.ts:171-178`
**Principle**: P10 — know your gaps; not strictly a lifecycle bug but lifecycle-event-handler perf.

**What's wrong**: Every "session exited" event from the underlying orchestrator will route through `findBySessionId` (linear scan) to discover which group it belongs to, then trigger a state-machine transition. If a server restart with N groups produces 2N exit-or-reconnect events in a tight loop, the cost is O(N²). N is bounded by user behaviour (one user, one machine), but the secondary effect is that the scan happens inside whatever event loop tick is processing the exit — possibly during shutdown cleanup, where a 200ms hiccup multiplies into the SIGTERM grace timeout.

**Consequence**: At small N (a handful of groups) invisible. At larger N or in a restart storm, the coordinator becomes a serializer for exit-event processing, which can interact badly with the `archiveGroup` sequential-kill pattern.

**Fix**: Maintain a `sessionIdToGroupId` reverse index alongside `groups`. Populate in `createGroup`, delete in `archiveGroup`. O(1) lookup, O(N) memory — trivial trade.

---

### P3-2. `backend-provider` allow-list is a single source of truth — wiring time has no enforcement seam for binary-path validation

**File**: `web/server/backend-provider.ts:11-51`
**Principle**: P1 — "spawn argument validation" (low-risk variant).

**What's wrong**: `BackendProvider.binaryName` is the literal string `"claude"` or `"codex"`. When wiring lands, `cli-launcher.ts` will resolve this to an absolute binary path via `$PATH` lookup. There is no place in this contract to plumb the resolved absolute path back — meaning the same `BackendProvider` value used for the "is this pair allowed?" check is divorced from the actual binary spawn. If `$PATH` includes a user-writable directory ahead of system paths, a malicious `claude` shadow could be picked up. This is a deploy/security expert concern primarily (Hunt P1), but the lifecycle-shaped fix lives here: `BackendProvider` should carry the resolved absolute path post-validation, not the bare binary name.

**Consequence**: Out of scope until cli-launcher migration lands, but the contract shape forecloses adding the validation later without breaking every caller.

**Fix**: Extend `BackendProvider` with `resolveBinary(): string` returning an absolute path resolved once at server boot and frozen. Make `binaryName` private. Callers wiring into spawn get the resolved path, not a name to re-resolve.

---

## Out-of-Lane Cross-References

- The `--disallowedTools` finding (P1-1) overlaps with Hunt (security) and Willison (LLM pipeline) — observer toolkit restriction. The subprocess-lane angle is the contract bug: a flag the cli-launcher cannot emit appears in the spawn-overrides type.
- PID-reuse identity confirmation (P1-2) overlaps with FS-JSON persistence (the persisted PID is the input to `aliveByPid`). Subprocess lane owns the *decision* that consumes it.
- Kill-hang timeout (P1-3) overlaps with Bun/Hono backend (Bun.spawn signal handling) — flagged here because the *contract* permits a hang; the implementation choice is downstream.
