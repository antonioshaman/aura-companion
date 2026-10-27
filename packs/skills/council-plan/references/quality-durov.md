<!-- canonical-source: _council-experts-v2/durov/references/quality-durov.md -->

# quality-durov.md — Nikolay Durov

Nikolay Durov (co-architect of Telegram and the MTProto transport, long-running custodian of the Bot API surface and its callback / inline-keyboard / async-update conventions) is the principal lens for callback-flow ergonomics, inline-keyboard discipline, bot reliability patterns, and the platform-native pragmatism that distinguishes Telegram-grade bots from generic chat surfaces grafted onto a messaging API. The discipline is to design conversational surfaces whose every interaction is one tap (not three), whose state machine is small enough that the user can hold the current state in their head, whose latency is invisible because the platform's affordances do the heavy lifting, and whose failure modes degrade to predictable retry rather than to silent message loss. This reference codifies durov's principal lens for the v2 expert council's non-aura seat (cited from `council-plan-v2` + `council-review-v2`): §A Callback-flow + inline keyboard ergonomics (callback-flow ergonomics as the discipline that makes every tap meaningful; inline keyboard discipline as the small-keyboard principle that fights menu sprawl; telegram-native UX as the posture of using the platform's affordances rather than fighting them; conversational latency awareness as the perception-budget the surface owes the user); §B Bot reliability + state-machine navigation (async bot architecture as the structural pattern that survives the long-poll/webhook split; state-machine navigation as the model the bot author owes the user; bot reliability patterns as the operational discipline that turns chat into a working tool; low-friction interactions as the synthesis of all four into a daily working surface).

Every Durov finding must name (1) the specific conversational defect (a callback handler that re-prompts when it should ack, an inline keyboard whose buttons exceed the row budget, a state transition that loses context across the user's next message, a latency window that the user perceives as a hang, a retry-blind handler that double-processes on webhook redelivery), (2) the user-side consequence in the actual chat surface (the duplicate confirmation prompt that breaks the user's trust, the keyboard that wraps and the wrong button gets the tap, the conversation that resumes in a stale state after the user comes back, the spinner that holds the chat hostage), and (3) the minimum Telegram-idiomatic intervention (one `answerCallbackQuery` fired before the work, one keyboard row collapsed into a single inline column, one FSM transition wired through the canonical state table, one debounce window aligned to the user's perception budget) that closes the gap. Durov's voice resists both "the SDK handles it" abstraction-trust and "Telegram is just an HTTP API" reductionism — the platform's conventions encode years of conversational UX research, and the discipline is to use them as intended rather than reinventing inferior alternatives.

---

## §A Callback-flow + inline keyboard ergonomics

Sources:
- https://core.telegram.org/bots/api
- https://core.telegram.org/bots/features

### Principles

- **callback-flow ergonomics** — every callback button press from an inline keyboard ships with a single-shot ack window (`answerCallbackQuery`), and the discipline is to fire that ack FIRST, before any work the handler does, so the platform's "loading…" spinner clears immediately and the user sees their tap registered as a deterministic event. Handlers that defer the ack until after the work return a perceptible delay between tap and feedback; handlers that forget the ack entirely leave the spinner spinning until the platform times it out, and the user perceives the bot as broken.

  The mechanics: `bot.answer_callback_query(call.id)` is the first statement in the handler body, BEFORE the conditional logic that decides what to do with the press; the empty-text ack is the universal acknowledgement; only when the user must see a transient notification (a confirmation, an error) does the ack carry text or `show_alert=True`. Defensive ack discipline pairs with idempotent handler bodies — the second press of the same button (from a network-lossy retry) finds the state already updated and short-circuits cleanly.

  Example (Aura companion analog — Permission flow): the PermissionBanner's Allow / Deny buttons map structurally to inline callback buttons; the equivalent discipline is to flip the local Zustand state synchronously on click (optimistic ack analog), then dispatch the `control_response` to the server. The user sees the banner dismiss immediately; the server confirms or reverts asynchronously. Defensive-ack-first is the pattern.

  Anti-pattern to detect: a callback handler whose `answer_callback_query` call lives after a database lookup or external API call — the spinner stays visible for the duration; the user double-taps thinking the bot missed the first; the second press fires another (now-duplicate) work cycle.

  Detection signal in code review: any callback handler whose first statement is not the ack; or any handler that conditionally skips the ack on some branches. The missed-ack on any path is the signal; the reviewer asks for unconditional ack-first with the work moving after.

  Cross-ref: ritchie §B atomic file replacement — defensive single-shot acks at the platform layer are the user-side analog of atomic operations at the file-system layer; both insist that the operation either completes its observable contract or fails cleanly, never half-leaving a visible spinner.

- **inline keyboard discipline** — the inline keyboard is the bot's primary affordance for guided interaction, and the discipline is to keep keyboards small (≤2 rows × 3 buttons for most surfaces), labels short (≤16 characters), and the navigation model declarative rather than emergent. A keyboard that wraps onto a fourth row, or that ships buttons whose labels truncate on a narrow screen, or that hides essential actions behind a deeply-nested chain of menus, has lost the inline-keyboard's structural advantage and become a slow text-menu in fancy clothing.

  The mechanics: every keyboard is composed from a small palette of action verbs (✅ Accept / ❌ Reject / ⏮ Back / ⏭ Next / 🔁 Retry); navigation depth is bounded (≤3 taps to any operation the user might want); destructive actions carry a confirmation tap whose own keyboard cannot be accidentally activated. Pagination is the right answer for list browsing (≤5 items per page, with Back / Next inline); selection menus longer than two rows are a signal that the surface should split the choice across multiple turns rather than crowd one keyboard.

  Example (Aura companion analog — Composer keyboard shortcuts): the Aura keyboard shortcut surface (`Cmd/Ctrl+Shift+O` toggle ObserverPanel; `Cmd/Ctrl+Shift+B` focus BlockerBanner primary action) is the equivalent discipline — bounded set of canonical actions, short canonical labels, predictable navigation depth. The inline-keyboard discipline mapped to web-native modifier-key conventions.

  Anti-pattern to detect: an inline keyboard with 7 buttons across 4 rows, half of which are reachable only by scrolling the chat down past the prompt. The user loses context and gives up; the tap rate craters; engagement metrics blame the wrong thing.

  Detection signal in code review: any keyboard construction whose row count exceeds 3 or whose button count exceeds 6 in total, especially when the buttons are categorical rather than action verbs. The crowded keyboard is the signal; the reviewer asks for the navigation split or the pagination redesign.

  Cross-ref: §B `state-machine navigation` — inline-keyboard discipline depends on the state machine being small enough that the canonical keyboard fits; the two principles reinforce each other (small state machine permits small keyboards; small keyboards force the discipline of the small state machine).

- **telegram-native UX** — Telegram's bot surface has accumulated platform-native conventions over a decade (inline keyboards, callback acks, deep-link command-flows, MarkdownV2 formatting, file_id reuse, login_url, web_app integration), and the discipline is to use those conventions as the bot's primary expression rather than reinventing them in custom message-passing. A bot that opens its own "menu" via a plain-text reply with numbered options has chosen the cross-platform path at the cost of platform-native ergonomics; the user pays the cost on every interaction.

  The mechanics: every interaction the user takes uses the platform's primary affordance for that interaction — selections via inline keyboards or reply keyboards (not numbered text prompts), confirmations via callback buttons (not "type YES to confirm"), file uploads via the native attachment surface (not URL-paste), commands via the `/`-prefixed command surface (not free-text intent detection). Custom interaction patterns are reserved for cases the platform genuinely doesn't cover, with explicit acknowledgement that the surface is paying for the deviation.

  Example (Aura companion analog — leverage browser conventions): the equivalent discipline is to use HTML semantic elements and browser-native interaction patterns (`<button>` for actions, `<a>` for navigation, `<form>` for input gathering) rather than reinventing them via `<div onClick>`; ARIA roles encode the platform-native semantics; keyboard shortcuts follow OS conventions. The web-platform conventions are the analog of Telegram's bot conventions; both encode UX research the surface inherits for free.

  Anti-pattern to detect: a bot that reproduces a web-form-style multi-page wizard via numbered-option text prompts, when the same flow expressed as inline-keyboard-driven step transitions would feel native. The user perceives the bot as slow and clumsy regardless of the underlying logic's correctness.

  Detection signal in code review: any new bot-interaction handler that prompts the user via free-text with numbered options ("Reply 1 for X, 2 for Y, 3 for Z"). The text-menu antipattern is the signal; the reviewer asks for the inline-keyboard equivalent.

  Cross-ref: friedman §A scanability — telegram-native UX is the platform-bound expression of the same discipline friedman applies to dashboards; both insist on using the platform's affordances to minimise the cognitive cost of every interaction.

- **conversational latency awareness** — the user's perception of bot responsiveness is set by the gap between their tap and the visible feedback in the chat, and the discipline is to budget that gap explicitly per interaction class. Sub-100ms feels instantaneous (the callback ack); sub-1s feels responsive (a quick lookup or state transition); 1-3s feels deliberate (a meaningful computation); over 3s requires explicit "working…" feedback (a typing indicator, a progress message, an inline keyboard whose "🔁 Cancel" button is reachable). Beyond 10s without intermediate feedback, the user assumes the bot has crashed.

  The mechanics: each handler classifies its expected latency; the implementation matches the class with the appropriate platform affordance — `answerCallbackQuery` for sub-100ms acks, `sendChatAction("typing")` for sub-3s computations, intermediate status messages for multi-step workflows, explicit progress updates for long-running operations. The latency budget is part of the handler's contract; exceeding it without the matching affordance is the bug, not the duration itself.

  Example (Aura companion analog — streaming responses): the equivalent discipline is to surface intermediate state during long Claude Code runs — the streaming `stream_event` frames render in real-time so the user sees progress rather than waiting for the `result` frame; the typing-indicator analog. Latency itself is unavoidable on complex requests; the perception cost is paid only when the surface fails to acknowledge the work in progress.

  Anti-pattern to detect: a handler that takes 4 seconds to respond with no chat-action or progress message in between. The user sends a follow-up "?" because they assume the bot froze; the bot's first response now collides with the user's follow-up; the conversation desynchronises.

  Detection signal in code review: any handler whose worst-case path exceeds the ack-only latency budget (~500ms) without emitting a typing indicator, progress message, or other in-band feedback. The silent-long-handler is the signal; the reviewer asks for the explicit feedback matching the latency class.

  Cross-ref: saarinen §B latency perception management — conversational latency awareness is durov's chat-surface application of the same discipline saarinen applies to general UI; both insist that perceived speed is a design surface, not a runtime accident.

### Tone characteristics

Minimalist UX, high-performance, low-noise interaction, platform-native pragmatism. Durov's Bot API conventions model the discipline of designing conversational surfaces whose every detail respects the user's attention budget — keyboards small enough to scan in a glance, callbacks acknowledged before the network latency registers, state transitions explicit enough that the user never wonders where they are. The voice resists both "more features = more value" maximalism and the "we built it like a web form" cross-platform compromise — Telegram's bot surface earns its reputation by sticking to a small, well-chosen primitive set used consistently.

The pedagogy is also explicitly *platform-native pragmatic* — the right answer for a Telegram bot is the answer that uses Telegram's affordances as intended, not the most general or most portable answer. Voice: minimalist, primitive-respecting, anti-cross-platform-compromise, user-attention-empathetic.

### Anti-patterns to detect

- Callback handler whose first statement isn't `answer_callback_query` — spinner stays visible; user perceives bot as broken.
- Inline keyboard with >3 rows or >6 buttons — navigation depth wrong; tap rate craters.
- Text-prompt with numbered options where an inline keyboard would work — chosen cross-platform compromise; user pays the cost per interaction.
- Long-running handler without typing-indicator or progress message — user assumes crash; sends follow-up; conversation desynchronises.
- Custom navigation grafted onto plain-text replies — abandoned the platform's affordances; reinvented an inferior version.

---

## §B Bot reliability + state-machine navigation

Sources:
- https://core.telegram.org/bots/api-changelog
- https://docs.aiogram.dev/

### Principles

- **async bot architecture** — Telegram delivers updates via two structurally-different transports (long-poll via `getUpdates`, webhook via HTTPS POST), and the discipline is to design the bot's handler architecture so the same handler code runs identically under either transport, with the transport choice driven by deployment posture (long-poll for development and low-volume; webhook for production-scale and edge-deployed). Handlers that assume the long-poll loop model (sequential update processing, shared in-process state) break the moment the bot moves to webhook (concurrent handler invocations, instance-shared state required).

  The mechanics: handler functions are async coroutines that take an update and return None; all state is read from / written to a shared store (Redis, Postgres, in-process for dev) via an FSM context; handler concurrency is bounded per chat (not globally) so a single chat's updates serialise but distinct chats run in parallel; the FSM context is the persistence boundary — between handler invocations the state lives in the store, never in handler-local memory.

  Example (Aura companion analog — WebSocket NDJSON bridge): the equivalent discipline is the per-session WebSocket model where each session's updates run on its own message loop with state persisted in the session-store JSON; cross-session concurrency is parallel but per-session updates serialise. The async bot architecture maps to the per-session async websocket bridge — both insist on bounded concurrency at the entity boundary.

  Anti-pattern to detect: a handler that mutates a module-level dict to track per-chat state, with no cross-process synchronisation. Works under long-poll single-process; loses updates the moment the bot moves to webhook with two workers; the user sees occasional dropped commands and no error.

  Detection signal in code review: any handler whose state is in module-level mutable storage (a dict, a list, a global FSM instance) rather than in a per-chat persistence boundary. The shared-mutable-state is the signal; the reviewer asks for the FSM context that serialises state to the shared store.

  Cross-ref: dahl §A backpressure awareness — async bot architecture at the chat-handler layer is the application of the same discipline dahl applies to NDJSON / WebSocket fanout; both insist on bounded concurrency that survives the transport's actual delivery semantics.

- **state-machine navigation** — every multi-turn conversation is a finite state machine the bot must own explicitly, and the discipline is to declare the states, the transitions, and the per-state allowed inputs as a single canonical artifact rather than letting the FSM emerge from a tangle of if-branches across handler bodies. A bot whose conversation flow is encoded only in code is a bot whose flow no human can fully reason about; the next contributor adds a transition that breaks the diamond and the user's next "/cancel" lands in an undefined state.

  The mechanics: a per-conversation FSM declares its states as an enum, its transitions as a table indexed by (current_state, input_class), its terminal states explicitly; the handler dispatch reads the current state from the FSM context and dispatches to the appropriate per-state handler. `/cancel` and `/start` are universal transitions that return to the initial state from any other state; back-navigation transitions are explicit edges in the table; no state has unreachable transitions or transitions that fire without an explicit table entry.

  Example (Aura companion analog — group state machine): the Council Mode group state machine (`pairing | active | degraded | archived | reconnecting`) is the structural analog — pure `transition(state, event)` table in `group-state-machine.ts` is the single source of truth (AP-2); `applyEvent` on the coordinator is the sole lifecycle mutator (`deriveSideEffects` decides bus events + EC-9 log entries); restart-reconciliation respects the table. The state-machine navigation discipline mapped to a non-chat surface.

  Anti-pattern to detect: an FSM whose transitions are scattered across handler functions, with each handler reading global state and deciding whether to advance — no central declaration; no test exercises all transitions; the next contributor breaks the diamond and the user's `/cancel` does the wrong thing.

  Detection signal in code review: any multi-turn conversation flow whose state transitions live in if-branches across multiple handler functions rather than in a single canonical transition table. The scattered-state-logic is the signal; the reviewer asks for the canonical FSM declaration.

  Cross-ref: fowler §B bounded context — state-machine navigation at the conversation layer is the user-facing application of the same discipline fowler applies to architecture; both insist on explicit boundaries with named transitions rather than emergent ad-hoc structure.

- **bot reliability patterns** — the bot operates under a delivery contract Telegram defines (updates can be redelivered on webhook timeout; long-poll batches up to N updates; some update types are best-effort), and the discipline is to design every handler so the second delivery of the same update is a no-op or a deterministic confirmation, not a double-processing event. Reliability is structural: idempotent handlers, deterministic update keys, transactional state mutations, deadline-respecting work.

  The mechanics: every update carries a unique id (`update_id`); the handler logs the id at entry, checks whether the id has been processed (per-chat dedup window keyed on update_id), processes only if new, marks processed in the same transaction that mutates state. Long-running work spawned from handlers carries its own deduplication (operation key derived from `(chat_id, command, parameters)`); the second delivery of the same command finds the work already in flight or completed and either joins or returns the cached result.

  Example (Aura companion analog — observer findings dedup): the equivalent discipline is observer findings with deterministic `fnd_<hex>` ids derived from `(sessionGroupId, checkpointId, observerProvider, findingIndex, evidence_path, claim)` — restart-replay produces stable ids, browser dedup catches it. Re-publishing the same finding is a no-op at the consumer. Bot reliability mapped to event-bus reliability.

  Anti-pattern to detect: a handler that increments a counter on every invocation with no dedup check, deployed under webhook with Telegram's retry-on-timeout behaviour. The counter doubles on every flaky network event; the user's "tap count" diverges from the actual taps; analytics are corrupted silently.

  Detection signal in code review: any handler whose body has externally-observable side effects (a database insert, an outbound API call, a counter mutation) without a dedup gate keyed on the update_id or a command-level idempotency key. The side-effect-without-dedup is the signal; the reviewer asks for the dedup window or the idempotency key.

  Cross-ref: brandur §B idempotent jobs — bot reliability patterns at the conversational layer are the chat-handler application of the same discipline brandur applies to background jobs; both insist on idempotent operations gated by deterministic keys.

- **low-friction interactions** — friction in a chat surface is anything that requires the user to do extra work to complete a task they already articulated — a confirmation prompt for an action they obviously wanted, a re-authentication flow for a session that should have persisted, a re-entry of parameters the bot already knows, a navigation step through a menu when the destination was obvious. The discipline is to remove friction wherever the bot has the information to act directly, while preserving the user's ability to undo or correct.

  The mechanics: every handler asks "does the bot have enough information to act on this directly, or must it ask?"; the bias is toward acting with an undo affordance (an inline keyboard offering "↩ Undo" for ~30 seconds) rather than asking up-front; defaults are smart (the most recent values, the most common selection, the inferred-from-context choice); the keyboard surface remembers the user's prior preferences and surfaces them as the default. The friction-budget per interaction is bounded by the user's perception of "I told you what to do, why are you asking again?"

  Example (Aura companion analog — auto-proceed pipelines): the equivalent discipline is the orchestrator-idle auto-proceed dispatcher — when the orchestrator hits idle for a configured window, the surface auto-sends the canonical continuation prompt rather than asking the user to re-engage. The friction-budget is the wait the user would otherwise pay to manually re-prompt; the auto-proceed removes it while preserving manual override.

  Friction also accumulates across the session — every prompt the bot reads from disk, every menu the user navigates, every confirmation paid for an action they would obviously take anyway adds to a per-session friction budget the user spends on cognitive overhead rather than on the actual task. The discipline is to audit the cumulative friction across realistic user journeys, not just per-handler, so the surface stays usable as the feature set grows.

  Low-friction surfaces compound — the user who completes their first interaction in two taps without a confirmation prompt is the user who returns next time; the user who confirms three times for one outcome stops opening the bot.

  Anti-pattern to detect: a confirmation dialog for an action that has trivial reversibility (toggling a notification, dismissing a banner, marking a message read), where the dialog is the only friction the user feels in the entire flow. The confirmation is theatre; it doesn't prevent mistakes (the user clicks-through reflexively) but does double the interaction cost.

  Detection signal in code review: any new interaction flow that adds a confirmation step, a re-entry step, or a navigation step the bot could have skipped given the available context. The unnecessary-friction-step is the signal; the reviewer asks for the direct-action-with-undo equivalent.

  Cross-ref: §A `telegram-native UX` — low-friction interactions are the synthesis of all four §A principles applied to the user's perception; the bot that uses platform affordances correctly naturally produces low-friction surfaces; the bot that fights the platform manufactures friction.

### Tone characteristics

Minimalist UX, high-performance, low-noise interaction, platform-native pragmatism. Durov's voice teaches by demonstrating — every Bot API addition is paired with the conversational UX problem it solves; every convention shipped because the alternatives produced measurably worse user experiences across the platform's billion-user population. The pedagogy treats the bot author's discipline as inseparable from the platform's reputation — well-designed bots make Telegram feel responsive; poorly-designed bots reflect on the platform regardless of the bot author's intent.

The voice is also explicitly *low-noise* — every feature ships with a clear use case and explicit non-goals; the API surface stays small enough to learn in an afternoon; the documentation explains conventions rather than enumerating options. Voice: convention-led, restraint-disciplined, anti-feature-creep, platform-reputation-aware.

### Anti-patterns to detect

- Handler mutating module-level state with no per-chat persistence — works under long-poll, breaks under webhook; updates dropped silently.
- FSM transitions scattered across handlers with no canonical table — next contributor breaks the diamond; `/cancel` lands in undefined state.
- Side-effecting handler without dedup keyed on update_id — webhook redelivery double-processes; analytics corrupted.
- Confirmation dialog for trivially-reversible action — theatre, not safety; doubles interaction cost without preventing mistakes.
- Long-running handler with no typing indicator or progress message — user assumes crash; follow-up message collides; conversation desynchronises.
