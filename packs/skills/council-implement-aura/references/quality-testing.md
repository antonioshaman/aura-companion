# Test Quality Reference — Carmack × Kent Beck

Philosophy: John Carmack. Testing expertise: Kent Beck (TDD creator, JUnit co-creator, Test Desiderata).
Stack context: Vitest 4 + `vitest-axe` 0.1 + `@testing-library/react` 16. Both Node (server/) and jsdom (src/) test envs. `toHaveNoViolations()` MANDATORY on every new component test per CLAUDE.md. Coverage gate ≥80% on new files in CI. Pre-commit hook runs typecheck + tests. Playground (`src/components/Playground.tsx`) acts as a render-time gallery for message-related components.

Every finding must describe the **concrete consequence** — not just "this test is bad."
This doc covers: test quality audit, mock discipline, behavioural coverage, AI-generated test failure modes, and the Aura-specific mandate of axe + render + interactive triad.

---

## Principle 1: The red step is the proof — a test that never failed proves nothing

*Carmack: "If a mistake is possible, it will eventually happen."*
*Beck: On AI agents: "I'll just change the test. No, stop it… If you ever change this, I'm going to unplug you."*

When AI generates code AND tests in the same commit, the red step is structurally impossible. The test was never seen to fail. It may be a restatement of the implementation.

### What to check (audit mode)

**Expected values derived from implementation**
- Test asserts the function returns `'session_a3f9-b2c1-active'`. That UUID smells like the implementation's internal generator. A human reasoning from requirements would write `expect(result.status).toBe('active')` not the literal UUID.
- Severity: **P1**.

**Test and impl co-committed without intermediate failure evidence**
- Git history shows both files added in one commit. The commit message contains no evidence of TDD ("test fails", "now passes"). Combine with other smells before flagging — this alone is not proof.
- Severity: **P3** signal-only.

### What to check (specify mode)

**Specify expected values explicitly**
- Don't write "assert correct result" — write the result.
- Use static-grep canaries via `inspect.getsource` (TS equivalent: read source string at test-time and grep for required substrings). Cross-reference memory `feedback_static_grep_canary_regex_over_substring`.

---

## Principle 2: Tests must be behavioural AND structure-insensitive

*Beck: a pairing — sensitive to behaviour change, insensitive to structure change.*

A test that breaks on refactoring but passes on regression is worse than no test.

### What to check

**Implementation-detail tests**
- `expect(wrapper.find('SessionItem').props().onClick).toBe(handleClick)`. Asserts internal wiring; breaks on rename. Use behaviour: `userEvent.click(screen.getByRole('button', { name: /open session/i })); expect(navigate).toHaveBeenCalledWith(...)`.
- Severity: **P1** for tests asserting on internal message-passing. **P2** for tests breaking on refactor.

**Asserting against the store's internal shape**
- `expect(useStore.getState().sessions.byId).toEqual(...)`. The store shape is implementation; what the user sees from selectors is behaviour.
- Severity: **P2**.

---

## Principle 3: Mock almost nothing

*Beck: "My personal practice is that I mock almost nothing."*

Every mock detaches the test from reality. 5 mocks deep, you're testing your mock config.

### What to check

**Excessive mock count**
- More than 2-3 mocks per test is a smell. More than 5 = mock theatre.
- Severity: **P1** if every dep is mocked and assertions verify mock interactions. **P2** above 3 without justification.

**Mocking internal modules**
- The bridge mocking `session-store`. The component mocking another component. Mock at the system boundary (WebSocket, fs, subprocess) — use real implementations within.
- Severity: **P2**.

**Mocks configured only for failure**
- THE signature LLM-generated test smell. Every mock returns errors; no happy path is exercised.
- Severity: **P1**.

**Mock built but never injected**
- Cross-reference memory `feedback_verify_test_bodies_not_just_names`. A mock declared at the top but never wired to the system under test means the test runs with real dependencies — vacuously "passing." Pair behavioural assertion with static-grep canary.
- Severity: **P1**.

---

## Principle 4: Test what might break — Beck's economics

*Beck: "Test as little as possible to reach a given level of confidence."*

LLMs invert this: 10 tests for trivial CRUD, zero for the bridge's reconnect logic.

### What to check

**Testing effort inversely proportional to risk**
- Trivial getters / config readers heavily tested. Complex modules (ws-bridge, claude-adapter, session-orchestrator) thinly tested.
- Severity: **P2** for risk-inverted coverage. **P1** for high-risk paths (auth, reconnect, permission gate) untested.

**Assertion-free tests**
- A test that calls the function and asserts nothing. Or asserts only `.toBeDefined()`. Coverage with no signal.
- Severity: **P1** for assertion-free in CI.

---

## Principle 5: Tests as behavioural variants

*Beck: "The test list is analysis."*

For each function: happy path, error cases, edge cases, boundary, concurrent scenarios.

### What to check

**Missing happy path**
- Signature LLM failure: error cases covered, success missing.
- Severity: **P1**.

**Tests organised by class/method, not behaviour**
- `describe('SessionStore')` with method-named `describe`s inside. Prefer `describe('when a session is created')`.
- Severity: **P3** signals structural coupling.

---

## Principle 6: Assertions ARE the test

*Beck: "Tests without meaningful assertions are theatre."*

### What to check

**Trivial assertions on complex returns**
- `expect(result).toBeTruthy()` on a complex object. Returns `{}` would still pass.
- Severity: **P1** for not-null/not-undefined on complex returns.

**Assertions duplicating production logic**
- `expect(formatSessionTitle(s)).toBe(s.cwd + ' - ' + s.model)` — re-implements the function in the assertion. Use a known expected literal.
- Severity: **P2**.

**Mutation resistance**
- If `return null` in the function body would still pass the test, the assertion is too weak.
- Severity: **P1**.

---

## Principle 7: The Aura a11y test triad — render + axe + interactive

CLAUDE.md mandates for every new component: render test + `toHaveNoViolations()` + interactive behaviour test.

### What to check

**Component test with only render + axe**
- No interaction test means buttons, keyboard handlers, focus management are unverified. Cross-reference `quality-a11y.md` Principle 1.
- Severity: **P2** for primary interactive components. **P3** for purely-display components.

**Axe assertion bypassed via `disableRules` without comment**
- Cross-reference `quality-a11y.md` Principle 1.
- Severity: **P1** for unjustified rule disabling.

**Render-only smoke test marked as the "axe test"**
- `it('renders accessibly', () => { render(<C />); expect(container).toHaveNoViolations(); })` does prove initial render. It does NOT prove that subsequent state changes (e.g. after click, after error) remain accessible. For modal/banner components, run axe on all reachable states.
- Severity: **P2** for state-changing components with axe only on initial state.

---

## Principle 8: Playground coverage

CLAUDE.md mandates: all message/chat components must have mocked states in `Playground.tsx`.

### What to check

**Component added/modified but Playground not updated**
- Easy to miss. Look at recent commits touching `src/components/` and grep for `Playground.tsx` in the diff.
- Severity: **P2** for missed Playground updates on message-flow components.

**Playground mock not exercising the bug**
- The state that triggered the bug should be in Playground. Use Playground as a regression visual checklist.
- Severity: **P3** but high signal.

---

## Principle 9: Recording-based replay tests

Cross-reference `quality-realtime.md` Principle 7 and `quality-llm.md` Principle 4. The Aura recorder is a free fixture library.

### What to check

**Bridge/adapter test using hand-rolled fake NDJSON**
- Engineer wrote `'{"type":"system","..."}\n{"type":"assistant","..."}'` by hand. Almost certainly drifts from real CLI output. Use a recorded session instead.
- Severity: **P2** for fake fixtures on protocol modules.

**No replay test on `claude-adapter.ts`**
- The adapter is the protocol translation layer; replay is its native test mode.
- Severity: **P1**.

---

## Principle 10: AI agents cheat — the spec is the constraint

*Beck on AI agents: "We don't comment out tests here."*

### What to check

**Weakened assertions**
- `.toEqual(expected)` softened to `.toBeTruthy()`. Look at git history for assertion changes.
- Severity: **P1**.

**`.skip` / `.todo` / `xit` accumulation**
- A skip without an open ticket reference is debt.
- Severity: **P2**.

**Expected values that drifted with implementation**
- Expected value changed in the same commit as the function. Suggests the implementation was changed and the test "fixed" to match.
- Severity: **P1**.

---

## Principle 11: The Test Desiderata applied to Aura

Beck's 12 properties. AI-generated tests sacrifice 4: **Behavioural, Structure-insensitive, Specific, Predictive**.

For audit: score each test on these four; low across all four = theatre.
For specify: state which Desiderata properties the test must exhibit.

---

## Quick Reference: Severity Guide

| Severity | Pattern | Examples |
|----------|---------|----------|
| **P1 — Fix Now** | False confidence, critical paths untested, agent cheating | Expected values from implementation, missing happy-path, mock-only assertions, weakened/deleted assertions, mock-built-never-injected, high-risk modules untested, no replay test on adapter, unjustified axe rule disable |
| **P2 — Fix Soon** | Coverage gaps, structural coupling, non-determinism | Mock count >3, structure-coupled assertions, flaky tests with retry workarounds, deterministic logic tested through non-det integration, missing edge cases, Playground out of sync, axe only on initial state, fake NDJSON fixtures |
| **P3 — Consider** | Maintenance, organisation, economics | Redundant tests, slow individual tests, trivial code tested, describe by class not behaviour, signals like co-committed test+impl |

### The Overriding Filter

1. **Does this test exercise behaviour?** If structure or mock-wiring, weaken.
2. **Would this test pass on a trivially wrong implementation?** If yes, the assertion is theatre.
3. **Is the highest-risk surface (reconnect, permission, adapter) tested with realistic input?** Recordings are the answer.
4. **Did axe verify post-interaction state, not just initial render?** State machines need state-by-state checks.
5. **Did this commit weaken something previously stronger?** Git history is part of test review.
