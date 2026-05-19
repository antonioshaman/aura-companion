# Overnight Handoff — `aura-companion` Council Pair (next session)

## Context recap

You are picking up an autonomous council session (orchestrator + observer pair) that completed 5 of 16 tasks from `PLAN-aura-consolidated-refactor.md`. The current main is healthy, npm is at `aura-companion@1.3.2`, and 11 tasks remain — most are independently unblocked. Your job overnight is to ship as many of the remaining tasks as the objective gates (typecheck + tests + observer review) allow.

**Stack:** Bun + Hono + TypeScript / React 19 + Zustand + Tailwind / WebSocket NDJSON + JSON-RPC / FS-JSON persistence / Vitest + vitest-axe.

**Conventions floor:** `conventions.md` — 3 AP + 9 EC. Do not re-flag. Spec lives at `PLAN-aura-consolidated-refactor.md`; review history at `.council/reviews/PLAN-aura-consolidated-refactor.review-log.md`.

## State at handoff

| Surface | State |
|---|---|
| Main branch | `c85c26e` (post-1.3.2 release) |
| npm | `aura-companion@1.3.2` |
| Open PRs | 0 |
| CI | All green |
| Open backlog items | 5 (see below) |
| Tasks done | 1, 2, 3, 4, 5 |
| Tasks remaining | 6, 7, 8, 9, 10, 11, 12, 13, 14, 15a, 15b |

## Pending user verification

**Task 5 runtime check.** PR #23 (`c85c26e`, shipped as 1.3.2) replaced the masked-value pattern on Claude Code OAuth Token + OpenAI API Key inputs with placeholder hints. User has not yet executed the 5-step browser/DevTools runtime check to confirm the bug is closed. If at session start you can see the result of that runtime check, act on it. If not, treat hypothesis (e) as **provisionally closed** and proceed with remaining tasks; user can fall back to drafts (a)/(b)/(c) at `/tmp/task5-drafts.md` if needed.

## Recommended starting order

Tasks ordered by **(a) dependency unblocked-ness**, **(b) blast radius low → high**, **(c) cost/leverage**:

### Phase A — fully independent, low risk (start here)

1. **Task 11** — Recordings redaction policy (Hunt × Persistence × Subprocess). Standalone surface: `recorder.ts` write-time format-aware redaction + `0600` file mode + auth-probe spawn exclusion. Backlog #6 (`preflight-probe.ts` dead-code audit) could be folded in if found during reading.
2. **Task 13** — Protocol parser replay corpus + drop telemetry (Realtime × Willison × Subprocess). Capture recording fixtures BEFORE Task 14's upstream sync; standalone test infrastructure.
3. **Task 15a** — Security baseline (Hunt × Backend). WS upgrade bearer-token check + Origin allowlist + IDOR middleware + CSP headers + Zod validation + `respondError` helper.
4. **Task 15b** — CI/Deploy hygiene (Deploy × Backend). `/healthz` endpoint + Dockerfile HEALTHCHECK + `--frozen-lockfile` everywhere + husky verification CI step + pin dev tools exact + Dockerfile rename + SIGTERM teardown + Docker-publish posture decision.

### Phase B — depend on completed tasks (1-4 ✅, 5 ✅)

5. **Task 6** — `SettingsPage` targeted split + `settings-slice` (React × Fowler). Settings-slice for server-authoritative facts; extract ONLY the Providers section + sections Task 7 will touch into `components/settings/`. Other sections stay inline.
6. **Task 12** — Schema versioning + durable storage migration (Persistence × Backend). Adds `schemaVersion: N` to every persisted JSON family; adds `streamStatus` field to assistant messages; migrates `$TMPDIR/vibe-sessions/` → `~/.companion/sessions/`.

### Phase C — depend on Phase B

7. **Task 7** — Claude MAX 20x auth tier verification REST + UI (Subprocess × Backend × Realtime × Willison × Friedman × Hunt). Server probe + cached result + `POST /api/auth/verify-claude-tier`. Depends on Task 6 settings-slice.
8. **Task 8** — UX systemic — Settings IA + ObserverPanel 3-tier + degraded recoverability (Friedman × Saarinen). Depends on Tasks 6, 7.

### Phase D — depend on Phase C

9. **Task 9** — Visual UI tokens consolidation + elevation ladder + Playground mirror (Saarinen). Depends on Task 8.
10. **Task 10** — a11y systemic floor (a11y Auditor). Depends on Tasks 5 ✅, 8, 9.
11. **Task 14** — Upstream sync 0.95.0 (Backend × Subprocess × Deploy × Realtime × Friedman). Depends on Tasks 13, 4 ✅.

## Hard caps & stop rules

- **Max tasks per night: 6.** After 6 atomic PRs land (auto-merge-when-green), stop and report. Don't pile up squash commits on main without breathing room for human review.
- **Hard stop on any STOP-severity observer finding.** Per stop rule in review-log.md, NOTE/INFO findings → known follow-ups, ship. WARN → fix once, re-check. STOP → stop the loop, surface to user, await direction.
- **Hard stop on typecheck/test failure not fixed within 2 iterations.** Stop is healthier than thrash. Per `feedback_agent_self_review_loop_gates`.
- **Hard stop if observer wake-dispatcher fails after server restart.** Per `feedback_in_memory_derived_state_reconcile_on_restart`: Task 4's reconcile work self-heals wake state on restart. If a clean server restart doesn't restore observer responsiveness, that's a regression worth pausing for. Fall back to user-relay if needed but report it.

## Operational notes

- **Auto-merge mode:** user authorized "auto-merge when green" — squash-merge every PR as soon as all 7 CI checks pass. No per-PR confirmation. Use `gh pr merge N --repo antonioshaman/aura-companion --squash --subject "..." --body-file ... --delete-branch`.
- **Repo merge policy:** rebase + merge-commit disabled. **Squash only**. Use explicit `--subject` to lock title and `--body-file` to carry SHA-map / iteration trail.
- **Per `feedback_branch_from_main_not_sibling`:** before each new PR, `git checkout main && git reset --hard origin/main && git checkout -b new-name`. Sibling branching causes squash-absorption ghost-PR bug (happened to PR #19 absorbed by PR #20 this session).
- **Per `feedback_fs_watch_macos_dirname_quirk`:** any new `fs.watch`-based watcher needs `endsWith(.md)` style pre-filter before strict pattern check. macOS fires parent-dir-name events that fail strict patterns.
- **Per `feedback_test_env_pollution_explicit_unset`:** any test asserting "fall back when X unset" must `delete process.env.X` in setup. Dev machines export vars that CI runners don't.
- **NPM publishing:** `NPM_PUBLISH_TOKEN` secret is valid + has bypass-2FA. release-please auto-opens release PRs on conventional-commit pushes. Auto-merge them as part of the loop after verifying changelog body doesn't overpromise (e.g., advertise features that didn't ship).
- **Council mode + observer:** observer relays its review via user (wake-dispatcher state lost across `.council/state/` reconstruction this session — should self-heal on next clean server restart per Task 4). If wake doesn't fire after restart, fall back to user-relay path.

## Outstanding backlog (record but don't block on)

| # | Title | Surface |
|---|---|---|
| 6 | `preflight-probe.ts` dead-code audit | server — wire or delete |
| 7 | fs-routes startup INFO log (cosmetic) | server — skip per Carmack |
| 10 | Anthropic API Key symmetric masked-value cleanup | `SettingsPage.tsx:~703` |
| 11 | `fs-routes.test.ts` env-pollution defensive unset | test fragility |
| — | Persistence-half byte-identical idempotency assertion (Task 4 v2 NOTE) | rolls into Task 12 |
| — | `scanForMissedObserverReviews` symmetric to checkpoints (Task 4 v1 NOTE) | rolls into Task 12 or Task 4 follow-up |
| — | Orchestrator-level concurrent `createCouncilGroup` test (Task 2 v1 NOTE) | future test-architecture |
| — | `GroupMember.sessionId: string | null` widening | structural fix for placeholder leak, big scope |
| — | `coord.findBySessionId` runtime guard or private-to-coordinator | converts doc → enforcement |

## First action of new session

1. Read `PLAN-aura-consolidated-refactor.md` (Tasks 6-15) and `.council/reviews/PLAN-aura-consolidated-refactor.review-log.md` (v1/v2/v3 review history + post-ship plan mutations).
2. Read `CLAUDE.md` (project conventions + test/CI/Playground rules) and `conventions.md` (AP/EC floor).
3. Read this handoff file.
4. Check `git log origin/main --oneline -5` to confirm baseline matches what this file claims (`c85c26e`).
5. Pick **Task 11** as first target (most independent, lowest blast radius). Follow `/council-implement-aura` per-task discipline: load expert reference, plan, implement, verify typecheck + tests, emit council-implement checkpoint, await observer review, fix or proceed.

## Memory entries deposited this session (for cross-session continuity)

- `feedback_fs_watch_macos_dirname_quirk` — macOS `fs.watch` parent-dir-name event quirk (propagated to 10 projects)
- `feedback_test_env_pollution_explicit_unset` — explicit `delete process.env.X` in test setup (propagated)
- `feedback_branch_from_main_not_sibling` — orthogonal PR base discipline (propagated)

Read these via `~/.claude/projects/-root-aura-companion/memory/MEMORY.md` index at session start.

---

**Status: ready for handoff.** Wake the new session with this file as the first context input.
