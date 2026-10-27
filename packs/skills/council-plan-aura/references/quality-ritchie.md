<!-- canonical-source: council-review-aura-v2/references/quality-ritchie.md -->
# Process Lifecycle + Filesystem Persistence Quality Reference — Carmack × Subprocess Lifecycle Expert × FS-JSON Persistence Expert

Philosophy: John Carmack. Specifics:
  - §A draws on systemd unit-file semantics, Erlang/OTP supervisor philosophy ("let it crash"), and Node `child_process` / Bun `spawn` real-world traps.
  - §B draws on etcd-raft (atomic writes), SQLite WAL design (durability), and Node/Bun fs semantics.

Stack context:
  - §A: `web/server/cli-launcher.ts` spawns Claude Code CLI (`claude --sdk-url ...`) or Codex as a child process. `web/server/session-orchestrator.ts` manages lifecycle: PID tracking, idle-kill at 4h, auto-relaunch on crash up to 3 retries, `--resume` for session recovery across server restarts. Recordings (JSONL) tied to subprocess lifecycle.
  - §B: Bun + Node `fs` / `fs/promises` / no database. Session state JSON at `$TMPDIR/vibe-sessions/`. Environment profiles at `~/.companion/envs/`. Raw protocol recordings JSONL at `~/.companion/recordings/`. Debounced writes (150ms) in `session-store.ts`. Append-only logs with rotation in `recorder.ts`. No transactions, no locks.

Every finding must describe the **concrete failure mode** — not just "looks fragile."
Realtime/NDJSON correctness in `quality-dahl.md` §B. Backend correctness (HTTP framework, async TS) in `quality-dahl.md` §A and the framework-neutral `quality-backend.md`. Security patterns (command injection in spawn, path traversal, slug injection) in `security.md` (Hunt). This doc partitions into two distinct review lenses, each with its own severity ladder and overriding filter: §A covers process state-machine correctness, signal handling, zombie/orphan prevention, auto-relaunch discipline, `--resume` semantics, server-restart reconnect race, idle-kill timing; §B covers durability, atomicity, crash recovery, append-safety, rotation invariants, sentinel/orphan detection, and replay determinism.

## Why this expert exists (two lenses, one Unix discipline)

The bridge owns and orchestrates external subprocesses that survive server restarts and reconnect by PID, AND it persists every byte of session state to local-disk JSON / JSONL with no database backing. No subsystem on a stock backend expert's radar — but at least three documented race conditions and orphan classes live exclusively in the process-lifecycle lens, and the failure modes that Postgres internalises (atomic commit, fsync, snapshot isolation) are now the application's filesystem responsibility. The CLI subprocess is also the only thing in the stack that can leak system resources (FDs, memory, zombies) without a corresponding HTTP request, so it demands a process-aware reviewer.

The two lenses share Unix discipline ("everything is a file"; "let it crash"; "atomic rename or it didn't happen") but force distinct review-time questions:
  - **§A asks**: "am I talking to the right process?" — PID identity, signal propagation, exit-handler completeness, lifecycle state-machine correctness.
  - **§B asks**: "did this write commit durably?" — atomic-rename, fsync, debounce-window, sentinel-orphan, line-terminator, schema-version, replay round-trip.

A single fused narrative loses both questions. They are kept partitioned below; each lens has its own severity ladder and its own overriding filter. Findings should be authored under exactly ONE of §A or §B (or both if cross-cutting), with the section header used as the lens marker.

---

## §A Process lifecycle

### Principle A1: `spawn` is not `exec` — every argument must be validated

*Carmack: "Use the type system as armour."*
*`Bun.spawn`/`child_process.spawn` with `shell: true` is `exec`-equivalent and accepts injection. Even `shell: false` requires that arguments be discrete strings, not concatenations of user input.*

#### What to check

**Shell-mode spawn**
- `Bun.spawn({ cmd: [..., shell: true] })` or `child_process.exec(...)` anywhere in the launcher. Cross-reference `security.md` Principle 1.
- Severity: **P1**.

**Argument list built from user-controlled fields**
- Args like `["--sdk-url", url, "--cwd", req.body.cwd]` where `req.body.cwd` flows in. If `cwd` is a path validated by the OS (`spawn` rejects invalid working directories), low-risk; if it's a flag-prefix injection (`--evil-flag`), the CLI may interpret it as a new flag.
- Use `--` to terminate option parsing where the CLI supports it. Validate against an allowlist of expected shapes.
- Severity: **P1** if user can inject CLI flags into the subprocess.

**`env` inheritance leaking secrets**
- Default `spawn` inherits the full parent environment. If the server has `ANTHROPIC_API_KEY`, `GITHUB_TOKEN`, etc., the CLI subprocess also has them. Usually intentional, but document it — and explicitly drop server-only secrets that the CLI doesn't need.
- Severity: **P3** unless audit reveals over-shared secrets.

---

### Principle A2: Track PID, but never trust PID across reboots

*Carmack: "If a mistake is possible, it will eventually happen."*
*PIDs are reused. A session JSON saying `pid: 12345` is no proof — kernel may have given 12345 to an unrelated process by the time the server restarts. Reconnection must verify identity, not just existence.*

#### What to check

**PID-based "is it alive" via `process.kill(pid, 0)` only**
- `kill -0` reports whether SOMETHING owns that PID — not whether it's the right something. The server may "find" the user's Firefox at PID 12345 and try to attach. Pair PID check with: parent PID match (`ppid` was us), executable name match (`/proc/<pid>/comm`), and/or a stable identity exchange (CLI announces its session ID on connect).
- Severity: **P1** for PID-only reconnect on server restart.

**No grace period before declaring dead**
- After server restart, the CLI hasn't reconnected yet. If the server immediately spawns a new CLI with `--resume`, you may have two CLIs talking to the same session. A grace period (5–10s) gives the inflight CLI a chance to reconnect first.
- Severity: **P1** for missing reconnect grace.

**Grace period without an upper bound**
- A grace period that never expires leaves sessions in "reconnecting" forever if the CLI is truly dead. Cap at (e.g.) 30s, then declare dead and relaunch.
- Severity: **P2**.

---

### Principle A3: Signals — SIGTERM grace, SIGKILL fallback

*Carmack: "Latency is always a bug — but data loss is worse."*
*Killing a CLI with SIGKILL while it's mid-write to its session may corrupt persisted state. A SIGTERM-first protocol lets the CLI flush and exit cleanly.*

#### What to check

**SIGKILL only**
- `proc.kill()` defaults to SIGTERM on Bun and Node. Confirm: it's not being forced to SIGKILL (`proc.kill('SIGKILL')` or `proc.kill(9)`) on graceful end. Reserve SIGKILL for non-responsive subprocesses after a SIGTERM timeout (e.g. 5s).
- Severity: **P2** for SIGKILL-only termination.

**Signal handlers absent on the server itself**
- Server crash mid-spawn or server SIGTERM during shutdown — does the server send SIGTERM to child CLIs before exiting? If not, the children become orphans inherited by init/launchd. They may run unattached until idle-kill fires (which won't fire if the server is the one tracking idle time).
- Pattern: install `process.on('SIGTERM'/'SIGINT')` handler on the server that broadcasts to all child CLIs, awaits clean exit (with timeout), then exits.
- Severity: **P1** for server with no child-signal propagation.

**`detached: true` without intention**
- A `spawn` with `detached: true` (and `unref()`) survives the server. This is sometimes desired (foreground server, background CLI). If unintentional, the CLI runs forever after the server dies. Confirm the choice is deliberate and documented.
- Severity: **P2** unless deliberate.

---

### Principle A4: Auto-relaunch — bounded, not infinite, and not silent

*Carmack: "Deploy assertions as tripwires."*
*Auto-relaunch (max 3 retries per CLAUDE.md) is the right answer to a flaky child. But unbounded retry is a busy-loop CPU sink, and silent retry hides a recurring crash.*

#### What to check

**Relaunch counter not reset on success**
- If the counter is "total relaunches ever", three flaky reconnects in a year kills the session forever. Reset to 0 when the child has stayed alive for N minutes (e.g. 5 min of stable runtime).
- Severity: **P2** for counter without success-reset semantics.

**No backoff between retries**
- Three consecutive `spawn` calls with no delay rapidly exhaust the budget on a deterministic failure (bad CLI binary, missing dependency). Use exponential backoff (1s, 2s, 4s).
- Severity: **P2** for retry without backoff.

**Silent failure on exhaustion**
- When the 3rd retry fails, the session state must reflect it (`status: "crashed", reason: "..."`). UI must show it. Otherwise the user sees a stuck "connecting" forever.
- Severity: **P1** for silent exhaustion.

**Identical relaunch arguments on every retry**
- If retry 1 fails with `--resume <id>` and the session is unrecoverable, retry 2 with the same args fails too. Either fall back to fresh-session args after N retries, or surface the unrecoverability to the user with explicit choice.
- Severity: **P3** unless this pattern has actually caused stuck sessions.

---

### Principle A5: `--resume` semantics — session ID continuity, not state

*Carmack: "Make data flow visible and explicit."*
*`--resume <session_id>` tells the CLI to pick up its own internal session ID. The CLI's notion of "resume" and the bridge's notion may diverge. Always confirm what state actually transfers — message history? Permissions? CWD? Env?*

#### What to check

**Server's session ID confused with CLI's internal session ID**
- Companion has its own session ID. The CLI has its own. `--resume` takes the CLI's ID. Mixing them up reconnects to the wrong session or fails outright.
- Severity: **P1** if IDs are confused at the launcher boundary.

**Resume assumed durable across CLI updates**
- A CLI version bump may invalidate old session resume tokens. `--resume` returns an error; the relaunch loop retries with the same broken token. Detect the resume-failed error class and fall back to fresh-session creation, not retry.
- Severity: **P1** for retry-on-resume-failure that never breaks the cycle.

**State drift after resume**
- The CLI's internal state (working directory, model, permission mode) may differ from what the bridge thinks. After resume, re-send the canonical state (model, permission mode) from the persisted session JSON to align the CLI.
- Severity: **P2** for state-drift after resume.

---

### Principle A6: Idle-kill — generous, but ungrudging when it fires

*Carmack: "State is the enemy."*
*Idle-kill at 4h (per CLAUDE.md) reclaims resources from forgotten sessions. The math has to be right: what counts as activity, what resets the timer, what happens when a tab is open but idle.*

#### What to check

**Activity tracker reset by keep-alives**
- If browser keep-alive pings reset the idle timer, an open-but-untouched tab keeps a CLI alive forever. Decide whether human input or any browser presence counts. Document the rule.
- Severity: **P2** for ambiguous activity-reset semantics.

**Idle-kill races with new browser attach**
- Idle-kill fires at T+4h. A browser attaches at T+4h+50ms. Either the session is dead and the browser sees the corpse, or the kill is racing. The attach must check the session state atomically — if killed, treat as ended.
- Severity: **P2** for unguarded attach-after-kill races.

**Pause/sleep not detected**
- Laptop suspends for 8h. On wake, the idle-kill timer has long since fired in wall-clock but maybe not in event-loop time (depends on timer implementation). Always recheck idle on wake. Use absolute timestamps, not relative timers.
- Severity: **P2** for monotonic-only idle accounting.

---

### Principle A7: Zombie reaping — the launcher is the parent

*Carmack: "Resource lifecycle is visible or it's leaked."*
*A subprocess that exits without its parent calling `wait()`/handling `exit` becomes a zombie. Node and Bun both auto-reap if you have an `exit` listener; without one, zombies accumulate.*

#### What to check

**No `exit` handler on the spawned process**
- Every `spawn` must attach `proc.on('exit', ...)`. Without it, zombies accumulate until process table overflow. Verify each spawn site has the handler installed before any `await` that might lose the reference.
- Severity: **P2** for missing exit handler.

**Exit handler that returns without cleanup**
- `proc.on('exit', () => {})` reaps the zombie but doesn't update session state, doesn't flush the recording, doesn't notify the browser. The session sits in a stale state forever.
- Severity: **P1** if cleanup omits user-visible state.

**Stdio streams not drained**
- A CLI that writes to stderr without anyone reading it can fill the pipe buffer (typically 64KB) and block the CLI on its next write. Always attach `.stderr.on('data', ...)` or pipe to `process.stderr`/a log file.
- Severity: **P2** for unread stdio streams.

---

### Principle A8: Recordings tied to lifecycle — start, append, close

*Carmack: "Structure should make the intended behavior obvious."*
*Recording starts when the CLI connects, appends every message both ways, closes when the CLI exits. A relaunch creates a new recording file. Coupling is correct; bugs are in the edges.*

#### What to check

**Recording file not closed on subprocess exit**
- The `exit` handler must close the recording (fsync + close the FD). An open recording past subprocess death leaves a tantalising FD-but-no-writer that confuses the rotation manager. Cross-reference §B Principle 5.
- Severity: **P2**.

**Recording opens on relaunch, but old session ID reused**
- If relaunch keeps the same Companion session ID but the CLI gets a new internal session, the recording file may be named after the old or new ID — be deliberate. Recommended: one recording per CLI subprocess instance (per spawn), not per Companion session.
- Severity: **P3** for naming consistency.

**`recording.start` racing the first CLI message**
- If the recording subscriber attaches AFTER the first NDJSON line is consumed by the bridge, line 1 is missing from the file. Subscribe-before-spawn (or before the WebSocket upgrade to the CLI socket).
- Severity: **P2** for first-message-missing recordings.

---

### Principle A9: Bun vs Node behaviour drift

*Carmack: "Don't build on assumptions you can't verify."*
*Bun and Node `child_process` are mostly compatible but diverge on subtle points: signal forwarding, `detached`, IPC channels, stdio types. Test on the runtime you actually deploy on.*

#### What to check

**Code written against Node `child_process` API but executed by Bun**
- Bun aims for compatibility, but `Bun.spawn` is preferred under Bun. If the codebase mixes `import { spawn } from 'child_process'` and `Bun.spawn`, behaviour can drift across runtimes. Pick one and stick with it.
- Severity: **P3** unless mixing has caused observed issues.

**`stdio: 'inherit'` in tests, `stdio: 'pipe'` in prod**
- Test-time spawns that inherit stdio dump CLI logs into the test runner. Prod spawns that pipe stdio require explicit draining (Principle A7). Mismatched defaults across environments hide bugs in dev.
- Severity: **P3** consistency.

---

### Principle A10: Know your gaps (§A)

*Carmack: epistemic humility — you can't fix what you don't know is broken.*

#### Areas this lens is weaker on (supplement from other sources)

- **systemd integration**: if the Companion server itself is managed by systemd, restart policies (Restart=on-failure, RestartSec=) intersect with the auto-relaunch counter. Out of scope here — covered by deploy expert (`quality-hashimoto.md`).
- **Sandboxing the CLI**: cgroups, namespaces, capability drops. Aura runs the CLI with full host privileges; sandboxing is a hardening project, not a current finding.
- **Cross-platform signals**: Windows has no SIGTERM. Bun on Windows behaves differently. The product is Linux/macOS-focused; flag if a Windows path is claimed.

---

### §A Quick Reference: Severity Guide

| Severity | Pattern | Examples |
|----------|---------|----------|
| **P1 — Fix Now** | Wrong process attached, infinite stuck state, silent crash propagation | PID-only reconnect, server with no child-signal propagation, silent retry exhaustion, IDs confused at launcher boundary, retry-on-resume-failure infinite loop, exit handler that omits user-visible cleanup |
| **P2 — Fix Soon** | Resource leaks, races on lifecycle edges, silent state drift | Missing reconnect grace, SIGKILL-only termination, retry without backoff, ambiguous idle-reset semantics, missing exit handler, recording file not closed, race on first-message capture |
| **P3 — Consider** | Consistency, future-hardening, runtime divergence | Mixed `child_process`/`Bun.spawn`, stdio defaults differ across env, recording naming, env over-share, retry args identical across attempts |

### §A The Overriding Filter

Before writing any §A finding, apply the subprocess synthesis:

1. **Does this code know which process it's actually talking to?** PIDs lie; identity must be confirmed.
2. **Are signals propagated, both inward (server → child) and outward (child exit → server cleanup)?** Either gap leaks state.
3. **Is auto-relaunch bounded, backed off, and visible on exhaustion?** Silent infinite retry is the most common stuck-session class.
4. **Are zombies reaped and stdio drained?** A subprocess holding a 64KB pipe blocks on its next write.
5. **Do recordings cover the full subprocess lifetime, not from-N-onwards?** Missing line 1 makes replay tests lie.

---

## §B Filesystem persistence

### Principle B1: Atomic write or it didn't happen — `writeFile` is not atomic

*Carmack: "If a mistake is possible, it will eventually happen."*
*POSIX rename(2) is the only filesystem operation guaranteed atomic across most local filesystems. A bare `writeFile`/`writeFileSync` is two operations under the hood: open → write → close. A crash between bytes leaves a truncated file. A crash mid-write of a session JSON wipes the entire previous state.*

#### What to check

**Bare `writeFileSync`/`writeFile` on durable state**
- Look for `fs.writeFileSync(path, data)` or `fs.writeFile(path, data)` where `path` is a durable record (session JSON, env profile, settings file). Concrete file: `web/server/session-store.ts` — if it writes directly to the final path, a server crash mid-write leaves a corrupted JSON that fails to parse on next load.
- Correct pattern: write to `${path}.tmp`, fsync, `rename` to final path. The rename is atomic on the same filesystem. Both readers see either old or new contents — never partial.
- Severity: **P1** for durable session/env state written non-atomically. **P2** for write-mostly logs where partial loss is acceptable.

**Missing fsync before rename**
- Even with tmp+rename, without `fsync` the OS may reorder writes — the rename can hit disk before the data. After a power loss, the file points at uncommitted data.
- For local dev tool this is **P2** (developer machine, low blast radius). For server deploy it would be **P1**. Flag at **P2** and note the trade-off.

**Truncating writes that lose history**
- `O_TRUNC` followed by partial write is the worst case: data shrinks before new data lands. If the write fails halfway, the file is shorter than both versions. JSON parse fails on next load.
- Severity: **P1** if it can affect session messages history (user-visible loss).

---

### Principle B2: Debounce is a correctness window, not just an optimisation

*Carmack: "If you can't see the cost, you can't reason about correctness."*
*Debounced writes amortise IO, but every debounce window is a span of time during which committed in-memory state has no on-disk counterpart. A crash inside the window loses every change since the last flush.*

#### What to check

**Debounce window without flush-on-shutdown**
- `session-store.ts` debounces at 150ms. If the process exits (SIGTERM, SIGINT, uncaught exception, OOM) inside that window, all messages received in the last <=150ms are lost. Is there a `process.on('SIGTERM'/'SIGINT')` handler that flushes pending debounced writes synchronously before exit? Is there a `beforeExit` handler?
- Severity: **P1** if no shutdown-flush exists and the data is user-visible (chat messages). **P2** if loss is recoverable from upstream (the CLI can re-emit).

**Debounce window without flush-on-critical-event**
- Some events change durability requirements: session ended, permission granted/denied, error thrown. These should bypass debounce and flush immediately. Otherwise a crash 100ms after permission grant re-shows the permission prompt on reload — confusing, possibly dangerous.
- Severity: **P2** for permission/end-of-session events not force-flushed.

**Debounce target not the latest snapshot**
- If debounce works by queuing diffs, late arrivals overwrite earlier diffs. Make sure the in-memory state is always the canonical source — debounced write should always snapshot the current state, not a stale diff.
- Severity: **P2** for stale-diff debounce patterns.

---

### Principle B3: Sentinel rows, but for files — close every state on every exit path

*Carmack: "Deploy assertions as tripwires."*
*The Postgres analogue is an outbox row that must be marked `done`. The filesystem analogue is a session JSON marked `active: true` that must be flipped to `active: false` (or deleted) on every exit path — graceful shutdown, error, crash recovery.*

#### What to check

**Sessions that stay `active: true` after process death**
- On startup, `session-orchestrator` reads sessions from disk and looks for PIDs to reconnect. A session that's `active: true` with a dead PID is an orphan. Is there explicit detection that flips orphans to `dead: true` / `terminated`? Is the grace period configurable? Without orphan reaping, the UI may show "running" sessions that haven't existed since the last reboot.
- Severity: **P1** for orphan sessions visible to user as live. **P2** for orphan state that only inflates list counts.

**Exit paths that don't update state**
- Any code path that ends a session (timeout, error, idle-kill, user end) must update the JSON to `ended` state. Look for `return` paths in `cli-launcher.ts` / `session-orchestrator.ts` that exit without writing. A session that "ends" silently leaves the file at the previous `running` state.
- Severity: **P2** for any silent exit path on session lifecycle.

**Missing idempotency on state transitions**
- If `endSession(id)` is called twice — once by user, once by CLI exit handler — does the second call corrupt the JSON (e.g. by re-incrementing a counter) or is it a no-op? State transitions must be idempotent because exit signals are unordered.
- Severity: **P2** if double-end can break the JSON.

---

### Principle B4: Append-only logs must split lines, not records

*Carmack: "Structure should make the intended behavior obvious."*
*JSONL (one JSON per line) is robust because newline is the atomic delimiter. The trap: writing without ending the line, or writing partial lines from interleaved producers.*

#### What to check

**`writeFile` to a JSONL with no trailing newline**
- `recorder.ts` writes raw protocol entries. Every line must end with `\n`. A line without trailing newline merges with the next line on the next write, producing one corrupt JSON object that breaks `readline` consumers.
- Severity: **P1** for JSONL writes missing `\n`.

**Multiple producers writing to the same JSONL**
- POSIX `write` is atomic up to PIPE_BUF (~4KB on Linux). Anything larger may interleave between concurrent writers. If two sessions both record to one file concurrently, large messages may interleave. Recordings are per-session, but make sure they're truly per-file.
- Severity: **P2** for shared JSONL writers without per-file locking or per-file partitioning.

**Producer crashes mid-line**
- If `recorder.ts` writes `{"ts":12345,"raw":"...`  and crashes, the next start appends a new line on top of the partial. JSONL parsers will see one corrupt line followed by valid ones. The parser must skip corrupt lines without aborting.
- Severity: **P2** for replay/audit tooling that crashes on a corrupt line.

---

### Principle B5: Rotation invariants — bound storage without losing meaning

*Carmack: "State is the enemy."*
*Recording rotation in `recorder.ts` kicks in at 1M total lines (configurable via `COMPANION_RECORDINGS_MAX_LINES`). Without it the directory grows unbounded; with a buggy rotation it loses recent data or keeps stale ghosts.*

#### What to check

**Deletion by name/timestamp without checking active recorders**
- Rotation walks the directory and deletes oldest files. If a still-open recorder is writing to one of those files, deleting it (`unlink`) on Linux keeps the FD valid but unlinks the inode — the active recorder writes to a ghost file that no one can read. On next session list, the recording appears missing.
- Fix: never delete a file currently held open by a recorder. Track active FDs in `RecordingManager` and skip them.
- Severity: **P1** for rotation deleting open files.

**Rotation triggered by size but counted by lines (or vice versa)**
- If `COMPANION_RECORDINGS_MAX_LINES` is the threshold but the check is `du -sh`-based (or vice versa), the metric mismatches the budget. Pick one and document it.
- Severity: **P3** consistency hygiene.

**No total-storage cap**
- Per-file rotation prevents single-file blowup. But if every new session creates a new file and old files are never deleted, the directory grows unboundedly until disk fills. The 1M-line cap is across all files, but verify it's enforced — not just the per-file ceiling.
- Severity: **P2** if directory size is unbounded.

---

### Principle B6: Slug + path validation — file paths are an attack surface

*Carmack: "Validate at the boundary."*
*`env-manager.ts` accepts a slug from a request and uses it to derive a file path under `~/.companion/envs/`. A slug like `../../../etc/passwd` reads files outside the directory. A slug with `\0` truncates the path on some platforms.*

#### What to check

**Slug regex too permissive**
- A slug regex of `/[a-z0-9-_]+/i` is fine. A regex of `.+` or string concatenation without validation is a path traversal vector. Cross-reference with `security.md` Principle 1.
- Severity: **P1** if user input flows into a path without strict validation.

**Path resolution before validation**
- `path.join(dir, slug)` does not prevent traversal — `path.join('/a/b', '../c')` returns `/a/c`. The check must be `path.resolve(joined).startsWith(path.resolve(dir) + path.sep)`.
- Severity: **P1**.

**Case-sensitivity mismatch**
- macOS (HFS+, default) is case-insensitive. Linux is case-sensitive. A slug `Foo` and `foo` may collide on macOS and not on Linux. Choose: normalise to lowercase (recommended) or accept the divergence and document it.
- Severity: **P3** consistency.

---

### Principle B7: Replay determinism — recordings must round-trip

*Carmack: "If you can't reproduce a bug, you can't fix it."*
*The recording system exists so we can replay protocol sessions for debugging. If the recording is lossy or reorders messages, replays diverge from production and the test value collapses.*

#### What to check

**`out` direction not recorded for both peers**
- Each entry has `dir: in|out` and `ch: cli|browser`. To fully reproduce a session we need ALL four combinations: `cli→server`, `server→cli`, `browser→server`, `server→browser`. Verify all four directions are captured at the point of read/write — not only one side.
- Severity: **P1** for missing direction.

**Re-serialisation before recording**
- `raw` is supposed to be the **exact original string**. If the recorder takes a parsed object and re-stringifies, formatting drifts (`{"a":1}` vs `{ "a": 1 }`), JSON canonicalisation differs across runtimes, and bug reproduction fails for whitespace-sensitive protocols.
- Severity: **P1** for re-serialised raw entries.

**Clock not monotonic**
- `ts: Date.now()` is wall-clock, which can jump backward on NTP correction. For replay ordering, prefer `performance.now()` plus a per-session base wall-clock so ordering is stable.
- Severity: **P3** at this scale; **P2** if replay diff tooling depends on `ts` ordering.

---

### Principle B8: JSON shape evolution — version every schema

*Carmack: "Use the type system as armour."*
*Session JSONs and env profile JSONs survive across versions. A field renamed in code that's still read from disk = silent parse failure or wrong default. A field that changes type = TypeScript lies.*

#### What to check

**No schema version field**
- Every persistent JSON should have a `schemaVersion: 1`. On load, unknown versions either migrate or reject loudly. Without it, a v2 server reading a v1 file silently defaults to incorrect values.
- Severity: **P2** for any persistent record without a version field.

**Loose Zod/runtime validation on load**
- `JSON.parse` returns `any`. If the loader assigns straight to a typed variable, TypeScript trusts the disk. A schema check (Zod, type guard, plain validator) at the load boundary turns a silent failure into a loud one.
- Severity: **P2** for session/env loaders without runtime validation.

**Mutating loaded objects in place**
- If the loader returns the parsed object and the application mutates it, the next save persists the mutation. Default values populated on load become "real" on next save. Make sure load → mutate → save is intentional, not a side effect of object identity.
- Severity: **P3** unless mutation introduces an invalid record.

---

### Principle B9: Watch out for the filesystem you don't have — tmpfs, NFS, encrypted FS

*Carmack: "Don't build on assumptions you can't verify."*
*`$TMPDIR` may be tmpfs (RAM-backed), which means a host reboot wipes all sessions. A user with `TMPDIR=/some/network/fs` gets NFS latency and stale-NFS-handle errors. Encrypted FUSE filesystems (e.g., cryptomator) often disable `fsync` for performance.*

#### What to check

**`$TMPDIR` assumed durable across reboots**
- Sessions are persisted to `$TMPDIR/vibe-sessions/` per CLAUDE.md. On most Linux distros `$TMPDIR` defaults to `/tmp` which IS wiped on reboot. On macOS it's `/var/folders/...` which IS NOT wiped. This means session durability is OS-dependent. Document the assumption; ideally use `~/.companion/sessions/` for true durability.
- Severity: **P2** for inconsistent durability across platforms.

**Cross-filesystem rename**
- `rename(tmpFile, finalFile)` is atomic only when both are on the same filesystem. If tmp is on `/tmp` (tmpfs) and final is on `~` (ext4), rename falls back to copy+unlink which is NOT atomic. Always create the tmp file in the same directory as the final target.
- Severity: **P1** for cross-FS atomic-rename assumption.

---

### Principle B10: Know your gaps (§B)

*Carmack: epistemic humility — you can't fix what you don't know is broken.*

#### Areas this lens is weaker on (supplement from other sources)

- **Distributed durability**: multi-host replication, consensus protocols (etcd, Raft) — irrelevant at this scale, but if Companion ever grows to a multi-server topology, this becomes critical.
- **Encryption-at-rest**: session JSONs may contain prompts, tool outputs, conversation history. If the disk is unencrypted, an attacker with FS access reads everything. Out of scope for a local dev tool but worth flagging if deployed.
- **Backup strategy**: there is none, by design. If `$TMPDIR/vibe-sessions/` is lost, sessions are gone. Acceptable for a dev tool; document the constraint.

---

### §B Quick Reference: Severity Guide

| Severity | Pattern | Examples |
|----------|---------|----------|
| **P1 — Fix Now** | Data loss, corruption, security boundary breach | Non-atomic writes on session JSON, missing JSONL `\n`, rotation deleting open files, path traversal via slug, re-serialised `raw` recording, cross-FS rename |
| **P2 — Fix Soon** | Crash window, orphan state, silent schema drift | Debounce without shutdown-flush, orphan sessions kept `active`, JSONL replay parsers that abort on corrupt lines, missing `schemaVersion` field, unbounded directory growth |
| **P3 — Consider** | Hygiene, platform consistency, edge polish | Rotation metric mismatch, slug case-sensitivity, non-monotonic `ts`, missing fsync on dev-only paths |

### §B The Overriding Filter

Before writing any §B finding, apply the FS-JSON synthesis:

1. **Can a crash here cause corruption visible to the user?** If yes, escalate to P1.
2. **Is every exit path closing the state row?** If not, expect orphans.
3. **Is the line-terminator discipline tight?** Missing `\n` poisons every downstream parser.
4. **Are slugs and paths validated at the boundary?** Anywhere user input becomes a path is an attack surface.
5. **Will the recording round-trip?** If the captured bytes don't equal the wire bytes, replay value collapses.

---

## §Z External-source enrichment

Sources:
- https://www.bell-labs.com/usr/dmr/www/
- https://man7.org/linux/man-pages/
- https://pubs.opengroup.org/onlinepubs/9699919799/
- https://en.wikipedia.org/wiki/The_C_Programming_Language

### Additional principles

- **Text-stream interoperability** is the original composability. Every Unix tool reads stdin / writes stdout / emits one line per event because that's the only contract that lets `grep`, `awk`, `sort`, `uniq`, `tee` compose without coordination. NDJSON is the wire-protocol heir; the text-stream interoperability contract holds across decades because it beats schema-versioned framing for systems-archaeology.
- **Composability-first** beats feature-rich. A 50-line tool with a tight stdin/stdout contract is a better building block than a 5000-line framework with a plugin API; composability-first is why `find | xargs | grep` outlives every "search platform" launched the same year.
- **Append-only logging** is the disk-side analogue of immutable data structures. Truncate-and-rewrite is where corruption lives; append-only logging plus a rotation policy gives you replay, audit, and crash-safety for the cost of one fsync per write. JSONL pairs perfectly with this discipline.
- **Atomic file replacement** is non-negotiable for any state file the system reads concurrently. `write tmp → fsync(tmp) → rename(tmp, dst)` is POSIX-atomic; `open(dst, O_TRUNC) → write` is not. Mid-write crashes that leave half-written state files are the canonical Unix anti-pattern this discipline eliminates.

### Tone characteristics

Unix minimalism: every line of code is one more thing that can break — fewer lines, fewer failure modes. Composability-first: design the interface assuming someone you've never met will pipe into it next year. Systems austerity: the kernel doesn't have an opinion about your domain, so neither should your file format. Deterministic engineering: a system whose state at time T is a pure function of its inputs through time T is one you can actually debug; everything else is divination.

### Anti-patterns to detect

- Non-atomic file replacement (e.g., `open(dst, O_TRUNC) → write`) on any state file the system reads concurrently — half-written file becomes visible on crash.
- Signal-as-control-channel for in-band data (e.g., SIGUSR1 to "trigger a reload" carrying no payload other than its arrival). Signals are interruptions, not messages; pair them with a state file or pipe.
- Append-without-fsync where durability matters — an `O_APPEND` write that the kernel hasn't flushed is a write that doesn't survive power loss; pair every durability-critical append with `fsync()` or accept the loss window.
- Hidden text-stream assumptions (e.g., `cat file | head -1`) where `file` lacks a final newline — produces a "broken-pipe-on-EOF" that looks like a tool bug but is a missing terminator.
