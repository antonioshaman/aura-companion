# Saarinen — Visual UI Quality Review (Council Mode, Phase F)

Reviewer lane: visual design quality only — colour tokens, spacing, typography hierarchy, dark-theme elevation, motion, shadows, component visual consistency, pixel-level polish. Reviewed components: `council/ObserverPanel.tsx`, `council/BlockerBanner.tsx`, `council/DegradedBanner.tsx`, `council/CouncilToggle.tsx`, `council/FindingsLog.tsx`, `council/ProviderBadges.tsx`, plus the changed regions in `Sidebar.tsx`, `TopBar.tsx`, `HomePage.tsx`.

Token system: confirmed `cc-bg | cc-fg | cc-card | cc-primary | cc-muted | cc-border | cc-error | cc-warning | cc-info | cc-codex | cc-hover | cc-active | cc-sidebar | cc-separator` in `web/src/index.css`. No new colour tokens introduced in Phase F (PLAN watchpoint passes). The five Council components reuse the existing semantic palette.

Conventions honoured (not re-flagged): AP-1..3, EC-1..9.

---

## P1 findings

None. Nothing in this scope hides primary information, blocks input, or makes overlays indistinguishable from the page beneath.

---

## P2 findings

### S-P2-1 — Dark-theme `cc-warning` (#f6e05e) reads as a hot yellow hot-spot on the `bg-cc-warning/8` DegradedBanner surface

**File:** `web/src/components/council/DegradedBanner.tsx:75-110`

**Visual consequence:** In dark mode, `--color-cc-warning` is `#f6e05e` — a saturated highlighter yellow. The DegradedBanner uses it in five concurrent surfaces simultaneously: `border-cc-warning/25`, `bg-cc-warning/8`, the icon tile (`bg-cc-warning/15 border-cc-warning/30`), the "Observer offline" label at `text-cc-warning font-semibold`, and the Respawn button (`bg-cc-warning/15 text-cc-warning`). Five overlapping warning tints — even at low alpha — accumulate into a visible yellow plate in the panel header. Compared with `bg-cc-info/5` in the same panel's first-run hint (`ObserverPanel.tsx:223`) the contrast is jarring: the info hint feels embedded, the warning feels stuck on top. Saarinen P3 ("Fully saturated semantic colours create hot-spots — desaturate").

**Why it matters here:** the DegradedBanner is supposed to be the *quiet* infrastructure channel — the loud destructive channel is BlockerBanner. Today they read at roughly equal visual weight because cc-warning at full saturation against `cc-card` (`#141413`) competes with cc-error (`#fc8181`) at the same alphas in BlockerBanner. The intended hierarchy (blocker = louder than degraded) is collapsed.

**Recommendation:** Either desaturate `--color-cc-warning` in dark mode (`#f6e05e` → something closer to amber-300 `#fcd34d` or warmer-muted), or drop the label colour to `text-cc-fg` and rely on the icon + tinted background alone to carry the warning role. Keep the destructive vs warning distinction visible by saturation, not by alpha alone.

---

### S-P2-2 — Inconsistent banner animation: BlockerBanner fades in (200ms), DegradedBanner appears instantly

**Files:** `web/src/components/council/BlockerBanner.tsx:53` (`animate-[fadeSlideIn_0.2s_ease-out]`), `web/src/components/council/DegradedBanner.tsx:70-76` (no animation attribute).

**Visual consequence:** Two sibling banners in the same feature, both surfaced asynchronously from a backend event, behave differently on mount. The BlockerBanner slides+fades; the DegradedBanner pops in. When both arrive within the same render frame (a STOP arriving for a session whose pair has just gone degraded), the eye catches the banner that *animated* and misses the one that didn't — exactly the opposite of what the channel-separation goal asks for. Saarinen P6 ("Inconsistent timing — pick a value, stick with it"; P2 for "visible on the same view").

**Recommendation:** Either give DegradedBanner the same `animate-[fadeSlideIn_0.2s_ease-out]` or drop it from BlockerBanner. The `animate-fade-in` (200ms) utility already exists in `index.css:119-121` and is the project's lighter fade alternative if `fadeSlideIn` is too theatrical for an in-panel banner. The `prefers-reduced-motion` guard at `index.css:355-362` will handle the a11y case in either direction.

---

### S-P2-3 — `bg-cc-warning/8` uses an off-scale opacity value; the rest of the file uses 5/10/15/25

**File:** `web/src/components/council/DegradedBanner.tsx:75`

**Visual consequence:** Tailwind's opacity scale steps in 5s (`/5 /10 /15 /20 /25`). The DegradedBanner background is `/8`, which is arbitrary and not used anywhere else in this component or in the sibling council files. The neighbouring `border-cc-warning/25`, `bg-cc-warning/15`, `border-cc-warning/30` all sit on the scale. The `/8` is invisible to the user as a single value but is a token-system leak — the next person editing this file has no anchor for what "subtle warning bg" means and will pick a different non-scale value.

**Recommendation:** Snap to `/10` (or `/5` if the current density is too strong — see S-P2-1). This is the kind of single-line fix that compounds over time; Saarinen P4 ("Quality is the accumulation of corrections").

---

### S-P2-4 — Status-pill typography: secondary metadata uses size + `font-mono-code` but identical contrast to the primary label

**File:** `web/src/components/council/ObserverPanel.tsx:62-104` (StatusPill)

**Visual consequence:** Each non-"never-checkpointed" pill renders a primary label (e.g. "Sleeping" at `text-xs font-medium`) followed by `· {state.lastPhase}` at `text-[10px] font-mono-code`. The sleeping/blocker pills set the metadata to `text-cc-muted`, but the *reviewing* pill at line 79-83 keeps both halves coloured `text-cc-primary` until the inline span specifically overrides to `text-cc-muted` at line 81-82 — and `text-[10px] font-mono-code text-cc-muted` reads at the same contrast as the primary `text-cc-primary` text-xs label in dark mode (`cc-muted: #c2c0b6` vs `cc-primary: #d97757` are different *hues* at similar perceived lightness against `#141413`). Two levers (size + family) are used but the colour lever isn't differentiated cleanly because the primary uses a saturated brand colour. Saarinen P2 ("hierarchy on size alone — should also be lower-contrast or lighter weight").

**Why it matters here:** the metadata ("phase: implementing") is supposed to read as ambient context; today it competes with the state name because the muted hue and the primary hue are at similar perceptual luminance. The result is the pill looks busy — three text fragments instead of "Reviewing · implementing".

**Recommendation:** Make the metadata genuinely lower-contrast: `text-cc-muted/70` or drop weight from `font-medium` (primary) so the secondary inherits no extra weight. Better still, give the StatusPill its own composition primitive that enforces "label = primary colour / metadata = muted-on-card" once.

---

### S-P2-5 — CouncilToggle dropdown breaks the project's dropdown-radius convention

**File:** `web/src/components/council/CouncilToggle.tsx:233`

**Visual consequence:** Every other `shadow-lg` floating panel in the app uses `rounded-[10px]` or `rounded-xl` (verified across `Composer.tsx:426,471`, `HomePage.tsx:953,986,1060,1151`, `LinearSection.tsx:533,569`, `BranchPicker.tsx:99`, `AgentEditor.tsx:417,443,543`, `LinearAgentEditor.tsx:184,210`, `Playground.tsx:2018`). The CouncilToggle pairing listbox uses `rounded-md` (6px). On a 4/8 grid this is a 4px drift — small in isolation, but the user lands on the New Session page and sees this dropdown next to the BranchPicker and the Folder picker, all of which round to 10. The Council surface immediately reads as "designed by a different person." Saarinen P8 ("Same component, multiple visual versions — visible inconsistency in core components").

**Recommendation:** Change `rounded-md` → `rounded-[10px]` on the listbox container at line 233 to match the prevailing shadow-lg-with-listbox treatment.

---

### S-P2-6 — `[exp]` (cc-info) and `unavailable` (cc-muted) chips share size/shape/weight; only hue differentiates them — and they can co-occur on the same row

**File:** `web/src/components/council/CouncilToggle.tsx:111-121`

**Visual consequence:** The two chips next to a pairing option are visually identical except for tint: both `text-[10px] uppercase tracking-wide font-mono-code px-1.5 py-0.5 rounded` chips. When the `claude+codex` option is disabled due to a missing CLI, both chips render side by side: `[exp]` in `cc-info` (saturated blue `#63b3ed` in dark mode) and `[unavailable]` in `cc-muted` on `cc-border`. The eye reads two equivalent-looking pills and has to *decode the colour* to know which is informational and which is the blocking reason. Worse: `cc-info` blue against `cc-muted/10 cc-border` is the louder of the two, so the experimental affordance dominates the unavailability affordance — exactly inverted hierarchy. Saarinen P2 ("Labels dominating data in data-dense views").

**Recommendation:** Make the "unavailable" chip carry the destructive role for this surface (cc-warning or cc-error at low alpha), or — better — collapse to one chip when the option is disabled. "unavailable" is the operative state; "[exp]" is metadata about a thing the user can't pick. Suppress `[exp]` when `!available`.

---

### S-P2-7 — Severity dot uses pure-saturation `bg-cc-error` against `bg-cc-card` — same hue at full saturation appears in three places at once

**Files:** `web/src/components/council/FindingsLog.tsx:58-66, 82`, `web/src/components/council/BlockerBanner.tsx:59`, `web/src/components/council/ObserverPanel.tsx:131`

**Visual consequence:** For a single unresolved STOP finding, dark mode renders cc-error (`#fc8181`) at full saturation in: (1) the FindingsLog severity dot (`bg-cc-error`), (2) the rail counter badge (`bg-cc-error/15 text-cc-error border-cc-error/25`), (3) the BlockerBanner icon (`text-cc-error` over `bg-cc-error/10 border-cc-error/25`), (4) the StatusPill dot (line 88, `bg-cc-error`), and (5) the BlockerBanner "Open evidence" CTA tint. All five live in the same viewport. cc-error at `#fc8181` is already softened from the light-mode `#c53030`, but at full saturation in 2-3 spots simultaneously the visual register saturates and the user's eye no longer ranks them. Saarinen P3 ("Accent colour overuse — accent on every interactive element flattens hierarchy").

**Recommendation:** Reserve full-saturation cc-error for the BlockerBanner icon (the one canonical "loud" element) and step down to `bg-cc-error/70` or muted tints for the dot in the FindingsLog row and the StatusPill. The audit-trail signal still lands at a glance, but the eye gets a real anchor (the banner) instead of five competing anchors. This pairs with S-P2-1: blocker should be louder than degraded — pick the loudest spot intentionally instead of saturating every error surface.

---

## P3 findings

### S-P3-1 — Severity dot is 8px (w-2 h-2) in FindingsLog and StatusPill but 6×6mm in the rail counter context; the icon-tile sizing across banners drifts

**Files:** FindingsLog `w-2 h-2`, StatusPill `w-2 h-2`, ObserverPanel collapsed-rail counter chip `min-w-[18px]` (no dot, just a number), BlockerBanner icon container `w-7 h-7 sm:w-8 sm:h-8`, DegradedBanner icon container `w-6 h-6`.

**Visual consequence:** Banners are intentionally different sizes (Blocker is louder, Degraded is quieter — good). But the *dot* size for severity ought to be uniform across the StatusPill and the FindingsLog row, and it is — they're both `w-2 h-2`. The downgraded dot at `FindingsLog.tsx:75-80` carries a `border` whereas the regular dot does not; the border adds 1px of outer extent, so the downgraded dot reads ~10px vs the regular 8px in the same column. Subtle but visible at hover scan: rows drift visually by 2px at the leading edge.

**Recommendation:** Wrap the downgraded marker in a fixed-size box (`w-2 h-2` with the border *inside* via `box-sizing: border-box`, or use `outline` instead of `border` so layout extent is unchanged). Tailwind 4 `outline outline-1 outline-cc-muted/40 outline-offset-0` is the one-liner.

---

### S-P3-2 — `font-mono-code` for `· {state.lastPhase}` is excellent intent but the separator `·` itself is also rendered as mono — gives the separator equal type weight to the data

**File:** `web/src/components/council/ObserverPanel.tsx:67, 81, 90`

**Visual consequence:** Pattern is `<span text-xs>Sleeping</span> <span text-[10px] font-mono-code>·</span> <span text-[10px] font-mono-code>{state.lastPhase}</span>`. The middle-dot in monospace sits awkwardly between proportional text and another mono fragment — and it's coded as a separate span with its own classes when it's purely typographic glue. Saarinen P2 ("Too many type styles — define a small set"). Three spans for one phrase is over-engineered for what reads as "label · data."

**Recommendation:** Move the `·` into the data span's prefix and drop a span: `<span class="text-[10px] font-mono-code text-cc-muted">· {state.lastPhase}</span>`. Same render, half the DOM, no separator-as-typography.

---

### S-P3-3 — ObserverPanel header `Observer` eyebrow + ProviderBadges share the header row but live at different type levels — uppercase 10px with `font-mono-code` against `compact` provider chips at `text-[10px] uppercase tracking-wide font-mono-code`. The chips and the eyebrow are at identical type style.

**File:** `web/src/components/council/ObserverPanel.tsx:186-201`

**Visual consequence:** "OBSERVER" eyebrow at `text-[10px] uppercase tracking-wider font-mono-code text-cc-muted` and the ProviderBadges compact chips at `text-[10px] px-1.5 py-0.5 rounded-md` with `font-mono-code uppercase tracking-wide` — they ARE the same type style with a different background. The eyebrow loses its hierarchy distinction from the chips. Saarinen P1 ("Chrome competing with content — P2 if hierarchy degraded").

**Recommendation:** Either (a) drop the eyebrow entirely (the chips themselves communicate "observer / orchestrator providers"), or (b) bump the eyebrow to `text-[11px]` and slightly different tracking, or (c) move the eyebrow to a different colour role (e.g. `text-cc-fg/60` without uppercase, more like a quiet section label). The current treatment is two visually-identical pieces sitting next to each other.

---

### S-P3-4 — FindingRow `transition-colors` on hover is fine; the dismiss-button `opacity-0 group-hover:opacity-100` is correct; but the `· {formatRelativeTime}` timestamp is `font-mono-code text-cc-muted` and rendered as the last item on the row — it's the same type style as the severity label `STOP` at the row's leading edge

**File:** `web/src/components/council/FindingsLog.tsx:123-138`

**Visual consequence:** Row layout: `[dot] [STOP] [claim text] [maybe downgraded chip] [timestamp] [maybe ×]`. The severity label and the timestamp share `text-[10px] uppercase tracking-wide font-mono-code`. The user's eye, scanning a list, sees five mono-code uppercase fragments per row instead of one. Saarinen P2 — proliferation. The timestamp is data-ish but it's not categorical; it doesn't need uppercase tracking treatment.

**Recommendation:** Drop the uppercase tracking on the timestamp — keep it `text-[10px] font-mono-code text-cc-muted` only. The leading severity label is the categorical thing; the trailing time is just a numeric.

---

### S-P3-5 — Sidebar archive-confirm Council preview uses `bg-cc-error/10 border-cc-error/25` for "archive Council pair" but the destructive emphasis only fires for Council sessions; solo sessions get `bg-cc-warning/10 border-cc-warning/20`

**File:** `web/src/components/Sidebar.tsx:618-671`

**Visual consequence:** Branching the colour role by content-type (Council = error, solo = warning) is correct intent — archiving a pair is destructive of two halves while solo is reversible — but the **size of the visual jump** between the two surfaces is large (cc-error vs cc-warning are entirely different hue families). For a user who creates both kinds of sessions, the archive-confirm sometimes appears red, sometimes amber, with the same overall layout. Saarinen P5 ("Inconsistent colour for same semantic — secondary text rendered as text-zinc-400 here, text-zinc-500 there"). The semantic here is "confirm archive" — the destructive variant should be a *more emphatic* version of the same role, not a different colour family.

**Recommendation:** Keep both surfaces in the cc-warning family but bump the Council variant: e.g. `bg-cc-warning/15 border-cc-warning/35` + a small inline cc-error icon for the "both halves" warning, or escalate type weight on the headline ("Archive Council pair?" already bold — that alone could carry the emphasis). Reserving cc-error for the *consequence* (the "Archive pair" button itself, which already uses cc-error) is the cleaner contract.

---

### S-P3-6 — `text-cc-fg/85` (Sidebar.tsx:640) is the only `/85` colour stop in the council surface

**File:** `web/src/components/Sidebar.tsx:640`

**Visual consequence:** Single occurrence of `/85` against an otherwise 100/70/60/40 ladder elsewhere in the file. Same off-scale concern as S-P2-3 but smaller blast radius (one line). Saarinen P3.

**Recommendation:** `text-cc-fg/80` to land on the project's existing palette.

---

### S-P3-7 — DegradedBanner spinner uses `border-2 border-cc-warning/30 border-t-cc-warning` ring; the rest of the council surface has no other spinner so there's no inconsistency to flag — but the spinner *colour* doubles down on cc-warning at a moment when the "respawning" verbal label is also cc-warning, the chip background is cc-warning/15, and the icon is cc-warning. Four warning surfaces stacked.

**File:** `web/src/components/council/DegradedBanner.tsx:89-91`

**Visual consequence:** Same family as S-P2-1, smaller. Saarinen P3 ("Accent overuse, moderate").

**Recommendation:** Keep the spinner's track at `border-cc-muted/20` (neutral) and only the moving arc cc-warning. Same readability, one fewer warning surface.

---

## Notes (no finding)

- **Elevation system holds in dark mode.** `cc-card` (`#141413`) on `cc-bg` (`#262624`) gives the BlockerBanner/DegradedBanner the closer-surface treatment Saarinen P3 calls for. No pure-black usage detected in scope. The ObserverPanel as a sibling of ChatView (not a modal) correctly avoids elevation noise.
- **No raw hex / arbitrary colours introduced.** Every colour reference in the six new components and the three integration touchpoints resolves through the `cc-*` token system.
- **Motion respects `prefers-reduced-motion`.** The global rule in `index.css:355-362` covers the 200ms BlockerBanner fade and the 200ms CouncilToggle dropdown grid-template-rows animation.
- **No new "review yellow," no harsh borders.** PLAN watchpoint passes. All borders use `border-cc-border` (semi-transparent overlay) or semantic-token-at-alpha. No opaque whites.
- **Spacing scale honoured for CouncilToggle.** `px-3 py-2.5` outer, `gap-3` inner — sits cleanly on the 4/8 grid as the plan specified (12 / 10 px reads as off-grid at 2.5 but Tailwind's `py-2.5 = 10px` is on the 4-grid, just below the 8-grid step; consistent with the rest of the form on HomePage).
- **ProviderBadges sizing is consistent across TopBar (compact) and ObserverPanel header (compact passed in by parent at `ObserverPanel.tsx:189`).** The `default` size variant exists but is unused in this Phase — flagged only because it's defined and not referenced, but that's a Fowler-lane concern, not a visual finding.

---

## Summary

7 P2, 7 P3, 0 P1. The Council Mode visual surface is largely on-system — token discipline holds, no new colours were minted, spacing and elevation respect the project conventions, and the dark-theme cards layer correctly. The recurring theme of the P2 findings is **the saturated semantic palette is being asked to do too much at once**: cc-warning lights up five surfaces in the DegradedBanner, cc-error lights up five places when a STOP arrives, and the inversion (blocker should outweigh degraded) is collapsed by alpha-stacking the same hue. Desaturating cc-warning in dark mode, reducing the cc-error footprint to one canonical loud surface, and snapping off-scale opacities to the existing system are the three highest-leverage corrections.
