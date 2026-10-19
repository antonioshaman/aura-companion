# Claude CLI stdout stalls: server or CLI? (P7/SERVER-STDOUT-STALL, 2026-10-02)

Follow-up to [silent-stdio-drift-kills-2026-10.md](silent-stdio-drift-kills-2026-10.md). That note found 52 **real** stdout stalls (2026-09-28 → 10-02): the CLI kept writing model output to its jsonl, and bun received nothing. 23 of them overlapped a stall in another session, which raised the suspicion of a server-side cause: a blocked bun event loop, memory pressure, or a broken stdout pump. This note checks that suspicion against the data and adds the instrumentation needed to settle it.

## Data

- Journal: `journalctl -u aura-companion.service` (read-only), `silent_stdio_drift.detected` and `[diagnostics] Runtime snapshot`.
- Protocol recordings: `~/.companion/recordings`, copied to `$WORK/drift/rec-all`, plus the earlier copy in `$WORK/drift/rec`. Recordings cover 38 of the 52 stalls.
- Scripts in `$WORK/drift/`: `crosssession.py`, `stall_vs_mcp.py`, `mcp_status_corr.py`, `cmd_lifecycle.py`.

The stall window for a session is [its last inbound CLI frame, detection time]. When no recording exists, the window starts at the first jsonl write after bun's last frame.

## Findings

### 1. The bun event loop was not blocked during the stalls

| Check | Result |
|---|---|
| Other Claude CLIs' stdout frames received by bun **inside** the stall window | 21 of 52 stalls. Up to 12 877 frames from other sessions in one window. In the other 31 there was simply no other active Claude session. |
| Same check, clustered stalls only (≥ 2 sessions within 180 s, 24 by this onset definition) | 12 of 24 had other CLIs streaming normally at the same time. |
| 2026-10-01 23:35 cluster (3 sessions) | The journal shows bun processing Codex frames, the observer wake and the relaunch logic second by second throughout the window. |
| `Runtime snapshot` (5-minute timer) in the cluster windows | Fires on schedule ±0 s. RSS 100–360 MB, heap ≤ 130 MB. |

A blocked loop starves every pipe at once. Here one CLI went quiet while bun kept reading its neighbours. That rules out a ≥ 90 s loop block for 21 stalls and gives no evidence of one for the rest. Short blocks (≤ a few s) are not measurable from this data. The lag detector below closes that gap.

### 2. `mcp_status` is a consequence, not the cause

In the recordings, 72 of 311 `control_request mcp_status` never got a `control_response`. Every unanswered one was sent to a CLI that was already silent: the browser sends `mcp_get_status` on page load, and users reload a page that looks stuck. Per stall: 17 had no `mcp_status` at all, 17 got the first one later than 15 s into the silence, and 4 within 15 s. A request sent mid-turn is normally answered in under 1 s (60 cases).

The fact that the CLI also stops answering control requests is consistent with its whole stdout channel being stuck, not just one message type.

### 3. A deterministic CLI-side pattern: scheduled commands that never print

The CLI emits `command_lifecycle {state: "started"}` when it starts an internal command (scheduled prompts: cron, `/loop`, ScheduleWakeup). In 40 of 53 such starts, `system:init` and the streamed turn follow within a second. In **9**, nothing else reaches stdout after `started`, sometimes for 2 hours, while the jsonl shows the turn running. These 9 account for 9 of the 52 real stalls: supervisor session ×8 (its 2-hour `:25` schedule), f54068e9 ×1. Nothing in bun differs between the 40 and the 9.

### 4. What remains unexplained

The other ~43 stalls happen mid-turn (after `system:init`, `thinking_tokens`, or `content_block_delta`), with the API clearly answering: assistant records keep landing in the jsonl. Some cluster across sessions. One cluster (2026-09-30 06:21–06:23) coincides with the bench OAuth incident fixed in FIX-D2-CLAUDE-AUTH. All sessions ran the same CLI 2.1.283, with no update during the window.

Hypotheses, in order of fit:

1. **Inside the CLI:** the stdout writer stalls while the transcript writer continues. Fits the per-session silence with a healthy bun, the unanswered control requests, and pattern 3. A shared upstream trigger such as an auth refresh or an API stream hiccup would explain the clusters.
2. **bun's per-pipe reader** (`ReadableStream` over the child's stdout) stops delivering for one child. This would also look per-session. It cannot be told apart from (1) with the current logs.
3. **Event-loop block / memory pressure:** contradicted by finding 1 for long blocks; short blocks are still unmeasured.

## Instrumentation added (this PR)

1. **`server.event_loop_lag`** (`web/server/event-loop-lag-monitor.ts`, wired in `index.ts`). A 500 ms timer measures its own drift. Lag above 1 s logs a WARN with `lagMs`, the slowest tracked synchronous operations since the previous tick (`topOperations`), `operationCount`, `untrackedMs` (lag not explained by a tracked operation, e.g. GC or cgroup throttle), `rss` and `heapUsed`. Tracked call sites:
   - CLI stdout frame handling: `cli.stdout:<sid8>`;
   - the drift-detector tick;
   - `session-store.save` (fsync'd atomic write of the full message history);
   - the 5-minute diagnostics tick.
2. **`cliWaitChannels`** on `silent_stdio_drift.detected` (`web/server/process-wait-channels.ts`). Kernel wait channels of the CLI's threads, read from `/proc/<pid>/task/*/wchan` just before the kill, e.g. `futex_wait_queue×9, ep_poll×1, running×1`.
   - A thread in **`pipe_write`** means the pipe is full and bun stopped reading it (hypothesis 2 or 3).
   - **No `pipe_write`** means the CLI itself stopped writing (hypothesis 1).

## How to read the next stalls

```bash
journalctl -u aura-companion.service --since today | grep -E 'event=(server.event_loop_lag|silent_stdio_drift.detected)'
```

- `silent_stdio_drift.detected` without `pipe_write` and without a nearby `server.event_loop_lag` → CLI-side. The next step is a minimal repro and an upstream report to Claude Code (scheduled-command case first: it is deterministic).
- `pipe_write` without a lag → bun's per-pipe reader. Next step: a reader-restart experiment in `pumpStdoutLines`.
- `server.event_loop_lag` around the stall onset → `topOperations` / `untrackedMs` name the culprit, and the sync call moves off the hot path.

No behaviour change. The drift detector still kills and relaunches stalled sessions as before.

## Update 2026-10-18 — what the next stalls showed, and the mitigation

Six drift kills of one working session in a day (af80e149: 03:42, 03:55, 04:14, 04:32, 10:49, 10:51); 7 across 4 sessions. Protocol recordings confirm every one was a real stall: zero `in cli` frames in the window while the jsonl gained thinking/text/tool_use/tool_result records. No `server.event_loop_lag` at any onset (the four lag lines of the day are all spawn-time, ~3 s).

- **`pipe_write` is not a usable tell on this box.** Bun spawns the CLI's stdio as Unix **socketpairs** (`/proc/<cli>/fd/1 -> socket:[…]`), not pipes; a writer blocked on a full socket does not park in `pipe_write`. A 5 s sampler of `ss -xpe` queues (`/tmp/stdio-queue-monitor.sh`) ran across the 04:32 and 10:49 stalls and saw **no unread bytes** on the CLI→bun socket — kernel-side, the CLI was not writing to stdout while it kept writing its jsonl. Whether the `write(1)` calls stop or Bun's native reader drains them into a buffer the JS pull never sees is decided by `strace -e trace=write` on the CLI (`/tmp/cli-stdout-strace.sh`, follows the pid across relaunches, fd 1 lines in `/tmp/cli-stdout-strace.log.fd1`).
- **Upstream knows the symptom.** claude-code [#39700](https://github.com/anthropics/claude-code/issues/39700) ("`--output-format stream-json` intermittently hangs — process stops producing output and never exits", non-TTY only, closed *not planned*) and [#17248](https://github.com/anthropics/claude-code/issues/17248) ("stdout under stream-json stops while session continues", closed as duplicate). The workaround those threads converge on is exactly this detector: watch the transcript, force-kill, resume.
- **Mitigation shipped here: the kill waits for the running tool call.** Every one of the six kills landed while the main thread was inside a Bash call (the command died with exit 137 and the resumed CLI had to redo it). `mainThreadOpenToolCallStartedAt` reads the jsonl tail; if the chain ends in a `tool_use` younger than `SUBAGENT_OPEN_TOOL_CALL_CEILING_MS`, `decideDriftKill` returns `withhold_open_tool_call` (logged + one browser notice per stall). The deferral covers exactly that one call: once its `tool_result` lands — or a *different* call opens, which proves it completed — the next tick kills and `--resume`s, and `deliverStalledReply` hands the records written meanwhile to the browser. A call older than the ceiling never defers.

### 2026-10-18 18:16 — settled: the stall is on bun's side

strace attached to the CLI's own threads (no `-f`; stdout is written through **fd 7**, a dup of fd 1 on 2.1.283) across the 18:07:50–18:16:04 stall of session af80e149:

| | |
|---|---|
| CLI `write(7, …)` calls in the window | 1 579, all returned their full length, 674 KB total |
| `in cli` frames in bun's recording in the window | 0 (last frame 18:07:54) |
| Unix-socket Recv-Q/Send-Q on the CLI↔bun pair (5 s samples) | 0 throughout |

The CLI wrote; the kernel delivered (queues empty); JS never saw the bytes. That leaves Bun's native stdout reader (`Bun.spawn` → `ReadableStream` over a socketpair, Bun 1.3.11) drained-but-not-surfaced: `reader.read()` in `pumpStdoutLines` stops resolving. Upstream claude-code #39700 / #17248 saw the same picture from the consumer side.

Also seen: the recovery rate guard (3 per 30 min) left the session dead from 18:08:04 to 18:16:04, then the kill hit four parallel tool calls at once — the open-call check only looked at the last record. Fixed by counting unanswered `tool_use` ids (bounded by the oldest).

Next: a reader-restart experiment (release the lock and re-acquire a reader on drift, before the kill) and a Bun upgrade trial on a non-prod checkout. Both need the owner's go.
