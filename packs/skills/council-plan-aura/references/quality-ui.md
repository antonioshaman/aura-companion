# UI Quality Reference — Carmack × Karri Saarinen

Philosophy: John Carmack. Specifics: Karri Saarinen (Linear, Airbnb DLS) + Steve Schoger (Refactoring UI).
Stack context: React 19 + Tailwind 4 + custom components (no Mantine/MUI/Radix). CodeMirror 6 for code-like surfaces, xterm 6 for terminal. Dark theme. The product is a streaming chat UI with side panel for sessions, task list, permission banner, and embedded CodeMirror/xterm surfaces.

Every finding must describe the **concrete visual consequence** — not just "this doesn't follow the system."

**Scope boundary:** Visual design quality. NOT accessibility (covered by `quality-a11y.md`), NOT UX patterns/flows (`quality-ux.md`), NOT performance.

---

## Principle 1: Reduce noise to reveal hierarchy

*Carmack: "Simple code." Every unnecessary element is potential confusion.*
*Saarinen: "From a visual standpoint, these tools had a lot of noise."*

### What to check

**Chrome competing with content**
- Sidebar, top bar, panel headers using bright colours, heavy borders, large type that visually competes with the chat content. Chrome should recede.
- Severity: **P2** for chrome competing with content. **P1** if it makes primary data hard to find.

**Decorative elements without function**
- Gradients in chrome, playful icons, rounded-bubbly elements. "If I'm building a house, I want my tools to be good, not fun."
- Severity: **P3** for decorative that doesn't interfere. **P2** if it takes space from data.

**Alignment inconsistencies**
- Icons not vertically centered with labels, list items with drifting left edges, action buttons at inconsistent positions.
- Severity: **P3** for minor drift. **P2** for visible misalignment in primary UI.

---

## Principle 2: Typography is the primary hierarchy tool — not size alone

*Saarinen: "90% of UI is text."*
*Schoger: "A common mistake is relying too much on font size."*

The three levers: size, weight, colour/contrast — used in combination.

### What to check

**Size as the only hierarchy lever**
- Secondary text differentiated only by being smaller. Should also be lower-contrast (text-zinc-400 vs text-zinc-100) or lighter weight.
- Severity: **P2** for hierarchy on size alone. **P3** if readable but weak.

**Too many type styles**
- More than ~6 distinct type treatments across a view. Tailwind makes it easy to drift to `text-sm`/`text-base`/`text-lg`/`text-xl` × `font-normal`/`font-medium`/`font-semibold`/`font-bold` → 16 combos. Define a small set in CSS variables or a typography component.
- Severity: **P3** for proliferation.

**Monospace not used for code/data**
- Inline code, file paths, IDs, tool names — should use the mono stack (Tailwind: `font-mono`). Signals "data, not prose" and aligns numerals.
- Severity: **P3** but high polish-payoff.

**Labels dominating data**
- "Status: Active" with `Status:` in bold and `Active` in regular — inverts the hierarchy. The data is what matters.
- Severity: **P2** in data-dense views.

---

## Principle 3: Dark theme is a system — opacity and elevation, not specific colours

*Saarinen: "Opacities of black and white during explorations." Linear uses LCH and generates from three inputs.*
*Schoger: "Avoid pure black."*

### What to check

**Pure black backgrounds**
- `bg-black` / `#000000` on primary surfaces. Use near-black (`bg-zinc-950` / `#0a0a0a`) for less eye strain.
- Severity: **P2** for pure black on primary surfaces.

**No elevation hierarchy**
- Modals, dropdowns, panels using the SAME background as the page behind. In dark theme elevation = lighter surface; without it overlays are indistinguishable from base.
- Severity: **P1** for modals indistinguishable from page. **P2** for missing intermediate levels.

**Harsh borders**
- Opaque white-ish borders create wireframe feel in dark theme. Use semi-transparent overlays (`border-white/10`) or rely on background differentiation.
- Severity: **P3** secondary. **P2** if borders dominate.

**Accent colour overuse**
- Accent (Aura's purple/blue) on every interactive element flattens hierarchy. Reserve for primary actions, active states, brand moments.
- Severity: **P2** for accent on every link/button. **P3** for moderate overuse.

**Fully saturated semantic colours**
- Reds/greens/blues at full saturation against dark backgrounds create hot-spots. Desaturate.
- Severity: **P2** for full-sat semantics. **P3** for minor tuning.

---

## Principle 4: Spacing creates meaning — systematic scale

*Saarinen: "Grid 8, and the 24 spacing affected our type styles."*

### What to check

**Arbitrary spacing values**
- Tailwind has a scale built in; arbitrary values (`p-[13px]`, `m-[17px]`) bypass it. Off-scale values pile into visible drift.
- Severity: **P3** occasional. **P2** for no system.

**Spacing not communicating grouping**
- Schoger: "Increase between groups, reduce within." Same space between section header and content as between unrelated sections fails proximity.
- Severity: **P2** for uniform spacing that makes grouping ambiguous.

**Density without system**
- Linear-style density: tight vertical, generous horizontal. If list items feel cramped (text touching, no padding), density is accidental.
- Severity: **P2** for cramped density.

**Line-heights not grid-aligned**
- Body line-height should snap to the spacing grid. Tailwind defaults usually do this; custom values may not.
- Severity: **P3** refinement.

---

## Principle 5: Color via tokens — semantic roles

*Carmack: "Type system prevents flaw classes." Token system prevents visual flaw classes.*
*Saarinen: Linear's tokens split by role — Bg, Label, Control × Base/Shade/Muted/Faint.*

### What to check

**Raw hex / Tailwind arbitrary colours**
- `bg-[#1a1a1a]` instead of `bg-zinc-900`. Each arbitrary breaks the token system.
- Severity: **P2** widespread. **P3** occasional.

**No semantic role tokens**
- Tailwind out of the box gives `slate`, `zinc`, `gray` — palette, not role. The codebase should define semantic vars (`--bg-base`, `--label-muted`, `--control-default`) on top so a re-theme doesn't require touching every component.
- Severity: **P2** for no role tokens.

**Inconsistent colour for same semantic**
- "Secondary text" rendered as `text-zinc-400` in one place, `text-zinc-500` in another. User feels inconsistency.
- Severity: **P2**.

---

## Principle 6: Motion confirms action — never decorate, never delay

*Carmack: "Latency is a bug."*
*Saarinen: "Almost everyone said they hate when tools are slow."*

Linear's standard hover transition is 150ms.

### What to check

**Animations that delay interaction**
- A slide-in panel that blocks click for 300ms. The destination must be interactive immediately.
- Severity: **P1** for blocking animations. **P2** for >300ms on frequent interactions.

**Inconsistent timing**
- One hover fade is 100ms, another is 200ms. Pick a value, stick with it.
- Severity: **P3** minor. **P2** if visible on the same view.

**State changes without transition**
- Item appears/disappears instantly. Brief fade or slide aids spatial continuity.
- Severity: **P3** — never add animation for animation's sake.

**No optimistic UI on safe actions**
- Toggling a setting waits for server round-trip with a spinner. Cross-reference `quality-ux.md` Principle 3.
- Severity: **P2** for safe-action waits.

---

## Principle 7: Shadows and elevation — defined levels

*Saarinen: four levels — Low (buttons), Medium/High (boxes), Float (modals).*

### What to check

**No defined elevation levels**
- Box shadows ad hoc per component. Tailwind shadows exist; pick which corresponds to each elevation.
- Severity: **P3** for no system. **P2** if same-elevation components have different shadows.

**Dark theme elevation without background diff**
- Cross-reference Principle 3 — in dark theme, shadow alone is insufficient.

---

## Principle 8: Component consistency — tokens, not one-offs

*Saarinen: "The Linear design system is no design system team, no councils, just colors, type, icons and components."*

### What to check

**Same component, multiple visual versions**
- Buttons with different padding, border-radius, type treatment across views. Build a shared Button component with variants, use it.
- Severity: **P2** for visible inconsistency in core components.

**No central token file**
- Tailwind config + a small CSS variables file should hold every token. If colours, spacings, shadows are duplicated across components, drift is guaranteed.
- Severity: **P2** for no central tokens.

**One-off styles repeated across components**
- The same pattern (e.g. session-list row) implemented in three places. Extract.
- Severity: **P3** maintenance.

---

## Principle 9: Quality is the accumulation of corrections

*Saarinen: "Quality doesn't happen on its own. Linear tracks quality issues with a dedicated label. Over 1,000 small fixes in two years."*

### What to check

**Layout shifts on interaction**
- Adding a message bumps the scroll. Expanding a tool block jumps the layout. Use `min-height` or reserve space.
- Severity: **P1** for shifts on primary interactions. **P2** secondary.

**Inconsistent hover/focus states**
- Some interactive elements have no hover; some have a hover that flashes.
- Severity: **P2** for missing hover on interactive. **P3** for inconsistency.

**Pixel-level polish issues**
- Text overflow without ellipsis, scrollbars appearing unexpectedly, content touching edges.
- Severity: **P3** individually. Note count — 5+ on one view signals systematic neglect.

---

## Principle 10: Operator-UI craft — remove generated-UI tells, encode data honestly

*Added 2026-10-19. Sources: UI/UX Pro Max (`nextlevelbuilder/ui-ux-pro-max-skill`, `references/quick-reference.md` + `pro-rules.md`) and taste-skill (`Leonxlnx/taste-skill`, `references/app-screens.md` §5–§14 — measurements from 23 real product screens — plus `motion.md`, `tells.md`). Taste-skill's owner-taste bans (violet/indigo accents, pure-black dark grounds) are deliberately NOT imported: they contradict Aura's accent and Principle 3. Contrast ratios, reduced-motion and focus rules stay with `quality-a11y.md` (watson).*

A UI assembled from defaults reads as "a well-applied kit, not a product": nothing in it is wrong and nothing was decided. Each check below is a measurable tell plus what replaces it.

### What to check

**Generated-UI tells on working screens**
- An icon in a tinted circle/square on every card or stat; a sparkline or green "+12.5%" pill on every metric; gradients on buttons, cards, text or grounds; glows, glass, `backdrop-blur` panels; a coloured icon per list category; "hover lift" on every card. Replace with a label and a number, flat opaque surfaces one tone step apart, one grey icon set.
- Severity: **P2** when two or more appear on one view (the screen reads as a template). **P3** for a single instance.

**Colour on chrome instead of data**
- Colour belongs on data, status and at most one primary action; the measured median is ~3% coloured pixels. Active nav item = neutral pill or brighter label, not an accent-filled row plus a coloured left bar. One accent family per screen; more than four hues on one view (or a hue per bar/per tool type) is a rainbow.
- Severity: **P2** for accent-filled chrome or >4 hues. Extends Principle 3 "Accent colour overuse".

**Numbers set as prose**
- Any figure that updates or sits in a column (token counts, cost, durations, timers, context %) uses `tabular-nums` (or the mono stack) so digits don't jitter while streaming. Numeric columns are right-aligned with headers flush to their values; fixed decimals per metric (money 2, percent 0–1, counts 0), thousands separators, units as a smaller muted suffix ("5,400 tok", "2 m 24 s"). Every right-aligned figure in a card/row ends on one right edge.
- Severity: **P2** for jittering live counters or left-aligned numeric columns. **P3** for decimal/unit inconsistency.

**Change colour that means up/down instead of good/bad**
- Every metric has a good direction (latency, cost, errors, context-used are better when they fall). A change in the bad direction gets the negative token; good direction gets positive or muted. A zero or undefined change is muted, never a green "+0" or red "0.00%"; from a zero baseline write "+4 (new)".
- Severity: **P2** — a rise in errors shown in the same colour as a rise in throughput hides the bad news.

**App type drifting toward display type**
- Working-screen h1 18–32px; no figure ≥ 48px. 4–6 sizes per view (clean scales: 12/14/16/24, 12/14/18/24), ≤ 3 weights with 700 doing one job; nothing below 11px; tracking 0 on body text, negative tracking only on large type. Line-height 20px for 14px text, 24px for 16px. On dark surfaces use at most two secondary greys and keep them visibly apart (three near-identical greys read as one grey used three ways).
- Severity: **P3** for scale drift. **P2** for a landing-page-sized title or figure inside the app shell. Tightens Principle 2 "Too many type styles".

**Borders, shadows and radius — pick once**
- A surface gets a 1px border OR a shadow, never both. Real shadows only on what floats (menu, popover, tooltip, dialog, composer). Radius is bimodal — tight 4–8px or soft 16–24px — chosen once; nested radii step down; more than three panel radii on one view is drift. A uniform 12–16px radius on everything is a generated default.
- Severity: **P3** individually; **P2** when border+shadow+mixed radii combine on one surface. Extends Principles 7–8.

**Status chips and badges**
- Pale tint with dark text of the same hue (dark theme: the hue on a dark tint of itself), 16–24px tall. Chips never squeeze (`shrink-0 whitespace-nowrap`) — a collapsed chip with its word spilling out is a defect. One status mark per row (a tag and a badge saying the same thing is noise). A saturated fill with white text only for a rare call-to-action; once more than ~1/5 of visible rows carry it, it becomes a stripe louder than the data.
- Severity: **P2** for squeezed/overflowing chips or duplicated status marks. **P3** for saturated pills.

**Tables and lists: rules and alignment, not decoration**
- No zebra striping, no filled header band, no uppercase-tracked headers (12px muted sentence case instead). Row rules, where used, are 1px and only slightly darker than the surface. The identity column (session name, file path, tool name) gets the most width and is never the one truncated first. Long tokens (paths, IDs, URLs) wrap with `overflow-wrap:anywhere` inside a `min-w-0` flex child, or truncate with ellipsis plus the full value on hover/expand — never `break-all` on prose.
- Severity: **P2** when the identity column is the one cut off or long paths overflow their container. **P3** for zebra/header-band decoration.

**Charts carry almost no chrome**
- One hue on the main data element, neutrals for the rest; 3–5 faint gridlines, no y-axis line, no legend for a single series; a 2px straight line without gradient fill or a dot on every point; a thin ring, not a fat labelled donut, and no donut beyond 5 categories. Colour never the only encoding (cross-ref watson).
- Severity: **P3** for chart chrome. **P2** if decoration obscures the value the chart exists to show.

**Motion tokens with numbers**
- Animate `transform`/`opacity` only — never width/height/top/left (layout-shift cousin of Principle 9). Press feedback 100–160ms; hover ≤150ms (Principle 6); menus/popovers 150–250ms; dialogs/drawers 250–450ms; exit ≈ 60–70% of enter. List stagger 30–50ms per item, 1–2 animated elements per view at most. Hover/pressed states never change layout bounds. No bounce easing, no infinite decorative loops. Reduced-motion fallback → watson.
- Severity: **P2** for layout-property animation or press states that shift layout. **P3** for timing outside the bands.

**Density moves as one dial**
- Density = row pitch + padding + type size moved together; shrinking the type while keeping the padding is accidental density. Placed space (a fixed grid, repeated gaps) reads calm; leftover space (a card stretched to its neighbour's height, cards in one row ending at different heights, a column empty in every row) reads unfinished.
- Severity: **P3**; **P2** if a dead band or ragged row sits in the primary view. Extends Principle 4 "Density without system".

---

## Quick Reference: Severity Guide

| Severity | Pattern | Examples |
|----------|---------|----------|
| **P1 — Fix Now** | User can't parse the interface, spatial relationships broken, interaction blocked | Modals indistinguishable from page, content invisible from contrast failure, animations blocking input, layout shifts on primary interactions |
| **P2 — Fix Soon** | Hierarchy degraded, consistency broken, interface feels rough | Chrome competing with content, no elevation system, raw hex everywhere, inconsistent components, accent overuse, harsh borders, pure black, labels dominating data, no semantic tokens |
| **P3 — Consider** | Polish, systematisation, refinement | Off-grid spacing, type style proliferation, alignment drift, missing hover, pixel overflow, monospace not used, single-use shadow values |

### The Overriding Filter

1. **Can the user immediately see what's important?** Flat hierarchy = flag.
2. **Is colour/spacing/typography systematic or ad hoc?** Arbitrary values = flag.
3. **Does dark theme feel like a surface or a void?** Missing elevation = flag.
4. **Would this feel fast?** Animations that delay = flag.
5. **Is quality consistent across views?** One polished, others rough = flag.
6. **Does it read as decided or as a kit?** Generated-UI tells, colour on chrome, numbers set as prose = flag (Principle 10).
