# Saarinen — UI Quality Review (SECOND PASS)

PR #91 `feat/dynamic-claude-models` — visual review of burndown commit `9d922c0`'s DOM restructure to `ModelSwitcher.tsx`.

Scope: same as first pass — visual hierarchy, dark-theme elevation, spacing/typography system, token discipline, motion, component visual consistency. NOT a11y, UX patterns, or React architecture.

The burndown's claim against my first-pass findings: 1 P2 + 6 P3 (none addressed by name in the burndown's Risks-And-Watchpoints scope — the restructure was driven by a11y P2 #12 / Friedman P2 #12 — but the restructure rearranged the DOM in ways that interact with my findings). The brief explicitly asks me to (a) re-verify whether the prior P2 `bg-cc-bg` finding survives the DOM restructure, (b) check whether the new wrapper > listbox + footnote shape introduced visual regressions invisible to tests.

---

## FINDING 1 (CARRIED — STILL P2, surface unchanged)

- **Title:** Dropdown surface STILL fails the dark-theme elevation contract — burndown moved the token, didn't change it
- **File:** `web/src/components/ModelSwitcher.tsx:264`
- **Principle:** Quality-UI Principle 3 — Dark theme is a system (elevation via surface differentiation); Principle 8 — Component consistency.
- **Severity:** P2
- **What's wrong:** The first-pass review flagged `bg-cc-bg border-cc-separator rounded-lg` on the dropdown panel as divergent from the canonical overlay pattern (`bg-cc-card border-cc-border rounded-[10px] shadow-lg`) used at `Composer.tsx:472`, `Composer.tsx:517`, `Playground.tsx:2202`, and the precedent-citing comment at `CouncilToggle.tsx:346-352`. The burndown's restructure moved these exact three tokens from the (former) listbox div onto a NEW outer wrapper div (`web/src/components/ModelSwitcher.tsx:264`) — but kept the tokens themselves identical. Verified via `src/index.css:190,192,196,208`: in dark mode `--cc-bg = #262624` is still the page surface and `--cc-card = #141413` is still the elevated-surface idiom. The dropdown panel STILL renders at the SAME shade as the chat surface behind it; the elevation-via-shadow-alone failure mode catalogued in the first pass is unchanged. Cross-check: `grep` for the convention across `web/src/components` returns 30+ hits on `bg-cc-card border-cc-border rounded-[10px]` and 0 hits on `bg-cc-bg ... shadow-lg`. ModelSwitcher remains the lone outlier.
- **Consequence:** Unchanged from first pass — in dark mode the menu visually melts into the chat behind it, leaving only the shadow ring as elevation cue; users perceive a soft halo rather than a confident overlay. Two listbox dropdowns in the same app (CouncilToggle vs ModelSwitcher) still read as belonging to different design systems.
- **Fix:** Same as first pass — replace `bg-cc-bg border-cc-separator rounded-lg` with `bg-cc-card border-cc-border rounded-[10px]` on the outer wrapper at line 264. The restructure has actually made this fix simpler because the tokens are now isolated on a wrapper that no longer also bears the focus-ring concern.

---

## FINDING 2 (NEW — introduced by the burndown's restructure)

- **Title:** Outer-wrapper `overflow-hidden` clips the listbox `focus:ring-1` to a 0-pixel band on three of four sides
- **File:** `web/src/components/ModelSwitcher.tsx:264` (wrapper `overflow-hidden`) × `:270` (listbox `focus:ring-1 focus:ring-cc-primary/40`)
- **Principle:** Quality-UI Principle 9 — Pixel-level polish; Principle 7 — Elevation is a system (focus ring is part of the affordance layer).
- **Severity:** P3
- **What's wrong:** The restructure put `overflow-hidden` on the OUTER wrapper (line 264) so the rounded corners clip whichever child (listbox, footnote) sits at the rounded boundary. The inner listbox now carries `focus:outline-none focus:ring-1 focus:ring-cc-primary/40`. Tailwind's `ring-1` paints a 1px box-shadow ring INSIDE the listbox's own border-box. Because the listbox child has the same width as the wrapper AND the wrapper clips overflow, the listbox's left/right/top edges butt the wrapper border with zero gap — the ring on those three edges renders inside the listbox's bounding box and is OK; but the focus ring at the BOTTOM edge of the listbox sits flush against the wrapper bottom (when footnote absent) OR against the footnote's `border-t` (when footnote present). With `overflow-hidden` + zero internal padding on the wrapper, the focus ring's bottom segment is visually walled off / collides with the cc-separator border-top of the footnote. The contract "focus ring outlines the focused thing" partially fails: top/left/right read as a thin orange/brand line; bottom either doesn't render (footnote absent — ring abuts wrapper inner edge, no contrast against cc-bg) or visually competes with the footnote divider (footnote present — 1px ring + 1px border = a 2px stacked rule).
- **Consequence:** Keyboard user tabs into the listbox, expects a clean inset focus ring, sees three sides only OR a stacked rule at the bottom. Inconsistent affordance — the focus ring's shape silently depends on the no-key-state of the dropdown. The pre-burndown shape didn't have this because the focus ring lived on the SAME element as the rounded panel — the corners and the ring were co-radius. The burndown introduced the asymmetry as a side-effect of separating "rounded surface" from "focused element."
- **Fix:** Two reasonable routes. (a) Move `focus:ring-1` UP to the wrapper (since the wrapper is now the visible surface, it should also own focus): drop `focus:ring-1` from the listbox; add `focus-within:ring-1 focus-within:ring-cc-primary/40` to the wrapper, keep `tabIndex={0}` on the listbox so focus still lands there. The ring then traces the rounded panel boundary cleanly. (b) Add `p-1` inside the wrapper so the listbox has breathing room — then the listbox's own focus ring renders inside the wrapper's clip with a 4px visible gutter on all four sides, matching CouncilToggle's `p-1` pattern (this also discharges Finding 5 from the first pass).

---

## FINDING 3 (NEW — introduced by the burndown's restructure)

- **Title:** Footnote restyled as `<a>` with `hover:bg-cc-hover` creates a 4th visually-selectable item that isn't part of the listbox semantically
- **File:** `web/src/components/ModelSwitcher.tsx:328-334`
- **Principle:** Quality-UI Principle 1 — Reduce noise to reveal hierarchy; Principle 8 — Component consistency (hover token = signal of selectable affordance).
- **Severity:** P3
- **What's wrong:** The burndown lifted the footnote from a plain `<div>` to an `<a href="#/settings">` AND gave it `hover:text-cc-fg hover:bg-cc-hover` — the EXACT SAME hover color tokens used by non-selected option rows at line 291 (`text-cc-muted hover:text-cc-fg hover:bg-cc-hover`). Visually, the hover state on the footnote is INDISTINGUISHABLE from the hover state on an option row. The footnote also shares the same `text-cc-muted` resting color as a non-selected option (line 291). The user sees a list of 3-7 muted rows with a 4th muted row at the bottom (separated by a hairline) that highlights identically on hover. The semantic difference (option vs link out) is communicated only by the position-after-divider and the text content — neither is a visual hierarchy lever. This is a Saarinen Principle 1 violation: the hover-tinted surface is the strongest "this is clickable as a list selection" signal in the dropdown, and using it on a non-list-selection element flattens the hierarchy.
- **Consequence:** A keyboard user arrow-keying through options at line 6 of 6 might expect the next ArrowDown to land on the footnote (it doesn't — footnote is outside the listbox, which is correct for SR but invisible to a sighted user). A mouse user scanning by hover-tracking may "test" the footnote with hover and read the bg-cc-hover lift as confirming "this is option #8" before the brain parses the divider as a category break. The divider does grouping work, the hover token undoes it.
- **Fix:** Differentiate the footnote's hover from the option-row hover at the affordance layer. Two routes. (a) Hover-as-link (no bg shift): drop `hover:bg-cc-hover`, keep `hover:text-cc-fg`, add `hover:underline` — communicates "navigation link" rather than "selectable item." This is the standard CSS convention and matches the `<a>` element semantics the burndown chose. (b) Hover-as-tinted-text (cc-primary accent on hover): swap `hover:text-cc-fg` for `hover:text-cc-primary`. Either route makes the footnote read as a footer link, not an off-list option. The current shape leaks the same color contract across two semantically distinct elements.

---

## FINDING 4 (NEW — introduced by the burndown's restructure)

- **Title:** Single `shadow-lg` on the outer wrapper now elevates TWO surfaces under one card boundary — visual stratum reads as one card with an internal rule, which is correct, but the absence of an inner gutter makes the rule read as splitting the card in half
- **File:** `web/src/components/ModelSwitcher.tsx:264` (wrapper carries `shadow-lg`) × `:331` (footnote `border-t border-cc-separator`)
- **Principle:** Quality-UI Principle 7 — Elevation is a system; Principle 4 — Spacing creates meaning (proximity grouping).
- **Severity:** P3
- **What's wrong:** The brief asks: "does the visual elevation still read as one card, or as two stacked surfaces?" Answer: it reads as one card (the wrapper's single shadow-lg + rounded-lg + border traces the perimeter), which is correct. BUT the footnote's `border-t border-cc-separator` (line 331) runs flush corner-to-corner across the inside of that card because the wrapper has zero inner padding. The visual effect: ONE card containing a TOP zone (the list, full-bleed) + a BOTTOM zone (the footnote, full-bleed) separated by a hairline rule that touches both inner edges of the card border. This is a different problem than first-pass Finding 7 (which was about the footnote inside the listbox being too visually loud) — here, the footnote is correctly OUTSIDE the listbox, but the divider's full-bleed reach inside an `overflow-hidden` card splits the card into two visually-equal "halves" of comparable weight. The footnote is two lines of 11px copy; the list is up to 7 rows of 13px copy. The hierarchy says "list is primary, footnote is footer." The full-bleed rule says "these are two equally-weighted zones." Hierarchy and treatment disagree.
- **Consequence:** Carried from first-pass Finding 7 but with a NEW visual contributor: the `overflow-hidden` rounded wrapper combined with the divider's full-bleed reach makes the bottom 16-24px of the card read as a second sub-panel rather than as a quiet footer attached to the same card. The burndown's restructure didn't address this; if anything, sharing one `shadow-lg` and one border across both zones amplifies the "two zones in one card" reading rather than softening it.
- **Fix:** Same as first-pass Finding 7, restated for the new shape — once an inner gutter exists (`p-1` on the wrapper, see Finding 2 fix-b above), the footnote's `border-t` insets by the gutter and stops short of the rounded corners; the divider's reach is then narrower than the card's outer boundary and reads as "rule between two zones inside one card" rather than "rule splitting one card into two." Alternative: drop `border-t` entirely and let `mt-1 pt-2` on the footnote do the grouping work. Spacing-as-separator is quieter than a line — Saarinen Principle 4: "Increase between groups, reduce within."

---

## FINDING 5 (VERIFIED — corner rendering is OK, no regression)

- **Title:** `border-t` on footnote inside `overflow-hidden` rounded wrapper — corner rendering verified, no visual gap
- **File:** `web/src/components/ModelSwitcher.tsx:264` (wrapper `rounded-lg overflow-hidden`) × `:331` (footnote `border-t`)
- **Principle:** Quality-UI Principle 9 — Pixel-level polish.
- **Severity:** Not a finding (verified clean).
- **What was checked:** The brief asked: "does it render correctly (no gap at the corners)?" Answer: yes. The wrapper's `overflow-hidden` correctly clips the footnote's flat bottom corners against the wrapper's rounded outer corners, which is the entire point of `overflow-hidden` on a rounded container. The footnote's `border-t` is a top edge only — it does NOT extend to the wrapper's bottom corners and so doesn't risk a corner-rendering artifact. The CSS clip path is doing its job. There is no visible gap, no half-pixel rendering issue, no border-radius math mismatch.
- **Note:** This is the ONE check the burndown's restructure passes cleanly. Worth recording explicitly because the rounded-clip-corner artifact is a class of bug that DOES exist in DOM-restructured overlays elsewhere; here it doesn't apply.

---

## What carried, what didn't

First-pass findings re-checked against the burndown:

| First-pass # | Topic | Status after burndown |
|---|---|---|
| 1 | Surface token divergence (cc-bg vs cc-card) | **CARRIED — Finding 1 above** |
| 2 | Latest chip drifts from "exp" chip pattern | CARRIED (not in scope for this 2nd pass — files unchanged) |
| 3 | Latest chip muted-on-muted contrast | CARRIED (same) |
| 4 | Trigger `max-w-[14rem]` vs dropdown `max-w-[280px]` mismatch | CARRIED (line 251 and line 264 — same clamps) |
| 5 | Panel lacks `p-1` inner gutter → highlight clips corners | CARRIED + INTERACTS with Finding 2 above (`p-1` would also fix the focus-ring clip) |
| 6 | Footnote `text-[11px]` is a fourth type size | CARRIED (line 331 still `text-[11px]`) |
| 7 | Footnote divider runs corner-to-corner | CARRIED + restated as Finding 4 above with new contributing factors |

Two NEW findings introduced by the burndown's restructure:
- Finding 2 (focus-ring clip by outer overflow-hidden)
- Finding 3 (footnote `<a>` hover-bg matches option-row hover-bg)

One affirmative clean check:
- Finding 5 (corner rendering of border-t inside overflow-hidden — verified OK)

---

## Summary

3 net-new findings carried to this pass: 1 P2 + 2 P3.

The P2 — the surface elevation contract — is the SAME finding as first-pass: the burndown's DOM restructure moved the `bg-cc-bg border-cc-separator rounded-lg` tokens from the listbox onto a new outer wrapper but kept the tokens identical, so the dropdown still renders at the page-surface shade and still diverges from the codebase's overlay convention on all three of background/border/radius. This is the kind of carry-forward shape that ages badly: the restructure SHOULD have been the moment to also snap the tokens to convention since the wrapper is now the visible surface, but it wasn't.

The two new P3s are both consequences of the wrapper/listbox/sibling separation — splitting "rounded clipping surface" from "focused content surface" exposed a focus-ring-clip mismatch (the focus ring renders inside the listbox bounds but the visible surface is the wrapper), and converting the footnote to a hover-tinted `<a>` made its hover state visually indistinguishable from an option-row hover state. Both are micro-issues consistent with Saarinen Principle 9: "quality is the accumulation of small corrections" — the restructure was correct at the semantic layer (footnote out of listbox = SR fix) but introduced two small visual debts at the same time.

Out of scope (deferred to other reviewers):
- Footnote `<a href="#/settings">` href correctness, dropdown-close on click — Friedman
- Footnote moved outside `role="listbox"` correctness — a11y auditor
- Sticky preference / inflight-clobber semantics — covered by other lanes
