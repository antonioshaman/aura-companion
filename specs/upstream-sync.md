# Spec: Upstream Sync — Vibe-Companion 0.90 → 0.95, with repeatable future-sync workflow

**Date:** 2026-05-08
**Status:** Draft

## Vision

Aura Companion forked from upstream Vibe-Companion (`the-companion`) at v0.90.0. Five upstream releases later we're missing fixes that directly hurt our users — most visibly the streaming-message duplication fix (0.92.1) that matches the "Phase 4 — Read all 9 outputs ×5" repetition seen in production, plus the proactive CLI relaunch on disconnect (0.95.0) and Claude Code channels protocol updates (0.93.0). The bet: catch up to 0.95.0 *and* invest one-time in tooling so the next sync (0.95 → 0.96, 0.96 → 0.97…) takes a few hours instead of becoming an archaeology project. Why now: upstream is shipping ~1 minor release/week; every week we wait, the merge cost grows.

## Problem Statement

Today an upstream sync requires manually walking ~30 commits, identifying which files conflict with Aura branding (UI strings, package name, manifest, logos), re-applying our local fixes by hand (sidebar, state-machine, heartbeat), and remembering not to step on the self-learning system (`.agents/`). There's no workflow doc, no tooling, no CI signal. The version-bump "stopper" (1.0.0 > any 0.x release) silences the upstream update-checker but also hides upstream activity from us. Result: we drift, miss bug fixes our users hit, and rebuilding the merge knowledge each time costs a full day.

## Target Users

### Aura maintainer (primary)
- **Context:** Periodically (every 2–4 weeks) wants to absorb upstream bug fixes without breaking Aura's identity.
- **Primary need:** Repeatable, low-cognitive-load sync that surfaces conflicts up front and protects local-only assets.
- **Success looks like:** A sync from 0.95 → 0.96 takes under 2 hours and produces a single reviewable PR.

### Aura end-user (secondary)
- **Context:** Uses the web UI daily; doesn't care where fixes come from, just wants the UI to stop duplicating messages and dropping connections.
- **Primary need:** Fewer regressions after sync, faster delivery of upstream bug fixes.
- **Success looks like:** The 0.92.1 duplication fix and 0.95.0 keepalive relaunch land without UI regressions.

## Scope

### In scope (v1)
- Merge upstream `the-companion` from v0.90.0 → v0.95.0 into Aura's `main`.
- Preserve Aura branding across the merge (no "The Companion" or "Vibe Companion" strings reach `main`).
- Preserve Aura's local fixes already on `main` (sidebar archived/orphaned, state-machine `ready→awaiting_permission`, browser heartbeat, Aura-Companion package rename, self-learning `.agents/` system).
- Documented sync workflow (`docs/upstream-sync.md`) that the maintainer can follow without re-deriving steps.
- Branding-preservation script (`scripts/apply-aura-branding.sh`) that re-applies Aura strings deterministically after pulling upstream.
- Drift signal: a way to know when upstream has shipped a new release without running manual `curl` against npm.

### Out of scope (v1) — future consideration
- Cherry-picking individual upstream PRs (we commit to full-merge cadence).
- Publishing Aura Companion to npm (stays a private fork).
- Auto-merge / auto-PR bot — surfacing the signal is enough; the merge stays human-driven.
- Restructuring Aura's directory layout to reduce conflict surface.

### Non-goals
- Tracking upstream's release cadence in lockstep — Aura syncs on its own schedule.
- Contributing changes back to upstream — one-way pull, not a bidirectional fork.
- Preserving upstream's update-checker UX — Aura's npm checker stays disabled-by-version-bump.

## Stories

### A. Upstream merge to 0.95.0

#### Story A.1: Absorb upstream history

**When** the maintainer kicks off a sync, **I want to** pull upstream up to a chosen tag into a working branch, **so I can** see all conflicts in one place before any decision is final.

**Acceptance Criteria:**

Given Aura `main` is at the current fork-tip and upstream `the-companion` has tag `v0.95.0`
When the maintainer runs the documented sync command
Then a local branch named `sync/upstream-0.95.0` exists containing every commit from upstream `v0.90.0..v0.95.0`

Given the sync branch is created
When `git diff main...sync/upstream-0.95.0 -- web/src web/server` is inspected
Then every functional change between 0.90.0 and 0.95.0 is reachable on the branch (verified by spot-checking PR #597, #621, #634)

Given upstream introduces a file that conflicts with an Aura-only file
When the merge runs
Then the conflict is flagged before any auto-resolution, never silently overwritten

Given the maintainer aborts the sync mid-way
When the abort runs
Then `main` is unchanged and the work-in-progress branch is preserved for retry

#### Story A.2: Verify post-merge runtime

**When** the merge resolves cleanly, **I want to** know whether the running app still passes the existing test suite and boots, **so I can** decide whether to land the PR.

**Acceptance Criteria:**

Given the sync branch with all conflicts resolved
When `bun run typecheck` and `bun run test` run from `web/`
Then both pass (modulo the pre-existing `HomePage`/`ModelSwitcher` Opus-regex failures, documented as known)

Given the sync branch
When the dev server boots
Then it serves `/api/sessions` 200 OK and the playground at `#/playground` renders without console errors

Given the user-visible duplication bug from PR #597
When a session that triggered the bug pre-sync is replayed against the sync branch
Then assistant messages with the same `id` are not visually duplicated

### B. Branding preservation

#### Story B.1: Re-apply Aura identity deterministically

**When** the merge pulls in a new file that contains upstream branding, **I want to** re-apply Aura strings by running a single script, **so I can** trust that no "The Companion" string survives to `main`.

**Acceptance Criteria:**

Given a file freshly merged from upstream containing the strings "The Companion", "Vibe Companion", or "the-companion" (in user-facing copy or manifest)
When `scripts/apply-aura-branding.sh` runs
Then those strings are replaced with the Aura equivalent and the script reports each file it touched

Given the package name `the-companion` appears in `web/package.json` after merge
When the branding script runs
Then `name` becomes `aura-companion` and `version` is preserved at the Aura value (1.0.x), not reset to upstream's 0.95.0

Given a file that legitimately references upstream by name (e.g. `CLAUDE.md` documenting the fork relationship, npm update-checker querying the upstream package)
When the branding script runs
Then those references are preserved (script reads an allowlist; doesn't blindly sed everything)

Given the script runs against an already-Aura-branded file
When it finishes
Then the file is byte-identical to before (idempotent re-runs are safe)

### C. Sync workflow

#### Story C.1: One document, one path

**When** the maintainer starts a new sync (now or in 6 months), **I want to** follow a single document end-to-end, **so I can** complete the sync without consulting Slack, chat history, or memory.

**Acceptance Criteria:**

Given `docs/upstream-sync.md` exists
When a person who has never done a sync reads it
Then they can complete a 0.95 → 0.96 dry-run on a clean clone without external help

Given the workflow doc
When it lists steps
Then each step is either a single shell command or a single decision point with criteria for going forward vs. stopping

Given the doc references files (branding script, allowlist, conflict checklist)
When those files don't exist
Then the doc is treated as broken (covered by a CI smoke-check)

#### Story C.2: Local fixes survive

**When** the maintainer merges upstream, **I want to** know which local-only commits exist so they aren't accidentally dropped, **so I can** rebase or re-apply them with intent.

**Acceptance Criteria:**

Given `main` and the sync branch
When the maintainer runs the documented "list local-only commits" command
Then it prints every commit on `main` that has no equivalent in upstream `0.90..0.95`, grouped by area (branding, sidebar, state-machine, heartbeat, self-learning)

Given a local fix overlaps semantically with an upstream fix (e.g. our sidebar fix vs. upstream PR #621)
When the workflow reaches conflict resolution
Then the doc tells the maintainer to keep the upstream version and verify the symptom is still fixed, with a one-line manual smoke step

### D. Drift detection

#### Story D.1: Know when upstream ships

**When** upstream publishes a new release to npm or GitHub, **I want to** be notified passively, **so I can** decide when the next sync is worth doing without polling manually.

**Acceptance Criteria:**

Given upstream publishes `the-companion@0.96.0` to npm
When the drift detector runs (cron / GitHub Action / local script — implementer's choice)
Then a single notification fires (issue, file, commit, log line — surface chosen by implementer) within 24 hours

Given the detector has fired for 0.96.0
When it runs again before a sync completes
Then it does not re-fire for the same version (deduped by version)

Given the detector cannot reach npm or GitHub
When it runs
Then it logs the failure but does not crash the surrounding system

## Technical Context

- **Stack:** Bun 1.x runtime, Hono backend on `web/server/`, React 19 + Vite on `web/src/`, TypeScript strict.
- **Repos:** Aura at `github.com/antonioshaman/aura-companion`, upstream at `github.com/The-Vibe-Company/companion`. Upstream npm package: `the-companion`.
- **Constraints:** Husky pre-commit runs typecheck + tests. Aura-only assets: `.agents/knowledge/`, `landing/` (if present), Aura-branded `web/src/` strings, `web/server/update-checker.ts` (queries upstream — preserved deliberately).
- **Existing systems:** Local fixes already on `main`: `93a205c` (sidebar), today's state-machine fix (`session-state-machine.ts`), today's heartbeat (`ws-bridge.ts` + browser-incoming `keep_alive` type).

## Boundaries

### ✅ Always
- Run `bun run typecheck && bun run test` before opening the sync PR.
- Use a fresh branch named `sync/upstream-<version>` per sync — never push to `main` directly.
- Re-run `scripts/apply-aura-branding.sh` after every conflict-resolution round, not just once at the end.
- Document any merge decision that wasn't mechanical in the PR description (one bullet per non-obvious choice).

### ⚠️ Ask first
- Adopting an upstream change to `web/server/update-checker.ts` (changes the version-bump stopper).
- Adopting an upstream change to `web/package.json` `name`/`version` fields.
- Adding a new third-party dependency that came in via upstream.
- Removing or relocating files in `.agents/`, `landing/`, or any directory that exists only on Aura.
- Changing the npm registry the update-checker points to.

### 🚫 Never
- Squash-merge the sync branch into `main` (we keep upstream commit history for future bisection).
- Force-push to `main` or to any `sync/*` branch shared with reviewers.
- Drop a local-only commit silently — if it must go, document why in the PR.
- Commit the rendered output of `scripts/apply-aura-branding.sh` without verifying the script is idempotent on its own output.
- Replace upstream's code with a "from-scratch" rewrite during sync — sync first, refactor after.

## Success Metrics

### Launch criteria (v1 is done when)
- `main` contains all upstream commits up to `the-companion@v0.95.0`.
- The four pre-existing local fixes still pass their tests on `main`.
- `docs/upstream-sync.md` exists and a dry-run of 0.95 → next-tag succeeds without consulting other sources.
- `scripts/apply-aura-branding.sh` is idempotent and covered by at least one test.
- Drift detector has fired at least once (proving the wiring works).

### 30-day success
- One additional sync (0.95 → 0.96 or later) completes in under 2 hours of maintainer time.
- Zero "The Companion" / "Vibe Companion" strings in `main` (grep-verifiable).
- The 0.92.1 streaming duplication fix is observably present in production (no `same-id` assistant message duplication in user reports).

## Recommended Decomposition

### Phase 1: Foundation (do this first, branch off `main`)
- Story B.1 — Branding script + allowlist. Build it *before* the merge so the merge can use it.
- Story C.1 — Skeleton workflow doc. Fill it in as Phase 2 happens; document each step you actually take.

### Phase 2: The merge (the headline outcome)
- Story A.1 — Pull upstream into `sync/upstream-0.95.0`, resolve conflicts using Phase 1 tooling.
- Story A.2 — Verify runtime. Land the PR.
- Story C.2 — Capture the local-fixes inventory while the knowledge is fresh.

### Phase 3: Future-proofing (low priority, do once Phase 2 lands)
- Story D.1 — Drift detector. The cheapest viable form (a cron-fired `curl` that opens a GitHub issue) is fine.
- Backfill: re-run the workflow doc against a 0.95 → 0.96 dry-run when upstream ships next; fix any rough edges.

## Assumptions

- (unconfirmed) The fork stays one-way — we never push back to upstream.
- (unconfirmed) `1.0.x` versioning continues; we bump to `1.0.95` or `1.1.0` after this sync to mark the absorbed upstream baseline.
- (unconfirmed) Drift signal target = a local file or GitHub issue is enough; no Slack/email needed.
- (confirmed in this session) Update-checker stopper stays in place via `web/package.json` version > upstream.
- (confirmed) Husky pre-commit runs typecheck + tests; the sync workflow inherits that gate.

## Open Questions

- Should the merge land as one giant PR or split per upstream minor (0.91, 0.92, …) for reviewability? (Recommendation: one PR, since each upstream minor is already a release commit.)
- Where does the drift signal go — `~/.companion/upstream-drift.json`, a GitHub Action issue, or a `bun.log` line? Maintainer preference.
- Do we want a `sync/` branch convention with branch protection rules, or is a local branch fine?
- How aggressive should the branding allowlist be? E.g., should `update-checker.ts` querying `the-companion` count as "legitimate" (current default) or "needs flag-on-merge"?

---

*After implementing each phase, compare results against the acceptance criteria for that phase's stories and list any unmet requirements.*
