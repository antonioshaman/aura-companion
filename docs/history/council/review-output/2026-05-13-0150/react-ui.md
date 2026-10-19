# React/Web UI Regression Review — 2026-05-13-0150

Stack: React 19 + Zustand 5 + Tailwind 4. Scope: clock-tick effect in ObserverPanel, module-level announcer Map in FindingsLog, exhaustive switches in StatusPill + DowngradedChip, 300s fallback constant in observer-panel-state, zero-new-array guard in council-slice, downgrade union widening in types.ts.

Prior pass: 1 P1 + 3 P2 + 3 P3 — all addressed in fix-pass; convention floor EC-1..EC-12 / AP-1..AP-3 honoured.

---

## Verified fix landings (no re-flag)

- **#4 (EC-11 wallclock-tick subscription)**: `ObserverPanel.tsx` L249–258. `useState(0)` + 1s `setInterval` gated by `isReviewingNow`, cleanup via `clearInterval(handle)` on dep change. Effect dep `[isReviewingNow]` correct — interval is torn down the moment the group leaves the reviewing condition.
- **#5 / #19 (EC-10 exhaustive switch)**: `StatusPill` covers all 9 `ObserverPanelState` variants (`never-checkpointed-yet`, `spawning`, `reconnecting`, `sleeping`, `reviewing`, `blocker-found`, `degraded`, `reviewing-stalled`, `queued-dropped`); `downgradeReasonHuman` covers all 3 `downgradeReason` union members (`evidence_missing_on_disk`, `evidence_not_in_modified_set`, `wake_version_mismatch`). Both `default: const _exhaustive: never = state/reason` + `void _exhaustive` correctly trips TS compile-fail on future variants.
- **#10 (module-level announcer scope Map)**: `FindingsLog.tsx` L49 `ANNOUNCED_FINDING_IDS_BY_SCOPE = new Map<string, Set<string>>()`, keyed by `announcerScope` (passed through as `group.sessionGroupId` from `ObserverPanel.tsx` L345). Multiple groups isolated correctly; collapse/re-expand re-mounts the component but the Map survives so duplicate announcements are suppressed.
- **#20 (conditional announcer render)**: `FindingsLog.tsx` L267–277 — `summaryAnnouncer` is `null` until `announcement.length > 0`, eliminating the empty `role="status"` mount.
- **#24 (zero-new array guard)**: `council-slice.ts` L304 `if (newOnes.length > 0) { findings.set(...) }` skips the fresh array write when dedupe filters everything; selectors subscribed to `findings` keep referential stability across server reconnect re-emits.
- **wake-version-mismatch type widening**: `types.ts` L170 `downgradeReason: "evidence_not_in_modified_set" | "evidence_missing_on_disk" | "wake_version_mismatch"` — covers Willison #12 server-side downgrade-all path.

---

## New questions

### Q1. `setInterval` clock-tick idiomatic vs `useSyncExternalStore`

`ObserverPanel.tsx` L249–258 uses `useState(0)` + `setInterval` to force a re-render once per second while `isReviewingNow`. Idiomatic React 19? **Yes.** `useSyncExternalStore` is the right tool when there's a *shared* external clock (e.g. one global ticker many components subscribe to); for a single component's transient timer scoped to a single state variant, the `useEffect`+`setInterval`+`clearInterval` pair IS the canonical pattern.

StrictMode dev double-mount: the effect destructor (`clearInterval(handle)`) runs between the two mounts in StrictMode, so only one interval is ever live. The dev double-render reveals leaks if cleanup is missing — here cleanup is present, so the only observable effect is two `setInterval` calls happening within microseconds with the first one cleared instantly. No bug.

### Q2. `void clockTick` to suppress unused warning

Idiomatic enough. The `void` expression is a value-level no-op that flags the read to TS and any linter without disabling a rule. The alternative `// eslint-disable-next-line @typescript-eslint/no-unused-vars` is *worse* — it disables the rule globally for that line and any future addition. Keep as-is.

---

## NEW FINDINGS

### P3-A — `ANNOUNCED_FINDING_IDS_BY_SCOPE` never cleared on `removeGroup`

- **Where**: `web/src/components/council/FindingsLog.tsx` L49 (Map declaration) ↔ `web/src/store/council-slice.ts` L222–237 (`removeGroup` clears `groups` / `groupBySessionId` / `findings` / `groundingDowngrades` — but does NOT clear the announcer Map).
- **What**: The module-level `ANNOUNCED_FINDING_IDS_BY_SCOPE` Map accumulates one `Set<string>` per `sessionGroupId` (= `announcerScope`). The set holds every finding id ever announced for that group. When the user archives a group, `council-slice.removeGroup` cleans the store but leaves the announcer Map carrying the dead group's finding ids forever.
- **Cost of being wrong**: A long-running browser tab cycling through Council groups (archive old → create new → repeat) accumulates `O(groups_ever_seen × findings_per_group)` strings in this Map. Per-group worst case in practice ≈ a few hundred entries (one per finding across the session). One hundred groups ≈ low-tens-of-thousands of strings — measurable bytes but not crash-level. **Real concern is correctness-adjacent**, not memory: the FindingsLog JSDoc at L41–48 already documents this as deferred work ("future cleanup belongs in the council slice's `removeGroup` if accumulation becomes a concern"). Documented-contract canary per memory `feedback_council_documented_contract_canary` — the contract is in prose, nothing enforces it. The next refactor or someone reading just the slice file won't know to add the cleanup.
- **Why P3 not P2**: bounded by user behaviour (groups created per page lifetime), no functional impact, no rendering bug, no SR regression. Pure cleanliness — but the comment in FindingsLog already lays out the fix shape; either close the loop now or remove the prose-only contract.
- **Severity**: **P3**.

### P3-B — `wakeTimeoutMs` fallback duplication across server/client

- **Where**: `web/src/observer-panel-state.ts` L87 `const timeoutMs = typeof group.wakeTimeoutMs === "number" ? group.wakeTimeoutMs : 300_000;` vs `web/server/council-types.ts` L58 `export const OBSERVER_WAKE_TIMEOUT_MS = 300_000;`.
- **What**: Two independent literal `300_000` constants for the same semantic value. Comment at observer-panel-state.ts L83–86 says "must match `OBSERVER_WAKE_TIMEOUT_MS` on the server (council-types.ts)" — documented-contract again.
- **Cost of being wrong**: The fallback only activates when the server's `group_created` frame *doesn't* publish `wakeTimeoutMs` (pre-Task-9 server, or replay of an older buffered frame). In the happy path the server's value wins and drift is invisible. If the server bumps `OBSERVER_WAKE_TIMEOUT_MS` to (say) 600_000 in a future change and forgets the frontend constant, the *only* observable case where drift matters is the upgrade race: server publishes 600_000 → frontend reads 600_000 → fine. Cache invalidation race or an old `group_created` replay where the field is missing → frontend uses 300_000, server uses 600_000 → status pill flips to `reviewing-stalled` 5 minutes early. Detectable as user-visible "Review stalled" with no incident-marker logging.
- **Why P3 not P2**: the wire field is the actual source of truth; the fallback is a soft floor for compatibility. The race window is narrow (a single frame). Sibling of memory `feedback_validator_per_semantic_category` — same value expressed twice across a process boundary will eventually drift; the doc-only comment is a prose canary. Cheap fix: export the literal from a single TS module that both sides can import OR (since they can't share modules across the bridge) add a runtime warning when the frontend's fallback is consulted (`console.warn("server did not publish wakeTimeoutMs — using frontend fallback ${X}ms; verify server version")`).
- **Severity**: **P3**.

---

## Out-of-scope observations (not findings, just notes)

- ObserverPanel's `nowMs` prop pass-through to both `deriveObserverPanelState` AND `formatRelativeTime` (L308–311) is correct — both sites consume the same wallclock reference so deterministic-replay tests stay deterministic. The "Date.now() in render" antipattern doesn't apply when the value is consumed both by a pure deriver and by `formatRelativeTime` on the same render.
- `appendObserverReview`'s `recentlySupersededCheckpointIds` write at council-slice.ts L284–287 always writes a fresh `GroupRecord` object even when the field is unchanged, which forces a render of every selector subscribed to `groups`. Not a regression — the prior fix at #24 only guarded `findings`. Watchpoint only.
- `groundingDowngrades` selector path at council-slice.ts L307–311 still writes a fresh array reference on every review (no zero-new guard like #24 added for `findings`). Currently no rendered consumer reads `groundingDowngrades` (per `grep`) so no re-render cost; if a future component subscribes, it'll re-render on every review even when downgrades didn't change. Watchpoint only — symmetric with #24 but not load-bearing yet.

---

**Summary**: 2 new P3 findings (both prose-only contracts that should be enforced or removed). All fix-pass additions follow React 19 / Zustand 5 conventions correctly. EC-10 / EC-11 exhaustiveness + clock-tick subscription land cleanly. The clock-tick `setInterval` + `void clockTick` is idiomatic — no cleaner alternative without invented abstraction.
