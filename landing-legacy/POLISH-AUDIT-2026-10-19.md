# auraco.space landing — polish audit (2026-10-19)

Scope: `landing-legacy/site/index.html` (RU) and `landing-legacy/site/en/index.html` (EN).
This is a polish pass, not a redesign. Content, section order, copy, anchors (`#why`, `#paths`, `#cases`,
`#skills`, `#council`, `#opensource`, `#free`, `#start`, `#faq`, `#support`, `#shots`, `#release-version*`)
and the live "phosphor-green terminal" brand stay as they are. The two pages share one identical `<style>` block,
and they still do.

This file sits outside `site/`. `deploy-timeweb.sh` rsyncs only `$SITE_DIR/` (= `landing-legacy/site/`),
so this audit and `landing-legacy/screenshots/` are never published.

Checklists used: UI/UX Pro Max (`quick-reference.md` §1 a11y, §4 style, §5 layout, §6 type/colour, §7 animation;
`pro-rules.md` contrast and pressed-state rules), taste-skill (`tells.md`, `motion.md`), and the council distillations
`quality-ui.md` / `quality-ux.md` Principle 10. Like the council, I did not apply taste-skill's owner-taste bans
on the accent colour family; the brand stays as it is.

Note on brand: the brief said "purple/blue accent", but the live page (sha-identical to `main`) is
phosphor green (`--amber: #00ff70`) on near-black, set by the "90s machine / Matrix terminal retheme" layer.
I kept the green brand that is live. The purple/brown/orange values left in the base layer were removed
because they came from the pre-retheme warm theme.

## Findings and changes

| # | Rule (source) | Finding (before) | Change |
|---|---|---|---|
| 1 | color-contrast 4.5:1 (Pro Max §1, §6) | `--text-dim #3a7d4f` measured 4.2:1 on the page ground and **3.5:1 on cards**. It is used for captions, proofs, footer meta and the "…ещё 13 навыков" rows. | `--text-dim` → `#4f9a68` (6.1:1 ground / 5.0:1 cards). Captions and stat labels that carry content now use `--text-mute` (7.6–9.1:1). |
| 2 | color-contrast; badge legibility (UI P10 "chips") | The "Флагманский кейс / Flagship case" badge was green text on a green gradient, so it could not be read. A retheme `!important` rule overrode the badge's dark text. | Flat accent pill with dark text (`#001206`). The badge is no longer in the `!important` colour override. |
| 3 | One type system (taste type; UI P2/P10 "≤3 weights, few sizes") | `Cormorant Garamond` was never loaded, so 17 rules fell back to a system serif: agent-box names, step numerals "01/02/03" (italic, gradient), OSS stats, preview glyphs. That gave mixed serif and mono on the same page. | Every `Cormorant` reference is now `inherit`, so the self-hosted JetBrains Mono is used everywhere. Italic on the mono face is gone (it was synthesized). Step numerals and stats are now solid accent, `tabular-nums`. |
| 4 | Hero headline ≤2–3 lines (taste structural tells) | RU h1 at 1440 wrapped to **4 lines** and broke after the hyphen ("ИИ-" / "СИСТЕМЫ"). | `clamp(25px, 6.9vw, 66px)`, wider measure, `text-wrap: balance`, and "Сложные ИИ-системы." kept on one line (`.nobr`, released below 360px). Result: 2 lines on desktop and mobile. |
| 5 | Pill badge above hero, pulsing status dot (taste second-wave tells) | Pill badge with a blinking dot above the h1. | The text stays (it is the key RU message) as a plain lead line with a static dot. |
| 6 | Emoji as icons; icon-in-rounded-square on 3 identical cards (taste first-wave; Pro Max `no-emoji-icons`) | 💬⚡🔓 tiles on the audience cards, 🌐💬🤖 in the Razumai links, 🎁🔓❤️ on the "free" cards. | Emoji removed. Cards lead with their title. |
| 7 | Duplicated affordance | RU "Смотреть RazumAI → →": the arrow was in the text and also in `::after`. | Arrow removed from the text, which now matches EN. The CTA is sentence case instead of tiny tracked uppercase. |
| 8 | Gradient/glow CTA buttons; one primary per view (taste; Pro Max `primary-action`) | Gradient fills plus coloured glow shadows on nav CTA, OSS button, Razumai primary link and donate buttons, with `translateY` hover lifts. | Flat accent fill with dark text, `brightness` hover, `scale(.98)` press. One filled primary per block; the rest stay ghost. |
| 9 | Hover lift on every card (taste motion tells; UI P10) | Audience paths, preview cards, experts and showcase links lifted on hover. | No lift. Border and background tone change only (the cards are links, so feedback stays). |
| 10 | Leftover warm theme in a green brand (UI P10 "one accent family") | Brown and orange tints in the header ground, showcase, council box (mauve glow), opensource box, terminal ground (`#060403`), "pairs" cards, roadmap note (mauve), screenshot frames. | All replaced with green-tinted or neutral grounds one tone step from the page (`--ground-deep #020803`). The decorative council glow blob is removed. |
| 11 | Status colour means something (UI P10) | The STOP tag was green with white text (2.1:1) on a warm banner, so a "stop" read the same as "ok". | STOP uses red `#ff5f57` with dark text and a red rule, matching the app's STOP finding. This is colour on data, not chrome. |
| 12 | Radius picked once (UI P10 "borders/shadows/radius") | 9 different radii (10/12/14/16/20/24/28/32…). | Tokens: `--r-lg 24` (big section panels), `--r-md 16` (cards), `--r-sm 10` (buttons, small tiles), plus 999 pills. |
| 13 | Spacing rhythm (Pro Max `spacing-scale`) | The "video coming soon" box sat flush against the next card row (0px gap). Section-sub to grid spacing varied (56/36). | `.why-video + .why-grid` gets 40px. Section-sub is 48px (36px on mobile). Mobile section padding is 72px and card padding 22px. |
| 14 | Skill rows were uneven | Short descriptions sat inline next to the command and long ones wrapped under it, so rows were ragged. | Every row is now the command chip, then the description. |
| 15 | Council flow boxes ragged | Orchestrator and observer boxes had different heights. | Stretched to equal height. The arrow stays centred. |
| 16 | Infinite meaningless loops (taste motion; Pro Max `excessive-motion`) | Ambient blobs drifting (30s/35s), logo pulse and ring, "sun" glow pulse, hero dot blink. | All removed. The glows are static. The carousel is the only moving element and it already pauses on hover, focus and reduced motion. |
| 17 | `prefers-reduced-motion` (Pro Max §1/§7; taste §8) | Only the carousel respected it. Smooth scroll and all transitions ran regardless. | Global reduced-motion block: no smooth scroll, near-zero animation and transition durations. Remaining easings use `--ease-out` (quint-out); hover 180ms, UI 240ms. |
| 18 | Keyboard operability (Pro Max `keyboard-nav`, `focus-states`) | FAQ questions were `<div onclick>`: no keyboard access and no state. No global focus ring. | FAQ questions are `<button type="button" aria-expanded>`, and `toggleFaq` updates `aria-expanded`. Global `:focus-visible` ring uses the accent. Carousel buttons are 40×40. |
| 19 | Mobile layout (Pro Max `horizontal-scroll`, gutters) | The header `.nav { padding: 18px 0 }` overrode `.wrap`'s side gutters, so the logo and lang switch were flush to the screen edges at 390 and "EN" was clipped. The footer overflowed at 360 (long e-mail). | The nav keeps the 24px gutters. The MIT badge is hidden ≤420px. Footer columns get `min-width:0` and `overflow-wrap:anywhere`, and the about column spans the row on mobile. No horizontal scroll at 360/390/768 (checked `scrollWidth == clientWidth`). |
| 20 | Glow intensity / legibility | Strong CRT glow on all headings and a scanline overlay at 0.55 over text and screenshots. | Kept (brand) but softened: heading glow 5px/0.35, accent 6px/0.45, scanlines 0.4. |
| 21 | Dead code / weight (Pro Max performance) | Phone-mockup CSS, the full pricing/promo CSS and JS (fake promo codes) and an unreachable "sign up" modal that `alert()`ed and printed "we e-mailed you". None of it was reachable since the project became free. | Removed. Inline-styled "free" and "donate" blocks moved to classes. RU `index.html` 115.5 KB → 101.2 KB, EN 101.2 KB → 90.2 KB. |
| 22 | Dead link | RU footer "Поддержка" pointed to `#`. | Points to GitHub Issues (github.com was already linked on the page; no new origin). |

## Constraints checked

- No new external origins. The set of `http(s)://` origins in both pages is unchanged (auraco.space, github.com, t.me,
  razumai.space, bun.sh, pay.cloudtips.ru, plus the `localhost:3456` example). No fonts, scripts, images or CSS from other hosts.
  Fonts are still the self-hosted `/fonts/jetbrains-mono-*.woff2`.
- No new images in `site/`. Total `site/` size: 1,934,791 → 1,909,579 bytes (−1.3%).
- HTML tag balance is clean in both pages. All ids kept except the five that belonged to the removed modal.
- Telemetry and analytics: none on the page. The `release.json` same-origin fetch and the carousel script are untouched.
- Not deployed. `deploy-timeweb.sh` was not run.
