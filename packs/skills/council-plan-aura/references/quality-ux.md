# UX Quality Reference — Carmack × Vitaly Friedman

Philosophy: John Carmack. Specifics: Vitaly Friedman (Smashing Magazine, Smart Interface Design Patterns).
Stack context: React 19 chat-style UI for developer-facing tool (Companion). Streaming assistant content. Permission banner for tool approval. Sessions sidebar with create/end/archive. Tasks panel extracted from `TodoWrite`/`TaskCreate` tool calls. Embedded CodeMirror and xterm surfaces.

Every finding must describe the **concrete UX consequence** — not just "this could be better."

**Scope boundary:** UX patterns, IA, interaction. NOT visual aesthetics (`quality-ui.md`), NOT a11y (`quality-a11y.md`), NOT security/perf.

---

## Principle 1: Structure complexity — don't simplify away user value

*Carmack: "Simple code." But Carmack never advocates removing necessary complexity.*
*Friedman: "'Efficient' is not always simple."*

Aura is a developer tool. Hiding tool outputs, conversation history, or session state to make the UI "clean" punishes the user who needs that data.

### What to check

**Critical data hidden behind clicks**
- Tool output truncated with no expand. Session metadata buried in a dropdown. Token usage hidden by default. If users need to scan it during a working session, surface it.
- Severity: **P1** if the user can't complete their task without navigating away.

**Mobile-as-shrunken-desktop**
- The product is desktop-first per CLAUDE.md (`cursor.sh dev` context). If mobile views exist, they should be re-designed for the form factor, not a horizontal scroll.
- Severity: **P3** until mobile becomes a use case.

---

## Principle 2: Design all five screen states

*Hurff/Friedman: blank, loading, partial, error, ideal.*

### What to check

**Missing blank/empty states**
- Home page with no sessions. Tasks panel with no tasks. Recordings list with no recordings. Each needs deliberate empty-state design: what this view shows, why it's empty, what action creates the first one.
- Severity: **P1** for primary views without empty state. **P2** secondary.

**Full-screen loading takeover**
- Initial app load showing a full-screen spinner. Better: skeleton of the layout. For streaming token output, the message bubble appears immediately with a streaming indicator — not a blocking spinner.
- Severity: **P2** for full-screen spinners.

**No partial-state handling**
- A session list where one session fails to load shouldn't crash the entire sidebar. Each item should error-isolate.
- Severity: **P1** if a single bad item kills the parent view.

**Generic error messages**
- "Something went wrong" with no action. Cross-reference `quality-backend.md` Principle 2 — backend should provide a useful error class; UI should translate to user-facing language with a recovery suggestion.
- Severity: **P2** for generic errors on critical paths.

---

## Principle 3: Never freeze the interface on a single input

*Friedman: "Every time we freeze the UI on a single input, we slow down customers."*

### What to check

**Composer locked while assistant streams**
- The Composer textarea should be typeable even while the previous assistant message is streaming. The user can queue their next prompt.
- Severity: **P2** for locked composer during stream. **P3** if intentional (single-message-at-a-time semantics) but undocumented.

**Auto-scroll fighting user scroll**
- User scrolls up to read earlier output, auto-scroll yanks them back to bottom on next token. Anti-pattern. Detect user-initiated scroll; pause auto-scroll until user returns to bottom.
- Severity: **P1** in a streaming product.

**No optimistic UI for safe actions**
- "Rename session" waits a full server round-trip with a spinner. Rename immediately; reconcile on confirm.
- Severity: **P2** for frequent safe actions with visible wait.

---

## Principle 4: Progressive disclosure with visible triggers

*Friedman: visible affordances, max three nesting levels.*

### What to check

**Hidden content with no visible trigger**
- A panel that contains useful data but no affordance to find it. The Recordings list — is it discoverable? The Env Manager — is there a clear path?
- Severity: **P2** for important features with weak triggers.

**Nesting beyond three levels**
- Sidebar → Session → Tool group → Tool call → Tool result subitems — that's already 5. Re-think information architecture if nesting drives that deep.
- Severity: **P2** for deep nesting without visual differentiation per level.

**Modals for non-blocking content**
- Modals for "feature announcement" or "session info." Cross-reference Friedman: modals are for deliberate friction (confirm destructive actions). Otherwise use non-modal panels.
- Severity: **P2** for non-blocking content in modals. **P1** if modal has no Escape/click-outside-close.

---

## Principle 5: Disabled controls are a dead end

*Friedman: "Disabled buttons are a disastrous design pattern" — but the rule is nuanced.*

### What to check

**Disabled `Send` with no visible reason**
- The Composer's Send button disabled while the model is loading — user understands. Disabled because the input is empty — user understands. Disabled for any non-obvious reason without tooltip — user is stuck guessing.
- Severity: **P2** for disabled with non-obvious blocker.

**Inline validation that blocks mid-type**
- Cross-reference `quality-frontend.md` Principle 1. Validate on blur or submit, not on every keystroke.
- Severity: **P2** for over-aggressive validation.

---

## Principle 6: Dashboards and lists drive action

*Friedman: "Dashboards shouldn't just display data, but create understanding."*

### What to check

**Session list without clear primary action per item**
- A session row should make "open" the obvious action, and provide secondary actions (rename, archive, delete) in a clear surface.
- Severity: **P2** if primary action is ambiguous.

**No drill-down from summary to detail**
- Tasks panel shows "3 tasks complete" — clicking should jump to those tasks in the chat.
- Severity: **P2** for summaries with no drill-down.

**No data freshness indicators on streaming state**
- A message that's been streaming for 30s with no indication of liveness vs hang. Stream cursor blink, "Receiving…" indicator, or token counter all signal liveness.
- Severity: **P2** for streaming UI without liveness signal.

---

## Principle 7: Respect user expertise

*Friedman: design for low, medium, high expertise.*

### What to check

**No keyboard shortcuts on frequent actions**
- New session, switch session, send message, dismiss permission. All should be shortcut-bound. Cross-reference `quality-a11y.md`.
- Severity: **P3** an expertise-level enhancement.

**Onboarding that blocks the product**
- Full-screen first-run modal. Skip-able is the minimum; ideally use contextual help that triggers when the user pauses or makes a mistake.
- Severity: **P1** for blocking onboarding. **P2** for multi-step that delays time-to-value.

**Settings buried without clear path**
- Env Manager, AI validation settings, model selector — if the user can't find them from the home view in <3 clicks, they're hidden.
- Severity: **P2** for important settings buried.

---

## Principle 8: AI-second, not AI-first — structure beats conversation

*Friedman: "Conversational AI is a very slow way of helping users express intent."*

But this product IS conversational by design (it's a chat with an LLM). The principle adapts: surface structure WHERE structure is faster than chat.

### What to check

**Permission decisions as text prompts**
- Tool permission via a typed answer instead of explicit buttons. Always use buttons; reserve text input for refinement.
- Severity: **P1** if permission grants are textual.

**Tool selection by typing tool name**
- If the UI ever asks the user to type a tool name to allow it, that's a typo away from a security issue. Use a list with checkboxes.
- Severity: **P2**.

**No surfaced refinement controls**
- Re-running a tool with adjusted parameters by re-typing. Provide "edit + retry" affordance on tool blocks.
- Severity: **P3**.

**Agentic AI without guardrails**
- Tool calls that don't require approval for destructive ops. Cross-reference `quality-llm.md` Principle 5.
- Severity: **P1**.

---

## Principle 9: Trust compounds slowly, breaks fast

*Friedman: "Every time a user discovers a mistake, it's a small betrayal of trust."*

### What to check

**No reasoning visibility for AI decisions**
- AI validator denies a tool. The user sees "denied" with no explanation. They lose trust in the validator. Show the rule or LLM rationale.
- Severity: **P2** for validator decisions without rationale.

**Inconsistent data across views**
- Token count in topbar says 5,400; same session in detail view says 5,100. Trust evaporates.
- Severity: **P1** for any same-data inconsistency.

**No confidence indicators where helpful**
- AI validator's confidence in a decision, the bridge's confidence that a session is still connected. Even simple traffic-light cues help.
- Severity: **P3**.

**AI-generated content not labelled**
- The session list auto-namer may rename a session. If the user doesn't know "this name came from AI", they may treat it as their own intent.
- Severity: **P3** for unlabelled AI-generated names. **P2** if mistaken-attribution has caused confusion.

---

## Principle 10: Working screens answer one question — honest states, actions where the answer is

*Added 2026-10-19. Sources: taste-skill (`Leonxlnx/taste-skill`, `references/app-screens.md` §2.2, §7.8, §8, §11 — from a study of 23 real product screens plus rules learned in blind tests) and UI/UX Pro Max (`nextlevelbuilder/ui-ux-pro-max-skill`, `references/quick-reference.md` §3, §8, §9). Visual encoding of the same data (tabular figures, chip styling, delta colour) is `quality-ui.md` Principle 10 (saarinen). Live regions, focus moves and toast announcement are `quality-a11y.md` (watson).*

### What to check

**No named question, no lead**
- Each view should be able to state the one question it answers first ("Which session needs me?", "Is this run stuck?", "What did the observer flag?"). The biggest block answers it and is read first; the single most important fact in today's data (the "one finding") sits next to the action it drives, not in a footer caption. Blocks that answer no follow-up question are cut.
- Severity: **P2** when the primary block of a view is not the answer to its question. **P3** for a buried finding.

**The main job is not one click from the answer**
- The most frequent job sits where the answer shows: an Approve/Deny on the banner that needs it, "Open log" / "Retry" on the failed item, "Resume" on the stalled session. A view with no control for its main job reads as a report, not a tool. Rows that need doing get a visible action in one fixed trailing column at the same pitch for every row — never muted grey text, never stacked so row heights change; rows that don't need it get at most one kebab.
- Severity: **P2** for a primary job requiring navigation away. **P3** for inconsistent row-action placement.

**Evidence missing beside a number or verdict**
- "Context 87%" or "Observer: blocked" is trusted more with its cause attached ("jumped after the 23:28 file read", "rule R-3: destructive git op"). One line of explanation on the event that matters beats a second chart. Extends Principle 9.
- Severity: **P3**; **P2** when the verdict drives a user decision.

**Zero, missing and loading look alike**
- A real zero is printed ("0", "$0.00", "0 tasks"). Missing / not-applicable is a small muted dash — a "--" at value size reads as loading. Counts shown in scope (tabs, badges, "12 open") are computed from the current view/filter and recomputed on every switch.
- Severity: **P2** when a user cannot tell "nothing" from "not loaded yet" on a primary view.

**Empty blocks lose their frame**
- An empty section keeps its header and frame and adds one sentence spanning the whole block (with the next step); an empty chart draws the zero line, not an illustration. First run keeps the shell and title and puts the first action where the data will appear. Labels and empty states use words of the trade ("Waiting for approval", "No checkpoints yet") — not "Items", "Records", "Status". Refines Principle 2 "Missing blank/empty states".
- Severity: **P2** primary views. **P3** secondary.

**Loading that reshuffles or flashes**
- Loading renders the final layout with value-sized placeholders and real labels/headers immediately; nothing shifts when data lands. Don't flash an indicator for near-instant work; use a skeleton (not a spinner) for waits over ~1s. Feedback for a click/tap appears within ~100ms. A refresh of data already on screen keeps the old values and updates a freshness stamp instead of blanking.
- Severity: **P2** for layout jumps or blanking on refresh of a primary view. **P3** for spinner-vs-skeleton choice.

**Errors as banners instead of in place**
- An error renders inside the block that failed, not as a full-screen banner or an alert: one sentence saying what failed and when the data was last good ("Couldn't load sessions. Last updated 09:14."), the cause plus how to fix it, and a Retry. Timeouts say they timed out and offer retry. Red is a signal, not a texture: one red mark per object, on the failing fact.
- Severity: **P2** on critical paths. **P1** if one failing block blanks the whole view (Principle 2 partial state).

**Stale data presented as live**
- Anything that can go stale (usage limits, session state, observer status) carries a freshness stamp and a refresh; a snapshot that cannot refresh says so in one quiet notice. Extends Principle 6 liveness.
- Severity: **P2** when stale data drives a decision (e.g. a limit badge from an expired token).

**Lists without a cap, a total, or a stable selection**
- Overview lists cap at 4–6 rows with "View all" and the total ("3 of 27"), no pagination widget under five rows. Full lists state the total above, keep the header in view while scrolling, and show the range ("1–50 of 1,284"). In a list that drives a detail pane (sessions → chat), the selected row uses a distinct fill that cannot be mistaken for hover or focus. Going back restores scroll position, filters and typed input; key views are deep-linkable (hash routes).
- Severity: **P2** for lost scroll/filter state on back or an ambiguous selected row. **P3** for missing totals.

**Settings and destructive actions without a contract**
- One save model per view: every control autosaves with a quiet "Saved" stamp, OR one Save per panel — never a mix. Show what the setting produces next to the control (a preview of the prompt/notification/output). Destructive actions go last in their own section, state the consequence in words, and confirm by naming the object ("Delete session 'fix-auth'?"); prefer Undo over confirm for reversible bulk actions; confirm before dismissing a panel with unsaved changes. Read-only must look different from disabled; disabled controls stay legible and say why (Principle 5).
- Severity: **P1** for an unconfirmed, unnamed destructive action. **P2** for mixed save models or silent data loss on dismiss.

---

## Quick Reference: Severity Guide

| Severity | Pattern | Examples |
|----------|---------|----------|
| **P1 — Fix Now** | User cannot complete core task, actively misled, trust destroyed | Critical data hidden behind clicks, no empty state on primary views, auto-scroll fighting user, AI actions without approval, data inconsistencies, blocking onboarding, agentic AI without guardrails, permission as text input |
| **P2 — Fix Soon** | Degraded UX, unnecessary friction | Composer locked during stream, generic error messages, modals for non-blocking content, no drill-down, no liveness signal during stream, no rationale on validator, disabled controls without reason |
| **P3 — Consider** | Polish, expertise affordances | No keyboard shortcuts, no AI-content labelling, no refinement controls, no confidence indicators, mobile not yet adapted |

### The Overriding Filter

1. **Can the user complete their task from this view?** Hidden critical data = flag.
2. **Does the interface freeze on input?** Locked composer, stuck scroll = flag.
3. **Are all five screen states designed?** Empty, loading, partial, error, ideal — missing any = flag.
4. **Does the user understand AI decisions?** Black-box denies = flag.
5. **Is the same data consistent across views?** Drift = trust erosion = flag.
6. **Does the view answer its one question, with the action beside the answer?** Unnamed lead, zero/missing/loading indistinguishable, errors that blank the view = flag (Principle 10).
