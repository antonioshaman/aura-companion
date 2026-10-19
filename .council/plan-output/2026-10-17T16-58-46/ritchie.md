# ritchie — Process Lifecycle (§A) + Filesystem Persistence (§B)

Feature: close #381 gaps (Codex advisory, dead-CLI advisory, handoff pruning) + W17 EC-4 port.
Lens kept partitioned: §A asks "am I measuring/talking to the right process?", §B asks "did this write/delete commit correctly and durably?". Severities follow each section's own ladder.

Files read: `session-recovery.ts` (tick 577-630, `maybeFireCompactionAdvisory` 839-895), `context-size-suggester.ts`, `routes.ts` 1212-1283, `ws-bridge.ts` (`recordContextAdvisory` 361, `session_update` merge 1121, `restoreFromDisk` 510), `session-types.ts` 906-925, `codex-adapter.ts` (`handleTokenUsageUpdated` 3253-3325), `checkpoint-watcher.ts` + `git show 31946bb9`, `review-watcher.ts` 36-70 (filename-contract reference), `session-store.ts` (write path greps), `cli-launcher.ts` `SdkSessionInfo`.

Facts established (not assumptions):
- Codex `context_used_percent` / `last_context_tokens` / `codex_token_details.modelContextWindow` already land on persisted `session.state` via the adapter `session_update` merge → a Codex signal is readable in O(1) with zero file I/O.
- `restoreFromDisk()` hydrates bridge sessions with `backendAdapter: null`, so `recordContextAdvisory()` has a target for a session whose CLI is dead or not yet reconnected.
- `persistSession` → `SessionStore` debounce 150 ms, crash-atomic tmp+fsync+rename (EC-46). `compactionAdvisoryFired` is never pruned (siblings `driftSuppressedLogged`/`driftPrevSnapshot` are).
- In this very repo root: one endpoint file `.aura-handoff-2026-09-19T13-29-57.md` and four owner files `.aura-handoff-2026-10-1{2,4,6,7}.md`. The only distinguishing token is `T\d\d-\d\d-\d\d`.
- The route's filename has 1-second resolution and is written with bare `writeFileSync` (silent overwrite on same-second collision).

Assumptions I'm making: `writeAtomicJson` (checkpoint writer) stages under a dot-prefixed or non-`.json` tmp name (the watcher's dotfile filter relies on it); `launcher.listSessions()` still returns exited sessions (it does — `SdkSessionInfo.state` includes `"exited"`).

---

## §A Process lifecycle

The feature adds no spawn arguments, no signal handling, no idle-kill or relaunch change, no new recording channel. The `continue-in-new` spawn path is untouched. One §A finding remains, because the advisory's *measurement* is anchored to a CLI identity (`cliSessionId` for the Claude transcript, `threadId` for Codex token usage) that the lifecycle can swap underneath it.

### A-1 — Anchor the advisory to the CLI identity it measured, and drop the seed when that identity changes (P2)
- Principle: A5 `--resume` semantics — state drift after resume ("Companion session ID ≠ CLI session ID"); A2 "never trust identity across restarts".
- Defends AC: AC1, AC2.
- What to get right: AC2 deliberately fires on exited sessions, and both backends can come back with a *different* identity — Claude's resume-failure fallback issues a fresh `cliSessionId` (new, tiny transcript at a new path), Codex `startFreshThread` assigns `freshThreadId` and resets the real context while `state.last_context_tokens` / `context_used_percent` keep the OLD thread's last values until the next turn. With the seed read from the persisted record, a fresh identity inherits a "≥5 MB / ≥85 %" record it never earned (banner sticks, handoff draft quotes a size that no longer exists), and a stale Codex percent can fire an advisory on a thread that is empty. Store the measured identity on the record (`cliSessionId`/`threadId`), make the seed conditional on identity equality, and have the tick treat an identity mismatch as "record is historical: do not seed, do not render as current" (clear or mark it; the browser already tolerates `null`). For Codex, the adapter must also reset or re-emit the context fields on `startFreshThread` so the measurement follows the live thread, not the dead one.
- Risk if skipped: A relaunched/fresh-threaded session shows a permanent "continue in a new session" banner (or fires one spuriously) because the persisted seed outlives the process it described.
- Depends on: B-5 (record schema carries the extra field).

No further §A recommendations: no new subprocess surface (argv, signals, idle, relaunch, recordings, zombie/stdio) is touched by AC1–AC4.

---

## §B Filesystem persistence

### B-1 — Deletion allow-list is ONE exported exact pattern + builder; executor refuses anything but a regular-file direct child (P1)
- Principle: B6 "Validate at the boundary"; B5 rotation deletes only what it owns; EC-19 filename contract (`OBSERVER_REVIEW_FILE_PATTERN` + `buildObserverReviewFilename` is the model).
- Defends AC: AC3.
- What to get right: Export `HANDOFF_FILE_PATTERN` anchored both ends with the full literal shape `^\.aura-handoff-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.md$` and `buildHandoffFilename(date)` co-located with the pruner (consumer), and make `routes.ts` call the builder instead of its inline template. Add a round-trip test (`PATTERN.test(build(now)) === true`) plus negative fixtures for the owner's `.aura-handoff-2026-10-17.md`, `.aura-handoff-2026-10-17T.md`, a name with a trailing space, and uppercase `.MD` — a mutant that loosens the regex must fail. The executor reads `readdirSync(cwd, { withFileTypes: true })` (Dirent does not follow symlinks), keeps only `isFile()` entries whose name matches, never recurses, and before `unlinkSync` asserts `resolve(dirname(join(cwd, name))) === resolve(cwd)` as defence-in-depth. Symlinks are skipped, never unlinked (even though unlink on a symlink is harmless, skipping keeps the invariant simple and testable).
- Risk if skipped: A loose or duplicated pattern deletes the owner's hand-written session notes sitting in the same directory — unrecoverable, and the loss is discovered days later.
- Depends on: —

### B-2 — Pure retention selector, AND-policy, ordering by embedded timestamp, age by the more-recent of (embedded ts, mtime) (P1)
- Principle: "Pure decision functions stay pure" (the `nextCompactionMilestone` precedent); B5 rotation invariants — bound storage without losing meaning.
- Defends AC: AC3.
- What to get right: Split `selectHandoffFilesToPrune(entries: {name, mtimeMs}[], now, {keepNewest: 3, minAgeMs: 7 d}) → names[]` (pure, fully unit-tested) from the FS executor. Delete only when BOTH hold: the file is outside the newest-3 by the timestamp parsed from its own name (not mtime — editors, `git checkout`, rsync all touch mtime), AND its age by `max(embeddedTs, mtime)` exceeds 7 days (a handoff the owner edited last week stays). Unparseable embedded timestamps → never a candidate (they shouldn't pass the pattern, but the selector must not trust that). The just-written filename is excluded by name, not by position: if the system clock stepped backward the new file can sort "older" than existing ones. Boundary tests: exactly 3 matching files → nothing; 4 files, oldest 6d23h → nothing; 4 files, oldest 7d+1s → exactly that one; a future-dated file → kept.
- Risk if skipped: The two conditions get implemented as OR, or ordering uses mtime, and a 3-day-old handoff another live session's pickup draft still references vanishes mid-task.
- Depends on: B-1.

### B-3 — Pruning runs after `createSession` succeeds, is failure-isolated per file, bounded, idempotent under ENOENT, and every unlink is a structured log line (P2)
- Principle: B3 close every state on every path (no half-done sweep); EC-9 structured logs; Carmack "deploy assertions as tripwires".
- Defends AC: AC3.
- What to get right: Order in the route: write handoff → `createSession` → on `ok` only, prune → respond. A failed spawn leaves the directory untouched (the user retries; no deletions have happened on a failed handoff). Wrap the whole prune in one try/catch that logs `event:"handoff.prune_failed"` and never alters the response, and wrap each unlink individually so one EACCES does not skip the rest. Treat ENOENT on unlink as success (two tabs can run continue-in-new on the same cwd within seconds; the loser must not warn). Cap deletions per request (e.g. 20) and log `event:"handoff.prune_capped"` beyond it — an unexpectedly large match set is a signal, not a chore. Per deletion: `event:"handoff.pruned"`, `sessionId`, `cwd`, `file` (basename), `ageMs`, `keptCount` — never contents.
- Risk if skipped: A permission error in a shared worktree turns a successful handoff into a 500, or a racing second tab logs spurious failures that mask real ones.
- Depends on: B-2.

### B-4 — Builder makes the handoff write collision-safe and atomic; tmp name must not match the pattern (P2 — scope-adjacent, state it)
- Principle: B1 "atomic write or it didn't happen"; B6 filename contract.
- Defends AC: AC3 (adjacent: the builder introduced for AC3 is the one place this belongs; it is not an explicit AC — chair decides).
- What to get right: The route's comment claims the timestamp prevents collisions, but it has 1-second resolution; two handoffs in one second (double-click, two tabs) silently overwrite the first markdown and the pruner later sees one file where two sessions' drafts point. Open with `wx` (O_EXCL) and on EEXIST bump the second (or append a short suffix the pattern allows — then widen the pattern deliberately, in one place). Stage to a name that can NEVER match `HANDOFF_FILE_PATTERN` (e.g. `.aura-handoff-<ts>.md.tmp-<pid>`) and `renameSync` into place so a crash never leaves a truncated file bearing the canonical name; unlink the tmp on failure.
- Risk if skipped: A truncated or overwritten handoff is exactly what the new session reads first — the recovery artifact itself is the corrupted record.
- Depends on: B-1.

### B-5 — Advisory record carries a discriminated `signal`; seeding is per-signal; legacy records default to `transcript_bytes` (P2)
- Principle: §B schema versioning and evolution; B2 "debounced write must snapshot canonical state".
- Defends AC: AC1 (and keeps AC2 unchanged for Claude).
- What to get right: Codex signal choice: use the persisted `state.context_used_percent` (derived from `last.inputTokens + last.outputTokens / modelContextWindow` — literally what is in the window), NOT `JSON.stringify(messageHistory).length`: the latter costs O(bytes) CPU per session per 15 s tick, is inflated by the very base64 payloads the handoff strips, and says nothing about the model's context. Claude stays bytes (developer decision). The record therefore needs `signal: "transcript_bytes" | "context_percent"` plus a signal-typed `milestoneValue`; keep `milestoneBytes` optional and populated ONLY for the bytes signal (never stuff a percent into a field named bytes — the route reads `milestoneBytes` to print "> N MB" in the pickup draft). Seeding `lastFired` in the tick must read the persisted value only when `record.signal` equals the signal being evaluated; a record with no `signal` (every record persisted before this change) is read as `transcript_bytes`. `nextCompactionMilestone` stays pure: pass the measured number and a ladder descriptor (milestones, messages, handoff-min) — the function must not know where the number came from. Flag to the React/UI expert: the browser's per-milestone dismissal key must incorporate `signal` or Codex and Claude milestones collide in localStorage.
- Risk if skipped: Bytes vs percent get compared on one axis (5_000_000 vs 85): Codex never fires, or the Claude seed suppresses nothing, or the handoff draft tells the user "> 0 MB".
- Depends on: —

### B-6 — Fire is a two-phase sentinel: mark in-memory only after the persisted record commits; log when it cannot (P2)
- Principle: B3 sentinel discipline — close every state on every path; B2 debounce as correctness window.
- Defends AC: AC1, AC2.
- What to get right: Today `compactionAdvisoryFired.set(...)` happens BEFORE `recordContextAdvisory()`, which returns `false` when the bridge has no session (restored launcher record without a bridge twin, or a mid-restart race). AC2 widens the loop to exited sessions, so this path becomes reachable: the in-memory mark says "fired", nothing is persisted, the banner is never shown again for the process lifetime. For the handoff tier, set the in-memory mark only when `recordContextAdvisory` returns `true`; on `false` log `event:"context_size.advisory_unrecorded"` + `sessionId` and leave the mark unset so the next tick retries. The 150 ms persistence debounce means a crash inside the window re-fires the same milestone after restart — acceptable and idempotent (same milestone, `at` bumps), but the AC1 "survives restart" test must simulate it honestly: empty in-memory map, persisted record present, assert NO re-fire; and a second test with persisted record absent asserts exactly one fire. A mutant that drops the `persisted` seed fails the first; a mutant that always returns `null` fails the second.
- Risk if skipped: A dead Claude session at 8 MB silently never gets its one-click exit, and the operator only learns when the session is wedged.
- Depends on: B-5.

### B-7 — Advisory tick stays O(sessions) with one `statSync` max, and the in-memory map is pruned with its siblings (P3)
- Principle: Carmack "if you can't see the cost, you can't reason about correctness"; B5 bound growth.
- Defends AC: AC2.
- What to get right: Lift the advisory out of the drift gates into its own loop over `launcher.listSessions()` (skip only `archived`; skip `starting`/no-`cliSessionId` because `resolveCliSessionPaths` returns null anyway) so the two concerns cannot silently re-couple. Per session: Claude → one `statSync`; Codex → read `state.context_used_percent`, no I/O. Skip the stat entirely when the seeded `lastFired` already equals the ceiling milestone (10 MB) — those are precisely the dead, huge transcripts AC2 adds, and there is nothing left to say. Prune `compactionAdvisoryFired` for ids no longer listed, exactly as the two sibling maps already do two lines above it.
- Risk if skipped: Dozens of non-archived exited sessions add a stat each per 15 s forever, and the map grows for the server's lifetime — small, but it is the kind of leak that only shows on the 3-week-uptime prod box.
- Depends on: B-6.

### B-8 — EC-4 port: document the residual coalescing window, pin the FS granularity assumption, and make the test count payloads, not events (P2)
- Principle: B2 debounce is a correctness window; §B FS-assumption portability; EC-4 / EC-6.
- Defends AC: AC4.
- What to get right: Port 31946bb9 as-is (it is the accepted review-watcher mirror), but add two honesty notes in the `superseded` doc comment: (1) the key is captured by an `await stat()` AFTER the event, so two renames closer together than that stat latency both observe the second mtime and still coalesce — the mechanism catches the *common* race, not all of them; (2) `mtimeNs` equality assumes ns-granularity mtime (ext4/APFS/tmpfs ok; HFS+ 1 s and FAT 2 s make two writes in one tick indistinguishable) — state the supported filesystems. The AC4 test must use the `debounceMs` seam (raise it), write two payloads with distinct `checkpoint_id` separated by a few ms so mtimes differ, and assert `emitted.length + superseded.length === 2` with both ids accounted for — a mutant that always coalesces (`clearTimeout` without `onDropped`) fails because 1 ≠ 2, and a mutant that always drops fails because the emitted id set is wrong. Confirm the writer's tmp staging name is dot-prefixed or non-`.json` so the watcher never stats a half-written file (if it is not, the stat-after-event key is of the tmp file and the port is meaningless). Abort path: the `finally` must clear `entry.timer` (the port does) — keep the existing abort test green.
- Risk if skipped: The port lands with a test that passes when both events coalesce (counting "at least one emit"), and a lost checkpoint — the observer never waking — stays silent, which is exactly what EC-4 exists to forbid.
- Depends on: —

### B-9 — Writer-side unique checkpoint filenames (P3 — scope creep, flagged for the chair)
- Principle: B5 rotation/overwrite invariants; EC-19 filename contract.
- Defends AC: none — explicitly outside AC1–AC4; recorded so the residual in B-8 has a named root fix.
- What to get right: The only complete cure for "two distinct payloads on one inode in the window" is to never share the inode: suffix `buildCheckpointFilename` with a monotonic sequence or the `checkpoint_id` so each checkpoint is its own file, with the EC-13 failsafe/`scanForMissedObserverWakes` reading all of them. This changes the writer contract and the readers' glob and belongs in its own plan.
- Risk if skipped: The mtime-key port remains a detector with a known blind spot rather than a guarantee.
- Depends on: B-8 (ships first; this supersedes its residual).

---

## PR split check (developer proposal)
- PR-A (AC1+AC2): A-1, B-5, B-6, B-7. B-5 must land before B-6's seeding logic (record shape first).
- PR-B (AC3): B-1 → B-2 → B-3, B-4 in that dependency order; B-4 is the one scope-adjacent item — include or split, but do not leave the 1-second collision undocumented in the route comment.
- PR-C (AC4): B-8; B-9 is a follow-up spec, not part of this PR.
