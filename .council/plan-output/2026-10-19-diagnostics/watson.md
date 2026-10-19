# watson — Accessibility Auditor — Diagnostics page + KB/memory analyzer (v1)

Reference: `quality-a11y.md` (Carmack × a11y Auditor). Surface audited: `#/diagnostics` (eight
auto-refreshing cards, drift table, decision cards with Keep / Archive / Merge, "Run analysis now",
read-only memory report with "Mark as seen") plus three numeric inputs and one toggle in Settings.
Existing patterns consulted: `SweepPage.tsx` + its test (dialog focus recipe, per-block status
regions), `GlobalUsageBadge.tsx` (opacity-muted text), `SessionDefaultsSettings.tsx` + test (switch
recipe), `ModelSwitcher.test.tsx` (verify-by-absence of live regions), `index.css` (tokens, global
focus ring, global reduced-motion block), `test-setup.ts` (axe registration, matchMedia stub).

RECOMMENDATION 1
- Title: One page-level announcer, not a live region per card
- AC defended: Must (spec §5), AC3
- Principle: 3 — ARIA live regions: announce deliberately
- What to get right: The SweepPage recipe (a polite status block for every loading / empty / result state) is right for a single-flow page but wrong when copied into eight cards that re-fetch every 30–60 s: each poll would mount and unmount a polite region per card and the screen reader would say "loading" eight times a minute. Put exactly one visually hidden, polite, atomic status element at page level, owned by the page component, and route every announcement-worthy transition through it as one short sentence. Cards carry no live attributes at all; their text stays reachable in browse mode.
- Risk if skipped: Screen-reader users mute the page (or the whole app) within the first minute.
- Depends on: —

RECOMMENDATION 2
- Title: Background refresh is a sub-state of "ready", never a trip back through "loading"
- AC defended: AC1, AC2, AC3
- Principle: 3 (live regions) + 1 (anything mechanically checkable should be)
- What to get right: Model each card as idle / loading / ready / unavailable / error, with "ready" carrying a refreshing flag (stale-while-revalidate) so a poll never replaces rendered content with a spinner. Mark the card busy with the aria-busy attribute while a refresh is in flight — it tells assistive tech the content may be mid-update without announcing anything. Test with fake timers: three polls returning identical data add zero status or alert nodes and change no live-region text.
- Risk if skipped: Every poll flashes a spinner, re-announces, and sighted low-vision users lose their reading position every minute.
- Depends on: 1

RECOMMENDATION 3
- Title: Announce only availability transitions, and keep changing timestamps out of the announced sentence
- AC defended: AC3, Must (spec §5 "source unavailable" state)
- Principle: 3 — live regions
- What to get right: The announcer speaks when a card crosses ok ↔ unavailable / error ("Usage upstream: KV quota exceeded"), when a manual analysis starts or finishes, and after a decision is applied — never on a same-state poll. A live region fires on any text mutation, so the sentence handed to the announcer must not embed "checked 5 s ago", a countdown, or a relative age; the visible card may show those, the announcer may not. Test: three consecutive polls returning the same 429 set the announcer text exactly once.
- Risk if skipped: "KV quota exceeded since 12:03, checked 4 s ago" is re-read on every poll.
- Depends on: 1, 2

RECOMMENDATION 4
- Title: Drift feed — no live region on the list; announce the count delta at most once per poll
- AC defended: AC2
- Principle: 3 — live regions (log / atomic misuse); precedent: ModelSwitcher verify-by-absence test
- What to get right: The newest-first drift list must not be a log live region: the operator may open the page to fifty events from the last 24 h, and as the server ring rotates the region would re-read rows. When a poll brings N new events, say "N new drift events" through the page announcer, throttled so one poll yields at most one sentence. Ship a verify-by-absence test asserting the list container carries no live attribute and no status role.
- Risk if skipped: Chatter, plus partially read rows as the list shifts under the cursor.
- Depends on: 1

RECOMMENDATION 5
- Title: Pairs, Drift and Context-advisory cards are real tables with column headers
- AC defended: AC1, AC2
- Principle: 5 — roles, names and the screen-reader contract
- What to get right: Rows × fields (session id, role, backend, last-frame age, state, reason, time) are two-dimensional data; only a genuine table with header cells gives a screen-reader user the column name as they move across a row. Keep the session id as full text (monospace, break-all as SweepPage does) rather than truncated with the rest in a tooltip, and render times as a time element with a machine-readable datetime plus visible human text — the absolute time must be in the DOM text or visually hidden, never title-only.
- Risk if skipped: "silent 20m" and "withheld_open_tool_call" are read as one undifferentiated string with no way to tell which session they belong to.
- Depends on: —

RECOMMENDATION 6
- Title: Status conveyed by a word first, icon second, colour last
- AC defended: AC1, AC3
- Principle: 6 — status colours not differentiated beyond colour
- What to get right: Every status (OK / silent 20m / degraded / KV quota exceeded / OAuth expired / source unavailable) renders the word itself, optionally a decorative icon marked hidden from assistive tech, and colour as decoration. The light-theme tokens for success (#2d7d46), warning (#8a5a00, already darkened for small text) and error (#c53030) all clear 4.5:1 on the white card, so colouring the status word is fine; colouring only a dot is not. In Windows forced-colours mode tinted backgrounds disappear — a text label and a border survive.
- Risk if skipped: A colour-blind operator cannot tell OK from degraded on the one page whose entire purpose is that distinction.
- Depends on: 5

RECOMMENDATION 7
- Title: Each decision card is a named group; Keep / Archive / Merge carry the entry id in their accessible name
- AC defended: AC7, AC8
- Principle: 5 — roles, names and labels
- What to get right: N findings produce 3N identically named buttons in the tab sequence. Give each card a group role whose name comes from its heading (entry id + signal, e.g. "got-017 — never used"), and extend each button's accessible name with the entry id via a visually hidden suffix or a description, so "Archive, got-017" is what is spoken and what tests query by. Add to the visible word rather than replacing it (an aria-label equal to the visible text is the P3 duplication smell).
- Risk if skipped: A screen-reader user archives the wrong entry; recoverable only by hand-editing the archive file.
- Depends on: —

RECOMMENDATION 8
- Title: Deterministic focus landing when a decision card leaves the DOM
- AC defended: AC8
- Principle: 4 — focus management on dynamic UI
- What to get right: After Archive (or a confirmed Keep / Merge) removes the card, focus must land somewhere predictable: the same-position action on the next card, else on the previous card, else on the card-list heading or the "all findings reviewed" empty state (made programmatically focusable). Announce "got-017 archived" through the page announcer. Keep the card mounted with its buttons disabled and an "archiving…" label until the POST resolves; on 400 / 409 / 5xx keep the card, render an inline alert linked to the card as its description, and leave focus on the pressed button.
- Risk if skipped: Focus falls to body and a keyboard user restarts from the top of an eight-card page after every decision.
- Depends on: 7

RECOMMENDATION 9
- Title: Merge target picker — a native select or radio group inside the card; a dialog only with the full SweepPage recipe
- AC defended: AC7 (merge marks only), Must (spec §5)
- Principle: 2 (every interactive is focusable) + 4 (focus management) + 7 (keyboard reachability)
- What to get right: Merge targets are the duplicate partner(s) — one to three entries — so a native select or a radio group plus Confirm / Cancel inside the card is the most robust keyboard pattern and needs no custom ARIA. Tab must reach the picker, arrow keys change the choice, Escape or Cancel abandons without posting and returns focus to the Merge button. If a modal is chosen instead, replicate SweepPage's confirm dialog exactly (dialog role, modal flag, initial focus on Cancel, Tab trap, Escape, focus restore to the trigger) and relax axe's region rule only for the portal, with a comment.
- Risk if skipped: A custom listbox without keyboard handlers makes Merge unreachable by keyboard — a P1 in the reference.
- Depends on: 7, 8

RECOMMENDATION 10
- Title: "Run analysis now" while running — stays focusable, explains why, announces start and completion
- AC defended: AC6
- Principle: 4 (focus on dynamic UI) + 5 (names) + 6 (disabled state perceivable)
- What to get right: Prefer the aria-disabled attribute with a no-op click over native disabled: native disabled drops the button from the tab order and in Firefox blurs it the instant it flips, so the keyboard user who just pressed it loses focus. Keep the visible "running…" text, place a visible explanation next to it ("An analysis is already running, started 12:03") linked as the button's description, and route "Analysis started" / "Analysis finished: N findings" through the announcer. A 409 from a click race is not an error to show — the button simply moves to the running state. Tests: a click while running posts nothing; after inFlight flips, focus is still on the button.
- Risk if skipped: A screen-reader user hears "button, dimmed" with no reason and no notice when it finishes.
- Depends on: 1

RECOMMENDATION 11
- Title: Behavioural a11y tests per card state, not one axe-on-render
- AC defended: Must (spec §5 component tests + axe)
- Principle: 1 — axe is a floor, not a ceiling
- What to get right: For each card, run axe across every discriminated state (loading, ready, empty, unavailable, error, running / archiving) through a parameterised test, then add at least one keyboard or focus assertion per interactive card: Tab order Keep → Archive → Merge → picker; focus landing after Archive; Escape in the picker; "running…" posts nothing on click; verify-by-absence of live attributes on the Drift and Pairs containers and on relative-time text. Drive the poll path with fake timers. No axe rule disabling except region for portals, each with a comment — the existing suite's precedent.
- Risk if skipped: An axe-green page that a keyboard-only operator still cannot operate.
- Depends on: 2, 4, 8, 9, 10

RECOMMENDATION 12
- Title: Muted card text at full token opacity only; axe under jsdom cannot measure contrast
- AC defended: Must (spec §5)
- Principle: 6 — Tailwind defaults are not pre-audited
- What to get right: The muted token (#6f6e69) measures about 5.1:1 on the white card and about 4.9:1 on the page background, so timestamps, "3/10 entries · 7/25 sessions · due in ≤12 days" and "source unavailable" may use it at 11–13 px. The opacity variants used elsewhere in the app (muted at 60 % ≈ 2.4:1, at 75 % ≈ 3.1:1 on white) fail body-text contrast and must carry no information on these cards — separators only. Dark theme is ≥ 10:1. axe's colour-contrast rule reports "incomplete" rather than a violation in jsdom, so the Vitest pass proves nothing about contrast: finish with one agent-browser pass in both themes and list the pairs checked in the PR body.
- Risk if skipped: The page an operator reads at 3 a.m. is the one with unreadable grey.
- Depends on: —

RECOMMENDATION 13
- Title: Keep the global focus ring and keep controls on the card surface
- AC defended: Must (spec §5)
- Principle: 2 — visible focus indicator with ≥ 3:1 contrast
- What to get right: The global focus-visible outline (primary token, 2 px, 2 px offset) measures about 3.1:1 against the white card and marginally under 3:1 against the page background. Never add outline-none or a focus variant that removes it on the new buttons, inputs or select, and keep every interactive control inside the white card surface rather than on the bare page background. If decision cards get a tinted highlight, the ring's offset must still sit on the card colour.
- Risk if skipped: A keyboard user cannot see which of 3N identical buttons has focus.
- Depends on: —

RECOMMENDATION 14
- Title: Motion — lean on the global reduced-motion rule; avoid JS-driven ticking text
- AC defended: Must (spec §5)
- Principle: 8 — motion preferences and animation safety
- What to get right: `index.css` already collapses every CSS animation and transition under prefers-reduced-motion, so a pulse on "running…" or a fade-in on a new drift row is covered as long as it is expressed in CSS (use the motion-safe variant as ProcessPanel does, so it is opt-in rather than muted). What that rule does not cover is JavaScript re-rendering "updated 12 s ago" or "due in 11d 23h 59m" every second: cap relative-time refresh at the poll cadence (30–60 s) or show absolute times, and do not run an indefinite spinner longer than 5 s when the busy flag already carries the meaning. Note the test setup stubs matchMedia to "no preference", so a reduced-motion branch needs its own test with the stub flipped.
- Risk if skipped: Vestibular-sensitive and screen-reader users both get a page that never settles.
- Depends on: 2

RECOMMENDATION 15
- Title: Settings numeric inputs — label with unit, commit-on-blur validation, linked messages; toggle follows the switch recipe
- AC defended: AC4 (thresholds editable in Settings), AC9 (memory report flag)
- Principle: 5 (form fields with label association) + 4 (error announcement)
- What to get right: Three inputs, each with a visible label whose text contains the purpose and the unit ("New KB entries since last run", "Finished sessions since last run", "Maximum days between analyses"), a help sentence linked as the description, numeric input mode with min and step so arrow keys work, and no custom stepper buttons. Validate on blur or commit, not per keystroke (clearing a field to retype "25" must not fire "must be at least 1"); on invalid input mark the field invalid, render the message next to it linked as its description, and announce it once through SettingsPage's existing alert region. The memory-report toggle reuses the existing switch-role button with the checked attribute and a help paragraph stating plainly that it is report-only and nothing under the memory directory is ever written. Tests query by label name, assert the invalid attribute and message link, and that a valid change invokes the callback once.
- Risk if skipped: Unlabelled number boxes (a P1 axe failure) or validation that interrupts typing on every digit.
- Depends on: —

RECOMMENDATION 16
- Title: Headings and landmarks so an operator can jump card to card
- AC defended: Must (spec §5)
- Principle: 5 (names reveal design) + 7 (Tab order follows visual order)
- What to get right: One page heading at level 1 ("Diagnostics"), each card a section landmark named by its level-2 heading, in-card subsections at level 3, with DOM order matching the visual grid order (no CSS reordering). This gives heading-jump and landmark-jump navigation across eight cards and satisfies axe's region rule without disabling it. The per-card "last updated" line lives as text inside its section, not as a floating badge outside it.
- Risk if skipped: Eight cards flatten into one reading stream and a screen-reader user reads the whole page to reach the KB card.
- Depends on: —
