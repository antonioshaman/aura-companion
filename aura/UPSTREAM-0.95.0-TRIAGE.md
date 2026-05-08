# Upstream 0.90.0 → 0.95.0 — Per-Commit Triage

**Range:** `the-companion-v0.90.0..the-companion-v0.95.0` (37 non-merge commits)
**Sync branch:** `sync/upstream-0.95.0` (created off `main`)
**Triage date:** 2026-05-08
**Triage author:** Carmack-style upfront skim (per PLAN-upstream-sync.md Task 5)

## Tag legend

- 🟢 **clean** — pure addition or isolated bug-fix; expected to merge with no conflict
- 🟡 **overlap** — touches a file Aura also modified; needs hand-merge per `aura/CONFLICT_WATCHLIST.md`
- 🔴 **risky** — touches load-bearing surface (state machine, protocol, ws-bridge core); read both diffs end-to-end before resolving
- ⚪ **skip** — does not apply to Aura's deploy reality (Railway, Postgres, Docker-in-Docker, etc.); merge but inert OR omit with rationale

## Per-commit table

> Order is **upstream chronological** (oldest first). The merge sequence per Carmack C3 is **blast-radius first**: land 🟢 batch first, then 🟡, then 🔴, with ⚪ done in their own quarantine commit. The "Land in" column groups commits into the merge batches from PLAN tasks 6, 7, 8, 9.

| # | SHA | Tag | Subject | Land in | Notes |
|---|---|-----|---------|---------|-------|
| 1 | `bc72ff1` | 🟡 | fix(ws-bridge): prevent CLI session_id from overwriting Companion ID (#580) | Task 7 | Touches `ws-bridge.ts` — read against today's heartbeat block. Likely composes cleanly. |
| 2 | `ee231c5` | 🟢 | fix(topbar): prevent Session tab from being clipped on Android (#581) | Task 6 | Mobile-only UI fix — Aura's mobile users benefit directly. |
| 3 | `3c3bb2e` | 🟢 | chore: release 0.90.1 | (skip) | Release-please commit; we ignore version bumps and use our own. |
| 4 | `273f86d` | 🟡 | fix(codex): improve reconnection reliability and prevent message loss (#584) | Task 7 | Codex reconnection — overlaps with our heartbeat philosophy but for codex transport. |
| 5 | `bb00c50` | 🟢 | chore: release 0.90.2 | (skip) | Release-please. |
| 6 | `245a29b` | 🔴 | **fix(ws-bridge): repair state machine transitions and prevent memory leaks (#590)** | Task 8 | **CRITICAL.** Upstream also fixed state-machine transitions. Our `AURA_EXTRA_READY_TRANSITIONS` may overlap or be subsumed. Read upstream diff in full; if upstream's fix covers `ready → awaiting_permission` natively, drop our spread. |
| 7 | `3368136` | 🟡 | fix(claude-adapter): drop CLI user echo messages to prevent raw JSON in chat UI (#592) | Task 6 | Direct application; verify no Aura tweaks to `claude-adapter.ts` were lost. |
| 8 | `cbaba1d` | 🟡 | feat(ui): add reconnection indicator for CLI sessions (#593) | Task 11 | UI status — slot into our consolidated status region (Task 11 from PLAN). Don't add as a fifth peer indicator. |
| 9 | `0b2d38a` | 🟢 | feat(linear): support multi-agent OAuth with per-wizard staging slots and UI redesign (#586) | Task 12 | Linear OAuth + UI; touches settings + new wizard. Hunt H3: token storage path. |
| 10 | `eb64cb0` | ⚪ | feat(platform): Railway deploy config, Resend emails, postgres.js driver (#594) | Task 9 | **Inert in Aura** — gate behind `AURA_FEATURES_*=1` env flags defaulting OFF; remove `railway.toml`-equivalents; move `postgres` to `optionalDependencies`. |
| 11 | `dd79e21` | 🟢 | fix(codex): resolve transport disconnect race causing stuck sessions on page refresh (#595) | Task 6 | Race fix — apply directly. |
| 12 | `1bbfda0` | ⚪ | feat(docker): add Docker-in-Docker and PostgreSQL to default image (#596) | Task 9 | Aura runs `nohup bun`, not Docker. Skip these Dockerfile changes OR delete `Dockerfile`/`docker-compose.yml` post-merge if not consumed by `container-manager.ts`. |
| 13 | `8148ef5` | 🟢 | chore: release 0.91.0 | (skip) | Release-please. |
| 14 | `d9611da` | ⚪ | feat(docker): add standalone docker-compose CLI to default image (#598) | Task 9 | Same as #596 — Docker-image-only change, inert in Aura prod. |
| 15 | `8a857d0` | 🟢 | chore: release 0.92.0 | (skip) | Release-please. |
| 16 | `6735a9a` | 🔴 | **fix(ui): redesign chat blocks inline and fix streaming message duplication (#597)** | Task 6 | **THE headline fix.** Aura saw "Phase 4 — Read all 9 outputs" ×5 in production. TS expert T3: verify fix is server-side (Aura's client `upsertAssistantMessage`/`mergeAssistantMessage` stays) vs client-side dedupe replacement (need to merge carefully into our merge logic). Must also add Beck B1 replay fixture before landing. |
| 17 | `f5f0a92` | 🟢 | chore: release 0.92.1 | (skip) | Release-please. |
| 18 | `5e76c50` | 🔴 | fix(orchestrator): prevent PID recycling from blocking Docker session relaunch (#589) | Task 7 | TS expert T7: re-validate `--resume` race window. Read against `cli-launcher.ts`. |
| 19 | `24ef8ac` | 🟢 | chore: release 0.92.2 | (skip) | Release-please. |
| 20 | `7f5eab2` | 🟡 | fix(docker): preserve containers on idle-kill and increase default timeout to 24h (#602) | Task 9 | Sandbox-container lifecycle. Deploy D3: confirm `container-manager.ts` honors the 24h policy. Make timeout configurable via `COMPANION_CONTAINER_IDLE_TIMEOUT`. |
| 21 | `0c2335e` | 🟢 | chore: release 0.92.3 | (skip) | Release-please. |
| 22 | `ee65392` | 🟡 | fix(claude-adapter): re-apply user echo drop fix reverted by #589 (#605) | Task 6 | Companion to #592 — review combined effect. |
| 23 | `b574883` | 🟢 | chore: release 0.92.4 | (skip) | Release-please. |
| 24 | `6710519` | 🟢 | refactor(linear): separate OAuth Apps from Tickets integration (#607) | Task 12 | Linear UI refactor; pairs with #586. |
| 25 | `b67650f` | 🟢 | chore: release 0.92.5 | (skip) | Release-please. |
| 26 | `c256360` | 🟢 | refactor: Code redundancy reduction (#610) | Task 6 | Pure refactor; expect mechanical conflicts only. |
| 27 | `08e495b` | 🟢 | fix(linear): log webhook acceptance and rejection (#612) | Task 12 | Logging-only. |
| 28 | `5baccb1` | 🔴 | **feat(claude): support channels protocol updates (#613)** | Task 8 | **HIGHEST RISK.** May introduce new Claude Code message kinds. TS expert T1: audit `VALID_TRANSITIONS` and add edges as needed. Willison W2: keep `default: reportProtocolDrift` and the "forward unknown anyway" path. |
| 29 | `c2f2b55` | 🟡 | feat(onboarding): add provider setup wizard for Claude Code and Codex (#615) | Task 12 | Friedman U4 + Saarinen S4 + Willison W4: detect Aura's pre-existing `.agents/`/CLAUDE.md state, restyle to Aura tokens, do NOT replace `/prime`. |
| 30 | `6f6d411` | 🟡 | feat(recording-hub): add hidden recording hub for replay, compat testing, and diagnostics (#617) | Task 13 | Saarinen S6 + Willison W5: keyboard-discoverable only, reads from existing `~/.companion/recordings/`, redaction layer required (Hunt H7). |
| 31 | `177af4b` | 🟡 | **fix(sidebar): reconcile client sessions with server on poll (#621)** | Task 7 | **OVERLAP** with our `93a205c` and `auraIsActiveSession`. Read both end-to-end. If upstream is server-driven authoritative rebuild, drop ours. If delta-based, keep ours. Symptom test in `Sidebar.test.tsx` is the gate. |
| 32 | `75a6cc9` | 🟢 | chore: release 0.93.0 | (skip) | Release-please. |
| 33 | `a555985` | 🟡 | feat(settings): add provider token configuration for Claude Code and Codex (#623) | Task 12 | Friedman U5 + Saarinen S5 + Hunt H3: 5-state token UX, masked-input primitive, file mode 0600, redaction denylist. |
| 34 | `b176624` | 🟢 | chore: release 0.94.0 | (skip) | Release-please. |
| 35 | `9b5e675` | 🟡 | fix(workbench): remove terminal and session extras (#632) | Task 11 / 14 | Friedman U7: in-app one-time toast for users with workbench muscle memory. Update Sidebar's NAV_SECTIONS. |
| 36 | `6a0e7c5` | 🔴 | **feat(keepalive): proactive CLI relaunch when frontend is disconnected (#634)** | Task 7 | TS expert T2 + H6: compose with our heartbeat — slot into `handleBrowserClose → idle kill watchdog` flow, not a parallel timer. Re-authenticate on reconnect (127.0.0.1 bind, per-session nonce). |
| 37 | `a2341a0` | 🟢 | chore: release 0.95.0 | (skip) | Release-please. |

## Summary by tag

| Tag | Count | Land batch |
|-----|-------|-----------|
| 🟢 clean / chore | 18 (incl. 9 release-please skips) | Task 6 |
| 🟡 overlap | 11 | Tasks 7, 11, 12 |
| 🔴 risky | 4 | Tasks 7 (×1), 8 (×2), 6 (×1) |
| ⚪ inert in Aura | 4 | Task 9 |

## Per-batch landing order (Carmack C3 — blast-radius first)

### Batch A (Task 6 — low blast radius, land first)

`ee231c5`, `3368136`, `dd79e21`, `c256360`, `6735a9a` (with Beck B1 replay fixture as gate), `ee65392`. The two 🔴 here (#590 state-machine, #597 chat block) — see below; #597 lands here, #590 lands in Batch C.

### Batch B (Task 7 — overlap with Aura)

`bc72ff1`, `273f86d`, `5e76c50`, `7f5eab2`, `177af4b` (sidebar — symptom test must stay green), `6a0e7c5` (heartbeat composition — most important).

### Batch C (Task 8 — protocol & state-machine, highest risk)

`245a29b` (state-machine repair — read first; may subsume our `AURA_EXTRA_READY_TRANSITIONS`), `5baccb1` (channels protocol — extend `VALID_TRANSITIONS` + preserve drift logging).

### Batch D (Task 9 — quarantine inert)

`eb64cb0`, `1bbfda0`, `d9611da` (treat as one quarantine commit with rationale in body).

### Batch E (Task 11 — UI status consolidation, post-merge)

`cbaba1d` (reconnection indicator — slot into status region).

### Batch F (Task 12 — onboarding/Linear/settings, post-merge)

`0b2d38a`, `6710519`, `08e495b`, `c2f2b55`, `a555985`. Aura tone + branding pass + token UX.

### Batch G (Task 13 — recording hub, post-merge)

`6f6d411`. Hidden by design + redaction layer.

### Batch H (Task 14 / 11 — workbench cleanup)

`9b5e675`. In-app toast for removed surfaces.

## Per-chunk landing protocol

For each commit landing in a batch:

1. `git cherry-pick <sha>` (or `git merge --no-ff <sha>` for batch merges — implementer's choice; cherry-pick keeps history flat per Carmack C2).
2. If conflicts: open `aura/CONFLICT_WATCHLIST.md`, find matching entry, apply resolution rule.
3. Run `bun run branding` (re-applies branding script idempotently — config from `branding.config.json`).
4. Run `bun run typecheck && bun run test`. **All sentinel/symptom/guard tests must pass.**
5. Commit with message format:
   ```
   sync: <upstream-sha> — <subject>

   [fit: clean | adapted | skipped+reason]

   <one-line rationale if non-mechanical decision>
   ```
6. If anything goes sideways past Batch C: `git checkout main && git branch -D sync/upstream-0.95.0` and start over (Carmack C1 — branch is the unit of abort).

## Conflict rule of thumb (Carmack C8)

Apply per-conflict in <1 minute:

- **(a)** Conflict in Aura-only territory (branding strings, `.agents/`, knowledge skills, self-learning code): **keep ours**, period.
- **(b)** Conflict in shared infra + upstream is fixing a bug we also have: **take theirs**, then re-apply our local fix on top if still needed.
- **(c)** Conflict in shared infra + both sides changed behavior intentionally (#590 state-machine, #621 sidebar, #634 heartbeat composition): **stop**, read both diffs end-to-end, write 2-line note in commit message explaining the choice.

## After all batches land

1. Bump `web/package.json` to `1.1.0` (Carmack version-policy verdict accepted).
2. Run full branding pass: `bun run branding`.
3. Run full test suite: `bun run typecheck && bun run test`.
4. Walk visual-asset checklist printed by branding script.
5. Land the PR to `main` as ONE PR (Carmack C2 — chunked commits inside the PR, single PR review).
