<!-- canonical-source: _council-experts-v2/abramov/references/quality-abramov.md -->

# quality-abramov.md — Dan Abramov

Dan Abramov (former React core team; long-running publisher of the *Overreacted* essays that turned React's internal mental model into widely-shared engineering vocabulary; author of the React 18 concurrent-rendering documentation) is the principal lens for React state, effects, and rendering discipline on Aura's aura-specific surfaces — the discipline of writing React code that aligns with the renderer's actual mental model rather than fighting it, of minimising state and effects to the irreducible truth, and of treating the server-client boundary as a first-class architectural seam rather than as transport plumbing. This reference codifies abramov's principal lens for the aura-only v2 expert council: §A React state & effects discipline (state minimization as the structural antidote to half the bugs in any React app; effects discipline as the line between escape-hatch and overuse; server-client boundary clarity as the architectural seam that determines whether state is consistent; hydration correctness as the silent failure mode SPAs share with SSR); §B Rendering mental models (composable components as the discipline that makes the tree comprehensible; optimistic UI as the structural pattern that gives the user back the latency; rendering mental models as the conceptual framework behind every other decision; synchronization over lifecycle thinking as the React 18+ shift the team must internalise).

Every Abramov finding must name (1) the specific React-architecture defect (duplicated state across slices, effect-for-derived-data, boundary leak, hydration mismatch, prop-drilling that should be composition, optimistic update without reconcile, lifecycle-think where sync-think is correct), (2) the operational consequence for the actual surface — a state divergence the user sees as "the UI is lying", a re-render storm that drops keystrokes, a hydration mismatch that swaps the wrong DOM node, a stale effect that fires after the component unmounted — and (3) the minimum React-idiomatic intervention (one selector narrowed, one effect removed, one boundary contract named, one `key` made stable, one `useTransition` wrapping the heavy update) that closes the gap. Abramov's pedagogy resists both "React is magic" mystification and "React is just JavaScript" reductionism; the discipline is to understand the renderer's actual contract — what causes re-renders, what state-changes mean to React, where the boundaries between components, states, and effects sit — and to write code that respects that contract.

---

## §A React state & effects discipline

Sources:
- https://overreacted.io/
- https://react.dev/

### Principles

- **state minimization** — the structural antidote to half the bugs in any React app is to ask, of every piece of state in the store, "is this derivable from other state?" — and if yes, derive it instead of storing it. Stored derived state is the failure mode: the source updates, the derived store does not, the UI now shows two contradictory versions of the same fact and the user has no idea which to trust. The discipline is to keep state minimal — only the irreducible inputs in the store, everything else computed at render time via selectors or memos.

  The mechanics: Zustand slices hold the raw inputs (the messages array, the active session id, the pending permissions); the derived views (filtered messages, current session record, blocking-vs-non-blocking permission count) are computed in selectors or in the component layer. Selectors take the raw state and return the view; the view never persists; the next render re-derives it. The cost of re-derivation is dwarfed by the cost of debugging stored-derived-state inconsistencies.

  State minimization also implies *not lifting state higher than it needs to live*. A piece of state used by exactly one component lives in that component's `useState`; lifting it to the parent (or worse, to the global store) couples the parent to the child's concerns and makes the state harder to reason about. The discipline is to keep state at the lowest possible scope and lift only when a genuine sharing requirement appears.

  Example (Aura companion): the store is split into slices (`sessions-slice`, `chat-slice`, `permissions-slice`, `council-slice`, etc.) each holding the irreducible state for its domain; derived views (which sessions are paired, which paired session has unresolved STOPs, which tool call is currently pending) are computed via Zustand selectors at the component boundary, not stored. The `deriveObserverPanelState` function takes `(group, findings, dismissedStopIds, nowMs)` and returns the discriminated-union status fresh on every render — state minimization in action.

  Anti-pattern to detect: a slice that stores a `filteredList` alongside the source `list`, with a setter that the application is expected to keep in sync. The next bug ships when one update path forgets to refresh the filtered copy and the UI starts diverging.

  Detection signal in code review: any new field in a Zustand slice whose value is plainly a function of another field already in the same slice (filtered subsets, sorted variants, counts, flags derived from a status enum). The derivable-state field is the signal; the reviewer asks for the selector that computes it at render time and the removal of the stored copy.

  Cross-ref: hickey-style simplicity over easy (analogous discipline at the data-model level) — both lenses converge on "don't conflate primary state with derived state"; React's renderer naturally cooperates with the discipline because it re-runs render every state change and re-deriving is cheap.

- **effects discipline** — `useEffect` is an escape hatch for synchronising React state with external systems (DOM imperatives, subscriptions, network calls, timers) — *not* a place to put logic that belongs in render or in event handlers. The discipline is to ask, of every effect, "is this synchronising with something outside React?"; if yes, the effect is correct; if no, the logic belongs elsewhere.

  The high-failure-rate misuse: effects that compute derived state and write it back via `setState`, producing render-state-render-state cascades. The right pattern is to compute the derived value inline during render (or via `useMemo` if expensive); the effect is the wrong tool because effects fire *after* render, so the value the user sees is one render behind the source state. State-from-effects is also a common cause of infinite-loop bugs when the dependency array includes the state the effect writes.

  Effects also need *cleanup* discipline. A subscription opened in an effect must be closed in the cleanup function; a timer set must be cleared; a fetch initiated must be cancelled. React's StrictMode runs effects twice in development to surface missing cleanups — the discipline is to write the cleanup as part of writing the effect, not as a follow-up TODO.

  Example (Aura companion): the WebSocket client (`ws.ts`) opens its connection in an effect at the App layer with cleanup that closes the socket on unmount; the `useBrowserTitleAlert` hook subscribes to the council slice via a Zustand `subscribe` call in an effect with the unsubscribe function returned as the cleanup. Both effects synchronise React state with genuinely external systems (network, browser title); neither computes derived state.

  Anti-pattern to detect: an effect whose body reads state and calls `setState` with a derived value, with the source state in the dependency array. The render-update-render cascade is structurally guaranteed.

  Detection signal in code review: any `useEffect` whose body is a single `setState(deriveX(state))` call. The effect-for-derivation is the signal; the reviewer asks for the inline `useMemo` or the at-render derivation that removes the effect entirely.

  Cross-ref: §B `rendering mental models` — effects discipline depends on understanding what renders are for and what effects are for; the model justifies the discipline. Misuse of effects nearly always traces to misunderstanding which work belongs to which phase.

- **server-client boundary clarity** — the network seam between client and server is an architectural boundary the design must name explicitly — what flows across, in what shape, who validates it, what the trust model is. A surface that treats the network as transparent (server returns data, client renders it, no boundary contract) ends up with serialization defects, type drift, and trust failures the team only discovers in production.

  The mechanics: the server publishes a typed contract (the JSON schema, the protocol grammar, the protobuf, the TypeScript types exported from the shared package); the client imports the contract and parses incoming payloads against it; the parsed object — not the raw network frame — is what the rest of the application consumes. Parse-or-fail at the boundary is the contract; downstream code can rely on the parsed type being honest.

  The boundary also carries the *trust model*. Server-published data may be trusted (the server is the source of truth); client-supplied data crossing back is treated as untrusted input the server re-validates. The boundary's direction is asymmetric, and the asymmetry must be encoded in the contract (which fields are server-authoritative, which client-derived, which user-input).

  Example (Aura companion): the server's NDJSON WebSocket protocol is typed in `web/server/session-types.ts` and re-exported to the client via `web/src/types.ts`; the client parses every inbound frame against the contract before dispatching to slices; `parseCheckpointPayload` in `council-types.ts` is the structured validator for orchestrator-produced checkpoint files (which the observer half consumes); the parsed object is what slices receive. The boundary is named, typed, validated.

  Anti-pattern to detect: a fetch wrapper that returns `any` (or `unknown` without subsequent narrowing), with the calling code accessing fields directly and trusting they exist. The boundary is invisible; the next API change ships a silent runtime defect.

  Detection signal in code review: any new network-call site (fetch, WebSocket onmessage, server-action result) whose return type is `any`, `unknown` un-narrowed, or a hand-rolled interface that doesn't trace to the server's authoritative type definition. The untyped boundary is the signal; the reviewer asks for the shared type and the parse step.

  Cross-ref: dahl §B NDJSON protocol — abramov's server-client boundary clarity is the client-side application of the same discipline dahl applies to the protocol's wire format; together they make the boundary holistically typed.

- **hydration correctness** — even single-page apps without SSR share a hydration-shaped concern: the React tree initialises against some bootstrap state (HMR snapshot, persisted localStorage, restored URL state), and the discipline is to ensure the initial render matches the state the user expects to see. Hydration mismatches in SPAs surface as flicker (initial UI replaced by reconciled UI), as lost focus (form re-mounts and loses cursor), or as state lost across navigation (component mounts with default state when it should have restored).

  The mechanics: the initial render must be deterministic from the bootstrap state — no `Date.now()` in the initial render path, no `Math.random()` that diverges across runs, no environment-dependent branches that could resolve differently in a re-render. Stable `key` props on lists prevent React from confusing entries during reconciliation; explicit `defaultValue` for uncontrolled inputs preserves user input across re-mounts.

  Hydration also covers the *restart story*. A user reloading the page mid-task should land back where they left off, not on the blank initial state. The discipline is to design hydration deliberately — what persists (active session id, scroll position, expanded panels), what does not (modal open state, transient hover), what is restored from server (current session state), and what is restored from client (UI preferences).

  Example (Aura companion): the Zustand store uses `persist` middleware for council preferences (panel-open per session, dismissed STOP ids, first-run hint); the active session is restored from `localStorage` on App mount; the WebSocket reconnects to the live CLI process across page reloads via the server's PID-based grace-period reattach. The user reloading mid-stream sees the streaming continue without restart.

  Anti-pattern to detect: a component that bootstraps from `useState(() => fetchInitialFromServer())` with no rendering accommodation for the asynchronous result (the initial render uses an undefined or null value, then the effect resolves and the component re-renders with the real value, causing a visible flicker).

  Detection signal in code review: any new top-level component whose first render reads from a hook whose value is not yet resolved (a Suspense-able read without a `<Suspense>` boundary, a fetch promise without an explicit loading state). The flicker-prone initial render is the signal; the reviewer asks for the Suspense boundary or the explicit loading-state branch.

  Cross-ref: friedman §B resilient interface patterns — hydration correctness is the React-internal application of the same five-states discipline friedman applies at the UX layer; both ensure the partial / loading / restored states are designed deliberately, not encountered accidentally.

### Tone characteristics

Conceptual clarity, teaching-oriented, frontend systems thinking, anti-magic. Abramov's *Overreacted* essays model the discipline of explaining-by-mental-model — every React quirk is traced to the underlying invariant the renderer maintains, with the implementation showed step-by-step until the reader can predict the behaviour for cases the essay doesn't cover. The voice resists both "React is magic" hand-waving and "you don't need to understand the framework" tooling reductionism; understanding the renderer is the engineering discipline that makes React code maintainable.

The pedagogy is also explicitly *anti-magic* — when a pattern works in a way that surprises the engineer, the discipline is to dig until the surprise dissolves into a mechanically-understandable invariant. Voice: patient, mechanism-led, anti-mystification, teaching-by-stripping-back.

### Anti-patterns to detect

- Derived state stored alongside its source — divergence is structurally guaranteed; the next bug is when of the two update paths.
- `useEffect` whose body is `setState(deriveX(state))` — render-cascade by construction; the value is one render stale on every observation.
- Network boundary returning `any` — the contract is invisible; the next schema change ships a silent runtime defect.
- Bootstrap from `useState(() => fetchInitial())` without Suspense or loading branch — flicker on every navigation; the user sees the seams of the SPA.
- "Lifting state up" to the global store when the state is used by one component only — coupling without benefit; the slice grows without bound.

---

## §B Rendering mental models

Sources:
- https://github.com/reactwg/react-18/discussions
- https://github.com/gaearon

### Principles

- **composable components** — the React tree is the application's structural artefact; the discipline is to design components that compose by *children prop* and by *render-prop / hook* patterns rather than by prop accretion. A component that ships with thirty optional props is a component whose authors gave up on the compositional model and started reinventing inheritance via configuration; the same surface expressed as compositions of smaller components is both more reusable and more readable.

  The patterns: components accept `children` for layout-shaped composition (a `Card` that wraps any content); components expose render props or hooks for state-shaped composition (a `usePermissions()` hook that any component can consume vs a `PermissionWrapper` HOC that everyone must wrap); components split along the *behaviour vs presentation* line (logic in custom hooks, JSX in pure components, both composed at the call site).

  Composability has a structural test: can a new feature be expressed by *combining* existing components without modifying any of them? If yes, the system is composable; if every new feature requires editing the shared components to accept new props, the system has lost the property. The discipline is to maintain the composability property under feature pressure rather than letting it erode prop by prop.

  Example (Aura companion): `ChatView` composes `MessageFeed` + `Composer` + `PermissionBanner` + (for council pairs) `ObserverPanel`; each child is a self-contained component that renders independently from its own slice subscription; new features (the BlockerBanner stacking, the DegradedBanner replacement) plugged into the layout via composition rather than requiring `ChatView` to learn about every new state.

  Anti-pattern to detect: a single component growing to dozens of boolean props each toggling some internal branch — `<Banner variant="error" dismissible withIcon showCountdown important={false} />`. The component is a configuration interpreter; the simpler design is multiple smaller components composed at the call site.

  Detection signal in code review: any component whose prop interface exceeds ~7 fields, especially when many are booleans gating internal branches. The prop bloat is the signal; the reviewer asks for the decomposition into smaller components or the children-prop refactor that absorbs the configuration into composition.

  Cross-ref: saarinen §A component cohesion — composable components is the structural lens; component cohesion is the visual-system lens. Both disciplines reinforce each other — cohesion is easier to maintain when components are composable, and composable components naturally adopt the system's cohesion if the primitives are tokenised.

- **optimistic UI** — the user's perception of speed is the time until the surface reflects their intent, not the time until the server confirms it; the discipline is to design every safe action (the actions whose failure is rare and recoverable) so the surface commits to the expected outcome immediately and reconciles when the real result arrives. The pattern hides the network's latency without lying about its eventual presence — the user sees the optimistic state, the system records the pending request, the result either confirms (silent) or reverts (with a clear "undo / retry" affordance).

  The mechanics: the store mutation fires synchronously on user action; the network request fires in parallel; the request's `onSuccess` is a no-op for the optimistic state (the state already shows the success); the `onError` reverts the optimistic mutation and surfaces an inline recovery affordance. The user's flow continues; the recovery is local to the row, not modal to the page.

  Optimistic UI requires *idempotent server semantics* on the safe actions — the request can be retried, the success-second-time looks the same as success-first-time, the in-flight collision between two optimistic updates against the same record resolves deterministically. The discipline pairs the client-side optimism with server-side idempotency; neither alone is sufficient.

  Example (Aura companion): the council-mode panel-open toggle and the dismiss-STOP action update the Zustand `council-slice` synchronously; the server is notified via WebSocket for cross-tab sync; the local state never waits for confirmation because the action is local-only (no server source-of-truth for these UI preferences). For server-authoritative actions (sending a chat message, archiving a session), the optimistic mutation appears in the message feed immediately, the server confirms via NDJSON `assistant` frame, and a discrepancy (rare; usually network) reverts with a per-message error indicator.

  Anti-pattern to detect: a user action whose UI does not update until the server response arrives, with a spinner blocking interaction in between. The surface feels slow even on fast networks; the user perceives every action as half-latency-bound.

  Detection signal in code review: any new user-action handler whose `setState` call is inside the network callback (`.then` / `await response`) rather than firing synchronously before the network request. The blocking-state-update is the signal; the reviewer asks for the optimistic flip ahead of the network call.

  Cross-ref: saarinen §B latency perception management — optimistic UI is the structural pattern; latency perception management is the design discipline that follows from it. The two together produce surfaces that feel fast independent of the network's actual condition.

- **rendering mental models** — the renderer is a function of state to UI; every component's body is run on every state change to produce a new virtual tree, which React reconciles against the previous tree to compute the minimum DOM mutations. The discipline is to internalise that model and write components that *cooperate* with it — pure rendering, stable identities, predictable dependencies — rather than fighting it with imperative escape hatches and manual memoisation.

  The model's load-bearing invariant: render must be a pure function. No side effects during render (those belong in effects); no mutation of props or state (those produce undefined behaviour); no dependence on values not passed as props or read from state (those break reconciliation). The discipline is to treat render as a calculation, not as a procedure; the component's job is to *describe* the UI for the current state, not to *manipulate* the DOM.

  React 18+ adds the concurrent-rendering layer: renders can be paused, restarted, or abandoned; effects fire only after committed renders; the team must distinguish *urgent* updates (user input) from *transitions* (state changes that produce expensive re-renders). The mental model expands: not every state update is the same; some can be deferred via `useTransition` so the urgent update stays responsive.

  Example (Aura companion): the `MessageFeed` re-renders on each NDJSON `stream_event` frame appended to the chat slice; the render is pure (the messages array is the input, the rendered tree the output); the heavy `ToolBlock` expansion is wrapped in `useTransition` so the streamed content stays responsive while the expansion's layout settles. The renderer's model is respected; the surface stays fast under load.

  Anti-pattern to detect: a component that imperatively manipulates the DOM in an effect to "fix up" what the render produced — adding event listeners on rendered nodes, querying `document.getElementById` from a render, mutating prop objects. Each imperative escape leaks the renderer's invariants and produces bugs the model would have prevented.

  Detection signal in code review: any `useEffect` whose body queries the DOM by id, class, or selector and modifies it. The imperative DOM mutation outside the render is the signal; the reviewer asks for the declarative equivalent — ref-based access, state-driven rendering, or a custom hook that absorbs the imperative work behind a React-friendly interface.

  Cross-ref: §A `effects discipline` — rendering mental models justifies effects discipline; understanding what render is for makes it obvious what effects are not for. The two principles compose into the operative React mental model.

- **synchronization over lifecycle thinking** — pre-React-16 mental models centred on lifecycle methods (`componentDidMount`, `componentDidUpdate`, `componentWillUnmount`) — each a place to run imperative code at a phase. React 16+ hooks shift the model to *synchronisation*: effects describe the relationship between React state and external state, and React decides when to re-run them. The discipline is to think about effects as "this part of the world should stay in sync with this React state", not as "run this code at this lifecycle phase".

  The mechanics: the effect's dependency array names the React state the external world is being synchronised with; React re-runs the effect whenever any dependency changes, and runs the cleanup before re-running (and before unmount); the contract is "this external resource matches this React state, always". Effects expressed as lifecycle ("mount: open subscription; unmount: close subscription") work for the simple case; effects expressed as synchronisation ("the subscription matches the current channel id") generalise to channel switches without bugs.

  React 18's concurrent rendering extends the model further — `useTransition` and `useDeferredValue` let the team mark some state updates as deferrable; the renderer can render urgent updates first and defer transitions, producing responsive UI under load. The shift is from "I control when things happen" (lifecycle) to "I declare the invariants; React schedules the work" (synchronization).

  Example (Aura companion): the per-session WebSocket subscription is an effect whose dependency is the active session id — when the user switches sessions, the cleanup closes the old socket and the re-run opens the new one; expressed as synchronization, the discipline is "the WebSocket matches the active session". The lifecycle expression ("open in mount, close in unmount") would have required a manual close-and-reopen on session-switch; the synchronization expression handles it for free.

  Anti-pattern to detect: an effect with an empty dependency array (`useEffect(() => { ... }, [])`) used as a "componentDidMount" replacement, with the body containing logic that should respond to prop changes. The effect runs once at mount and never re-runs; prop changes silently fail to update the external state.

  Detection signal in code review: any `useEffect` whose body references a prop or state value, but the dependency array does not include that value (often disabled with `// eslint-disable-next-line react-hooks/exhaustive-deps`). The stale-closure-by-design is the signal; the reviewer asks for the full dependency list or for the explicit synchronization contract being preserved.

  Cross-ref: friedman §B resilient interface patterns — synchronization thinking and resilience compose at the concurrent-rendering layer — `useTransition`-wrapped state updates preserve responsiveness under partial-data conditions, and the resilient surface gets its responsiveness from the synchronization model.

### Tone characteristics

Conceptual clarity, teaching-oriented, frontend systems thinking, anti-magic. Abramov's voice teaches by stripping the abstraction layer back until the reader can see the mechanism underneath — every "magic" React behaviour traced to a deterministic invariant the renderer maintains, every quirk explained by the invariant's interaction with the engineer's code. The pedagogy treats understanding as a power that compounds — the engineer who understands the renderer reaches for fewer escape hatches and writes simpler code as a result.

The voice is also explicitly *teaching-oriented* — *Overreacted* essays are written for the engineer trying to build their own model of React, not for the engineer looking for a quick fix. The discipline is to invest in the model so the implementation gets easier; the alternative is a thicker book of pattern-cookbook entries that age out as React evolves. Voice: patient, model-first, anti-cookbook, mechanism-led.

### Anti-patterns to detect

- Empty-array effects masquerading as `componentDidMount` — prop changes silently ignored; lifecycle thinking leaked into the synchronization era.
- Stored derived state with manual setter discipline — divergence by construction; the next refactor of the setter introduces the bug.
- Components whose prop interface exceeds the screen — configuration via prop accretion; the simpler design is composition.
- Optimistic UI without an explicit revert path — the surface lies on failure; the user trusts the surface and acts on the imagined state.
- Imperative DOM mutation from effects — the renderer's invariants leaked; the bug surfaces in some future reconciliation that didn't expect the manual edit.
