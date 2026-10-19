# Filesystem JSON-Store Persistence Review — Observer Auto-Wake (Story 2 AC#1)

Lens: **Carmack × FS-JSON Persistence Expert** (atomic writes, debounce windows, sentinel/orphan, append-safety, rotation invariants, replay determinism, schema evolution).

Files in scope:
- `web/server/council-wake-sentinel.ts` (NEW)
- `web/server/recorder.ts` (v1 → v2 schema bump, `origin` field)
- `web/server/replay.ts`
- `web/server/recording-hub/hub-store.ts`
- `web/server/session-orchestrator.ts` (sentinel I/O at `dispatchObserverWake` + initialize())

Convention floor honoured by author (NOT re-flagged): AP-1..AP-3, EC-1..EC-9. I flag violations of EC-8 where applicable but not the convention itself.

---

## P1 Findings — Fix Now (durability gap, data-loss mode, corruption)

### P1-1 — Promised restart-gap catchup scan is missing; checkpoint→wake pipeline silently under-wakes across crashes

**File:** `web/server/session-orchestrator.ts` (`reconcileCouncilGroups`, line ~668; `startCouncilWatchers`, line ~1070)

**Failure mode:** The context-brief (line 16-18) and the sentinel module's own JSDoc (lines 13-18 of `council-wake-sentinel.ts`) describe two consumers — pre-dispatch idempotency guard AND **"restart reconcile: on initialize, the reconciler scans `.council/checkpoints/<phase>.json`, finds the highest-sequence checkpoint per group, compares against the sentinel. A gap means a checkpoint landed but the observer never received a wake — fire one on resume."** Consumer #2 is **not implemented**.

`reconcileCouncilGroups` rebuilds `councilGroupMeta` and calls `startCouncilWatchers` — which only attaches `fs.watch` (event-only, no pre-scan). `checkpoint-watcher.ts` confirms: it iterates `for await (const ev of watch(...))`; pre-existing files at attach time are invisible to Node's `fs.watch`. The sentinel's `last_woken_sequence` field is recorded on every write but **never read** by any code path — `dispatchObserverWake`'s Gate 0 (line 1224-1237) only does `last_woken_checkpoint_id === payload.checkpoint_id` equality, and that gate only fires when a payload arrives via the watcher in the first place.

**Concrete crash scenario** (the one the sentinel was designed to close):
1. Orchestrator atomically writes `.council/checkpoints/phase-G.json` (seq 7).
2. Server crashes BEFORE `dispatchObserverWake` runs (`handleCouncilCheckpoint` invokes it synchronously inline at line 1170, so the window is small, but it includes: emit `group:checkpoint` bus event, then sentinel read, build manifest, build wake body, narrow-to-adapter, adapter send. Adapter-send is the largest sub-window.).
3. Server restarts. `reconcileCouncilGroups` runs, registers the group, calls `startCouncilWatchers`. `fs.watch` attaches to the directory. **Nothing emits for the pre-existing seq-7 file.**
4. Observer sits idle forever for seq 7. The next checkpoint (seq 8) wakes it on seq 8 but uses seq 8's payload (delta-since-seq-7 is the manifest source if `entry.lastCheckpoint` is still null after restart — but it is null because the watcher never re-emitted seq 7, so the manifest treats seq 8 as the first checkpoint and the seq-7 delta paths never get reviewed).

The fix the brief promised: in `reconcileCouncilGroups` (or `startCouncilWatchers` before the `fs.watch` attach), `readdirSync(checkpointsDir)`, parse each `*.json`, find the highest-sequence checkpoint, compare to `readCouncilWakeSentinel(...)` — if `payload.sequence > sentinel?.last_woken_sequence ?? -1` (or sentinel is null and any checkpoint exists), synthesise a `handleCouncilCheckpoint` call. That's the only thing `last_woken_sequence` is for; without it the field is dead weight.

**Severity rationale:** P1 because (a) the brief explicitly promised this; (b) the user-visible failure mode is **silent under-review** of any phase whose checkpoint landed in the crash window — observer never wakes, no review file lands, no banner, no log line of "missed checkpoint" on restart, just silence; (c) it's the highest-leverage durability promise the sentinel makes — without it the sentinel only does in-restart-LRU dedup that the watcher's own seenCheckpointIds set already handles within a single uptime, so the whole module is currently load-bearing for ~5% of its design surface.

**Carmack synthesis:** *"If you can't see the cost, you can't reason about correctness."* The dead `last_woken_sequence` field is the tell — it has no reader, which means the design intent never landed. Either implement the scan (close the gap) or drop the field (admit the scope reduction).

**Severity:** **P1**

---

## P2 Findings — Fix Soon (crash window, orphan state, silent schema drift)

### P2-1 — Sentinel write failure logs at WARN but doesn't degrade the group; second-restart double-wake hole

**File:** `web/server/session-orchestrator.ts` lines 1321-1334; `council-wake-sentinel.ts` lines 130-143

**Failure mode:** When `writeCouncilWakeSentinel` throws (disk full, perm denied, parent FS read-only, fsync EIO on the parent-dir fsync inside `writeAtomicJson`), the catch on lines 1326-1334 logs `council.wake.sentinel_write_failed` and continues. The wake has already shipped to the observer's CLI socket. If the server then crashes before the observer responds with `result`, on restart **Gate 0 fails to dedup** (no sentinel on disk) AND the gap-scan (if it existed per P1-1) would re-dispatch the wake. The observer sees the same wake twice. The comment on line 1318-1320 acknowledges this ("the worst case is restart-replay double-wakes that the seq-monotonic guard would still catch") — but the seq-monotonic guard at line 1143 only fires when `entry.lastCheckpoint !== null`, which is the in-memory state that's **null after restart**. So that "guard" doesn't catch this case.

**Concrete:** sentinel write fails on a host whose `.council/state/` is on a read-only mount (FUSE quirk, ZFS snapshot, NFS-with-EROFS-on-rename). The server logs, ships wakes happily across the uptime, then on restart re-ships every wake. Observer processes them all, produces duplicate reviews — `validateObserverFindings` will produce duplicate `fnd_<hex>` ids (deterministic, so same content → same id) which the browser dedups, but the observer wastes a turn per duplicate, and the `observer:turn-done` listener semantics get muddier.

**Suggested fix:** On sentinel write failure, also `applyEvent({ type: "user_archived" })` or `group:degraded` the group with a structured reason (`sentinel_write_failed` would extend the `group_degraded.reason` enum the brief mentions on line 31 as "not yet emitted"). Better to lose the council pair loudly than to ship undeduped wakes silently.

**Severity:** **P2** — failure surface is narrow (write-only FS condition during normal runtime), recovery on restart is double-work not data loss, but the in-flight comment's "seq-monotonic guard catches it" claim is wrong post-restart.

---

### P2-2 — `parseCouncilWakeSentinel` returns `null` on schema_version mismatch with no migration or telemetry

**File:** `web/server/council-wake-sentinel.ts` lines 75-94

**Failure mode:** Line 84 — `if (obj.schema_version !== COUNCIL_WAKE_SENTINEL_SCHEMA_VERSION) return null`. When the team eventually bumps to schema v2 (the JSDoc on lines 27-30 explicitly anticipates this — *"A future v2 bumps the accepted set in the reader"*), every existing on-disk sentinel reads as `null`. Callers (`dispatchObserverWake` Gate 0) treat null as "no record of a prior wake" and **proceed with the dispatch**. So a v1→v2 bump silently causes a one-time double-wake for every active group on the first checkpoint after deploy.

Compare to the recorder's approach (`RECORDING_HEADER_VERSIONS_ACCEPTED: ReadonlySet<...>`) — that's the right pattern. The sentinel should ship the same shape now (`COUNCIL_WAKE_SENTINEL_VERSIONS_ACCEPTED`) so the next bump just adds to the set and migrates fields. Currently the schema-evolution surface is a foot-gun the JSDoc promises is solved but the code does not solve.

Additionally: a corrupted sentinel returning `null` looks identical to a missing sentinel from the dispatcher's POV. There's no telemetry distinguishing "first checkpoint ever" from "parse failed for an existing file" — operators have no signal that a corruption happened. The reader should log at WARN on `JSON.parse` success + validation failure (distinct from ENOENT, which is the silent-default case).

**Suggested fix:**
1. Introduce `COUNCIL_WAKE_SENTINEL_VERSIONS_ACCEPTED: ReadonlySet<1>` now (one-element set, future-proof structure).
2. Distinguish ENOENT (silent, return null) from validation failure (log at WARN with path + reason).

**Severity:** **P2** — currently dormant (v1 only exists), but the design surface is already in JSDoc and the next bump bypasses the safety the JSDoc claims.

---

### P2-3 — Recorder schema v2 `origin` field is consumed without explicit version-branching in `hub-store.ts` validators

**File:** `web/server/recording-hub/hub-store.ts` lines 90-114

**Failure mode:** `importContent` accepts any version in `RECORDING_HEADER_VERSIONS_ACCEPTED` (good), but the entry validator on lines 103-107 checks only the v1 invariants (`ts`, `dir`, `raw`, `ch`). A v1 reader running on a v2 file with `origin: "server:council-wake"` accepts the entry — the field is silently dropped by the validator (it doesn't touch `origin`). Good for back-compat. **But**: a future v3 that makes `origin` required (or renames it) would still validate against the v1 check, masking the regression. The version field becomes informational rather than load-bearing.

The recorder header bump (v1→v2) added `origin` as an *optional* field, which is back-compat-safe. The risk lands when a future bump makes `origin` semantic (e.g. v3 splits "browser" into "browser-relay" vs "browser-replay" and downstream tooling branches on it). The validator should already branch on `header.version` so each version's invariants are enforced by their own rules. Today's code is one schema bump away from a silent drift.

**Concrete:** the validator at line 104 — `if (typeof entry.ts !== "number" || !entry.dir || typeof entry.raw !== "string" || !entry.ch)` — never grows when the schema does. A v3 entry with a malformed `origin` would import successfully and surface later as garbage in the hub UI.

**Suggested fix:** Move per-version invariant checks behind `switch (header.version)` even though v1 and v2 invariants happen to be identical today. The structural slot signals "this is where v3 would add its check".

**Severity:** **P2** — currently safe; structural reservation for the next bump.

---

### P2-4 — `.council/state/<groupId>-wake.json` survives group archive; orphan sentinel accumulation

**File:** `web/server/council-wake-sentinel.ts`; `web/server/session-orchestrator.ts` `stopCouncilWatchers` (line 1128)

**Failure mode:** When a group is archived via `applyEvent({ type: "user_archived" })`, `stopCouncilWatchers` (line 1128-1133) aborts the AbortController and deletes the in-memory watcher entry. The sentinel file at `.council/state/<groupId>-wake.json` is **not** unlinked. Per-group, ~200 bytes, bounded as the brief notes — but only bounded by the number of groups ever created in a workspace. A workspace used heavily (50+ council pairs created/torn-down over weeks) accumulates 50+ sentinel files for groups that no longer exist.

Direct user-visible impact: nothing today (no code reads sentinels by directory scan, only by exact group-id path). But the orphan-state principle (Principle 3: *"close every state on every exit path"*) is violated. If/when the P1-1 catchup scan is implemented, it'll likely read `.council/state/` (or at least filter the checkpoint scan by archived-status), and an unlink-on-archive becomes load-bearing.

**Suggested fix:** Add `unlinkSync(councilWakeSentinelPath(workspaceCwd, sessionGroupId))` (wrapped in try/catch swallowing ENOENT) inside `stopCouncilWatchers` for the `user_archived` exit path. Don't unlink on transient `group:degraded` — that's not a final exit.

**Severity:** **P2** — disk leak is bounded and slow; design-floor violation more than acute risk.

---

## P3 Findings — Hygiene / Consistency

### P3-1 — `councilWakeSentinelPath` joins workspace + relative path without realpath; cross-FS rename on weird workspaces

**File:** `web/server/council-wake-sentinel.ts` lines 62-64; `web/server/atomic-write.ts`

**Observation:** `writeAtomicJson` (per its own contract, lines 23-26) writes `.tmp` in the same `dirname(target)` and renames within that directory — so rename is on the same filesystem **as the target**. Correct.

But if `workspaceCwd` is itself a symlink straddling filesystems (rare but possible: workspace at `/home/user/proj` symlinked to `/mnt/nfs/proj`, with `.council/state/` resolved to NFS), the rename is on NFS — which is atomic per POSIX but exhibits stale-NFS-handle on concurrent reads. The sentinel design is fine for local FS; flag as P3 since the watch-and-write flow already assumes local-FS semantics elsewhere.

**Severity:** **P3** — out-of-scope for a local dev tool; flag for the deploy doc.

---

### P3-2 — `last_woken_at` ISO timestamp is wall-clock; usable for forensics but stamped at write-time not send-time

**File:** `web/server/council-wake-sentinel.ts` line 140 (`new Date().toISOString()`)

**Observation:** Stamped inside `writeCouncilWakeSentinel`, **after** the bridge send returns `{ kind: "sent" }`. So the timestamp reflects the sentinel-write moment, not the wake-send moment. Difference is microseconds for the happy path, but if `writeAtomicJson` is slow (NFS, encrypted FUSE), the field becomes misleading. Field is documented as "Wallclock ISO 8601 of the wake send" (line 50) which is now subtly wrong.

**Suggested fix:** Either (a) pass `wokenAt: number` from `dispatchObserverWake` into `writeCouncilWakeSentinel` so the timestamp is captured at send-completion, or (b) rename the field to `last_woken_recorded_at` to match what it actually is.

**Severity:** **P3** — forensic precision.

---

### P3-3 — JSONL line-discipline check on recorder `origin` field — confirmed safe

**File:** `web/server/recorder.ts` lines 132-153

**Observation:** Verified — `origin` is a string literal type (`"browser" | "server:council-wake"`), never multi-line, never user-controlled. `JSON.stringify(entry) + "\n"` is the same write idiom as before. `appendFileSync` writes atomically up to PIPE_BUF (~4KB on Linux); a recorded entry with `origin` is well under that. No line-discipline regression. **No finding.**

---

### P3-4 — Disk-space accounting for recorder wake frames — confirmed safe

**File:** `web/server/recorder.ts` `cleanup()` method, lines 365-419

**Observation:** Verified — the rotation budget is total lines across all files, capped at 1M. Council-wake frames count as one line each, same as any other `out` frame. No new uncapped path. The cleanup loop skips active recorders (line 402). The wake-frame additions don't change the budget shape. **No finding.**

---

### P3-5 — Sentinel directory creation chain — confirmed via `writeAtomicJson` mkdir-recursive

**File:** `web/server/atomic-write.ts` line 25; `web/server/council-wake-sentinel.ts` lines 56-64

**Observation:** Verified — `writeAtomicJson` does `mkdirSync(dir, { recursive: true })` unconditionally at the top of every call. The sentinel's `councilWakeSentinelPath` returns `<cwd>/.council/state/<groupId>-wake.json`; `dirname(target)` resolves to `<cwd>/.council/state`, which mkdir-recursive creates on first write. The JSDoc on lines 56-60 correctly cautions against pre-creating from the orchestrator side (TOCTOU window with the watcher arming on `.council/`). Sentinel module is self-sufficient. **No finding.**

---

## Summary Table

| ID | Severity | Title | File |
|----|----------|-------|------|
| P1-1 | **P1** | Promised restart-gap catchup scan is missing; `last_woken_sequence` is dead weight | session-orchestrator.ts initialize/reconcile |
| P2-1 | **P2** | Sentinel write failure logs but doesn't degrade group; restart double-wake hole | session-orchestrator.ts line 1321 |
| P2-2 | **P2** | Sentinel schema version mismatch returns null; future v2 bump = one-time double-wake storm | council-wake-sentinel.ts line 84 |
| P2-3 | **P2** | Recorder v2 entry validator doesn't branch on version; next bump masks regressions | hub-store.ts line 104 |
| P2-4 | **P2** | Sentinel file survives group archive; orphan accumulation per workspace | session-orchestrator.ts stopCouncilWatchers |
| P3-1 | P3 | Workspace-symlink-cross-FS rename concern | council-wake-sentinel.ts line 62 |
| P3-2 | P3 | `last_woken_at` timestamp captured at write-time not send-time | council-wake-sentinel.ts line 140 |

**Lane discipline:** All findings address concrete data-loss, durability gap, or schema-evolution corruption modes per the FS-JSON Persistence reference. No code; no re-flagging of EC-1..EC-9 or AP-1..AP-3.

**One-line verdict:** Sentinel module is well-built in isolation; the catchup-scan it was designed to enable (P1-1) is the single load-bearing absence and the only reason `last_woken_sequence` exists at all. Recorder v1→v2 bump is back-compat-safe but the version-branching surface (P2-3) is one bump from drift.
