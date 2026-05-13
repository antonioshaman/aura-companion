# FS-JSON Persistence — Regression Review (2026-05-13-0150)

Reviewer: Carmack × FS-JSON Persistence Expert
Pass: regression (second pass on observer auto-wake)
Files reviewed:
- `web/server/council-wake-sentinel.ts`
- `web/server/session-orchestrator.ts` (scanForMissedObserverWakes + group:exited handler)
- `web/server/recorder.ts`
- `web/server/replay.ts`
- `web/server/recording-hub/hub-store.ts`

---

## Verification of prior-pass fixes (no re-flag)

The 1 P1 + 4 P2 + 2 P3 prior-pass items in scope land correctly:

- **EC-12 reconcile (#6)**: `scanForMissedObserverWakes` at `session-orchestrator.ts:676-736` is wired into `initialize()` at line 657, immediately after `reconcileCouncilGroups()`. Sequencing is correct — watchers + meta must exist before the scan dispatches.
- **Sentinel cleanup (#16)**: `deleteCouncilWakeSentinel` exists at `council-wake-sentinel.ts:155-166` and is called from the `group:exited` listener at `session-orchestrator.ts:1001`. Done BEFORE `stopCouncilWatchers` so `entry.cwd` is still available — the comment at line 996 documents the ordering invariant.
- **Sentinel write failure log (#14)**: bumped to `log.error` with `incident: "second_restart_double_wake_possible"` at `session-orchestrator.ts:1502-1510`.
- **Cross-group filter on scan (Hunt sibling)**: `payload.session_group_id !== groupId` guard at line 700 prevents a foreign-tenant checkpoint from waking the wrong observer. Matches the runtime gate in `handleCouncilCheckpoint` at line 1262.
- **Recorder v2 / replay / hub-store**: `RECORDING_HEADER_VERSIONS_ACCEPTED = {1, 2}` is consumed by `replay.ts:34` and `hub-store.ts:90` symmetrically — no path silently rejects either version. Writer always emits v2 at `recorder.ts:23, 119`.

`scanForMissedObserverWakes` correctness against the focus checklist:
- **Missing dir** → inner `try/catch` around `readdirSync` at lines 681-689 swallows ENOENT and `continue`s. ✓
- **Corrupt individual checkpoint file** → `parseCheckpointPayload` returns null; `if (!payload) continue;` at line 699 skips. ✓
- **Cross-group foreign checkpoint** → filter at line 700 (`if (payload.session_group_id !== groupId) continue;`). ✓
- **Bounded sync loop** → `O(groups × files-per-group)` synchronous; acceptable for dev-tool scale. The outer `try/catch` at line 728-734 catches any unforeseen throw per group so one bad group does not abort initialize for the others. ✓

The remaining seeding question (raised in the brief) is real and is filed as Finding #3 below. Sentinel cleanup gap (also raised in the brief) is filed as Finding #1 below.

---

## NEW Findings

### Finding #1 — Sentinel orphaned when group transitions to `degraded` (both-halves-died / reconnect-timeout) **[P2]**

**Where:** `web/server/session-orchestrator.ts:997-1018` (`group:exited` listener) interacting with `web/server/group-state-machine.ts:170-186` (transition to `degraded`).

**The data-mode:** `deleteCouncilWakeSentinel` is invoked exclusively from the `group:exited` bus listener. Inspecting `deriveSideEffects` in `group-state-machine.ts`, the only event that produces `{ kind: "exited" }` is `next === "archived"` (line 190), which is reached only via `user_archived` / `user_killed`. The transitions `active → degraded` (`half_died`) and `reconnecting → degraded` (`reconnect_failed`) do NOT emit `group:exited` — they emit `{ kind: "degraded" }`. A council group that loses both halves and reaches `degraded` without the user explicitly archiving leaves `<workspace>/.council/state/<groupId>-wake.json` on disk indefinitely.

The same orphan also occurs in the `relaunchExhaustedNotified` short-circuit at `session-orchestrator.ts:1068-1075` — both halves get marked intentional, the state machine moves to `degraded`, no `group:exited` fires, sentinel survives.

**Why it matters:** Per Principle 3 (sentinel close-on-every-exit) and Principle 5 (rotation invariants). `.council/state/` accumulates one orphan file per derelict group across sessions. For a single workspace this is small, but for a long-lived workspace exercised across many CI/dev cycles it grows unboundedly. More subtle: the sentinel for a `degraded` group is still consulted by `scanForMissedObserverWakes` on the NEXT server restart (the watcher reattaches because `reconcileCouncilGroups` re-registers any non-archived group at lines 787-822). If the user later archives the workspace + recreates a new group with the same `sessionGroupId` (cryptographically improbable but allowed for resumed sessions), the stale sentinel could mask a legitimate wake.

**Severity:** P2 — orphan state accumulation in a workspace-scoped directory with a small but real semantic-correctness exposure on restart-reconcile. Not P1 because the group-id collision is cryptographically rare and the accumulation is bounded by user behaviour (workspaces are dev-machine local).

**What to verify:** Either (a) extend `deriveSideEffects` to emit a separate `{ kind: "settled"; reason: "both_halves_died" }` side-effect on the `→ degraded` transition and route sentinel cleanup off it; or (b) clean the sentinel in the existing `group:degraded` listener at line 917 alongside the queued-checkpoint drop already there. Option (b) is the smaller diff and matches the watcher-side already-drop-queued semantic — once `degraded`, the group cannot receive further wakes for this lifetime, so the sentinel has no further value.

**Note:** The `GroupBusSideEffect` type at `group-state-machine.ts:98` declares `reason: "user_archived" | "shutdown" | "both_halves_died"`, but `deriveSideEffects` only ever produces `user_archived`. Type allows two values that the producer cannot emit — adjacent dead-type hygiene, not a P-level finding but worth pruning alongside.

---

### Finding #2 — Recorder lifecycle event `dir: "in"` mislabels server-emitted close metadata **[P3]**

**Where:** `web/server/recorder.ts:160-179` (`recordEvent`).

**The data-mode:** Lifecycle events (`ws_open`, `ws_close`, `ws_error`, `reconnect_attempt`, `reconnect_success`) are written with `dir: "in"` hardcoded at line 165. The direction field is supposed to mean "received by server" vs "sent by server" per CLAUDE.md and per the doc-comment at `recorder.ts:55`. A `ws_close` triggered by the server's own teardown (`closeAll`, `stopRecording`, intentional kill) is structurally an "out" event — the server initiated the close, the peer received it. Replay tooling consuming `dir` to reconstruct who-acted-first will misattribute server-initiated closures as peer-initiated.

**Why it matters:** Principle 7 — replay determinism. The current shape isn't lossy enough to corrupt session bytes, but a replay-diff tool keying on `dir` to assert "the CLI closed first" will get the wrong answer when the server SIGTERM'd the CLI. The recorder is v2 already and the brief notes "no further changes" — but this question is a v2-era hygiene point that the prior pass didn't surface.

**Severity:** P3 — diagnostic-only impact, no on-disk corruption, no user-visible data loss. Worth filing because lifecycle events are explicitly diagnostic and `dir` is the obvious axis to ask about them.

**What to verify:** Either rename the field on lifecycle entries (e.g. `actor: "server" | "peer"`) so it doesn't reuse the data-direction axis, or drop `dir` to a per-event-required choice. The existing v2 readers in `replay.ts` and `hub-store.ts` accept missing fields gracefully — adding a `dir` distinction won't break replay back-compat.

---

### Finding #3 — Watchpoint: `scanForMissedObserverWakes` seeds `entry.lastCheckpoint` even when dispatch is skipped **[P3 — watchpoint]**

**Where:** `web/server/session-orchestrator.ts:725-727`.

```
entry.previousCheckpoint = entry.lastCheckpoint;
entry.lastCheckpoint = highest;
this.dispatchObserverWake(groupId, highest);
```

**The data-mode:** The scan unconditionally seeds the watcher entry with `highest` as `lastCheckpoint` BEFORE calling `dispatchObserverWake`. If dispatch is then skipped (reasons surveyed: `already_woken`, `observer_unknown`, group status `reconnecting`/`degraded`/`pairing`/`archived`, `build_error`, `backpressure`, `socket_disconnected`, `observer_busy`), the in-memory state still says "the highest seq is X" but no wake was sent and (for non-`sent` outcomes) no sentinel was written.

The seeding choice is semantically defensible: the scan is the **idempotency source of truth** for "what is the highest sequence on disk right now," independent of whether dispatch succeeds. Subsequent live `fs.watch` events with `sequence <= highest.sequence` get dropped at the monotonicity guard in `handleCouncilCheckpoint:1276` — correct, no double-wake risk. Subsequent live events with `sequence > highest.sequence` find `previousCheckpoint = highest` and `lastCheckpoint = new`, which is the correct delta.

However, **`previousCheckpoint = entry.lastCheckpoint`** at line 725 is `null` on a fresh reconcile (the watcher entry was just registered with `lastCheckpoint: null` at line 1192). So after the scan, `previousCheckpoint = null` and `lastCheckpoint = highest`. Any subsequent live checkpoint sees `previousCheckpoint = highest` correctly. But the **manifest for `highest` itself**, if dispatch later drains a queued wake for it (busy → drain → re-dispatch), is built from `current=highest, previous=null` rather than from `current=highest, previous=(the actual prior on-disk checkpoint)`. The manifest is cumulative, not delta.

This is a watchpoint, not a finding, because:
- On a fresh restart with no prior in-memory state, "previous" really IS unknown — the scan can't reconstruct it without reading every historical checkpoint file ordered by sequence. The orchestrator chose the safe-default (cumulative manifest = larger but always-correct), which trades efficiency for correctness.
- If you wanted a delta manifest after restart, the scan would need to also seed `previousCheckpoint` with the **second-highest** sequence found in the directory. The current code intentionally doesn't, because (i) checkpoint files may have been rotated/deleted between runs, (ii) the previous checkpoint's `artifact_paths` may reference files that no longer exist, and the EC-7 wrapper would drop them as path-traversal anyway.

**Severity:** P3 watchpoint. Document this trade-off in the comment at line 723 — currently it says "Also seed `lastCheckpoint` so subsequent grounding has the manifest context the regular flow would have populated" but doesn't acknowledge that `previousCheckpoint` is left null and the manifest for `highest` will be cumulative if the dispatch was queued and later drained.

**What to verify:** Read the comment, decide whether the cumulative-manifest-on-catchup behaviour matches intent, and either widen the comment or seed `previousCheckpoint` from the second-highest valid checkpoint in the same directory.

---

## Summary

Prior-pass durability gaps are closed cleanly. Three new findings, none critical:
- P2: sentinel orphans on `degraded` transition (real, fixable in one listener).
- P3: recorder lifecycle `dir: "in"` is a diagnostic-axis mis-labelling.
- P3 watchpoint: scan's `lastCheckpoint` seeding leaves `previousCheckpoint=null`, producing cumulative manifests for catchup-and-queue-drain edge cases — defensible default, worth documenting.

No new P1 findings. The fix-pass closes the durability gaps cleanly; the remaining issues are accumulation hygiene + diagnostic precision.
