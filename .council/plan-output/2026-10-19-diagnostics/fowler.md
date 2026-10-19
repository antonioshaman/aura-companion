# Fowler — structural design for Diagnostics page + KB/memory analyzer (v1)

Economic lens applied throughout: this is ~14 files / ~1400 lines, one operator, two surfaces, one new persistence schema. Every boundary below is one that pays off inside this feature's own implementation (it isolates a mutation, makes an AC testable without the server, or keeps a 2.4k-line file from growing), not a boundary for a hypothetical v2. Items I considered and deliberately did NOT recommend are listed at the end.

RECOMMENDATION 1
- Title: One `web/server/diagnostics/` package, one wiring seam in `index.ts`, one shared types file
- AC defended: Must (spec §5); indirectly all of AC1–AC9
- Principle: Principle 6 (architecture earns its boundaries — different reasons to change); AP-3 precedent (writer and reader schemas co-located)
- What to get right: Put every new server module under `web/server/diagnostics/` (event ring, runtime snapshot, pairs snapshot, overview aggregator, trigger, analyzer, runner, decisions applier, memory report) and expose them to `index.ts` through a single `wireDiagnostics(deps)` call that returns the handles the routes and shutdown need, so `index.ts` gains one block rather than a dozen scattered constructions. Declare the wire shapes (overview envelope, report schema with `schemaVersion`, decision record, accumulation status) once in `diagnostics/diagnostics-types.ts`, and have `web/src/api.ts` import them type-only, exactly as `src/types.ts` already imports from `../server/session-types.js` — one contract, no client-side re-typing drift.
- Risk if skipped: The feature lands as ten independent additions to `index.ts` (already 1150 lines of boot wiring) and the browser re-declares the report shape by hand, so the first schema change is shotgun surgery across server, API helper and three cards.
- Depends on: —

RECOMMENDATION 2
- Title: Extract the KB core from `web/scripts/kb-health.ts` into `web/server/knowledge/kb-store.ts`; the script becomes a thin CLI that re-exports
- AC defended: AC5, AC7, AC8
- Principle: Principle 2 (extract pure logic); Principle 8 (refactor first, then add function — separate commits)
- What to get right: The dependency direction is fixed by the repo: three scripts already import from `../server`, nothing in `server/` imports from `../scripts`, and `web/tsconfig.json` includes `src`/`server`/`evals` but not `scripts`. So the loader, usage-log parser, health computation, entry predicates and the archive move go to a server module; `kb-health.ts` keeps only argv parsing, output formatting and `process.exit`, importing from the new module and re-exporting the same names so the existing `kb-health.test.ts` and `/prime` / `kb:prune` invocations are untouched. The script's `writeTextAtomic` dependency on `scripts/atomic-json.ts` must come with it — add a text/JSONL variant beside `writeAtomicJson` in `server/atomic-write.ts` (or move the shared primitive under `server/`) rather than letting the server reach into `scripts/`. Land the extraction as its own commit with zero test modifications beyond import paths, before any analyzer code exists.
- Risk if skipped: Either the server imports a CLI script (wrong-direction dependency, un-typechecked in the main build, `import.meta.dirname` path assumptions baked in) or the analyzer re-implements the loader and the two copies drift on the exact rule that protects AC7 — "unparseable lines are preserved verbatim, never dropped".
- Depends on: Recommendation 1

RECOMMENDATION 3
- Title: Carve `archiveEntries(kbDir, ids, reason)` out of `pruneKb`; prune becomes "select idle, then archive"
- AC defended: AC8, AC7
- Principle: Principle 2 (separate pure selection from the visible mutation); Principle 5 (avoid duplicating the one write path that rewrites a store)
- What to get right: Today `pruneKb` fuses the idle-selection policy with the archive mechanics (archive file appended first, live store rewritten second, raw lines preserved). The decisions applier needs the mechanics for an explicit id list, not the policy, so split them: a pure selector returns the ids and reasons, and one `archiveEntries` performs the two writes. `pruneKb` calls the selector then `archiveEntries`; the `archive` decision calls `archiveEntries` with the owner's reason. Keep "archive written before live store rewritten" documented on the extracted function as its invariant.
- Risk if skipped: The decisions applier grows its own store-rewriting loop; two writers for the only destructive KB operation means the next change to one (for example, archive-reason format) silently diverges from the other, and AC8's "nothing is deleted" is guaranteed in one place only.
- Depends on: Recommendation 2

RECOMMENDATION 4
- Title: `decisions.jsonl` is the only write for `keep`, `merge` and `seen`; never stamp `reviewedAt` / `mergePending` into the KB stores
- AC defended: AC7, AC8, AC9; owner rule §0
- Principle: Principle 3 (minimise mutation sites); the project's own FIX-A2-1 precedent documented at the top of `kb-health.ts`
- What to get right: The KB stores are git-tracked and shared with running Council pairs; `kb-health.ts` records exactly why writing lifecycle fields into them was abandoned (every `/prime` dirtied the prod checkout, racing writers lost updates). The same argument applies to `reviewedAt` and `mergePending`: record them as decision lines, and have the report builder fold `decisions.jsonl` when it computes "suppressed for 90 days unless a new signal appears" and "merge pending X→Y". The spec's wording ("the entry is marked `reviewedAt`") is then satisfied by the ledger, with the archive move remaining the single store-rewriting operation.
- Risk if skipped: Three decision kinds become three store-rewriting code paths, the prod checkout gets dirty on every "Keep" click, and the AC7 byte-diff test has to enumerate which fields are allowed to change instead of asserting "unchanged".
- Depends on: Recommendation 3

RECOMMENDATION 5
- Title: Analyzer signals are pure functions over loaded data with one injected `exists` predicate
- AC defended: AC5, AC7; Must (signals tested on KB fixtures)
- Principle: Principle 2 (extract pure logic; keep I/O visible at the edge); EC-7 (path resolution lives in the resolving wrapper, not in predicates)
- What to get right: Each signal (`never-used`, `dead-reference`, `duplicate`, `contradiction`, `outdated-reports`, `stale-promoted`, `bitter-pill`) is a function from `(entries, usageIndex, folded decisions, clock, context)` to findings, composed by one `analyzeKb` that returns the report object and nothing else. The only filesystem-dependent signal, `dead-reference`, receives an `exists(relativePath)` predicate from the caller; the runner implements that predicate through the EC-7 resolving wrapper bounded to the repo root. Loading and writing stay in the runner, so the test for AC7 is "call `analyzeKb` on fixtures, assert zero fs writes" with no spies on the analyzer itself.
- Risk if skipped: Signals that read the disk directly cannot be fixture-tested without a temp repo, the ≤100 ms `trackSync` budget becomes unmeasurable because I/O is interleaved with scoring, and the path-resolution rule has seven call sites instead of one.
- Depends on: Recommendation 2

RECOMMENDATION 6
- Title: One `KbAnalysisRunner` owns all mutable run state; the hourly check and the POST route call the same method
- AC defended: AC4, AC5, AC6
- Principle: Principle 3 (state is the primary source of bugs — contain it); Principle 4 (one method whose result names the outcome)
- What to get right: `inFlight`, `lastRun`, `lastReport` and the report-directory bookkeeping live on one object with one entry point, `requestRun(reason)`, that returns a discriminated result (started with runId / already in flight / not due with progress). The route maps that result to 202 or 409; the hourly check calls it after `evaluateTrigger`; neither touches the fields. `evaluateTrigger` itself is a pure function of `(lastRunAt, newEntries, finishedSessions, now, thresholds)` returning `{ due, reason, progress }` — the same `progress` struct feeds the AC4 card string, the daily "not due" log line and the `latest` endpoint, so there is exactly one place the numbers come from.
- Risk if skipped: Single-flight ends up enforced twice (route-side flag plus scheduler-side flag) and the two disagree after a thrown analysis; "3/10 entries · 7/25 sessions" is computed in the card and again in the log and drifts.
- Depends on: Recommendation 1

RECOMMENDATION 7
- Title: Reuse `CleanupScheduler` for the hourly check (second instance, 1h interval) and give it a `scope` label so its log lines stop saying "cleanup"
- AC defended: AC4, AC5
- Principle: Principle 1 (leave stable code alone — don't write a second timer class); Principle 4 (names that lie — log scope and event prefix)
- What to get right: The scheduler already has what a new ticker would need: missed-tick collapse after sleep, per-callback error boundary, `dispose()` awaited in `gracefulShutdown`, and the `__runSweepNowForTests` seam. A second instance at the clamp minimum (1h) is inside its contract. The one thing to change is cosmetic but load-bearing for operators: its log scope and event names are hard-wired to `cleanup-scheduler` / `cleanup.sweep.*`, so an hourly KB check would emit `cleanup.sweep.started` every hour and pollute the alerting greps. Add an optional constructor label that defaults to the current strings, used in the scope and event prefix — no rename of the class, no behaviour change for the existing instance.
- Risk if skipped: Either a third timer pattern appears in `index.ts` (the existing `diagnosticsTimer` setInterval is already the odd one out) or operators lose the ability to grep `cleanup.sweep.*` for the daily sweep.
- Depends on: —

RECOMMENDATION 8
- Title: The bounded event ring is its own tiny generic primitive, fed through `SessionRecoveryDeps`, with the log payload as the single source of the ring payload
- AC defended: AC2
- Principle: Principle 2 (keep the mutation — the emit — visible at the site); EC-21 (documented tuples derive from one source); AP-1 style DI
- What to get right: `diagnostics/event-ring.ts` holds a capacity-and-window-bounded ring with `record` and `snapshot(sinceMs)`; it knows nothing about drift. `SessionRecovery` receives a `recordDriftEvent` callback via its deps (defaulting to a no-op so the existing constructor sites and tests are untouched). At each of the ten `silent_stdio_drift.*` emit sites, build the payload object once and pass that same object to both `log.warn` and the callback — the log contract pinned by tests does not change, and the ring can never carry a different `sessionId` / `reason` than the line in `journalctl`. Relaunch and boot-resume events from the orchestrator paths can be added by the same pattern later without touching the ring.
- Risk if skipped: A module-level singleton ring imported by `session-recovery.ts` makes every recovery test share global state, and a second hand-built payload at each emit site is the exact "half the triplet drops" bug EC-21 was written for.
- Depends on: Recommendation 1

RECOMMENDATION 9
- Title: Extract `buildRuntimeSnapshot(deps)` from the 5-minute tick; the overview calls it fresh; re-anchor the EC-19 canary on the new module in the same commit
- AC defended: Must (Backend card reads existing data, not re-derived)
- Principle: Principle 2 (extract pure projection); Principle 8 (a refactor that moves a test's anchor must update the test, not weaken it)
- What to get right: The snapshot is already a pure projection over `metricsCollector`, `wsBridge`, `terminalManager` and `cleanupScheduler` accessors; move that projection into `diagnostics/runtime-snapshot.ts` and have the tick do "build, log, memory-pressure gate" with no other change. The overview route calls the same builder on request — it is cheap and sync, so a cached "last snapshot" is unnecessary state; the brief's "last snapshot held in memory" becomes "last snapshot time" only if the UI wants it. The EC-19 canary pins the key names as literal bytes of `index.ts`; it must be re-pointed at the new module's source in the same commit, with the same key list — this is a test modification, not a removal, and the plan should say so explicitly so nobody "fixes" the red canary by leaving a duplicate key list in `index.ts`.
- Risk if skipped: The route re-lists the fourteen gauges by hand next to the tick's list and the two drift on the first rename, which is precisely the failure the canary exists to catch — now with two sites to pin.
- Depends on: Recommendation 1

RECOMMENDATION 10
- Title: Pairs snapshot is a pure overlay on the coordinator's `GroupRecord`; frame age comes through an optional `IBackendAdapter` capability, never `instanceof ClaudeAdapter`
- AC defended: AC1
- Principle: AP-2 (state machine is the single source of group status); Principle 5 (feature envy / speculative generality — the adapter interface already uses optional capabilities)
- What to get right: `buildPairsSnapshot(groups, lookupSession, groupMeta, now)` takes the coordinator's records (status straight from the state machine, no re-derivation from session states), overlays `lastCheckpointReceivedAt` from `CouncilGroupMeta`, and computes "silent Nm" from a per-session last-inbound-frame timestamp. That timestamp exists today only as `ClaudeAdapter.getLastCliFrameReceivedMs`, reached in `session-recovery.ts` via an `instanceof` check; do not copy that into diagnostics. Add `getLastCliFrameReceivedMs?()` as an optional method on `IBackendAdapter` — the interface already carries `getObserverTurnState?` and `getRateLimits?` this way — so Claude answers, Codex returns undefined, and the card renders "frame age unknown" for that half instead of silently omitting the pair. Where fields coincide with `buildBrowserGroupRecord` (pairing label, status, dead role), consume that record rather than re-assembling it (AP-14).
- Risk if skipped: A second status derivation drifts from the state machine (the AP-2 violation council reviews re-flag every time), and a backend-specific `instanceof` in a backend-agnostic page is the first thing the Codex parity rule in CLAUDE.md trips on.
- Depends on: Recommendation 1

RECOMMENDATION 11
- Title: Overview aggregator is a dumb map over independent suppliers that all return one `CardSource<T>` envelope
- AC defended: AC3; Must (every card has a "source unavailable" state)
- Principle: Principle 3 (one shape for "ok / unavailable", not six nullable fields); Principle 6 (six subsystems, six reasons to change — keep them apart)
- What to get right: Define a single envelope — available with data and `fetchedAt`, or unavailable with `reason` and `since` — and make each of the six sources (runtime, pairs, drift ring, context advisories, usage upstream, KB health) a separate supplier function that catches its own failures and returns the envelope. The aggregator just calls the six and assembles the object; it contains no per-source logic and no try/catch of its own, so adding a seventh card is one supplier and one key. For the usage source, `stats-routes.ts` keeps one module-level "last upstream outcome" record (status code, since, last success) updated at the single fetch site and exposed by a getter; the overview reads the getter — it must not perform a second upstream fetch.
- Risk if skipped: The aggregator becomes the feature's god-function (six subsystems, six exception shapes, six null conventions), and one failing supplier takes the whole page to 500 — the exact silent-disappearance class the spec is trying to end.
- Depends on: Recommendation 1

RECOMMENDATION 12
- Title: Define "finished session" exactly once as a pure predicate used by the trigger for both backends
- AC defended: AC4, AC5
- Principle: Principle 4 (names reveal design — "finished" must mean one thing); Principle 5 (vocabulary consistent across modules)
- What to get right: The trigger needs "finished sessions since lastRun" and the brief notes Claude and Codex must count identically. Put `isFinishedSession(info)` and `countFinishedSince(sessions, sinceMs)` next to `evaluateTrigger`, reading only fields present on `SdkSessionInfo` for both backends (exit code set, or archived, with the exit/archive timestamp — if the launcher row lacks a usable timestamp, add one field at the single place the launcher records exit rather than inferring from transcript files). Test the predicate with one Claude and one Codex fixture row.
- Risk if skipped: The count is written inline in the hourly check, drifts from whatever the Pairs or Sweep pages mean by "finished", and the 25-session threshold fires at different rates per backend without anyone noticing.
- Depends on: Recommendation 6

RECOMMENDATION 13
- Title: The memory analyzer takes a read-only filesystem capability; it is structurally unable to write
- AC defended: AC9; Never (write to the memory dir)
- Principle: Principle 3 (make the forbidden state unrepresentable); Principle 2 (pure signals, I/O at the edge)
- What to get right: `diagnostics/memory-report.ts` receives an object exposing only list/read/stat over the memory directory (resolved through the EC-7 wrapper by the caller) and never imports a write API from `node:fs`; its signals (`duplicate`, `dead-reference`, `age`) are pure functions over the loaded frontmatter and bodies. The AC9 test then has two cheap layers: an fs spy asserting zero writes, and a static assertion that the module's import list contains no write symbols. The `seen` decision is recorded by the same decisions applier as the KB decisions (Recommendation 4) — the memory module has no decision code at all.
- Risk if skipped: "Report-only" is a comment rather than a property; the first helper that reuses an existing read-modify-write utility for convenience violates the owner's hardest rule with no test to catch it.
- Depends on: Recommendation 4

RECOMMENDATION 14
- Title: Routes in `routes/diagnostics-routes.ts` are thin; decisions validation is a pure `validateDecisions(body, report)`
- AC defended: AC6, AC8; Must (decisions validation tests)
- Principle: Principle 6 (existing route-module convention; `routes.ts` is 2458 lines); Principle 2 (pure validation, visible application)
- What to get right: Register the four endpoints via `registerDiagnosticsRoutes(api, deps)` like the other `routes/*.ts` modules, with the runner, applier, aggregator and settings passed as deps so the route tests never boot the server. Each handler does three things only: parse, call one method, map the discriminated result to a status. Validation of the decisions array against the current report (known entryIds, `mergeInto` present only for merge, memory findings accept only `seen`) is a pure function returning either the typed decision list or the first error, tested on fixtures; the applier then runs in a visible sequence — append ledger line, then archive move — with no validation of its own.
- Risk if skipped: Validation and application interleave inside the handler, a partially-valid batch applies half its archives before the 400, and the 409/202 mapping gets its own in-flight flag.
- Depends on: Recommendations 3, 6

RECOMMENDATION 15
- Title: Settings gain one nested `kbAnalysis` object with its own normalizer, following the `councilSecondReviewer` precedent, plus the flat `diagnosticsMemoryReport` boolean
- AC defended: AC4 (thresholds editable), AC9 (flag default off)
- Principle: Principle 5 (data clump — three thresholds that always travel together); Principle 1 (follow the existing precedent instead of inventing a third pattern)
- What to get right: `settings-manager.ts` already handles one structured setting (`councilSecondReviewer`) through a dedicated parser module and a single allow-list entry; do the same with a `kb-analysis-settings.ts` normalizer that clamps the three numbers to sane bounds and fills defaults 10 / 25 / 14, so the settings route, `normalize`, the trigger and the UI form all consume one validated shape. The boolean flag stays flat like `kbAutoPrime`. The `SessionDefaultsSettings.tsx` form edits the object as one unit.
- Risk if skipped: Three flat keys mean three allow-list entries, three route validations and three normalize lines today, and a fourth threshold later is a four-file edit; the opposite failure (hand-rolled nested parsing in the route) duplicates what `second-reviewer-config.ts` already demonstrates.
- Depends on: —

RECOMMENDATION 16
- Title: Page-local reducer like `SweepPage`, no Zustand slice; one `CardFrame` owns the loading / unavailable / empty rendering; cards are leaf components over `CardSource<T>`
- AC defended: AC3; Must (every card has an explicit unavailable state); AC6 (disabled "running…")
- Principle: Principle 3 (state used by one subtree stays local); Principle 5 (the never-null rule in one place, not eight); EC-10 (discriminated-union renderers compile-fail on missing variants)
- What to get right: Diagnostics state is consumed by exactly one route, polled on an interval, and discarded on navigation — the `SweepPage` discriminated-union reducer is the right shape, and a store slice would add cross-tab persistence nobody asked for. Put the "never render nothing" rule into a single `CardFrame` that switches exhaustively on the envelope (loading, unavailable with reason and since, empty, ready) and renders children only in the ready branch; each card is then a small leaf component that formats its data and nothing else, which keeps its `.test.tsx` to render + axe + its own interactions. The KB analysis card is the only one with mutations (run, decisions); keep those in the page reducer, passed down as callbacks, so the card never calls the API directly.
- Risk if skipped: Eight cards each hand-roll "if no data return null" and the first one that forgets reproduces the `GlobalUsageBadge` disappearance the page exists to fix; a Zustand slice drags polling and decisions into global state with no second consumer.
- Depends on: Recommendation 11

---

Considered and not recommended (economic test failed for this feature at this scale):
- A generic "diagnostic source registry" or plugin interface for cards — six fixed sources, one page; a plain object of suppliers is enough.
- Renaming `CleanupScheduler` to a neutral `PeriodicScheduler` — correct in principle, but it is a cross-file rename of stable code; the label option in Recommendation 7 removes the operator-facing lie at near-zero cost.
- Moving the context-advisory computation out of `session-recovery.ts` — the page only reads the persisted `context_advisory` record per session; no extraction needed.
- Branded types for `runId` / `entryId` — two id kinds, no observed confusion; plain strings with clear field names suffice.
- Splitting `ws-bridge.ts` — this feature reads from it via existing accessors and adds nothing to it; leave it alone.
