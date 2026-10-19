# Vitaly Friedman — UX quality recommendations
Feature: Diagnostics page (#/diagnostics) + background KB / memory analyzer, v1.
Reference: quality-ux.md (Carmack × Friedman). Scope: UX patterns, IA, interaction only.

RECOMMENDATION 1
- Title: Fix the card order to the operator's 10-second scan, and lead every card with a one-line verdict
- AC defended: AC1, AC2, AC3 (JS-1)
- Principle: 6 — Dashboards and lists drive action
- What to get right: The page must answer "is anything wrong?" before the operator reads a single row, so the cards are ordered by urgency and never reflow: Backend, Pairs, Drift (24h), Context advisory, Usage upstream, Knowledge base, KB decisions, Memory report. Each card opens with a single verdict line in plain words ("2 pairs live, 1 observer silent 20m", "3 drift events in the last hour", "upstream: KV quota exceeded since 14:02") followed by its last-updated time; the detail rows come after. A card that has nothing to report says so in that same verdict line rather than collapsing to zero height.
- Risk if skipped: The operator scans eight blocks of numbers looking for the problem, which is exactly the journalctl experience the page exists to replace.
- Depends on: —

RECOMMENDATION 2
- Title: Every card implements all five states independently, with "source unavailable since <time>" as a first-class state
- AC defended: AC3; Must (spec §5)
- Principle: 2 — Design all five screen states
- What to get right: Each card has its own blank ("no drift events since the server started at <time>"), loading (skeleton of the rows, not a page spinner), partial (some rows failed to resolve, say which), error ("source unavailable since <time>: <reason>") and ideal state, and no card is allowed to render nothing. The unavailable state names the source (usage worker, session store, kb-health reader, state machine) and the reason class the server returned, and it sits exactly where the data would sit so the operator sees absence as a fact, not as a layout gap. One failed card never blanks the others — the overview endpoint can come back with a per-card error and the page still renders the other seven.
- Risk if skipped: The GlobalUsageBadge failure mode repeats — the thing that disappears is the thing that is broken, and nobody can tell.
- Depends on: —

RECOMMENDATION 3
- Title: Distinguish "stale but known" from "unavailable", and never blank a card on refresh
- AC defended: AC3; Must (spec §5)
- Principle: 3 — Never freeze the interface on a single input; 9 — Trust compounds slowly
- What to get right: When a source fails after it has succeeded once, the card keeps the last good values dimmed with "last successful response <time>" above the unavailable notice, so the operator still knows what the world looked like a minute ago. Automatic refresh of the overview shows a quiet "updating…" marker on the page header and replaces values in place; it must never drop a card back to its loading skeleton. The Backend card states the snapshot age explicitly ("snapshot taken 3 min ago, next in 2 min") because the operator otherwise cannot tell a frozen number from a stable one.
- Risk if skipped: The page flickers between data and spinners every refresh, and a momentary upstream hiccup wipes the only evidence the operator had.
- Depends on: 2

RECOMMENDATION 4
- Title: The Pairs card shows raw identity and raw liveness evidence per role, not a traffic light alone
- AC defended: AC1
- Principle: 1 — Structure complexity, don't simplify away user value; 9 — Reasoning visibility
- What to get right: Each pair is one row with both roles visible: role, full sessionId (monospace, copy-on-click), backendType, the group status word exactly as the state machine names it, pid, last inbound frame as both relative age and absolute time, observer turn state, and last checkpoint / last wake time. "Silent 20m" is a derived label; it must sit next to the number it was derived from (last frame 14:02:11, threshold 15 min) so the operator can disagree with it. Each row links to the session itself for drill-down. A group whose status the state machine calls not operable is shown with that status, never hidden from the list as "not live".
- Risk if skipped: The operator sees "observer unhealthy", opens journalctl to find out which session and why, and the page has failed JS-1.
- Depends on: 1

RECOMMENDATION 5
- Title: Drift feed — last hour open, remaining 24h behind a visible, counted trigger, newest first
- AC defended: AC2
- Principle: 4 — Progressive disclosure with visible triggers
- What to get right: The card renders every event from the last hour expanded, then a single visible control reading "Show 17 earlier events (1–24h)" that expands in place; never a hidden tab, never a modal. Each row shows the event name verbatim as the log emits it (silent_stdio_drift.withheld_open_tool_call, not a friendly paraphrase), sessionId, absolute time plus relative age, reason, and the numeric fields that justified it (mtime delta, last frame age, undelivered records, CLI version) on a second line. Group consecutive events for the same session visually but keep them as separate rows so "detected, then withheld, then relaunch_failed" reads as a story.
- Risk if skipped: Either the hour's events are buried under a day of noise, or the day's history is unreachable when the operator needs to see "did this also happen yesterday".
- Depends on: 1

RECOMMENDATION 6
- Title: Be honest about the ring's memory: the feed begins at server start and is bounded
- AC defended: AC2
- Principle: 9 — Trust compounds slowly, breaks fast
- What to get right: The in-memory ring loses everything on a restart and drops the oldest entries when full, so the card's blank and ideal states both carry the window they cover: "events since server start <time>" and, when the ring has wrapped, "oldest retained event <time>; earlier events are only in journalctl". An empty feed right after a restart must say that explicitly rather than claiming a quiet night.
- Risk if skipped: After a restart the operator reads "no drift events in 24h" as good news while the kill that caused the restart is the one thing not shown.
- Depends on: 5

RECOMMENDATION 7
- Title: The Usage card and the sidebar badge must tell the same story
- AC defended: AC3
- Principle: 9 — Inconsistent data across views
- What to get right: The Usage card has a fixed vocabulary of states — OK, KV quota exceeded, OAuth expired, upstream unreachable, unknown — each with "since <time>" and "last successful response <time>", read from the same server-side status the badge proxy records. The badge's current behaviour (vanish on any failure) must at minimum not contradict the card: while the card says "KV quota exceeded since 14:02", the badge's absence is explained by a tooltip or the badge shows a muted "usage unavailable" mark that links to #/diagnostics. The card's copy names the fix path for each state in one line (quota: resets at <time>; OAuth: re-login on the host).
- Risk if skipped: Two surfaces disagree about the same upstream and the operator trusts neither.
- Depends on: 2

RECOMMENDATION 8
- Title: Accumulation progress as three independent gauges with the "any one of" rule stated
- AC defended: AC4
- Principle: 6 — Dashboards create understanding
- What to get right: The KB card shows the three counters as three labelled lines — "entries 3 / 10", "sessions 7 / 25", "age 2 / 14 days" — each with a small progress bar and the threshold value, and a sentence above them that explains the rule: "An analysis starts when any one of these reaches its threshold; next check at <time>". "Due in ≤12 days" is the age gauge's remainder and should be shown as that, not as a separate mysterious number. Beside the gauges: last run time, what triggered it (entries / sessions / age / manual), and a link to the thresholds in Settings ("thresholds 10 · 25 · 14 — edit").
- Risk if skipped: "3/10 · 7/25 · due in ≤12 days" on one line is a riddle; the operator cannot tell whether all three must be met or any one.
- Depends on: 18

RECOMMENDATION 9
- Title: "Run analysis now" never freezes the page and reports progress it can actually know
- AC defended: AC6
- Principle: 3 — Never freeze the interface on a single input; 5 — Disabled controls
- What to get right: Pressing the button immediately switches it to "running… started 14:05 (12 s)" with an elapsed counter, the rest of the page stays interactive, and the card polls the latest endpoint until inFlight clears, then replaces the findings in place with a "new report <time>" marker. A 409 is shown as the identical running state with "already running since <time> (started by schedule)" rather than as an error toast, because from the operator's point of view the outcome is the same. If the run fails, the button returns to enabled and the card shows the failure reason and keeps the previous report visible. Navigating away and back must land on the same running state.
- Risk if skipped: The operator double-clicks, sees a red 409, and concludes the feature is broken when it is working exactly as designed.
- Depends on: 2

RECOMMENDATION 10
- Title: Every disabled control carries its reason in visible text beside it
- AC defended: AC6, AC9
- Principle: 5 — Disabled controls are a dead end
- What to get right: There are at least five legitimate disabled states on this page — analysis running, settings still loading, memory report flag off, no report yet to decide on, decision already posted for this entry — and each needs a short adjacent sentence, not a tooltip only: "Memory report is off — enable it in Settings → Session defaults → Knowledge analysis", "No report yet — the first analysis runs when a threshold is reached, or run it now". The threshold fields in Settings are never disabled for validation; they validate on blur with the error next to the field.
- Risk if skipped: A greyed button with no explanation is the operator's cue to open journalctl, which the page exists to prevent.
- Depends on: 9

RECOMMENDATION 11
- Title: A decision card shows the signal, the criterion, the numbers and the whole entry — enough to decide in seconds
- AC defended: AC7
- Principle: 9 — Reasoning visibility; 1 — Structure complexity
- What to get right: Each finding card leads with the signal name as a badge and the criterion in words with the entry's actual numbers filled in: "never-used: usageCount 0, not in usage.log, created 2026-07-02 (109 days ≥ 30)". Below it the entry in full — id, type, fact text untruncated, recommendation, tags, confidence, provenance source and date, usage and helpful counts, affected files each marked as present or missing in the repo. The analyzer's proposed decision is visibly highlighted as a proposal ("suggested: archive") but no button is pre-selected. Cards with several signals on one entry show all signals on that one card rather than repeating the entry.
- Risk if skipped: The operator cannot judge "never used" without knowing the rule, and either rubber-stamps everything or trusts nothing.
- Depends on: —

RECOMMENDATION 12
- Title: Duplicates are shown side by side with the matching parts emphasised, and the merge direction is explicit
- AC defended: AC7
- Principle: 1 — Don't hide critical data; 9 — Reasoning visibility
- What to get right: A duplicate finding is one card holding both entries in two columns — fact beside fact, tags beside tags, with the shared tokens emphasised and the similarity score stated ("Jaccard 0.86 on fact + tags"; or "identical normalised fact"). The merge control forces a direction: the operator picks which entry survives ("mark got-040 to merge into got-041" and the reverse are two distinct choices), and the card restates the choice in words before posting. Keep and Archive on a duplicate pair apply per entry, so each column has its own Keep / Archive and the pair has one Merge.
- Risk if skipped: The operator archives the wrong twin, or marks a merge with no idea which text is meant to survive.
- Depends on: 11

RECOMMENDATION 13
- Title: Each button states its consequence in one line, and the labels say what the action really does
- AC defended: AC7, AC8
- Principle: 9 — Trust compounds slowly, breaks fast; 8 — Structure beats conversation
- What to get right: Under the three buttons the card shows the consequence copy: Keep — "marks reviewed; hidden from reports for 90 days unless a new signal appears"; Archive — "moves this line to .agents/knowledge/archive/gotchas.jsonl; nothing is deleted; restore by moving it back"; Merge — labelled "Mark for merge", with "only marks the pair and adds a task to the report; no text is changed". After a decision the card does not vanish: it collapses to a one-line decided row ("got-017 — archived 14:07 → archive/gotchas.jsonl") with the file path shown, so the operator sees the proof of what happened and the list does not jump under the cursor.
- Risk if skipped: "Merge" reads as "merge" and the operator expects merged text; "Archive" reads as delete and the operator hesitates on every card.
- Depends on: 11

RECOMMENDATION 14
- Title: Decisions are submitted per card with per-card pending state; Keep and Seen may be optimistic, Archive may not
- AC defended: AC8
- Principle: 3 — No optimistic UI for safe actions (and none for unsafe ones); 2 — Partial-state handling
- What to get right: Keep and Mark-as-seen change nothing on disk except the decisions log, so they collapse the card immediately and reconcile on the response. Archive touches a KB file, so its card shows "archiving…" on that card only until the server confirms the move, then shows the destination path. A failure on one card (400 because the report changed underneath, or a write error) stays on that card with its reason and a retry, while other cards remain decidable. A running tally in the card header ("4 of 12 decided") gives the two-minute review a sense of progress.
- Risk if skipped: One failed archive blocks the whole review, or an optimistic "archived" is shown for a line that never moved.
- Depends on: 13

RECOMMENDATION 15
- Title: Tell the operator when the report no longer matches the KB
- AC defended: AC5, AC7
- Principle: 9 — Inconsistent data across views
- What to get right: The decisions card header shows "report from <time>, based on 152 entries" and, when the KB has changed since (the accumulation counters are already available), a banner "KB changed since this report: 4 entries added or edited — findings may be stale" with the Run-now button beside it. A decision posted against an entry that has since changed is answered by the server with a reason, and the card shows that reason rather than a generic failure.
- Risk if skipped: The operator archives an entry based on a two-week-old finding that a recent edit already fixed.
- Depends on: 8, 14

RECOMMENDATION 16
- Title: Heuristic signals are framed as "check manually" and never pre-suggest Archive
- AC defended: AC7
- Principle: 9 — No reasoning visibility for AI decisions (applies equally to heuristics)
- What to get right: Contradiction and bitter-pill findings are heuristics by the spec's own admission; their cards carry a "heuristic — verify" badge, show the matched evidence verbatim (the two opposing phrases and the overlapping affected files; the provenance date versus the current CLI major version) and suggest no decision. Keep and Archive remain available but with no highlighted suggestion, so the analyzer's confidence is readable from the card itself.
- Risk if skipped: A string match between "never" and "always" is treated as a verdict, and the first wrong archive costs the analyzer its credibility for good.
- Depends on: 11

RECOMMENDATION 17
- Title: The memory card is framed as read-only from the first line, and its disabled state explains itself
- AC defended: AC9
- Principle: 5 — Disabled controls; 9 — Trust
- What to get right: The card title carries the framing ("Memory report — read-only; Aura never writes to memory files") so nobody looks for an Archive button; each finding shows the file path for the operator to open by hand and the matching evidence (duplicate description pair, dead path, age in days), and offers only "Mark as seen" with its consequence ("records a line in decisions.jsonl; the file is untouched"). When the flag is off, the card still renders with a sentence pointing to the Settings toggle; when on, the manual "Run memory report" button states the cost ("reads ~470 files, ~2 MB; runs only when you press this") and follows the same running-state rules as the KB run.
- Risk if skipped: The operator presses a button expecting a fix, nothing changes in the memory dir, and the read-only promise reads as a bug.
- Depends on: 9, 10

RECOMMENDATION 18
- Title: Thresholds live in Settings → Session defaults as a "Knowledge analysis" sub-block, cross-linked from the KB card
- AC defended: AC4; Must (spec §5)
- Principle: 7 — Settings buried without clear path
- What to get right: The three numeric fields and the memory-report toggle sit together in a titled sub-block directly under the existing "Load knowledge base at session start" switch, each field showing its unit, its default and the rule sentence ("an analysis starts when any one threshold is reached"). The KB card on the diagnostics page links straight to that block, and the block links back to #/diagnostics, so the operator never has to remember which of ten Settings sections holds them. Values validate on blur with a visible range (minimums of 1 entry, 1 session, 1 day), never on each keystroke.
- Risk if skipped: Thresholds end up in a "General" or "Advanced" section nobody associates with the KB, and the defaults are effectively hard-coded.
- Depends on: —

RECOMMENDATION 19
- Title: Reachable in one click from the sidebar and deep-linkable per card
- AC defended: AC1, AC2, AC3 (JS-1)
- Principle: 4 — Visible triggers; 7 — Respect expertise
- What to get right: "Diagnostics" is a Workspace sidebar item beside Sweep, and each card has a stable anchor so a support note can say "open #/diagnostics and look at the Drift card" and land there. The usage badge's unavailable state (Recommendation 7) and any future "observer missing" hint are natural entry points to the page and should link to the matching card.
- Risk if skipped: The page exists but the operator still reaches for journalctl because the route is a thing you have to know.
- Depends on: 7
