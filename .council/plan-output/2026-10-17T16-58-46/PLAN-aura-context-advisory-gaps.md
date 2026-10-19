# Council Plan (Aura): Close the #381 context-overflow handoff gaps + W17 EC-4

**Plan file:** `.council/plan-output/2026-10-17T16-58-46/PLAN-aura-context-advisory-gaps.md`
**Expert outputs:** `dahl.md`, `ritchie.md`, `fowler.md`, `hunt.md` in the same directory.

**Scope:** (1) Codex sessions receive the same `context_advisory` + banner as Claude; (2) the advisory fires for non-archived sessions even when the CLI is disconnected/exited; (3) endpoint-written `.aura-handoff-<ts>.md` files are pruned conservatively; (4) `checkpoint-watcher.ts` gets the EC-4 `(file, mtimeNs)` supersede keying.
**Context:** PR #381 bolted the advisory onto the silent-stdio drift tick, inheriting its Claude-only / connected-only gates. The handoff route already works from in-memory `messageHistory` for both backends, so the banner is the only missing piece for Codex and dead sessions. Handoff files accumulate in every workspace. The checkpoint watcher is the last fs watcher that can silently coalesce two payloads.
**Boundaries:** no landing (#376 shipped separately), no backend restart in this plan, no change to Claude's byte thresholds, no new WS message type, no startup sweep of handoff files, no identity-anchoring of the advisory record (watchpoint only), no shared debounce helper, no writer-side unique checkpoint filenames (follow-up spec).
**Council dispatched:** economy roster from the selection engine (dahl, beck, fowler) + chair re-adds (ritchie: filesystem/lifecycle is the core of items 2–4; hunt: the feature deletes files in a user cwd). beck has no `plan-aura` catalog prompt (review-only seat) → test-quality is defended at review time; its AC coverage (mutation-resistant tests) is written into each task below. All four dispatched seats returned recommendations.

**Decisions taken by the Chair (Carmack filter):**
- Codex signal = `state.context_used_percent` (main-thread `last.inputTokens+outputTokens / modelContextWindow`, already persisted by the adapter). Unanimous (dahl R1, fowler D1, ritchie B-5, hunt R4). Rejected: `JSON.stringify(messageHistory)` per tick (O(history) CPU, measures the payload the handoff strips, never shrinks after Codex compaction) and rollout bytes (~34 KB on prod → dead ladder).
- Codex ladder = ONE rung, 90 % → `continue_in_new`. No `/compact` tier for Codex (not verified that app-server exposes it; a tier that promises an unverified action is worse than none).
- Record gains `signal` + unit-typed `milestone`; `milestoneBytes` becomes optional and bytes-only (dahl R2 / ritchie B-5 / fowler Rec 3 agree). Browser touch is deliberate and small: dismissal key and header read `milestone`/`signal`.
- Age for pruning = conjunction of BOTH the embedded timestamp AND mtime being older than 7 days (ritchie B-2 reconciles hunt "mtime" vs fowler "name": `max(embeddedTs, mtime)`); ordering for "newest N" by embedded timestamp.
- hunt R3 (`cliSessionId` segment validation) is ALREADY implemented (`CLI_SESSION_ID_PATTERN` at `silent-stdio-drift-detector.ts:656`); only a negative test is added.
- ritchie A-1 (anchor the record to `cliSessionId`/`threadId`) → watchpoint, not a task: the only bad outcome is a stale banner after a fresh-identity relaunch, which the user can dismiss; `lastFired` is monotonic so no spurious re-fire is possible.
- ritchie B-4: collision safety via `wx` + retry with a bumped second (cheap); no tmp+rename staging for a one-shot ≤ 220 KB markdown (cost > benefit).
- PR split confirmed: PR-A = Tasks 1–5 (branch `fix/context-advisory-codex-and-disconnected`), PR-B = Tasks 6–8 (`fix/handoff-file-pruning`), PR-C = Task 9 (`fix/checkpoint-watcher-ec4-supersede`, already open as #382). Any order; no cross-PR coupling because `milestoneBytes` stays bytes-only.

---

## Task Sequence

### 1. Extract the advisory into its own tick pass (behaviour-preserving move first)
| | |
|---|---|
| **Domain** | fowler × Carmack — P6 separate things that change for different reasons / P8 refactor ≠ add function |
| **Ref** | `references/refactoring.md` → P6, P8; ritchie B-7 |
| **Depends on** | — |
Give the advisory a `contextAdvisoryTick()` sibling invoked from the same interval callback and the same `trackSync` wrapper, iterating `launcher.listSessions()` with only the `archived` gate; delete the call inside `driftDetectorTick`. Rename `maybeFireCompactionAdvisory` → `maybeFireContextAdvisory` and `compactionAdvisoryFired` → `contextAdvisoryFired`, and prune that map for unlisted ids next to its two sibling maps. First commit keeps the Claude gate identical so the existing three advisory tests pass unchanged. Per-session try/catch with `event:"context_advisory.tick_session_failed"` so one bad session cannot starve the rest (dahl R4).

### 2. Ladder descriptor + Codex percent ladder in `context-size-suggester.ts`
| | |
|---|---|
| **Domain** | dahl × Carmack — A8 type safety at the boundary; fowler Rec 2 |
| **Ref** | `references/quality-dahl.md` → A8; `refactoring.md` → P2, P5 |
| **Depends on** | — |
Lift milestones + messages + handoff-min into one exported ladder descriptor with the bytes ladder as the default (every existing test passes unchanged), and add a percent ladder for Codex with a single 90 % rung whose copy says what Aura measured ("Codex context window is 90 % full…"). `nextCompactionMilestone`/`advisoryActionFor` take the descriptor; they never learn where the number came from. Pure, fully unit-tested, including the rule that a ladder rung without copy yields null.

### 3. Discriminated advisory record (`signal`, `milestone`, optional `milestoneBytes`)
| | |
|---|---|
| **Domain** | ritchie §B × Carmack — schema evolution; dahl R2; fowler Rec 3 (names that lie) |
| **Ref** | `references/quality-ritchie.md` → §B schema versioning |
| **Depends on** | Task 2 |
Extend `ContextAdvisoryRecord` and `ContextAdvisoryPayload` with `signal: "transcript_bytes" | "context_percent"` and `milestone: number`; `milestoneBytes` becomes optional and is populated only for the bytes signal. Readers treat a persisted record without `signal` as bytes (no migration). The route keeps reading `milestoneBytes` for the "> N MB" quote, so a Codex handoff never prints a nonsense size. Browser: `ContextAdvisoryNotice` keys dismissal on `milestone ?? milestoneBytes`, the banner header shows "over N MB" for bytes and "N % full" for percent; `ws.ts` legacy-frame seeding compares `milestone`. Update the banner tests (render, axe, percent variant) and the Playground with a Codex-percent mock.

### 4. Measure → decide → fire per backend, with commit-before-mark
| | |
|---|---|
| **Domain** | dahl × Carmack — A1 swallowed failure on durable state; ritchie B-6 sentinel discipline |
| **Ref** | `references/quality-dahl.md` → A1, A6; `quality-ritchie.md` → B2/B3 |
| **Depends on** | Tasks 1–3 |
Inside the new pass: Claude → `resolveCliSessionPaths` + ONE `statSync` (drop the connected/`ClaudeAdapter` gates; skip the stat when `lastFired` already equals the ceiling); Codex → read `state.context_used_percent`, no I/O. Seed `lastFired` from the persisted record only when its `signal` matches the ladder in use. Advance the in-memory mark only after `recordContextAdvisory` returns true; on false log `event:"context_advisory.record_skipped"` and let the next tick retry. For the percent signal do not emit the legacy `error` frame (its browser handler is bytes-shaped); `session_update` is authoritative. Narrow the bare stat catch to ENOENT/EACCES-silent, else log.

### 5. Tests for AC1/AC2 (mutation-resistant)
| | |
|---|---|
| **Domain** | beck (review-time) × Carmack — EC-42 |
| **Ref** | `references/quality-testing.md`; ritchie B-6 test design |
| **Depends on** | Task 4 |
In `session-recovery.test.ts`: (a) exited Claude session with no adapter and a 5.5 MB sparse jsonl fires once with `signal:"transcript_bytes"`; (b) connected session behaviour unchanged (existing tests); (c) Codex session at 92 % fires once with `signal:"context_percent"`, `milestoneBytes` undefined, no legacy frame; same session at 50 % never fires; (d) persisted Codex record seeds → no re-fire; persisted bytes record does NOT seed the percent ladder; (e) `recordContextAdvisory` returning false leaves the mark unset and the next tick fires again; (f) negative test for `resolveCliSessionPaths("../../etc/passwd")` → null.

### 6. Handoff filename contract module `handoff-files.ts`
| | |
|---|---|
| **Domain** | ritchie §B × Carmack — filename-contract convention (B-1); hunt R1; fowler Rec 5 |
| **Ref** | `references/quality-ritchie.md` → B6; `conventions.md` filename contract (reference `OBSERVER_REVIEW_FILE_PATTERN`) |
| **Depends on** | — |
New small module owning the name lifecycle: anchored exact `HANDOFF_FILE_PATTERN` (`^\.aura-handoff-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.md$`), `buildHandoffFilename(date)` that self-asserts against the pattern, and `parseHandoffTimestamp(name)`. Tests: round trip; negatives for the owner's date-only name, `T` without time, `.md~`, `.MD`, trailing space, the legacy fixture `…T013747.md`.

### 7. Pure retention selector + failure-isolated pruner
| | |
|---|---|
| **Domain** | ritchie §B × Carmack — B-2/B-3; hunt R1/R2; dahl R6; fowler Rec 6 |
| **Ref** | `references/quality-ritchie.md` → B3, B5; `security.md` → P1 path traversal, P3 minimise state |
| **Depends on** | Task 6 |
`selectHandoffFilesToPrune(entries, nowMs, {keepNewest: 3, minAgeMs: 7 d, exclude})` is pure over `{name, mtimeMs}`: order by embedded timestamp, keep newest 3, delete only when BOTH embedded timestamp and mtime are older than 7 days, never the just-written name, unparseable → never a candidate. `pruneHandoffFiles({cwd, sessionId, keep})` does one non-recursive `readdirSync(withFileTypes)`, keeps `isFile()` dirents (symlinks skipped) matching the pattern, `lstat`s only those, asserts the join resolves directly inside `resolve(cwd)`, unlinks with per-file try/catch (ENOENT = success), caps at 20 with `event:"handoff.prune_capped"`, logs `event:"handoff.pruned"` (`sessionId`, `cwd`, `file`, `ageMs`) per unlink and `event:"handoff.prune_failed"` per failure, never throws. Boundary tests: exactly 3 → nothing; 4 with oldest 6d23h → nothing; 7d+1s → that one; future-dated kept; symlink + nested dir + owner file untouched on a real tmpdir.

### 8. Route uses the builder, writes collision-safe, prunes after a successful spawn, leaks no path
| | |
|---|---|
| **Domain** | dahl × Carmack — A2 boundary / A1 operational errors; ritchie B-3/B-4 |
| **Ref** | `references/quality-dahl.md` → A1, A2 |
| **Depends on** | Task 7 |
`routes.ts` calls `buildHandoffFilename`, opens with `wx` and on EEXIST retries with the next second (max 3), returns a generic 500 message while logging the detail. Prune only after `createSession` succeeded, inside its own try/catch, before the response. Route tests: a stale endpoint-format file is removed, the owner's date-only file and a symlink survive, a prune failure still yields 200, a failed spawn deletes nothing.

### 9. PR-C (#382) finishing touches
| | |
|---|---|
| **Domain** | ritchie §B × Carmack — B-8 honesty notes; dahl R7 drop-reason consumer; EC-9 |
| **Ref** | `conventions.md` EC-4, EC-9 |
| **Depends on** | — |
On top of the ported commit: wire an `onDropped` in `council-lifecycle.ts` for the checkpoint (and review) watcher that logs `event:"council.watcher.dropped"` with `sessionGroupId`, `kind`, `file`, `reason`, `detail` (mtimes only, never payload). Add the two honesty notes to the `superseded` doc comment (stat-after-event residual window; ns-mtime filesystem assumption). Confirm the ported test counts payloads (`emitted + superseded === 2` with both ids accounted for).

---

## Risks & Watchpoints
- **ritchie A-1 — identity drift:** a fresh `cliSessionId`/`threadId` after relaunch inherits the persisted record; the banner may be stale until dismissed. Monotonic `lastFired` prevents re-fires. Revisit if users report sticky banners.
- **dahl R2 — legacy frame is bytes-shaped:** never send the `error`+advisory frame for the percent signal; old browsers simply don't get a Codex banner until reload.
- **ritchie B-8/B-9 — residual coalescing window:** two renames faster than one `stat()` still coalesce; the complete fix is unique checkpoint filenames (own spec).
- **hunt adjacent — handoff file mode 0o644 and `String(err)` in a 500 body:** mode is an owner decision (not changed); the error-body leak is closed in Task 8.
- **Codex `context_used_percent` resets to 0 at adapter init** and after `context_compacted`; with a monotonic seed this never re-fires — document in code.
- **fowler watch list:** `session-recovery.ts` is the next god module; if a third per-tick concern appears, move the tick loop to its own file.

## External Setup Required
No external setup required. All tasks can be implemented within the codebase.

## Summary
| # | Task | Domain | Depends on |
|---|------|--------|------------|
| 1 | Extract advisory tick pass (move + rename + prune map) | fowler / ritchie | — |
| 2 | Ladder descriptor + Codex 90 % ladder | dahl / fowler | — |
| 3 | Discriminated record + minimal browser touch | ritchie §B / dahl | 2 |
| 4 | Measure→decide→fire per backend, commit-before-mark | dahl / ritchie | 1–3 |
| 5 | AC1/AC2 tests | beck (review) | 4 |
| 6 | `handoff-files.ts` filename contract | ritchie §B / hunt | — |
| 7 | Pure selector + pruner | ritchie §B / hunt / fowler | 6 |
| 8 | Route: builder, `wx`, prune-after-spawn, no path leak | dahl / ritchie | 7 |
| 9 | #382 finishing touches (onDropped EC-9, honesty notes) | ritchie §B / dahl | — |

## Verdict
The load-bearing decision is the signal choice for Codex: reading the percent the adapter already persists keeps the tick O(1) per session with zero new I/O and avoids a second writer of `context_advisory`. The highest-risk surface is Task 7 (the server deleting files in a user cwd), where the exact-pattern allow-list, `isFile()`-only dirents and the AND retention policy are the whole safety story — start with Tasks 6–7 and their negative fixtures. ritchie's §B lens is the one to keep open during the build.
