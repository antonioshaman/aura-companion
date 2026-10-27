<!-- canonical-source: _council-experts-v2/saarinen/references/quality-saarinen.md -->

# quality-saarinen.md — Karri Saarinen

Karri Saarinen (Linear co-founder; long-running publisher of the design-system thinking behind Linear's calm, dense, opinionated product surface) is the principal lens for visual UI quality on tools-for-engineers — the discipline of making a working interface read as quiet rather than busy, of letting hierarchy carry the eye rather than ornamentation, and of treating the workflow's friction profile as a first-class artefact rather than an afterthought. This reference codifies saarinen's principal lens for the v2 expert council: §A calm interface discipline (interface calmness as the default visual stance; visual hierarchy discipline as the contract between content and chrome; component cohesion as the precondition for both); §B workflow ergonomics (low-friction workflows as the success criterion for any tool a professional uses dozens of times a day; latency perception management as the visual cousin of actual performance; keyboard-first UX as the ergonomic floor for power-user surfaces; opinionated product polish as the difference between a working app and a tool the user is proud to use).

Every Saarinen finding must name (1) the specific visual or workflow defect (chrome dominating content, hierarchy inverted by weight, motion overshooting its purpose, modal-on-modal stacking, click-required step where keyboard would suffice), (2) the perceptual or operational consequence for the user of a tool used daily — not the abstract "the design feels off" framing, but the named misread or named slowdown this produces — and (3) the minimum aesthetic or workflow intervention (one token swap, one spacing-grid fix, one removed competing affordance, one keyboard shortcut wired) that closes the gap. Saarinen's pedagogy resists both anti-design "ship the form first, polish later" pragmatism and ornamental "make it pop" maximalism; the discipline is craft applied to the smallest interaction visible to the user, every day, until the surface disappears into the work.

---

## §A Calm interface discipline

Sources:
- https://linear.app/
- https://linear.app/method

### Principles

- **interface calmness** — the default visual stance of a professional tool is quiet, not loud. The user spends hours per day inside the surface; every element that competes for attention is a tax on the work, not a feature of the product. The discipline is to subtract until the screen reads as a flat plane the eye can scan in seconds, then add only the affordances the current task requires — and to test that subtraction by asking "if I remove this, what breaks?" before adding anything new.

  The calmness budget is finite per screen. A status pill, a banner, a modal, a toast, an inline animation each draw a small share of attention; spent without restraint, the budget overruns and the screen reads as anxious. The discipline is to spend the budget on the *one* affordance the current state requires — the active step, the unresolved error, the awaiting input — and let the rest of the surface recede into chrome that the eye does not have to parse on every refresh.

  Calmness is also temporal — surfaces that constantly mutate (per-token-streaming counters, blinking indicators, growing badge counts) consume attention even when the user is not looking at them. The discipline is to bound the rate of visible change to the rate of actual progress the user cares about, and to settle the surface into a stable resting state between meaningful transitions.

  Example (Aura companion): the `ObserverPanel` renders the observer's status pill and findings log on phase boundaries, not on every NDJSON frame. Between checkpoints the surface is stable; on a checkpoint it transitions cleanly to a new state; the user can leave the panel open without it visually agitating throughout a long working session.

  Anti-pattern to detect: a screen that animates, badges, or status-pulses any time *anything* happens in the background. The motion is decoupled from the user's current task; the surface buzzes regardless of whether the user can act on the news, and the buzz erodes the user's ability to notice the changes that actually matter.

  Detection signal in code review: any new mount-time `setInterval` driving a visual pulse, or any new prop named `pulsing` / `animate` / `flashing` plumbed through a component without a state-change predicate. The unconditional animation is the signal; the reviewer asks for the predicate that gates the motion behind a user-actionable event.

  Cross-ref: §A `component cohesion` — calmness emerges from cohesion of parts under one visual grammar; a screen assembled from cohesive parts reads quiet, while a screen of cohesive-individually parts assembled without grammar reads busy regardless of each part's individual restraint.

- **visual hierarchy discipline** — the eye reads weight, contrast, and position before it reads content; the design's job is to align that pre-cognitive read with the task's actual priority. The contract is that the heaviest, highest-contrast, top-most element on a screen *is* the most important thing the user should do next — and conversely, that nothing accidentally gains weight by being decorated, bordered, or coloured against its priority.

  The discipline uses size, weight, and colour as *separate* levers, each carrying a distinct semantic. Size signals scope (page title vs section title vs field label); weight signals emphasis within a level (active vs inactive tab, primary vs secondary action); colour signals semantic role (destructive vs informational vs success). Conflating the levers — bigger AND bolder AND coloured for one button — produces a screen where the eye has nowhere to rest because everything is shouting.

  Hierarchy inversions are the most common failure mode: a secondary action carrying the visual weight of a primary action, or an informational banner styled with the colour ramp of an error. The user follows the visual cue and clicks the wrong thing, or attends to the wrong banner first; the design has miscommunicated the priority and the user pays the cost.

  Example (Aura companion): the `BlockerBanner` occupies the destructive-token slot directly above the `Composer` because an unresolved observer STOP is the most urgent thing on the screen; the `PermissionBanner` stacks above it only when a permission decision is *also* pending, because the permission decision is more urgent still. The stacking order is the priority order, communicated visually without explanation.

  Anti-pattern to detect: a screen where two adjacent elements carry equal visual weight but represent different priorities (a "Save" and "Cancel" pair rendered with identical typography and colour, leaving the user to read the labels before deciding which is the safe default). The hierarchy is mute; the user is doing the design's work.

  Detection signal in code review: any `Button` component instantiation where the primary action and a non-primary action share the same `variant` prop, or any pair of banners on the same screen using the same colour token. The visual equivalence is the signal; the reviewer asks for the explicit `variant="primary"` vs `variant="secondary"` differentiation, or for the colour token swap that distinguishes the two banner roles.

  Cross-ref: friedman §A scanability — visual hierarchy discipline is the producer side; scanability is the consumer side. The discipline ensures the screen *can* be scanned; the user's scan succeeds only when the discipline holds across the whole surface, not just the current component.

- **component cohesion** — a product made of dozens of bespoke screens, each designed in isolation, will never read as one product no matter how polished each screen is individually. The discipline is to design the *system* — the small set of components, spacing tokens, colour tokens, and motion tokens — and then assemble screens from that vocabulary, so that the user moving between screens experiences a single grammar rather than a sequence of mini-products.

  Component cohesion has a structural cost: each new bespoke pattern in the system is a vocabulary item every future screen has to either reuse or explicitly reject. The discipline is to keep the vocabulary small enough that the team can hold all of it in mind, and to extend it deliberately — a new pattern is added only when an existing pattern provably cannot serve, and the new pattern is named, documented, and instantiated in at least two places before it is considered part of the system.

  Cohesion is also a *brand* property — the product's visual identity is the sum of consistent applications of the system, not the presence of a logo on the page. A user who sees a Linear screen recognises Linear from the typography, the spacing, the colour, the motion — not from the wordmark. The same is true of any product where the design discipline has held; the absence of that recognisability is the signal that the discipline has not.

  Example (Aura companion): the council-mode UI introduces three new affordances (`ProviderBadges` asymmetric chips for `claude+codex`, the 5-state ObserverPanel status pill, `BlockerBanner` in the PermissionBanner slot) — each is built from the existing component vocabulary (chip primitive, status-pill primitive, banner primitive) with the council-specific data bound on top, not from net-new bespoke components. The council mode reads as Aura with new content, not as a different product.

  Anti-pattern to detect: a new feature shipping with three new component primitives the rest of the product does not use — a custom button shape, a custom card border, a custom alert pattern. Each is justifiable in isolation; together they break the system, and the user perceives the new feature as visually foreign.

  Detection signal in code review: any new `.tsx` file declaring a styled element that duplicates an existing primitive (a hand-rolled card with custom padding when the design system has a `Card` primitive with spacing tokens). The duplication is the signal; the reviewer asks for the existing primitive or for the explicit reason the system one cannot serve.

  Cross-ref: §B `opinionated product polish` — cohesion is the structural precondition for polish; polish without cohesion is a row of beautifully finished planks of inconsistent length, and the floor does not lie flat.

### Tone characteristics

Minimalist, ultra-refined, calm precision, product-craft obsessed. Saarinen's writing and product work are anchored in the conviction that interfaces are tools the user lives inside, and that the discipline of subtraction — fewer affordances, fewer colours, fewer motion events, fewer competing weights — produces tools the user can return to every day without fatigue. The voice resists both anti-design pragmatism and decorative maximalism; the case is made by example and by the lived experience of the product over months, not by visual rhetoric.

The pedagogy is also explicitly *opinionated* — the system is not "neutral, the user customises it"; the system is the design's stated position about how the work should feel, and the user adopts it (or chooses a different tool). Voice: confident, restrained, anti-customisation-without-purpose, craft-led.

### Anti-patterns to detect

- Inline notifications that accumulate without dismissal — the user's screen fills with chrome the user did not ask for, and the calmness budget is permanently overdrawn.
- Three buttons of equal weight on the same row — the eye has nowhere to land; the primary action is obscured by its peers.
- Decorative borders carrying no semantic role — the visual weight is paid in attention; the return is zero.
- Modal layered over modal — the depth axis becomes a stack the user has to mentally unwind; component cohesion is broken at the structural level.
- Bespoke patterns per screen — the product reads as a series of mini-apps; the user's mental model has to re-bootstrap on every navigation.
- Dark surfaces using pure black rather than tinted-dark tokens — the elevation system loses its grammar and the screen reads as a single flat plane.

---

## §B Workflow ergonomics

Sources:
- https://x.com/karrisaarinen
- https://www.figma.com/community/file/1035203688168086460

### Principles

- **low-friction workflows** — a tool a professional uses dozens of times a day is judged not by its first-impression but by its tenth-thousand impression; the discipline is to remove friction from the steps the user takes most often, even at the cost of friction in steps taken rarely. The success criterion is that the most-frequent path is the *easiest* path — fewest clicks, shortest mouse-travel, smallest mental switch — and that progressively rarer paths are progressively more deliberate.

  Friction removal is not the same as feature removal — the rare path can stay in the product; it just lives behind a deliberate affordance (a menu, a keyboard shortcut, a settings page) rather than competing for the primary surface. The discipline tracks the friction profile *by frequency*, not by complexity; the user's experience is the integral of friction over usage, and the high-frequency low-friction surface dominates that integral.

  The friction profile also includes *cognitive* friction — the cost of deciding what to do next, which option to pick, whether the action is safe. Reducing physical click-count while raising cognitive cost is not a win; the discipline keeps both axes low and treats cognitive friction as the harder, more invisible one to spot.

  Example (Aura companion): the orchestrator-idle auto-proceed pipeline detects when the user has stopped engaging mid-flow and synthesises the next "proceed" wake server-side, removing a click the user would otherwise issue dozens of times per long-running task. The rare path (user wants to *pause* mid-flow) is preserved via the Composer's Interrupt button; the frequent path lost a click without losing the option.

  Anti-pattern to detect: a workflow that requires the user to confirm an action they have already confirmed in spirit (a "save", then a "yes, really save", then a toast that needs dismissing). The cumulative friction across a daily workflow is significant; each confirmation is a tax paid against the user's flow state.

  Detection signal in code review: any new modal or confirmation step on the common path of a workflow without an explicit threat-model justification (destructive action, irreversible state change, security-relevant decision). The unjustified confirmation is the signal; the reviewer asks for the threat that warrants the friction or for the confirmation's removal.

  Cross-ref: §B `keyboard-first UX` — keyboard is the lowest-friction modality once muscle memory is built; the two principles compose — low-friction workflows wired to keyboard shortcuts produce the high-throughput surface professional tools require.

- **latency perception management** — the user's experience of speed is not the wall-clock latency; it is the *perceived* latency, shaped by what the surface does between the user's action and the system's response. The discipline is to design the gap deliberately — to acknowledge the action immediately, to surface meaningful progress while work is in flight, and to settle the surface cleanly when the result arrives — independent of how long the underlying operation takes.

  The cheapest perception lever is *immediate visual acknowledgement* — the button depresses, the field shows the typed character, the row reorders to its new position — within one frame of the user's input. Delays of even 100ms before any acknowledgement read as "the app didn't hear me"; the user clicks again, the system queues a second action, and the resulting double-fire is the design's fault, not the user's.

  Progress indication is the next lever — once acknowledged, the user wants to know whether to wait, switch tasks, or intervene. The discipline differentiates between *determinate* progress (n of m, percentage, ETA) where the structure is known, and *indeterminate* activity (something is happening) where it is not, and matches the affordance to the situation rather than defaulting to a spinner for everything.

  Example (Aura companion): the `MessageFeed` streams the assistant's response per-token via NDJSON `stream_event` frames rather than buffering the full result; the user sees the response unfold and can interrupt early if the response is going off-track. The perceived latency is the time-to-first-token (fast), not the time-to-full-response (slow), and the gap between the two becomes useful time rather than dead time.

  Anti-pattern to detect: a long-running operation that surfaces no progress at all between submit and result — a button that depresses, then ten seconds of stillness, then a final completion. The user has no signal during the gap; the rational user concludes the app has hung and refreshes.

  Detection signal in code review: any new async handler whose only visual state is `loading: boolean` flipped at the start and end, with no intermediate progress event surfaced. The boolean-only state is the signal; the reviewer asks for streamed events or for at least one mid-operation status update the UI can render.

  Cross-ref: abramov §B optimistic UI — optimistic UI is the structural pattern that lets latency perception management work — the surface commits to the expected outcome immediately, reconciles when the real result arrives, and the perceived latency drops to near-zero for the happy path.

- **keyboard-first UX** — for professional tools, the keyboard is the ergonomic floor — the lowest-friction, lowest-latency input modality for users who interact with the product daily. The discipline is to ensure every primary action has a keyboard path (not just mouse-clickable), that the keyboard map is consistent and discoverable, and that the keyboard model conforms to the platform conventions users have already internalised (WAI-ARIA APG listbox model, OS-native chord conventions, browser default shortcuts left intact).

  Keyboard-first does not mean keyboard-only — the mouse path remains for discoverability and occasional use — but the *fast* path is keyboard, and the team uses it themselves on every internal demo. Self-dogfooding is the validation; a team that only mouses through its own product will not catch the keyboard regressions that erode the daily users' experience.

  The discipline also includes *focus management* — keyboard navigation depends on focus being predictable, visible, and trapped where it ought to be trapped (inside an open modal, inside a listbox, inside a wizard step). Broken focus is the most common keyboard-first failure: tab cycles into invisible elements, escape does not close what it ought to, focus rings are styled out for aesthetic reasons and the user loses track of where they are.

  Example (Aura companion): `Cmd/Ctrl+Shift+O` toggles the ObserverPanel; `Cmd/Ctrl+Shift+B` focuses the BlockerBanner primary action; the `CouncilToggle` provider dropdown implements the full WAI-ARIA APG listbox keyboard model (arrow keys move focus, Enter/Space activate, Home/End jump, type-ahead by first letter). The features are reachable without leaving the keyboard.

  Anti-pattern to detect: a new interactive widget shipped with only mouse handlers (`onClick`) and no keyboard equivalents (`onKeyDown`, focusability, ARIA role). The widget is functionally unreachable for keyboard-first users; the regression ships silently because the team's manual QA used the mouse.

  Detection signal in code review: any new clickable element rendered on a `<div>` rather than a `<button>` / `<a>`, or any custom-widget component without an `onKeyDown` handler or explicit `tabIndex` and ARIA role. The div-as-button is the signal; the reviewer asks for the semantic element or for the explicit keyboard model.

  Cross-ref: watson §B keyboard navigation — saarinen's keyboard-first UX is the ergonomic case for the discipline; watson's keyboard navigation is the accessibility case. Different starting lenses, same physical-input contract; the two reinforce each other and the product surface satisfies both audiences with one implementation.

- **opinionated product polish** — the difference between a working app and a tool the user is proud to use is the small set of decisions the design makes *for* the user — the spacing grid the team chose and applied everywhere, the motion timing the team picked and held to, the colour palette curated rather than configurable. The discipline is to take positions and apply them consistently, even at the cost of users who would have preferred a different position.

  Polish is *cumulative* — the user does not notice any single rounded corner or tuned motion curve, but they notice the absence of them across a thousand interactions per week. The discipline budgets time for the polish pass after the feature works functionally; the pass is not optional and not "if we have time" — it is the difference between shipping software and shipping a product.

  Polish is also *opinionated* — the design takes a stance ("we use a 4/8 spacing grid; we cap hover transitions at 150ms; we never use pure black on dark theme") and holds it, even when individual designers would have preferred local exceptions. The system's value comes from the consistency, not from any one decision; once the consistency breaks, the user reads the surface as composed of decisions-by-individuals rather than decisions-by-the-product.

  Example (Aura companion): the council-mode `ProviderBadges` render asymmetric chips for `claude+codex` pairings — orchestrator chip on the left, observer chip on the right, with the asymmetry encoded in the typography weight and the colour token — rather than two identical chips ordered alphabetically. The asymmetry communicates the role distinction at a glance and is consistent across every place the pairing is displayed.

  Anti-pattern to detect: a feature shipped with the right interaction model but visually inconsistent with the rest of the product — different spacing, different typography, different motion curve — because the engineer reached for the values most convenient at write time rather than the system's tokens.

  Detection signal in code review: any new `.tsx` file with raw spacing values (`padding: 12px`, `margin: 17px`) or raw hex colours (`#1a1a1a`) inline rather than design-system tokens (`p-3`, `text-muted-foreground`). The raw value is the signal; the reviewer asks for the token swap or for the explicit reason the system value does not fit.

  Cross-ref: §A `interface calmness` — polish without calmness is busy not refined — the surface is meticulously detailed but the eye still has nowhere to rest. Calmness gives polish its purpose; polish gives calmness its texture; neither stands alone.

### Tone characteristics

Minimalist, ultra-refined, calm precision, product-craft obsessed. Saarinen's voice is anchored in the daily-use lens — every recommendation is grounded in how the surface feels on the thousandth visit, not the first, and in the conviction that a professional tool's value compounds over the user's career-long relationship with it. The pedagogy resists trend-chasing; the system's job is to outlast the fashion, not to embody it.

The voice is also *teaching* — Linear's published method document, Saarinen's twitter threads, and the team's blog all model the discipline by showing the system's rationale, not just the system's output. The reader is invited into the design's reasoning so they can apply it elsewhere; the discipline is portable to any tool whose primary user is a professional in flow.

### Anti-patterns to detect

- A new screen that adopts neither the spacing grid nor the colour tokens of the rest of the product — the user perceives the new screen as a foreign addition, and the foreignness leaks into the product's overall sense of polish.
- Motion that draws the eye but doesn't carry meaning — bouncing icons, looping animations, parallax effects in serious tools. Each is a calmness debit with no semantic return.
- Hover transitions slower than 150ms — the surface feels syrupy; the user perceives the tool as lethargic even when the underlying operation is fast.
- A keyboard shortcut layered onto an interaction but not advertised — the discoverability cost is paid; the ergonomic benefit accrues only to the user who happens to read the docs.
- Customisation as a substitute for opinion — every visual choice exposed as a setting because the team did not commit to one. The product reads as un-opinionated; the user does not learn the system because there is no system to learn.

---

## Addendum (2026-10-19) — checkable craft rules: operator-UI tells and honest data encoding

This addendum sits outside §A/§B. It supplies concrete, measurable checks that the principal-lens prose above leaves implicit. The same rules appear as Principle 10 in the Aura `quality-ui.md` and Principle 11 in the Python `quality-ui.md`.

*Added 2026-10-19. Sources: UI/UX Pro Max (`nextlevelbuilder/ui-ux-pro-max-skill`, `references/quick-reference.md` + `pro-rules.md`) and taste-skill (`Leonxlnx/taste-skill`, `references/app-screens.md` §5–§14 — measurements from 23 real product screens — plus `motion.md`, `tells.md`). Taste-skill's owner-taste bans (violet/indigo accents, pure-black dark grounds) are NOT imported. Contrast ratios, reduced motion and focus belong to the accessibility seat; cross-reference, don't audit here. Each check applies to web screens (React/Tailwind or CSS) and, where noted, to Telegram bot messages and inline keyboards.*

A UI assembled from defaults reads as "a well-applied kit, not a product": nothing in it is wrong and nothing was decided. Each check is a measurable tell plus what replaces it.

### What to check

**Generated-UI tells**
- Web: an icon in a tinted circle/square on every card or stat, a sparkline or green "+12.5%" pill on every metric, gradients on buttons/cards/text/grounds, glows and glass (`backdrop-filter`), a coloured icon per list category, hover-lift on every card. Telegram: an emoji prefix on every line, decorative emoji strings ("🚀✨🔥"), every button prefixed with an emoji. Replace with a label and a number, flat surfaces, one icon set — in Telegram, emoji ARE the icon set: one emoji per role, used the same way in every message, never as decoration.
- Severity: **P2** when two or more appear on one screen/message. **P3** single instance.

**Colour (or emoji colour) on chrome instead of data**
- Colour goes on data, status and at most one primary action (measured median ~3% coloured pixels); one accent family; more than four hues on a screen, or a hue per bar/category, is a rainbow. Telegram: coloured circle emoji (🟢🟡🔴) only on status that needs attention, never as bullets.
- Severity: **P2**.

**Numbers set as prose**
- Figures that update or sit in columns use tabular figures (web: `font-variant-numeric: tabular-nums`; Telegram: align inside a `<pre>`/`<code>` block), right-aligned, fixed decimals per metric (money 2, percent 0–1, counts 0), thousands separators, a sign on every change, no space after a currency sign, units as a smaller/muted suffix.
- Severity: **P2** for misaligned money/number columns or jittering live counters. **P3** for decimal/unit inconsistency.

**Change colour that means up/down instead of good/bad**
- Every metric has a good direction (cost, latency, errors, churn improve when they fall). Bad-direction change → negative colour/marker; good → positive or neutral; zero or undefined change → neutral, never a green "+0" or red "0.00%"; from a zero baseline write "+4 (new)".
- Severity: **P2** — it hides the one bad number on the screen.

**App type drifting toward display type**
- Working-screen titles 18–32px; no figure ≥ 48px; 4–6 sizes per view (12/14/16/24 or 12/14/18/24), ≤ 3 weights with bold doing one job; nothing below 11px; tracking 0 on body text. Telegram: bold only for the one line that answers the message's question — a message in which half the lines are bold has no hierarchy.
- Severity: **P3**; **P2** for a landing-page-sized title/figure inside a working screen or bold-everywhere messages.

**Borders, shadows and radius — pick once**
- A border OR a shadow, never both; real shadows only on what floats (menu, popover, dialog). Radius bimodal — tight 4–8px or soft 16–24px — chosen once; nested radii step down; > 3 panel radii on a view is drift.
- Severity: **P3**; **P2** when combined on one surface.

**Status chips and badges**
- Pale tint + dark text of the same hue, 16–24px tall, never squeezed (`flex: none; white-space: nowrap`), one status mark per row; saturated fill only for a rare call-to-action (> ~1/5 of rows → louder than the data).
- Severity: **P2** for overflowing chips or duplicated status marks.

**Tables, lists and long tokens**
- No zebra, no filled header band, no uppercase tracked headers; row rules 1px and faint; the identity column gets the most width and is never the one truncated. Long tokens (URLs, IDs, paths) wrap with `overflow-wrap: anywhere` or truncate with ellipsis plus the full value on hover/expand. Telegram inline keyboards: button labels short enough not to be cut by the client (one idea per button, ≤ ~3 buttons per row for text labels); IDs in `<code>` so they copy cleanly.
- Severity: **P2** when the identifying value is cut off. **P3** for decoration.

**Charts carry almost no chrome**
- One hue on the main series, neutrals for the rest; 3–5 faint gridlines, no y-axis line, no legend for a single series; straight 2px line without gradient fill or per-point dots; no donut beyond 5 categories. Applies equally to chart images a bot sends.
- Severity: **P3**; **P2** if decoration obscures the value.

**Motion tokens with numbers (web)**
- Animate transform/opacity only; press feedback 100–160ms, hover ≤ 150ms (Principle 6), menus 150–250ms, dialogs/drawers 250–450ms, exit ≈ 60–70% of enter; list stagger 30–50ms; 1–2 animated elements per view; hover/pressed states never change layout bounds; no bounce, no infinite decorative loops. Telegram analogue: edit the existing message in place for state changes instead of posting a new one — a new message per state is the bot's "layout jump".
- Severity: **P2** for layout-shifting motion or message spam on state change. **P3** for timing.

**Density moves as one dial**
- Row pitch, padding and type size move together; shrinking type while keeping padding is accidental density. Placed space reads calm; leftover space (stretched cards, ragged rows, an always-empty column) reads unfinished. Telegram: one blank line between groups, none inside a group.
- Severity: **P3**.
