# Aura Conflict Watchlist

Files where Aura logic is interleaved with upstream Vibe-Companion code. When merging upstream, these files **must** be hand-merged — never auto-resolved.

For each entry:
- **What Aura added** — what behaviour we layered on top
- **What upstream tends to change** — patterns of conflict to expect
- **Resolution rule** — preferred merge strategy for typical conflicts

When in doubt: keep ours (Aura) for entries marked **AURA-LOCAL**, take theirs (upstream) when upstream is fixing the same bug we patched and their fix is stricter.

## Files

### `web/server/update-checker.ts`

- **Aura added:** the version-stopper comment block at top of file; `// aura-keep-upstream-name` marker on the `NPM_REGISTRY_BASE` constant; the deliberate 1.x version in `web/package.json` that suppresses the update banner.
- **Upstream tends to:** bump the npm package version on every release (touches `package.json`); occasionally refactor `checkForUpdate` / `getRegistryUrl` (PR #594 added Railway/Resend code paths that wrap the checker).
- **Resolution rule:** keep our top-of-file note and the `aura-keep-upstream-name` marker. Take upstream's logic changes BUT confirm the npm package name in `NPM_REGISTRY_BASE` stays `the-companion` (not rebranded by the script — guarded by the marker). Never let `web/package.json` `name` change from `aura-companion`. Never let `web/package.json` `version` go below or equal to upstream's latest npm release.

### `web/server/ws-bridge.ts`

- **Aura added:** the "Browser heartbeat" block (`startBrowserHeartbeat`, `stopBrowserHeartbeat`, `broadcastBrowserHeartbeat`, `BROWSER_HEARTBEAT_INTERVAL_MS`, `browserHeartbeatTimer` field). Direct `ws.send` for keep_alive frames intentionally bypasses `sequenceEvent` / `eventBuffer` / `messageHistory`.
- **Upstream tends to:** refactor message routing; introduce new browser-bound message types; PR #634 (proactive CLI relaunch on disconnect) overlaps thematically and lands recovery logic into the same file.
- **Resolution rule:** keep our heartbeat block intact. When PR #634 lands, place its relaunch-decision logic inside the existing `handleBrowserClose → idle kill watchdog` flow (not as a parallel timer). NEVER let an upstream refactor route `keep_alive` frames through `broadcastToBrowsersFn` / `sequenceEvent` — that would consume `nextEventSeq` and corrupt the replay invariant. If you see a PR unifying all outgoing-to-browser calls, audit the heartbeat path first.

### `web/server/session-state-machine.ts`

- **Aura added:** `AURA_EXTRA_READY_TRANSITIONS = ["awaiting_permission"]` constant, spread into the `ready` row of `VALID_TRANSITIONS`. Without this, `permission_request` arriving after `result` (the `ready` phase) is silently blocked.
- **Upstream tends to:** add new phases (compacting, channels-related, etc.); rewrite the transition table when protocol expands; PR #613 (Claude channels protocol) likely introduces new edges.
- **Resolution rule:** keep `AURA_EXTRA_READY_TRANSITIONS` and the spread. If upstream rewrites the table from scratch, re-apply the spread into the new `ready` set. Audit any new message kinds introduced by upstream to see whether they imply additional `ready → X` transitions Aura should add to `AURA_EXTRA_READY_TRANSITIONS`.

### `web/src/components/Sidebar.tsx`

- **Aura added:** `auraIsActiveSession(s, sdkSessionIds)` helper that hides archived, cron-spawned, agent-spawned, and orphaned bridge-only sessions from the active list. `removeBridgeSession(sessionId)` call after archiving. See commit `93a205c`.
- **Upstream tends to:** rewrite session-list reconciliation from scratch (PR #621 already does this server-driven). The sidebar is high-traffic for upstream UI work.
- **Resolution rule:** if PR #621 (or successor) lands a server-driven reconcile that authoritatively rebuilds `sdkSessions` from server polls, our orphan filter may be unnecessary — but verify behaviour with the `Sidebar.test.tsx` symptom test before dropping. If upstream's reconcile is delta-based (patches), keep our filter. Never delete `auraIsActiveSession` without the symptom test passing post-removal.

### `web/package.json`

- **Aura added:** `name: "aura-companion"`, `version: "1.0.x"` (deliberately ahead of upstream so the version stopper works), Aura-specific `bin` map, `keywords`, `author`, `description`. New `branding` and `branding:dry` scripts.
- **Upstream tends to:** bump version on every release (managed by release-please bot); add new dependencies; rename scripts.
- **Resolution rule:** **keep ours** for `name`, `version`, `bin`, `keywords`, `author`, `description`. **Take theirs** for `dependencies` / `devDependencies` (new transitive deps from upstream — review per Hunt H1 lockfile bar). **Merge** the `scripts` block carefully: keep Aura's added scripts (`branding`, etc.); take upstream's new scripts; resolve any name collisions in favour of Aura.

### `CLAUDE.md`

- **Aura added:** the entire "Self-Learning System" section, the `.agents/knowledge/*.jsonl` documentation, the `/prime` `/learn` `/self-reflect` skill protocol, the Cursor Cloud caveats. The "What This Is" section's mention of Vibe-Companion is intentional fork attribution.
- **Upstream tends to:** rewrite top sections (commands, architecture); add new sections.
- **Resolution rule:** **always keep** the Self-Learning System section and Cursor Cloud caveats. **Always keep** the fork-attribution sentence. Take upstream's command/architecture updates as long as they don't conflict with Aura's branded names. NEVER let an upstream merge replace `aura-companion` references in this file with `the-companion`.

### `web/server/protocol/`

- **Aura added:** nothing. This is **vendored** upstream protocol contract (Claude Code SDK types).
- **Upstream tends to:** sync this directory verbatim from Claude Code SDK on every release.
- **Resolution rule:** **strictly read-only from Aura's side.** Take upstream's version verbatim, every time. If Aura needs to extend the protocol, do it in a sibling file (e.g. `web/server/protocol-aura/`) that imports from `protocol/`. CI grep should flag any Aura-authored commit that touches `web/server/protocol/` without the `protocol-override` label.

### `.agents/knowledge/*.jsonl`

- **Aura added:** the entire directory. Append-only knowledge stores written by the self-learning skills. Six files: `patterns.jsonl`, `gotchas.jsonl`, `decisions.jsonl`, `anti-patterns.jsonl`, `codebase-facts.jsonl`, `api-behaviors.jsonl`.
- **Upstream tends to:** never touch this directory (it doesn't exist upstream).
- **Resolution rule:** **never modify, ever, in any merge.** The branding script's `protectedPaths` list excludes `.agents/knowledge/**` and `**/*.jsonl`. A pre-merge byte-equality test (Task 3) asserts these files are unchanged across the merge. If they ever differ, the merge is corrupt — abort and start over.

## CI guardrails referenced

- `web/scripts/apply-aura-branding.test.ts` — verifies idempotence and protected-paths behaviour.
- `web/server/__overrides__/*.approved` (Task 3) — guard tests that fail when watchlisted files change without acknowledgement.
- (Future) CI grep blocking `web/server/protocol/` modifications without `protocol-override` label.

## When upstream merges land

1. Open `aura/CONFLICT_WATCHLIST.md` in one tab.
2. For each conflict, identify which entry above applies.
3. Apply the entry's resolution rule.
4. Re-run the branding script (`bun run branding` from `web/`).
5. Re-run guard + symptom tests (`bun run test`).
6. Document any non-obvious decision in the merge commit body (Carmack C8).
