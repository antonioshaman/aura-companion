# Observer Liveness + Backoff Directive

**From:** orchestrator (session `5d77c644-2c15-49a1-aad6-c4b8919db407`, group `grp_e81a5ef8c55a741db574fbe59f7fb1a7`)
**To:** observer (session `df4806c6-34cb-4838-98b7-ea5962d997ac`)
**Emitted at:** 2026-05-15T01:39:08Z
**Phase:** liveness-ping (informational, not a Carmack-Council phase)

## Purpose

This is a **liveness ping** and an **advisory backoff directive**, not a
review request. The orchestrator confirms two-way connectivity and signals
expected silence: the orchestrator will be working on PR-integration
subsections (Task 11 wire-up) for an extended period without emitting new
council-implement checkpoints.

## Acknowledgment requested

On this single wake, emit exactly ONE review file under the contract
(`<phase>-<provider>-observer.md` → here, `liveness-ping-claude-observer.md`)
with:

- `findings[0]`: severity `INFO`, `claim` echoing receipt of this directive
  with the directive emitted_at timestamp, `evidence_path` = this file
  (`aura-observer-liveness-directive-2026-05-15.md`),
  `evidence_lines: [1, 1]`, `confidence: "high"`.
- If you observe any contract violation in the directive itself (e.g.
  malformed timestamp, wrong group id), record it as a second `WARN`
  finding citing the same file.

Do NOT browse the rest of the tree. Do NOT review the open task files
(`HANDOFF-task11-wireup.md`, `PLAN-tasks-10-11-boundary-and-send-pipeline.md`,
etc.) — they will appear in a proper council-implement checkpoint after
the integration PR's first commit.

## Advisory backoff cadence (server-enforced, not observer-enforced)

The orchestrator acknowledges the following operational reality:

- Your **failsafe self-poll** (`.council/prompts/observer-system.md` →
  Failsafe section) is fixed at 5 minutes and is **server-scheduled**, not
  observer-loop-controlled. You cannot extend or compress it from inside
  a `-p` invocation; the scheduler in `session-orchestrator.ts` is the
  real authority.
- The orchestrator's desired cadence for THIS PR window (Task 11 wire-up
  integration commit) is: **back off from 5 min to longer intervals if no
  new orchestrator checkpoint lands.** Proposed ladder, advisory only:
    1. 5 min — initial (current behaviour)
    2. 10 min — after 1 empty poll (no new checkpoint to review)
    3. 20 min — after 2 empty polls
    4. 40 min — after 3 empty polls
    5. 60 min — floor (don't back off further)
- **Runtime enforcement of this ladder requires a server-side change**
  (`session-orchestrator.scanForMissedObserverWakes` or the failsafe
  scheduler in `applyCouncilObserverSpawnConfig`'s spawned tick loop).
  The orchestrator is opening that as a separate task — out of scope for
  the current Task 11 wire-up PR.

You, the observer, are not asked to enforce this ladder. You are asked to
**acknowledge it** in your INFO finding so the orchestrator's review-
watcher fan-out leaves a paper trail in the journalctl
`observer.invocation.completed` log line.

## Producer-side signal

Expected next orchestrator checkpoint: **not before 2026-05-15T03:00:00Z**
(roughly 80 min from this directive). Anything sooner is either a typo
checkpoint or a scope change.

## Out of scope this turn

- The 4 open P1 findings in repo root (`feedback_aura_*`) — they each
  ship as separate hotfix branches and will not be checkpointed through
  this group.
- The original archived pair `grp_4f15985bfcc15b0661e6fcbbe71daab8` —
  ignore.

## End directive

Single review file out. Exit on completion.
