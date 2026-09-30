# saarinen.md — UI Quality review of PR #68

**Reviewer:** Karri Saarinen
**Scope:** `web/src/components/ProjectGroup.tsx` (council-role plumbing) — the change that makes the existing `SessionItem` glyph + suffix design land for active session pairs for the first time in production. Read in context with `SessionItem.tsx` lines 245–344 and `Sidebar.tsx#councilInfoFor` (the role source).

This PR doesn't introduce visual elements; it activates a design path that has been dark since `ec93eab`. The glyph + suffix rendering itself is well-tokenised (amber-400 / sky-300 / cc-muted/60), so I'm not asking for re-skinning. The findings below concern *what the row reads as* now that the design lands on top of everything else PR #61 added to the same row.

---

## Finding 1 — Suffix " · orchestrator" / " · observer" doubles a signal the glyph already carries on a row whose horizontal budget is already gone

**Severity:** P2
**File:** `web/src/components/SessionItem.tsx:272-279` (rendering site that this PR newly activates for active pairs via `ProjectGroup.tsx:123`)

**Finding.** The name row now carries: status-dot → ☼/☽ glyph → label → " · orchestrator" suffix in `cc-muted/60`. The glyph and the suffix encode the same information twice on the same row. Original Item 17 documents this as a screen-reader concession (glyph is `aria-hidden`, suffix carries the accessible text), which is the right a11y handling — but it routes the choice as "glyph + suffix together" rather than "glyph for sighted, suffix for assistive". For a sighted user reading the row at a glance, "orchestrator" written out next to ☼ adds no information the glyph hasn't carried; it consumes ~12 characters of the truncation budget on a name row that is already the most space-pressed surface in the product (Sidebar default width 260px, names already truncate to "…", per the May-2026 two-row layout fix). On a `claude+codex` pair the row's meta line will also carry a provider chip ("CODEX") that asymmetrically encodes role-by-side; on `claude+claude` (the common case after PR #61 landed) it carries only the glyph + suffix. Either way the suffix is the redundant element.

**Consequence.** The eye reads weight before content (saarinen §A `visual hierarchy discipline`). The suffix is rendered at `cc-muted/60` — quiet — but it still occupies the name row to the right of the label, which is the highest-priority text on a sidebar row. The user's scan now has to step past "· orchestrator" / "· observer" on every glance at every council session in the list, on every load. After the bootstrap fix lands and groups appear from reload onward, the user with N council pairs in the list sees the suffix 2N times per pass. The calmness budget (§A `interface calmness`) gets spent on chrome that says what the glyph already said.

The cost is *especially* visible on narrow widths and on long session names — once `truncate` kicks in, the suffix can survive while a meaningful trailing fragment of the label is what got cut. That inverts the priority (label is more important than role).

**Fix.** Choose one of:

1. **Drop the suffix from the visible row; keep the accessible label via a visually-hidden span.** The glyph stays `aria-hidden`, and a sibling `<span className="sr-only">` carries "orchestrator" / "observer". Screen-reader audit (watson's domain) keeps passing; the visible row recovers ~12 chars of name budget and loses one piece of chrome the eye has to skip.
2. **Drop the glyph; keep only the suffix.** This is the conservative read — keep an unambiguously labelled, dimmable text token, lose one rendering layer. Less visually distinctive but easier to scan in a dense list.

Option 1 is the saarinen-preferred move (smaller surface, glyph-as-signal, accessible-via-aria-not-text). Either is a strict improvement over "both rendered, both visible".

---

## Finding 2 — On `claude+codex` pairs the glyph + suffix + provider chip render three encodings of "this row is the orchestrator/observer" on one row

**Severity:** P2
**File:** `web/src/components/SessionItem.tsx:260-333` (composition site; activated by `ProjectGroup.tsx` plumbing)

**Finding.** Walk the row for an active orchestrator in a `claude+codex` pair after this PR:

- Name row: ☼ amber glyph + label + " · orchestrator" suffix
- Meta row: cwd + BackendBadge (CC, green) + provider chip "CODEX" (sky) + (optionally) unread count "N" (red)

The glyph says "this is the orchestrator half" (colour + shape encoding). The suffix says "this is the orchestrator half" (text encoding). The asymmetric provider chip on the meta row, by virtue of being CODEX-not-CLAUDE on a Claude backend, *also* says "this is the orchestrator half" (the helper `pairHalvesAfterBackendCollapse` literally collapses the redundant half — so the chip's presence encodes role-by-asymmetry). The user is told three times.

`ProviderBadges` was designed in PR #61 to communicate role-by-asymmetry at a glance (saarinen §B `opinionated product polish` — the chosen asymmetric chip is the role signal). The glyph + suffix design (Item 17, 2026-05-15) was designed before PR #61 landed and assumed the chip wasn't there. Now both ship together, on the same row, for the same pairing case.

**Consequence.** Three competing weights for the same semantic on one row. Saarinen §A `visual hierarchy discipline`: size, weight, and colour are *separate* levers, each carrying a distinct semantic — conflating them produces a screen where the eye has nowhere to rest. Here the asymmetric chip (already the deliberate design for role-by-asymmetry from PR #61), the glyph (Item 17's pre-PR-61 design), and the suffix (the Item 17 a11y artifact) all carry the same bit. The row reads as decorated rather than informational, and the user has to learn three sub-grammars instead of one.

The pair on `claude+claude` ducks this because the provider chip collapses entirely (homogeneous-suppression rule from PR #27 + `pairHalvesAfterBackendCollapse`). So the asymmetric pairing — which is the more cognitively expensive one for the user already — gets the *more* crowded row.

**Fix.** Decide which of the three signals owns the "this is the orchestrator half" semantic and demote the other two. The system-consistent answer (PR #61's design intent + saarinen §A `component cohesion`) is the **asymmetric provider chip** for asymmetric pairings, and the **glyph alone** (no suffix) for homogeneous pairings where the chip is suppressed. That gives one row → one signal → the user learns the grammar once. Concretely: on `claude+codex`, render glyph + label only (drop suffix; chip carries role-by-asymmetry); on `claude+claude`, render glyph + label only (chip absent; glyph carries role). Suffix becomes `sr-only` regardless (Finding 1).

---

## Finding 3 — Meta row chip cluster has grown to 5 potential elements on a 260px sidebar — overflow ergonomics are now load-bearing and were not designed-for at Item 17 time

**Severity:** P3
**File:** `web/src/components/SessionItem.tsx:282-343` (meta row container; activated path)

**Finding.** The meta row's `<span className="flex items-center gap-1 shrink-0">` chip cluster can now carry, in order: BackendBadge → Docker icon → cron icon → provider chip → unread count. That's up to 5 chips at `text-[10px] / px-1.5 py-0.5` plus their 4px gaps, against a cwd that wants `truncate min-w-0 flex-1` on the left. The PR's `ProjectGroup.tsx` change doesn't *add* to this cluster — but it changes the user's mental load *for the name row above it*, and the two rows together are what the user perceives as "the session". The Item 17 design pre-dates the Docker chip and the cron chip; the chips were added later under the same `shrink-0` cluster.

On a Council Mode pair session that's also containerised (a plausible configuration once the council prompt fallback + bootstrap from this PR + PR #61 land together), the row consumes: status-dot (12px) + glyph (~14px) + label (truncated) + suffix (~80px when "· orchestrator") on row 1; cwd (truncated to min-content) + 5 chips (~140px total with gaps) on row 2. The 260px default sidebar width has already given the cwd minimal space; on narrow viewports (the sidebar collapses on mobile but is still 260px-ish in the open state), the cwd disappears entirely under the chip cluster's `shrink-0`.

**Consequence.** Saarinen §B `low-friction workflows`: the sidebar is the user's primary navigation surface — used hundreds of times per long-running working session. Each chip is justified individually; together they push the cwd (which the user reads to disambiguate same-named sessions across projects) below the visibility floor. On the active-pair case this PR newly enables, the user can no longer tell which workspace the council pair is running in without expanding the row or hovering for the title. The row reads as "lots happening" rather than "this session is in /repo/foo".

**Fix.** Two levers, either of which suffices, both is preferable:

1. **Cap the chip cluster's visual budget.** Set a `max-w` on the chip span (e.g. `max-w-[120px]` with `overflow-hidden`) so the cwd always retains a readable tail. The hidden chips become title-tooltipped on the wrapper. This is the cheap intervention — no semantics change, just a budget cap.
2. **Move the unread count off the meta row onto the name row, as a trailing badge after the suffix/glyph cluster.** The unread count is the *highest-priority* signal on the row (the user must act on a blocker) — by saarinen §A `visual hierarchy discipline` it deserves the name row's weight, not the meta row's. Moving it also evicts one chip from the meta cluster, recovering ~30px for the cwd.

This isn't strictly a PR #68 fix — the chips pre-date it — but PR #68 is what brings the glyph + suffix to *every* active pair, which is when this row crowding becomes the daily case rather than the edge case. Worth raising for next-iteration polish.

---

## Finding 4 — The suffix " · orchestrator" / " · observer" inherits the `truncate` of its parent name `<span>`, so on narrow widths the suffix wins over the label

**Severity:** P3
**File:** `web/src/components/SessionItem.tsx:254-280`

**Finding.** The wrapper `<span>` carries `truncate block` (line 255). The glyph, label, and suffix render as inline children. With `truncate` on a block whose inline children include "☼ {label} · orchestrator", CSS truncates from the right of the *visible inline content*. When the row is narrow enough to truncate, the order of what gets cut is: suffix tail → suffix start → label tail. The suffix doesn't have an opportunity to drop independently — it's part of the same overflow chain as the label.

So a session named `"Refactor session-orchestrator router"` on a 260px sidebar with an orchestrator role suffix becomes `"Refactor session-orches… · orchestr…"`. The user reads the role (low-priority on this row — they already know which side of the pair they clicked) and loses the label tail (high-priority — they're trying to find this specific session in a list of similarly-prefixed ones).

**Consequence.** Saarinen §A `visual hierarchy discipline` again: weight is right, but *truncation order* is the implicit hierarchy in dense lists, and here the truncation favours the lower-priority token. The user resorts to hovering on each row to see full names — which is friction (§B `low-friction workflows`) on the surface they use most.

**Fix.** Adopting Finding 1 (suffix becomes `sr-only`) closes this incidentally — the suffix no longer participates in visual truncation. If Finding 1 is rejected and the suffix stays visible, then the label needs its own `truncate` and the suffix becomes a `shrink-0` sibling outside the label's truncation chain. The structural shape is `<span class="block flex items-center min-w-0"><span class="truncate min-w-0">{label}</span><span class="shrink-0 text-cc-muted/60"> · orchestrator</span></span>` — i.e. flex with the label as the only truncating child.

---

## Cross-cutting note (not a finding — context for the council)

This PR's stated scope is "REST bootstrap for ObserverPanel findings on browser reload". The `ProjectGroup.tsx` plumbing change is incidental ("bonus fix" per the context brief) but is the highest-visual-impact change in the PR — it's the first time the Item 17 glyph + suffix lands in production for active pairs. The bootstrap mechanism itself is a server-side correctness fix the user only notices in its absence (PR #61 had this gap; this PR closes it). The visual surface this PR newly activates is what I've graded above; the bootstrap itself is invisible-by-design and not a saarinen domain concern.

Two of my findings (1 and 2) argue the visible surface should *shrink* rather than expand on the back of this fix. That's the saarinen reflex — the bug here is "the design didn't render in case X"; the temptation is to celebrate it now rendering; the discipline is to ask whether the design (designed pre-PR-61) is still the right design now that the row context has changed under it. The answer is "mostly yes, but the suffix is doing two jobs and one of them is a11y-only".
