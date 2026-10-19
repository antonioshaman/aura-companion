# Learnings

## [LRN-20260605-001] best_practice

**Logged**: 2026-06-05T01:18:00Z
**Priority**: medium
**Status**: pending
**Area**: backend

### Summary
When replacing a legacy probe with a stronger N-factor verifier and only PARTIAL stronger-data is available at the call site, widen the helper signature to accept `null` for the missing factor and document the degraded mode — ship the strictly-stronger subset now, don't block on the full anchor.

### Details
PLAN T3 introduced `verifyProcessIdentity(pid, sessionId, expectedStartMs)` as a three-factor (liveness + argv + starttime) replacement for the bare `process.kill(pid, 0)` boot probe. The spawn-time anchor (`expectedStartMs`) only becomes available in Phase D when the sidecar file lands; Phase A's boot probe has nothing to pass. Two failure modes if not handled: (a) defer the wire-up to Phase D (loses argv-token defence for weeks of pipeline time) or (b) pass sentinel `0` (every alive process mismatches on starttime → triggers the relaunch storm we're fixing). Resolution: widen `expectedStartMs: number | null` — when `null`, skip the starttime factor, verdict reduces to liveness + argv. Strictly stronger than `kill -0` alone. Phase D upgrades callers to pass the real anchor.

### Suggested Action
When designing an N-factor verifier as a defensive upgrade, ask up front: "are all N factors available at the FIRST call site, or only at the eventual one?" If asymmetric, the signature should admit it via `T | null` per factor with a documented degraded-mode contract. Don't force the early site to wait for late data, and don't lie to it with sentinels.

### Metadata
- Source: conversation
- Related Files: web/server/process-identity.ts, web/server/cli-launcher.ts (boot probe)
- Tags: degraded-mode, defensive-upgrade, n-factor, ship-partial
- See Also: feedback_protocol_handshake_vs_transport_state (memory — sibling pattern: `state=connected` ≠ protocol-ready; both distinguish "verifiable now" vs "verifiable eventually")
- Pattern-Key: defensive_upgrade.partial_anchor_degraded_mode
- Recurrence-Count: 1
- First-Seen: 2026-06-05
- Last-Seen: 2026-06-05
