# abramov — React 19 / Zustand / Tailwind recommendations: Diagnostics page + KB analyzer

Scope: `web/src` only (routing, page state, cards, decisions, Settings UI). Server shapes are referenced only where the page's state design depends on them; dahl owns the REST contract.

Reference read: `quality-frontend.md` (Carmack × Dodds × React 19). Codebase anchors: `web/src/components/SweepPage.tsx` (+ test), `SectionErrorBoundary.tsx`, `GlobalUsageBadge.tsx`, `SessionDefaultsSettings.tsx`, `SettingsPage.tsx`, `store/settings-slice.ts`, `utils/context-advisory.ts`, `utils/routing.ts`, `App.tsx`.

---

RECOMMENDATION 1
- Title: No Zustand slice — the page owns its state locally, exactly like SweepPage
- AC defended: Must (spec §5); AC1–AC3 indirectly
- Principle: Principle 2 (slice discipline) + Principle 4 (one write path for server data)
- What to get right: Diagnostics data is server-authoritative, has exactly one consumer (the page), is never needed by ws.ts, the sidebar, or any session view, and must be fresh on every visit rather than cached. That is the settings-slice's own documented bar for NOT adding store fields ("only server-authoritative facts used by two or more consumers"). Keep a reducer-driven local state in DiagnosticsPage with explicit tagged unions; the store stays untouched and nothing is persisted across navigations.
- Risk if skipped: A diagnostics slice becomes a second write path for server facts (pairs, usage, settings thresholds) that drifts from ws.ts and the settings slice, and a stale cached snapshot is precisely what an operator page must never show.
- Depends on: —

RECOMMENDATION 2
- Title: Two page-level fetches (overview, kb-analysis latest), never eight per-card fetches
- AC defended: AC1, AC2, AC3, AC4
- Principle: Principle 1 (eliminate state that can be derived; colocate what remains)
- What to get right: The page holds exactly two source records — one for the overview response and one for the latest-analysis response — each a tagged union (not yet loaded / ready with payload and fetched-at / failed with message and last-good payload). Every card receives its slice of the payload as props, derived during render; no card fetches on its own and no card mirrors props into local state. The two sources poll independently so a slow or failing KB read never delays the Backend/Pairs/Drift cards.
- Risk if skipped: Per-card fetches multiply requests eight-fold per poll, produce eight independent loading flickers, and make "the backend is unreachable" show up as eight different errors instead of one.
- Depends on: 1

RECOMMENDATION 3
- Title: Per-card status is part of the server payload, so "unavailable" survives a 200
- AC defended: AC3; Must (spec §5 "every card has a source-unavailable state")
- Principle: Principle 8 (type system as armour at the boundary) + the `feedback_silent_null_render_hides_upstream_failure` rule
- What to get right: The overview response must carry, per card, an explicit availability discriminator (available with data, or unavailable with a reason code and a since-timestamp) rather than nullable fields — the usage card in particular needs the upstream HTTP status, the "KV quota exceeded" reason and the time of the last successful upstream reply, not three nulls. On the client, each card's rendering state is derived from two levels: the page-level source (not loaded / failed) and the card-level discriminator (available / unavailable / available-but-empty). Three distinct visible outcomes must exist and be tested apart: "loading", "source unavailable since T because R", and "no events in the last 24h"; the fourth, rendering nothing, is forbidden in every branch. Type the response in api.ts (as SweepPreview is typed) and exhaust the unions with a never-assertion.
- Risk if skipped: A 200 with empty fields quietly reproduces the GlobalUsageBadge disappearance this page exists to end, and the card that goes blank is the one the operator came to look at.
- Depends on: 2

RECOMMENDATION 4
- Title: A single CardFrame implements the loading / unavailable / stale chrome once
- AC defended: Must (spec §5); AC3
- Principle: Principle 6 (composition over configuration)
- What to get right: Build one presentational frame component that takes a card title, the derived card state and a children slot; it renders the title row with "updated N s ago", the unavailable banner with reason and since-time, the loading placeholder, and a "stale" marker when the last successful fetch is older than roughly two poll intervals. The eight cards then only render their happy path and their own empty state inside that slot. The frame is where the never-null guarantee lives, so it is tested once for all branches, and each card test only needs render + axe + its own empty/decision behaviour.
- Risk if skipped: Eight hand-rolled unavailable branches diverge; one card inevitably forgets the branch and returns null, and the rule is only as strong as its weakest card.
- Depends on: 3

RECOMMENDATION 5
- Title: Cards are pure (props in, callbacks out); only DiagnosticsPage talks to api.ts
- AC defended: AC1, AC2, AC6, AC8, AC9 (each card's test)
- Principle: Principle 6 (composition) + Principle 4 (no component mutates server data on its own)
- What to get right: BackendCard, PairsCard, DriftCard, ContextAdvisoryCard, UsageCard, KbHealthCard, KbAnalysisCard and MemoryReportCard receive typed data plus `onRunAnalysis` / `onDecide` callbacks; they never import api.ts. DiagnosticsPage is the only component that fetches, posts, and owns the reducer. Card tests then render fixtures directly without mocking the network, and the single DiagnosticsPage test is the one that mocks api.ts (as SweepPage.test does) to cover the fetch orchestration, the 409 path and the decision round-trip. This page is not a message-flow component, so no Playground entry is required — do not add one just to have one.
- Risk if skipped: Cards that fetch themselves cannot be tested with fixtures, cannot be composed into a single refresh cycle, and each becomes its own mini-page with its own polling bugs.
- Depends on: 2, 4

RECOMMENDATION 6
- Title: Derive ages at render from absolute timestamps; pass `now` in, never store an age
- AC defended: AC1 ("silent 20m"), AC2 (newest first)
- Principle: Principle 1 (derive, don't sync)
- What to get right: The server sends absolute epoch timestamps (last inbound frame, last checkpoint, event time, last successful upstream reply) plus the snapshot's generated-at. The client computes "silent 20m" and "3 min ago" during render relative to a `now` value owned by the page and refreshed on every poll tick; cards accept that `now` as a prop so tests pin it and assert the exact label. Do not run a separate one-second ticker, and do not let the server pre-format strings the page would have to re-derive for sorting. Sort the drift feed on the client by timestamp descending with a stable key (event timestamp plus sessionId plus event name); render the "silent" badge only when the age crosses the threshold, with an explicit "no inbound frame recorded yet" wording when the timestamp is absent rather than computing an age from zero.
- Risk if skipped: Server-formatted or stored ages freeze at fetch time and read "silent 5m" twenty minutes later, or an absent timestamp silently becomes "silent 56 years".
- Depends on: 2

RECOMMENDATION 7
- Title: Context advisory card reads through the existing one-browser-reader decoder
- AC defended: Must (spec §3.1 context advisory card)
- Principle: Principle 4 (single parse path — do not fork the extraction logic in a component)
- What to get right: `utils/context-advisory.ts` is documented as the ONE browser reader of an advisory record, handling the pre-2026-10-17 bytes-only shape. The card must call that decoder for every record in the overview payload and render the decoded signal and milestone in that signal's unit (bytes for transcripts, compactions for Codex); it must not read the raw milestone fields itself.
- Risk if skipped: A second reader forks the legacy-shape rule, and old advisories show "0" or the wrong unit on the diagnostics page while the banner shows the right one.
- Depends on: 5

RECOMMENDATION 8
- Title: Polling cadence — 30 s overview, visibility-paused, focus-refetched; latest-analysis tightens only while in flight
- AC defended: AC4, AC5, AC6
- Principle: Principle 7 (hooks correctness: cleanup, no stale closures) + Principle 3 (latency is a bug)
- What to get right: Poll the overview every 30 seconds (the backend snapshot itself is 5-minutely; pairs liveness and the drift ring are the only things that move faster, and a half-minute resolution is enough for "silent 20m"). Pause the interval when the document is hidden and refetch once on visibility/focus, the same discipline App.tsx uses for group bootstrap. The latest-analysis source polls at the same cadence normally but drops to a few seconds while the payload says an analysis is in flight, and refetches immediately after any successful decision post. Every poll effect returns a cleanup; every response is tagged with a monotonically increasing request sequence and late responses with an older sequence are dropped, so a slow pre-run poll cannot overwrite the post-run report.
- Risk if skipped: Hidden tabs hammer the server and the KB reader for hours; an out-of-order response regresses "report ready" back to "running…" and the button stays dead until the next tick.
- Depends on: 2

RECOMMENDATION 9
- Title: useTransition wraps refreshes to avoid flashing, but never gates buttons on isPending
- AC defended: AC6; Must (spec §5)
- Principle: Principle 3 (React 19 transitions) + memory `feedback_react19_usetransition_ispending_bleeds_into_next_state`
- What to get right: Wrap each poll/refresh fetch-and-dispatch in startTransition so the previous card content stays mounted and interactive while new data lands — a refresh must replace content in place, never pass through a loading state once data exists (keep last-good payload in the failed branch too). The reducer's own tags are the only source of "in flight" for buttons: the Refresh button disables on the source's refreshing tag, Run analysis disables on the server-reported inFlight plus the local starting tag, decision buttons on the per-entry posting tag. isPending from useTransition is never used as a disabled condition, because it stays true through the settling render and bleeds into the next state.
- Risk if skipped: The SweepPage regression repeats — a button that only changes local state renders disabled after a fetch settles, and tests for the running… state become flaky.
- Depends on: 8

RECOMMENDATION 10
- Title: "Run analysis now" is driven by server inFlight; 202 and 409 both land in the same running state
- AC defended: AC6
- Principle: Principle 1 (single source of truth) + Principle 8 (exhaustive union)
- What to get right: Model the run control as an explicit union — idle / starting (click sent, no answer yet) / running (server says inFlight, optional runId, started-at) / failed (message). A 202 and a 409 both transition to running: a 409 means another tab or the hourly check already started it, which is not an error for the operator and must not surface as a red banner; the button label reads "running…" with elapsed time and the state is released only when a subsequent latest-analysis poll reports inFlight false and a newer report timestamp. Across tabs, tab B learns about tab A's run purely through the poll, which is why inFlight must live in the GET payload and the client never trusts its own click alone. Non-409 failures go to failed with the server message, and the next poll clears it.
- Risk if skipped: Two tabs show contradictory states, a 409 reads as a failure, and a locally-flagged "running" never clears when the run was started elsewhere.
- Depends on: 8, 9

RECOMMENDATION 11
- Title: Decisions are confirmed, not optimistic — Archive moves a file, so the UI waits
- AC defended: AC7, AC8, AC9
- Principle: Principle 4 (one write path) + Principle 8 (discriminated union per entry)
- What to get right: Each finding carries its own decision state: undecided / posting(decision) / decided(decision, timestamp) / rejected(status, message). On click, only that finding's three buttons disable and show the chosen verb in progress; other findings stay interactive. On success the finding stays on screen marked "Archived" / "Kept until <date>" / "Merge pending into X" (it does not vanish, which would be another silent disappearance), and the page refetches the latest report so the server-authoritative reviewedAt / mergePending / archived marks replace the local marker — the local decided state is a bridge until the next payload, not a second truth. A 400 (unknown entryId: the report rotated underneath the tab) shows an inline "report changed — reloading" note and triggers the refetch; a 409 (analysis in flight) shows "analysis running, retry after it finishes" and returns the finding to undecided. Merge needs the target first: the duplicate finding carries both ids, so offer "merge into A" / "merge into B" as explicit choices rather than a free-text target. Post one single-element array per click; no batch "apply all" in v1. The memory card reuses the same per-entry union with a single "Mark as seen" verb and no other buttons rendered, so the test can assert exactly one button per finding.
- Risk if skipped: An optimistic "Archived" that the server rejected leaves the operator believing a KB line moved when it did not — the one lie this feature is not allowed to tell.
- Depends on: 5, 8

RECOMMENDATION 12
- Title: One SectionErrorBoundary per card, labelled, distinct from "source unavailable"
- AC defended: Must (spec §5)
- Principle: Principle 5 (error boundaries; async errors routed explicitly)
- What to get right: Wrap each card in the existing SectionErrorBoundary with the card's name as label, so a render throw in DriftCard shows "Drift failed to load — Retry" while the seven others keep working; the page itself is mounted lazily and embedded like SweepPage. Boundaries only catch render errors: fetch and decision failures must be modelled in the reducer (recommendations 3 and 11) and must never be rethrown into a boundary, otherwise a 429 upstream would read as a crashed component. Keep the two wordings visibly different ("source unavailable since T" versus "card failed to render") because they point the operator at opposite ends of the chain.
- Risk if skipped: One malformed event in the drift ring blanks the whole page, or a transient upstream failure is reported as a frontend crash and the operator debugs the wrong layer.
- Depends on: 4

RECOMMENDATION 13
- Title: Routing and navigation follow the sweep precedent exactly
- AC defended: AC1–AC3 ("When I open #/diagnostics")
- Principle: Principle 1 (hash is the source of truth, read via the existing hashchange subscription)
- What to get right: Add a diagnostics member to the route union in utils/routing.ts with its parseHash case, a lazily-imported DiagnosticsPage branch in App.tsx rendered in the same absolute-inset container with the embedded prop, and a Sidebar item in the Workspace group next to Sweep with matching activePages. Do not read the hash inside the page and do not store the route anywhere; App.tsx's useHash already delivers it.
- Risk if skipped: A page reachable only by typing the hash, or a second route parser, is the first thing the next refactor breaks.
- Depends on: —

RECOMMENDATION 14
- Title: Settings additions are controlled fields owned by SettingsPage; the page never reads Settings
- AC defended: AC4 (thresholds shown as "3/10 · 7/25 · due in ≤12 days")
- Principle: Principle 1 (derive, don't sync) + Principle 2 (do not widen the settings slice for a single consumer)
- What to get right: Extend SessionDefaultsSettings (or a sibling "Knowledge analysis" block with the same controlled-component contract) with three numeric inputs and one switch, values and callbacks coming from SettingsPage's existing draft state and save path; add the keys to AppSettings and the updateSettings payload type in api.ts. Numeric thresholds commit on blur or explicit save with min/step validation and the current value visible as the field's own draft — not a PUT per keystroke; the boolean uses the optimistic-with-revert toggle pattern SettingsPage already applies to the AI-validation switches. Since the nested threshold object is patched as a whole, always send the full trio. The diagnostics page must not fetch settings: the latest-analysis payload echoes the effective thresholds alongside the counts, so the "3/10" label has one source and reflects what the server actually used.
- Risk if skipped: The KB card and Settings disagree about thresholds after an edit, or a half-patched nested object resets one threshold to its default.
- Depends on: 2, 13

RECOMMENDATION 15
- Title: Test shape — fixtures per card, one orchestration test for the page, states asserted apart
- AC defended: AC1, AC2, AC3, AC6, AC8, AC9; Must (spec §5 component tests)
- Principle: Dodds — test behaviour, not implementation (reference doc preamble); Principle 8
- What to get right: Each card test renders fixtures for: loading, source unavailable with reason, available-but-empty, and populated; asserts the exact operator-facing wording (the "KV quota exceeded since" text for AC3, "silent 20m" with a pinned now for AC1, descending order for AC2); runs axe; and clicks each interactive control asserting the callback fired once with the right entry id and decision. The DiagnosticsPage test mocks api.ts and covers: 409 on run keeps the button disabled with "running…", a 400 on a decision triggers a refetch and an inline note, an out-of-sequence late response is ignored, and a failed poll keeps the last-good content with a stale marker. Follow SweepPage.test's documented-coverage header style.
- Risk if skipped: Tests that only assert "renders without crashing" would pass on a card that returns null, which is the exact defect class this page is built to remove.
- Depends on: 3, 5, 10, 11
