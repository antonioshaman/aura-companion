# TASK: UI/UX bugs — "Observer offline" + stale PR Context panel

Discovered 2026-05-14 during PR 2c session (auto-proceed boundary + send pipeline).
User flagged both from a live screenshot of the Aura Companion UI.

## Bug 1 — "Observer offline" shown for a live observer

**Symptom:** Right-panel ObserverPanel header shows `● Observer offline` for the
om_event_bot Council pair (`grp_4469a4c25778ce50ae3e5eb6a01f8356`). At the
same moment `/api/sessions` reports:
- orchestrator PID 1300110, `state: connected`, `archived: false`
- observer PID 1300088, `state: connected`, `archived: false`

So the observer half is structurally alive. UI says otherwise.

**Suspect surfaces (priority order):**
1. **`web/src/observer-panel-state.ts`** — `deriveObserverPanelState({group, findings, dismissedStopIds, nowMs})` priority ladder. Verify what produces the `"offline"` string and which `group.status` triggers it.
2. **`web/src/store/council-slice.ts`** — `upsertGroup` may not re-hydrate on a `group_created` replay; the slice state could be stale relative to `/api/sessions`. Pair with `feedback_create_event_broadcast_races_client_connect` — create-time pub/sub races client connect.
3. **`web/server/ws-bridge.ts`** — does `broadcastToGroup` actually reach the orchestrator's browser when the pair's observer transitions `reconnecting → active`? Verify with wire recording (`feedback_wire_recording_canonical_for_flow`).
4. **`web/server/session-orchestrator.ts`** — `group:reconnecting` / `group:created` re-fire on observer respawn. Per `feedback_in_memory_derived_state_reconcile_on_restart`, the in-memory derived state may not reconcile.

**Verification path:**
- `agent-browser` to the UI session, open Devtools Console.
- Inspect the Zustand store: `useStore.getState().council.groups['grp_44...']`.
- Compare `group.status` to backend `/api/sessions`.
- Look for missed `group_created` ws frames in the wire recording at `~/.companion/recordings/`.

**Definition of done:**
- When observer half is `state=connected` and the group's `applyEvent` last delivered an `active` status, the UI panel MUST show `● Observer idle/ready`, not `offline`.
- Add a wire-recording-based replay test that asserts the deriver returns the right state for a live-observer / dead-observer transition.

## Bug 2 — Stale / placeholder GITHUB PR panel

**Symptom:** Right-panel Context section shows:
```
GITHUB PR
PR #82 (Merged)
test merge
+0 -0 · 0 files
```

This is a merged PR with placeholder stats ("test merge" title, zero
diff). The current session is `Verdant Delta /root/om_event_bot` —
unlikely to be genuinely associated with PR #82 of some unrelated repo.

**Suspect surfaces:**
1. **`web/server/pr-poller.ts`** — does it purge the per-session PR record
   when the PR is merged/closed? `feedback_outbox_close_all_paths`
   suggests close-on-every-exit-path is often missed.
2. **`web/server/session-store.ts`** — the persistent association
   between sessionId and `prInfo` may survive PR merge.
3. **`web/src/components/ContextPanel.tsx`** (or wherever the panel
   renders) — does the deriver hide the PR block when the PR is `closed`
   AND last poll was > 24h ago? Or always render whatever's in state?
4. The `+0 -0 · 0 files` and `test merge` title look like a synthetic
   default — maybe a dev/test fixture leaked into prod state through the
   `migrateLegacyTmpdirSessions` path.

**Verification path:**
- Inspect `~/.companion/sessions/<sessionId>.json` for the `prInfo`
  field on Verdant Delta's session record.
- Grep `pr-poller.ts` for the cleanup branch on `pr.state === "closed"`.
- Check if the PR record was ever cleared after merge.

**Definition of done:**
- Merged/closed PRs older than 7 days are hidden from the Context panel
  (the user no longer cares).
- The "test merge / +0 -0 / 0 files" placeholder must NEVER ship — either
  fix the upstream call so real stats land, or fail-closed (hide the
  block) until the API returns valid stats.

## Owner

Open for assignment. Both are UI/UX visible defects, not in scope for
PR 2c (server-side auto-proceed). Recommended to bundle as one
"Council UI panel state hygiene" PR with replay-based regression tests
for the deriver.
