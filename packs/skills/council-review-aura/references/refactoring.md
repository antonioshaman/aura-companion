# Refactoring Reference — Carmack × Martin Fowler

Philosophy: John Carmack. Specifics: Martin Fowler.
Stack context: Bun + Hono + TypeScript backend / React 19 + Zustand + Tailwind frontend. The "god module" risk in this codebase is `web/server/ws-bridge.ts` (state machine + message router + permissions + history). Zustand slice cohesion is the corresponding risk on the frontend.

Every refactoring finding must answer: **"Will this slow us down?"** — not "is this clean?"

---

## The Central Question

Extract pure logic; keep state-mutating code visible and sequential. The first is universally beneficial. The second is dangerous when hidden behind a name.

---

## Principle 1: Refactoring is economic — leave stable code alone

*Fowler: "The point of refactoring is not 'clean code', it is purely economic."*
*Carmack: "The function least likely to cause a problem is the one that doesn't exist."*

Before flagging any structural issue, ask:
- **Is this code likely to change?** If stable and working, leave it.
- **Is the current structure actively making changes harder?**
- **Would this refactoring pay off in weeks?** If only in months, probably not worth flagging.

If you can't answer "yes" to at least one, don't flag. This kills 50% of low-value review comments.

---

## Principle 2: Extract pure logic, keep mutations visible

*Carmack: "The real enemy is unexpected mutation of state."*
*Fowler: Extract Function is "ninety-nine percent of the time" the right move for long functions.*

- **Extracting pure functions** (no side effects): always safe.
- **Extracting impure functions**: context-dependent. If extraction hides which state mutates and when, it's harder to reason about.

### What to check

**Long functions mixing pure and impure code**
- A `ws-bridge.ts` handler that parses + validates + mutates session state + broadcasts + persists. The parse and validate are pure — extract them. The mutate/broadcast/persist must stay visible in the sequence.
- Severity: **P2** when mixing makes the function hard to modify safely.

**Functions that lie about side effects**
- `getSession(id)` that also touches `lastAccessed`. Or `formatMessage(msg)` that also writes to the recording.
- Severity: **P2** — these are bug factories.

**Excessive extraction of trivial code**
- Single-use helpers that add a name but no clarity. Carmack: "if operations happen sequentially, their code should follow sequentially."
- Severity: **P3**.

---

## Principle 3: State is the primary source of bugs — minimise and contain

*Carmack: "A large fraction of flaws are due to programmers not understanding all possible states."*
*Fowler added Mutable Data, Global Data, and Loops as new smells in 2018.*

### What to check

**Mutable Data**
- Wide-scope mutable variables. In `ws-bridge.ts`: per-session state maps that are mutated from many code paths. If mutation paths fan out beyond ~3 sites, encapsulate.
- Severity: **P2** for wide-scope mutation. **P3** local.

**Global Data**
- Module-level mutables. In Bun/Hono server, the singleton bridge instance is global by design. Confirm no per-request state leaks into it.
- Severity: **P1** if cross-request contamination.

**State colocation failures (React)**
- Zustand store state used by exactly one component subtree. Either keep in Zustand with a narrow selector OR lift to component-local state. Cross-reference `quality-frontend.md` Principle 1.
- Severity: **P3**.

---

## Principle 4: Names reveal design

*Fowler: "When you can't think of a good name, it's a sign of a deeper design malaise."*

### What to check

**Names that lie or mislead**
- Functions named for one effect that also do another. Boolean flags whose `true`/`false` aren't obvious from the name. Generic names: `data`, `info`, `handler`, `manager`.
- Severity: **P2** if name misleads about behaviour. **P3** if merely vague.

**Comments as deodorant**
- Comment explains WHAT — refactor the code instead. WHY — keep the comment.
- Severity: **P3**.

**Inconsistent vocabulary across modules**
- Same concept with different names (`session`/`thread`/`conversation`). Pick one.
- Severity: **P3**.

---

## Principle 5: Smells that compound

### Feature Envy
- A function in one module spending more time in another module's data than its own. The bridge's `permission` handling that mostly reads from `session-store` is a candidate: either move the logic or design a narrower seam.
- Severity: **P2** if causing shotgun surgery.

### Shotgun Surgery
- One change requires edits across many files. Type changes that cascade through `session-types.ts` → `ws-bridge.ts` → `store/chat.ts` → `MessageBubble.tsx` are normal (the type IS the contract). Untyped manual cascades are the problem.
- Severity: **P2** — velocity dies here.

### Primitive Obsession
- Strings where domain types belong: session IDs as bare `string` instead of branded types, timestamps as raw `number`. TypeScript makes branded types cheap.
- Severity: **P3** unless causing unit confusion bugs.

### Speculative Generality
- Abstraction layers for one implementation. Generic backends parameterised over Claude/Codex when only two specific ones exist. Sometimes this lives in `claude-adapter.ts` vs codex routing — keep it pragmatic.
- Severity: **P2** if adding significant complexity. **P3** if just unused parameters.

---

## Principle 6: Architecture earns its boundaries

*Fowler: "Successful microservices started with a monolith that got too big."*
*Carmack: every abstraction boundary is more code, more state.*

### What to check

**Premature modularisation**
- A "services" layer when there are 10 endpoints. The Companion server's `routes.ts` calling directly into `ws-bridge` is fine for current scale.
- Severity: **P3**.

**Missing boundaries where they matter**
- Different parts changing for different reasons should be separated. The `ws-bridge.ts` does CLI lifecycle, browser broadcast, permission ack tracking, and session persistence — four concerns, four reasons to change.
- Severity: **P2** if cross-cutting changes have caused regressions.

**Published interfaces that shouldn't be**
- Module APIs treated as stable when they should be freely changeable. In a single-team monorepo, internal APIs can be churned.
- Severity: **P3**.

---

## Principle 7: The enabling triad — tests, CI, refactoring

*Fowler: "Only with testing, CI, and refactoring can you practice simple design."*
*Carmack: "The most important thing I've done as a programmer is aggressively pursue static analysis."*

### What to check

**Missing tests on changed code**
- Cross-reference `quality-testing.md` (Beck). Any refactoring PR without passing tests is restructuring, not refactoring.
- Severity: **P2** for changed code without test coverage. **P1** for critical paths.

**Tests coupled to implementation**
- Tests that break on refactoring without behaviour change actively discourage refactoring.
- Severity: **P2**.

**TypeScript strictness as static analysis**
- Cross-reference `quality-backend.md` Principle 8 and `security.md` Principle 2.
- Severity: **P2** for `strict: false`. **P3** for scattered `any`.

**Fear-zones in the codebase**
- Areas team avoids touching. `ws-bridge.ts` is the prime candidate. Each fear-zone is a refactoring debt that compounds.
- Severity: **P2**.

---

## Principle 8: Refactoring is not restructuring — review differently

*Fowler (via Beck): "When adding function, don't change existing code. When refactoring, don't add function."*

A PR that mixes both makes the reviewer unable to verify correctness of either.

### What to check

**"Refactoring" PR that changes observable behaviour**
- If tests had to be modified beyond mechanical renames, behaviour changed.
- Severity: **P2** for PRs labelled "refactor" that actually change behaviour without test updates.

**Refactoring sprints**
- If the team needs dedicated time, the codebase has already degraded. Flag at the meta level.

---

## Quick Reference: Severity Guide

| Severity | Pattern | Examples |
|----------|---------|----------|
| **P1 — Fix Now** | Correctness bugs from structure | Cross-request state in module scope, critical paths without tests |
| **P2 — Fix Soon** | Slowing the team down | Shotgun surgery, hidden mutations, feature envy, speculative complexity, tests coupled to implementation, refactor PRs that change behaviour, multi-concern god modules like `ws-bridge.ts` if cross-cutting changes have caused regressions |
| **P3 — Consider** | Hygiene that compounds | Vague names, data clumps, minor duplication, primitive obsession, premature abstraction, low-value extraction |

### The Overriding Filter

Apply Fowler's economic test: **"Will this slow us down?"** If not, lower the severity or skip. Carmack adds: **"Is this code hiding state that will surprise someone?"** If neither applies, move on.
