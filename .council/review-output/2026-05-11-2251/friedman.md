# Friedman (UX Quality) Review — Council Mode Phase F UI

Scope: CouncilToggle, ObserverPanel, BlockerBanner, DegradedBanner, FindingsLog, Sidebar (archive confirm + unread counter), use-browser-title-alert, observer-panel-state.

Filter: 5 screen states, never-freeze-on-input, progressive disclosure with visible triggers, disabled controls with explanation, dashboards with drill-down, AI-second / structure over chat, trust through reasoning visibility, data consistency.

Prior conventions (AP-1..3, EC-1..9) NOT re-flagged. Visual / a11y findings deferred to Saarinen and a11y auditor respectively.

---

FINDING:
- Title: No loading state for the pair-spawn window — "pairing" and "reconnecting" group statuses collapse into the same "Awaiting first checkpoint" copy as a healthy idle pair
- File: web/src/observer-panel-state.ts:22-65, web/src/components/council/ObserverPanel.tsx:53-104
- Principle: UX P2 (five screen states — loading and partial must be designed, not inherited from the idle path)
- Severity: P1
- What's wrong: `deriveObserverPanelState` branches on `group.status === "degraded"` and otherwise drops into checkpoint-derived states. The other four `SessionGroupStatus` values — `pairing`, `active`, `reconnecting`, `archived` — are all funnelled to `never-checkpointed-yet` until a checkpoint lands. A user who toggles Council Mode on, clicks Create, and watches the pair come up sees an `Awaiting first checkpoint` pill with a static muted dot for the entire spawn window (which can be 10-30s when a fresh Docker container needs to come up plus an observer subprocess). The same pill appears AFTER the pair is fully alive and sitting idle. There is no skeleton, no `Spawning observer…` copy, no spinner, and no way to know whether the silence means "spawn in progress" or "spawn complete, awaiting work." Worse: when `status === "reconnecting"` (observer briefly dropped its WebSocket but coordinator hasn't given up), the panel shows whatever pre-existing checkpoint state was last derived — masking the fact that the observer is mid-recovery. The five-state design (blank / loading / partial / error / ideal) has a hole in the loading and partial slots.
- Consequence: First-run users have no signal that pair creation is progressing; if a spawn hangs or rolls back they only learn from the absence of state change. Returning users can't tell apart "observer briefly disconnected" from "observer is healthy but quiet" — the panel claims everything is fine while the backend is mid-recovery, eroding trust the moment the user discovers the disconnect (Principle 9). The status pill also misses its biggest natural use case: a coloured spinner during the most uncertain 30 seconds of the Council session.
- Fix: Add two new variants to `ObserverPanelState` discriminated union — `spawning` (status === "pairing") and `reconnecting` (status === "reconnecting") — each with a distinct pill (spinner + cc-info palette for spawning, cc-warning for reconnecting). Insert them ABOVE `never-checkpointed-yet` in the priority ladder, BELOW `degraded`. Update the priority-ladder JSDoc and add tests for both new branches in `observer-panel-state.test.ts`. The spawning state's pill should say `Spawning observer…` with the elapsed time; the reconnecting state should say `Observer reconnecting — last checkpoint Xm ago`. Wire a Playground entry for each.

---

FINDING:
- Title: Uncontainerized Council pair archives silently — the "both halves end" preview is reachable only via the containerized / Linear-linked branches
- File: web/src/components/Sidebar.tsx:390-422, web/src/components/Sidebar.tsx:614-671
- Principle: UX P1 (destructive action without confirmation; group-action invisibility) and P2 (partial state — the council session is a NEW class of session the legacy archive path doesn't know about)
- Severity: P1
- What's wrong: `handleArchiveSession` only opens the confirm prompt when (a) a non-done Linear issue is linked or (b) the session is containerized. The `confirmArchiveId`-driven banner (which carries the new `archive-confirm-council-preview` "ends BOTH the orchestrator and the observer in this pair" microcopy) is gated behind `setConfirmArchiveId(sessionId)` at line 418-420, which only fires for containerized sessions. A plain uncontainerized Council pair takes the `doArchive(sessionId)` fast-path at line 421 — no confirm, no preview, no warning that two sessions and two LLM subprocesses are about to die in one click. The carefully-written "Archive Council pair?" microcopy added to satisfy the PLAN watchpoint is unreachable for the majority of dev-loop sessions (most users will not containerize their council pairs in v1).
- Consequence: A user mid-review on a paired session who clicks the archive icon to "tidy the sidebar" terminates both halves instantly. They lose the observer half whether they intended to or not, plus any pending findings the observer was about to emit. The archive action is destructive (subprocess kill + state mutation) but its destructive scope is hidden behind a branch the user never sees.
- Fix: In `handleArchiveSession`, check `councilInfoFor(sessionId).pairing` BEFORE the containerized branch. If the session is part of a council group, ALWAYS open `confirmArchiveId` so the council preview banner renders — independent of containerization and Linear linkage. The existing council branch of the confirm banner (lines 634-647) already says the right thing; only the routing is broken. Tests: archive an uncontainerized council session and assert `archive-confirm-council-preview` appears before `doArchive` is called.

---

FINDING:
- Title: Title-bar alert prefix `(N)` has no drill-down — clicking the tab returns to wherever the user was, not the offending group
- File: web/src/use-browser-title-alert.ts:33-64
- Principle: UX P6 (dashboards must drive action — summaries with no drill-down) and P1 (critical data hidden behind navigation)
- Severity: P2
- What's wrong: The hook decorates `document.title` with `(N) ` so a backgrounded tab signals "you have N unresolved blockers across all council groups." Useful as a notification — but `N` is a single aggregate across every group with findings. When the user clicks back into the tab, they land on whatever route the hash points to (likely home, or the currently-focused session). If their three unresolved STOPs are spread across three different groups, the title alert tells them "go look at something" but provides no path to find what. The Sidebar SessionItem badges expose per-session unread counts (good), but the user has to scan the entire sidebar to locate the offenders. There is no global "Council inbox" view, no auto-routing on click, no per-group breakdown in the title or in any header surface. This is a classic summary-without-drill-down failure: the badge creates urgency without resolving it.
- Consequence: Power users running multiple parallel council sessions get a useful "something needs attention" signal at the OS level, but resolving it costs them a full sidebar scan every time. Casual users may dismiss the prefix as cosmetic noise after the third "go find it yourself" round-trip — trust in the alert erodes (Principle 9). The feature is well-built mechanically but doesn't pull its UX weight.
- Fix: Either (a) on tab re-focus with `N > 0`, auto-route the URL hash to the group with the oldest unresolved STOP (one-click drill-down) — the hook can dispatch a navigation intent the App layer consumes; or (b) add a small Council-inbox badge to the TopBar that opens a popover listing groups with `unresolved > 0`, each row a deep-link to that group's session. Option (b) keeps the user in control; option (a) optimises for the common single-pair case. At minimum, expand the title prefix when there are >1 groups: `(2 in 1 group)` vs `(3 across 2 groups)` so the user knows whether one click resolves it.

---

FINDING:
- Title: FindingsLog rows hide evidence path + line range — once the BlockerBanner is dismissed, the user must re-open the row to recover the reasoning that grounded the STOP
- File: web/src/components/council/FindingsLog.tsx:99-151
- Principle: UX P9 (trust through reasoning visibility — AI decisions without rationale erode trust) and P1 (critical data hidden behind clicks)
- Severity: P2
- What's wrong: The BlockerBanner correctly inlines evidence_path, evidence_lines, observer model, observer provider, and phase — good reasoning visibility per PLAN T15.3. But the FindingsLog row that represents the SAME finding shows only severity dot + label + 1-line claim + relative-time stamp + (sometimes) downgraded chip. Evidence path, line range, observer model, and observer provider are not visible at the row level. The `onSelect` prop is wired through to `onOpenEvidence` (a parent-supplied handler), but a row with no `onSelect` wired falls back to a disabled button — the title attribute carries only the claim, not the evidence. After the user dismisses a STOP banner, the only way to recover "what file and line did the observer cite" is to click the row (which may or may not be wired) or to wait for a fresh STOP. The row is the SUMMARY representation of a finding; if the summary lacks the load-bearing evidence pointer, the user has to drill to the BlockerBanner-only level to re-establish trust. Plus: the downgraded chip's explanation ("evidence not on disk" vs "not in modified files") is in the `title` attribute — mouse-hover only. Keyboard users and quick-scan users never see why a STOP got downgraded.
- Consequence: A user reviewing a session's full council history (dozens of findings over a multi-phase orchestrator run) cannot scan the log for "which findings cited files I actually touched" without clicking each row. Worse, the downgrade reason — the most important piece of trust-restoration context — is hover-only, so a user who notices a downgraded chip can't tell at a glance whether to take it seriously without manual mouse work. Both gaps push the dev-tool toward "AI black box" rather than "structured reasoning surface" (the AI-second principle).
- Fix: Add a second line below the claim in `FindingRow` showing `<evidence_path>:<line-start>-<line-end>` in a muted mono font, truncated with title fallback. For downgraded rows, render the downgrade reason inline as visible text (not just tooltip): `· downgraded — evidence not on disk`. The row should grow from 1-line to 2-line for findings that carry evidence — that's still bounded and matches the dashboard-density expectation. Add a hover/focus expand affordance (chevron) that reveals observer model + provider + phase, so the row carries the full attribution chain without forcing a banner re-fire.

---

FINDING:
- Title: `claude+codex` Codex-unavailable tooltip explains WHAT is missing but not HOW to fix it; the disabled option becomes a dead end
- File: web/src/components/council/CouncilToggle.tsx:131-132, 235-247
- Principle: UX P5 (disabled controls without recovery path) and P7 (settings buried — Codex setup path is not surfaced from the create-session flow)
- Severity: P2
- What's wrong: When `codexAvailable === false`, the dropdown option for `claude+codex` is disabled with `cursor-not-allowed`, an "unavailable" chip, and a tooltip reading `"Codex CLI not detected — install or sign in."` (the default `codexUnavailableReason`). The reason text accurately states WHAT is missing but offers no path to fix it. A user who wants to try the experimental pairing is told "you can't" with no link, no docs pointer, no settings-page deep link, and no "Check again" affordance after they install. They have to leave the app, find the Codex install instructions on their own, install it, and either reload the page or hope the probe re-runs. The disabled+text pattern matches the anti-pattern Friedman calls out: a dead end with no recovery scent. The tooltip itself is `title` attribute on the button, so keyboard-only users can't read the reason at all (also a11y, deferred), and even mouse users have to hover-and-wait to see it — the reason is shown inline only when `disabled && unavailableReason` (lines 106-108), which IS visible but only inside the open dropdown, meaning the user must first click into the dropdown to learn the option is unavailable AND why.
- Consequence: Codex pairing is the experimental headline feature of this phase. A user who hits the disabled state on their first interaction concludes "Codex doesn't work" and abandons the feature; they never discover the path to enable it. The conversion funnel from "click claude+codex" to "successfully spawn a codex observer" loses every user who isn't already a Codex installer.
- Fix: When the option is disabled, render the unavailable reason as an inline subcopy (already partly done, line 106) AND add a small action button "Install Codex" that opens a docs URL in a new tab, OR an inline "Check again" button that re-runs the probe (PLAN Task 11) without a page reload. Both surfaces should be keyboard-reachable. If the probe surface is part of preflight-probe, a re-run hook is the cheaper option and lets the user resolve their setup in-place. Keep the tooltip as a redundant hover affordance but stop relying on it as the primary explanation.

---

FINDING:
- Title: Experimental "exp" chip is opaque without context — first-time users learn what "experimental" means by clicking and finding out
- File: web/src/components/council/CouncilToggle.tsx:111-115, 218-222
- Principle: UX P4 (progressive disclosure with visible, legible triggers) and P9 (AI-content labelling — "experimental" is a trust signal that should be unambiguous)
- Severity: P3
- What's wrong: The `exp` chip is a 10px uppercase mono-code abbreviation rendered as `bg-cc-info/10 text-cc-info border border-cc-info/15`. It carries no tooltip, no aria-label expansion, no inline footnote. The selected-option dropdown trigger shows it when `claude+codex` is selected, and the dropdown listbox shows it on the matching row. A first-time user has to parse the three-letter abbreviation against the `claude+codex` label and infer "this is experimental." The subcopy "Both halves are billed separately." appears below the option but doesn't address the experimental connotation at all (which is the more important signal for risk-averse users). What does "experimental" mean here? Beta-quality? Subject to break? Higher false-positive rate? Higher latency? The chip implies caution but never spells it out.
- Consequence: Users who are conservative about LLM choices skip the option without understanding the actual risk profile — leaving the experimental pairing under-exercised in real workflows and starving the feature of feedback signal. Users who are aggressive about new features pick it without understanding what they're opting into, then complain when the experimental quirks bite them. Either way, the abbreviation undersells the trust-mediation work.
- Fix: Expand `exp` to `Experimental` in the dropdown listbox row (where there is space), keep `exp` as the compact form in the trigger. Add a `title` attribute or a small info icon next to the chip that opens a one-line explanation: "Codex pairings may produce different finding shapes; we're still tuning the grounding rules." Surface this same context in the first-run microcopy when the user has the experimental pairing selected. Bonus: link the title to a one-paragraph docs page so the curious user can read more without leaving the create-session flow.

---

FINDING:
- Title: ObserverPanel header has no error / partial state — what does the user see if `findings` ever fails to load, or arrives with a parse error?
- File: web/src/components/council/ObserverPanel.tsx:141-249, web/src/observer-panel-state.ts:22-65
- Principle: UX P2 (five states — error and partial must be deliberately handled, not silently absorbed into "blank")
- Severity: P2
- What's wrong: The panel renders ObserverPanel content only when `deriveObserverPanelState` returns a non-null state, otherwise nulls out. There is no error state — no path that says "the observer's review file was malformed" or "the WebSocket dropped a `observer_review` message." The grounding pipeline server-side downgrades STOPs and emits a `wasDowngraded` chip in the row, but if the orchestrator handler ever rejects a review payload (schema violation, parse error, missing checkpoint), nothing surfaces to the user — they just stop seeing findings. Equivalently, if the group's findings map has a stale entry (e.g. dismissedStopIds includes ids that no longer exist after a re-archive), the count derivation silently drifts. There is no `partial` state at all: the panel either shows the perfect-world ideal (sleeping/reviewing/blocker-found/degraded) or shows nothing.
- Consequence: A subtle failure mode — observer emits a review, server rejects it on grounding-pre-parse, browser never sees it — is invisible to the user. They believe the observer reviewed their work and found nothing; in fact the review never made it through. Trust evaporates the moment they discover this asymmetry (Principle 9). Reviewing a session post-hoc, they can't tell apart "no findings emitted" from "findings emitted but dropped."
- Fix: Add an `error` variant to `ObserverPanelState` for cases where the most recent review handler rejected the payload, and an info banner in the panel reading "Last review skipped — schema mismatch (see logs)" with a "Retry" affordance when a re-emission is possible. Wire the server-side `handleCouncilReview` error path through a new `BrowserIncomingMessage` variant (`observer_review_rejected` or similar) so the client can render the failure. Without this, the panel's silence is indistinguishable from success — the very trust-erosion pattern Friedman flags.

---

FINDING:
- Title: DegradedBanner's orchestrator-died microcopy references an "end the group" action that does not exist in the UI
- File: web/src/components/council/DegradedBanner.tsx:66-69, 102-122
- Principle: UX P5 (instructions must point to real controls) and P9 (microcopy that names absent controls breaks trust)
- Severity: P3
- What's wrong: When `deadRole === "primary"` (orchestrator died), the detail copy reads: `"The observer is alive but the orchestrator died. This is an unusual state — respawn or end the group."` But the banner only renders two buttons: `Respawn primary` and `Continue solo`. There is no `End group` button anywhere in this surface. The user is told to take an action that doesn't exist; the closest is presumably the sidebar archive flow, which lives outside this banner and isn't called out. "Continue solo" with the orchestrator dead is also semantically odd — the observer can't continue solo without an orchestrator to observe; what does that even do?
- Consequence: A user staring at a real degraded-orchestrator condition reads "respawn or end the group", scans for an End button, finds nothing, scans again, and gives up — either clicking Respawn without confidence or abandoning the session. The microcopy adds confusion at the exact moment the user needs clarity. Trust slips.
- Fix: Either (a) rewrite the orchestrator-dead microcopy to name only the available actions: `"The observer is alive but the orchestrator died. Respawn the orchestrator to resume, or archive this group from the sidebar."` — and explicitly link "archive" to the sidebar surface; or (b) add a third button `End group` (or `Archive group`) to the banner that routes through `api.archiveSession` for both halves. Option (a) is the smaller change; option (b) makes the banner self-contained. In either case, drop "Continue solo" for the orchestrator-dead case since the semantic doesn't hold — the observer has nothing to observe without its peer.

---

FINDING:
- Title: First-run microcopy in ObserverPanel is one line — does not explain what STOP / WARN / NOTE / INFO mean, or when downgrades happen
- File: web/src/components/council/ObserverPanel.tsx:222-235
- Principle: UX P7 (respect user expertise — low/medium/high paths) and P2 (blank state must explain "what this view shows, why it's empty, what creates the first one")
- Severity: P3
- What's wrong: The dismissable first-run hint reads: `"This panel shows a second AI reviewing the orchestrator's work. It only interrupts you for blockers."` Single sentence, single Got-it button. That's adequate for the medium-expertise user who already knows what a "checkpoint" is and what a "blocker" looks like. But the panel renders four severity levels (STOP / WARN / NOTE / INFO) with distinct dots, downgrade chips, and dismiss semantics — none of which the first-run hint addresses. A new user dismissing the hint loses access to it permanently (per-user localStorage flag) and is then expected to infer the severity model from in-context findings. There is no help icon, no docs link, no "What do these severities mean?" surface after dismiss.
- Consequence: Users hit Got-it after reading one sentence, then encounter their first `WARN` finding and have no anchor for whether it's safe to ignore or requires a stop-and-fix. They learn by trial and error, which means real production bugs may get categorised as WARN noise and skipped over (Principle 9 trust drift). The opposite happens too — NOTEs get over-treated as blockers because the user doesn't know NOTE is the lowest severity.
- Fix: Either (a) expand the first-run microcopy into a 3-4 line block that names the severities and what action each implies; or (b) keep the one-line hint but add a persistent "?" affordance in the panel header that re-opens a help popover on demand. Option (b) is the more durable answer because it serves the user at the moment of confusion, not at session start. Pair with a small severity legend at the top of the FindingsLog when there are >0 findings ("STOP — blocks merge · WARN — needs review · NOTE — context only · INFO — observation").

---

FINDING:
- Title: Cmd/Ctrl+Shift+B blocker-focus shortcut is undiscoverable — no surfacing in the BlockerBanner itself, no hint in the first-run microcopy
- File: web/src/use-council-shortcuts.ts (referenced), web/src/components/council/BlockerBanner.tsx:91-120
- Principle: UX P7 (respect user expertise — keyboard shortcuts on frequent actions; but a shortcut nobody knows is a shortcut for no-one)
- Severity: P3
- What's wrong: A keyboard shortcut to focus the blocker banner's primary action is implemented (`data-council-blocker-primary` attribute + `Cmd/Ctrl+Shift+B` handler in use-council-shortcuts). This is good — it satisfies the expertise-affordance principle. But there is no surfacing of this shortcut anywhere a user would discover it: no hint badge on the BlockerBanner, no entry in the first-run microcopy, no command-palette surface, no help page. A power user who knows the convention from other dev tools might guess and try; everyone else never finds it. The shortcut is effectively dead code for the median user.
- Consequence: Time saved goes to ~0% of users. The feature exists but earns no return on the engineering investment. Worse, when an experienced user discovers the shortcut by accident, they wonder what other shortcuts exist and have no way to find them — leading to repeated "is there a shortcut for this?" friction.
- Fix: Add a small hint to the BlockerBanner: a muted-text affordance like `⌘⇧B to focus` next to the primary action button (or a tooltip on hover). At minimum, list all council-mode shortcuts in the first-run microcopy or in a help popover (per the prior finding). If a command-palette is on the roadmap, the shortcuts surface there naturally; until then, in-context hint is the cheapest discoverable surface.

---

FINDING:
- Title: Status pill "Reviewing" has no escalation timeout — a stuck observer review animates the same dot indefinitely
- File: web/src/components/council/ObserverPanel.tsx:71-84, web/src/observer-panel-state.ts:48-54
- Principle: UX P6 (no data freshness indicator on streaming/long-running state) and P9 (no liveness signal during indeterminate wait)
- Severity: P3
- What's wrong: When `observerReviewing === true`, the StatusPill animates a pulsing cc-primary dot with the phase name and the timestamp of when reviewing began. There's no escalation: if the observer subprocess hangs (LLM API stuck, network failure, container deadlock), the pill keeps pulsing forever with no warning. The "reviewing since 14m ago" string will grow without bound, but there is no transition from `reviewing` to `stuck` or `taking longer than expected`. A user staring at "reviewing · phase-2 · 14m ago" has no way to know whether the observer is slow or dead.
- Consequence: Users wait through indeterminate hangs without a prompt to take action (kill + respawn). Patient users tolerate it; impatient users assume the system is broken and reload the page, losing context. Either path costs the user.
- Fix: Add a derived "stuck" sub-state when `reviewing` has been active longer than a threshold (configurable, default 90s). The pill should escalate visually (cc-warning palette + "Reviewing — taking longer than expected") and offer a one-click "Skip this review" or "Restart observer" affordance. Or, more conservatively, surface an inline warning in the panel header below the pill at the 90s mark without changing the pill itself. The principle is: indeterminate waits need a visible deadline.

---

## Summary

11 UX findings — 2 P1, 5 P2, 4 P3.

Hottest items:
- **P1-1 (Loading state gap):** spawn / reconnecting states collapse into idle pill — the most uncertain 30 seconds of a council session has no visible loading affordance.
- **P1-2 (Silent group archive):** uncontainerized council pairs bypass the carefully-written "ends both halves" preview — the destructive group action lacks confirmation.

P2 cluster centres on **trust through visible reasoning** (findings rows lack evidence inline; first-run microcopy and Codex-unavailable affordances are dead ends; panel has no error state). P3s are polish — experimental chip clarity, shortcut discoverability, microcopy precision in DegradedBanner, stuck-review escalation.

The Council Mode UI is structurally strong — the five-state pill is a good discriminated union, channel separation (blocker vs degraded) is enforced, AI-content is structured (findings) rather than chat-conversational. The remaining gaps cluster around the seams where the priority ladder meets reality (pairing/reconnecting/error fall through), and around where destructive group actions intersect legacy single-session affordances (sidebar archive).
