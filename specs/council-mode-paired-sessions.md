# Spec: Council Mode — paired orchestrator + observer sessions

**Date:** 2026-05-11
**Status:** Draft

## Objective

Add a "Council Mode" to Aura Companion that, on session creation, spawns two linked SDK sessions — an **orchestrator** (the user-facing chat where the Carmack Council workflow runs: `/prime → /spec-writer → /council-plan → /council-implement → /council-review → /test-architect → /self-improvement → /self-reflect`) and an **observer** that wakes on each pipeline checkpoint, performs an independent review of the just-produced artifacts, and signals findings back into the orchestrator UI. The goal is to make the multi-agent pattern that worked manually in past pipelines (catching ~2 P1 issues per phase that single-author thinking missed) reproducible in one click instead of requiring two terminals and manual coordination.

## Context

Today users can run the Carmack Council workflow in a single Aura Companion session by invoking each skill in turn — but there is no independent reviewer. Past attempts at a second "watcher" session in Aura Companion left it idle ("болталась и ничего не происходило") because there was no explicit wake mechanism. The orchestrator side reuses existing `session-orchestrator.ts` + `cli-launcher.ts` + worktree machinery; the new piece is *pairing*, *checkpoint-driven activation*, and the UI to make the observer visible without crowding the chat. All Carmack-Council skills already exist under `~/.claude/skills/`; no skill authoring is part of this spec.

## Scope

### In scope
- New `mode: "single" | "council"` field on the existing session-create API and corresponding UI toggle on New Session.
- Paired session lifecycle: shared `sessionGroupId`, shared workspace (single git worktree), linked kill/archive/reconnect.
- Observer wake mechanism: filesystem checkpoint sentinels at `.council/checkpoints/<phase>.json` written by orchestrator, watched by observer; timer heartbeat as fallback only.
- Observer writes confined to `.council/observer/`, `.council/reviews/`, and `specs/*observer*.md`; code paths read-only.
- UI shape: orchestrator main chat (left), Observer panel (right, collapsible) showing `sleeping / reviewing / blocker-found` + latest findings + artifact links.
- Findings routing: `STOP/BLOCKER` → banner in orchestrator chat + synthetic system message in orchestrator transcript; `Notes/Suggestions` → Observer panel only.
- Provider abstraction with two supported pairings v1: `claude+claude` (default) and `claude+codex` (experimental); UI surfaces active provider/billing source.
- Degraded mode: if observer dies, orchestrator continues; UI offers explicit "Respawn observer".

### Out of scope (v1)
- Auto-invoking the Carmack chain (user still types each skill explicitly).
- Triads or N>2 paired sessions.
- Cross-session shared memory during a phase (only filesystem artifacts).
- Hot-swapping observer system prompts mid-session.
- Mandatory Codex observer (Codex stays an optional adapter).
- Auto-push / PR creation as part of Council Mode (separate feature, auth already wired).

### Non-goals
- Replacing single-session mode — it remains the default.
- Making observer catch 100% of issues; target is "meaningful independent signal," not parity.
- Real-time UI sync between sessions; checkpoint-driven is acceptable.

## Stories

### Story 1: Start a Council Mode session

**When** I create a new session in Aura Companion and need independent review on a Carmack-Council task, **I want to** toggle "Council Mode" before launching, **so I can** get an observer paired with my orchestrator from minute one.

**Acceptance Criteria:**

- Given the New Session dialog is open, when I toggle "Council Mode" on, then a provider-pairing selector appears with `claude+claude` selected by default.
- Given Council Mode is on and I launch the session, when the backend processes the request, then exactly two linked SDK sessions are created sharing one `sessionGroupId`, one workspace, and identical env/permissions.
- Given Council Mode is on but the selected observer provider has no working credentials, when I attempt to launch, then the launch is rejected with an inline error naming the missing credential — no half-paired session is created.

### Story 2: Observer wakes on each checkpoint

**When** the orchestrator finishes a Carmack step and writes the checkpoint sentinel, **I want to** have the observer detect it within seconds, read the produced artifacts, and post a review, **so I can** see independent findings before I move to the next step.

**Acceptance Criteria:**

- Given the orchestrator writes `.council/checkpoints/<phase>.json`, when the file appears, then the observer panel status transitions `sleeping → reviewing` within 5 seconds.
- Given the observer is reviewing, when it completes, then it writes `.council/reviews/<phase>-observer.md` and the orchestrator chat displays an indicator that a review landed.
- Given no checkpoint is written for 30 minutes, when the timer fallback fires, then the observer logs an idle heartbeat to the panel but does NOT begin a review (no fabricated work).
- Given the observer attempts to write outside its allowed paths, when the write is intercepted, then it is blocked and logged as a permission violation in the Observer panel.

### Story 3: Receive and act on findings

**When** the observer surfaces findings, **I want to** see STOP-level blockers immediately in my main chat and routine notes in the side panel, **so I can** decide what blocks the pipeline and what is tracking-only without context-switching.

**Acceptance Criteria:**

- Given the observer review contains a `STOP` finding, when the review file lands, then a banner appears in the orchestrator chat showing the finding summary + link to the full review.
- Given the observer review contains only `Notes`/`Suggestions`, when the review file lands, then the Observer panel updates but no chat banner is shown.
- Given a STOP banner is shown, when I dismiss it, then it collapses but remains accessible via the Observer panel history.

### Story 4: Mixed-provider pairing

**When** I want a different model for independent review to reduce same-model blind spots, **I want to** pair a Claude orchestrator with a Codex observer, **so I can** get diversified review at the cost of an additional billing source.

**Acceptance Criteria:**

- Given I select `claude+codex` pairing, when I launch, then the UI clearly labels both sessions with their provider and billing source (`Claude subscription` / `Codex ChatGPT plan` / `OpenAI API key`).
- Given Codex CLI is not installed or has no auth, when I attempt to select `claude+codex`, then the option is disabled with a tooltip explaining what's missing.
- Given a `claude+codex` pair is running, when the observer produces a review, then the review file is annotated with its provider so future audits can attribute findings.

### Story 5: Lifecycle (kill, archive, reconnect, degraded)

**When** something happens to either session in a pair, **I want to** have predictable group-level behavior, **so I can** trust that kill/archive/reconnect don't leave orphans.

**Acceptance Criteria:**

- Given a Council Mode pair is running, when I archive or kill the orchestrator, then the observer is killed as part of the same group operation.
- Given the observer process dies unexpectedly, when the orchestrator is still alive, then the Observer panel shows "Degraded — observer not running" with a single-click "Respawn observer" action; the orchestrator session continues working.
- Given Aura Companion restarts, when both processes had been alive, then both reconnect to the same `sessionGroupId` and the pair resumes; if only one reconnects within the grace window, the surviving session goes into degraded mode.

## Boundaries

### ✅ Always
- Confine observer writes to `.council/observer/`, `.council/reviews/`, `specs/*observer*.md`.
- Persist `sessionGroupId` and role on disk so a server restart can re-pair the sessions.
- Show the provider + billing source for each half of the pair in the UI.
- Treat the filesystem checkpoint as the authoritative trigger; the timer is fallback only.
- Add tests for paired-session lifecycle (Story 5) and for write-boundary enforcement (Story 2 negative AC).

### ⚠️ Ask first
- Any change to existing single-session create flow that's not gated by the new `mode` field.
- Introducing a new IPC channel between sessions beyond the filesystem + existing event-bus.
- Persisting observer reviews outside the workspace (e.g., a central reviews DB).

### 🚫 Never
- Spawn observer without an explicit user opt-in (`mode: "council"`).
- Let the observer write to code paths or non-allow-listed directories.
- Auto-invoke Carmack-Council skills on the user's behalf.
- Block the orchestrator on the observer being unavailable — degraded mode must keep the user productive.
- Ship Codex as a hard dependency — `claude+claude` must work standalone with no Codex CLI installed.

## Success Metrics

- **First-run reliability:** ≥95% of newly created Council Mode sessions produce at least one observer review within the first orchestrator-driven phase (no "болтающийся" observer regressions).
- **Wake latency:** observer transitions `sleeping → reviewing` within 5 seconds of checkpoint write on a dev machine.
- **Boundary enforcement:** 0 successful observer writes outside the allow-list across the full test suite.
- **Provider parity:** `claude+claude` and `claude+codex` pairs both complete the full Carmack chain end-to-end on a smoke-test repo.
- **Single-mode regression:** existing single-session create flow shows no change in latency or success rate after the feature lands.

## Assumptions

- (confirmed) Carmack-Council skills already exist under `~/.claude/skills/`; this spec does not author them.
- (confirmed) Per-user GitHub auth is wired for `auracomp` via `/root/.ssh/claude-code-deploy`; auto-push out of scope here but inherits that wiring.
- (unconfirmed) Codex CLI exposes a programmatic checkpoint-aware mode comparable to Claude Code's `--sdk-url`; if not, observer-as-Codex may need a thin wrapper to poll filesystem and emit reviews through the WS bridge. Confirm before implementation.
- (unconfirmed) A single shared worktree is acceptable for v1; if race conditions appear during prototyping, fall back to two linked worktrees with explicit FS-only sync.

---

*After implementing, compare results against each acceptance criterion above and list any unmet requirements.*
