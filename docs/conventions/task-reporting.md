# Task reporting discipline (keeps the Task Panel honest)

> Moved out of `CLAUDE.md` in P2/A3 (2026-09-28). `CLAUDE.md` links here with one line;
> this file is loaded on demand, not on every session start.


The Task Panel is a **mirror of your last `TodoWrite`**, never live ground truth — it
cannot know your progress until you emit a `TodoWrite`. The staleness badge is designed so
the **UI carries the honesty, not your diligence**: it describes the reporter's cadence
neutrally rather than implying you did something wrong. Its states:

- **`Updated {ago}`** / **`Idle · list last updated {ago}`** — neutral, muted. A recent or
  simply-old snapshot.
- **`Agent active · updated {ago}`** — muted. The session is running; the list is either
  fresh, or there is an `in_progress` task that already explains what's in flight. A single
  long step (big build, long test) will NOT trip a warning — there is no transition to emit,
  so staleness alone is not treated as fault.
- **`Agent active · list may be behind · {ago}`** — amber, the only warning state. Reserved
  for the one case that is *provably* behind: running, stale (>5 min), and **no** `in_progress`
  task to account for the silence.

Because the amber state is gated on evidence (not flat wall-clock age), it does not cry wolf
during healthy long-running work. Calling `TodoWrite` on every task-state transition — as
soon as a task starts and the moment it completes — is still the right habit (it keeps the
panel maximally useful), but it is a **nudge, not an SLA**: the badge stays truthful whether
or not you are perfectly diligent. This is a reporting-cadence convention; the UI surfaces
cadence honestly, it does not manufacture updates.
