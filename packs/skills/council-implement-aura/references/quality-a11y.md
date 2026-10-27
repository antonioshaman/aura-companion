# Accessibility (a11y) Quality Reference — Carmack × a11y Auditor

Philosophy: John Carmack. Specifics: WCAG 2.2, ARIA Authoring Practices Guide (APG), axe-core rule catalogue, Marcy Sutton's screen-reader practice.
Stack context: React 19 + Tailwind 4 + custom components (no Mantine/MUI/Radix). Vitest + `vitest-axe` + `@testing-library/react`. `toHaveNoViolations()` is mandatory on every component test per `CLAUDE.md`. CodeMirror 6 + xterm 6 are embedded surfaces with their own a11y rules. The product is a streaming chat-style interface with permission banners — three accessibility-sensitive idioms in one screen.

Every finding must describe the **concrete user-impact** — not just "axe flagged this." A finding without a real user (keyboard-only, screen-reader, low-vision, motion-sensitive) is decoration.
Visual design quality is in `quality-ui.md` (Saarinen). UX flow is in `quality-ux.md` (Friedman). This doc covers: axe enforcement, ARIA correctness, focus management, keyboard navigation, screen-reader announcements, color contrast, motion preferences, and component-level a11y compliance.

---

## Why this expert exists

CLAUDE.md makes axe assertions mandatory on every new component test. Without a dedicated a11y reviewer, axe rules become a checklist that components weave around (e.g. `aria-hidden=true` to silence warnings instead of fixing the underlying issue). UI/UX experts care about visuals and flow; a11y is the only role that owns the user-with-different-input. The streaming-chat surface specifically — where new content appears live — is a class of UI where screen-reader announcements need design, not just markup.

---

## Principle 1: Axe is a floor, not a ceiling

*Carmack: "Anything that can be mechanically checked should be."*
*axe-core enforces ~50 rules with ~30% WCAG coverage. A clean axe scan means "no auto-detectable violation" — not "accessible." Half of accessibility (focus order, screen-reader announcement clarity, motion appropriateness) is invisible to axe.*

### What to check

**Test passes axe but doesn't actually exercise a11y**
- A render-only test with `toHaveNoViolations()` proves the initial render is clean. It says nothing about: focus management after click, ARIA live region timing, keyboard reachability of interactive elements that only appear on hover, error announcement under screen-reader.
- Severity: **P2** for component tests that only assert axe-on-initial-render. Pair with a behavioural a11y test (keyboard activation, focus assertion, role assertion).

**Axe rule disabled to make a test pass**
- `axe.configure({ rules: { 'color-contrast': { enabled: false } } })` or per-test `disableRules: ['color-contrast']`. Sometimes legitimate (third-party widget cannot meet contrast), but should be rare, justified by comment, and tracked in a debt list. Blanket disabling is hiding the problem.
- Severity: **P1** for unjustified rule-disable. **P2** with a brief comment but no debt tracking.

**`aria-hidden=true` used to silence axe instead of fixing semantics**
- `aria-hidden` on an interactive element makes axe quiet, screen-readers blind, and the component still focusable by keyboard. The user tabs to an "invisible" control with no announcement.
- Severity: **P1** for `aria-hidden` on any focusable element.

---

## Principle 2: Every interactive element is focusable AND has a visible focus indicator

*Carmack: "Deploy assertions as tripwires."*
*Keyboard navigation is the universal substrate — used by screen-readers, motor-impaired users, power users with `Ctrl+Tab`/`Ctrl+`, and any browser without a pointer.*

### What to check

**`<div onClick>` instead of `<button>`**
- `<div>` is not focusable by default. Adding `onClick` makes it visually interactive but invisible to keyboard. axe catches some cases but not all (e.g. `role="button"` on a div without `tabindex`). Always use `<button>` or `<a>` — they get focus, role, and keyboard semantics for free.
- Severity: **P1** for any actionable `<div>` in `Sidebar`, `ChatView`, `MessageBubble`, `ToolBlock`.

**`tabindex=-1` on something that should be tabbable**
- Removes the element from tab order. Sometimes correct (programmatically-focused container), often a mistake (was-focusable, then someone added `-1` to "fix" a visual issue). Audit every `tabindex=-1` for intent.
- Severity: **P2** for unintentional `-1`.

**`outline: none` without replacement**
- Tailwind's reset and many resets remove the browser default focus ring. If `outline: none` is applied without `:focus-visible` styles, sighted keyboard users see nothing on focus. **Catastrophic for keyboard-only users.**
- Severity: **P1** for any global `outline: none` without a replacement focus style.

**Focus indicator that fails 3:1 contrast against the focused element**
- WCAG 2.4.11 (Focus Not Obscured) and 2.4.13 (Focus Appearance, new in 2.2). The focus ring must have ≥3:1 contrast against adjacent colours. A faint grey ring on a dark background fails this and is invisible.
- Severity: **P2** for low-contrast focus rings.

---

## Principle 3: ARIA live regions — announce streaming content deliberately

*Carmack: "If you can't measure it, you can't improve it."*
*The chat surface streams assistant content token-by-token. Without ARIA live regions, screen-readers see a static page until they re-explore it. With wrong live-region semantics, they re-read the entire conversation on every token.*

### What to check

**No live region on streaming output**
- `MessageBubble` (or its container in `MessageFeed`) for in-progress assistant output should be wrapped in `<div role="log" aria-live="polite" aria-atomic="false">` or use `aria-busy` semantics. Otherwise the screen-reader user has no idea content is arriving.
- Severity: **P1** for streaming chat with zero live-region coverage.

**`aria-live="assertive"` on non-critical content**
- `assertive` interrupts the user's current speech. Reserve for genuine emergencies (permission denied, fatal error). Use `polite` for everything else, including assistant responses.
- Severity: **P2** for over-use of `assertive`.

**`aria-atomic="true"` causes whole-message re-read on every token**
- `atomic=true` says "re-read the entire region whenever ANY part changes." For streaming token-by-token, this means re-reading the entire message after every token. Screen-readers become unusable. Set `aria-atomic="false"` on streaming containers — only new content gets announced.
- Severity: **P1** for streaming content with `aria-atomic="true"`.

**Tool calls and tool results not announced**
- When `ToolBlock` renders a new tool call or result, does the screen-reader know? Often these are visually distinct but ARIA-silent. Either include them in the message log live region or announce via a dedicated polite region.
- Severity: **P2** for tool calls invisible to screen-readers.

---

## Principle 4: Focus management on dynamic UI — modals, panels, banners

*Carmack: "Structure should make the intended behavior obvious."*
*When a `PermissionBanner` appears, where does focus go? When it dismisses, where does focus return? Wrong answers strand keyboard users on hidden elements.*

### What to check

**`PermissionBanner` shows without moving focus**
- A permission request is a high-urgency, blocking interaction. Focus should move to the banner (and ideally to the Allow/Deny buttons) so the user can respond without searching. Without focus-move, the keyboard user must Tab through the entire page to reach the banner.
- Severity: **P1** for permission banner appearing without focus-move.

**Dismiss doesn't return focus to the triggering element**
- Closing a modal/panel/banner should return focus to whatever opened it. Otherwise focus falls to `<body>` and the user loses their place.
- Severity: **P2** for missing focus return.

**Focus trap missing on modal-style overlays**
- A true modal must trap focus inside itself (Tab cycles through modal contents only) until dismissed. Otherwise Tab walks off into the page behind. APG `dialog (modal)` pattern is the reference.
- Severity: **P2** for non-trapping modals.

**`autofocus` attribute on every page load**
- Aggressive autofocus disorients screen-reader users (page header is skipped). Use intentionally — e.g. the `Composer` textarea on chat-view load is reasonable. The session-list search field on home page is questionable.
- Severity: **P3** unless autofocus is on a non-obvious element.

---

## Principle 5: Roles, names, and accessible labels — the screen-reader contract

*Carmack: "Names reveal design."*
*Every interactive element needs an accessible name. Icons-only buttons without `aria-label` are unannounced. Roles must match expected interaction patterns from APG.*

### What to check

**Icon-only buttons without `aria-label`**
- `<button><Icon name="close" /></button>` announces as "button" with no name. Either add `aria-label="Close"` or visible text. The CLI status indicators, tool-block expand/collapse, sidebar collapse — all need labels.
- Severity: **P1** for icon-only buttons in primary chrome.

**`role="..."` mismatches the element's behaviour**
- A `role="button"` on something that doesn't respond to `Enter`/`Space` is a lie. The screen-reader user hears "button," presses Enter, nothing happens. Either implement keyboard handlers or use a non-button role.
- Severity: **P2** for role-behaviour mismatch.

**`aria-label` duplicates visible text**
- A button labelled "Save" with `aria-label="Save"` is redundant; on some screen-readers it reads twice. Use `aria-label` only when there is no visible label.
- Severity: **P3** for label duplication.

**Form fields without `<label>` association**
- `<input id="search">` without `<label for="search">` makes the field unlabeled. Placeholder text does not satisfy WCAG (it disappears on focus). axe catches this; the finding is when teams "fix" by adding `aria-label` that drifts from placeholder text.
- Severity: **P1** for unlabeled form fields.

---

## Principle 6: Color contrast — Tailwind defaults are not pre-audited

*Carmack: "Don't build on assumptions you can't verify."*
*Tailwind's stock palette includes plenty of combos that fail WCAG. `text-gray-400` on `bg-gray-50` is below 4.5:1. The same combo on `bg-white` may pass. Never assume a colour pair without measuring.*

### What to check

**Body text below 4.5:1 contrast**
- WCAG 2.1 AA requires 4.5:1 for body text. Audit primary text against actual background — including focused, hovered, and disabled states.
- Severity: **P1** for primary text below 4.5:1.

**Large text below 3:1 contrast**
- 3:1 for large text (≥18pt or ≥14pt bold). axe checks this, but ensure the rule is enabled in test config.
- Severity: **P2** for large text below 3:1.

**Disabled state contrast not assessed**
- Disabled buttons often have intentionally low contrast (≤3:1). WCAG exempts disabled elements from contrast rules, BUT users still need to perceive that a control exists. If a disabled "Save" button is invisible against the panel background, sighted users get confused too.
- Severity: **P3** for severely-invisible disabled states.

**Status colours (success/warn/error) not differentiated beyond colour**
- Colour alone fails for color-blind users. Pair colour with icon, text, or position (e.g. always show "Error" word with red, "Success" word with green).
- Severity: **P2** for colour-only status indication.

---

## Principle 7: Keyboard navigation — every primary action has a shortcut, every shortcut is announced

*Carmack: "Latency is always a bug."*
*Keyboard shortcuts make the product fast for power users AND make it usable for keyboard-only users. The product should expose its shortcuts; hidden shortcuts are worse than none.*

### What to check

**Primary actions reachable only by mouse**
- "New session" button in `Sidebar`, "Allow" on `PermissionBanner`, "Send" on `Composer` — all must be Tab-reachable AND have shortcuts. Composer Cmd/Ctrl+Enter is canonical for chat send; verify it exists.
- Severity: **P1** for primary actions Tab-unreachable.

**Shortcuts conflict with browser/OS reserved keys**
- `Ctrl+W` closes the tab; using it as a shortcut breaks the browser. `Ctrl+F` searches the page; replacing it is a strong action. Check against [W3C reserved shortcut list](https://www.w3.org/TR/wai-aria-practices/#keyboard).
- Severity: **P2** for conflicts with universally-reserved keys.

**Shortcut help not discoverable**
- A `?` overlay listing shortcuts is the standard pattern. Without it, only users who read docs or guess discover them.
- Severity: **P3** unless the product strongly emphasises keyboard use.

**Tab order does not follow visual order**
- The DOM order determines Tab order. If the visual layout (flexbox `order`, `grid`) reorders elements, Tab traverses them in DOM order, which may not match what the user sees. Always test Tab order in actual rendered layout.
- Severity: **P2** for primary-flow tab-order surprises.

---

## Principle 8: Motion preferences and animation safety

*Carmack: "If a mistake is possible, it will eventually happen."*
*WCAG 2.3.3 (Animation from Interactions): respect `prefers-reduced-motion`. Some users get vertigo from parallax, slide, and zoom. Some users on slow devices have animations chug. Both groups need a way out.*

### What to check

**No `prefers-reduced-motion` media query**
- Every keyframe animation, transition, and JS-driven animation should be muted under `@media (prefers-reduced-motion: reduce)`. Streaming text cursor blink, sidebar slide-in, tool-block expand — all should drop or shorten under reduced motion.
- Severity: **P2** for any moderate animation lacking the query.

**Animations longer than 5s without pause control**
- WCAG 2.2.2 (Pause, Stop, Hide). Anything that auto-animates longer than 5s and is non-essential must have a pause control. Streaming token-by-token is essential (it's the content); a marquee or progress carousel is not.
- Severity: **P2** for non-essential animation without controls.

**Flash rates near 3Hz seizure threshold**
- WCAG 2.3.1. Unlikely in a chat-style product, but if anything flashes (e.g. loading dots, error pulse), confirm <3Hz.
- Severity: **P1** if any flash hits the threshold.

---

## Principle 9: Embedded widgets — CodeMirror, xterm, and third-party a11y

*Carmack: "Validate at the boundary."*
*CodeMirror 6 and xterm 6 each have their own keyboard models and ARIA setup. The host app is responsible for the wrapper (label, role, surrounding focus management); the widget owns its internal a11y. Verify the wrapper meets standards even if the widget partially does.*

### What to check

**CodeMirror without `aria-label`**
- The editor renders inside a `contenteditable`-style div. Without a label, screen-readers announce it as a generic editable region. Provide `aria-label` describing what the editor is for ("File contents preview" / "Diff viewer").
- Severity: **P2**.

**xterm terminal not labelled or live-regioned**
- Terminal output streams; without ARIA live, screen-readers don't announce. xterm has built-in accessibility support but requires enabling. Verify the wrapper enables it AND has a sensible label.
- Severity: **P2** for terminal surfaces with no a11y configuration.

**Widget keyboard trap**
- Some widgets capture Tab as part of their internal flow (e.g. CodeMirror Tab inserts indent). Users must have an escape mechanism (typically `Escape` then Tab, or `Ctrl+M` to toggle Tab-handling). Verify the widget allows escape and document it visibly.
- Severity: **P2** for unescapable keyboard traps.

---

## Principle 10: Know your gaps

*Carmack: epistemic humility — you can't fix what you don't know is broken.*

### Areas this doc is weaker on (supplement from other sources)

- **Mobile screen-reader UX**: VoiceOver on iOS and TalkBack on Android have semantics that differ from desktop NVDA/JAWS. The product is desktop-first; mobile a11y is best-effort.
- **Cognitive accessibility**: language complexity, error recovery cognitive load, simplification — partially covered by `quality-ux.md` (Friedman), not deeply here.
- **High-contrast mode (Windows)**: Forced-colors media query. Tailwind doesn't ship a forced-colors theme by default. Verify components don't break in Forced Colors.
- **Manual screen-reader testing**: axe-core cannot catch all real-SR bugs. A 15-minute NVDA/VoiceOver pass per major release is irreplaceable.

---

## Quick Reference: Severity Guide

| Severity | Pattern | Examples |
|----------|---------|----------|
| **P1 — Fix Now** | Keyboard or screen-reader user cannot operate the product | `outline: none` without replacement, `aria-hidden` on focusable element, icon-only buttons unlabeled, permission banner appears without focus-move, streaming with `aria-atomic=true`, no live region on streaming chat, body text below 4.5:1, primary actions unreachable by keyboard |
| **P2 — Fix Soon** | Significant accessibility friction or partial blockers | Component tests only assert axe-on-render, axe rule disabled with comment but no debt, `aria-live=assertive` overuse, modals without focus trap, role-behaviour mismatch, status indicated by colour only, missing `prefers-reduced-motion`, embedded widgets unlabelled |
| **P3 — Consider** | Polish, discoverability, edge profiles | `aria-label` duplicating visible text, autofocus on non-obvious element, shortcut help not discoverable, disabled state too invisible, tab-order surprise in secondary flows |

### The Overriding Filter

Before writing any finding, apply the a11y synthesis:

1. **Can a keyboard-only user complete this task?** If not, P1.
2. **Does a screen-reader user know what's happening when content streams in?** Live regions are not optional in a chat product.
3. **Does focus move where it needs to, and return when it should?** Most a11y bugs are silent-focus-loss.
4. **Did axe pass because it's clean, or because rules were disabled?** Disabled-rule debt is the most common drift class.
5. **Has anyone actually tried this with NVDA/VoiceOver?** axe alone is not a clean bill.
