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

**Process identity** (`process-identity.ts`) anchors on the `--sdk-url <sessionId>` argv
token for WS sessions. stdio argv carries no sessionId at all, so the spawn-time sidecar's
`argvSha256` is the equivalent anchor — without it a healthy stdio CLI reads as `mismatch`
and the orphan-reaper kills it.


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
made while another relaunch of the same session runs joins it and gets its result, so only
one CLI is spawned. A manual relaunch with a different model waits for the running one and
then relaunches. Before this, after a server restart the boot watchdog and the observer
catch-up poll both fired at ~30 s and spawned two CLIs with `--resume` on one cliSessionId.
Automatic paths also skip a session whose last successful relaunch is under 60 s old while
its new CLI is still `starting`: a Codex CLI needs ~16 s to attach, and the deaf-session check
would otherwise read it as dead. A CLI that crashed (`exited`) is relaunched as usual; a
manual relaunch always runs. The relaunch marks the session intentional only for its own
old-process kill. If archive, delete or a user kill marks it meanwhile, that mark stays, and
a process spawned for a session archived mid-relaunch is killed. The observer auto-heal
does not reset the auto-relaunch crash budget; only a manual relaunch does.
