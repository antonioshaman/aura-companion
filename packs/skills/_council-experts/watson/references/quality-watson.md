<!-- canonical-source: _council-experts-v2/watson/references/quality-watson.md -->

# quality-watson.md — Léonie Watson

Léonie Watson (director of TetraLogical; long-running W3C participant; one of the most influential voices on screen-reader compatibility, ARIA correctness, and the operational realities of using assistive technology daily) is the principal lens for accessibility quality on Aura's aura-specific surfaces — the discipline of treating WCAG as a floor rather than a ceiling, of validating assistive-technology behaviour empirically rather than by axe-checkbox, and of designing every dynamic surface for the screen-reader user from the first commit rather than retrofitting after the visual UI ships. This reference codifies watson's principal lens for the aura-only v2 expert council: §A Assistive technology compatibility (screen-reader compatibility as the empirical test of an interface's a11y story; semantic HTML as the structural baseline that ARIA layers onto, not replaces; ARIA correctness as the contract every dynamic surface must hold); §B WCAG operationalization (keyboard navigation as the ergonomic floor for the a11y audience that overlaps with the keyboard-first power-user audience; contrast compliance as a continuous discipline against tonal drift; accessible interaction flows as the dynamic-state equivalent of accessible markup; WCAG operationalization as the engineering practice that turns guideline into commit-time gate).

Every Watson finding must name (1) the specific accessibility defect (div-as-button, missing alt text, focus ring styled out, contrast 4.4:1 where 4.5:1 is required, aria-live missing on streaming region, focus trap absent on modal), (2) the operational consequence for the named assistive-technology user — a screen-reader user encountering an unannounced state change, a keyboard-only user unable to escape a modal, a low-vision user losing the focus indicator in a dark-theme palette — and (3) the minimum intervention (one semantic-element swap, one ARIA attribute, one focus-management hook, one contrast-token bump) that closes the gap. Watson's pedagogy resists both axe-passes-therefore-accessible reductionism ("the linter said it was fine") and over-ARIA "first rule of ARIA is don't" violations (rich ARIA scaffolding bolted onto malformed HTML produces worse screen-reader experiences than plain semantic markup with no ARIA at all).

---

## §A Assistive technology compatibility

Sources:
- https://tink.uk/
- https://www.w3.org/WAI/

### Principles

- **screen-reader compatibility** — the empirical test of an interface's accessibility story is whether a screen-reader user can complete the surface's primary tasks with the same fluency a sighted keyboard user can; everything else (axe pass, WAVE green, "we added ARIA") is a leading indicator at best and a vanity metric at worst. The discipline is to run the surface against a real screen reader (NVDA on Windows, VoiceOver on macOS/iOS, TalkBack on Android) on the actual user flows, with the audio on, and to listen for the moments where the announcement is wrong, missing, redundant, or hostile to navigation.

  The mechanics that screen readers actually consume are (in order): the accessible name (computed from `aria-label`, `aria-labelledby`, label association, or the element's text content), the role (computed from the native element or `role` attribute), the state (selected, expanded, disabled, busy), and the value (for inputs and ranges). Each layer can fail independently; an `aria-label` that contradicts a `<label>` element, a `role="button"` on a `<span>` with no keyboard handler, a `aria-disabled="true"` that does not actually prevent focus — each of these reads as a usability defect to the screen-reader user even when axe sees nothing wrong.

  Dynamic content adds the announcement axis — what the screen reader says when something *changes* without the user's focus moving. Live regions (`aria-live="polite"` or `aria-live="assertive"`) are the contract that "this part of the page may update; please announce changes"; the discipline is to use live regions sparingly on content the user actually needs announced, with `aria-atomic="false"` when the change is additive (new log entries, new chat tokens) so only the new content is announced rather than the entire region re-read.

  Example (Aura companion): the `FindingsLog` inside `ObserverPanel` carries `role="log"` + `aria-live="polite"` so the screen-reader user is notified when a new observer finding lands without the entire panel being re-announced on each entry. The CLAUDE.md test mandate requires `toHaveNoViolations()` on every component test (axe floor) plus behavioural focus-management tests on every interactive component (ceiling), so the contract is validated at both layers.

  Anti-pattern to detect: a component that visually communicates a state change (a badge appears, a spinner starts, a banner stacks) with no corresponding accessible announcement. The sighted user sees the change; the screen-reader user is left wondering whether anything happened, and the surface has communicated to only half its audience.

  Detection signal in code review: any new dynamic component (streaming feed, status pill, banner) without `aria-live`, without `role="status"` / `role="log"` / `role="alert"`, and without an explicit comment justifying why announcement is not needed. The absent announcement is the signal; the reviewer asks for the live region or for the justification.

  Cross-ref: §A `ARIA correctness` — screen-reader compatibility is the behavioural test; ARIA correctness is the markup discipline. Both must hold for the test to pass; either alone produces a surface that fails the audience it was meant to serve.

- **semantic HTML** — the first rule of ARIA is "don't use ARIA" — use the native HTML element whose default role, keyboard behaviour, and accessibility tree exposure already match what you want, and reach for ARIA only when no native element fits. The discipline rewards markup that is correct *before* any ARIA is added; ARIA layered onto incorrect semantic markup produces compounded defects that are harder to diagnose than the bare visual-only div-soup the team is trying to upgrade away from.

  The native elements come with extensive default behaviour the framework cannot easily reproduce: `<button>` is focusable, activates on Enter and Space, fires synthetic click events from keyboard, exposes `role="button"`, gets correct accessibility-tree placement on every screen reader; a `<div>` styled to look like a button needs all of that hand-rolled, and the hand-roll is wrong in subtle ways the team only learns about when a real user reports a problem. The same is true of `<a>` for navigation, `<input type="checkbox">` for toggles, `<details><summary>` for collapsible regions, `<dialog>` for modals (where supported), and the form elements as a class.

  When ARIA *is* warranted (custom widgets the platform does not provide — listbox, combobox, treeview, tabs), the discipline is to follow the WAI-ARIA Authoring Practices (APG) patterns exactly — the keyboard model, the focus management, the announcement choreography — rather than improvising. The APG patterns are the result of years of iteration with screen-reader users; ad-hoc ARIA produces ad-hoc failures.

  Example (Aura companion): the `CouncilToggle` provider dropdown implements the full WAI-ARIA APG listbox keyboard model — arrow keys move focus among options, Enter/Space activate the focused option, Home/End jump to first/last, type-ahead selects by first character — rather than rolling its own keyboard handlers. The implementation is portable to every screen reader because every screen reader has learned the listbox pattern from the APG.

  Anti-pattern to detect: a custom widget built from `<div>` and `<span>` elements with hand-rolled `onClick` handlers and either no ARIA at all or improvised ARIA that doesn't match any APG pattern. The widget is functionally inaccessible; the engineer is also paying to re-implement behaviour the platform already ships for free.

  Detection signal in code review: any new interactive component declared on `<div role="...">` or `<span role="...">` when a native element with matching default role exists. The element-mismatch is the signal; the reviewer asks for the native swap or, if a custom widget is genuinely warranted, for the APG pattern reference being followed.

  Cross-ref: friedman §B form usability — semantic HTML is the structural floor that form-usability builds on; an inaccessible form is also a less-usable form even for sighted mouse users, because the platform's native input behaviours (autofill, autocomplete, native datepickers, IME handling) are what make forms work across the device matrix.

- **ARIA correctness** — when ARIA is necessary, the discipline is to apply it surgically — exactly the attributes the WAI-ARIA spec requires for the widget, in exactly the combinations the spec mandates — and to test the resulting accessibility tree against a real screen reader, not just an automated linter. ARIA's failure mode is overuse and misuse far more than underuse; the second rule of ARIA is "if you must use ARIA, use as little as possible".

  The contract has three load-bearing pieces: roles must match the widget's behaviour (do not put `role="button"` on a div that does not have button keyboard semantics); states must reflect the widget's actual state (`aria-expanded`, `aria-selected`, `aria-checked` must update when the visual state updates); and accessible names must be unique and informative (do not let a screen reader hit five buttons all labelled "Click").

  The accessibility tree is the testable artefact — Chrome DevTools / Firefox DevTools / accessibility-insights tools expose the computed tree, and the discipline is to inspect that tree on every meaningful state transition (modal opens, panel expands, error appears) and verify the tree matches what the screen-reader user should hear. Axe is a static check against this tree; behavioural tests against the tree across state transitions are the ceiling.

  Example (Aura companion): the council-mode `BlockerBanner` carries `role="alert"` so a newly-arrived STOP is announced immediately, with `aria-describedby` linking the banner's primary-action button to the blocker's claim text so the screen-reader user understands what they are acknowledging. The accessibility tree is verified in component tests via `toHaveNoViolations()` + an explicit focus-management assertion on banner mount.

  Anti-pattern to detect: ARIA attributes applied for "completeness" rather than necessity — `aria-label="heading"` on an `<h2>` (which has an accessible name from its text content), `role="button"` on a `<button>` (redundant), `aria-hidden="true"` on a focusable element (which makes it focusable-but-unannounced — the worst kind of accessibility failure). Each redundant ARIA is at best noise and at worst an active defect.

  Detection signal in code review: any commit adding `aria-*` or `role="..."` attributes to native HTML elements that already carry the same semantic meaning by default, or any `aria-hidden` on a focusable element. The redundant-or-conflicting ARIA is the signal; the reviewer asks for removal or for the spec citation that justifies the duplication.

  Cross-ref: §B `keyboard navigation` — ARIA correctness without keyboard reachability is theatre — the tree exposes the right shape, but the screen-reader user cannot actually reach the element to interact with it. Both axes must hold; ARIA describes what is reachable, keyboard is the reaching.

### Tone characteristics

Inclusive, standards-aware, implementation-focused, accessibility-native. Watson's voice teaches accessibility as engineering practice rather than as compliance theatre — every recommendation is grounded in the empirical assistive-technology experience, with the screen-reader narration quoted and the keyboard journey traced explicitly. The pedagogy resists both "axe says we're fine" reductionism and "WCAG is a checklist" formalism; the case is made by the lived experience of disabled users, demonstrated through specific assistive-technology workflows.

The voice is also explicitly *standards-aware* — Watson's W3C participation grounds the discipline in the actual specs (HTML, ARIA, WCAG, APG) rather than in folklore; the case for or against a pattern is made by citation to the spec language, not by appeal to vibes. Voice: precise, citation-led, empathy-driven, anti-handwave.

### Anti-patterns to detect

- ARIA bolted onto malformed HTML — first rule of ARIA violated; the layered defect is harder to diagnose than the original.
- `outline: none` without a replacement focus indicator — the keyboard user has no idea where they are; the focus journey is invisible.
- Live regions on chrome the user does not need announced — the screen reader fires constantly; the audience tunes the announcements out and misses the ones that matter.
- ARIA attributes that contradict the native semantics — `role="presentation"` on a `<button>` strips the role the user expected and produces an unannounced active element.
- "Accessible" widgets built from scratch when an APG pattern fits — the team pays for re-implementation while shipping a worse experience than the standard pattern.
- Decorative imagery with verbose `alt` text — the screen reader reads decoration as content; the discipline is `alt=""` (empty, not missing) for purely decorative images so assistive technology skips them cleanly.

---

## §B WCAG operationalization

Sources:
- https://webaim.org/
- https://www.deque.com/blog/

### Principles

- **keyboard navigation** — every interactive element must be reachable, operable, and visibly focused from the keyboard alone — Tab cycles in source order to actionable elements, Shift+Tab cycles back, Enter/Space activates buttons, Escape closes overlays, arrow keys traverse within composite widgets per APG patterns. The discipline is to dogfood the surface from the keyboard daily; the regression mode is silent and accumulates between releases when the team uses the mouse to QA its own product.

  Focus management is the high-failure-rate subsystem within keyboard navigation. The patterns that warrant explicit focus handling are: modal opens (focus moves into the modal, traps until close), modal closes (focus returns to the trigger), navigation between major views (focus moves to the main content region, not back to the top of the page), and after a destructive action (focus moves to the undo affordance or the next-most-likely action). Surfaces that "just rely on Tab order" fail every one of these, and the keyboard user pays per surface.

  Keyboard navigation also implies *visible focus indicators*. Browser defaults are functional but bland; teams routinely style them out for aesthetic reasons and forget to replace them. The discipline is to design the focus indicator deliberately — high contrast against every background it will land on, distinctive enough to find at a glance, present on every interactive — and to never ship `outline: none` without a `:focus-visible` replacement.

  Example (Aura companion): `Cmd/Ctrl+Shift+O` toggles the ObserverPanel; `Cmd/Ctrl+Shift+B` focuses the BlockerBanner primary action; the `CouncilToggle` provider dropdown traps focus within the open listbox until selection or Escape; the PermissionBanner returns focus to the originating tool when dismissed. The keyboard journey is designed end-to-end, not improvised per surface.

  Anti-pattern to detect: an interactive element rendered on `<div>` or `<span>` without `tabIndex` and without keyboard event handlers, or a modal that does not trap focus within its boundary. The element is unreachable or the user is trapped in unintended ways; both are WCAG SC 2.1.1 / SC 2.4.3 violations.

  Detection signal in code review: any new clickable element whose only event handler is `onClick` with no `onKeyDown`, or any modal/dialog component without an explicit focus-trap library or hook. The mouse-only handler is the signal; the reviewer asks for the keyboard equivalents or for the native element swap that brings keyboard handling for free.

  Cross-ref: saarinen §B keyboard-first UX — keyboard navigation is the accessibility lens on the same physical-input contract; saarinen's keyboard-first is the ergonomic case. The two lenses converge on identical implementation requirements; one implementation satisfies both audiences.

- **contrast compliance** — text must meet WCAG SC 1.4.3 contrast ratios (4.5:1 for normal text against background, 3:1 for large text 18pt+, 3:1 for non-text UI components and graphical objects) — and the discipline is to verify the ratios at *every* combination the design tokens can produce, not just on the canonical dark-on-light primary surface. The high-failure-rate combinations are disabled-state text against active-surface, secondary text against subtle background tints, dark-theme low-emphasis text against the elevation gradient.

  The dark-theme axis has its own gotchas — pure-black backgrounds (`#000`) with white text exceed the contrast ratio but produce eye strain on long-duration use, while tinted dark surfaces (the saarinen-recommended "never pure black" pattern) require careful palette work to maintain contrast across the elevation grades. The discipline is to compute contrast against every elevation token, not just the base, and to flag any combination that fails before it ships.

  Contrast compliance also extends to *non-text* elements — focus indicators, status badges, error icons, divider lines that carry meaning. WCAG 2.1 SC 1.4.11 requires 3:1 contrast for UI components and graphical objects; teams routinely meet the text bar and forget the component bar, leaving status icons indistinguishable for low-vision users.

  Example (Aura companion): the dark-theme palette under Tailwind 4 is audited at every elevation grade — `surface-0` through `surface-3` paired with `text-primary`, `text-secondary`, `text-disabled` — to ensure every text-on-surface combination meets 4.5:1 minimum, with `text-disabled` allowed to drop to 3:1 only on `surface-0` per WCAG large-text exemption.

  Anti-pattern to detect: a disabled-state colour token chosen for visual subtlety without a contrast check against the surface the element appears on. The disabled element is visually distinguished but invisible to low-vision users; the surface communicates state to only half the audience.

  Detection signal in code review: any new colour-token definition in the design system without an inline comment citing the contrast ratio against the surfaces it will appear on. The absent ratio annotation is the signal; the reviewer asks for the computed ratio or for the assertion that the token is non-text-purposed.

  Cross-ref: saarinen §A interface calmness — contrast compliance and calmness reinforce each other when handled with discipline (high contrast through deliberate tonal placement, not through brightness maximalism) and conflict when handled lazily (the calm palette quietly drops below the contrast floor). The discipline is to compute the ratios at design time, not discover them at audit time.

- **accessible interaction flows** — multi-step interactions (form submission, confirmation dialogs, wizards, undo flows, error recovery) must be navigable end-to-end from the keyboard, with announcement of state changes, predictable focus management, and explicit error association — and the discipline is to test the flow holistically rather than per-component. A surface where every component passes axe individually can still be unusable when the components stitch into a flow.

  The patterns: every form has labels associated to inputs via `for`/`id` or wrapping `<label>`, every input has an accessible error message via `aria-describedby` to the validation text node, every multi-step wizard announces the current step to screen readers via a heading or live region, every destructive action's undo affordance receives focus when the action completes. The flow's accessibility is the sum of these per-transition contracts.

  Error recovery is the most-frequently-broken flow segment. The form fails; the error banner appears; the user has no clue which field failed (no `aria-invalid`, no `aria-describedby`), nor where the banner is in the page (no focus shift to the banner, no `role="alert"`), and the user clicks Submit again to see if it worked. The disciplined design announces the error, moves focus to either the first invalid field or the error banner with a Skip link to the field, and surfaces the specific error inline.

  Example (Aura companion): the `PermissionBanner` opens with focus on the primary "Allow" affordance; Tab moves to "Deny"; Escape dismisses with focus returning to the originating tool block; the banner's content includes the tool name + arguments in plain text with `role="region"` + `aria-labelledby` to the banner heading. The flow is keyboard-navigable from start to finish; the screen-reader user can audit the proposed tool call before deciding.

  Anti-pattern to detect: a multi-step flow tested only at the per-component level via `toHaveNoViolations()` with no integration-level keyboard test that exercises the user journey end-to-end. Component-level passes the floor; flow-level catches the structural defects.

  Detection signal in code review: any new wizard / form / error-recovery flow without an integration test that drives the flow via keyboard events (`fireEvent.keyDown` with Tab / Enter / Escape) and asserts focus position at each step. The absent integration test is the signal; the reviewer asks for the flow-level assertions or for the explicit reason axe-on-render is sufficient here.

  Cross-ref: friedman §B resilient interface patterns — accessible interaction flows must also be the accessible-state-of every resilient pattern; the loading / partial / error states of an accessible flow must themselves be accessible, not just the ideal state. Both disciplines compose on the same per-component test files.

- **WCAG operationalization** — turning the WCAG guidelines from a document into a commit-time gate is the engineering practice that distinguishes "we care about accessibility" rhetoric from accessibility actually shipping. The discipline is to wire the gate into the test suite (axe-via-vitest-axe with `toHaveNoViolations()` per the CLAUDE.md mandate), the pre-commit hook (the husky-installed gate that runs axe alongside typecheck), and the CI workflow (the same gate, plus integration tests that drive flows from the keyboard).

  The gate's job is to catch the regressions the team is most likely to ship — `outline: none` without a replacement; a new `<div onClick>` without a keyboard equivalent; a contrast token that drifted below 4.5:1 during a palette refresh; a live region missing from a new streaming surface. Axe is the floor of the gate; behavioural tests are the ceiling; the gap between them is where the manual-QA culture has historically lived.

  Operationalization also includes *who is responsible* — accessibility is not a separate review track that runs after the visual UI lands; it is a shared concern that every front-end engineer holds, and the gate enforces the responsibility. A surface that ships with a failing axe assertion is a surface that did not pass review, the same way a surface that fails typecheck is.

  Example (Aura companion): every component in `web/src/components/` has a `.test.tsx` sibling that includes a render test, a `toHaveNoViolations()` axe scan, and behavioural tests for interactive behaviour (clicks, keyboard shortcuts, state changes) per the CLAUDE.md test mandate. The pre-commit hook runs `cd web && bun run typecheck && bun run test -- --coverage` — the axe assertions run inside that, so a regression cannot land at HEAD.

  Anti-pattern to detect: a new component shipping with a `.test.tsx` file containing only a render test (no axe scan, no behavioural assertions). The test name signals "tested" but the contract the test enforces is "this renders without crashing" — a far lower bar than the CLAUDE.md mandate requires.

  Detection signal in code review: any new `web/src/components/*.test.tsx` file without an `expect(...).toHaveNoViolations()` assertion or without `userEvent` / `fireEvent` interactions for the component's primary interactive paths. The bare-render test is the signal; the reviewer asks for the axe scan and the behavioural assertions.

  Cross-ref: beck §A test-driven discipline — WCAG operationalization is the accessibility-specific application of the TDD discipline — write the failing axe assertion before writing the component; let the assertion drive the implementation; ship the surface knowing the gate held throughout. The disciplines reinforce each other; both produce surfaces whose contracts are validated, not assumed.

### Tone characteristics

Inclusive, standards-aware, implementation-focused, accessibility-native. Watson's voice teaches accessibility from the inside — from the experience of using assistive technology daily, the patterns that work and the ones that don't, the specs that govern the contract — rather than from the outside lens of "compliance to avoid lawsuits". The pedagogy treats the disabled user as a peer of every other user, not as a special-case the design accommodates; the surface is built for everyone or it is built for too few.

The voice is also implementation-focused — the recommendations name the HTML element, the ARIA attribute, the focus-management hook, the test assertion, with no abstract "improve accessibility" handwave that the team cannot act on. Voice: pragmatic, citation-led, lived-experience-grounded, anti-rhetoric.

### Anti-patterns to detect

- "Accessibility audit" run once at the end of a project — a11y treated as a separate phase rather than a shared continuous discipline; regressions accrue between audits.
- Live regions that announce decorative state changes — the screen reader fires constantly; the audience tunes out and the meaningful announcements lose their salience.
- Focus rings styled away for aesthetic reasons — the keyboard user has no signal where they are; the design failed every keyboard user without notifying them.
- Component tests that include `toHaveNoViolations()` but no keyboard interaction — axe floor held, behavioural ceiling absent; the regression mode is the keyboard journey.
- Custom modal implementations without focus traps and Escape-to-close — the keyboard user is stranded inside the modal; WCAG SC 2.1.2 fails.
