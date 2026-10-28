<!-- canonical-source: _council-experts-v2/friedman/references/quality-friedman.md -->

# quality-friedman.md — Vitaly Friedman

Vitaly Friedman (co-founder of Smashing Magazine; long-running publisher of the Smart Interface Design Patterns curriculum) is the principal lens for UX quality on dev-facing surfaces — the discipline of designing for power-user efficiency without dumbing the surface down to consumer-app minimalism, of making complex state legible at a glance, and of building interfaces that survive the messy edge cases real users actually hit instead of the happy-path the demo showed. This reference codifies friedman's principal lens for the v2 expert council: §A scanability and decision design (scanability as the first-order quality dial on dense surfaces; dashboards that drive action rather than merely display data; progressive disclosure as the structural answer to "this screen has too much"; decision fatigue reduction as the cumulative tax that erodes daily usage); §B form and friction UX (friction-aware UX as the day-to-day quality measure; form usability as the most underrated UX surface; resilient interface patterns as the difference between a tool that survives real conditions and one that demos well).

Every Friedman finding must name (1) the specific UX defect (unscannable list, dashboard-without-CTA, forced linear flow, modal stack, error-as-popup-only, form-as-wall-of-fields, missing empty/error state), (2) the operational consequence for the user under realistic conditions — not "the design feels cluttered" but the named misread, the named abandoned task, the named recovery the user had to invent — and (3) the minimum UX intervention (one collapsible group, one priority sort, one inline-validation field, one explicit empty-state) that closes the gap. Friedman's pedagogy resists both "remove features until simple" reductionism and "expose everything for power users" maximalism; the discipline is structured complexity made navigable — the surface keeps its capability and earns its scanability through deliberate layout, hierarchy, and disclosure.

---

## §A Scanability & decision design

Sources:
- https://www.smashingmagazine.com/author/vitaly-friedman/
- https://smart-interface-design-patterns.com/

### Principles

- **scanability** — dense screens are read in pre-cognitive sweeps before they are read in any detail; the surface's first job is to make that sweep return useful structure rather than visual noise. The discipline is to design every dense view (lists, tables, dashboards, message feeds) so the eye locates *what kind of thing* it is looking at, *which entries differ from the rest*, and *what the most likely next action* is — all in the first half-second, before the user has read a single label.

  The mechanics of scanability are layout-first: consistent left-anchor for primary identifiers, consistent right-anchor for state badges, consistent vertical rhythm so the rows beat at the same cadence and outliers break that cadence visibly. Decoration that disturbs the rhythm (per-row backgrounds, varying paddings, mixed font sizes within a column) destroys the sweep; the user must read each row individually because the visual grammar gave them no shortcut.

  Scanability also asks the design to *prioritise* the columns and badges visible at sweep distance. Five badges per row each carrying equal weight render as visual mush; one badge carrying high weight plus four de-emphasised badges renders the priority instantly. Subtraction within the row is as important as subtraction across the page.

  Example (Aura companion): the `Sidebar` session list anchors each session's title left, status pill right, and renders ProviderBadges as a single chip-pair on the row's right edge; scanning the sidebar yields "which sessions are active / paired / blocked" in one sweep, with the title only read once the eye has landed on the row the badge drew it to.

  Anti-pattern to detect: a dense list rendered as a wall of uniform-weight rows, with every metadata field present and equally weighted on every row. The eye has no anchor; the user reads serially and the screen feels slow even when the data is small.

  Detection signal in code review: any list/table component instantiation where every column carries the same typography weight or where badges are rendered without a primary-secondary discipline. The flat hierarchy is the signal; the reviewer asks for the primary axis (which one column drives the row's identity) and the demotion of the rest.

  Cross-ref: saarinen §A visual hierarchy discipline — scanability is the consumer side; visual hierarchy is the producer side. Both axes must hold for the sweep to succeed; one alone is insufficient.

- **dashboards that drive action** — a dashboard is not a wall of numbers; it is the answer to the question "what should the user do next?" The discipline is to design every summary surface so that the metrics displayed earn their place by changing what the user does. If the user looks at a number and does nothing different, the number does not belong on the dashboard — it belongs in a detail view the user opens deliberately.

  The pattern requires explicit *next-action affordances* tied to each headline metric: a session in degraded state surfaces a "diagnose" link; an unresolved blocker surfaces a "resolve" button; a long-idle process surfaces a "wake or archive" pair. The metric without the affordance is a dead signal; the affordance without the metric is a guess at urgency.

  The discipline also asks the design to *sort* by actionability, not by recency or alphabetical default. A user looking at six panels first reads the topmost; the topmost should be the one most worth attention right now, not the one that happened to mount first. Static dashboards that "give every panel equal weight" silently teach the user that the dashboard has no opinion, and the dashboard becomes scenery.

  Example (Aura companion): the `HomePage` surfaces recent sessions with their council-pair status (active / paired / blocker-found / degraded), and a blocker-found pair sorts above an idle pair regardless of recency — the surface is opinionated about which session deserves the next click, and the user's flow is shaped by the surface rather than by chronological accident.

  Anti-pattern to detect: a dashboard whose entries are sorted by created-at or alphabetical, with no priority axis derived from current state. The user scans every panel before deciding where to act; the dashboard added cognitive load without absorbing any.

  Detection signal in code review: any dashboard/summary view where the source data is sorted by an immutable property (id, createdAt, name) rather than a current-state property (status priority, urgency score, blocked-count). The static sort is the signal; the reviewer asks for the dynamic sort that surfaces what changed.

  Cross-ref: §B `resilient interface patterns` — dashboards that drive action depend on resilience to render correctly under partial data — a panel that disappears when its data fails to load drops the affordance the user was about to click; the dashboard's action-driving property is conditional on the resilience pattern holding.

- **progressive disclosure** — when a surface has more capability than fits on one calm screen, the discipline is to organise the surface into layers — primary affordances visible by default, secondary affordances behind one clear control, tertiary detail behind a deliberate dig. The hidden capability is not removed; it is *positioned* so the common case is unencumbered and the rare case is reachable.

  Progressive disclosure has two preconditions that distinguish it from "hiding things hoping users won't notice": the *trigger* must be visible and labelled honestly, and the *cost* of opening must be near-zero (one click, one keystroke, no modal that interrupts the current task). A surface whose advanced affordances are invisible until the user already knows they exist has hidden the capability, not disclosed it progressively.

  The pattern also asks the design to *commit* to the layer split — what is primary, what is secondary, what is tertiary — and apply it consistently. Inconsistent layering ("this view shows everything; that view hides half") is worse than uniform exposure because the user cannot build a mental model of where things live; the consistent layering is the user's contract with the system.

  Example (Aura companion): the `ToolBlock` renders the tool name + status by default; clicking expands the full input/output payload; clicking again can dig further into raw stream events. The user scrolling through a long session sees the tool sequence without the per-tool detail noise; the user investigating a specific tool opens it; the user debugging the protocol opens deeper. Three layers, one disclosure axis, applied uniformly to every tool surface.

  Anti-pattern to detect: a surface that hides advanced controls behind an unlabelled icon or a gear menu, with no visual signal that more capability lives behind it. The user does not know the affordance exists; the disclosure failed at the visibility precondition.

  Detection signal in code review: any collapsible / expandable component whose trigger is an icon-only button without an accessible label, or whose default state is collapsed for content the common-case user definitely needs. The hidden-default-with-mute-trigger is the signal; the reviewer asks for the labelled trigger and the reconsidered default.

  Cross-ref: saarinen §B low-friction workflows — progressive disclosure is the structural pattern; low-friction workflows is the resulting user experience. Disclosure done well removes friction by making the common path the visible path; disclosure done poorly adds friction by hiding what the user expected to find.

- **decision fatigue reduction** — every decision the surface asks the user to make is a tax paid against the user's attention budget; a tool used dozens of times a day cannot afford a decision per use that the surface could have made on the user's behalf. The discipline is to identify the decisions that are *truly* the user's to make (irreversible, security-relevant, taste-relevant) and to absorb every other decision into a sensible default the user can override but does not have to confirm.

  The discipline pairs with *visible-but-overridable* defaults. The surface tells the user what it picked (this is the model, this is the permission mode, this is the destination directory) and offers the affordance to change it, but does not block the workflow waiting for the user to repeat the same choice they made fifteen times today. The override exists; it is rare.

  Cumulatively, decision fatigue is the most expensive UX tax because it compounds across the day. A surface that asks "are you sure?" twice per task and is used a hundred times per day costs the user two hundred sure-moments — each small, the integral large enough to push the user to a competing tool with sensible defaults. The discipline budgets those sure-moments at zero unless the action requires it.

  Example (Aura companion): the council-mode New Session form offers a sensible default pairing (`claude+claude`), an explicit toggle for council vs single, and a provider dropdown only revealed when council is on. The common case (single Claude session) requires zero decisions beyond "create"; the council case asks one extra decision and answers the rest by default.

  Anti-pattern to detect: a workflow that re-asks decisions the user already settled (which environment, which model, which permission mode) on every action when the prior choice was a reasonable default for the next action. Each re-ask is a friction debit; the user accumulates them.

  Detection signal in code review: any new modal / form / dropdown introduced into a workflow without a default value derived from prior context (last-used, session-default, account-default). The empty-default is the signal; the reviewer asks for the prior-context source that should pre-populate the field.

  Cross-ref: saarinen §B opinionated product polish — decision fatigue reduction is the UX axis; opinionated polish is the visual-craft axis. Both come from the same discipline of taking positions on the user's behalf; one expresses through workflow defaults, the other through visual defaults.

### Tone characteristics

Practical UX, educational, detail-oriented, usability-first. Friedman's writing and curriculum are anchored in the conviction that UX is a craft learnable by demonstration — every pattern is shown with a real screenshot, a real failure mode, and a worked iteration toward the better version, with the reader invited to apply the same iteration to their own surface. The voice resists both UX-as-magic mystification and UX-as-aesthetic reductionism; the case is made by examples accumulated over thousands of working interfaces.

The pedagogy also extends to *teaching by inventory* — the Smart Interface Design Patterns catalogue is a deliberate vocabulary the team can reach for; the discipline is to know the inventory, recognise which pattern applies, and apply it deliberately rather than improvising bespoke solutions to problems that have known answers. Voice: patient, illustrative, anti-novelty-for-novelty's-sake, vocabulary-building.

### Anti-patterns to detect

- Tables that render every column equally — the eye has no anchor and the data feels heavier than it is.
- Dashboards as data display — numbers without next-action affordances; the user scans, learns nothing actionable, and bounces.
- Hidden advanced controls behind unlabelled icons — the affordance is invisible; the disclosure is not progressive, it is concealment.
- Confirmation modals on common actions — decision fatigue compounded across the day; the user develops blind-clicking habits that eventually misfire on a real destructive action.
- Settings pages that mirror the dashboard's information architecture — the user has to learn two parallel structures for the same surface; the design failed to commit to one organisation.

---

## §B Form & friction UX

Sources:
- https://www.smashingmagazine.com/category/ux
- https://www.smashingmagazine.com/category/design-systems

### Principles

- **friction-aware UX** — friction is not a single quantity; it is a distribution across the user's daily path through the surface. The discipline is to map that distribution (which steps the user touches most often; where they pause, retry, or recover) and to invest in friction-reduction proportionally — most for the highest-frequency steps, least for the deliberate rare ones. The map is empirical; assumptions about which step is friction-heavy are wrong as often as they are right.

  The discipline rewards *intentional* friction at boundaries where reversibility, security, or large-blast-radius warrant it. A "delete this entire workspace" affordance should carry friction the matching "delete this temporary draft" affordance does not. Uniform-friction surfaces are not flat to the user; they are flat in the surface's mind, which is a different thing — the user perceives uniform-friction as either tediously slow (for the common case) or dangerously casual (for the rare case).

  Friction-awareness also tracks *cognitive* friction separately from *physical* friction. A workflow that reduces clicks but requires the user to remember more state has not improved; it has shifted the cost from the hand to the head, and the head is the limiting reservoir for the daily user. The discipline measures both axes when judging an intervention.

  Example (Aura companion): the council-mode pair creation asks one extra question (provider pairing) above the single-session default — intentional friction for the rare case of "I want a paired session" justified by the destructive-state-machine implications; the common case (single session) preserves zero-friction defaults.

  Anti-pattern to detect: a workflow that adds friction to a frequent step in the name of safety, when the safety concern would be better addressed by reversibility or by a confirmation only on the actually-irreversible part. The user pays per use; the safety pays once at most.

  Detection signal in code review: any new "are you sure?" confirmation gate on a reversible action, or any new required field on a form whose primary purpose serves a rare scenario. The misplaced gate is the signal; the reviewer asks for the threat model justifying the friction at this exact step.

  Cross-ref: saarinen §B low-friction workflows — friction-awareness is the diagnostic discipline; low-friction workflows is the design pattern that follows. The map informs the surface; the surface is judged against the map.

- **form usability** — forms are where most UX failures cluster because forms are where the user is asked to translate their intent into the system's data model, and the translation is hard. The discipline treats every form as an act of *user-intent-to-system-state* mapping and designs for the user's intent first — label phrasing that matches the user's mental model, field order that matches the user's narrative, validation that explains rather than rejects, errors that surface inline rather than at submit-time.

  The mechanics: short labels in the user's vocabulary (not the database column name); progressive validation (the user knows the email is invalid before they tab out, not after they hit submit); error messages that name the specific problem and the specific fix ("password must be at least 12 characters" not "invalid password"); persistent state (the user's half-filled form survives the back button, the accidental tab close, the lost connection).

  Forms also reward *defaults derived from context* — last-used values, session-derived values, sensible global defaults — so the user is filling in what is different about this submission, not re-entering their own name. The discipline is to make the form a delta on the user's existing state rather than a blank slate the user has to re-bootstrap.

  Example (Aura companion): the `EnvManager` form persists in-progress edits to localStorage and pre-fills new environment values from the most-recently-used profile; the user defining environment three is editing the differences from environment two, not starting from a blank page. The defaults are visible (the user knows what they are inheriting) and overridable (the user changes whichever field actually differs).

  Anti-pattern to detect: a form that blank-slates every field on mount, has validation only at submit-time, and surfaces errors as a banner above the form rather than next to the offending field. The user submits, scrolls, reads the banner, scrolls back, hunts for the wrong field, fixes it, submits again, repeats. Each iteration is a friction debit; multi-iteration forms become abandoned forms.

  Detection signal in code review: any form component whose validation only fires on `onSubmit` (not `onBlur` or `onChange`), or any error display that renders away from the field that produced the error. The submit-only validation is the signal; the reviewer asks for inline validation and field-anchored errors.

  Cross-ref: watson §A semantic HTML — form usability and accessibility share most of their structural concerns — labelled fields, error association via `aria-describedby`, native input types, autocomplete attributes; getting the form right for keyboard and screen-reader users gets it right for visual users too, and the implementation is one.

- **resilient interface patterns** — real surfaces operate under conditions the happy-path demo never showed: partial network connectivity, slow third-party services, in-flight migrations, paginated data with one missing page, users on yesterday's build talking to today's API. The discipline is to design every surface to degrade gracefully across these conditions — to show a meaningful state in every regime, to recover automatically where possible, and to communicate honestly when it cannot.

  The structural pattern: every surface has *five* states to design (blank / loading / partial / error / ideal), not one. The blank state teaches the new user what the surface is for; the loading state acknowledges the work the system is doing; the partial state renders what is available while the rest loads; the error state explains the failure and offers recovery; the ideal state is the demo. A surface designed for only the ideal state surprises the user every other day, and the surprise erodes trust.

  Resilience also extends to *version skew* — the user on an older client talking to a newer server, or vice versa. The surface must detect the skew, communicate it, and offer a path forward (refresh, re-login, contact support) rather than failing silently or failing loudly without context.

  Example (Aura companion): the council-mode UI renders `DegradedBanner` when one half of a pair has exited unexpectedly, `BlockerBanner` when an observer STOP is unresolved, an explicit "reconnecting" pill during the 45s reconnection grace window, and an empty-state hint on never-checkpointed-yet pairs — five distinct surfaces designed deliberately for the five conditions the pair lifecycle can occupy. The user always sees a meaningful state for the current condition; the surface does not blank out or "spin forever" in any regime.

  Anti-pattern to detect: a surface that shows the ideal state during loading (giving the user the illusion that data is present when it is still arriving), or that renders nothing at all on error (leaving the user staring at a half-empty page wondering whether the click landed). Either failure breaks the user's trust in the surface's communication contract.

  Detection signal in code review: any component that handles only the success branch of a data fetch, with no rendering for the loading, error, or empty cases. The naked success path is the signal; the reviewer asks for all five states or for an explicit reason that one of them does not apply here.

  Cross-ref: §A `dashboards that drive action` — resilient interface patterns is the structural floor that lets action-driving dashboards survive partial-data conditions. A dashboard that disappears when one panel's data fails loses the affordance the user was about to use; the resilience pattern keeps the affordance visible and labels the absent data honestly.

### Tone characteristics

Practical UX, educational, detail-oriented, usability-first. Friedman's voice teaches by accumulation — pattern after pattern, surface after surface, with the principle articulated and then demonstrated in dozens of variations until the reader can apply it themselves. The pedagogy treats UX as a craft that compounds with practice rather than a talent the designer is born with; the case is made for the team's collective growth, not for the rare visionary.

The voice is also explicitly *vocabulary-building* — the Smart Interface Design Patterns catalogue names patterns the team can reference in conversation ("we need progressive disclosure here", "this is decision fatigue"), and the named vocabulary is itself a productivity tool. A team without the vocabulary is reinventing every decision; a team with it can converge on a known pattern in seconds. Voice: patient, taxonomy-led, anti-jargon, anti-mystification.

### Anti-patterns to detect

- Forms that validate only at submit-time — the user iterates blindly; the surface communicates failure too late to prevent it.
- Surfaces designed for the ideal state only — partial / loading / error / blank states all render as the ideal state malfunctioning, and the user concludes the surface is broken when it is merely uncommunicative.
- Error messages that name the problem but not the fix — "operation failed" is not an error message; "operation failed: server rejected the file because it exceeds 10MB; try uploading a smaller file" is.
- Inline validation that fires aggressively before the user has finished typing — every keystroke becomes a failed-validation flash; the user reads the surface as hostile.
- Modal-based confirmation on actions that are reversible by a one-click undo — friction added; safety added by reversibility would have been cheaper and more graceful.
- Form submissions that reset to blank on success without acknowledging the work landed — the user cannot distinguish accepted-and-cleared from silently-dropped, and re-submits "just to be sure".
- Optimistic UI updates that fail to reconcile when the underlying request errors — the surface shows the action succeeded; the system rolls it back silently; the user discovers the divergence later trying to act on the imagined state.
- Action-failed errors swallowed into a 3-second toast that auto-dismisses — the user blinked, the toast was gone, the failure is now invisible; the next retry blames the user.
- Settings pages whose information architecture mirrors the dashboard's — the user has to learn two parallel structures for the same surface; the design committed to no organisation, doubled.

---

## Addendum (2026-10-19) — checkable craft rules: one question per screen, honest states, actions where the answer is

This addendum sits outside §A/§B. It supplies concrete, measurable checks that the principal-lens prose above leaves implicit. The same rules appear as Principle 10 in the Aura `quality-ux.md` and Principle 11 in the Python `quality-ux.md`.

*Added 2026-10-19. Sources: taste-skill (`Leonxlnx/taste-skill`, `references/app-screens.md` §2.2, §7.8, §8, §11 — from a study of 23 real product screens plus rules learned in blind tests) and UI/UX Pro Max (`nextlevelbuilder/ui-ux-pro-max-skill`, `references/quick-reference.md` §3, §8, §9). Visual encoding of the same data (tabular figures, chip styling, delta colour) belongs to the UI-quality seat (saarinen); live regions, focus moves and screen-reader announcements to the accessibility seat. Each check applies to web screens and, where noted, to Telegram bot conversations.*

### What to check

**No named question, no lead**
- Each screen — or each bot status message — states the one question it answers first ("Did today's payment come in?", "Which order needs me?"). The biggest block / first line answers it; the one finding that most needs attention sits next to the action it drives, not in a footer or the last line. Blocks with no question are cut.
- Severity: **P2** when the lead is not the answer. **P3** for a buried finding.

**The main job is not one tap from the answer**
- The most frequent job sits where the answer shows: "Pay", "Retry", "Open log" on the item that needs it (web row action; Telegram inline button on that very message). A screen/message with no control for its main job reads as a report. Rows that need doing get a visible action in one fixed trailing column; others get at most one overflow menu.
- Severity: **P2**.

**Evidence missing beside a number or verdict**
- A figure or verdict carries its cause in one line ("declined: card expired", "+38% after Tuesday's price change"). One line of explanation beats a second chart.
- Severity: **P3**; **P2** when the verdict drives a user decision.

**Zero, missing and loading look alike**
- A real zero is printed ("0", "0 ₽"); missing / not applicable is a small muted dash, not a value-sized "--" that reads as loading. Counts in scope (tabs, badges, "12 open") are computed from the current view/filter and recomputed on every switch.
- Severity: **P2** on primary views/messages.

**Empty states lose their frame**
- An empty section keeps its header and adds one sentence plus the next step; an empty chart draws its zero line, no illustration; first run puts the first action where the data will appear. Labels use words of the trade ("Waiting on the customer", "Due on the 28th"), never "Items", "Records", "Status".
- Severity: **P2** primary, **P3** secondary.

**Loading that reshuffles or flashes**
- Web: final layout with value-sized placeholders, labels immediately, no shift when data lands; no indicator flash for near-instant work, skeleton for waits > ~1s; visible feedback within ~100ms of a tap. Telegram: answer every callback query immediately (no stuck spinner on the button), send a "typing"/"working…" state for waits > ~1s, then edit that same message with the result. A refresh keeps old values and updates a freshness stamp.
- Severity: **P2** for layout jumps, blanking, or an unanswered callback. **P3** otherwise.

**Errors as banners or dead ends**
- The error appears inside the block (or the message) that failed: what failed, when the data was last good, the cause plus how to fix it, and a Retry (inline button in Telegram). Timeouts say so and offer retry. One red mark per object, on the failing fact — red is a signal, not a texture.
- Severity: **P2** on critical paths; **P1** if one failing block blanks the whole screen or the bot goes silent.

**Stale data presented as live**
- Anything that can go stale (balances, order status, limits) carries a freshness stamp ("updated 09:14") and a refresh; a snapshot that can't refresh says so once, quietly.
- Severity: **P2** when stale data drives a decision (payments, stock).

**Lists without a cap, a total, or a way back**
- Overview lists cap at 4–6 rows with "View all"/"Show all" and the total ("3 of 27"); full lists state the range ("1–50 of 1,284") and page with Prev/Next that keep the position. Going back restores scroll, filters and typed input; key screens are deep-linkable (web URL; Telegram `/start <payload>` deep link).
- Severity: **P2** for lost state on back. **P3** for missing totals.

**Settings and destructive actions without a contract**
- One save model per view: autosave with a quiet "Saved", OR one Save per panel — never a mix. Show what the setting produces (a preview of the notification/receipt). Destructive actions go last, state the consequence in words, and confirm by naming the object ("Cancel order #1042?"); prefer Undo for reversible bulk actions; confirm before discarding unsaved input. Read-only looks different from disabled; disabled stays legible and says why (Principle 5).
- Severity: **P1** for an unconfirmed, unnamed destructive or money-moving action. **P2** for mixed save models or silent data loss.
