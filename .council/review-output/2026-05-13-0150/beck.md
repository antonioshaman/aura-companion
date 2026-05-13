# Beck — Test Quality Regression Review (2026-05-13-0150)

Scope: `web/server/council-wake-sentinel.test.ts` (NEW, 12 tests), `web/server/observer-wake-fixture.test.ts` (NEW, 5 tests), `web/server/observer-prompt.test.ts` (static-grep canary @ 436-451), `web/server/session-orchestrator.test.ts` (mandatory-echo fixture update).

Verified: prior pass's static-grep canary uses `\w+` via `\s*\(` — appropriate per `feedback_static_grep_canary_regex_over_substring` (the canaried symbol name is the load-bearing assertion; the regex-flex is in the whitespace, which is correct usage of the memory rule — a placeholder for the method's exact identifier would defeat the canary's purpose).

Verified: parser-reject branches for the wake sentinel are well-covered (non-JSON, schema_version mismatch, missing fields, negative sequence, malformed timestamp, raw-file corruption) — six independent inputs each pinned to `null`, mutation-resistant.

Verified: round-trip through `parseCheckpointPayload` and the live builder happy-path in `observer-wake-fixture.test.ts` cover the EC-6 fixture contract for the producer side.

---

## P1 — Fix Now

### B1 — `dispatchObserverWake` keystone STILL has zero direct behavioural test table; fix-pass closed sentinel + fixture coverage but the dispatcher itself remains canary-only

**File:** `/root/aura-companion/web/server/session-orchestrator.test.ts` (gap)
**Cross-reference:** prior cycle's Beck #13, prior-fix-pass intent

**Evidence:**
- `bun run test` shows zero matches for `dispatchObserverWake` or `[Ww]ake` test names inside `session-orchestrator.test.ts` — only line 2188 mentions `observer_wake_payload_version_echo` in a checkpoint fixture, which is review-path data, not a dispatcher invocation.
- `observer-prompt.test.ts:436-451` ships a static-grep canary asserting `this.dispatchObserverWake(` is reachable inside `handleCouncilCheckpoint`'s body. This proves the call site is wired in source. It does NOT exercise the 10 outcome branches the method emits (`dispatched`, `skipped_cross_group`, `skipped_no_pair`, `skipped_archived`, `skipped_already_woken`, `skipped_relaunching`, `skipped_observer_disconnected_will_drain`, `skipped_backpressure_queued`, `skipped_reconnecting`, `failed`).
- The fix-pass landed two NEW test files (sentinel + fixture, 17 tests) — neither touches the dispatcher's gate logic. The keystone surface — the function whose 10 outcomes the entire pipeline funnels through — is tested only by the indirect "wake-version echo" path in the review handler's downstream consumer.

**Consequence:**
A future refactor that flips the order of two gates (e.g. cross-group check after backpressure check), or that returns `dispatched` on the relaunching-half path, would ship green on every existing test — including the static-grep canary, which only proves the symbol is reachable. A bug like "observer wake fires before the observer's WebSocket attaches" is precisely the class of failure the gate ordering was designed to prevent; without a table-driven test, the regression surface for that class is invisible.

The prior pass's Beck #13 said "keystone surfaces zero direct behavioural tests." The fix-pass closed the keystone's two adjacent surfaces (sentinel parse/write/read; wake-payload bytes) but left the dispatcher itself in the same state. This is "moved the problem," not "fixed."

**Recommendation:**
Add a `describe("dispatchObserverWake outcome branches")` in `session-orchestrator.test.ts` with one `it.each` table covering each of the 10 outcomes. Use the existing orchestrator-with-stub-spawner harness already at the top of the file (search for `makeOrchestrator` or its analogue); inject a fake `sendObserverWakeFrame` recording calls; for each row, set up the orchestrator state to satisfy exactly one gate's input and assert (a) the outcome string emitted in the EC-9 log and (b) whether `sendObserverWakeFrame` was called. The fake's behaviour should be keyed by `(sessionId, checkpointId)` per `feedback_parallel_test_fakes_keyed_by_input`, not a call counter.

---

### B2 — `sendUserFrameFromServer` (the wake frame's actual on-wire send) has zero test of its 5 outcomes

**File:** `/root/aura-companion/web/server/claude-adapter.test.ts` (gap)

**Evidence:**
- `claude-adapter.test.ts` is 1364 lines and 80+ tests; zero matches for `sendUserFrameFromServer`, `observerTurnState`, or `wake`.
- The function emits 5 distinct outcomes (`sent`, `busy`, `socket_disconnected`, `backpressure`, `failed`) — the dispatcher branches on these to decide whether to write the sentinel and which EC-9 log line lands.
- Fix-pass landed `observerTurnState` resets in BOTH `detachWebSocket` AND `handleTransportClose` (prior #2). Without a test exercising the "send-while-busy" → "transport-closes" → "next checkpoint sends successfully" sequence, the reset's load-bearing role is invisible to the test suite. A regression that drops one of the two reset call sites (the kind of edit a "simplify duplicate clear" refactor would produce) ships green.

**Consequence:**
Beck Principle 4: testing effort is inversely proportional to risk. The wake-send path is the only server-initiated NDJSON frame in the codebase; every other CLI write originates from a browser-initiated `user_message`. Its protocol asymmetry (array-of-one-text-block vs the inbound plain-string) is documented in `observer-wake-fixture.test.ts:8-14` as the reason the fixture exists. The frame's outcome branches are the seam where backpressure / disconnect / busy-state interact with the dispatcher's gate decisions — exactly the surface the council prioritised closing.

**Recommendation:**
Add a `describe("sendUserFrameFromServer outcomes")` in `claude-adapter.test.ts` with five `it`s, one per outcome. Use the existing adapter-with-fake-socket harness (the file already constructs adapters with mock WebSocket and asserts on NDJSON bytes — see lines 513+). Mock at the WebSocket boundary, not internal modules, per Beck Principle 3.

---

## P2 — Fix Soon

### B3 — `observer-wake-fixture.test.ts` "live builder canary" does NOT compare bytes between live output and the pinned fixture

**File:** `/root/aura-companion/web/server/observer-wake-fixture.test.ts:92-125`

**Evidence:**
- The test's own header comment claims: "If the builder's output shape drifts, the unit asserts in this file stay green but THIS test fails — the round-trip through the consumer-side parsers is what pins the wire contract."
- What the test actually asserts (lines 113-121): `result.textBody` contains `"# Council Checkpoint — council-plan"`, contains `"```json"`, the inner JSON block parses, and four field values match. It NEVER reads the fixture file in this test case. It NEVER compares `result.ndjsonLine` (or `textBody`) byte-for-byte against `claude-v1.jsonl`.
- Mutations that would silently pass: re-order the JSON keys in the wake's inner block (the test asserts `Object.keys(...).slice(0, 5)` for that order in the SEPARATE test at line 58, but on the FIXTURE bytes, not the live builder output); swap the `# Council Checkpoint — {phase}` headline copy; append a trailing instruction sentence; flip `delta`/`carried`/`dropped` array ordering.

**Consequence:**
The fixture file's purpose is to be the EC-6 pinned-on-disk artefact the live builder's output must match. The current test exercises three properties (fixture parses, fixture has expected key order, live builder includes some substrings) but never closes the loop. A drift in the live builder's serialisation order — exactly the regression EC-6 pinning is designed to catch — ships green because the live-builder test exercises substring contains, not byte equality.

This is Beck Principle 6 mutation-resistance: the assertions are too weak. A trivially wrong implementation that re-orders the JSON keys, swaps the headline, or appends a sentence still passes.

**Recommendation:**
Either (a) byte-compare `result.textBody` (or the full NDJSON line) directly against `readFileSync(FIXTURE_PATH, 'utf-8').trim()` in the live-builder test — golden-file canary, fail-on-drift, fixture is the spec; or (b) split: keep the structural assertions for stability under non-load-bearing edits and ADD one new `it("live builder output equals the pinned fixture byte-for-byte (golden)")` that does the strict comparison. Option (a) is simpler; option (b) gives a localisation hint when the canary fails. If the team prefers (b) to allow controlled prose edits, the byte-comparison should canary the JSON BLOCK only (between the fence markers), since the surrounding prose is for the LLM and key-ordering inside the JSON is what the autoregressive parse depends on.

---

### B4 — `deleteCouncilWakeSentinel` has zero test coverage despite being a NEW helper this fix-pass added

**File:** `/root/aura-companion/web/server/council-wake-sentinel.test.ts` (gap)

**Evidence:**
- `council-wake-sentinel.ts:155-166` defines `deleteCouncilWakeSentinel` — added in this fix-pass per prior Persistence #16.
- `council-wake-sentinel.test.ts` has zero matches for `deleteCouncilWakeSentinel` or "delete".
- The function has three behavioural cases worth pinning: (1) deletes an existing sentinel; (2) ENOENT is silently absorbed (no throw); (3) other fs errors propagate. The contract is documented in the source's JSDoc but unenforced by tests — per memory `feedback_council_documented_contract_canary`, "contract in JSDoc = doc, not enforcement."

**Consequence:**
A refactor that adds a `console.warn` on ENOENT (turning the "best-effort" contract into a noisy log), or one that swaps `unlinkSync` for `rmSync` with `force: true` (which would silently swallow ALL errors, not just ENOENT), ships green. The sentinel-cleanup-on-exit path is the only call site preventing `.council/state/` accumulation across the long-running server's lifetime; a regression that breaks cleanup re-introduces the orphaned-file problem the fix-pass was meant to solve.

**Recommendation:**
Add three `it`s in `council-wake-sentinel.test.ts` under a new `describe("deleteCouncilWakeSentinel")`: (1) write a sentinel, delete it, assert `readCouncilWakeSentinel` returns null AND the file no longer exists on disk; (2) call delete on a never-written group — assert it does not throw; (3) (optional, harder) chmod the directory to read-only and assert delete throws (catches the "swallow-all" regression). The first two are mandatory; the third is nice-to-have.

---

## P3 — Consider

### B5 — `parseCouncilWakeSentinel` schema-version mismatch test only asserts the parser rejects; no documentation/test of the downgrade-or-migrate path the JSDoc promises

**File:** `/root/aura-companion/web/server/council-wake-sentinel.ts:25-29` + `council-wake-sentinel.test.ts:84-92`

**Evidence:**
- The source JSDoc at lines 25-29 says: "A future v2 bumps the accepted set in the reader; the writer always emits the current."
- The test at line 84-92 only asserts that a `schema_version: 999` payload returns `null` (the current parser's reject behaviour).
- There is no test asserting the migration-or-downgrade pathway documented in the JSDoc — because there is no migration pathway, only a reject. The JSDoc describes a v2-shaped future that doesn't exist in code.

**Consequence:**
Cosmetic. When v2 lands, the developer adding it will likely write the migration test as part of the same patch. The current state isn't broken — it's just that the JSDoc gestures at a future the test suite hasn't yet pinned. Flagging only because the prompt explicitly asked whether the mismatched-version's downgrade-or-migrate behaviour is tested separately. The answer is: no, only the reject. Per Beck Principle 4 economics, this is correct — don't test code that doesn't exist. Note it as a future TODO when v2 lands.

**Recommendation:**
None now. When/if a v2 sentinel schema is introduced, add a test asserting (a) v1 input parses to the v2 shape with default fields populated, or (b) v1 input still parses to a v1 reader, depending on which migration strategy the team picks. Optionally trim the JSDoc to remove the "future v2" sentence if the team decides reject-forever is the policy.

---

## Net assessment

The fix-pass closed Beck #13 **partially**: the two adjacent surfaces (sentinel filesystem helpers + wake-payload byte fixture) gained 17 new tests with strong parser-reject and round-trip coverage. The keystone itself — `dispatchObserverWake` with its 10 outcomes and `sendUserFrameFromServer` with its 5 — remains canary-covered only. The dispatcher gate logic is exactly the surface the council prioritised (it's where backpressure, disconnect, busy-state, archived-group, cross-group authorization all converge), so leaving it tested only by a "the call site is reachable from the handler body" static-grep is below the bar this codebase has set elsewhere (compare to `claude-adapter.test.ts`'s ~80 tests for the inbound protocol seam).

B3 (live-builder byte canary missing) and B4 (delete helper untested) are smaller but mechanical — both can land in one follow-up commit.

The static-grep canary itself is correct and well-formed per the memory rule (the regex flex is in whitespace; the canaried symbol name is the load-bearing assertion). No P1 finding on the canary's regex shape.
