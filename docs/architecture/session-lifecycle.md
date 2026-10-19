# Session lifecycle

> Moved out of `CLAUDE.md` in P2/A3 (2026-09-28). `CLAUDE.md` links here with one line;
> this file is loaded on demand, not on every session start.


Sessions persist to disk and survive server restarts. What happens to the *process* on
restart depends on the transport:

- **WS transport** — live CLI processes are detected by PID and given a grace period to
  reconnect their WebSocket. If they don't, they're killed and relaunched with `--resume`.
- **stdio transport (default)** — the pipes died with the previous server process, so a
  surviving PID can never talk to the new server. Boot recovery verifies identity (see
  below) and SIGTERMs it rather than leaving a session that looks alive but is deaf. The
  record keeps `cliSessionId`, so the next message relaunches with `--resume` and the
  conversation continues where it stopped.

**Boot resume (W2).** Sessions that were alive before the restart are relaunched with
`--resume` at boot, without waiting for a browser (before, a browserless orchestrator,
council pair or CLI-cron session stayed down until someone opened its tab). Graceful
shutdown first marks every live session — plus crashed ones whose keepalive relaunch was
still pending — with `resumeOnBoot` in `launcher.json`, BEFORE the council teardown kills
both halves of each pair (which persists them as `exited`). On boot, `restoreFromDisk`
collects the non-archived sessions that were non-`exited` or marked, came back `exited`,
and have a `cliSessionId`; `SessionRecovery.scheduleBootResume` relaunches them
`COMPANION_BOOT_RESUME_STAGGER_MS` (1.5 s) apart through `handleAutoRelaunch` — the same
guarded path a returning browser uses (archived / user-stopped / intentional-kill skips,
crash budget, single-flight with a concurrent browser relaunch). Sessions restored as
`starting` (WS transport) stay with the reconnection watchdog. User-stopped sessions are
never marked, so they stay down.

**Crash-loop guard.** The auto-relaunch budget lives in memory and resets per boot, so after
repeated non-graceful deaths (OOM-kill under `Restart=always`) boot resume would bring the
whole fleet back on every respawn. `boot-crash-guard.ts` keeps `boot-history.json` in the
sessions dir: graceful shutdown sets `cleanShutdown`; a boot without it is a crash boot.
Once 3 crash boots land within 10 minutes, boot resume is skipped
(`boot_resume.skipped_crash_loop`) and sessions come back when a browser opens them.
Graceful restarts (deploys) never count. A missing or corrupt file fails open.

**Process identity** (`process-identity.ts`) anchors on the `--sdk-url <sessionId>` argv
token for WS sessions. stdio argv carries no sessionId at all, so the spawn-time sidecar's
`argvSha256` is the equivalent anchor — without it a healthy stdio CLI reads as `mismatch`
and the orphan-reaper kills it.

**Orphan-reaper ownership.** A PPID=1 orphan with no known session is reaped only with proof
this server spawned it: `--sdk-url`, or (stdio Claude) an argv hash matching a runtime
sidecar. Codex `app-server` is not proof on its own (the Codex VS Code extension and the
Codex daemon run it too). A Codex orphan needs a sidecar argv-hash match (the
`node .../codex.js` wrapper the launcher spawns) or the per-session
`CODEX_HOME=<COMPANION_HOME>/codex-home/<sessionId>` in `/proc/<pid>/environ`, which the
wrapper's native child inherits. Without either it is skipped
(`orphan_reaper.skipped_unowned_codex`).


**User stop** (`POST /api/sessions/:id/kill`, the UI kill button) is not a crash. Before
any kill runs, `killSession` marks the session intentional and "stopped by user". For a
council half it marks BOTH halves and stops both (EC-2). Keepalive, `session:relaunch-needed`
(a returning browser, a transport drop) and the observer catch-up scan skip such sessions,
and the group gets no reconnect/degraded transition. The mark is cleared only by an explicit
relaunch or by a new browser-typed user message. Either one brings back the whole stopped
pair, so a later real crash is auto-relaunched again. Archive and delete drop the mark.
The mark lives in memory: after a server restart a stopped session behaves as before
(it relaunches when a browser opens it).

**One relaunch at a time** (P4/FIX-AUTOHEAL-1). Every relaunch path goes through
`SessionRecovery.relaunchOnce`: a manual relaunch (REST, the UI button), the observer
auto-heal, the auto-relaunch (keepalive, a returning browser) and the boot watchdog. A call
made by an automatic path while another relaunch of the same session runs joins it and gets
its result, so only one CLI is spawned. A manual relaunch never joins: it waits for the running
one and then spawns its own CLI, because the running one may have read the old model, env or
credentials (Settings → apply credentials; P4/FIX-AUTOHEAL-2). Before this, after a server restart the boot watchdog and the observer
catch-up poll both fired at ~30 s and spawned two CLIs with `--resume` on one cliSessionId.
Automatic paths also skip a session whose last successful relaunch is under 60 s old while
its new CLI is still `starting`: a Codex CLI needs ~16 s to attach, and the deaf-session check
would otherwise read it as dead. A CLI that crashed (`exited`) is relaunched as usual; a
manual relaunch always runs. A skipped automatic trigger re-checks the session when the
window closes: a CLI still `starting` with no adapter then goes through the auto-relaunch
(and its crash budget), so a CLI that hangs without exiting is not left alone. The relaunch marks the session intentional only for its own
old-process kill. If archive, delete or a user kill marks it meanwhile, that mark stays, and
a process spawned for a session archived mid-relaunch is killed. A Codex WS spawn that is
still picking its port when the session is killed, archived, deleted or relaunched again does
not start at all (it was not in the process table yet, so there was nothing to kill). The observer auto-heal
does not reset the auto-relaunch crash budget; only a manual relaunch does.

**Init probe (Claude only).** The Claude CLI emits `system.init` only in response to a `user`
frame, so on every CLI attach with no queued message the bridge writes a probe `user` frame
(`AURA_INIT_PROBE_MARKER`) and interrupts it 200 ms later (`sendInitializeKickoff`). The probe
and its `[Request interrupted by user]` stay in the CLI transcript, and the CLI folds the next
real prompt into the same human turn. The marker therefore must never ask the model for
silence: the old "do not respond" wording made the model answer the user's next message with
"No response requested." after reconnects (introduced in #200, fixed in #335).
`init-probe-reconnect.replay.test.ts` replays the recorded probe → interrupt → user message
sequence and pins both properties; `real-cli-reconnect.e2e.test.ts` runs the same path
against a real CLI (opt-in: `AURA_REAL_CLI_E2E=1`).

**Codex has no init probe.** The Codex app-server handshake is the JSON-RPC `initialize` /
`initialized` exchange, which needs no user turn; `sendInitializeKickoff` returns early for
any non-Claude adapter. A Codex session's first user message is sent as-is and cannot be
swallowed this way, so the `noResponseRequestedReplies` delivery metric stays 0 for Codex
unless the model says it on its own.

**Reply-delivery metrics** (`delivery-metrics.ts`; `GET /api/metrics` → `delivery`,
`GET /api/metrics/delivery`, Settings → Diagnostics → *Reply delivery*). In memory since server
start, global and per session, for both backends: time from a user message to the first
assistant output (histogram), messages with no output within `COMPANION_DELIVERY_STALL_MS`
(default 60 s), "No response requested." replies to a real user message, drift-detector
recoveries, and short RU/EN nudges ("жду", "ты тут?", "are you there?") as a proxy for "the
user felt ignored". Each also logs a structured `delivery.*` event. The drift detector is
Claude-only (Codex has no CLI jsonl to compare). Its recovery kills the whole CLI process,
including every background task it still runs (background Bash, `local_agent` subagents) —
it fires most often on CLIs running many parallel subagents. The count of such tasks, tracked
from `task_started` / `task_notification` frames, is logged with `delivery.drift_recovery`
and summed in `backgroundTasksKilled`.
