# React/Web UI Frontend Quality Reference — Carmack × Kent C. Dodds × React 19

Philosophy: John Carmack. Specifics: Kent C. Dodds (AHA Programming, Testing Library, "Test behaviour, not implementation"). React 19 + Zustand + Tailwind + Vite.
Stack context: React 19 / Vite 6 / Tailwind 4 / Zustand 5 / CodeMirror 6 / xterm 6. No SSR, no Next.js, no Server Components, no tRPC, no CSS Modules. Single SPA served from Hono backend. State in a Zustand store with 8 slices keyed by session ID. WebSocket client (`web/src/ws.ts`) drives the store. Routing is hash-based (`#/playground`).

Every finding must describe the **concrete cost of getting it wrong** — not just "this is bad practice."
Visual design quality is in `quality-ui.md` (Saarinen). UX patterns and flows are in `quality-ux.md` (Friedman). Accessibility is in `quality-a11y.md`. Test quality is in `quality-testing.md` (Beck). This doc covers: React architecture, Zustand store discipline, derived vs stored state, hooks correctness, component composition, error boundaries, and the React 19 surface (`useTransition`, `useDeferredValue`, `use`, Actions).

---

## Principle 1: Eliminate state that can be derived, then colocate what remains

*Carmack: "State is the enemy."*
*Dodds: "Don't sync state. Derive it." Every piece of stored state that could be computed is a synchronisation bug waiting to happen.*

### What to check

**Derivable state stored in `useState`**
- A `useState` whose value can be computed from props, Zustand store state, or other state in the same render. Example: `[isStreaming, setIsStreaming]` when the assistant's `lastMessage.status === 'streaming'` is the actual source of truth. The two will drift on the next bug.
- Severity: **P1** for derivable state controlling critical flow (permission UI, streaming indicators, session-end gates). **P2** for UI nice-to-haves.

**`useEffect` to sync between state sources**
- `useEffect(() => setLocalCopy(zustandValue), [zustandValue])`. This is the synchronisation anti-pattern in its cleanest form. The store value IS the source of truth; read it directly during render.
- Severity: **P2**.

**Props mirrored into `useState`**
- `const [internal, setInternal] = useState(props.value)` and then `useEffect` to sync. Derive from props on every render, or lift the source up.
- Severity: **P2**.

**URL/hash route mirrored into local state**
- `useEffect(() => setRoute(window.location.hash), [])` without subscribing to `hashchange`. The hash is the source of truth; read it via a hook that listens for `hashchange`.
- Severity: **P2**.

---

## Principle 2: Zustand slice discipline — narrow selectors, immutable updates

*Carmack: "Less code means fewer bugs."*
*Zustand 5 is selector-driven: components subscribe to a slice of state. A component that selects the entire store re-renders on every change. A reducer that mutates state breaks shallow-equality bail-outs.*

### What to check

**Components selecting the whole store**
- `const store = useStore()` instead of `const messages = useStore(s => s.messages[sessionId])`. Re-renders on any state change anywhere in any session. With long-running sessions this is unbounded re-render cost.
- Severity: **P2** for whole-store selection in any frequently-rendered component.

**Selector returns a fresh object every call**
- `useStore(s => ({ messages: s.messages, isStreaming: s.streaming }))` builds a new object every render → shallow-equal fails → re-renders forever. Use multiple selectors OR `useStore(s => s.messages, shallow)` with explicit equality.
- Severity: **P2**.

**Mutating store state**
- `state.messages.push(msg)` instead of `set(state => ({ messages: [...state.messages, msg] }))`. Mutation breaks Zustand's change detection. Some components see the update; others don't.
- Severity: **P1** for any direct mutation of store state.

**Slice cohesion broken**
- `AuthSlice` reaching into `ChatSlice.messages` directly inside its reducer. The Zustand store has 8 slices per CLAUDE.md mapping; cross-slice writes should go through a single composed action, not slice-to-slice reach-arounds.
- Severity: **P3** for moderate leakage. **P2** for repeated cross-slice mutation.

---

## Principle 3: React 19 — useTransition, useDeferredValue, Actions

*Carmack: "Latency is always a bug."*
*React 19 surfaces async-rendering primitives that change how UI freezes during expensive updates. Using them wrong (or not at all) means typing in `Composer` hitches when a long message arrives, or a permission decision blocks scrolling.*

### What to check

**Expensive renders without `useDeferredValue`**
- A `MessageFeed` that re-runs a markdown parser on every keystroke as the user types in the Composer. The render path should use `useDeferredValue` to defer expensive recomputes until the input pauses.
- Severity: **P2** for typing latency in chat surface from un-deferred renders.

**Synchronous large updates that should be transitions**
- "Switch session" loads a new message history into the store. Without `startTransition`, the UI freezes during the diff. With `useTransition`, the previous session stays interactive (and `isPending` shows a subtle indicator).
- Severity: **P3** unless freeze is observable. **P2** if user-visible.

**`use(promise)` outside a Suspense boundary**
- React 19's `use(promise)` requires Suspense. Missing Suspense means render throws repeatedly. Either wrap in `<Suspense fallback={...}>` or fetch with a different primitive.
- Severity: **P1**.

**Actions used as if they were synchronous**
- React 19 form actions return a state, but `useActionState` is the supported pattern. Manual `<form onSubmit>` with `async` calls and ad-hoc state is the legacy model. Mixing breaks Suspense boundaries.
- Severity: **P3** unless the mix has caused observed bugs.

---

## Principle 4: WebSocket-driven state — the `ws.ts` contract

*Carmack: "Make data flow visible and explicit."*
*`web/src/ws.ts` is the single mutation channel for the store from server events. If a component pushes server-derived state directly into Zustand bypassing `ws.ts`, two write paths exist and they will diverge.*

### What to check

**Components calling `set` with server data**
- Any component that mutates the store from a fetch/WS response in its own `useEffect`. The store update path should be: `ws.ts` parses event → calls a store action → component reads. Two parallel paths is a recipe for ordering bugs.
- Severity: **P2**.

**Reconnect drops queued user input**
- User types and presses Send while disconnected. The send call fails silently. There must be either: an outbox queue that flushes on reconnect, OR a visible disabled-input state. Silent failure is worst.
- Severity: **P1**.

**Sequence number / replay not consumed**
- `ws.ts` should track `lastSeqSeen` (see `quality-realtime.md`) and re-request missed events on reconnect. If it doesn't, the UI silently misses events from disconnect periods.
- Severity: **P1**.

**Tool result parsing in components, not in `ws.ts`**
- `TodoWrite`/`TaskCreate` tool extraction into the task panel is done in `ws.ts` per CLAUDE.md. If components parse tool blocks themselves, the extraction logic forks and the task panel drifts from the chat view.
- Severity: **P2** for parsing duplication.

---

## Principle 5: Error boundaries and `useErrorBoundary`

*Carmack: "Deploy assertions as tripwires."*
*A React render error crashes the entire tree to a blank page by default. Without granular boundaries, one buggy tool-result renderer takes down the chat. With boundaries, one section shows an error while the rest stays functional.*

### What to check

**No top-level error boundary**
- `App.tsx` must be wrapped in an error boundary. Without it, any unhandled render error blanks the screen and loses the WS connection. Use a library boundary (`react-error-boundary`) or a hand-rolled class component.
- Severity: **P1**.

**No per-section boundaries**
- `ChatView`, `Sidebar`, `TaskPanel` should each have their own boundary. A failing `ToolBlock` should not crash the sidebar.
- Severity: **P2**.

**Async errors not routed to boundary**
- Promise rejections from event handlers don't propagate to error boundaries by default. Use `useErrorBoundary().showBoundary(err)` to route them, or rethrow during render after `useState`-setting the error.
- Severity: **P2**.

**Boundary that swallows without logging**
- An error boundary that renders "Something went wrong" but doesn't log to PostHog/console wastes the failure signal. Log full error + component stack.
- Severity: **P2**.

---

## Principle 6: Composition over configuration

*Carmack: "Make data flow visible and explicit."*
*Dodds: prefer compound components over prop-heavy single components. `<PermissionBanner action={...} suggestions={...} model={...} onAllow={...} onDeny={...} onSetMode={...} />` is brittle. Composition with slots reads better and bends more easily.*

### What to check

**Prop-bloated components**
- A component with 8+ props on its public API. Likely each prop signals a different responsibility that wants its own subcomponent.
- Severity: **P3** unless prop additions are repeatedly painful.

**Prop drilling that skipped composition**
- `App → ChatView → MessageFeed → MessageBubble → ToolBlock` passing the same `sessionId` through every layer. Use Zustand store with a `sessionId` selector, or React Context scoped to `ChatView`. Don't drill.
- Severity: **P2** when 3+ layers forward unused props.

**Render-prop or `cloneElement` patterns**
- React 19 has better primitives. Render props are still valid for some advanced patterns but most uses are better served by `children` slots.
- Severity: **P3**.

---

## Principle 7: Hooks correctness — dependency arrays and stale closures

*Carmack: "If you can't see the cost, you can't reason about correctness."*
*The dependency array is the single most error-prone surface in React. `react-hooks/exhaustive-deps` catches the common cases; what slips through is the deliberate omission with no rationale.*

### What to check

**Disabled or stale `exhaustive-deps`**
- `// eslint-disable-next-line react-hooks/exhaustive-deps` without an inline reason is a debt marker. Often the right answer is to use `useEvent` (or React 19 `useEffectEvent` when available) for the mutable function.
- Severity: **P2**.

**Functions recreated every render passed to `useEffect`**
- An inline `const handle = () => {...}` referenced in a `useEffect` dep array re-runs the effect every render. Use `useCallback` OR move the function inside the effect.
- Severity: **P2**.

**`useRef` for state**
- `useRef` is a mutable box that doesn't trigger renders. Storing state in a ref bypasses React's update model. Sometimes correct (timers, debounce handles), often a mistake (component appears to read stale data).
- Severity: **P3** unless it's hiding a real bug.

**Cleanup function missing on subscriptions**
- `useEffect(() => { ws.subscribe(...) })` without `return () => ws.unsubscribe(...)`. Listeners leak across mounts.
- Severity: **P2**.

---

## Principle 8: Type system as armour — at the boundary

*Carmack: "Use the type system to prove absence of flaw classes."*
*The Aura store is fully typed (`AuthSlice`, `ChatSlice`, etc.). Components consume that typing. `any` casts at the boundary erase that protection — usually because the store type lies.*

### What to check

**`any`/`as` at store boundary**
- `useStore((s: any) => s.messages)` — a single `any` undoes Zustand's whole typing. Same for `as` on the return value.
- Severity: **P2**.

**Discriminated union not exhausted**
- `switch (msg.type)` on the typed CLI message union with no `default`. TypeScript can require exhaustiveness via `never` assertion. Without it, new union members produce silent fallthrough.
- Severity: **P2**.

**Catch blocks treating `error` as `Error`**
- Catch blocks must accept `unknown`. `error.message` access on `unknown` is a type error. Use a helper that narrows or duck-types `.message`.
- Severity: **P3**.

---

## Principle 9: CodeMirror and xterm are React-foreign — wrap them carefully

*Carmack: "Validate at the boundary."*
*CodeMirror 6 and xterm 6 mount their own DOM. React reconciliation can fight them — destroy their internal state, double-mount, or fail to clean up. Always isolate them in dedicated wrapper components with deliberate effect lifecycle.*

### What to check

**Editor instance recreated on every render**
- `useEffect(() => { const view = new EditorView(...) })` without proper init guard re-creates the instance every render. Editor state (selection, scroll) resets.
- Severity: **P1**.

**Editor `destroy()` not called on unmount**
- Without cleanup, every navigation to a CodeMirror view leaks the view instance. Memory grows linearly with navigations.
- Severity: **P2**.

**Direct DOM mutation outside the editor's API**
- Reaching into CodeMirror's DOM to set selection or content. Use the editor's `dispatch`/`update` API. Direct DOM mutation desyncs from the editor's internal state model.
- Severity: **P2**.

---

## Principle 10: Know your gaps

*Carmack: epistemic humility — you can't fix what you don't know is broken.*

### Areas this doc is weaker on (supplement from other sources)

- **Bundle size and code splitting**: Vite handles this; not a frequent finding source.
- **SSR/RSC patterns**: not used in this project; out of scope.
- **Accessibility deep dive**: separate doc — `quality-a11y.md`.
- **Animation choreography**: covered briefly in `quality-ui.md` (Saarinen).
- **State management trade-offs Zustand vs Redux vs Jotai**: project uses Zustand, not a finding source.

---

## Quick Reference: Severity Guide

| Severity | Pattern | Examples |
|----------|---------|----------|
| **P1 — Fix Now** | Re-renders break, state corrupts, render crashes hard | Store mutation, `use(promise)` outside Suspense, no top-level error boundary, reconnect drops user input silently, missing replay on reconnect, editor instance recreated every render |
| **P2 — Fix Soon** | Sync anti-patterns, prop drilling, missing cleanups | Whole-store selection, selector returning new object, async errors not routed to boundary, disabled `exhaustive-deps` without rationale, cross-slice mutation, parallel store-write paths from components, prop drilling 3+ levels |
| **P3 — Consider** | Hygiene, composition opportunities, edge polish | Manual ref-as-state, missing exhaustive `switch` discriminator, render-prop where slots would work, transition-eligible synchronous updates, prop count above 8 |

### The Overriding Filter

Before writing any finding, apply the React 19 + Zustand synthesis:

1. **Is this state necessary?** If derivable, flag it.
2. **Is the selector narrow and stable?** Wide or freshly-built selectors murder render budget.
3. **Is there exactly one write path for this data?** Two parallel paths means race.
4. **Does the component clean up its subscriptions, effects, and editors?** Leak budget is finite.
5. **Are React 19's primitives used where they help (`useTransition`, `useDeferredValue`, `<Suspense>`)?** Or is the code stuck in React 17 patterns?
