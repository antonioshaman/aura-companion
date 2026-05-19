# Spec: Council Mode bidirectional pipeline — Orchestrator ↔ Observer cycle

**Date:** 2026-05-15
**Status:** Draft
**Depends on:** `specs/council-experts-catalog-v2-expansion.md` (catalog v2 with 16 creator-named IDs + chair-side stack-detection + panel selection)

## Vision

Today's Aura Council Mode pair (Orchestrator + Observer sessions) is **one-directional**: Observer wakes on filesystem checkpoint, writes a review file, server fans findings back to Orchestrator's UI. Failure modes the operator already saw: (1) Observer falls asleep silently when the filesystem watcher drops events; (2) Orchestrator advances without knowing Observer is dead; (3) cross-half memory drift (Orchestrator runs `/learn`, Observer's review is based on stale memory); (4) no convergence signal — operator must manually check CI gates to know "we're done". v2 makes Council Mode a **bidirectional, self-driving development pipeline**: Orchestrator follows the canonical 9-step sequence (`/prime → /spec-writer → /council-plan → /council-implement → /council-review → /test-architect → /self-improvement → /learn → /self-reflect`); Observer reviews task N's commit IN PARALLEL with Orchestrator's task N+1 plan; both halves can wake each other, exchange messages visibly to the operator, and converge after 2-3 cycles + green CI. "Why now": β consolidated the catalog (44/44 byte-identical, −29% LOC); v2-catalog completes the catalog story. The pipeline is the next bottleneck — operators must currently choreograph the slash commands manually and watch CI by hand.

## Problem Statement

Operators report three symptoms today: (1) **silent Observer drop-off** — connection-loss or filesystem-watcher race leaves Observer in `degraded`, no auto-recover, Orchestrator keeps advancing without review; (2) **memory drift between halves** — Orchestrator does `/learn`, the new memory entry lands in `~/.claude/projects/<x>/memory/`, but Observer's next dispatch reads its OWN per-half memory baseline (no cross-half sync); (3) **manual choreography** — operator must remember to run `/prime` first, must invoke `/spec-writer` before `/council-plan`, must manually check `bun run typecheck && bun run test && bun run test:a11y` after each round. There's no "we're done — ship it" signal; convergence is an ad-hoc judgment. The current model wastes wallclock waiting on each step + creates a single-point-of-failure when Observer sleeps unexpectedly.

## Target Users

### User segment 1: Aura developer running a Council pair
- **Context:** Created a Council pair via the UI's "Create Council Mode" toggle; expects Orchestrator + Observer to drive the feature autonomously through plan → implement → review cycles until CI is clean.
- **Primary need:** Confidence that both halves stay alive throughout the session AND a clear "shippable now" signal.
- **Success looks like:** Pair survives connection flaps; Observer auto-wakes on missed checkpoints; convergence banner fires after 2-3 clean cycles.

### User segment 2: Multi-stack operator
- **Context:** Same operator as the catalog spec — runs Council pairs across 13+ projects. Today must restart manually after every Observer flap.
- **Primary need:** Pair-coordination that survives the filesystem-watcher quirks they've debugged for weeks. Bidirectional wake means either half can pull the other out of `sleep` / `degraded`.
- **Success looks like:** Operator opens a council pair, walks away, returns to a converged feature with green CI — no manual restarts.

## Scope

### In scope (v1)

- **Canonical 9-step Orchestrator sequence** — `/prime → /spec-writer → /council-plan → /council-implement → /council-review → /test-architect (anytime) → /self-improvement → /learn → /self-reflect` announced at session start.
- **Parallel Observer review cycle** — Observer reviews task N's commit while Orchestrator advances to task N+1.
- **Cross-half wake + heartbeat** — either half can revive the other when sleep/degradation is detected. See "Cross-half sync architecture options" section — implementer picks the hybrid.
- **Convergence detection** — 2-3 consecutive cycles with 0 P1 findings + green CI → pair emits `converged` checkpoint + banner.
- **Shared memory baseline** — Orchestrator's `/learn` writes are visible to Observer's next dispatch (rsync-style propagation between per-half memory).
- **Observer sleep timer adjustable by Orchestrator** — Orchestrator can send a `sleep-timer <ms>` directive (e.g., shorter timer during active development, longer during overnight runs).
- **Documentation** — `conventions.md` gains EC-27 ("Council Mode standard pipeline + bidirectional cycle + convergence signal") and EC-28 (deferred Layer 1-6 architectural roadmap — LangGraph orchestrator, CrewAI/AutoGen runtime, OpenDevin executors, vector memory, MCP runtime — documented as future state per the user's vision document).

### Out of scope (v1) — future consideration

- **Full v2 layered architecture** (LangGraph Brahman, CrewAI specialist runtime, AutoGen debate loops, OpenDevin shell/browser/editor/planner/filesystem, local Ollama/Qwen). EC-28 documents the roadmap but v1 stays on existing `cli-launcher.ts` + `session-orchestrator.ts` + filesystem checkpoints.
- **Vector memory** (semantic recall across sessions). Today's `.agents/knowledge/` + memory MD files stay.
- **MCP runtime integration** (servers, tools, shared context). The MCP LENS lives in `colvin` (per catalog spec); runtime is separate.
- **Coder-vs-reviewer debate loops** within a single half (AutoGen-style). v1 keeps single-round dispatch.

### Non-goals

- **Not a Claude Code skill-loader rewrite.** The pipeline runs on top of existing slash commands; we add coordination + sequence-awareness, not a new harness.
- **Not a UI overhaul.** Convergence banner is small; the rest of the pair UX stays as-is.

## Cross-half sync architecture options (DISCUSSION — implementer chooses hybrid)

The current sync mechanism (Observer watches `.council/checkpoints/`, writes to `.council/reviews/`) has known failure modes: filesystem watchers drop events under load, no liveness signal, no way for Orchestrator to know Observer is stuck. v1 should layer additional channels. **None of these replace filesystem checkpoints** — those stay as the persistent audit trail. The question is what to ADD for liveness + interactive coordination.

### Option A: Filesystem mailbox (extend current shape)
Append-only `.council/mailbox.jsonl` shared by both halves; each appends events `{from, to, kind, body, ts}`. Both watch the file via existing fs-watcher infra.
- **Pros:** Zero new infrastructure; survives server restart; replayable; matches existing β model.
- **Cons:** Same fs-watch fragility as today; no instant wake-up; high latency under load.
- **When suitable:** if we believe the fs-watch issues are debuggable rather than structural.

### Option B: Dedicated REST API on port 3457 (port-isolated coordination)
Spin a second small HTTP server on `:3457` exposing `POST /pair/<groupId>/wake`, `POST /pair/<groupId>/heartbeat`, `POST /pair/<groupId>/message`, `GET /pair/<groupId>/status`, `POST /pair/<groupId>/sleep-timer`. Each half polls heartbeat + posts on advance. Port isolation: if `:3456` stalls (main bridge under load), `:3457` still responds.
- **Pros:** Survives bridge stalls; standard REST is operationally familiar; easy to debug with `curl`; explicit per-pair routes.
- **Cons:** Another process to monitor; needs its own auth (token); state ownership question (in-memory vs persisted).
- **When suitable:** if operators have observed `:3456` stalls hurting pair-coordination.

### Option C: Inline messages via existing `injectUserMessage` (visible in CLI/UI)
Extend `ws-bridge.injectUserMessage(sid, content, origin)` (already shipped in PR #59 with `origin: "server:cron|agent|rest"`) to support `origin: "council:peer"`. Observer can post a user_message into Orchestrator's chat thread (and vice versa). The message shows up IN THE CLI session + browser UI as a tagged inline note from the peer.
- **Pros:** Maximum operator visibility — you literally SEE the halves talking; reuses today's infrastructure; no new ports; no new files; persists in recording for replay.
- **Cons:** Conflates "user input" with "peer coordination" — Observer's note advances Orchestrator's turn state unless we gate it (the EC-16 origin-discriminator already supports skipping `userFrameObservers` for server-origin frames — extend for `council:peer`); chat thread fills up if too chatty.
- **When suitable:** if the operator wants to OBSERVE the pair conversation directly. Strong for debugging.

### Option D: WebSocket pair-channel via bridge (control_request subtype)
Add `control_request` subtype `pair:message` flowing through existing `ws-bridge.ts` routing. Each half subscribes; the other half sends. Live, low-latency, bidirectional.
- **Pros:** Reuses existing WS plumbing; instant delivery; clean separation from user-message flow.
- **Cons:** Coupled to bridge uptime (same failure mode as Observer dropping today); requires new protocol shape + tests.
- **When suitable:** if we trust the bridge's reliability and want a clean isolated channel.

### Option E: Inline code annotations
Halves drop comments like `// @council:from=observer:finding=fnd_abc123` directly into the source files. The other half reads via grep. Persistent, version-controlled, lossless across server restarts.
- **Pros:** Version-controlled; reviewable in the diff; survives all infrastructure failure modes; readable by a human in a code review.
- **Cons:** Pollutes the source tree; slow loop (commits required for the other half to see); doesn't survive a `git checkout` of a different branch; not interactive.
- **When suitable:** for FORENSIC annotations rather than live coordination. Could co-exist with another channel as the persistent record.

### Option F: Hybrid — RECOMMENDED for v1

Layer the channels by purpose:

| Channel | Purpose | Mechanism |
|---|---|---|
| **State of record** | Checkpoints, reviews, audit trail | β filesystem (`.council/checkpoints/`, `.council/reviews/`) — unchanged |
| **Liveness + wake** | Heartbeat, wake-up, sleep-timer adjustment, degraded-state recovery | Option B — REST API on `:3457` (port-isolated from main bridge) |
| **Conversational visibility** | "Observer flagged X" inline in Orchestrator's chat; pair talks visibly to operator | Option C — extended `injectUserMessage` with `origin: "council:peer"` |
| **Forensic annotation (optional)** | Persistent peer-tagged comments in source | Option E — `// @council:` comments, opt-in per project |

This hybrid means:
- Operator SEES the pair conversation in the CLI/UI (Option C visibility).
- Liveness recovers from filesystem-watcher failure via REST heartbeat (Option B isolation).
- Audit trail unchanged for replay and forensics (β files).
- Optional code annotations for projects that want them (Option E forensic).

Implementer can drop Option E entirely if it adds noise. Options C + B are the core proposal.

## Stories

### Canonical sequence

#### Story 1.1: Orchestrator announces the 9-step sequence at session start

**When** a fresh Council Mode pair activates, **I want** the Orchestrator's first message to announce the planned sequence `/prime → /spec-writer → /council-plan → /council-implement → /council-review → /test-architect (anytime) → /self-improvement → /learn → /self-reflect`, **so I can** start the session knowing the framing and exit-points.

**Acceptance Criteria:**
- Given a fresh Council Mode pair, when the Orchestrator first activates, then its first message names the 9 sequence steps in order with brief intent.
- Given the Orchestrator is at step N, when it advances, then a checkpoint `<workspace>/.council/checkpoints/step-<N>-<phase>.json` records the step + produced artifact path.
- Given an unexpected skill is invoked out of sequence (e.g. `/council-implement` before `/council-plan`), when the Orchestrator detects, then a structured WARN names the missing prerequisite step (forensic; does NOT block).
- Given the session wraps, when `/self-reflect` runs, then it summarises which sequence steps ran vs skipped.

### Bidirectional sync

#### Story 2.1: Observer reviews task N in parallel with Orchestrator's task N+1

**When** Orchestrator's task N completes (commit + checkpoint sequence M emitted), **I want** Observer to start `/council-review` against task N's commit while Orchestrator starts task N+1's `/council-plan`, **so I can** parallelise review and converge fast.

**Acceptance Criteria:**
- Given Orchestrator's task N emits a checkpoint, when Observer wakes, then it dispatches `/council-review` against task N's commit AND Orchestrator can advance to task N+1 without waiting.
- Given task N's review surfaces P1 findings, when Observer writes the review file, then Orchestrator's BlockerBanner fires AND the new task's `/council-plan` reads the review as input.
- Given task N's review surfaces 0 P1 findings, when Observer finishes, then Orchestrator continues task N+1 without interrupt.
- Given Observer is mid-review when task N+1 emits its own checkpoint, when the new checkpoint lands, then Observer queues it after the current review (no checkpoint loss).

#### Story 2.2: Either half can wake the other out of degraded/sleep state

**When** Orchestrator detects Observer has been silent past the heartbeat threshold (or vice versa), **I want** either half to send a wake signal that pulls the other back online, **so I can** recover from filesystem-watcher drops or bridge stalls without a manual restart.

**Acceptance Criteria:**
- Given Observer has not posted a heartbeat in N seconds (N=heartbeat-interval × 3), when Orchestrator runs its periodic check, then it sends a wake signal via the cross-half coordination channel.
- Given Observer is degraded but reachable, when it receives a wake signal, then it re-establishes its filesystem watchers AND posts a fresh heartbeat AND signals "alive" back to Orchestrator.
- Given Observer is unreachable (process dead), when wake times out after M seconds, then Orchestrator emits a `pair:half-unreachable` log + UI banner; operator decides whether to recreate the pair.
- Given Orchestrator is stuck (no checkpoints emitted in K minutes), when Observer notices the gap, then Observer reciprocates with a wake signal toward Orchestrator (bidirectional, not just Orchestrator → Observer).

#### Story 2.3: Halves can write to each other's chat thread (operator-visible)

**When** Observer surfaces a P1 finding mid-cycle, **I want** the finding to appear as an inline message in Orchestrator's CLI/UI chat thread (and vice versa for Orchestrator pings), **so I can** SEE the pair conversation rather than only reading filesystem artifacts.

**Acceptance Criteria:**
- Given a finding, when Observer posts it via the cross-half channel, then an inline message tagged `[from-observer: P1]` appears in Orchestrator's chat thread (CLI + UI).
- Given the inline message has `origin: "council:peer"`, when the bridge processes it, then `userFrameObservers` is NOT advanced (matches EC-16 — peer messages aren't user activity).
- Given the operator wants to see only review files (less chatty mode), when they toggle a config flag, then inline peer messages are suppressed from the UI but still land in recording.
- Given a pair-peer message exceeds 1KB, when posting, then it's truncated with a link/path to the full content (audit trail in `.council/reviews/`).

#### Story 2.4: Cross-half memory baseline stays consistent

**When** Orchestrator runs `/learn <insight>` mid-session, **I want** Observer's NEXT dispatch to read the updated memory baseline, **so I can** avoid Observer reviewing against stale context.

**Acceptance Criteria:**
- Given Orchestrator commits a memory entry to its half's `~/.claude/projects/<x>/memory/`, when the entry lands on disk, then Observer's per-half memory dir gains the same file within N seconds (rsync-style propagation; specific N tuned during implementation).
- Given memory propagation lags, when Observer's next dispatch begins, then it explicitly re-reads its memory dir AND if a propagation conflict (same filename, different content), then the lexically-newer file wins with a structured log.
- Given Observer commits its OWN `/learn` entry, when the file lands, then Orchestrator's memory dir mirrors it via the same propagation channel.
- Given the propagation channel fails for >M minutes, when the heartbeat surfaces the drift, then both halves degrade to "stale memory — manual rsync required" mode + warn the operator.

### Sleep timer adjustment

#### Story 3.1: Orchestrator can adjust Observer's sleep-timer

**When** active development is in progress (Orchestrator is in mid-cycle), **I want** to send Observer a shorter sleep-timer (e.g., 30s vs 5min), **so I can** keep Observer responsive without manually restarting the pair.

**Acceptance Criteria:**
- Given Orchestrator sends a `sleep-timer-set <ms>` directive via the cross-half coordination channel, when Observer receives, then its sleep timer adjusts to the new value AND it acknowledges with a heartbeat.
- Given the sleep timer is set to 0 or negative, when Observer receives, then it rejects the directive with a structured error AND keeps its prior value.
- Given Orchestrator hasn't sent a sleep-timer directive, when Observer wakes, then it uses the default (today's value, e.g., 5 minutes — preserved from current implementation).
- Given the operator overrides the sleep-timer via a config flag, when the flag is set, then the operator's value wins over Orchestrator's directive.

### Convergence detection

#### Story 4.1: After N clean cycles + green CI, pair declares "converged"

**When** the pair has completed N (default 3, configurable 2-5) consecutive task-review cycles with 0 P1 findings AND CI gates (typecheck + tests + a11y + coverage) are all green, **I want** the pair to emit a `converged` checkpoint AND show a "Converged — ready to ship" banner, **so I can** know when to merge without manually checking gates.

**Acceptance Criteria:**
- Given (N-1) consecutive cycles complete with 0 P1 findings, when Orchestrator next runs CI gates (`bun run typecheck && bun run test`), then a `convergence-trial` checkpoint records the gate results.
- Given all gate results are green AND N consecutive clean cycles passed, when the Nth cycle completes, then a `converged` checkpoint is written AND a UI banner shows "Converged — ready to ship".
- Given any cycle surfaces a P1 OR a gate fails, when convergence was previously declared, then `converged` is revoked AND the clean-cycle counter resets to 0.
- Given the operator manually dismisses the banner (overrides), when the dismissal lands, then a `convergence-manual-override` log entry records the decision (forensic).
- Given the Carmack-reviewer evaluates the changeset size + risk, when it recommends adjusting N (lower for small/safe changes, higher for large/risky), then a `convergence-threshold-suggestion` log entry surfaces the rec; operator decides to accept/decline.

#### Story 4.1.5: Convergence indicator in upper-left panel (sun/moon consistency)

**When** the pair reaches `converged` state, **I want** the convergence indicator to live IN THE UPPER-LEFT PANEL (the Sidebar header area, NOT a separate sticky banner at the top of ChatView), with the pair label format `☼ <name1> * Orchestrator / ☽ <name2> * Observer` and a convergence-state badge alongside, **so I can** see at a glance which pair has converged + which session is which role, WITHOUT a separate banner stealing chat real estate.

**Acceptance Criteria:**
- Given a Council pair, when the upper-left panel renders, then the pair header reads `☼ <session-1-name> * Orchestrator / ☽ <session-2-name> * Observer` on a single line OR stacked if width-constrained.
- Given the pair is mid-cycle (not yet converged), when the panel renders, then a status badge `🔄 Cycle <N>/<threshold>` appears next to the pair label.
- Given the pair reaches `converged` state, when the panel renders, then the status badge flips to `✅ Converged — ready to ship` (green / `emerald-500` token).
- Given the pair is `degraded` or any half is offline, when the panel renders, then the badge flips to `⚠️ Degraded` (warning yellow / `amber-500` token) AND the convergence counter freezes (does not advance during degraded state).
- Given the operator clicks the `✅ Converged` badge, when the click lands, then a small popover/dropdown opens with: "View final review" (opens last `council-review-<provider>-observer.md`), "Dismiss" (forensic-logged override, hides badge), "Reset cycle counter" (clears convergence state for the next feature loop).
- Given ANY UI surface naming the Orchestrator role (sidebar row, panel header, peer-message tags, EC-9 logs, status pills, recorder annotations), when rendering, then it uses the literal `☼ Orchestrator` form (not `Orchestrator` alone, not `Chair`, not `Lead`).
- Given ANY UI surface naming the Observer role, when rendering, then it uses `☽ Observer` form consistently.
- Given a non-Council session (solo, no pair), when rendering, then NO ☼/☽ icon appears (icons are pair-specific).
- Given the pair label exceeds the panel width, when truncation kicks in, then the role indicator (☼ or ☽) + first 12 chars of the name + role label are preserved; the OTHER half collapses to icon-only with hover-tooltip showing the full label.

**Reference for visual placement:** mirror the existing sidebar role decoration (commit `ec93eab feat(sidebar): council role decoration on session rows — ☼ orchestrator / ☽ observer`). The convergence info attaches to the SAME location, not a new banner surface.

## v2 deployment isolation (CRITICAL — inherited from catalog spec)

This pipeline spec inherits the v2 isolation pattern from `specs/council-experts-catalog-v2-expansion.md`. Pipeline-specific notes:

- All v2 pipeline behaviour (canonical sequence announcement, cross-half sync, convergence detection) lands in `council-*-v2/` dispatcher skills + `council-implement-*-v2/` implementer skills. v1 dispatchers stay untouched during development.
- Aura code changes (`web/server/session-orchestrator.ts`, `web/server/ws-bridge.ts`, new REST server on `:3457`, etc.) develop on a `feat/council-v2-pipeline` git branch in `/root/aura-companion`. Production main is untouched.
- REST `:3457` server only starts when invoked by a `*-v2` skill, OR behind a feature flag in main branch (e.g., `COMPANION_PAIR_COORD_PORT=3457`). Production sessions on main get the v1 behaviour (no `:3457` server, no cross-half wake).
- Convergence banner UI ships behind a feature flag (`COMPANION_COUNCIL_V2_UI=1`) until promotion.
- Promotion sequence: catalog v2 atomic swap (per catalog spec) → flip feature flags → archive v1 → 30-day watch.

The two specs land their atomic-promotion commits in the same PR so v1 → v2 cutover is a single reviewable change.

## Technical Context

- **Catalog dependency:** Requires `specs/council-experts-catalog-v2-expansion.md` Phase 3 to be done first (catalog stable at 16 IDs + chair-side stack-detection working).
- **Existing infra:** `ws-bridge.ts`, `session-orchestrator.ts`, `session-group-coordinator.ts`, `recorder.ts`, β filesystem checkpoints + reviews — all stay.
- **New surfaces:** REST server on `:3457` (Option B); extended `injectUserMessage` with `council:peer` origin (Option C); convergence-banner UI component; cross-half memory propagator.

## Boundaries

### ✅ Always

- Preserve β filesystem checkpoints + reviews as the persistent audit trail.
- Inline peer messages via `injectUserMessage` MUST set `origin: "council:peer"` so `userFrameObservers` does NOT fire (EC-16 contract).
- Heartbeat interval ≤ 30 seconds; wake-detection threshold ≥ 90 seconds (3× heartbeat).
- Every cross-half message records to the recording file for replay.

### ⚠️ Ask first

- Adding any non-filesystem channel beyond Options B + C (e.g., MCP, vector memory backplane, custom transport).
- Removing the filesystem checkpoint surface (would break β audit trail).
- Changing the convergence threshold (default 3 cycles + 0 P1; raising/lowering changes user trust).
- Extending the canonical sequence beyond 9 steps.

### 🚫 Never

- Replace filesystem checkpoints with a transient channel — audit trail is load-bearing for incident triage.
- Couple convergence detection to a single CI gate (must be the FULL set: typecheck + tests + a11y + coverage).
- Allow auto-merge on convergence — convergence is a SIGNAL, not an action.
- Send peer messages without the `origin: "council:peer"` tag (would advance user turn state by mistake).

## Success Metrics

### Launch criteria (v1 is done when)

- Canonical sequence announcement lands in Orchestrator's startup message.
- Observer wakes within heartbeat-threshold seconds when Orchestrator pings, AND vice versa.
- Inline peer messages appear in CLI + UI with `[from-observer]` / `[from-orchestrator]` tags.
- 2-3 cycles with 0 P1 + green CI produces a `converged` banner.
- `conventions.md` updated with EC-27 + EC-28.

### 30-day success

- Operator-reported "Observer dropped silently" incidents: ≥80% reduction (today's most common Council Mode complaint).
- Average wallclock from "pair created" to "converged" banner: ≤ 30 minutes for a small-feature pair (was 60+ today with manual choreography).
- Cross-half memory drift incidents (where Observer reviewed against stale `/learn`): ≤1% of cycles.

## Recommended Decomposition

### Phase 0: Pair with catalog v2 isolation

- Catalog spec Phase 0 establishes `_council-experts-v2/` + 6 forked `council-*-v2/` skills.
- Pipeline spec phases land their changes into the SAME `*-v2` forks (no overlap, sequential phases).
- Aura code changes (REST `:3457` server, convergence banner UI, etc.) develop on `feat/council-v2-pipeline` branch with feature flags.

### Phase 1: Canonical sequence + filesystem-only liveness improvements — INSIDE `council-*-v2`
- Story 1.1 — sequence announcement at session start
- Improve fs-watcher robustness (poll fallback if event dropped, scan-on-init reconcile per memory `feedback_fs_watch_event_only_needs_init_scan`)
- No new ports, no new channels yet — establishes the sequence skeleton
- **Why first:** lowest infra change; testable in isolation; baseline measurement for wake-failure rate

### Phase 2: Cross-half liveness via Option C (inline peer messages)
- Story 2.2 (subset: wake via injectUserMessage), Story 2.3 — extend `injectUserMessage` with `council:peer` origin; Orchestrator pings via inline message; Observer responds same way
- Operator sees the pair conversation directly
- **Why second:** maximises observability cheaply; if this is enough, Phase 3 can defer

### Phase 3: Cross-half coordination REST API on `:3457` (Option B)
- Story 2.2 (full: REST-based wake + heartbeat), Story 3.1 — separate HTTP server on `:3457` for heartbeat/wake/sleep-timer/status; survives bridge stalls
- **Why third:** addresses the bridge-stall failure mode that Phase 2 inherits

### Phase 4: Cross-half memory propagation
- Story 2.4 — rsync-style propagation between Orchestrator and Observer memory dirs; conflict resolution; drift detection
- **Why fourth:** depends on Phases 2-3 for the channel; orthogonal to convergence

### Phase 5: Convergence detection + UI banner
- Story 4.1 — clean-cycle counter, CI gate trigger, `converged` checkpoint, UI banner component (behind `COMPANION_COUNCIL_V2_UI=1` feature flag)
- **Why fifth:** highest-visibility piece; needs all prior phases to feed reliable inputs

### Phase 6: Atomic promotion (joint with catalog spec Phase 4)

- Lands in the SAME PR as catalog spec Phase 4.
- Skills swap: 6 `council-*-v2/` directories replace v1 atomically (see catalog spec for the exact mv sequence).
- Aura code merge: `feat/council-v2-pipeline` branch merges to `main`.
- Feature flags flipped: `COMPANION_PAIR_COORD_PORT=3457` becomes default; `COMPANION_COUNCIL_V2_UI=1` becomes default.
- 30-day archive watch on `council-v1-archive` git tag.
- **Why last:** mechanical promotion of validated v2 state; cannot run mid-Council session that uses these skills.

## Assumptions

- **(confirmed)** Cross-half sync uses a HYBRID of Options B (REST `:3457` for liveness) + C (inline peer messages for visibility) + filesystem-of-record (β audit trail). Options A/D/E available as additions if hybrid proves insufficient.
- **(confirmed)** OpenDevin/LangGraph/CrewAI/AutoGen/vector memory/MCP runtime is FUTURE STATE — documented in `conventions.md` EC-28 (per the user's Layer 1-6 architectural vision) but NOT v1 work.
- **(unconfirmed)** Heartbeat interval (30s default), wake threshold (90s = 3× heartbeat), and convergence cycle count (3 clean cycles) are correct defaults. Tunable post-launch.
- **(confirmed)** Convergence indicator lives **in the upper-left panel** (Sidebar header area), attached to the pair label `☼ <name1> * Orchestrator / ☽ <name2> * Observer`. NOT a separate sticky banner under TopBar — that would steal chat real estate. See Story 4.1.5 for the badge shape + interactions.

## Resolved decisions (was Open Questions)

### Cross-half sync hybrid (confirmed)
Option F = filesystem of record (β) + REST `:3457` (Option B for liveness) + inline peer messages (Option C for visibility) + **Option E code annotations included in v1** with auto-versioning (per user direction).

### Code annotation format (Option E inclusion)
Annotations land directly in source with the shape:
```
// @council:v<X.Y.Z>:from=<☼-orchestrator|☽-observer>:finding=<fnd_id>:claim="<≤80 chars>"
```
Version `X.Y.Z` is the catalog version (see `~/.claude/skills/_council-experts/VERSION` + `git tag`). Auto-bumped by CI:
- **Patch** bump per CI re-run (`v2.3.0 → v2.3.1`)
- **Minor** bump per PR merge (`v2.3.X → v2.4.0`)
- **Major** bump per spec promotion (`v2.X.Y → v3.0.0` when council-mode-v3 ships)
- Stored in `~/.claude/skills/_council-experts/VERSION` (plain text, single line) AND as git tag for grep-ability.

### REST `:3457` auth (architecturally separate, pragmatically shared in v1)
**Best practice = separate token** (compromise isolation, scope minimisation, independent rotation). For v1 ship reasons we ALLOW shared bearer (`bun run generate-token`'s existing token) BUT EC-29 in `conventions.md` documents the migration path: v2 splits to a dedicated `COMPANION_PAIR_COORD_TOKEN`. Architecture should write the auth layer in a way that one-line config flip switches from shared to dedicated.

### Convergence threshold (default 3, dynamically configurable)
- **Default:** 3 consecutive clean cycles + green CI gates.
- **Override channels:**
  - Pair creation form: `convergence_cycles: <2..5>` input field.
  - Env var per session: `COMPANION_CONVERGENCE_THRESHOLD=<2..5>`.
  - **Carmack-reviewer logic at convergence checkpoint:** the Chair evaluates change size + risk (LOC touched, files changed, security-tagged files, breaking-change markers). If small + low-risk → SUGGEST lowering threshold to 2 ("lighter = simpler = clearer" — Carmack principle). If large + high-risk → SUGGEST raising to 4-5.
  - Operator manual dismiss: forensic-logged override.
- **Hard bounds:** min=2 (anything below is single-pass review, no convergence), max=5 (anything above is spec-defined ceiling — review-fatigue threshold).

### Memory propagation transport (3-tier hybrid borrowed from OpenDevin pattern)

| Tier | Mechanism | Latency | Reliability |
|---|---|---|---|
| **Primary (fast path)** | `inotify` watch on `~/.claude/projects/<x>/memory/` of both halves; new file → cp to the other half | <1s | High on Linux; fragile on macOS (per `feedback_fs_watch_macos_dirname_quirk`) |
| **Signal (cross-check)** | Bridge emits `memory:updated` event when either half's `/learn` lands; both halves listen via bridge subscription | <100ms | Coupled to bridge uptime |
| **Safety net (catch-up)** | 60-second polling rsync between the two memory dirs (catches missed inotify on macOS + missed bridge events on bridge stall) | up to 60s | Survives ALL fs-watch + bridge failures |

**Conflict resolution:** lexically-newer file wins, log structurally `memory.conflict` for forensic. Same filename + different content across halves = high-priority warn.

**Why this hybrid (vs alternatives):**
- LangGraph's `CheckpointSaver`-style state-graph = single-process; our halves are two CLI subprocesses.
- CrewAI's external Mem0/ChromaDB = adds a heavyweight dependency for v1 (out of scope).
- AutoGen's append-only `GroupChat` history = matches Option A mailbox but doesn't solve cross-process file sync.
- OpenDevin's filesystem + event-stream = closest match. We adapt: inotify (filesystem) + bridge event (event-stream) + polling rsync (failure backstop).

### Sleep-timer bounds (confirmed)
- **Min:** 5 seconds (anything below makes Observer effectively spinning + thrash filesystem).
- **Max:** 30 minutes (anything above means Observer is functionally offline; pair should archive instead).
- **Default:** 5 minutes (today's value).

## Resolved decisions (continued)

### inotify polyfill on macOS (confirmed)
No polyfill mandated by the spec. Phase 4 implementation picks per native availability — likely `chokidar` if Bun lacks robust native fsevents, OR direct `fs.watch` with the existing macOS quirks accepted (memory `feedback_fs_watch_macos_dirname_quirk`). The 3-tier transport (inotify + bridge event + polling rsync) means primary-tier failures gracefully degrade to safety-net rsync — no hard dependency on perfect inotify.

### Conflict resolution policy (confirmed — recommendations only)
Spec recommends "lexically-newer file wins" as a DEFAULT heuristic, NOT a hard-enforced policy. Implementation picks the policy fitting the project's filename conventions (date-prefix, semver, monotonic counter, etc.). All conflicts log structurally `memory.conflict` for forensic — operator audits when needed. Spec's job is to mandate the LOGGING + the heuristic existence, not to dictate the specific tie-breaker.

### Auto-versioning trigger (confirmed — green CI only)
Patch bump fires ONLY on green CI run (typecheck + tests + a11y all pass). Flaky CI = no version bump. Reason: avoids the "version-explosion-on-noisy-CI" failure mode. Implementation: CI step checks gate-result before invoking the bump script.

---

*After implementing each phase, compare results against the acceptance criteria for that phase's stories and list any unmet requirements.*
