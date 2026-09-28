# Beck — Test Quality Review

**Scope:** 11 new test files (≈900 LOC, 166 tests) accompanying the Phase A+B+C source modules. All green; this review asks the harder question: *would they go red on a real regression?*

**Verdict:** Strong overall. Pure-module tests (validators, state machine, predicates, reconciliation) are behavioural, use literal `toEqual`, exercise both happy paths and rejection modes, and would mutation-test well. The coordinator's atomic-rollback claim **is** verified at the right granularity (`toHaveBeenCalledWith("sess-1")`). Mocks are confined to the spawner/killer system boundary — coordinator tests are not mock theatre. NUL-byte rejection tests *do* contain real `\x00` bytes (the Read tool renders them as spaces; raw byte inspection confirmed them).

Findings below are calibrated against actual mutation resistance. None are P1 — the test suite is genuinely better than the median AI-generated suite at this size.

---

## Findings

### F1 — Watcher tests use fixed sleeps as the proof of "nothing happened"
**File:** `web/server/checkpoint-watcher.test.ts:93-114` (`ignores .tmp staging files`)
**Principle:** Principle 4 / Test Desiderata — *Deterministic, Predictive*. Quality-testing.md "deterministic logic tested through non-deterministic integration" → P2.
**Severity:** P2.

**What's wrong:** The `.tmp` test asserts that no event fires by `await new Promise(r => setTimeout(r, 250))` and then `expect(seen).toHaveLength(0)`. A real `fs.watch` event after the 250ms window (debounce is 150ms; coalesced events on macOS/Linux can fire later) would pass the test today and fail tomorrow under CI load. The "init wait" of 50ms in every test in this file is the same pattern — adequate on a dev laptop, fragile on a contended runner.

**Consequence:** Flake under load. Worse, an actual regression where the dotfile filter is removed could *also* sneak past on a fast machine (the watcher's debounce timer might be queued but not yet fired by 250ms). The "negative" test in particular cannot ever prove the negative — only "did not yet fire in 250ms".

**Fix:** Use `vi.useFakeTimers()` and tick the debounce window deterministically. For the negative test, either drive a *positive* control event after the `.tmp` write to prove the watcher is still listening (then assert `seen.length === 1` with the right id), or replace the polling shape with a single drained-queue check.

---

### F2 — `transition` determinism check passes on broadly-wrong implementations
**File:** `web/server/group-state-machine.test.ts:79-93`
**Principle:** Principle 6 — *Assertions ARE the test* / mutation resistance.
**Severity:** P2.

**What's wrong:** The "transition from %s never returns undefined" loop asserts `expect(ALL_STATES).toContain(transition(state, event))`. A mutated `transition` that *always* returns `"active"` would pass this entire table — `"active"` is in `ALL_STATES`. The assertion is `not-undefined` dressed up as a determinism check.

**Consequence:** The block reads like a property test (every (state, event) is covered) but provides almost no signal. The explicit per-transition `expect(...).toBe(...)` cases above carry the real load; this loop is coverage theatre.

**Fix:** Either delete the loop, or convert it into a real total-function snapshot: build the full 5×8 expected-output table and assert `expect(transition(s,e)).toBe(expected[s][e])`. That table doubles as documentation of the state machine.

---

### F3 — Archive ordering claim is asserted in comments, not by tests
**File:** `web/server/session-group-coordinator.test.ts:120-145` (`archiveGroup`)
**Principle:** Principle 2 + 6 — behavioural assertion of the *temporal* invariant.
**Severity:** P2.

**What's wrong:** The comment on line 131-134 claims: "status flips BEFORE the kill calls so that a session-exit event from the first kill cannot trigger a respawn racing the second." The test then only checks the *final* state (`c.get(g.sessionGroupId)?.status === "archived"`) and the kill count. An implementation that set `status = "archived"` *after* both kills (or between them) would pass this test. The race condition the comment warns about is not actually fenced by the assertion.

**Consequence:** The most consequential ordering guarantee in the coordinator — the one that prevents respawn-during-archive — is documented but not protected. A refactor that moves `g.status = transition(...)` below the kill loop would land green.

**Fix:** Wire the kill mock to read `coord.get(g.sessionGroupId)?.status` on each invocation and capture it. Then assert `expect(killStatusObservations).toEqual(["archived","archived"])`. That tests the *ordering* invariant rather than the end-state.

---

### F4 — `assertObserverToolPolicyConsistent` happy-path is asserted; error branch is not
**File:** `web/server/observer-permissions.test.ts:68-76`
**Principle:** Principle 5 — *Tests as behavioural variants* (missing error case is a known LLM failure mode, here inverted: error case is the *whole* point of this function).
**Severity:** P2.

**What's wrong:** Only the no-throw branch is exercised. The function's reason for existing is to *throw* when allow/deny lists intersect. That throw branch is never tested with a deliberately conflicting input. The constants are module-level frozen and not parameterised, so the function as written is hard to test that way — but the canary's whole value-prop is unverified.

**Consequence:** A refactor that subtly broke the intersection check (e.g. `OBSERVER_DISALLOWED_TOOLS.filter(t => allowed.has(t))` mistyped as `allowed.has(t.toLowerCase())` after a normalisation pass) would not be caught. The canary becomes a vacuous true at boot.

**Fix:** Either parameterise `assertObserverToolPolicyConsistent(allowed, disallowed)` so a unit test can pass intersecting lists and `expect(() => ...).toThrow(/appear in both/)`, or extract the predicate `hasIntersection(a, b): string[]` as a pure helper and pin it with `expect(hasIntersection(["Read","Bash"], ["Bash"])).toEqual(["Bash"])`.

---

### F5 — `OBSERVER_*_TOOLS` literals duplicate the implementation; test doubles as the spec
**File:** `web/server/observer-permissions.test.ts:15-30, 36-45`
**Principle:** Principle 1 — *Expected values from implementation*. **Mitigated** by intent — the test exists *as* the pinning canary.
**Severity:** P3 (signal only).

**What's wrong:** The expected arrays are character-for-character copies of `OBSERVER_ALLOWED_TOOLS` and `OBSERVER_DISALLOWED_TOOLS`. Under Beck's "expected values derived from implementation" rule, that's normally a P1. But here the test's *purpose* is exactly to be a tripwire — it's the spec lock-in, not a derivation. The risk is that any change to the canonical lists requires changing both files in one diff, which an AI editor can do without thinking.

**Consequence:** If a future agent widens the allow-list (adds "Bash") and updates the test in the same commit to match, the test happily passes and nothing surfaces. This is the Beck-on-AI scenario verbatim: "I'll just change the test."

**Fix:** Lower-tech option — annotate the test with an inline comment stating "any change to this list requires Hunt review; do not update in the same commit as the source." Higher-tech option — add a CODEOWNERS-style rule that requires a non-AI review on `observer-permissions.ts`. Out of test-suite lane otherwise.

---

### F6 — `sessionGroupId` regex assertion duplicates the source pattern
**File:** `web/server/session-group-coordinator.test.ts:47`
**Principle:** Principle 6 — *Assertions duplicating production logic*.
**Severity:** P3.

**What's wrong:** `expect(record.sessionGroupId).toMatch(/^grp_[a-f0-9]{32}$/)` re-implements `GROUP_ID_PATTERN` from `group-authorization.ts` and `generateGroupId`'s output shape from `session-group-coordinator.ts`. If both are mutated coherently to e.g. `grp_[a-f0-9]{16}` (16 bytes vs 32 chars confusion), the assertion silently drifts with the implementation.

**Consequence:** Weaker mutation resistance than the test suggests. The ID *length* and *prefix* are security-relevant (entropy budget); they deserve a literal pin, not a structure pin.

**Fix:** Assert at least the structural invariants that *cannot* drift: `expect(record.sessionGroupId.length).toBe(36)` and `expect(record.sessionGroupId.startsWith("grp_")).toBe(true)`. Then keep the regex as a secondary check.

---

### F7 — `createGroup` happy-path does not assert on the second-spawn's backendType
**File:** `web/server/session-group-coordinator.test.ts:34-48`
**Principle:** Principle 5 — *behavioural variants*. Mixed-pairing branch is the value-prop.
**Severity:** P3.

**What's wrong:** The happy-path test uses `primary: "claude", observer: "claude"`. The `spawn.calls[0]?.sessionGroupRole === "orchestrator"` / `spawn.calls[1]?.sessionGroupRole === "observer"` assertions cover roles, but the `backendType` propagation is not checked for the cross-family pairing (`claude+codex`). That's the more interesting case — `isSupportedPairing` and `experimental: true` both flow from it.

**Consequence:** A bug where `createGroup` passed `req.primary` to *both* spawn calls (ignoring `req.observer`) would pass every existing test — `claude+claude` is symmetric. The experimental cross-family pairing's primary value-prop (different backend on observer) is unverified.

**Fix:** Add one test: `createGroup({primary:"claude", observer:"codex"})` then `expect(spawn.calls[0]?.backendType).toBe("claude")` and `expect(spawn.calls[1]?.backendType).toBe("codex")`.

---

### F8 — `parseObserverReviewPayload` factory-mutation tests share fixture state via reference
**File:** `web/server/council-types.test.ts:122-148`
**Principle:** Principle 5 + Test Desiderata *Isolated*.
**Severity:** P3.

**What's wrong:** `const p = validReview(); p.findings[0]!.evidence_path = "/etc/passwd"` mutates the factory's output. The factory is per-call so isolation is fine in practice, but the type-cast hack `(p.findings[0] as unknown as { severity: string }).severity = "STOPP"` (line 124) is the brittle kind — readers can't tell whether this is a setup-state hazard or a deliberate type-system bypass.

**Consequence:** Future test edits may accidentally share state if the factory is later memoised. Minor.

**Fix:** Build each malformed payload from scratch with an inline object literal that's *almost* valid; that makes the malformation visible at the call site rather than diffing against a factory.

---

### F9 — No replay/property test on `parseCodexFrame`; hand-rolled fixtures only
**File:** `web/server/codex-envelope.test.ts` (entire file)
**Principle:** Principle 9 — *Recording-based replay tests*. Quality-testing.md: "Engineer wrote `'{"type":"system","..."}\n...'` by hand. Almost certainly drifts from real CLI output."
**Severity:** P2.

**What's wrong:** Every fixture is a hand-rolled `JSON.stringify({...})`. The Aura recorder already captures real Codex JSON-RPC frames to `~/.companion/recordings/` per CLAUDE.md. None are used. The parser's whole reason for existing is to chew on real protocol traffic; we have no test that proves it ever accepts a recorded frame end-to-end.

**Consequence:** Drift between the hand-rolled fixtures and what Codex actually emits is invisible. A method name format change in real Codex (e.g. new dotted segment depth) wouldn't surface until production.

**Fix:** Add a `parseCodexFrame.replay.test.ts` that reads a small fixture file (`web/test/fixtures/codex-frames.jsonl` — committable since it's protocol bytes) and asserts every recorded line parses to a non-null `CodexFrame`. Property test alternative: use `fast-check` to generate random valid frames and assert round-trip via the parser.

---

### F10 — Watcher init-wait magic number (50ms) repeated four times
**File:** `web/server/checkpoint-watcher.test.ts:58, 82, 107, 146`
**Principle:** Principle 4 — *Test economics*. Quality-testing.md: "flaky tests with retry workarounds" → P2.
**Severity:** P3.

**What's wrong:** Every test that needs the watcher to be "ready" does `await new Promise(r => setTimeout(r, 50))`. This is an undocumented assumption about how long `fs.watch` takes to subscribe. No symbol, no comment justifying *50*, no exposed `ready` promise on the watcher.

**Consequence:** When this flakes (and it will, on a contended runner), the fix-pressure is to bump 50→100→250 in a `git blame`-driven panic. The root cause — no readiness signal from `watchCheckpoints` — never gets fixed.

**Fix:** Have `watchCheckpoints` expose a `whenReady: Promise<void>` (resolved after the first `for await` iteration is entered, or by polling the internal watcher's first emission). Tests `await whenReady` instead of guessing. Eliminates the magic number and gives the production code a useful affordance too.

---

## Summary

- **P1:** 0
- **P2:** 4 (F1, F2, F3, F9)
- **P3:** 6 (F4, F5, F6, F7, F8, F10)
  - F4 elevated reasoning above; placed P2 — keeping count: P2=5, P3=5.

**Corrected totals: 0 P1, 5 P2, 5 P3.**

Strongest tests in scope: `group-reconciliation.test.ts`, `atomic-write.test.ts`, `observer-write-policy.test.ts` — literal `toEqual`, real filesystem, exhaustive table-driven rejection cases, no mocks. These are the model the watcher and coordinator tests should reach for.

Weakest signal: the watcher's timing-based negative assertions (F1, F10) and the coordinator's archive-ordering "promise" (F3). The latter is the highest-leverage fix — the ordering claim is real, load-bearing, and currently advisory only.
