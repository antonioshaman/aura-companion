# Subprocess Lifecycle — Council Review 2026-05-11-2251

Reviewer: Subprocess Lifecycle Expert (Carmack × systemd/Erlang-OTP)
Scope: cli-launcher.ts (observer-role spawn + prompt loading + SdkSessionInfo extensions); session-orchestrator.ts (createCouncilGroup + watcher lifecycle + handlers + group bus listeners); group-shutdown.ts; preflight-probe.ts.

Conventions honoured (NOT re-flagged): AP-1..3, EC-1..9.

---

## P1 — Fix Now

### S1. Observer prompt is lost on auto-relaunch — observer becomes "undirected" after the first crash
**File:** `web/server/cli-launcher.ts:374-487` (relaunch path) vs `:586-601` (observer prompt load).
**Problem:** `spawnCLI` only injects `--append-system-prompt` when `options.sessionGroupRole === "observer"` (line 586). On the initial spawn the orchestrator passes that field through `LaunchOptions`. But `CliLauncher.relaunch()` (line 475-484) reconstructs the options object from `info` and explicitly omits `sessionGroupRole`. The persisted `info.sessionGroupRole` is set (line 337) and survives `restoreFromDisk`, but it is never read back into the relaunch options. Net effect: after the auto-relaunch loop (`MAX_AUTO_RELAUNCHES = 3` in session-orchestrator) or after the reconnection-watchdog relaunch (line 1293), the observer subprocess restarts as a plain unrole-d Claude/Codex session with `--resume <cliSessionId>` but no observer system prompt. The model will still emit messages, but it has no instruction to scope its work to `.council/checkpoints/`, no instruction to write a single review JSON, no STOP-grounding constraint — producing arbitrary chat content into a session the bridge still routes as "observer". This silently violates the project's own invariant ("Observer prompt-at-spawn is hard-fail" in context-brief.md) on every relaunch.
**Severity reasoning:** Principle 1 (spawn argv discipline) and Principle 5 (`--resume` state drift). The whole point of the loud-fail on missing prompt is to make "undirected observer" impossible — the relaunch path breaks that contract.
**Fix:** In `relaunch()`, pass `sessionGroupRole: info.sessionGroupRole` (and `sessionGroupId: info.sessionGroupId`) into the `spawnCLI` options. If the prompt load now throws, surface the throw and treat the observer half as unrecoverable so the coordinator can degrade the group rather than running a directionless model.

### S2. Watcher AbortController is never released on observer-side subprocess exit (only on group:exited)
**File:** `web/server/session-orchestrator.ts:351-353, 412-417, 215-240`.
**Problem:** `stopCouncilWatchers` is called only from the `group:exited` bus listener. `group:exited` is emitted by the coordinator's `archiveGroup` or by an explicit group teardown — NOT by `session:exited` on either individual half. If the observer subprocess dies and `MAX_AUTO_RELAUNCHES` is exhausted (handleAutoRelaunch → relaunchExhaustedNotified), the orchestrator-half is still alive, the coordinator's `archiveGroup` is never called, and `group:exited` never fires. The checkpoint + review watchers keep running with their AbortController unaborted, the `lastCheckpoint` map entry keeps growing, and any subsequent checkpoint file written by the still-alive orchestrator triggers a `handleCouncilCheckpoint → group:checkpoint` fanout to a `broadcastToGroup([primaryId, observerId], …)` call where observerId points to an exited session. Worse, if the observer half later relaunches under a *new* cliSessionId (resume failure → fresh start), reviews land on the still-running watcher and are emitted with the stale `lastCheckpoint`. The cleanup is bus-event-coupled to a transition that the failure mode never produces.
**Severity reasoning:** Principle 7 (resource lifecycle visibility). The watcher + manifest is a leaked resource keyed off a dead pair half. Equivalent to "exit handler that omits user-visible cleanup" — the council UI keeps surfacing findings against a group whose observer has been dead since attempt 3.
**Fix:** Subscribe to `session:exited` in `initialize`; when the exiting session has `sessionGroupRole === "observer"` AND auto-relaunch is exhausted (or after a configurable grace), call `coordinator.applyEvent(groupId, { type: "observer_dead" })` or directly call `stopCouncilWatchers(groupId)`. Drive `group:exited` from the orchestrator side rather than relying on coordinator's archiveGroup as the only emitter.

### S3. `--append-system-prompt $body` argv injection — the prompt body is unbounded multi-line text with no argv-byte validation
**File:** `web/server/cli-launcher.ts:586-601`; `web/server/observer-prompt.ts:75-124`.
**Problem:** The body is loaded straight from `.council/prompts/observer-system.md` (currently 5751 bytes; the loader caps at 64 KiB). It is then pushed verbatim into the argv array as the next token after `--append-system-prompt`. Bun.spawn → execve(2) carries argv as NUL-terminated C strings; the loader rejects NUL bytes (good), but does NOT reject:
- Embedded newlines (the body is intentionally multi-line markdown — a newline inside an argv element is legal at the kernel level, but the CLI's flag parser may interpret it as a line-break in interactive mode or in some shell wrappers).
- The argument size: Linux's `ARG_MAX` is typically 128 KiB total across all argv+envp, but per-argument no fixed cap is documented. Bun copies the array into a contiguous execve buffer; combined with the inherited env (which can be megabytes if the user has lots of secrets), a 64 KiB prompt could push the spawn over `MAX_ARG_STRLEN` (typically 32 pages = 131072 bytes on Linux) and produce `E2BIG`. The current loader cap (64 KiB) is bigger than the typical per-arg limit and there is no compensating check at spawn time.
- Bytes that look like option prefixes (`--evil-flag`) inside the prompt body — these are safe in this case because they are the VALUE of `--append-system-prompt`, not a separate argv token, but only because Bun is invoked with `shell: false` (line 659). If a future refactor ever flows this body through `bash -lc` (the containerized path at line 633 already does string interpolation via single-quote escaping), the embedded quotes/backticks inside the body become a code-injection surface.
**Severity reasoning:** Principle 1 (spawn argv validation). The mechanism works today only because (a) host-mode spawn is shell-false and (b) the prompt file happens to be ≤6 KiB. Both invariants are fragile and undefended.
**Fix:** Add `OBSERVER_PROMPT_MAX_ARGV_BYTES = 32_000` (under `MAX_ARG_STRLEN` with headroom) to observer-prompt.ts and reject larger bodies at load. Reject ASCII control bytes other than `\n`/`\r`/`\t` in the body (single-byte filter). Document that the body MUST NOT flow through any shell-true path; add a runtime guard in the containerized branch (which today builds an `innerCmd` via single-quote escaping — that escaping is safe for `'` but not for `$`'s inside `bash -lc` if the prompt ever uses heredoc-like content; force `--append-system-prompt-file` over passing the body inline for container sessions, OR mount the prompt into the container and pass the path).

### S4. Watcher startup is fire-and-forget through a lazy dynamic import; createCouncilGroup returns success before watchers are actually attached
**File:** `web/server/session-orchestrator.ts:371-410, 587-593`.
**Problem:** `startCouncilWatchers` does `import("node:path").then(({ join }) => { watchCheckpoints({...}).catch(...); watchReviews({...}).catch(...); })`. The outer `then` is not awaited. `createCouncilGroup` calls `startCouncilWatchers(...)` then immediately emits `group:created` and returns `{ok:true}` to the caller. If `watchCheckpoints` rejects synchronously (e.g. `.council/checkpoints/` does not exist and `fs.watch` throws on missing directory — which the comment on line 384 explicitly acknowledges as "the directory may not exist yet when the pair spawns — that's OK"), the `.catch` handler logs a warning and the watcher is silently absent for the entire lifetime of the group. Subsequent checkpoint writes by the orchestrator land into an unwatched directory; the observer side may emit reviews into an unwatched reviews directory; the UI sees zero findings forever and the user has no signal that the pipeline is broken.
**Severity reasoning:** Principle 4 (silent failure on subsystem exhaustion). The orchestrator returns "council group active" while its sole signal pathway is dead. Equivalent to "silent retry exhaustion" — the user sees a stuck "observing" forever.
**Fix:** Create the two `.council/checkpoints/` and `.council/reviews/` directories with `mkdirSync(..., { recursive: true })` BEFORE constructing the watcher promises, so `fs.watch` cannot throw on a missing directory. If the watcher promise rejects for any other reason, transition the group to `degraded` via `coordinator.applyEvent(groupId, { type: "watcher_failed" })` and broadcast `group_degraded` to the browser so the user sees the failure instead of an indefinite "sleeping" state.

---

## P2 — Fix Soon

### S5. `group-shutdown.ts` does not abort the council watchers — only archives the groups
**File:** `web/server/group-shutdown.ts:34-86`; cross-ref `session-orchestrator.ts:351-353`.
**Problem:** `shutdownAllGroups` races each `coordinator.archiveGroup(groupId)` against a shared timeout sentinel. `archiveGroup` kills both halves' subprocesses and walks the state machine, but neither it nor the shutdown wrapper invokes `stopCouncilWatchers`. The watchers tear down only when `group:exited` is emitted on the bus — which, in the shutdown path, happens only if a separate listener fans `archiveGroup`'s state transition into a `group:exited` event. Looking at the orchestrator: `group:exited` listeners exist (line 295 + 351) but there is no emitter from inside `archiveGroup`. So during SIGTERM-driven shutdown the kill calls execute, the process exits SIGKILL-fallback runs (cli-launcher line 1236), but the `fs.watch` async iterator inside `watchCheckpoints`/`watchReviews` is still suspended on `for await (const ev of watch(...))`. The event loop has these as live references; if the server's process.exit happens before Bun GCs them, you get a graceful shutdown that takes 30s waiting for filesystem activity that never comes. If shutdown timing is short (`opts.timeoutMs` default 5-10s), watchers leak to the next process restart's stale state.
**Severity reasoning:** Principle 3 (signal propagation). Server SIGTERM fans out to subprocesses correctly but not to internal supervisory loops.
**Fix:** Either expose `SessionOrchestrator.stopAllCouncilWatchers()` and call it from the shutdown hook before `shutdownAllGroups`, OR have `archiveGroup` emit `group:exited` so the existing `stopCouncilWatchers` listener fires. Verify shutdown completion test asserts the watcher promise has actually resolved (await the returned promise from watchCheckpoints, not just the kill calls).

### S6. Preflight probe has no per-probe timeout — a hung `--version` blocks the UI's pairing dropdown indefinitely
**File:** `web/server/preflight-probe.ts:59-101`.
**Problem:** `probeBinary` awaits `runner(binary, ["--version"])` with no timeout. The injected `ProbeRunner`'s real wiring (described in the docstring as "Bun.spawn against `which <binary>` + `<binary> --version`") is the caller's responsibility — but the contract does not require a timeout. If `codex --version` hangs (e.g. a corrupted install that opens a network call on startup, or an unauthenticated binary that prompts for OAuth on stderr), `Promise.all` at line 92 never resolves and the council toggle button stays in "probing…" state forever. There is also no max-cardinality guard on stdout/stderr — the comment at line 23 ("bounded so a hostile binary cannot exhaust memory") delegates the bounding to the runner without enforcing it at the pure layer.
**Severity reasoning:** Principle 6 (idle-kill race), applied here to capability detection. A "probe that lies" by hanging is observationally identical to a probe that says "unavailable" but the UI cannot distinguish.
**Fix:** Add a `timeoutMs` field to `ProbeRunResult`/`ProbeRunner` contract, default 5000ms, and have `probeBinary` reject with `available: false, reason: "probe timed out"` if the runner does not resolve within the budget. Document the stdout/stderr length cap as an enforced contract at the pure-module boundary (e.g. truncate to `MAX_VERSION_LINE_LEN * 4`) rather than trust the runner.

### S7. Recording lifecycle is per-session, but observer-prompt SHA is captured only on initial spawn — never written to the recording header
**File:** `web/server/cli-launcher.ts:592` (`info.observerPromptSha256 = artifact.sha256;`); cross-ref `recorder.ts` (not in scope but referenced).
**Problem:** The SHA is stored on `SdkSessionInfo` and persisted via `saveLauncher`. But the recording file header (per CLAUDE.md: "First line is a header with session metadata") is opened when the CLI WebSocket connects, which happens AFTER `spawnCLI` returns. The recorder pulls metadata from somewhere (the bridge / session info) at that point — if the recorder snapshots metadata before the `system.init` round-trip, the SHA is there. If it snapshots after, the SHA is still there because it was set at spawn-options time. BUT: on auto-relaunch (see S1), the observer prompt is not re-loaded, the SHA on the existing info is stale, and the new recording file (one per CLI subprocess instance per Principle 8) is opened referencing a SHA whose body the model never received. Forensic replay later will reconstruct "model saw prompt SHA X" while the actual argv contained no prompt at all.
**Severity reasoning:** Principle 8 (recordings tied to lifecycle). The recording's metadata header is supposed to make the model's input space reconstructable; the staleness defeats that.
**Fix:** Tied to S1 — when the relaunch path re-loads the prompt, re-compute the SHA and persist before the new recording header is written. If the prompt is intentionally not re-loaded on relaunch, clear `info.observerPromptSha256` on `relaunch()` to preserve the invariant "SHA present iff body was injected this spawn".

### S8. Idle-kill timer fires on observer half exactly the same as the orchestrator — observer that's "sleeping until checkpoint" looks identical to "idle 24h"
**File:** `web/server/ws-bridge.ts:1043-1095`; `session-orchestrator.ts:255-268`.
**Problem:** `IDLE_KILL_THRESHOLD_MS` is 24h (configurable). The watchdog starts on `browserSockets.size === 0` and fires when `Date.now() - lastCliActivityTs > threshold`. For the observer half, there is by design no CLI activity between checkpoints — the observer is supposed to sleep until a checkpoint sentinel wakes it. If the orchestrator works for 25h without writing a checkpoint (e.g. user is debugging a slow feature; checkpoint cadence is per-phase, not per-hour), the observer's `lastCliActivityTs` has not advanced since spawn. With no browser attached to the observer side (the UI usually shows the orchestrator view; observer side may have zero browsers regardless), the idle-kill fires and the observer is killed. The orchestrator continues; the group transitions to `degraded` via the coordinator's state machine ONLY IF the kill is fanned into a state event. Looking at the orchestrator's `idle-kill` handler (line 255), it marks `intentionalKills.add(sessionId)` and calls `launcher.kill` — but it does NOT call `coordinator.applyEvent(groupId, { type: "observer_dead" })`. The group remains in "active" status while one of its halves is dead.
**Severity reasoning:** Principle 6 (idle-kill races + ambiguous activity-reset). Observer's correct "asleep" state is misclassified as "idle".
**Fix:** Either (a) suppress idle-kill entirely for sessions with `sessionGroupRole === "observer"` (rationale: the lifetime is bounded by the orchestrator's lifetime, which already has its own idle-kill); or (b) reset `lastCliActivityTs` on every observer wake (checkpoint sentinel write→observer read→write review) so the observer's "activity" includes its filesystem-driven cycles. Option (a) is simpler and matches the intent that pair halves share fate.

### S9. `createGroup` rollback kill-of-primary is awaited but not deadline-bounded — observer spawn that hangs blocks coordinator forever
**File:** `web/server/session-group-coordinator.ts:108-155`.
**Problem:** `await this.deps.spawn(...)` for the observer half has no timeout. If observer-half spawn is slow (e.g. Codex binary takes 30s to do its auth check, container startup is slow, prompt-load filesystem stat hits a stuck NFS mount), the orchestrator-half is already alive and consuming resources, and the caller's HTTP request is blocked. There is no per-spawn timeout in either the coordinator or the underlying `doCreateSession`. If the observer spawn throws (e.g. observer prompt missing — S3 path), the rollback kill DOES execute and IS awaited (line 143), which is correct. But the `await this.deps.kill(primarySpawn.sessionId)` itself has no deadline — `launcher.kill` waits up to 5s for SIGTERM then SIGKILLs (cli-launcher line 1228-1237), so worst case is bounded at 5s + the spawn-call duration. That's fine for the rollback path; the unbounded duration is on the SUCCESS path of an observer spawn that never returns.
**Severity reasoning:** Principle 4 (bounded retry) extended to bounded spawn. The single-spawn path needs its own deadline.
**Fix:** In `createCouncilGroup`, wrap both spawn calls in `Promise.race` with a `COMPANION_COUNCIL_SPAWN_TIMEOUT_MS` (default 60s). On timeout, treat as spawn failure → rollback the first half → return `{ok:false, error: "observer spawn timed out", status: 504}`.

---

## P3 — Consider

### S10. `parsePairingLabel` is duplicated inline in `createCouncilGroup` instead of importing from a single source
**File:** `web/server/session-orchestrator.ts:518-524`.
**Problem:** A string split + tuple check that parses `"claude+claude"` / `"claude+codex"`. The comment says backend-provider doesn't export it because it's "a routes-layer concern". But `createCouncilGroup` IS being called from the routes layer; this inline parser duplicates whatever the routes layer does to validate the same string. If the route handler ever accepts `"claude+codex"` with whitespace, trailing `\n`, or case variation that this parser rejects, the orchestrator and the route disagree on what a valid pairing looks like.
**Severity reasoning:** Principle 9 (consistency / future-hardening).
**Fix:** Move `parsePairingLabel` to `backend-provider.ts` as a named export alongside `isSupportedPairing`. Routes and orchestrator import the same parser.

### S11. `session:exited` listener pile in `initialize()` has subtle ordering — proactive relaunch fires before agent-executor handles exit
**File:** `web/server/session-orchestrator.ts:215-240`.
**Problem:** Four listeners are registered on `session:exited` in sequence: agent-executor handling → exit callbacks → state machine transition → `scheduleProactiveRelaunch`. Bun's `EventEmitter` runs them in registration order. The proactive relaunch fires AFTER agent-executor's handle and AFTER the state machine transitions to `terminated`. For a council observer that exits with `intentionalKills` not set (e.g. genuine crash), `scheduleProactiveRelaunch` calls into the same observer prompt code path as fresh spawn — which (per S1) does NOT re-inject the prompt. This is the immediate cause behind S1's user-visible failure mode.
**Severity reasoning:** Principle 9 (consistency). The listener ordering is not the bug, but the lack of a council-aware short-circuit on the relaunch path is.
**Fix:** Tied to S1. Once relaunch respects `sessionGroupRole`, this listener pile is fine.

### S12. `findFreePort` is reused for Codex WS but not for any council-specific port — confirm no council session needs an inbound port
**File:** `web/server/cli-launcher.ts:32-56`.
**Problem:** Sanity check, not a finding per se. Council Mode runs both halves on the same `--sdk-url`-style WS server (the existing Hono port); there is no per-pair port allocation. The Codex-WS proxy port (4500-4600 range) IS used when either half is Codex, and `claimedCodexWsPorts` is shared across all sessions, so a `claude+codex` pair correctly claims one port for the observer half. The reservation set survives across restarts via `restoreFromDisk` (line 289-296). No bug — the system holds together for the supported pairings.
**Severity reasoning:** N/A — verification only.
**Fix:** None. If a future pairing adds a second Codex (e.g. `codex+codex`), both halves would compete in the same port-range allocator, which is fine.

---

## Summary

| Severity | Count |
|----------|-------|
| P1 | 4 (S1, S2, S3, S4) |
| P2 | 5 (S5, S6, S7, S8, S9) |
| P3 | 3 (S10, S11, S12) |

The dominant theme: **the council-mode layer assumes the single-session lifecycle is council-aware on the relaunch / exit / shutdown paths, but it isn't.** Initial spawn correctly injects observer role + prompt; every subsequent process-state transition (relaunch, idle-kill, server-shutdown, exit-without-archive) drops council context on the floor. S1 is the canary — the same root cause manifests in S2 (watcher leak), S7 (recording-header staleness), S8 (idle-kill of observer), and S11 (listener ordering). Fixing the "relaunch path reads sessionGroupRole from persisted info" pattern resolves the whole cluster.

Cross-references for the Hunt + Willison + Persistence + Realtime tracks:
- S3 (argv bytes) ↔ Hunt security.md Principle 1 (spawn argv as injection surface).
- S4 (watcher silent-absent) ↔ Persistence Principle 1 (atomic writes assume a reader).
- S2 (watcher leak) ↔ Realtime Principle 7 (event-bus emitter coverage).
- S7 (recording SHA staleness) ↔ Willison's LLM-pipeline reproducibility track.
