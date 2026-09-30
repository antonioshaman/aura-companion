# Council Review (Aura): Council Mode Phases D–G

**Scope:** Phase D (group-shutdown, preflight-probe, event-bus extension), Phase E (observer-prompt, observer-attribution, observer-grounding), Phase F (six `components/council/*` + store slice + global hooks + Sidebar/ChatView/TopBar/HomePage/App wiring + Playground), Phase G.1 (routes + orchestrator.createCouncilGroup + ws-bridge.broadcastToGroup), Phase G.2 (cli-launcher observer prompt-at-spawn + checkpoint/review watchers + grounding-validated `observer_review`).
**Context:** Council Mode pairs one orchestrator LLM session with one observer session sharing a workspace. The observer wakes on filesystem checkpoint sentinels written by the orchestrator, emits structured reviews, and the server runs grounding validation before fanning to the browser. The branch is 13 commits ahead of `main`; 5494 tests pass, 0 failures. The prior council review (2026-05-11-1957) closed Phase A–C with 25 fixes and codified AP-1..3 + EC-1..9 — those are NOT re-flagged here.
**Council dispatched:** Hunt (security), Fowler (refactoring), Bun/Hono/TS Backend, FS-JSON Persistence, Realtime/NDJSON Protocol, Subprocess Lifecycle, React/Web UI, a11y, Saarinen (UI Quality), Friedman (UX Quality), Willison (LLM Pipeline), Beck (Test Quality). Docker/GHA Deploy skipped — no files in scope.

---

## P1 — Fix Now

### 1. Observer subprocess spawns without its tool allow-list, deny-list, or permission-mode — EC-1 unenforced at the spawn site; same gap leaves `claude+codex` observer entirely unrole-d

| | |
|---|---|
| **File** | `web/server/cli-launcher.ts:586-601`, `web/server/session-orchestrator.ts:541-569`, `web/server/session-group-coordinator.ts:40-47` |
| **Council** | Hunt × Carmack — Security Principle 1 (RCE surface) + Principle 7 (assertions as tripwires); cross-ref Fowler F1 — Principle 6 (missing boundaries) |
| **Ref** | `references/security.md` → P1, P7; `references/refactoring.md` → P6 |

**Finding:** `getObserverSpawnOverrides()` exists with the correct `allowedTools`/`disallowedTools`/`permissionMode` but **no caller imports it**. The observer-role branch in `spawnCLI` only appends `--append-system-prompt`; the `SessionSpawner` contract has no slots for tool restrictions. Worse — the observer-prompt injection ITSELF lives only in `spawnCLI`; `spawnCodexWs`/`spawnCodexStdio` have no equivalent branch, so a `claude+codex` pair spawns an undirected Codex observer with the full default tool surface AND no system prompt.

**Consequence:** A prompt-injected Claude observer (e.g. via a workspace-supplied `.council/prompts/observer-system.md` — also workspace-rooted, see #2) gets full Bash/WebFetch in the orchestrator's cwd. A Codex observer never receives ANY role definition — runs as a default chat session whose review-file output is grounded by the server as if it were a real reviewer. Both gaps invert the entire safety contract this feature exists to provide.

**Fix:** Extend `SessionSpawner` with `allowedTools`/`disallowedTools`/`permissionModeOverride`. In `createCouncilGroup`'s spawn adapter, apply `getObserverSpawnOverrides()` for `sessionGroupRole === "observer"`. Lift the observer-prompt resolve+inject out of `spawnCLI` into a shared helper used by both `spawnCLI` and `spawnCodex*` (the Codex branches accept a `systemPrompt` option already — wire `artifact.body` into it). Add a boot-time canary that fails if an observer-role launch reaches `Bun.spawn` without `--disallowedTools Bash` in argv.

---

### 2. Three Phase E primitives are imported by tests only — the integration contract Phase G claims is half-fictional

| | |
|---|---|
| **File** | `web/server/session-orchestrator.ts:418-479` vs unused: `observer-prompt.ts:161-193` (`buildObserverContextManifest`), `observer-attribution.ts:81-117` (`wrapObserverFindingForInjection`), `observer-attribution.ts:163-184` (`formatObserverInvocationLog`), `observer-write-policy.ts` (`assertObserverWriteAllowed`) |
| **Council** | Willison × Carmack — LLM Pipeline P4 (recording-based replay) + P8 (context propagation); cross-ref Persistence P2-4/P2-5 |
| **Ref** | `references/quality-llm.md` → P4, P8; `references/quality-persistence.md` → P3, P8 |

**Finding:** Four well-tested Phase E primitives have ZERO production callers (grep confirms). Their JSDoc, the prompt artifact, and the commits all behave as if they're wired: (a) the prompt tells the observer "read **only** the manifest paths" but `handleCouncilReview` shoves cumulative `artifact_paths` verbatim into `modifiedFiles` — no delta filter applied; (b) the documented multi-layer renderer defence (preamble + delimiter + JSX escape) is really single-layer (JSX escape only); (c) the observer invocation log carrying `promptSha256`/`latencyMs`/STOP counts — the whole forensic re-run guarantee — is never emitted; (d) `assertObserverWriteAllowed` exists but no observer write site invokes it.

**Consequence:** Each gap is the "documentation as enforcement" anti-pattern EC-7 was written against, applied to behaviour: the observer's context grows cumulatively across phases (Willison P8 context distraction); a refactor that adds prose rendering, markdown, or telemetry mirroring has no preamble layer to fall back on; the forensic story for "which prompt SHA did this observer see at this moment" is broken on restart; the EC-7 write boundary the prior council fixed remains a primitive the production path doesn't depend on.

**Fix:** Wire `buildObserverContextManifest` in `handleCouncilCheckpoint` to compute the delta against the per-group `lastCheckpoint` BEFORE storing — pass the manifest's `delta` to the observer's per-checkpoint input; pass `modifiedFiles = new Set(delta)` to grounding. Wire `wrapObserverFindingForInjection` at the orchestrator-side synthetic message injection point (when a STOP banner is created). Emit `formatObserverInvocationLog(...)` at the end of `handleCouncilReview` via `log.info` with the structured shape. Wire `assertObserverWriteAllowed` into the observer-side `canUseTool` callback for Write/Edit/MultiEdit. Each wire-up is small in isolation; the cluster closes the contract gap.

---

### 3. `group:exited` and `group:degraded` are wired as listeners but never emitted — entire wire variants are dead protocol surface

| | |
|---|---|
| **File** | `web/server/session-orchestrator.ts:295-310` (listeners) vs `web/server/session-group-coordinator.ts:174-202` (`archiveGroup` — no emit); `grep -rn 'emit.*group:'` returns only `group:created`, `group:checkpoint`, `group:review` |
| **Council** | Realtime/NDJSON × Carmack — Protocol Principle 7 (drift between declared types and observable behaviour) + Principle 4 (fan-out) |
| **Ref** | `references/quality-realtime.md` → P4, P7 |

**Finding:** Two of the five new `BrowserIncomingMessage` variants declared in Phase F.1 are dead protocol surface. The orchestrator's bus listeners exist and the `wsBridge.broadcastToGroup` fanout works, but nothing emits `companionBus.emit("group:exited", …)` or `"group:degraded", …` anywhere in the server. When the user archives a Council pair, the browser's `groups` map never gets `removeGroup`; when one half dies, the surviving half's UI never enters degraded mode.

**Consequence:** Two of the five wire variants compile, type-check, render in Playground, and never fire at runtime. The DegradedBanner is unreachable in any real session; group-archive leaks records across the session lifetime. Cross-cut with Subprocess #4: observer-half death never reaches the bus because there's nothing wired to emit it.

**Fix:** Emit `companionBus.emit("group:exited", { sessionGroupId, reason })` from `archiveGroup` after both kills, and from the group state machine on `both_halves_died`/shutdown. Emit `"group:degraded"` from the coordinator's state-machine transition that flips `pairing|active → degraded`. Add a replay test that injects a synthetic half-death and asserts `group_degraded` reaches the bridge.

---

### 4. Council context (sessionGroupRole, observer prompt, watcher lifecycle) is dropped on every non-initial-spawn transition — relaunch, idle-kill, shutdown all leak it

| | |
|---|---|
| **File** | `web/server/cli-launcher.ts:475-484` (`relaunch`), `web/server/session-orchestrator.ts:255-268` (idle-kill), `web/server/group-shutdown.ts:34-86`, `web/server/session-orchestrator.ts:351-353` (`stopCouncilWatchers` is bus-coupled to `group:exited` only) |
| **Council** | Subprocess Lifecycle × Carmack — Principle 1 (spawn argv discipline) + Principle 5 (`--resume` state drift) + Principle 7 (resource lifecycle visibility) |
| **Ref** | `references/quality-subprocess.md` → P1, P5, P7 |

**Finding:** Initial spawn correctly carries `sessionGroupRole` + observer prompt + watcher arm. After the first crash, idle-kill, or server-shutdown, the council layer drops everything: (a) `CliLauncher.relaunch()` reconstructs options from `info` but explicitly omits `sessionGroupRole` — auto-relaunched observer spawns as a plain unrole-d session with `--resume` but no prompt; (b) `stopCouncilWatchers` only fires on `group:exited`, never on `session:exited` of an individual half, so observer-half death + auto-relaunch exhaustion leaves watchers + `lastCheckpoint` map entries running against a dead pair; (c) `group-shutdown.ts` archives groups but never aborts council watchers — the `for await` loops leak into the next process restart; (d) `info.observerPromptSha256` becomes stale on relaunch — the recording header claims a SHA the model never received; (e) idle-kill threshold (24h) doesn't account for observer's "sleeping between checkpoints" pattern — observer half gets reaped without the group transitioning to degraded.

**Consequence:** A council pair survives the first hour cleanly; after any subprocess hiccup the council pipeline silently regresses to "two normal sessions" with the UI still claiming healthy council operation. Findings stop arriving, the user sees no error.

**Fix:** Single root cause — read `info.sessionGroupRole` and `info.sessionGroupId` in `relaunch()` and pass them into `spawnCLI`/`spawnCodex*` so the observer prompt is re-loaded and the SHA refreshed. Subscribe `session:exited` in `initialize()`: when the exiting session has `sessionGroupRole === "observer"` and auto-relaunch is exhausted, drive `group:exited` via the coordinator's state machine so watchers tear down. Either suppress idle-kill entirely for observer-role sessions, or reset `lastCliActivityTs` on observer wake cycles. Have `archiveGroup` emit `group:exited` (fixes #3 simultaneously). Add `stopCouncilWatchers` to `group-shutdown.ts`'s pre-archive step.

---

### 5. `watchReviews` debounces by filename only — same-path payloads silently coalesce; multi-provider claude+codex pair loses one observer's review

| | |
|---|---|
| **File** | `web/server/review-watcher.ts:25, 75-84`, `.council/prompts/observer-system.md` (no filename rule), `web/server/observer-write-policy.ts:45` (filename pattern allows hyphenated phases but no provider segment) |
| **Council** | FS-JSON Persistence × Carmack — Persistence Principle 2 (debounce is a correctness window) + Principle 6 (validate at boundary); EC-4 regression |
| **Ref** | `references/quality-persistence.md` → P2, P6 |

**Finding:** The review-watcher's debounce map is keyed by `file` only — EC-4 specifically forbids this when distinct payloads can collide on the same path. The dedup key `(checkpoint_id, observer_provider)` is applied AFTER the read, so only the last rename's bytes are ever read. Compounded by the prompt artifact NOT specifying a provider-disambiguating filename: both halves of a `claude+codex` pair write to `.council/reviews/<phase>-observer.md` and one silently overwrites the other within the 150 ms debounce window. The "two reviews for the same checkpoint from different providers should both surface" comment at lines 122-123 is aspirational, not enforced anywhere.

**Consequence:** This is the experimental pairing's entire value proposition collapsing into "whoever writes last wins" — without a log line saying so. The watcher's regression test at `review-watcher.test.ts:96-117` writes the same payload twice and cannot detect this failure mode.

**Fix:** Pin a provider-aware filename in (a) `observer-system.md` ("write to `.council/reviews/<phase>-<provider>-observer.md`"), (b) `REVIEW_FILE_PATTERN` regex (require the `<provider>` segment from `claude|codex`), (c) `isObserverReviewFilenameAllowed`. Switch debounce keying from filename-only to `(file, mtimeNs)` OR read inside the debounce window and emit per distinct content hash. Add the EC-4-mandated regression test: two `writeAtomicJson(samePath, distinctPayload)` calls within one 150 ms window both surface (or one is recorded via `onDropped` with reason `"superseded"`).

---

## P2 — Fix Soon

### 6. Server-generated finding ids are non-deterministic — every server restart re-emits the same review with fresh ids; browser dedup fails

| | |
|---|---|
| **File** | `web/server/session-orchestrator.ts:449-469` |
| **Council** | Willison × Realtime — LLM P4 (reproducibility) + Realtime P3 (sequence/replay); cross-ref Backend P2-6 |
| **Ref** | `references/quality-llm.md` → P4; `references/quality-realtime.md` → P3 |

**Finding:** `handleCouncilReview` mints `fnd_${randomBytes(8).hex}` per call. The browser dedups `appendObserverReview` by `wire.id`. The only intra-process dedup is the watcher's process-local `seenDedupKeys`. After server restart, the on-disk review file is re-read, fresh random ids are minted, browser sees them as distinct → FindingsLog duplicates on every restart of a long-running council group. The downgrade-id correlation also relies on array-index alignment with a `fnd_<hex>` fallback that orphans the chip if the alignment ever drifts.

**Fix:** Derive the finding id deterministically from `(sessionGroupId, checkpointId, observer_provider, findingIndex, evidence_path_hash)`. Same input → same id across restarts. Drop the random fallback in the downgrade correlation path; if `findings[d.index]?.id` is undefined, that's a programmer error and should throw, not silently substitute a random id.

---

### 7. Lazy `await import("node:path")` inside `startCouncilWatchers` has no terminal `.catch` — silent unhandled rejection leaves watchers half-installed

| | |
|---|---|
| **File** | `web/server/session-orchestrator.ts:379-409` |
| **Council** | Bun/Hono/TS Backend × Carmack — Backend P1 (operational vs programmer errors) + P5 (resource lifecycle) |
| **Ref** | `references/quality-backend.md` → P1, P5 |

**Finding:** `councilWatchers.set(...)` runs BEFORE the dynamic import resolves. The `.then` callback attaches `watchCheckpoints`+`watchReviews` `.catch`s, but the outer chain has no terminal `.catch`. A rejection of the import (rare but possible — packaged distribution path quirks, future module-path refactor) becomes a silent unhandled rejection. Bun's default crashes on this in production; in dev it warns once. Worse: the map entry is populated, so a retry `startCouncilWatchers` call is a no-op, and `stopCouncilWatchers` aborts a signal that has no listeners. From the outside: REST returns 200, browser thinks council is up, no watcher actually runs.

**Fix:** Delete the lazy import. `node:path` is a built-in Bun module loaded eagerly regardless; `routes.ts`/`cli-launcher.ts`/`recorder.ts` already import it. Promote to a top-level `import { join } from "node:path"` at the top of `session-orchestrator.ts`. `startCouncilWatchers` becomes fully synchronous; the race vanishes. Plus: create `.council/checkpoints/` and `.council/reviews/` with `mkdirSync(..., { recursive: true })` BEFORE constructing the watcher promises so a missing directory doesn't trigger the silent-absent failure mode.

---

### 8. `handleCouncilCheckpoint` overwrites `lastCheckpoint` with no sequence-monotonicity check — stale checkpoint poisons grounding

| | |
|---|---|
| **File** | `web/server/session-orchestrator.ts:419-428` |
| **Council** | Realtime/NDJSON × Carmack — Protocol Principle 3 (sequence numbers) + P7 (drift) |
| **Ref** | `references/quality-realtime.md` → P3, P7 |

**Finding:** Server-side handler accepts any checkpoint unconditionally and replaces `entry.lastCheckpoint`. `CheckpointPayload` carries `sequence: number` but it's consumed only for outbound emission. Under load (FS watcher reordering, atomic-rename races, observer-resume re-reads the directory), an older checkpoint can overwrite a newer one — the next observer review then grounds against the stale `artifact_paths`. STOPs in the newer phase's manifest get downgraded to NOTE because the stale checkpoint doesn't list them.

**Fix:** In `handleCouncilCheckpoint`, reject `payload.sequence <= entry.lastCheckpoint.sequence` with a structured warn log and skip the outbound `group:checkpoint` emission. The client's existing monotonicity guard (`council-slice.ts:256`) becomes the second line of defence, not the first. Test: emit checkpoints `[1, 3, 2]`, assert `lastCheckpoint.sequence === 3` and that exactly two `group:checkpoint` emissions fire.

---

### 9. `handleCouncilReview` pipeline has zero direct test coverage; SSE `/sessions/create-stream` Council branch also untested

| | |
|---|---|
| **File** | `web/server/session-orchestrator.ts:430` (no test references the symbol); `web/server/routes.ts:216-262` (no parallel describe in `routes.test.ts`) |
| **Council** | Beck × Carmack — Testing P4 (test what might break) + P5 (composition is the analysis) |
| **Ref** | `references/quality-testing.md` → P4, P5 |

**Finding:** Two load-bearing council surfaces have no tests: (a) the composed pipeline `review payload → modifiedFiles from manifest → validateObserverFindings → stable id assignment → broadcast` is the seam where Council Mode's value proposition lives, and the constituent pures are well-tested in isolation but the composing handler is not; (b) the SSE Council branch has its own pairing-validation block, its own progress-event shape, and its own `done` payload that includes `observerSessionId` — a duplication of the non-stream branch that will drift.

**Fix:** Add `session-orchestrator.council.test.ts` exercising `handleCouncilReview` end-to-end: a happy-path test, a "STOP outside modifiedFiles → downgrade" test, a "evidence missing on disk → downgrade" test. Add a `describe("POST /api/sessions/create-stream — Council Mode branch")` to `routes.test.ts` covering invalid-pairing-before-progress, valid-pairing-with-progress-events, done-payload-shape, and coordinator-failure-emits-error. Drop a recorded `ObserverReviewPayload` fixture under `web/server/fixtures/council-reviews/` so EC-6 carries into Phase G.

---

### 10. CouncilToggle listbox is APG-non-compliant + ProviderBadges/DegradedBanner fail WCAG AA contrast — axe missed both because Tailwind alpha-tokens defeat the auto-resolver

| | |
|---|---|
| **File** | `web/src/components/council/CouncilToggle.tsx:229-249` (listbox), `ProviderBadges.tsx:54-64` (chip contrast), `DegradedBanner.tsx:84, 108` (label + button contrast) |
| **Council** | a11y Auditor × Carmack — A11y P5 (roles + behaviour match), P6 (color contrast), P7 (keyboard navigation) |
| **Ref** | `references/quality-a11y.md` → P5, P6, P7 |

**Finding:** The pairing dropdown declares `role="listbox"` + `role="option"` but has zero keyboard handlers — no Arrow/Home/End, no Escape, no type-ahead, no `aria-activedescendant`. NVDA/JAWS users hear "listbox", press Down arrow, and nothing happens. Separately, `text-cc-primary` (`#d97757`) on `bg-cc-primary/10` chip background measures ~2.8:1 (need 4.5:1 for body text). `text-cc-codex` on `bg-cc-codex/10` is ~3:1. `text-cc-warning` (`#b7791f`) on `bg-cc-warning/8` DegradedBanner is ~4.1:1. axe doesn't catch any of these because Tailwind's `/N` alpha-modifier produces `rgba()` over a theme-token-driven parent that axe-core can't always resolve. `index.css` already defines `cc-primary-btn`/`cc-codex-btn` for exactly this reason ("Darker button-grade variants — meet WCAG AA").

**Fix:** Switch chip text from `text-cc-primary`/`text-cc-codex` to the `-btn` variants in ProviderBadges; switch DegradedBanner label + button text to a new `--color-cc-warning-text` (or use `text-cc-fg` for label, reserve gold for icon and border). For CouncilToggle: add full APG listbox keyboard model (Arrow/Home/End/Escape/type-ahead with `aria-activedescendant`), OR drop `role=listbox`+`role=option` and re-cast as a `<menu>`/popover where Tab-only is acceptable. Replace `disabled` on the codex option with `aria-disabled` so SR users can hear WHY it's unavailable. Add behavioural keyboard tests alongside the existing axe scans.

---

### 11. ObserverPanel has no loading/reconnecting state pill — pairing/reconnecting collapse into idle "Awaiting first checkpoint"

| | |
|---|---|
| **File** | `web/src/observer-panel-state.ts:22-65`, `web/src/components/council/ObserverPanel.tsx:53-104` |
| **Council** | Friedman × Carmack — UX P2 (five screen states) + P9 (trust through data consistency) |
| **Ref** | `references/quality-ux.md` → P2, P9 |

**Finding:** `deriveObserverPanelState` branches on `status === "degraded"` and otherwise funnels every other `SessionGroupStatus` (`pairing`, `active`, `reconnecting`, `archived`) into `never-checkpointed-yet` until a checkpoint lands. A user who toggles Council Mode on and clicks Create watches the panel sit on a static muted dot for the 10–30s spawn window. The same pill appears AFTER pairing is done and the observer is idle. `reviewing → reconnecting` masks the disconnect entirely. The five-state UX design (blank/loading/partial/error/ideal) has holes in loading and partial.

Same domain, different finding: uncontainerized council pairs bypass the carefully-written "Archive Council pair?" preview because `handleArchiveSession` checks the council branch ONLY for containerized sessions (the council preview was added inside the existing container-archive plate). Archive of an uncontainerized council pair fast-paths to `doArchive(sessionId)` with no confirmation — both halves die in one click.

**Fix:** Add `spawning` (`status === "pairing"`) and `reconnecting` variants to `ObserverPanelState`. Insert ABOVE `never-checkpointed-yet` in priority ladder, BELOW `degraded`. Distinct pills (spinner + cc-info for spawning, cc-warning for reconnecting). Update JSDoc + tests. In `Sidebar.handleArchiveSession`: check `councilInfoFor(sessionId).pairing` BEFORE the containerized branch; always open `confirmArchiveId` when the session is in a council group. Add a test: archive an uncontainerized council session and assert the `archive-confirm-council-preview` appears before `doArchive` is called.

---

## P3 — Consider

### 12. Two parallel cleanup paths for Council state on session removal — `cleanupCouncilForSession` is defined but never called

| | |
|---|---|
| **File** | `web/src/store/council-slice.ts:337-363` (definition, no caller) vs `web/src/store/sessions-slice.ts:112-189` (duplicate inline cleanup in `removeSession`) |
| **Council** | React/Web UI — Frontend Principle 2 (slice-owns-its-own-cleanup) |

The slice owns the persistence keys but the cleanup is duplicated inline in `sessions-slice.removeSession`, reaching across the slice boundary to read + mutate the council maps and re-persist via `localStorage.setItem`. The two paths happen to agree today; the next time someone adds a field to council cleanup, they will edit the unused `cleanupCouncilForSession` (the documented surface) and the persisted state will drift silently from in-memory. Call `s.cleanupCouncilForSession(sessionId)` from `removeSession` and delete the inline block. Either wire or delete the export — both is the worst of both.

---

### 13. Coordinator's spawn-rollback kill does not mark intentional first — EC-2 violated, race window can trigger proactive relaunch of the half being killed

| | |
|---|---|
| **File** | `web/server/session-orchestrator.ts:541-569` (`createCouncilGroup` kill shim), `web/server/session-group-coordinator.ts:141-152` (rollback path) |
| **Council** | Bun/Hono/TS Backend — Backend P5 + EC-2 |

When the observer-half spawn fails, the coordinator calls the injected `kill(primary.sessionId)` to roll back. The kill shim calls `this.killSession(sessionId)` directly — without first adding the id to `intentionalKills`. The `session:exited` listener fires `scheduleProactiveRelaunch` BEFORE `killSession` returns, racing the second kill. Orphan CLI process attached to a `sessionGroupId` that no longer exists. Either widen the `kill` shim to mark intentional first, or add a `markIntentionalForGroup(group)` step before either kill call.

---

### 14. `cc-warning` saturation in dark mode collapses the blocker-vs-degraded hierarchy + banner animation drift + off-scale opacity values

| | |
|---|---|
| **File** | `web/src/components/council/DegradedBanner.tsx:75-110`, `BlockerBanner.tsx:53` vs DegradedBanner (no animation), CouncilToggle dropdown `rounded-md` vs project's `rounded-[10px]` |
| **Council** | Saarinen — UI P3 (hot-spots from saturated semantic colour) + P6 (motion consistency) + P8 (component visual consistency) |

DegradedBanner uses `--color-cc-warning` (`#f6e05e` in dark mode) on five concurrent surfaces (border, background, icon, label, button) — accumulates into a yellow plate that competes with BlockerBanner's `cc-error` at the same alphas. The intended hierarchy (blocker > degraded) is collapsed. Plus: BlockerBanner fades in 200ms; DegradedBanner pops instantly. Plus: `bg-cc-warning/8` is off-scale (project uses 5/10/15/25). Plus: CouncilToggle dropdown breaks the project's `rounded-[10px]` shadow-lg convention. Desaturate `cc-warning` in dark mode (or drop label to `text-cc-fg`); give both banners the same `animate-[fadeSlideIn_0.2s_ease-out]`; snap `/8` → `/10`; switch CouncilToggle listbox to `rounded-[10px]`.

---

### 15. `session-orchestrator.initialize()` is 160 lines mixing single-session + council concerns

| | |
|---|---|
| **File** | `web/server/session-orchestrator.ts:199-357` |
| **Council** | Fowler — Refactoring P5 (smells that compound) + P6 (missing boundaries) |

Phase D–G added five group:* listeners + watcher teardown to an already-long `initialize()` packed with single-session lifecycle, auto-relaunch, idle-kill, naming, and reconnection-watchdog wiring. They are interleaved with the existing subscriptions; the council bag and the solo bag have no visible boundary. Each future council event will tempt the implementer to thread one more listener into the same method. Extract `private wireGroupListeners()` (group:* + watcher teardown) and call from `initialize()`. The body becomes a two-line manifest. No behaviour change.

---

## Summary

| # | Finding | Severity | Council | Fix effort |
|---|---------|----------|---------|------------|
| 1 | Observer spawns without tool-restrictions + Codex observer unrole-d | P1 | Hunt × Fowler | ~3–4 hr (extend SessionSpawner, wire prompt into both spawn paths, boot canary) |
| 2 | Three Phase E primitives unused in production | P1 | Willison × Persistence | ~3–4 hr (wire context-manifest, attribution wrapper, invocation log, write-policy assert) |
| 3 | `group:exited`/`group:degraded` never emitted | P1 | Realtime | ~1 hr (emit from archiveGroup + state-machine transitions) |
| 4 | Council context lost on relaunch/idle-kill/shutdown | P1 | Subprocess | ~2–3 hr (relaunch reads role, session:exited drives group:exited, idle-kill exception for observer) |
| 5 | `watchReviews` filename collision (claude+codex fatal) | P1 | Persistence | ~2 hr (provider-aware filename + (file,mtime) dedup key + EC-4 test) |
| 6 | Non-deterministic finding ids | P2 | Willison × Realtime | ~30 min (deterministic id derivation) |
| 7 | Lazy `node:path` import → silent unhandled rejection | P2 | Backend | ~15 min (promote to top-level import, mkdir before watcher) |
| 8 | `handleCouncilCheckpoint` no monotonicity guard | P2 | Realtime | ~30 min (sequence gate + test) |
| 9 | `handleCouncilReview` + SSE Council untested | P2 | Beck | ~2 hr (three new test files) |
| 10 | CouncilToggle listbox APG + WCAG AA contrast | P2 | a11y | ~3–4 hr (keyboard model + token swaps + behavioural tests) |
| 11 | No loading state + uncontainerized archive bypass | P2 | Friedman | ~2 hr (two new state variants + Sidebar branch reorder + tests) |
| 12 | Two parallel Council cleanup paths | P3 | React/Web UI | ~15 min |
| 13 | EC-2 spawn-rollback intentional-mark gap | P3 | Backend | ~30 min |
| 14 | Saarinen cluster (warning hot-spot, banner animation, opacity drift) | P3 | Saarinen | ~1 hr |
| 15 | `initialize()` mixes single-session + council | P3 | Fowler | ~30 min (extract) |

**Totals:** 5 P1, 6 P2, 4 P3.

## Verdict

The Council Mode feature is structurally sound — the coordinator/state-machine/AP-1 boundaries hold, the convention discipline from Phase A–C carries through (EC-1..9 are observed at the type level), the React + Zustand layer is well-composed, and the test density is high. But the integration between Phase E (pure primitives) and Phase G (wiring) is incomplete: **three of the four Phase E primitives the prompt artifact and JSDoc claim are wired have ZERO production callers** (#2). Combined with `group:exited`/`group:degraded` never being emitted (#3) and the observer subprocess spawning without its tool restrictions or — for Codex pairings — without any prompt at all (#1), the feature ships as a thin veneer over real foundations that aren't load-bearing yet.

The single most consequential fix is **#1** — Hunt × Fowler. Without it, the observer is an agentic LLM with full default tool surface running same-uid same-cwd as the orchestrator; a workspace-supplied `.council/prompts/observer-system.md` is an in-tree RCE vector. The fix has been mostly designed (`getObserverSpawnOverrides()` exists with the right shape) — it just needs to reach the spawn call site. Until #1 is in place, the experimental `claude+codex` pairing should be feature-flagged off, not gated only by the preflight probe.

Carmack would ship Phase E → Phase G end-to-end before merging — the helpers exist, the integration is small, and the cluster of "documentation as enforcement" issues all close together with a single careful PR. The remaining P2/P3 cluster is the polish work that's expected for a feature this size; #6 (deterministic ids), #7 (delete the lazy import), and #11 (loading state) are the highest-leverage tightenings to land alongside the five P1s.

The council reviewed 5494 passing tests and found one untested high-risk pipeline (#9). That ratio is exemplary; the Phase E pure-helper discipline + the in-repo prompt artifact load canary + the real-symlink EC-7 test + the deterministic Playground entries are the right shape. Resist the urge to inline these "for readability" — the Beck-F4 pattern is paying its rent.

---

## Findings Breakdown by Expert

| Expert | P1 raw | P2 raw | P3 raw | Total | In Final | Key Areas |
|--------|--------|--------|--------|-------|----------|-----------|
| Hunt (Security) | 1 | 3 | 2 | 6 | 1 P1 (primary on #1) | Spawn argv, workspace-rooted prompt, recording doubling, grounding bypass |
| Fowler (Refactoring) | 1 | 3 | 2 | 6 | 1 P1 (cross-ref #1), 1 P3 (#15) | Codex observer prompt gap, initialize() cohesion |
| Bun/Hono/TS Backend | 3 | 6 | 5 | 14 | 1 P2 (#7), 1 P3 (#13) | Lazy import race, EC-2 rollback gap, REST shape divergence |
| FS-JSON Persistence | 2 | 6 | 2 | 10 | 1 P1 (#5), 1 P1 cross-ref (#2) | EC-4 regression, filename ambiguity, primitives unused |
| Realtime/NDJSON | 2 | 4 | 3 | 9 | 1 P1 (#3), 1 P2 (#6 cross-ref + #8) | Dead emit surface, sequence monotonicity, finding-id stability |
| Subprocess Lifecycle | 4 | 5 | 3 | 12 | 1 P1 (#4 — cluster of 5 sub-findings) | Council context lost on every non-initial transition |
| React/Web UI | 1 | 8 | 7 | 17 | 1 P3 (#12) | Cleanup duplication; selector hygiene; error boundaries |
| a11y Auditor | 3 | 7 | 4 | 14 | 1 P2 (#10 — cluster of 3) | Listbox APG, WCAG AA contrast on alpha tokens |
| Saarinen (UI Quality) | 0 | 7 | 7 | 14 | 1 P3 (#14 — cluster of 4) | Dark-mode warning hot-spot, banner-animation drift |
| Friedman (UX Quality) | 2 | 5 | 4 | 11 | 1 P2 (#11 — both P1s merged) | Loading state hole, uncontainerized archive bypass |
| Willison (LLM Pipeline) | 4 | 5 | 2 | 11 | 1 P1 (#2 — primary), 1 P2 (#6) | Phase E primitives unused, finding-id determinism |
| Beck (Test Quality) | 1 | 4 | 4 | 9 | 1 P2 (#9 — both Beck P1+P2) | handleCouncilReview untested, SSE Council untested |
| **TOTAL** | **24** | **63** | **46** | **133** | **15** | — |

133 raw → 15 final after Carmack filter + cross-expert dedup. The compression is dominated by Phase E primitives appearing in multiple lanes (Willison + Persistence + Hunt all separately flagged subsets of #2) and council-context-loss appearing across five Subprocess sub-findings collapsed into #4.

**Review output written to:** `.council/review-output/2026-05-11-2251/FINAL-REVIEW.md`

**Expert output files:**
- Hunt: `.council/review-output/2026-05-11-2251/hunt.md`
- Fowler: `.council/review-output/2026-05-11-2251/fowler.md`
- Bun/Hono/TS: `.council/review-output/2026-05-11-2251/backend-ts.md`
- FS-JSON: `.council/review-output/2026-05-11-2251/persistence.md`
- Realtime/NDJSON: `.council/review-output/2026-05-11-2251/realtime.md`
- Subprocess: `.council/review-output/2026-05-11-2251/subprocess.md`
- React/Web UI: `.council/review-output/2026-05-11-2251/react-ui.md`
- a11y: `.council/review-output/2026-05-11-2251/a11y.md`
- Saarinen: `.council/review-output/2026-05-11-2251/saarinen.md`
- Friedman: `.council/review-output/2026-05-11-2251/friedman.md`
- Willison: `.council/review-output/2026-05-11-2251/willison.md`
- Beck: `.council/review-output/2026-05-11-2251/beck.md`
