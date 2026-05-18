# ritchie — Unix-discipline review (§A Process / §B Filesystem)

PR #68 (`feat/council-mode-bootstrap-rest`) — bootstrap REST endpoint repopulating the browser's `groupBySessionId` map on app mount. The PR is **read-only against in-memory coordinator state**; no subprocess interactions, no disk writes. The Unix-discipline lens therefore has a narrow target surface: confirm the read does not accidentally couple to process or persistence state machines, and confirm the snapshot semantics are tight enough for the REST consumer.

Verdict: no §A P1/P2; one §B P3 about snapshot reference-sharing; one §A P3 about reconnect-window truthfulness of the response. Both observations, not blockers.

---

## §A Process lifecycle

### A-1. `getAllGroupsForBootstrap` is structurally read-only against process state — no spawn/kill/PID coupling

- **Severity:** none (positive confirmation)
- **File:** `web/server/session-orchestrator.ts:2974-2992`, `web/server/session-group-coordinator.ts:502-504`
- **Finding:** The bootstrap path reads exclusively from `this.coordinator.listAll()` which returns `Array.from(this.groups.values())`. Neither the orchestrator wrapper nor the coordinator primitive call into the launcher, send signals, mutate PID tables, touch `--resume` machinery, or interact with reconnect-grace timers. The shared `buildBrowserGroupRecord` helper composes a pure-data wire shape from already-resolved fields and an imported constant; it has no I/O.
- **Consequence:** Concurrent invocations of `GET /api/groups` cannot race the subprocess lifecycle in any way visible to the launcher. The endpoint is therefore safe to expose to browsers that connect / reconnect / reload at arbitrary times during a Council Mode session's life.
- **Fix:** none. Note recorded so reviewers do not re-flag the coupling absence.

### A-2. Response surfaces transient `reconnecting` / `degraded` status without identifying which half died

- **Severity:** P3 — visibility hygiene (not a process-correctness defect)
- **File:** `web/server/session-orchestrator.ts:2984-2989`, `web/server/session-types.ts` (`BrowserGroupRecord.deadRole?`)
- **Finding:** `getAllGroupsForBootstrap` correctly maps the coordinator's live `GroupStatus` onto the wire (this is the intended fix — a reload mid-degraded must not falsely advertise `active`). However, `GroupRecord` on the coordinator does not persist `deadRole`; that metadata lives only on the `ReconnectContext` map and on the bus event payload. When a browser bootstraps during a `degraded` or `reconnecting` window, the response carries `status: "degraded"` but omits `deadRole`, and the frontend panel-state deriver defaults to `"observer"` via `?? "observer"`. If the dead half was the orchestrator, the UI will mis-label the surviving half. The brief explicitly notes this is carry-forward / out-of-scope, but from ritchie's lens it is the §A invariant "the response must not lie about which process the user is talking to."
- **Consequence:** A reload during the 45s reconnect grace, OR after `reconnect_failed`, shows the wrong glyph attribution if the orchestrator is the dead half. The chat surface remains operable (orchestrator-or-observer-survivor branching elsewhere), but the UI conveys incorrect process identity. Low blast radius because: (1) `degraded` is uncommon, (2) the typical dead half is the observer, (3) live `group:degraded` push corrects it within seconds of reload.
- **Fix:** Out of PR #68 scope per brief; recorded so the next PR closing this gap (persisting `deadRole` on `GroupRecord` and routing it through `buildBrowserGroupRecord`) has a citation. No code change here.

### A-3. No `Date.now()` impurity introduced into `transition()` / `applyEvent` paths

- **Severity:** none (positive confirmation)
- **File:** `web/server/group-state-machine.ts:105-132`, `web/server/session-group-coordinator.ts`, `web/server/browser-group-record.ts`
- **Finding:** `transition()` remains a pure `(state, event) → state` function. The diff adds `listAll()` (pure map read) and a new helper file (pure data composition + a constant import). Neither path reads wallclock. The coordinator's existing `Date.now()` / `this.now()` call sites at lines 197/239/415 are unchanged.
- **Consequence:** EC-9 logging determinism + state-machine test purity preserved. Time-travel tests (`vi.useFakeTimers()` with injected clock) continue to work.
- **Fix:** none.

### A-4. `deadRole` synthesis at the coordinator boundary would also close A-2

- **Severity:** P3 — design note for follow-up
- **File:** `web/server/session-group-coordinator.ts:163-171` (`ReconnectContext`)
- **Finding:** The coordinator already holds `deadRole` on the per-group `ReconnectContext`. A future PR could expose it as `coordinator.getDeadRole(sessionGroupId): SessionGroupRole | undefined` and let `getAllGroupsForBootstrap` thread it into the wire shape. This is a small surface, mechanically symmetric to `listAll`, and would eliminate the frontend's `?? "observer"` defensive guess for the bootstrap path. Live push already carries `deadRole` via `group:degraded` event.
- **Consequence:** Closes the only §A truthfulness gap in the bootstrap response. Pair with persisting `deadRole` on `GroupRecord` proper if `degraded` is intended to outlive the reconnect window.
- **Fix:** noted for follow-up, not in PR #68 scope.

---

## §B Filesystem persistence

### B-1. Bootstrap path has zero filesystem side effects

- **Severity:** none (positive confirmation)
- **File:** `web/server/session-orchestrator.ts:2974-2992`, `web/server/session-group-coordinator.ts:502-504`, `web/server/browser-group-record.ts:48-58`
- **Finding:** None of the three changed files call `fs.writeFile`, `writeAtomicJson`, `fs.appendFile`, `fs.rename`, or any `fs/promises` API. `OBSERVER_WAKE_TIMEOUT_MS` is imported as a constant, not a path resolution. No watcher attach. No JSONL append. No rotation interaction. The endpoint produces a wire payload from in-memory state and returns it through Hono's `c.json` serialiser.
- **Consequence:** A crash mid-bootstrap leaves zero on-disk artefacts; `writeAtomicJson` invariants are not touched; recordings are not affected. The bootstrap can be called at arbitrary frequency without impacting durability windows of `session-store.ts`, `recorder.ts`, or `.council/` watchers.
- **Fix:** none.

### B-2. Snapshot semantics — fresh array container, shared `GroupRecord` references

- **Severity:** P3 — semantic precision (current usage is safe)
- **File:** `web/server/session-group-coordinator.ts:502-504`
- **Finding:** `listAll()` returns `Array.from(this.groups.values())`. This produces a fresh array per call (good — the test at `session-group-coordinator.test.ts:191-200` pins it), but the `GroupRecord` objects inside that array are shared by reference with the coordinator's internal `Map`. A caller iterating the snapshot WILL observe in-place mutations of those records' fields (`status`, `cycleNumber`, `convergenceState`, etc.) if the coordinator's state machine fires concurrently with iteration.
- **Consequence:** Today's only consumer is `getAllGroupsForBootstrap`, which reads each record's fields in a single synchronous loop and constructs immutable wire payloads via `buildBrowserGroupRecord`. There is no event-loop yield inside the loop, so no concurrent mutation can interleave. Safe by current usage. Future callers that hold the snapshot across an `await` would silently observe later coordinator mutations — a footgun.
- **Fix:** If a future caller needs cross-yield snapshot stability, either (a) deep-clone each record at `listAll()` time, (b) freeze the records at the coordinator boundary, or (c) document the by-reference contract at the JSDoc and reject async-iteration callers. None of these are needed for PR #68; flag for any reuse of `listAll` outside the synchronous bootstrap path.

### B-3. No accidental write-amplification via bootstrap

- **Severity:** none (positive confirmation)
- **File:** `web/server/routes.ts:498-500`
- **Finding:** The route handler calls `orchestrator.getAllGroupsForBootstrap()` and returns the result. No debounced-write trigger, no `session-store.markDirty()`, no audit-log append. The endpoint is idempotent at the disk layer: N calls produce zero writes.
- **Consequence:** A misbehaving client polling `GET /api/groups` cannot cause disk I/O amplification. The bootstrap is bounded to in-memory cost only.
- **Fix:** none.

### B-4. Empty-coordinator path returns empty wire — no implicit persistence-restore attempt

- **Severity:** none (positive confirmation)
- **File:** `web/server/session-orchestrator.ts:2975`
- **Finding:** `if (!this.coordinator) return [];` short-circuits when Council Mode has not been used this server uptime. There is no fallback that tries to read group records from disk — consistent with the in-memory-only nature of the coordinator's `groups` map. Aligns with the `feedback_in_memory_derived_state_reconcile_on_restart` learning: this map is **intentionally not restart-durable**; pairs are torn down on server restart and re-created if the user wants them.
- **Consequence:** A post-restart bootstrap correctly returns `{groups: []}`. The frontend's defensive `?? "active"` fallback for the live `group_created` frame (per context-brief) handles the case where a buffered legacy frame lands before a fresh pair-create.
- **Fix:** none.

---

## Summary

PR #68 lands cleanly through the Unix-discipline two-axes lens:
- §A: zero process-lifecycle coupling introduced; one pre-existing visibility gap (A-2, `deadRole` not on `GroupRecord`) is documented as out-of-scope carry-forward, not a PR #68 regression.
- §B: zero filesystem side effects; one snapshot-reference-sharing nuance (B-2) is correct for the synchronous bootstrap consumer but warrants a JSDoc note if `listAll` is ever reused across an `await`.

No P1 / P2 findings.
