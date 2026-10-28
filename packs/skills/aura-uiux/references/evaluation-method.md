# Evaluation method — heuristic audits and task-based tests

Platform: all

## When this applies

An audit, critique or design review must produce findings that someone else can rank and act on, or a team wants to watch real users try the product. Use it with the audit and critique skills: they say what to look at; this file says how to record and rank it.

## Addendum (2026-10-28) — one finding, five fields

Source: nielsen-heuristics, nngroup-severity

Every finding carries all five fields; a finding missing one is a note, not a finding.

1. **Heuristic.** One of Nielsen's ten: visibility of system status; match between the system and the real world; user control and freedom; consistency and standards; error prevention; recognition rather than recall; flexibility and efficiency of use; aesthetic and minimalist design; helping users recognise, diagnose and recover from errors; help and documentation.
2. **Severity 0–4.** 0 not a problem; 1 cosmetic, fix if time allows; 2 minor, low priority; 3 major, important to fix; 4 catastrophe, fix before release.
3. **Evidence.** The screen, state and element, plus what the user sees or cannot do: a selector, a screenshot reference or the exact copy. "Feels cluttered" is not evidence.
4. **Fix.** The smallest change that removes the problem, stated so it can be checked.
5. **Platform.** web, telegram-mini-app, ios or android, because the fix often differs per host.

Rate severity from three factors together: how often the problem occurs, how badly it blocks the user when it does (impact), and whether users hit it again and again once they know it (persistence). Rate independently first when several reviewers audit, then merge; a single reviewer finds only part of the problems.

In a Council review the scales map one-to-one: 4 → P1, 3 → P2, 1–2 → P3, 0 → drop it.

## Addendum (2026-10-28) — task-based usability test

Source: nngroup-usability-testing, govuk-service-manual-research

1. **Goal.** Write down the one decision the test informs (for example, "can a new user top up without help?").
2. **Participants.** Five people from the real audience usually expose most of the major problems in one flow; test again after fixing instead of testing more people once. Include people who use assistive technology or a large text size when the flow must work for them.
3. **Tasks.** Three to five realistic tasks phrased as goals, not instructions: "You want to pay for last month's order", not "Click Pay". Do not use interface words in the task.
4. **Session.** The facilitator asks the participant to think aloud, does not help or lead, and answers questions with questions. Note where they hesitate, backtrack, misread or give up.
5. **Record.** For each task: success, partial or fail; time on task; and every problem as a finding with the five fields above.
6. **Report.** Rank findings by severity, show the evidence (quotes, clips), and propose fixes. Re-test the fixed flow.

## Source conflicts

None between the sources used here.
