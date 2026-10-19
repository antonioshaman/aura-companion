# Subprocess Lifecycle Expert — Council Mode Paired-Sessions Review

Reviewer focus: process state correctness for paired CLI subprocesses (orchestrator + observer) — argv shape and `--resume` ID hygiene at the `backend-provider` seam, observer SDK profile enforced AT spawn (not bolted on after), group-aware kill ordering, per-half relaunch bulkheads, reconnect-grace coherence across both halves, all-4-states restart reconciliation, and recording lifetime coupling for the pair.

Files reviewed:
- `/root/aura-companion/web/server/backend-provider.ts` + `.test.ts`
- `/root/aura-companion/web/server/session-group-coordinator.ts` + `.test.ts`
- `/root/aura-companion/web/server/group-reconciliation.ts` + `.test.ts`
- `/root/aura-companion/web/server/observer-permissions.ts` + `.test.ts`

Cross-reference (to verify lane-correct integration, not to flag): `cli-launcher.ts`, `session-orchestrator.ts`, `group-state-machine.ts`, `session-types.ts`.

Summary: **8 findings — 3 × P1, 4 × P2, 1 × P3.**

---

## P1 — Fix Now

### P1-SP-1. Observer SDK permission profile is defined but NOT applied at spawn — the security boundary is dead code

**File:** `/root/aura-companion/web/server/observer-permissions.ts` (entire module)
**Cross-ref:** `/root/aura-companion/web/server/session-group-coordinator.ts:39-46` (`SessionSpawner` interface), `/root/aura-companion/web/server/cli-launcher.ts:140-171` (`LaunchOptions`)

**Concrete process-state failure.** `getObserverSpawnOverrides()` returns `{ allowedTools, disallowedTools, permissionMode }`, but **no caller in the entire repository invokes it**. Grep confirms zero imports of `getObserverSpawnOverrides` / `OBSERVER_ALLOWED_TOOLS` / `OBSERVER_PERMISSION_MODE` outside the module's own tests. Critically, the `SessionSpawner` signature in `session-group-coordinator.ts` (lines 39–46) accepts `cwd, backendType, model, permissionMode, sessionGroupId, sessionGroupRole` — there is **no path for `allowedTools` / `disallowedTools` / per-role permission overrides**. So when the coordinator spawns the observer half it forwards the same `permissionMode` that the user picked for the orchestrator (line 107), and the launcher emits exactly the same `--allowedTools` it would for any other session (cli-launcher.ts:536–540).

Per the brief and per the doc invariant (quality-subprocess Principle 1: "argument list built from user-controlled fields" / "use the type system as armour"), the observer profile MUST be applied AT spawn — `Bun.spawn(["claude", "--allowedTools", "Read", "--allowedTools", "Grep", ..., "--permission-mode", "default"])` — not "bolted on after" via runtime injection, which is not implemented either. As shipped, an observer spawned today inherits the orchestrator's `bypassPermissions` or `acceptEdits` mode and the orchestrator's tool surface, including `Bash`. That is the exact opposite of the doc's "shrink the attack surface" claim that the module's preamble advertises.

This is a P1 process-state failure because:
1. The observer subprocess starts with full agent privileges.
2. The module exists, tests pass, and the comment at the top reads "applied at spawn" — so a reader assumes the boundary is live. The discrepancy is invisible without grep.
3. Per memory `feedback_verify_test_bodies_not_just_names`: the test asserts the *constants* match a literal — it never asserts the constants flow into a spawn command line. Vacuously passing.

**Concrete fixes (any one closes the gap, all three together are the right shape):**
- Add `allowedTools?: string[]`, `disallowedTools?: string[]`, `permissionModeOverride?: string` to the `SessionSpawner` opts contract and have `SessionGroupCoordinator.createGroup` apply `getObserverSpawnOverrides()` for the observer half only.
- Propagate the override into `LaunchOptions` and into the `args` array build at `cli-launcher.ts:520–554` (claude) and `cli-launcher.ts:758–762` (codex). Codex doesn't currently accept `--allowedTools` — flag whether the policy applies to codex observers at all, otherwise an observer pairing of `claude+codex` silently runs an unconstrained codex.
- Add a *behavioural* test: invoke `coord.createGroup({primary:"claude",observer:"claude"})` against a fake spawner that records argv, assert that the observer call's argv contains `--permission-mode default` AND `--allowedTools Read` AND does NOT contain `--allowedTools Bash`. Today no such test exists.

Also: `assertObserverToolPolicyConsistent()` is exported but never invoked from server startup — it advertises itself as "the boot canary" but nothing calls it. Wire it into `index.ts`/server bootstrap.

---

### P1-SP-2. Group-aware kill does not mark the second half as "intentional kill" before the first kill — the orchestrator's exit handler will relaunch the observer (or vice versa) mid-teardown

**File:** `/root/aura-companion/web/server/session-group-coordinator.ts:148-164` (`archiveGroup`)
**Cross-ref:** `/root/aura-companion/web/server/session-orchestrator.ts:195-197, 856-898` (`scheduleProactiveRelaunch` — fires on `session:exited`, gated only by `intentionalKills.has(sessionId)`)

**Concrete process-state failure.** Per the brief: *"mark BOTH session IDs as intentional kills BEFORE calling launcher.kill() on either — otherwise the first kill triggers proactive relaunch of the other half mid-teardown."* What the coordinator does today:

```ts
g.status = transition(g.status, { type: "user_archived" });   // flips group status
await this.deps.kill(g.primary.sessionId);                    // kills primary
await this.deps.kill(g.observer.sessionId);                   // kills observer
```

The `g.status = "archived"` flip is purely internal coordinator state. **It does NOT touch `session-orchestrator.intentionalKills`**, which is the actual gate consulted by `scheduleProactiveRelaunch` (orchestrator.ts:859). When `await this.deps.kill(g.primary.sessionId)` resolves, the underlying `CliLauncher.kill()` emits `session:exited` via `proc.exited.then(...)` (cli-launcher.ts:619–637, 950, 1129), which fires `scheduleProactiveRelaunch(primaryId)` AND independently every other `session:exited` listener. The observer's listener wakes the coordinator's `applyEvent("half_died","orchestrator")` — fine — but the orchestrator's keepalive will *also* see a not-yet-killed observer with `intentionalKills.has(observerId) === false`, schedule a 3 s proactive relaunch (orchestrator.ts:870–895), and 3 seconds later the observer's exit (caused by the second kill, two lines down) fires AGAIN and the keepalive relaunches it. The pair tears down half-zombie: the orchestrator dies, the observer briefly resurrects, then dies, then relaunches, then is finally killed by `archiveGroup`'s second `kill()` call, then keepalive races again on the resurrected one.

Worse: there's also no plumbing from the *single-session* path. `SessionOrchestrator.deleteSession()` (line 706) adds `intentionalKills.add(sessionId)` for one ID only — if a user invokes the single-session delete on what is actually one half of a council pair (UI Task 15 isn't here, so routing isn't proven), the OTHER half is left dangling and proactively relaunched by `scheduleProactiveRelaunch` two lines after `proc.exited` resolves.

The injected `SessionKiller` type (`session-group-coordinator.ts:48`) is `(sessionId: string) => Promise<void>` — it has no way to expose "mark intentional first." The coordinator either needs (a) a different injected surface that takes both IDs and brackets the kills inside the intentional-kill set, or (b) to be wired to push BOTH IDs into the orchestrator's `intentionalKills` set before calling kill on either.

**Concrete fix shape:**
- Change `SessionKiller` to `(sessionId: string, opts?: { intentional?: true }) => Promise<void>`, or add a sibling `markIntentional(sessionId)` injection. In `archiveGroup`, call `markIntentional(primary)` AND `markIntentional(observer)` BEFORE either `kill(...)`.
- Add a test that uses a fake spawner with a `session:exited`-emitting kill and asserts that the second kill is reached without an intervening relaunch attempt. Currently `session-group-coordinator.test.ts:135-145` only proves both kills run if one throws — it does NOT exercise the cross-listener race.

---

### P1-SP-3. `--resume` IDs at the coordinator boundary are not differentiated from CLI internal session IDs — the relaunch path on the observer half will dispatch wrong-shape resume

**File:** `/root/aura-companion/web/server/session-group-coordinator.ts:30-46` (`SpawnedSession`, `SessionSpawner`), `/root/aura-companion/web/server/group-reconciliation.ts:35` (`relaunch_observer; primarySessionId`)
**Cross-ref:** `/root/aura-companion/web/server/cli-launcher.ts:87-93, 550-552, 1148-1156` (`cliSessionId` vs `sessionId`, `--resume <cliSessionId>`)

**Concrete process-state failure.** Per quality-subprocess Principle 5: *"Companion has its own session ID. The CLI has its own. `--resume` takes the CLI's ID. Mixing them up reconnects to the wrong session or fails outright."* The existing single-session launcher carefully separates the two — `SdkSessionInfo.sessionId` (Companion UUID, used to route WebSocket) vs `SdkSessionInfo.cliSessionId` (CLI's internal ID, only populated after `system.init`, used for `--resume`, cleared on a `<5s` rapid exit at cli-launcher.ts:629–632).

In the new code, **the coordinator collapses this distinction.** The `SpawnedSession` shape (line 30–32) only carries `sessionId: string`. `GroupRecord.primary` / `.observer` (line 50–53) only carry `sessionId: string; backendType`. The `relaunch_observer` reconciliation action (group-reconciliation.ts:35) carries only `primarySessionId: string`. Two consequences:

1. **At reconciliation time, "relaunch the observer with same groupId" cannot be implemented correctly** without going back to the launcher to fetch `cliSessionId` for both halves. The action is named at the layer that's missing the data. The unit test (group-reconciliation.test.ts:30–35) asserts the literal string "sess-1" comes through, which proves nothing about whether the actual relaunch call will use it as a `--resume` arg (it would be wrong — that's the Companion sessionId, not the CLI sessionId).

2. **At create-group time, if the observer crashes seconds after spawn (before `system.init` lands), `cliSessionId` is undefined on the launcher record.** The coordinator already wrote `record.observer.sessionId` into its map — the next `applyEvent("half_died","observer")` flips group to `degraded`, and any auto-respawn (when wired) would try `--resume <something>`. Without `cliSessionId`, the launcher's existing logic (cli-launcher.ts:550–552) correctly emits NO `--resume` flag — but if the coordinator caches and forwards `record.observer.sessionId` thinking it's a resume token, the CLI subprocess receives `--resume <companion-uuid>`, the CLI rejects it, exits in `<5s`, and the relaunch counter (`MAX_AUTO_RELAUNCHES = 3`, orchestrator.ts:29) is exhausted via Principle 5's "retry-on-resume-failure infinite loop" — except in 3 attempts rather than infinite, which is still wrong because the cause is misuse, not a real failure.

The smell: there is exactly one string slot for "the observer's ID" at the coordinator layer, and the type system permits it to be used both as the routing key (Companion ID, never resume) and as a resume token (CLI ID, never routing). Per Carmack: *"Make data flow visible and explicit."*

**Concrete fix shape:**
- Differentiate at the type level. `GroupMember { sessionId; backendType; cliSessionId?: string }` and explicit accessor that reads from the launcher's live record. Or simply make the coordinator never own a resume token — when it needs to relaunch a half, dispatch through `SessionOrchestrator.relaunchSession()` and let the launcher pull `cliSessionId` from its persisted state (which is the only place that distinction is authoritative).
- Rename `primarySessionId` in `relaunch_observer` to make it explicit that this is the Companion routing ID (not a resume token). Bonus: add a test that proves the observer relaunch path does NOT pass the Companion UUID to `--resume`.

---

## P2 — Fix Soon

### P2-SP-4. Reconnect-grace is per-session, not per-group — split-brain is the default after server restart

**File:** `/root/aura-companion/web/server/group-reconciliation.ts:39-64` (`decideReconciliation`)
**Cross-ref:** `/root/aura-companion/web/server/session-orchestrator.ts:926-939` (`startReconnectionWatchdog`, `RECONNECT_GRACE_MS = 30000`), cli-launcher.ts:250-261 (per-session `process.kill(pid, 0)` check)

**Concrete process-state failure.** Per the brief: *"reconnect-grace coherence across both halves (both reconnect OR both exceed grace — not split-brain)."* The current restart flow:

1. `CliLauncher.restoreFromDisk()` (cli-launcher.ts:226-284) checks each session's PID independently via `process.kill(pid, 0)`. If primary's PID lives and observer's does not, primary becomes `starting`, observer becomes `exited`.
2. `startReconnectionWatchdog` (orchestrator.ts:926) waits 30 s on a SINGLE timer over ALL `starting` sessions. After 30 s, every still-`starting` session is relaunched independently.
3. `decideReconciliation` is supposed to be the brain — but it accepts only `aliveByPid: boolean` per half (group-reconciliation.ts:10-14). There is no time-window concept. The four-state decision happens in one snapshot.

So at server start at t=0 the system has 100ms of "neither PID is settled" before either process has rebound its WS. If the watcher/coordinator calls `decideReconciliation(state)` with both `aliveByPid=true` at t=200ms, but at t=15s the observer's WebSocket has still not reconnected (CLI proc alive but hung pre-handshake), the policy returns `resume_pair` — and nothing in the four branches handles "observer alive by PID but never reconnects within grace." That case devolves to the orchestrator's per-session relaunch watchdog firing on the observer at t=30s — at which point the coordinator's status is still `active` (no event was applied), and the observer relaunches behind the coordinator's back, leaving the new observer PID disconnected from the GroupRecord.

The other direction: primary's PID is dead at the t=200ms snapshot but the kernel was just slow to reap and the WS reconnect was about to land — the decision returns `relaunch_observer`, but actually both halves are about to come back up. Now you have an unwanted re-spawn racing the surviving primary.

The data shape needs to either (a) accept a single time-window-after-restart input ("both alive AND both reconnected within W ms"), or (b) be invoked from a coordinator-owned watchdog that AWAITS reconnect-or-grace-expiry per half before calling `decideReconciliation`. Right now neither is true — the function shape implicitly assumes the caller solved the timing already, but the caller is not in this batch (no integration site).

**Concrete fix shape:** Add a `RestartState` field per half — `reconnectedWithinGraceMs: boolean | undefined` distinct from `aliveByPid`. Promote the four-state decision to five or six states (e.g. `primary_pid_alive_no_ws_yet → wait_or_kill` is its own branch). Add a test for the explicit "alive by PID but did not reconnect within grace" case.

---

### P2-SP-5. No per-half relaunch budget bulkhead — observer crash loop drains orchestrator's `MAX_AUTO_RELAUNCHES`

**File:** `/root/aura-companion/web/server/session-group-coordinator.ts` (no budget concept), `/root/aura-companion/web/server/session-orchestrator.ts:29` (`MAX_AUTO_RELAUNCHES = 3`), `:801-812` (counter exhaustion logic)
**Cross-ref:** brief: *"per-session relaunch budgets (bulkhead — observer crashes must not drain orchestrator's budget; emit typed `group:degraded` event on budget exhaustion not silently)"*

**Concrete process-state failure.** The existing orchestrator keeps `autoRelaunchCounts: Map<sessionId, number>`. Per-half this is already bulkheaded — observer crashes consume the *observer's* slot, primary crashes consume the *primary's* slot. So far so good.

But there are three concrete gaps in the council-mode layer:

1. **No event emission on exhaustion.** When the observer hits 3 retries (orchestrator.ts:802-812), the launcher broadcasts `{type:"error"}` to that session's browser sockets. It does NOT emit any group-level event. The coordinator's `applyEvent("half_died","observer")` only ever fires from the immediate exit; there is no `applyEvent` call when retries-have-been-exhausted. The group sits in `degraded` (best case) or `active` (if the half-died event has been clobbered by a successful relaunch that then crashed) and the user never learns that the observer half is permanently gone until they open that specific session's chat. The brief explicitly calls this out: *"emit typed `group:degraded` event on budget exhaustion not silently."* Today: silent.

2. **No `group:relaunch-needed` debouncing across the pair.** The `session:relaunch-needed` event is per session (orchestrator.ts:205). If a browser is open on the orchestrator chat and the observer crashes, only the observer's count moves — but if a browser is opened on EITHER chat, both halves' `handleAutoRelaunch` paths run independently. There is no group-level "both browsers attached → both halves alive" idempotency. A user toggling between the two chats can spin both counts.

3. **No bulkhead for the FAILURE MODE of the pair-spawn rollback.** `SessionGroupCoordinator.createGroup` (line 88-131) rolls back the primary if observer-spawn fails — but if `this.deps.kill(primarySpawn.sessionId)` throws (line 124), it's swallowed. The primary survives as a Companion session with `sessionGroupId` set but no observer mate. There is no second-attempt cleanup, no event emission. The orphan primary lives forever or until idle-kill.

**Concrete fix shape:** Introduce `groupRelaunchBudgets: Map<groupId, {primary:number, observer:number}>` owned by the coordinator. On `session:exited` for a half, increment that half's count. On exhaustion, emit `group:degraded` via `companionBus`. On `createGroup` rollback failure, push the primary into `intentionalKills` and emit `group:create-failed` with the orphan ID so an out-of-band reaper can finish the job.

---

### P2-SP-6. `archive_dead` and `mark_orphan` write tombstone but do NOT seal the surviving subprocess — observer-only-alive case leaves a running CLI uncoordinated

**File:** `/root/aura-companion/web/server/group-reconciliation.ts:39-64`
**Cross-ref:** `/root/aura-companion/web/server/group-reconciliation.ts:77-88` (`writeArchiveTombstone`)

**Concrete process-state failure.** In `mark_orphan` (only-observer-alive), the decision is described as "refuse auto-promotion; surface to the user." But the *function returns a value* — it does not act. The caller (not in this batch) is expected to do the right thing, but there is no policy stating that the still-alive observer process MUST be either (a) killed because there's no orchestrator to drive it, or (b) preserved with explicit `intentionalKills` so an unrelated keepalive doesn't try to "fix" it.

Symmetrically for `archive_dead`: `writeArchiveTombstone` writes `.council/ARCHIVED` — but if one of the halves has been resurrected by the OS or by a slow `docker exec -d` (cli-launcher.ts:777, container WS mode) between the alive-check and the tombstone write, the tombstone is now lying about reality. There is no atomic "kill both → confirm dead → write tombstone" sequence in this module — and the function is `void`-returning, so the caller can't even tell whether the kill completed before the tombstone was inked.

Per quality-subprocess Principle 7 (zombie reaping): an unattached observer that survives a `mark_orphan` decision is exactly the "subprocess holding a 64KB pipe" scenario the doc warns about — it has no one reading its stdio (the coordinator's reference dropped at archive), but it also wasn't `proc.kill`-ed.

**Concrete fix shape:**
- Change `decideReconciliation` to return actions that include `sealAlive: SessionId[]` and `tombstone: boolean`. Make tombstone-write a post-condition of an actual `kill` having resolved, not a precondition.
- Add a test for "observer alive at decision time but coordinator decided mark_orphan" — assert that the *next* reconciliation call (idempotent re-run) discovers the still-alive observer and either re-seals it or returns a richer "stuck orphan" action.

---

### P2-SP-7. Coordinator's `archiveGroup` does not stop the recording for either half — recordings stay open past subprocess death

**File:** `/root/aura-companion/web/server/session-group-coordinator.ts:148-164`
**Cross-ref:** `/root/aura-companion/web/server/cli-launcher.ts:619-637` (process exit handler does NOT close recorder), `/root/aura-companion/web/server/recorder.ts:259, 303` (recorder.close exists; no listener wires it to `session:exited`)
**Brief:** *"recording-lifecycle coupling for paired sessions (both halves' recordings)."*

**Concrete process-state failure.** Per quality-subprocess Principle 8: *"The `exit` handler must close the recording (fsync + close the FD)."* The launcher's `proc.exited.then` (cli-launcher.ts:619-637, 922-950, 1119-1129) updates state, deletes the proc, persists, emits `session:exited` — but does NOT invoke `this.recorder?.close(sessionId)` (or whatever the manager surface is). Grep for `recorder.close` finds it only in `recorder.ts` itself; nothing else calls it on subprocess exit.

For paired sessions this matters double: when the coordinator calls `archiveGroup`, BOTH halves' recordings are still open. The current rotation manager (per memory of the architecture from CLAUDE.md) caps at 1M lines globally — two un-closed paired-session recordings can each be accumulating after the subprocess is gone (any `recorder.record(...)` call from a delayed adapter teardown writes after exit). Worse, an `archiveGroup` that succeeds (status `archived`) leaves no explicit signal "stop recording for both halves now" — the recorder has no group concept.

The coordinator should either (a) take an injected `RecorderManager` and call `disableForSession` for both halves in `archiveGroup`, or (b) emit `group:archived { primaryId, observerId }` and have the recorder subscribe. Right now neither exists; the seam is open.

**Concrete fix shape:**
- Add `recorder: { disableForSession(id: string): void }` to `SessionGroupCoordinatorDeps` and call it for both halves at the top of `archiveGroup` (before the kills, since the kills themselves emit `session:exited` which is the OTHER place this should be wired but isn't).
- Independently: add a `companionBus.on("session:exited", ...)` in `recorder.ts` that closes the file. That fix is broader than this scope — flag it here as the upstream of the council-mode-specific gap.

---

## P3 — Consider

### P3-SP-8. `backend-provider`'s `SUPPORTED_PAIRINGS` allow-list does not include backend-availability gating — claude+codex spawns can fail late

**File:** `/root/aura-companion/web/server/backend-provider.ts:44-51`
**Cross-ref:** `/root/aura-companion/web/server/cli-launcher.ts:701-713, 982-993` (binary-resolution failure path — sets `state="exited"`, `exitCode=127`, returns)

**Concrete process-state consequence.** `isSupportedPairing("claude","codex")` returns `true` unconditionally — but on a host with no `codex` binary, the observer spawn fails *inside* the launcher, returning a session in `state="exited", exitCode=127`. The coordinator's rollback path (`session-group-coordinator.ts:120-129`) catches this if the launcher *throws*; it does NOT catch the case where the launcher silently records the failure and returns. Looking at `spawnCodex` / `spawnCodexWs` (cli-launcher.ts:683-690, 696-712), the failure path is to mutate `info` and return — the returned `SdkSessionInfo` looks structurally like a successful spawn from the caller's perspective. `SessionSpawner` returns `{sessionId}` — there is no way for the coordinator to detect a state-poisoned spawn.

The `SUPPORTED_PAIRINGS` list is a static manifest; the live capability check would be `resolveBinary("codex")` ahead of time. Not a P1/P2 because the failure is loud-enough at session creation (the orchestrator sees `state="exited"`), but the user-facing message will be "unsupported pairing" or a generic spawn error, not "codex is not installed."

**Concrete fix shape:** Add `isPairingAvailable(primary, observer): boolean` that calls `resolveBinary` for each. Use it at the REST handler (Hunt's lane on the actual route — but the predicate belongs here). Tests for the case where the binary is absent. Low priority because the failure mode is loud, not silent.

---

## Notes on what was NOT flagged (stayed in lane)

- **Spawn injection of user-controlled fields** (e.g. `cwd`, `model`, branch names): Hunt's lane. Cross-referenced for context — branch validation at orchestrator.ts:323-325 already exists; the pairing argv path doesn't add new user-controlled fields.
- **Hono handler shape** (REST routes for create-group / archive-group): Backend/Bun-Hono lane. The coordinator is decoupled by injection; route wiring isn't in this batch.
- **Atomic write fsync semantics** for the tombstone: FS-JSON lane. P2-SP-6 only flags the *sequencing* of write-vs-kill, not the durability of the file itself.
- **The Codex JSON-RPC envelope parsing**, the FS watcher debounce, the group-state-machine purity: out of subprocess lane (Realtime/NDJSON, FS-JSON, Fowler).
- **`detached: true` on spawn** (quality-subprocess Principle 3): verified absent on all four spawn sites (cli-launcher.ts:604, 828, 856, 1068). Good.
- **SIGKILL-only termination** (Principle 3): verified `kill("SIGTERM")` first with 5s timeout to SIGKILL at cli-launcher.ts:1171-1182. Good.

---

Findings written to subprocess.md — 8 findings (3 × P1, 4 × P2, 1 × P3).
