# Saarinen — UI Quality Review

PR #91 `feat/dynamic-claude-models` — visual review of `ModelSwitcher.tsx` + `pickIcon` in `backends.ts`.

Scope: visual hierarchy, dark-theme elevation, spacing/typography system, token discipline, motion, component visual consistency. NOT a11y, UX patterns, or React architecture.

The PLAN's Risks & Watchpoints addresses sticky-vs-dynamic[0], aria-live regression, Hunt R3 pre-auth oracle, recording exclusion, cache file location, Subprocess probe-spawn — none of those overlap with UI quality. Items below are net-new visual findings or items not explicitly parked.

---

## FINDING 1

- **Title:** Dropdown surface fails dark-theme elevation contract against the canonical sibling pattern
- **File:** `web/src/components/ModelSwitcher.tsx:213`
- **Principle:** Quality-UI Principle 3 — Dark theme is a system (elevation via surface differentiation); Principle 8 — Component consistency.
- **Severity:** P2
- **What's wrong:** The dropdown panel uses `bg-cc-bg border-cc-separator rounded-lg`. In dark mode `--cc-bg = #262624` is the chat/page background — the panel renders the SAME shade as the surface behind it. Every other overlay in this codebase that floats above the chat surface (`CouncilToggle` listbox at `CouncilToggle.tsx:352`, `Composer.tsx:472,517`, `LinearAgentEditor.tsx:184,210`, `Playground.tsx:2202`) consistently uses `bg-cc-card border-cc-border rounded-[10px] shadow-lg` — `cc-card = #141413` is the recessed-surface idiom this product uses to establish depth in dark mode. ModelSwitcher diverges on all three tokens: background (`cc-bg` vs `cc-card`), border (`cc-separator` vs `cc-border`), and radius (`rounded-lg` = 8px vs `rounded-[10px]`). With shadow-lg alone carrying the entire elevation load and no surface contrast against the chat behind, the dropdown reads as a floating outline rather than a distinct elevated surface.
- **Consequence:** In dark mode the menu visually melts into the chat behind it on hover-of-message-area, leaving only the shadow ring; users perceive a soft "halo" rather than a confident overlay. Two listbox dropdowns in the same app (CouncilToggle vs ModelSwitcher) read as belonging to different design systems.
- **Fix:** Snap to the project's overlay convention — replace `bg-cc-bg border-cc-separator rounded-lg` with `bg-cc-card border-cc-border rounded-[10px]`. Cross-ref the `CouncilToggle.tsx:346-352` comment "Saarinen council review #14: dropdown radius snapped to project's rounded-[10px] shadow-lg convention" which already enshrines this exact rule for the other listbox in the codebase.

---

## FINDING 2

- **Title:** "Latest" badge styling drifts from the existing "exp" chip pattern — two semantic micro-chips, two visual treatments
- **File:** `web/src/components/ModelSwitcher.tsx:245-249`
- **Principle:** Quality-UI Principle 8 — Component consistency (tokens, not one-offs); Principle 5 — Color via tokens, semantic roles.
- **Severity:** P3
- **What's wrong:** The new "Latest" chip uses `text-[10px] uppercase tracking-wide text-cc-muted px-1.5 py-0.5 rounded border border-cc-separator`. The pre-existing sibling chip "exp" inside CouncilToggle (`CouncilToggle.tsx:325-329`) uses the same dimensional formula but adds `font-mono-code` AND uses a tinted role (`bg-cc-info/10 text-cc-info border-cc-info/15`). The micro-chip is the same primitive in both places (compact uppercase tag for an earned signal), but rendered with two distinct color strategies (muted-on-separator vs tinted-info) AND two type stacks (default vs mono). On the same visual stratum (a label next to a row item), the user reads two different "kinds of chip" when there's only one semantic kind.
- **Consequence:** Quiet inconsistency — neither chip is wrong on its own, but viewed side-by-side ("exp" on the New Session pairing dropdown vs "Latest" on the per-row model dropdown) they betray two designers' hands. As Saarinen notes, quality is the accumulation of corrections — micro-chip styling is exactly the surface where drift hides.
- **Fix:** Pick one chip pattern for "small uppercase tag, earned signal, not destructive" and reuse it. Two reasonable directions: (a) align "Latest" to the existing "exp" formula, swapping `cc-info` for `cc-primary/10 + cc-primary + cc-primary/15` so newest-model still reads as the product's accent (and adopt `font-mono-code`); or (b) extract both into a shared `<Chip variant="..." />` primitive in `web/src/components/` and migrate both call sites. Option (a) is the smaller correction; option (b) prevents the next chip from drifting again.

---

## FINDING 3

- **Title:** "Latest" chip reads as flat muted-on-muted — no earned-signal weight against the row's own muted label
- **File:** `web/src/components/ModelSwitcher.tsx:245-249`
- **Principle:** Quality-UI Principle 2 — Typography is the primary hierarchy tool (size+weight+color, not size alone).
- **Severity:** P3
- **What's wrong:** Non-selected, non-active rows render label text in `text-cc-muted`. The "Latest" chip is ALSO `text-cc-muted` on a `border-cc-separator` border (separator at `rgba(222,220,209,0.08)` in dark mode is almost invisible). So the chip's three signals (text color, border color, background) all sit at or below the row label's contrast level. The label uses size+weight+(muted)color; the chip uses size+uppercase+(same muted)color. The hierarchy lever for "this is the newest one" is doing about the same visual work as "this is a regular dropdown row label" — the badge recedes instead of inviting the user toward the newer model.
- **Consequence:** Users scanning a 5-7 item Claude list for "what's new" don't catch the badge in peripheral vision; the discoverability goal of Friedman R1 (sticky preference stays sticky, BUT the new option is visible) softly fails because the visible signal is too quiet to draw the eye.
- **Fix:** Lift the chip one contrast notch — keep the border quiet but bump the text to `text-cc-fg/70` OR tint with `text-cc-primary` (the brand orange). The chip should be quieter than the selected-row checkmark but louder than the row's own muted body text. Cross-check against Saarinen Principle 3 "accent overuse" — one badge per tier, ≤3 tiers, is precisely the kind of "reserve accent for earned moments" case where the brand color is warranted.

---

## FINDING 4

- **Title:** Trigger label `max-w-[14rem]` exceeds dropdown `max-w-[280px]` clamp — trigger can render wider than the menu it opens
- **File:** `web/src/components/ModelSwitcher.tsx:201` vs `:213`
- **Principle:** Quality-UI Principle 4 — Spacing/sizing creates meaning (systematic scale); Principle 9 — Pixel-level polish.
- **Severity:** P3
- **What's wrong:** Trigger label has `max-w-[14rem] truncate` (14rem = 224px) on top of the trigger's `h-8 px-2` + icon + chevron (roughly +44px of chrome). At max label-width the trigger button can render around 268px wide. The dropdown clamps to `min-w-[180px] max-w-[280px]`. These two widths are technically compatible (280 ≥ 268) but only barely — and the dropdown is `right-0` anchored. For typical Anthropic display_names ("Claude Sonnet 4.6" ~ 130px) the dropdown opens at its `min-w-[180px]` floor, narrower than the trigger label. Result: the dropdown's left edge appears INSIDE the trigger's left edge, with the trigger label peeking out to the left of the menu — visible misalignment between the trigger's text-start and the dropdown's leftmost option's text-start. Both elements are in the user's foveal vision at the moment of click; the offset is the kind of pixel drift Saarinen Principle 9 catalogues.
- **Consequence:** Subtle but present: clicking a trigger and seeing the dropdown's left edge land somewhere INSIDE the label feels uncalibrated — particularly when the bottom-bar dropdown's purpose is "show me the menu for this label I just clicked." The spatial promise of "the menu starts where the trigger started" is broken.
- **Fix:** Two routes. (a) Sync the clamps: change dropdown `min-w-[180px]` to either match the trigger label's clamp range (`min-w` ≥ trigger render width) OR drop the trigger's `max-w-[14rem]` to `max-w-[12rem]` (192px) so the dropdown's 180px floor is always wider than the truncated trigger. (b) Position the dropdown to match the trigger's full bounding box (e.g. `left-auto right-0 min-w-[100%]`) so the dropdown's width grows to AT LEAST the trigger's width regardless of clamps. Option (b) is the more durable rule.

---

## FINDING 5

- **Title:** Dropdown grows from 3 → 7 items but loses the project's inner-padding ring — items render edge-to-edge to the panel border
- **File:** `web/src/components/ModelSwitcher.tsx:213` (panel) vs `:229` (row)
- **Principle:** Quality-UI Principle 4 — Spacing creates meaning; Principle 8 — Component consistency.
- **Severity:** P3
- **What's wrong:** The canonical listbox pattern in this codebase (`CouncilToggle.tsx:352`) wraps items in a panel with `p-1` (4px inner gutter) so highlighted rows show a small inset from the border. ModelSwitcher's panel has NO inner padding — rows are `px-3` then run directly to the panel's border at top/bottom. With 7 items + `max-h-[24rem]` + `overflow-y-auto`, the first row's `bg-cc-active` (selected) or `bg-cc-hover` (active) extends ALL the way to the rounded panel corner; the rounded corners visibly clip the highlight square. The no-key footnote at the bottom has `border-t` but no `mb-` from the panel bottom either — it sits against the rounded corner.
- **Consequence:** At the scroll boundary, the highlight color clips into the panel's rounded corner — instead of a calm inset rectangle floating inside the panel, the highlight visually fights the panel's border-radius. Especially jarring when the user is arrow-keying through 7 items and the highlight reaches index 0 or index 6.
- **Fix:** Add `p-1` to the panel container AND swap the row's `rounded-` setting to `rounded-md` so the highlight sits as an inset chip inside the panel. The no-key footnote should keep its `border-t` separator but live INSIDE the `p-1` ring — i.e. it becomes a quiet inset row at the bottom rather than a flush bar. Mirror CouncilToggle's structure exactly so the two listboxes stop diverging.

---

## FINDING 6

- **Title:** No-key footnote uses `text-[11px]` — a non-systematic typography lever (the page elsewhere settles on text-[10px] / text-[12px] / text-[13px])
- **File:** `web/src/components/ModelSwitcher.tsx:264`
- **Principle:** Quality-UI Principle 2 — Type style proliferation; Principle 4 — Systematic scale.
- **Severity:** P3
- **What's wrong:** The footnote uses `text-[11px] text-cc-muted px-3 py-2`. The trigger sits at `text-[12px]`, the row labels at `text-[13px]`, the "Latest" chip at `text-[10px]`. Introducing 11px adds a fourth distinct size on a single overlay (10/11/12/13) — Tailwind's `text-xs = 12px` exists for exactly this; the design system's reach into the dropdown should compress, not expand. The footnote is quiet, which is correct (it's a discoverability hint, not a required action), but quietness should come from color/weight rather than a one-off size.
- **Consequence:** Small but real type-scale drift; on the same overlay the eye now negotiates four sizes when three would do the same hierarchy work. Sets a precedent for the next discoverability footnote elsewhere to pick its own size, too.
- **Fix:** Drop `text-[11px]` to `text-[10px]` (matches the chip) OR to `text-xs` (12px, matches the trigger label). Keep the muted color + the `border-t cc-separator` rule above; quietness is already carried by the color contrast and the divider.

---

## FINDING 7

- **Title:** Footnote divider uses `border-cc-separator` but the panel uses no inner padding — the divider runs the full panel width and visually splits the entire overlay
- **File:** `web/src/components/ModelSwitcher.tsx:264` (footnote with border-t) combined with `:213` (panel padding absent — see Finding 5)
- **Principle:** Quality-UI Principle 4 — Spacing communicates grouping; Principle 9 — Pixel-level polish.
- **Severity:** P3
- **What's wrong:** Because the panel has no inner gutter (Finding 5), the footnote's `border-t border-cc-separator` runs corner-to-corner across the panel — visually it reads as cutting the panel in two halves (top: list, bottom: footnote) of comparable visual weight rather than the intended "primary content + quiet footer hint." Combined with the row's flush-to-corner highlight (Finding 5), the dropdown's bottom region looks like a separate sub-panel rather than a trailing hint.
- **Consequence:** Discoverability footnote inflates visually beyond its quiet-hint role; it reads almost as important as "a model row" because of the divider's reach.
- **Fix:** Once Finding 5 is applied (add `p-1` ring), the footnote's `border-t` should inset by the panel padding so the divider stops short of the rounded corners. Alternatively, drop the `border-t` entirely and let the spacing (`mt-1 pt-2` on the footnote) do the grouping work — Saarinen Principle 4: "Increase between groups, reduce within." Spacing-as-separator is quieter than a line.

---

## Summary

7 findings: 1 P2, 6 P3. No P1.

P2 is the elevation/surface divergence — ModelSwitcher's dropdown diverges from the codebase's established overlay convention (`bg-cc-card border-cc-border rounded-[10px]`) on all three of background/border/radius, leaving the menu without surface contrast against the dark chat surface behind it. This is the same finding the CouncilToggle dropdown comment at `CouncilToggle.tsx:346-352` explicitly addressed for the sibling listbox.

The P3 cluster all live in pixel-level polish space and concentrate around the dropdown overlay: chip styling drift vs the existing "exp" pattern, contrast level of the "Latest" badge, trigger-vs-dropdown clamp interaction, panel inner padding, footnote sizing and divider reach. Saarinen Principle 9: "Quality is the accumulation of corrections" — five micro-issues on one overlay signal the surface needs a polish pass rather than a one-off fix.

Out of scope (deferred to other reviewers):
- APG keyboard model, scroll-into-view focus discipline → a11y auditor
- "Latest" badge text wording, footnote copy → Friedman
- `useMemo` / `latestPerTier` set construction → React/Web UI
