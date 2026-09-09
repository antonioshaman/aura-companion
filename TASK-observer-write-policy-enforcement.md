# TASK: Enforce `assertObserverWriteAllowed` at the observer permission gate

**Origin:** Council review 2026-09-08 (`.council/review-output/2026-09-08-2230/FINAL-REVIEW.md`),
finding #16 (Chair cross-cut, prompted by Hunt P1). Deferred from the follow-up
fix PR because it changes the observer permission pipeline, not the reviewed diff.

## Problem

The observer's review-file ownership is proven **only** by the self-reported
`session_group_id` the observer LLM writes into its review. `handleCouncilReview`
and the deadline rescan now reject a review whose `session_group_id` doesn't
match the watcher's group (got-051), and #1 gives each pair a group-scoped
on-disk filename so *accidental* collisions are gone. Neither stops a
**deliberately steered** observer: every observer is granted `Write` for any
path under its workspace cwd (`observer-permissions.ts`), which is the same
shared directory holding every sibling pair's `.council/` files. A
prompt-injected observer (its whole job is reading untrusted diffs) can read a
sibling checkpoint in plaintext, learn the sibling's real `session_group_id`
and a real modified-file path, and write a review that passes the ownership
guard *and* the STOP-grounding gate — injecting a fabricated grounded STOP into
another pair's UI, attributed in the audit log to the victim group.

`assertObserverWriteAllowed(path, root)` (`observer-write-policy.ts`) exists to
confine the observer's writes, but has **zero production call sites** — it is
defined and unit-tested, never wired in.

## Scope

1. Wire `assertObserverWriteAllowed` into the observer's write path so an
   observer can only write its OWN group's review file
   (`<phase>-<session_group_id>-<provider>-observer.md`, per #1) and nothing
   else under `.council/`. The group id must come from the **server's** record
   of which group this observer session belongs to, never from the file's
   self-reported field.
2. Decide the enforcement layer: CLI permission profile at spawn
   (`applyCouncilObserverSpawnConfig`) vs. a server-side post-write validation
   that quarantines/ignores out-of-policy writes. The spawn-time profile is the
   stronger boundary (the write never happens) but depends on the CLI honoring
   a path-scoped Write allow-list; confirm both Claude Code and Codex support
   that granularity, else fall back to server-side rejection keyed on the
   server's group→session map.
3. Add a test: an observer for group A that writes group B's review filename
   (with B's real `session_group_id`) is rejected/ignored, and B's own review
   is unaffected.

## Not in scope

The accidental-collision path (#1, shipped) and the ingestion guard (got-051,
shipped). This task is specifically the **adversarial** boundary.
