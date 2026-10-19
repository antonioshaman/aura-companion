# Fowler — structural design / refactoring

Expert: Martin Fowler (refactoring, module boundaries). Reference: `council-plan-aura/references/refactoring.md`.
Files read: `context-size-suggester.ts`, `session-recovery.ts` (tick + `maybeFireCompactionAdvisory`), `ws-bridge.ts` (`recordModelFallback`/`recordContextAdvisory`), `session-types.ts` (advisory types), `routes.ts` (continue-in-new), `codex-adapter.ts` (`handleTokenUsageUpdated` → `applyMainThreadTokenUsage`), `codex-turn-usage.ts`, `review-watcher.ts` (EC-4 block + filename contract), `checkpoint-watcher.ts` (grep), `handoff-extractor.ts` (exports), `git show --stat 31946bb9`.

## Decisions taken (stated, not asked)

- **Codex signal = context-window tokens from `thread/tokenUsage/updated`, consumed from `session.state` (already written by `applyMainThreadTokenUsage` as `context_used_percent` / `last_context_tokens` / `codex_token_details.modelContextWindow`), NOT `messageHistory` size.** Reasons: (1) `messageHistory` never shrinks after Codex's internal compaction, so a healthy compacted session would fire forever; (2) it measures Aura's own copy including base64 images — the payload the handoff strips, i.e. it measures the wrong thing; (3) tokens-in-window is the quantity that actually wedges a Codex thread, and it is already on state — zero new I/O, zero new adapter plumbing. Measured value for the ladder: `last.inputTokens` of the main thread as a fraction of `modelContextWindow` (a percent ladder, e.g. two rungs where the top rung is `continue_in_new`). The exact rungs are a product call; structurally they live next to the Claude rungs (Rec 2).
- **The existing pure suggester already is unit-agnostic** — `nextCompactionMilestone(current, lastFired, milestones, messages)` takes the ladder and copy as parameters. Reuse it with a Codex ladder + Codex copy. Do NOT build a `ContextSignalSource` strategy/interface (Speculative Generality, two concrete backends).
- **Assumption:** `ContextAdvisoryBanner` renders the server-authored `message` string and uses `milestoneBytes` only as the per-milestone dismissal key. If it also formats `milestoneBytes` as "N MB", Rec 3's discriminator is what lets the browser branch — but that browser change is then PR-A scope, not "unchanged".
- **PR split A/B/C confirmed**, with sequencing C → B → A (C is a pure port with no dependencies; B touches only the route + a new module; A is the only behaviour change in shared code). PR-A must be two commits (Rec 1 then Rec 2) per Principle 8.

---

### Rec 1 — Move the advisory out of the drift gate as a sibling pass, in a behaviour-preserving commit first
- Principle: P6 "different parts changing for different reasons should be separated" + P8 "when refactoring, don't add function".
- Defends AC: AC2 (and is the precondition for AC1).
- What to get right: `driftDetectorTick()` has three gates (`backendType !== codex`, `state ∈ {connected, running}`, `adapter instanceof ClaudeAdapter`) that are correct for drift recovery and wrong for the advisory. Give the advisory its own method (`contextAdvisoryTick()`) invoked from the SAME `setInterval` callback and the same `trackSync` wrapper — no new timer, no new module — iterating `launcher.listSessions()` with only the `archived` gate, and delete the call inside `driftDetectorTick`. Commit 1 of PR-A is the move with the Claude gate temporarily kept identical (tests unchanged, proving behaviour-preservation); commit 2 drops the connected/adapter gate and adds Codex. Rename `maybeFireCompactionAdvisory` → `maybeFireContextAdvisory` and `compactionAdvisoryFired` → `contextAdvisoryFired` in commit 1 (the name lies: it fires handoff advisories too).
- Risk if skipped: the advisory stays a passenger on a gate it does not own; every future drift-gate change silently changes advisory reach (exactly how #381 shipped with AC2 missing), and Codex support would have to be bolted into a method whose doc says "Codex-half sessions are skipped".
- Depends on: —

### Rec 2 — One impure "measure" step per backend, one pure "decide", one visible "fire" sequence; ladders + copy co-located in `context-size-suggester.ts`
- Principle: P2 "extract pure logic, keep mutations visible and sequential"; P5 Speculative Generality (avoid).
- Defends AC: AC1, AC2.
- What to get right: inside `contextAdvisoryTick` structure each session as three sequential steps that stay in `session-recovery.ts`: (a) *measure* — a `switch (info.backendType)`: Claude → `resolveCliSessionPaths` + one `statSync` (the only I/O; keep the existing try/catch-skip); Codex → read `bridgeSession.state.last_context_tokens` and `codex_token_details.modelContextWindow` (no I/O; skip when absent). (b) *decide* — call the existing pure `nextCompactionMilestone` with the backend's ladder/copy; add the Codex ladder and `MESSAGE` map as new exported constants in `context-size-suggester.ts` next to the byte ones so one file owns every threshold and every string (`advisoryActionFor` needs a per-ladder handoff floor rather than the hard-coded 5 MB — pass it in, keep it pure). (c) *fire* — the unchanged `recordContextAdvisory` + legacy broadcast, visibly inline. Do NOT fire from `codex-adapter.handleTokenUsageUpdated`: that creates a second writer of `context_advisory` (adapter event path vs tick path), and the adapter must not know about persistence. Keep O(sessions): no extra `readdir`, no reading `messageHistory`.
- Risk if skipped: a "signal source" abstraction or a second firing site in the adapter makes "why did the banner appear/disappear" a two-module investigation and lets Claude and Codex advisories drift apart in copy and thresholds.
- Depends on: Rec 1.

### Rec 3 — Add a `signal` discriminator to `ContextAdvisoryRecord`/payload (additive); keep `milestoneBytes` as the dismissal key but stop reading it as bytes where the signal is tokens
- Principle: P4 "names that lie" (P2 severity); P5 Shotgun Surgery via the typed cascade (acceptable, the type IS the contract).
- Defends AC: AC1.
- What to get right: `milestoneBytes` becomes a lie the moment Codex writes a token count into it, and `routes.ts` already consumes it as `contextBytes` for the "> N MB" handoff quote — a Codex handoff would say "0.2 MB". Add `signal: "transcript_bytes" | "context_tokens"` to the record and the wire payload (absent on persisted records → treat as `transcript_bytes` at the read site, no migration), and have the route pass `contextBytes` only when `signal === "transcript_bytes"`. Keep `milestoneBytes` populated with the raw milestone value in the signal's unit so the browser's per-milestone dismissal still works without a browser change (a session has exactly one backend, so keys never collide). Record the rename `milestoneBytes → milestone` as a follow-up mechanical refactor across `session-types → ws-bridge → ws.ts → ContextAdvisoryBanner`; do not do it inside PR-A.
- Risk if skipped: the first Codex handoff file and pickup draft quote a nonsense byte size, and every later reader of the record has to guess the unit from the backend.
- Depends on: Rec 2.

### Rec 4 — Keep `ws-bridge.ts` a read-only dependency of the advisory; no new bridge methods
- Principle: P3 "if mutation paths fan out beyond ~3 sites, encapsulate" + P6 god-module containment.
- Defends AC: AC1, AC2 (indirectly — it is a constraint on how they are implemented, not scope creep).
- What to get right: `recordContextAdvisory` is already the single writer of `state.context_advisory` and a 7-line sibling of `recordModelFallback`. The Codex path needs only `getSession(id)?.state` reads. Do not add `recordCodexContextAdvisory`, do not let the adapter write the field, do not generalise the two `recordX` methods into a "persisted notice" helper yet — two instances is below the Rule of Three; revisit when a third notice type arrives.
- Risk if skipped: a third write path into session state from the bridge's biggest fear-zone, for a feature that needs none.
- Depends on: —

### Rec 5 — Filename contract: `HANDOFF_FILE_PATTERN` + `buildHandoffFilename()` in a new `handoff-files.ts`, route switched to the builder
- Principle: P5 Shotgun Surgery / cross-module filename contract convention (reference `OBSERVER_REVIEW_FILE_PATTERN` + `buildObserverReviewFilename`).
- Defends AC: AC3.
- What to get right: the name is currently an inline template literal in `routes.ts` (line 1247) and a comment in two browser files — the deleter's allow-list must be derived from the same source as the writer. Put the pattern (anchored, exact shape `.aura-handoff-YYYY-MM-DDTHH-MM-SS.md`, so the owner's date-only `.aura-handoff-2026-10-17.md` fails the `T..` segment by construction) and the builder in a new small module `web/server/handoff-files.ts`, with the builder self-asserting against the pattern like `buildObserverReviewFilename` does. Do not put it in `handoff-extractor.ts` (that file is about content; the filename lifecycle changes for different reasons) and not in `routes.ts` (already a 1200+ line route bag). Replace the inline template in the route with the builder — mechanical, same bytes out.
- Risk if skipped: the first timestamp-format tweak in the route silently puts every existing handoff file outside the pruner's allow-list (safe) or, worse, a widened regex inside it (unsafe).
- Depends on: —

### Rec 6 — Pruner = pure selector over directory entries + thin impure wrapper; called once, after a successful spawn, failure-isolated
- Principle: P2 "extract pure logic, keep mutations visible"; P7 tests on changed code (EC-42 mutation-resistant).
- Defends AC: AC3.
- What to get right: split `selectHandoffFilesToPrune(entries, now, policy)` — pure, takes already-filtered `{name, isFile}` entries, parses the timestamp FROM THE NAME (not mtime: deterministic, and the owner opening a file in an editor cannot change its age), applies BOTH rules (outside newest N=3 AND older than 7 days) — from `pruneHandoffFiles(cwd, policy, log)` which does `readdirSync(cwd, {withFileTypes:true})`, keeps only `isFile()` dirents (never follows symlinks, never recurses), filters by `HANDOFF_FILE_PATTERN`, calls the selector, `unlinkSync`s each, and logs one structured line per deletion (`event`, `sessionId`, `cwd`, `file`) and one per failure. In the route call it after `createSession` succeeded and before the response, inside its own try/catch so no pruning error can alter the status code. Unit-test the selector on fixture arrays (including the date-only owner name, a `.md~` backup, a future timestamp, exactly-N files, exactly-7-days boundary); integration-test the wrapper on a real tmpdir with a symlink and a nested dir.
- Risk if skipped: a readdir+regex+unlink blob inside the route handler is untestable without spawning a session, and the first time the policy changes somebody edits the regex in place.
- Depends on: Rec 5.

### Rec 7 — PR-C ports ONLY the two checkpoint-watcher files from 31946bb9; resist extracting a shared debounce core
- Principle: P8 "refactoring is not restructuring"; P1 economic test; Rule of Three.
- Defends AC: AC4.
- What to get right: commit 31946bb9 bundles the EC-4 watcher port with an EC-5 Codex frame-drift guard and tests in `codex-adapter.ts` / `claude-adapter.test.ts`. Take `web/server/checkpoint-watcher.ts` + `checkpoint-watcher.test.ts` only (path-restricted checkout/cherry-pick), keep the `debounceMs` option name identical to `review-watcher`'s so the test seam vocabulary matches. After the port the two watchers share ~40 duplicated lines of `(file, mtimeNs)` debounce logic. Leave it: the payload types, drop-reason unions, and filename filters differ, both files are stable, and a generic `debounceByMtime<T>` would be a third thing to understand for no planned change. Flag as P3 in the PR description.
- Risk if skipped: the EC-5 guard rides into a PR labelled "W17 EC-4 port", and a reviewer cannot verify either; an eager extraction turns a 10-minute port into a cross-watcher refactor with regression surface in Council Mode.
- Depends on: —

### Rec 8 — Test seams for the decoupled tick: inject the clock and the size reader, not the filesystem
- Principle: P7 "tests coupled to implementation discourage refactoring"; P2.
- Defends AC: AC1, AC2.
- What to get right: AC2's test needs a launcher session with `state: "exited"` and no adapter, plus a transcript size ≥ 5 MB. Do not write a 5 MB file per test; if the existing `session-recovery.test.ts` fixtures do not already pass an injectable size reader, add one optional dep (`statSize?: (p) => number`) on the orchestrator's deps object next to the existing `undeliveredOutput`/`subagentActivitySince` seams — same pattern, one line. AC1's test seeds `state.context_advisory` with a Codex record and asserts no re-fire, then raises `last_context_tokens` past the next rung and asserts exactly one `recordContextAdvisory` call with `signal: "context_tokens"`.
- Risk if skipped: tests that depend on real multi-MB files or on `ClaudeAdapter` instances will break on the next drift-detector change, teaching the team to stop touching the tick.
- Depends on: Rec 1, Rec 2.

---

## Where complexity will accumulate (watch list)

1. `session-recovery.ts` is the next god module after `ws-bridge.ts` — drift verdicts, relaunch policy, Council reconcile, and now the advisory tick. The sibling-pass shape (Rec 1) keeps it additive; if a third per-tick concern appears, the tick loop becomes its own file with the passes as plain functions taking `(info, bridgeSession)`.
2. Thresholds and copy: as long as every ladder/message lives in `context-size-suggester.ts` (Rec 2), tuning is a one-file change; the day a rung is hard-coded in the tick or the adapter, it is shotgun surgery.
3. The `recordX` pair in `ws-bridge.ts` (Rec 4): generalise at the third instance, not before.
4. Watcher debounce duplication (Rec 7): accept until a third watcher or a behavioural change to the debounce itself.

## Scope-creep flags

- Rename `milestoneBytes → milestone` across the typed cascade: real but tied to no AC — defer, listed in Rec 3.
- Shared debounce helper: tied to no AC — do not do it (Rec 7).
- Startup sweep for handoff files: explicitly out (request-path only), agrees with the developer decision.
