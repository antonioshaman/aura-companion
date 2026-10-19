# dahl.md — Bun + Hono + TS backend / NDJSON-WS protocol seat

Scope note: the feature adds no WS message type and no change to the Claude NDJSON or Codex JSON-RPC surface; it is REST plus in-process plumbing that TAPS the bridge (last-inbound-frame age, drift emit sites, group status). Recommendations below are therefore §A runtime hygiene first, with §B only where the Pairs card reads bridge state. Principles cite `quality-dahl.md`.

Ground truth checked in the repo (read-only): `createRoutes` registers `registerStatsRoutes(api)` BEFORE the bearer middleware and `registerSettingsRoutes` / `registerSystemRoutes(api, deps)` / `registerMetricsRoutes(api, { gaugeProvider })` AFTER it; `respondError` already exists with a closed `ErrorCode` union including `conflict` and `validation_failed`; the 5-min tick in `index.ts` builds the snapshot inline and only logs it; `SessionRecoveryDeps` is the DI seam for the drift detector and the pinned tests filter `log.warn/info` spy calls by the `event` field; `ClaudeAdapter.getLastCliFrameReceivedMs()` exists but `IBackendAdapter` and `CodexAdapter` have no inbound-frame timestamp at all; `stats-routes.ts` and `usage-limits.ts` both collapse every failure to nulls and keep no failure state; the KB is ~175 KB across six JSONL files, the memory dir is 471 files / 2.3 MB; the request body limit middleware caps at 64 MB.

---

RECOMMENDATION 1
- Title: One `registerDiagnosticsRoutes(api, deps)` module behind the auth middleware, with a narrow deps interface
- AC defended: AC1, AC2, AC3, AC6 (route surface), Must (spec §5)
- Principle: A2 (validate at the Hono boundary) + A3 (auth before routes)
- What to get right: Add a `routes/diagnostics-routes.ts` that follows the `registerSystemRoutes(api, deps)` shape and is called from `createRoutes` after the `api.use("/*", auth)` block — never next to `registerStatsRoutes`, which is deliberately pre-auth. The deps object must be a small interface of read functions and one service handle (overview provider, drift ring reader, pairs snapshot reader, usage-status readers, the kb-analysis service) rather than the whole orchestrator or wsBridge, so `diagnostics-routes.test.ts` can inject fakes exactly as `system-routes.test.ts` and `stats-routes.test.ts` do today. Nothing in the module should touch Hono's `c` beyond parsing the request and writing the response.
- Risk if skipped: A route registered beside the public stats proxy ships session ids, cwd paths and KB contents unauthenticated; a module that pulls in the orchestrator cannot be unit-tested without booting the bridge.
- Depends on: —

RECOMMENDATION 2
- Title: Overview response is a map of per-card discriminated unions that never 500s because one source failed
- AC defended: AC3, Must (spec §5 "every card has a source-unavailable state")
- Principle: A1 (operational errors are handled) + A8 (type safety at the boundary)
- What to get right: `GET /api/diagnostics/overview` assembles each card independently inside its own error boundary and returns, per card, either an ok variant with `updatedAt` and data, or an unavailable variant with a closed reason string and a `since` timestamp; the top-level status is 200 whenever the handler itself ran. Define the wire types once in a server module that `src/api.ts` imports (the `council-types.ts` pattern), so the React union and the server union cannot drift. Send `Cache-Control: no-store` and skip ETag: the payload is rebuilt from memory in microseconds and every poll legitimately changes `updatedAt`, so conditional requests buy nothing.
- Risk if skipped: One throwing source (e.g. a missing `.council/state` sentinel) turns the whole page into an error state and reproduces the silent-disappearance class the page exists to end.
- Depends on: 1

RECOMMENDATION 3
- Title: Hold the 50 KB overview budget by construction, not by hope
- AC defended: AC2, Must (spec §3.5 "≤ 50 KB")
- Principle: A7 (async correctness — payload size scales with request) + Carmack "if you can't measure it"
- What to get right: Bound every list in the overview at the producer: the drift ring returns at most N newest events inside the 24 h window (a count cap in the hundreds, not thousands), the pairs card only non-archived groups, advisories only sessions with a persisted advisory, and no card embeds message history, prompts, or tool payloads. KB health counters and the accumulation status are read from the analysis service's cached state (computed by the hourly check or the last run), never by re-reading the JSONL files in the request path. Add a route test that serialises a fully-populated fixture overview and asserts the UTF-8 byte length stays under the budget, so a future field addition fails loudly.
- Risk if skipped: A busy day of drift events or a long `reason` string pushes the response past the budget, the UI poll gets slower each hour, and nobody notices until the page is the thing that lags.
- Depends on: 2, 7

RECOMMENDATION 4
- Title: Single-flight lives in one in-process analysis service that BOTH the POST route and the hourly check call
- AC defended: AC5, AC6
- Principle: A1 (one owner of durable state) + B6 (single-shot ack discipline, applied to a job)
- What to get right: The `kb-analysis` service owns a single `inFlight` slot holding `runId` and `startedAt`; the slot is claimed synchronously before the first `await` so two POSTs arriving in the same tick cannot both pass the check, and it is cleared in a `finally` regardless of outcome. `POST /run` returns 202 with the new `runId` when it claims the slot and 409 (via `respondError` with the existing `conflict` code) carrying the in-flight `runId` and `startedAt` when it cannot; the hourly check uses the same claim and logs `kb_analysis.skipped_in_flight` instead of starting a second run. The job promise must not escape unhandled: the route fires it with its rejection path fully inside the service, and the response is written before the job does any filesystem work.
- Risk if skipped: Two concurrent runs write two report files with overlapping timestamps, "exactly one analysis runs" (AC5) is violated, and an unhandled rejection from the fire-and-forget job crashes the Bun process.
- Depends on: 1

RECOMMENDATION 5
- Title: Decision POST validates the whole array against the current report before applying anything
- AC defended: AC7, AC8, AC9
- Principle: A2 (validate at the boundary) + A8 (closed unions)
- What to get right: Parse the body inside a catch that returns 400 on malformed JSON; require a non-empty array bounded by the number of findings in the report; require each item to carry `entryId` matching a finding id in the latest report, a `decision` from the closed set, and `mergeInto` present if and only if the decision is merge and naming a live KB id; require a `runId` in the body and answer 409 if it is not the latest report, so a stale tab cannot act on a superseded run. Validate every item first and only then apply, so a 400 never leaves half the array archived; memory findings accept only `seen`, and `archive`/`merge`/`keep` on a memory finding is a 400 (never a silent no-op). Use `respondError` with `validation_failed`, keep the offending field names in the server-side `detail` only.
- Risk if skipped: A typo or a stale page archives the wrong KB line, or the server applies three decisions, rejects the fourth, and the client cannot tell which ones landed.
- Depends on: 1, 10

RECOMMENDATION 6
- Title: Operational failures of the analysis job become a recorded `lastRun.status = failed`, not a swallowed rejection
- AC defended: AC5, Must (spec §5 `event=kb_analysis.*`)
- Principle: A1 (programmer errors crash, operational errors are handled) + A6 (structured logging)
- What to get right: Inside the job, treat missing KB dir, corrupt JSONL lines, EACCES on the memory dir, and a failed report write as operational: log one `kb_analysis.failed` line with a closed `reason` and `runId`, persist the failure into the service state so `GET /latest` can say "last run failed at T: reason", and release the single-flight slot. Everything the job logs carries `event` in the `kb_analysis.` namespace (`started`, `not_due`, `due`, `finished`, `failed`, `skipped_in_flight`, `report_written`, `decision_applied`) with `runId` on every line after start. Catch as `unknown` and narrow; never `.catch(() => {})` on the report write or the decisions append.
- Risk if skipped: The button shows "running…" forever after a crash, or the page says "no analysis yet" while journalctl holds the only evidence that one failed.
- Depends on: 4

RECOMMENDATION 7
- Title: Tap the drift emit sites through one in-module helper that logs AND pushes, fed by an optional `DriftEventSink` dep
- AC defended: AC2
- Principle: A6 (structured logging as the observability surface) + Carmack "make data flow visible"
- What to get right: Inside `session-recovery.ts`, route the ten `silent_stdio_drift.*` emits (and the relaunch / boot-resume `orchestrator` lines the spec also wants) through a single private helper that calls the existing `log.warn`/`log.info` with the exact same module, message and payload, then hands the same payload plus a wallclock `ts` to a `driftEventSink` injected via `SessionRecoveryDeps` (optional, default no-op). The pinned tests spy on the logger and filter by `event`, so they stay byte-identical; the ring and the log line are provably the same object because there is one assembly site. The ring itself is a tiny pure class with fixed capacity and oldest-eviction, a `snapshot(sinceMs)` that returns newest-first, and its own unit test; it stores only the scalar fields the log line already carries (event, sessionId, reason, mtimeDeltaMs, bunLastFrameMs, cliVersion, trigger), never the full `evidence` with wait channels.
- Risk if skipped: A second hand-built payload at each emit site drifts from the log line within a release, and the page shows a reason the journal does not.
- Depends on: —

RECOMMENDATION 8
- Title: Extract the 5-min snapshot assembly into a pure builder; the tick logs it, the route reads it fresh
- AC defended: Must (spec §3.1 Backend card)
- Principle: A8 (type safety) + Carmack "structure should make intended behaviour obvious"
- What to get right: Move the object literal in the `diagnostics.tick` into a pure `buildRuntimeSnapshot(deps)` that the tick calls and logs unchanged (the EC-19 canary pins the key set, so the builder must return exactly those keys and the canary test should be pointed at the builder's output). The overview route calls the same builder on request — it is synchronous, memory-only and microsecond-cheap (`metricsCollector.getSnapshot`, `process.memoryUsage`, a Map size) — so no cache or second timer is needed; additionally keep the last tick's result and its `at` so the card can show "last logged snapshot at T" beside the live values. Add API-only fields (process pid, `serverUptimeMs`, package version, event-loop-lag monitor's last report) to the response object, not to the log line.
- Risk if skipped: Two copies of the field list diverge, the canary passes while the page shows a different number than the journal, and a cached-only snapshot can be five minutes stale during the incident the operator opened the page for.
- Depends on: —

RECOMMENDATION 9
- Title: Pairs snapshot reads the coordinator and adapters; add an inbound-frame timestamp to the adapter interface so Codex is not reported as silent since epoch
- AC defended: AC1
- Principle: B5 (silence is not health) + B7 (two-protocol adapter parity)
- What to get right: Build the pairs card from `coordinator.listAll()` filtered on non-archived status (AP-2 — status comes from the state machine, dead role and degraded reason from the existing lifecycle maps), then per half: sessionId, role, `backendType`, bridge phase, pid, exitCode, `lastCheckpointReceivedAt` from `CouncilGroupMeta`, `last_woken_at` from the wake sentinel, and `lastInboundFrameAgeMs`. The age must come from an optional `getLastCliFrameReceivedMs` on `IBackendAdapter`: Claude already has it; Codex needs the transport's incoming-line hook to stamp it. Until the Codex stamp lands, and whenever the value is zero (Claude's "no frame yet" sentinel), the card must render "no frame yet" rather than computing an age from zero. Expose the snapshot through a method on the lifecycle/orchestrator rather than reaching into private maps.
- Risk if skipped: Every Codex observer shows "silent 20+ years", or the page re-derives degraded/active from pid + socket and disagrees with the state machine (the exact AP-2 violation).
- Depends on: 1

RECOMMENDATION 10
- Title: Keep a tiny failure record in `stats-routes.ts` and `usage-limits.ts`; expose it by getter, leave both public responses unchanged
- AC defended: AC3
- Principle: A1 (operational errors are handled, not flattened) + A5 (fetch bodies consumed)
- What to get right: At the fetch site in each module keep two module-level values — `lastOkAt`, and `lastFailure` with a closed kind (`http` with status, `timeout`, `network`, `parse`; for usage-limits additionally `no_credentials` and `refresh_failed`) plus a `since` that is set on the first failure after the last success and preserved across repeated failures, so "KV quota exceeded since T" is the true onset. Export a read-only getter per module for the overview to consume; do not change the `/stats/global` or `/usage-limits` bodies (one is public and both are pinned by tests). While there, consume or cancel the response body on the non-ok branch — `if (!res.ok) throw` currently leaves the body unread and the connection held — and keep the existing abort timer.
- Risk if skipped: The card can only say "unavailable", the operator still has to guess KV quota vs OAuth expiry, and a 429 that started three hours ago reads as "just now".
- Depends on: —

RECOMMENDATION 11
- Title: KB reads stay sync under one `trackSync` label; memory reads go async in chunks with only the parse segment tracked
- AC defended: AC9, Must (spec §5 "≤ 100 ms, never block the event loop")
- Principle: A7 (the event loop is not magic) + A5 (bounded concurrency)
- What to get right: Loading ~175 KB of KB JSONL with the existing `node:fs` sync reader is a few milliseconds and fits under a single `trackSync("kb-analysis.load")`; keep it sync so the extracted `kb-health` core stays one error shape. The memory dir (471 files, 2.3 MB) must not be read with a sync loop or an all-at-once `Promise.all`: read with `fs/promises` in fixed-size batches (tens of files), yield between batches, and wrap only the synchronous frontmatter parse of each batch in `trackSync("memory-report.load")`. The duplicate detector is quadratic in entry count — fine for 152 KB entries, borderline for 471 memory files with token-set Jaccard — so iterate rows in chunks with a yield between chunks and track each chunk separately, so the lag monitor's top-operations list names the culprit if it ever crosses the threshold.
- Risk if skipped: A manual memory report stalls every CLI stdout pump for a visible fraction of a second, which is the exact event-loop stall the drift detector was built to find.
- Depends on: 6

RECOMMENDATION 12
- Title: The hourly check is a second `CleanupScheduler` with a 1 h interval, unref'd and cleared in `gracefulShutdown`, and only decides — it never analyses inline
- AC defended: AC4, AC5
- Principle: A5 (timer lifecycle) + A1 (error boundaries around periodic work)
- What to get right: Instantiate a second scheduler with `intervalMs` of one hour (inside the clamp) so the check inherits the existing try/catch, `getSweepInFlight`, and `dispose`; register the check as its single sweep and dispose it in `gracefulShutdown` next to `clearInterval(diagnosticsTimer)`. The check body is cheap and sync-safe: it compares the persisted `lastRun` against KB entry `createdAt`/`updatedAt` strings (not file mtimes — a git checkout rewrites mtimes), the finished-session counter, and `maxAgeDays`; when due it calls the service's claim path (Rec 4) and returns; when not due it logs `kb_analysis.not_due` at most once per day using a last-logged timestamp like `lastMemoryPressureWarnAt`. The memory report is never started by the check unless `diagnosticsMemoryReport` is on, and even then only as part of a due run.
- Risk if skipped: A `registerSweep` on the daily instance runs at most once a day (AC4's "hourly" is false), and an un-cleared interval keeps the process alive on SIGTERM or fires into a half-torn-down bridge.
- Depends on: 4

RECOMMENDATION 13
- Title: Define "finished sessions since last run" as distinct session ids seen on `session:exited`, persisted with the run state
- AC defended: AC4, AC5
- Principle: A1 (single owner of durable state) + B7 (backend parity)
- What to get right: Subscribe the analysis service to `companionBus` `session:exited` exactly as `metricsCollector` does and add the sessionId to a bounded set; count the set's size, not the event count, because drift relaunches and auto-relaunches emit `session:exited` several times for one logical session. Both Claude and Codex sessions emit the same bus event, so the count is backend-agnostic by construction. Persist the count and `lastRunAt`/`lastRunId` atomically in a small state file under the diagnostics dir on each change (debounced) so a restart between runs does not reset the accumulation to zero; do not derive it by scanning the session store on every tick.
- Risk if skipped: One wobbly session with three relaunches counts as three finished sessions and triggers an analysis on noise, or every restart silently resets the progress the KB card shows.
- Depends on: 12

RECOMMENDATION 14
- Title: `GET /latest` serves the in-memory latest report loaded once; report files are validated by `schemaVersion` and never re-read per poll
- AC defended: AC5, AC6
- Principle: A7 (no fs in the poll path) + A8 (boundary validation on our own files too)
- What to get right: After a successful run the service keeps the report object in memory and writes it atomically; at boot it loads only the newest file under `trackSync`, validates `schemaVersion` and the top-level shape, and on mismatch or corruption exposes an unavailable variant with the reason rather than throwing. `GET /latest` returns the in-memory `{inFlight, lastRun, accumulation, report}` without touching disk. Cap findings per signal in the report writer so the wire object stays bounded by KB size, and include the `runId` the decisions route will demand back.
- Risk if skipped: The page's 5-second poll becomes a JSON file read plus parse on every tick, and a report from a future schema crashes the handler into a 500 on every load.
- Depends on: 4, 6

RECOMMENDATION 15
- Title: Validate the three numeric settings and the flag at the PUT boundary with bounds; extend the `Pick<>` allow-list and `normalize` defaults together
- AC defended: AC4, Must (spec §3.2 "thresholds in Settings, not code")
- Principle: A2 (validate at the boundary) + A8 (schema and type move together)
- What to get right: In `settings-routes.ts` accept the thresholds only as positive integers within sane bounds (entries up to a few thousand, sessions up to a few thousand, days 1–365) and `diagnosticsMemoryReport` only as a boolean, with the same 400 message style as the existing fields; add the keys to `updateSettings`'s `Pick<>` allow-list, to `normalize` with the 10/25/14/false defaults, and to the GET/PUT echo so the UI reads back what it wrote. The hourly check reads the thresholds on every tick via `getSettings()`, never captures them at boot.
- Risk if skipped: A `0` or `-1` threshold makes every tick "due" and the analyzer runs hourly, or a key missing from the allow-list is silently dropped and the owner's change never takes effect.
- Depends on: 12

RECOMMENDATION 16
- Title: Stay on `node:fs` for the extracted KB core and all new persistence; no `Bun.file`, no cross-filesystem rename
- AC defended: AC8, Must (spec §5 atomic writes)
- Principle: A9 (Bun-specific behaviour — one error shape per concern)
- What to get right: The extracted `kb-health` core already uses `node:fs` with a tmp-and-rename archive move that writes the archive BEFORE rewriting the live store; keep that exact module as the only writer of `.agents/knowledge` and call it from the decisions route with a single load and a single rewrite per store for the whole batch, not one rewrite per decision. Reports and `decisions.jsonl` live under `~/.companion/diagnostics/kb-analysis/`, where `writeAtomicJson`'s same-directory tmp+rename is atomic; the decisions append uses one `appendFileSync` per line with the `a` flag like `recordPrime`. Avoid `Bun.file` reads here so ENOENT and EACCES surface as the same `ErrnoException` shapes the rest of the server narrows on.
- Risk if skipped: Mixed read APIs produce two different "file missing" errors that the unavailable-state mapping handles inconsistently, and a per-decision rewrite loop turns a five-item POST into ten fsyncs inside a request handler.
- Depends on: 5
