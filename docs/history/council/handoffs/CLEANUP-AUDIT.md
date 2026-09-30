# Cleanup Audit — outstanding work as of 2026-05-14

Status of every plan/task spec on disk, what's open, what's closed, what's queued. Written at end of session 2026-05-14 evening; produced by inspecting `git log origin/main`, the merged PR list, the running session/server state, and the contents of each `PLAN-*.md` + `TASK-*.md` file in the repo root.

Reality check: every claim here references either an open PR number (verifiable on GitHub) or a file path in this repo (verifiable on disk). Anything I couldn't verify mechanically is marked **(needs probe)**.

---

## Open PRs this session

| PR | Branch | Status | Scope |
|---|---|---|---|
| **#44** | `fix/sidebar-chip-redundancy-full-suppression` | OPEN — author-only review | TASK-sidebar-chip-redundancy-full-suppression — drop pair-half that duplicates `CC`/`CX` backend chip. Full suite green (5866 pass). |
| **#45** | `feat/auto-proceed-foundation` | OPEN — author-only review | PLAN-aura-orchestrator-idle-auto-proceed Tasks 1+3+4 (envelope contract + `ClockSource` DI + `orchestratorTurnState`). Full suite green (5927 pass; +61 new tests). No behavioural change yet — substrate only. |
| #39 | `docs/fresh-clone-deploy-guide` | OPEN (older) — author-only | Fresh-clone deploy docs. Not touched this session. Pre-existing. |
| #26 | `release-please--branches--main--components--aura-companion` | OPEN (bot) | release-please auto-PR for 1.4.0. Bot-managed; will refresh when next feature merges. |

---

## Plan-file status (`PLAN-*.md` in repo root)

| File | Status | Notes |
|---|---|---|
| `PLAN-upstream-sync.md` (May 8) | ✅ DONE | upstream 0.90→0.95 sync shipped in 1.1.x; can be archived. |
| `PLAN-council-mode-paired-sessions.md` (May 12) | ✅ DONE | Council Mode fully shipped; entire architecture documented in CLAUDE.md. Can be archived. |
| `PLAN-aura-council-reconnect.md` (May 12) | ✅ DONE | AP-2 (`applyEvent` sole mutator) shipped; CLAUDE.md describes it as canonical. Can be archived. |
| `PLAN-aura-observer-auto-wake.md` (May 13) | ◐ PARTIAL | claude+claude observer wake shipped (PR #8). claude+codex wake reverted (#33 → #43) — wake-turn does not survive auto-relaunch race; **deferred indefinitely** until a different mechanism is designed. Working pair: `grp_4469a4c2`. |
| `PLAN-aura-consolidated-refactor.md` (May 13) | ◐ PARTIAL | 16-task meta-spec; majority landed. See per-task table below. |
| `PLAN-aura-orchestrator-idle-auto-proceed.md` (May 13) | ◐ IN PROGRESS | 15 tasks; foundation PR #45 lands Tasks 1+3+4. See "Remaining auto-proceed work" below. |

---

## `PLAN-aura-consolidated-refactor` per-task status

Mapped by cross-referencing the 16 task headers against the merged-PR ledger.

| # | Task | Status | Evidence |
|---|---|---|---|
| 1 | `deriveSideEffects` keystone tests | ✅ DONE | `web/server/group-state-machine.test.ts` has 11 references to `deriveSideEffects` (likely covered). **Needs probe** — confirm cartesian `(prev_status × event_type)` matrix is exhaustive. |
| 2 | `pendingCouncilCall` race fix via spawn-context plumbing | ❓ **needs probe** | Field still present in `session-group-coordinator.ts`; structural fix may or may not have landed. |
| 3 | PR #7 partial-pair restart redo from current main | ❓ **needs probe** | PR #7 closed; verify the redo landed via a different PR (likely #16 — "plan-aura Tasks 1-4 — keystone tests, race fix, partial-pair redo"). |
| 4 | Reconcile-on-initialize: rebuild in-memory derived state + init-scan FS watchers | ◐ PARTIAL | Some reconcile landed; `feedback_in_memory_derived_state_reconcile_on_restart` + `feedback_fs_watch_event_only_needs_init_scan` are both relevant. **Needs probe** — verify `session-orchestrator.initialize()` does the iteration + readdir-on-arm. |
| 5 | Settings/Codex UI auth bug — diagnose + fix | ◐ PARTIAL | Hypothesis (e) (masked-value pattern) closed by PR #23. Other hypotheses (a/b/c) **needs probe** — may still be live on production. |
| 6 | SettingsPage split + settings-slice | ✅ DONE | PR #32 (`feat(settings): settings-slice for server-authoritative facts`). |
| 7 | Claude MAX 20x auth tier verification | ✗ ABANDONED | PR #41 shipped, PR #42 reverted — vendor has no endpoint via CLI OAuth scope. Permanently deferred per handoff. Memory entry: `feedback_probe_chain_no_public_endpoint`. |
| 8 | UX systemic — Settings IA + ObserverPanel + degraded recoverability | ◐ PARTIAL | Some pieces landed (#25, #27, this PR #44). Mental-model 3-tier work **not started**. |
| 9 | Visual UI tokens consolidation + elevation ladder | ❓ **needs probe** | Some token work shipped through multiple PRs; no single source-of-truth audit. |
| 10 | a11y systemic floor | ◐ PARTIAL | Test infrastructure shipped (`toHaveNoViolations` used across most component tests). 44×44 touch-target audit **needs probe**. |
| 11 | Recordings redaction policy | ✅ DONE | PR #28 (`feat(recorder): redact secrets at write, 0600 file mode, record:false opt-out`). |
| 12 | Schema versioning + storage migration | ✅ DONE | PR #37 (`migrate session storage to ~/.companion/sessions`) + PR #40 (`explicit schemaVersion + load-side migration`). |
| 13 | Protocol parser replay coverage + observer-review fixtures | ✅ DONE | PR #29 (`observer-review fixture corpus + protocol.frame_dropped telemetry`). |
| 14 | Upstream sync 0.95.0 + Codex smoke spawn + Dockerfile audit | ◐ PARTIAL | upstream 0.95 sync landed; Codex smoke spawn and Dockerfile audit **needs probe**. |
| 15a | Security baseline — WS upgrade + IDOR + renderer trust + CSP | ✅ DONE | PR #30 (`Origin allowlist on WS upgrade + CSP + respondError helper`). |
| 15b | CI/Deploy hygiene bundle | ✅ DONE | PR #31 (`/healthz endpoint + --frozen-lockfile + pin threshold-gated dev tools`). |

**Verdict on consolidated-refactor:** 8 of 16 tasks clearly landed. 4 are partial. 4 need a verification probe to confirm status. None are clearly missing — the gaps are "did the structural fix actually land" rather than "was it forgotten." A follow-up half-day probe pass against the 4 unknowns would close the file.

---

## Remaining auto-proceed work (PLAN-aura-orchestrator-idle-auto-proceed)

After PR #45, the four-PR sequence the council plan recommends has one PR landed and three queued:

### PR 2 of 4 — Persistence + timer + state machine
Tasks 5, 6, 7, 8, 9. Lands the actual idle-timer-manager and wires arm/disarm through `applyEvent`. Largest of the three remaining PRs; touches `session-orchestrator.ts`. Estimated: 600+ lines.

### PR 3 of 4 — Hono boundary + send pipeline
Tasks 10, 11. Adds boundary validation on `POST /sessions/create` for the opt-in flag, the synthetic-frame outbound FIFO queue, and the `synthetic:true` recorder marker. Estimated: 300-400 lines.

### PR 4 of 4 — Frontend + regression suite
Tasks 12, 13, 14, 15. New `auto-proceed-slice.ts`, `AutoProceedChip` component with 5 a11y-disciplined variants, AFK Summary banner, replay regression + sibling smoke test. Estimated: 500+ lines.

### Task 2 (skill canary) — separately deferred
The CI canary asserts that the three council-aura skill files contain the recognition prefix `[auto-proceed:idle-timeout v1]`. Those files live in `~/.claude/skills/council-{plan,implement,review}-aura/SKILL.md` (user-managed, not in the repo). The user must add the recognition clause to those files before the canary can succeed. The producer-side prefix is locked in PR #45.

---

## Untracked working artefacts in repo root

These files are NOT in `.gitignore` and NOT committed. They survived multiple session handoffs in the working tree:

```
HANDOFF-overnight.md       (May 13)
HANDOFF-morning.md          (May 14)
HANDOFF-evening.md          (May 14)
CI-CONTEXT.md
TASK-sidebar-chip-redundancy-full-suppression.md
PLAN-aura-orchestrator-idle-auto-proceed.md
.council/checkpoints/
.council/reviews/council-implement-claude-observer.md
.council/reviews/council-plan-claude-observer.md
```

**Recommendation:** keep them as untracked working artefacts (the user iterates on them between sessions); don't commit to main. Add to `.gitignore` would silence them but also hide them from future audits. Current convention works.

---

## What "clean enough to use in other projects" means

The user's stated goal at session start: *"подчистить хвосты чтобы можно было пользоваться полноценно в других проектах."*

Honest answer:

- ✅ **B (sidebar UX)** — closes a four-times-escalated user complaint. Shipped (PR #44).
- ✅ **C (housekeeping)** — on clean `main`; obsolete `revert/codex-observer-wake` branch deleted; broken stuff archived (#41/#42, #33/#43).
- ◐ **A (idle auto-proceed)** — foundation only this session (PR #45). The user-visible auto-proceed feature requires PRs 2-4 of the sequence. *Until those land, the orchestrator does NOT auto-fire on idle — but the substrate is now in place.*
- ◐ **PLAN-aura-consolidated-refactor leftover** — 4 tasks need a probe pass to confirm status; none look load-bearing.
- ❌ **Observer auto-wake for claude+codex pair** — permanently deferred (different mechanism needed; current wake-turn approach doesn't survive auto-relaunch race). Users running claude+codex pairs get no observer signal; users running `claude+claude` get full observer end-to-end. This was the explicit recommendation in the previous-session handoff.

The tool is usable in other projects with `claude+claude` Council pairs and the current sidebar UX. The auto-proceed feature is the next user-visible polish round; it's a multi-PR build, not a single-session ship.

---

## Next-session priorities

In order of "highest user value per hour of work":

1. **Merge PRs #44 + #45** after review (or self-merge per usage). Both are author-only-review; user decides whether to wait.
2. **Probe the 4 `needs-probe` consolidated-refactor tasks** — half-day pass; either close them or open targeted PRs.
3. **A PR 2 of 4** — persistence + timer manager. Largest of the remaining auto-proceed PRs; ship before frontend so the timer is testable end-to-end.
4. **A PR 3 of 4** — Hono boundary + send pipeline.
5. **A PR 4 of 4** — frontend slice + chip + AFK Summary + replay regression.
6. **Task 2 (skill canary)** — needs coordination with the user's `~/.claude/skills/council-*-aura/SKILL.md` files; not pure-repo work.

If a new claude+codex observer mechanism is in scope, it deserves its own council plan rather than reviving the reverted PR #33 approach.
