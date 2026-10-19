# ritchie — Process Lifecycle (§A) + Filesystem Persistence (§B)

Lens: `quality-ritchie.md`. Scope: the hourly KB-analysis check and the single-flight analysis job inside the server process (§A), and every new byte on disk — reports, `decisions.jsonl`, the archive move, accumulation state, path bounds, the memory-dir read-only guarantee (§B). Ground truth read: `cleanup/cleanup-scheduler.ts` (self-rescheduling timeout, error boundary, `dispose()` awaits in-flight, timer NOT unref'd), `cleanup/eviction-sweeper.ts` (boot reconcile sweeps `.<hex>.tmp` older than `bootTimeMs`), `atomic-write.ts` (tmp O_EXCL → fsync → rename → dir fsync, default byte cap = council artifact limit), `scripts/kb-health.ts` (`loadKb` keeps raw line text; `pruneKb` writes archive BEFORE live store; rewrite is a full-file replace), `cli-launcher.ts` (`session:exited` emitted from the same `proc.exited` site for Claude and Codex; `exitCode` is sticky and reset to undefined on relaunch; spawn failures also set `exitCode` 1/127/-1), `index.ts` `gracefulShutdown` (diagnostics timer cleared first, then session-store flush, council teardown, `cleanupScheduler.dispose()`, then `process.exit(0)`), and the host: memory dir is `root:auracomp 775`, memory files `auracomp 644` — the service user CAN write there, so OS permissions prove nothing.

## §A Process lifecycle

### A1
RECOMMENDATION
- Title: Hourly check = a second `CleanupScheduler` instance at 1h, disposed inside `gracefulShutdown` before the container persist
- AC defended: AC4, AC5, Must (spec §5 — single-flight, structured logs)
- Principle: A3 (signals — server shutdown must drain what it owns); A6 (absolute timestamps, collapse missed ticks)
- What to get right: Do not add a bare `setInterval`; construct a dedicated `CleanupScheduler` with `intervalMs` = 1h (inside the clamp, no test override in production) and register the due-check as its only sweep, so the check inherits the self-rescheduling timeout (laptop sleep / clock jump collapses to one tick), the per-sweep try/catch with `event=cleanup.sweep.error`, and `dispose()` that awaits the in-flight tick. Wire its `dispose()` into `gracefulShutdown` next to the existing scheduler, before `markCleanShutdown`, and note that the scheduler's timer is not unref'd — tests must dispose it in teardown or the worker hangs. The "due" decision must compare persisted absolute timestamps (`lastRun.ts` vs now), never elapsed tick counts, so a 14-day max-age survives sleeps and restarts.
- Risk if skipped: A thrown due-check or a fired tick during teardown either crashes Bun (unhandled rejection inside a bare interval) or races the shutdown; a tick-counting max-age never fires on a host that sleeps.
- Depends on: —

### A2
RECOMMENDATION
- Title: One in-memory single-flight gate shared by the hourly tick and the manual POST; disk is never the arbiter of "running"
- AC defended: AC5, AC6
- Principle: A4 (bounded, visible); B3 (close every state on every exit path)
- What to get right: Both entry points (scheduler sweep and `POST /run`) call one `startAnalysis()` that holds a single in-flight promise plus its `runId`; a second caller gets "already running + that runId" (route maps it to 409) without touching the filesystem. The handle is cleared in a `finally`, so a thrown, rejected, or aborted run can never leave the gate closed. Any on-disk in-flight marker (see A4) is informational for the next boot only — the gate on a live process is the in-memory handle, so a stale marker from a crash can never block "Run analysis now" forever.
- Risk if skipped: A persisted "running" flag that survives a crash deadlocks the manual run until someone deletes a file by hand; two gates (tick vs POST) let one analysis start on each and write two reports for the same accumulation window.
- Depends on: A1

### A3
RECOMMENDATION
- Title: The analysis is a background job with an abort signal and a budget — the sweep callback must not hold the event loop, and shutdown must not wait on it unboundedly
- AC defended: AC5, Must (spec §5 — no event-loop blocking, KB reads under `trackSync` ≤ 100 ms)
- Principle: A3 (SIGTERM grace, bounded shutdown); Carmack "latency is always a bug"
- What to get right: The hourly sweep does the cheap due-check synchronously under `trackSync` (first a `stat` of the six KB store files — if no store mtime is newer than `lastRun.ts` and the session counter is below threshold, skip the parse entirely) and, when due, launches the analysis as a tracked promise and returns; it does not await the whole run inside the sweep, otherwise `dispose()` at shutdown blocks on a long run and the 8 s budget is blown. The run itself must be chunked (yield between KB files and, for the optional memory pass over ~470 files / 2.2 MB, between batches with async reads) so no single synchronous slice exceeds the lag-monitor budget. Give the run an abort signal: `gracefulShutdown` signals it first, the run stops at the next chunk boundary without writing a report and without advancing `lastRun`, and the next boot's hourly check re-evaluates thresholds from persisted state — no special recovery needed because the report write is atomic (B1).
- Risk if skipped: A 2 MB synchronous memory scan stalls the WebSocket bridge for every live session; a SIGTERM during a run either loses the shutdown budget or exits with a half-written report.
- Depends on: A1, A2, B1

### A4
RECOMMENDATION
- Title: Failure semantics for the ticker: a failed run never advances `lastRun`, never retries hourly forever, and a run that killed the server is detected at boot and suppresses auto-trigger
- AC defended: AC5, Must (spec §5 — `event=kb_analysis.*` logs)
- Principle: A4 (auto-relaunch bounded, backed off, visible on exhaustion); OTP "let it crash" with a supervisor that notices
- What to get right: On rejection, log `event=kb_analysis.failed` with the reason once, keep `lastRun` at the previous successful value (otherwise a failed run suppresses the next attempt for 14 days), and record `lastAttempt{ts, outcome}` in memory and in the state file so the hourly tick backs off (no automatic retry for a fixed number of hours; manual run always allowed) instead of re-running a deterministic failure every hour. Write a small in-flight marker (`runId`, `pid`, `bootTimeMs`) under the reports dir when a run starts and remove it on completion; the boot reconcile finds a marker whose `bootTimeMs` predates this boot, concludes the previous run died with the server (OOM on the memory pass, crash), surfaces "last run died" on the KB card, and disables automatic triggering until one manual run succeeds — the crash-loop guard. The marker is never consulted on a live process (A2).
- Risk if skipped: A run that OOMs the server is re-launched by the hourly tick after every systemd restart — a self-inflicted crash loop with no visible cause; a failed run silently postpones analysis by two weeks.
- Depends on: A2, B5

### A5
RECOMMENDATION
- Title: "Finished sessions since last run" is counted from `session:exited` events, de-duplicated by session id and gated on at least one completed turn — identical for Claude and Codex
- AC defended: AC4, AC5
- Principle: A7 (exit handler completeness — the exit event is the one place both backends converge); B3 (state transitions idempotent)
- What to get right: Do not derive the count by scanning the session store at tick time: `exitCode` is sticky and reset on relaunch, rows carry no exit timestamp, and the retention/eviction sweeps remove finished rows, so a store scan drifts both ways. Subscribe once to `session:exited` (the launcher emits it from the same `proc.exited` path for both backends, so parity is structural, not per-backend logic) and add the session id to a persisted set in the accumulation state; count the set's size. Exclude exits of sessions with `num_turns` = 0 (spawn failures and immediate `--resume` deaths also set an exit code) and let the set de-duplicate drift-kill → auto-relaunch cycles, which otherwise count one session three times. Reset the set only when a report lands (B5). Document the definition on the card tooltip so an operator can reconcile the number.
- Risk if skipped: Codex and Claude count differently, relaunch storms trip the 25-session threshold in an hour, and an evicted session never counts at all — the trigger becomes unexplainable.
- Depends on: B5

### A6
RECOMMENDATION
- Title: Every `kb_analysis.*` log line carries `runId` + `trigger` + `outcome`, and the ticker's daily "not due" line is rate-limited by the persisted state, not by a process-local counter
- AC defended: AC4, Must (spec §5)
- Principle: EC-9/EC-22 lineage (structured lifecycle lines with behavioural tests); A4 "not silent"
- What to get right: Emit `kb_analysis.check` (counts vs thresholds, due or not), `kb_analysis.started` (`runId`, `trigger` = hourly|manual), `kb_analysis.completed` (`runId`, report path depth/hash per EC-23 — never the raw path), `kb_analysis.failed`, `kb_analysis.aborted`, `kb_analysis.skipped_in_flight`, and `kb_analysis.died_previous_boot`. Keep the once-a-day "not due" line keyed on a `lastNotDueLogAt` timestamp in the state file so a restart does not reset the suppression. Each line needs an EC-22 behavioural test that spies on the logger.
- Risk if skipped: The page is the only other consumer; without these lines the next "why did analysis not run for three weeks" is undiagnosable from journalctl, which is the spec's stated reason to exist.
- Depends on: A1, A4

## §B Filesystem persistence

### B1
RECOMMENDATION
- Title: Reports go through `writeAtomicJson` with an explicit byte cap, a lexically sortable filename, and a server-generated `runId`; "latest" is the newest well-formed report by filename
- AC defended: AC5, AC7, Must (spec §5 — atomic writes)
- Principle: B1 (atomic write or it didn't happen); B9 (tmp in the same directory as the target)
- What to get right: Use the server `atomic-write.ts` helper (tmp O_EXCL in the reports dir, fsync, rename, directory fsync) and pass an explicit, generous `maxBytes` — the default cap is the council-artifact limit and would throw on a large KB report, silently dropping the run. Name files `<UTC timestamp, fixed width, lexically sortable>-<runId>.json` so directory order equals chronological order without relying on mtime (which a backup restore or `cp` rewrites); the `runId` is generated server-side and never accepted from a request. Selecting "latest" is a readdir filtered by the strict filename pattern, excluding dotfiles (`.<hex>.tmp`, the in-flight marker), `decisions.jsonl`, and `state.json`; a report that fails to parse or has a newer `schemaVersion` yields an explicit "report unreadable" card state, not a crash and not a silent fallback to an older file.
- Risk if skipped: A crash mid-write leaves a truncated JSON that the next `GET latest` parses as corruption; the card goes blank — the exact silent-disappearance class the feature exists to eliminate.
- Depends on: —

### B2
RECOMMENDATION
- Title: Keep-last-20 retention is deterministic: prune after the new report's rename lands, by filename order, strict-pattern-only, never the in-flight run, never the two non-report files, plus a boot-time orphan-tmp sweep
- AC defended: AC5, Must (spec §5)
- Principle: B5 (rotation invariants — bound storage without losing meaning); EC-8 (sentinel-before-sweep)
- What to get right: Run retention as the last step of a successful run, after the rename, so a crash can leave 21 files but never 19 with the newest missing. Candidates are only names matching the report pattern, sorted by name, oldest first, keeping 20; `decisions.jsonl`, `state.json`, the in-flight marker and any `.<hex>.tmp` are structurally excluded (pattern mismatch), not special-cased by hand. Register a boot reconcile on the hourly scheduler that unlinks `.<hex>.tmp` files whose mtime predates `bootTimeMs` (the eviction-sweeper pattern) and leaves newer ones alone. Decisions may reference a `runId` whose report has been rotated out — the decision replay (B4) must tolerate that; retention never touches `decisions.jsonl`.
- Risk if skipped: mtime-ordered pruning after a restore deletes the newest report; a sloppy glob eventually deletes `decisions.jsonl` — the only human-authored data in the directory — as "old derived data".
- Depends on: B1

### B3
RECOMMENDATION
- Title: `decisions.jsonl` append discipline — one write per line with a trailing newline, newline-repair before append, fsync after a human decision, partial-line-tolerant reader
- AC defended: AC8, AC9
- Principle: B4 (append-only logs must split lines, not records); §Z append-without-fsync
- What to get right: Each decision is one `appendFileSync` of a single JSON object followed by a newline (one `write(2)` on an O_APPEND fd, the `usage.log` precedent), followed by an fsync — these are owner decisions, the one place in this feature where losing the last write loses human work. Before appending, check whether the file's last byte is a newline (a crash mid-line leaves it without one) and prepend a newline if not, so the torn line stays torn on its own and the new record starts clean. The reader skips any unparsable line, reports `file:line`, and continues; it never aborts a replay or a page load. Each line carries its own small version field so the format can evolve without a header line that an append-only file cannot retroactively gain.
- Risk if skipped: A torn last line merges with the next decision into one corrupt record, the replay silently loses both, and the archived entry "comes back" as a never-used finding on the next report.
- Depends on: —

### B4
RECOMMENDATION
- Title: `decisions.jsonl` is the intent sentinel for the archive move: append the decision first, then act, and replay at boot/at analysis time to finish any archive whose entry is still live
- AC defended: AC7, AC8
- Principle: EC-8 (decide → write marker → act → reconcile); B3 (idempotent state transitions)
- What to get right: Ordering for `archive`: append the decision line (durable intent) → append the entry to `archive/<store>.jsonl` → rewrite the live store without that line → respond. Make the "act" step idempotent by state, not by memory: before acting, check where the id lives — in live only ⇒ do both steps; in both ⇒ finish only the live rewrite; in archive only ⇒ nothing to do (success); in neither ⇒ log and fail loudly. Reuse the same function from a boot reconcile that replays decisions newest-last and re-applies any `archive` whose id is still in a live store, so a crash between the two file writes (the window `pruneKb` already documents as "duplicates, recoverable") heals itself on the next start instead of waiting for a human. `keep` and `merge` are pure replay facts: `reviewedAt` (keep, 90-day suppression unless a new signal appears) and `mergePending`/`mergeInto` are derived by replaying the log, last decision per id wins, and are NEVER written into the KB entry itself — the stores are git-tracked content; telemetry stays out of them (the FIX-A2-1 rule that moved usage out of the stores). If the act step fails after the intent was appended, the POST must say so (recorded, not yet applied, will be reconciled) rather than 200.
- Risk if skipped: A crash between the archive append and the live rewrite leaves the entry in both files; a naive retry appends it to the archive a second time; the UI shows "archived" while the live store still carries the line and the next report flags it again.
- Depends on: B3, B6

### B5
RECOMMENDATION
- Title: Accumulation state lives in one atomically written `state.json` under the reports dir, versioned; `lastRun` advances only after the report rename, and a boot reconcile adopts a newer report the state does not know about
- AC defended: AC4, AC5
- Principle: B1 (atomic replace); B2 (debounce is a correctness window); B8 (version every schema)
- What to get right: One small file holding `schemaVersion`, `lastRun{ts, runId, outcome}`, `lastAttempt`, the exited-session id set (A5), `lastNotDueLogAt`, and `autoTriggerSuppressed` (A4). The session set is updated on every exit event through a debounced atomic write (a crash in the window delays the trigger by a few sessions — acceptable, and far better than a per-exit fsync in the exit handler). Write order at run completion: report rename → state update that advances `lastRun` and clears the set. A crash between the two leaves a report newer than `lastRun`; the boot reconcile scans the reports dir and, if the newest well-formed report is newer than `lastRun.ts`, adopts it rather than running again. Do not store any of this in `settings.json` — settings are owner-edited configuration (thresholds belong there), state is machine-written, and the `updateSettings` allow-list exists precisely to keep them apart.
- Risk if skipped: Restart loses the accumulation count (first tick after boot sees zero sessions forever if the counter was process-local), or a crash after the report but before the state write produces two reports for one window.
- Depends on: A5, B1

### B6
RECOMMENDATION
- Title: Three roots, three resolving wrappers (EC-7): reports dir (read/write), KB dir (read + archive move only), memory dir (read only) — every id→file mapping is derived from loaded data, never from the request
- AC defended: AC7, AC8, AC9, Must (spec §5 — no paths from request bodies)
- Principle: B6 (slug + path validation at the boundary); EC-7 (predicate inlines realpath or is reachable only via the wrapper)
- What to get right: Each root is realpath'd once at construction (climbing to the nearest existing ancestor for a not-yet-created reports dir) and every file operation goes through a wrapper that joins, realpaths, and bounds-checks against that root before any `fs` call; the predicates are not exported on their own. The only request-supplied identifiers are `entryId`, `decision`, `mergeInto`, and `runId`: `entryId` resolves to a store basename by looking it up in the KB load (the store the id was found in), `runId` must match the current report's id, and the archive target is `archive/<that basename>` with the basename validated against the enumerated `*.jsonl` set — nothing from the body ever becomes a path component. The KB root is the repo's `.agents/knowledge` derived server-side; the memory root is derived from the project slug server-side; the report filename pattern is a strict regex shared by the writer, the "latest" selector, and the retention pruner (EC-20 exported constant).
- Risk if skipped: An `entryId` or `runId` with path separators reaches `join` and reads or rewrites a file outside the three roots — on this box that includes `~/.companion/settings.json` and the OAuth credentials.
- Depends on: —

### B7
RECOMMENDATION
- Title: Byte-for-byte preservation of untouched KB lines plus a compare-and-swap guard against the concurrent `/learn` append on this multi-agent checkout
- AC defended: AC7, AC8
- Principle: B1 (truncating writes lose history); Carmack "if a mistake is possible it will eventually happen"
- What to get right: The live-store rewrite reuses the loader's verbatim line text (raw and entry lines alike) so unparsable rows, whitespace, and key order survive untouched; the only permitted diffs are the removed line and, at most, a final newline added to a file that lacked one (document that one-byte normalisation and pin it in the byte-diff test). Because council pairs and `/learn` append to the same git-tracked stores in the same checkout, the load → rewrite must be one synchronous block with no await, and immediately before the rename the file's size + mtime + inode must equal what was loaded; on mismatch, abort, reload, and retry once, logging `event=kb_analysis.archive_conflict` — never rename over a store that changed underneath. State on the card that an archive decision modifies a git-tracked file (the checkout becomes dirty; the `git pull --ff-only` deploy path cares) so the owner commits it deliberately.
- Risk if skipped: A `/learn` line appended between the load and the rename is silently erased by the full-file replace — the one data loss in this feature that no replay can recover, because the lost line was never in any log.
- Depends on: B4, B6

### B8
RECOMMENDATION
- Title: The memory-dir read-only guarantee is structural and testable: a read-only fs adapter type, a write-rejecting root wrapper, and a spy test over every write primitive — because file permissions on this host do not protect it
- AC defended: AC9, Must (spec §5 — never write to the memory dir)
- Principle: Carmack "use the type system as armour"; EC-42 lineage (mutation-resistance — remove the guarantee, a test goes red)
- What to get right: The memory analyzer receives an adapter that exposes only `readdir`/`readFile`/`stat`, so a write is a compile error; the memory root's resolving wrapper has no write-mode operations at all, so a future helper cannot acquire one by accident; and `memory-report.test.ts` spies on every write-capable primitive (write, append, open with write flags, rename, mkdir, rm/unlink, chmod, utimes, copy, truncate) across both `node:fs` and `fs/promises` and asserts none receives a path under the memory root during a full report plus a "Mark as seen" POST (which must land only in `decisions.jsonl`). Note explicitly in the test why: the memory dir is group-writable by the service user, so "the OS would refuse" is false here. Keep the report-only mode behind `diagnosticsMemoryReport` (default off) and the check must not even `readdir` the memory root when the flag is off.
- Risk if skipped: The owner's hard rule rests on a code-review promise; one refactor that "normalises frontmatter" on load and saves it back rewrites 471 hand-written memory files in a single tick.
- Depends on: B6

### B9
RECOMMENDATION
- Title: Version every new on-disk shape and validate at the load boundary: report `schemaVersion`, `state.json` `schemaVersion`, per-line version in `decisions.jsonl`; a newer version is rejected loudly with a card state, not parsed with defaults
- AC defended: AC5, AC7, AC8
- Principle: B8 (JSON shape evolution — version every schema; runtime validation on load)
- What to get right: Follow the session-store precedent (`CURRENT_..._SCHEMA_VERSION` + a migrate function that returns null on a newer version and stamps the version on an unversioned legacy file). Validate the parsed report with a type guard before it reaches the route — findings array shape, ids, signal names from a closed set — so a hand-edited or truncated report produces "report unreadable (reason)" rather than a crashing render. The decision validator checks `decision` against the closed set and `mergeInto` as a known id in the same report; an unknown `entryId` is 400 (spec), a `runId` that is not the current report's is 409 (the user decided on a stale screen).
- Risk if skipped: A v2 server reading a v1 report silently shows wrong findings; an operator acts on them and archives the wrong entry.
- Depends on: B1, B3, B5

### B10
RECOMMENDATION
- Title: Orphan handling when a run dies mid-write: tmp swept at boot, in-flight marker consumed at boot, latest-selection immune to both — no manual cleanup step ever required
- AC defended: AC5, AC6
- Principle: B3 (sentinel rows for files — close every state on every exit path); A4 (visible, not silent)
- What to get right: Three artefacts can be left behind by a crash: a `.<hex>.tmp` (swept by the B2 reconcile when older than boot), the in-flight marker (consumed by the A4 reconcile, which turns it into a visible "previous run died" state and suppresses auto-trigger), and a report newer than `lastRun` (adopted by the B5 reconcile). All three reconciles register on the hourly scheduler and run once before the first tick; each is idempotent (a second boot with nothing to do is a no-op) and logs a structured line. The `GET latest` handler must work correctly in every combination (marker present + no report, tmp present + valid report, etc.) and `POST /run` after a crash must be allowed immediately because single-flight is in-memory (A2).
- Risk if skipped: After one crash the page shows "running…" forever, the button stays disabled, and the operator's only remedy is deleting files under `~/.companion` by hand — the failure mode the feature was built to replace.
- Depends on: A2, A4, B2, B5

## Watchpoints for the Chair (not separate recommendations)

- `CleanupScheduler`'s timer is not unref'd; a second instance in tests must be disposed in `afterEach` or vitest workers hang. Production is unaffected (`gracefulShutdown` ends with `process.exit`).
- The KB loader normalises a missing final newline on rewrite; the AC8 byte-diff test must allow exactly that one-byte difference and nothing else.
- `exitCode` on the launcher row is also set for spawn failures (1/127/-1) — the A5 `num_turns ≥ 1` gate is what keeps "finished sessions" honest.
- The spec's `kb-health.ts` extraction (fowler) must keep `loadKb` returning verbatim line text; losing that field silently breaks B7.
