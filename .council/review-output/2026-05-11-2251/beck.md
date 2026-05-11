# Beck — Test Quality Review (Phases D–G)

Reviewer lens: Kent Beck — the red step is the proof, mock almost nothing, behavioural + structure-insensitive pairing, assertion-as-test, axe state-by-state, recording-based replay over hand-rolled fakes, agent-cheating signals.

Scope checked against the conventions floor: AP-1..3 and EC-1..9 not re-flagged; Beck F2/F3/F4/F6/F7 already in place across these files (visible as pure helpers exported solely for branch isolation, `Beck F4` comments throughout, in-repo prompt-artifact canary, system-boundary integration over mock theatre).

Overall posture: the test suite for Phases D–G is one of the stronger Aura test sets I have read. Pure helpers (`parseObserverPromptHeader`, `checkStopGrounding`, `clampWidth`, `applyTitleAlertPrefix`, `shouldIgnoreShortcut`, `matchesCouncilShortcut`, `severityClass`, `formatRelativeTime`, `parsePairing`, `isAttributeSafeToken`, `findUnresolvedStops`, `deriveObserverPanelState`) are each exercised branch-by-branch with structure-insensitive assertions; component tests use store integration over mocking; `observer-prompt.test.ts` carries a load-canary that reads the actual repo artifact; `review-watcher.test.ts` drives the real fs+watch+atomic-write stack rather than a stubbed walker. The findings below are the residual edges, not foundational concerns.

---

## P1

### B1. `handleCouncilReview` pipeline has zero direct test coverage

**Where:** `web/server/session-orchestrator.ts:430` (definition); no `*.test.ts` references the symbol anywhere in the tree.
**What this means concretely:** The handler is the load-bearing seam where (a) the `ObserverReviewPayload` lands from `review-watcher.ts`, (b) stable IDs are assigned to findings, (c) `validateObserverFindings` performs the STOP grounding downgrade against the orchestrator's modified-files manifest, (d) wire payloads + downgrades are broadcast via `broadcastToGroup`. Three of those four steps are unique to this method — the constituent pures (`validateObserverFindings`, `wrapObserverFindingForInjection`) are well-tested in isolation but their *composition under the orchestrator's authority over what counts as "modified files in this phase"* is exercised only at integration-test time, if at all. A future refactor that drops grounding ("we already trust the observer") or swaps the modified-files source ("git diff is more accurate than the manifest") would not light up red. This is precisely the high-risk module Beck P4 warns about: trivial pures heavily tested; the composing handler — where the wire→grounding→broadcast contract actually lives — untested.
**Why it matters:** Council Mode's value proposition is grounded STOPs. A regression that downgrades nothing, downgrades everything, or wires the wrong modifiedFiles set is exactly the bug class that would make the feature look fine in dev (findings render!) while silently failing its security/UX guarantee in production.
**Severity:** P1 — high-risk path untested.
**Reference:** `quality-testing.md` Principle 4 ("Test what might break") + Principle 5 (composition is the analysis, not the constituent functions).
**Fix:** Add a `session-orchestrator.council.test.ts` (or extend the existing orchestrator test file with a `describe("handleCouncilReview", ...)`). Feed a real `ObserverReviewPayload` with mixed STOPs/NOTEs through the handler; stub `modifiedFiles` from the checkpoint manifest; assert (a) downgrades emitted match expected indices, (b) the broadcast payload's `findings` array has downgraded STOPs rewritten to NOTE + `wasDowngraded:true`, (c) the broadcast carries the `groundingDowngrades` shape the slice expects. A single happy-path test + a "STOP outside modifiedFiles" test + an "evidence missing on disk" test is sufficient. Bonus: a recorded-payload replay fixture under `web/server/fixtures/council-reviews/` so EC-6 carries into Phase G.

---

## P2

### B2. `routes.test.ts` Council branch never asserts the SSE `/sessions/create-stream` path

**Where:** `web/server/routes.test.ts:545-635` covers `/api/sessions/create` only; `/api/sessions/create-stream` Council branch (`routes.ts:216-262`) has no corresponding describe block.
**What this means concretely:** The streaming variant has its own pairing-validation block, its own `councilMode/councilPairing` strip, its own progress-event emission shape, and its own `done` payload shape (which includes `observerSessionId` in addition to `sessionGroupId` — different envelope than the non-stream branch). The non-stream tests prove only that the non-stream handler is wired. A future change to the stream handler that, e.g., emits progress before validating pairing (leaking the invalid string into a UI event), forwards `councilMode` to the SSE `done` payload, or drops `observerSessionId` would pass `bun run test` green.
**Why it matters:** The two route variants are duplicated logic that will inevitably drift; the test set should cover both.
**Severity:** P2 — coverage gap on a code-duplicated surface.
**Reference:** `quality-testing.md` Principle 5 (test list = analysis; if there are two routes, there are two test lists).
**Fix:** Add `describe("POST /api/sessions/create-stream — Council Mode branch")` parallel to the non-stream describe; assert (a) invalid pairing emits an `error` SSE event before any `progress` event and never calls `createCouncilGroup`, (b) valid pairing emits two `progress` events bracketing the coordinator call, (c) the `done` payload carries both `sessionGroupId` and `observerSessionId`, (d) coordinator failure emits an `error` event with the propagated message.

---

### B3. `ObserverPanel` axe coverage skips the `reviewing` state

**Where:** `web/src/components/council/ObserverPanel.test.tsx:271-315` asserts axe on sleeping, blocker-found, degraded, and collapsed-rail — four of five. The `reviewing` state (status pill carries `aria-busy="true"`, distinct microcopy, panel may render a spinner) has no axe scan.
**What this means concretely:** A future addition that, say, animates a spinner via an `aria-hidden`-less SVG or a focus-trapping live region in the reviewing state would not trip axe in CI. Beck P7 / `quality-testing.md` Principle 7 calls this out explicitly: state-changing components must run axe state-by-state because each reachable state is a distinct accessibility surface.
**Why it matters:** `reviewing` is the most common active state in practice (every checkpoint flips through it). A11y debt accumulates fastest in the states the user sees most.
**Severity:** P2 — incomplete state-by-state axe coverage on the panel.
**Reference:** `quality-testing.md` Principle 7; `conventions.md` Aura a11y triad mandate (axe on each reachable state, not just initial).
**Fix:** Add one more `it("passes accessibility scan in reviewing state", ...)` block using the existing `seedGroup() + seedCheckpoint()` helpers (the reviewing state derives automatically because no review has landed yet to flip `observerReviewing` off).

---

### B4. `review-watcher.test.ts` relies on real-time `setTimeout(250)` waits without fake timers

**Where:** `web/server/review-watcher.test.ts:51, 71, 82, 105, 108, 111, 128` — each test waits 250–300ms wall-clock for the 150ms debounce + handler to settle.
**What this means concretely:** Per-file wall-clock cost ≈ 1s; per CI run on this suite, ~5 tests × 250ms each = ~1.25s minimum that scales linearly with each new case added. More importantly, these tests are non-deterministic on a loaded runner: an overcommitted CI agent can deliver the rename event after the wait window expires, surfacing as a flaky "expected length 1, got 0". The watcher code already accepts an injected timer surface conceptually (the debounce constant is module-local but the structure is friendly to DI); switching to `vi.useFakeTimers()` + `vi.advanceTimersByTimeAsync(160)` would tighten determinism and shave wall time. This is the classic Beck "deterministic-logic-tested-through-non-det-integration" smell.
**Why it matters:** Today the suite is green; the day someone adds a 6th case the cumulative wall-clock cost or a flaky CI agent will erode confidence in the file. Recording-based deterministic timing is the design lever already validated by `checkpoint-watcher` in Phase A–C.
**Severity:** P2 — non-deterministic dependency on wall-clock timing where deterministic mocking is feasible.
**Reference:** `quality-testing.md` Principle 4 ("Test as little as possible to reach a given level of confidence") + Principle 9 (deterministic over real-time, when the protocol allows).
**Fix:** Wrap each test's body in `vi.useFakeTimers()`; replace `await new Promise(r => setTimeout(r, 250))` with `await vi.advanceTimersByTimeAsync(160)` (one frame past the 150ms debounce); restore real timers in `afterEach`. The `fs.promises.watch` event still arrives in real time, so a small `await new Promise(setImmediate)` may be needed between the write and the advance — that's a 1-tick microtask wait, not a 250ms wall-clock wait.

---

### B5. `observer-grounding.test.ts` parent-traversal test does not pass through the source's traversal-reject branch

**Where:** `web/server/observer-grounding.test.ts:267-276` — "downgrades when evidence_path contains parent traversal" supplies `"src/../../etc/passwd"` to `validateObserverFindings`.
**What this means concretely:** The test relies on the `modifiedFiles` set membership check (line 64 of source) firing FIRST — the set contains exactly the same string `"src/../../etc/passwd"` (line 271), so this branch passes. But the test name implies it's exercising the `createWorkspaceExistsCheck` traversal-reject branch (lines 148-149 of source). It is not — the modified-set check happens first and returns "not_in_modified_set" before traversal-reject even runs. Reading the assertion, only `severity === "NOTE"` is checked, not the `downgrades[0]?.reason`. So a regression that removed the parent-traversal segment-check inside `createWorkspaceExistsCheck` would not surface here.
**Why it matters:** EC-7 is the most security-critical convention on the council/observer surface; the test that claims to defend it is testing the wrong layer.
**Severity:** P2 — assertion strength below what the test name claims.
**Reference:** `quality-testing.md` Principle 6 (mutation resistance — "would `return null` in the function body still pass the test?").
**Fix:** Either (a) populate `modifiedFiles` with a different string (e.g. `"foo.ts"`) so the traversal path is the one that triggers, or, better, (b) split into two assertions: one that pins `reason === "evidence_not_in_modified_set"` for the listed case, and a separate test that puts a known-modified path under the workspace, has the path resolve via `..` segments to the same realpath as a file outside-workspace, and asserts `reason === "evidence_missing_on_disk"`. The current `symlinkSync` test (line 237) already covers the latter behaviour from one angle; the traversal-string angle is the missing partner.

---

## P3

### B6. `BlockerBanner.test.tsx` HTML-escape test verifies absence-of-img but is reachable on a partial-fix

**Where:** `web/src/components/council/BlockerBanner.test.tsx:89-97`.
**What this means concretely:** The test does two assertions: `getByText(malicious)` succeeds (literal text rendered) and `querySelectorAll("img")` returns 0. The first is robust — `getByText` only matches text-node content, not HTML. The second is also robust because `<img>` is one of the recognisable tags that would be produced if React ever serialised the claim through `dangerouslySetInnerHTML`. This is actually a *good* pair, contra what the brief flagged. The minor edge: if a future refactor used `dangerouslySetInnerHTML` on `<span>{claim}</span>` and the malicious string only contained an `<img>`, the test catches it. If the malicious string only contained a `<script>` (which jsdom would parse-but-not-execute), the `getByText` check would FAIL (because `<script>` isn't text content in jsdom) and the test would still go red — different signal, but red. Net: the test is meaningfully mutation-resistant.

That said, the brief asked me to check whether the test could pass-even-when-broken. One narrow miss: if a renderer broke escaping but still emitted the textual content alongside the rendered `<img>` (e.g. via `outerHTML` interpolation), `getByText(malicious)` would still succeed because the textual exact-match query finds the element whose `textContent` is the malicious string. The `querySelectorAll("img")` check would then fire. So the conjunction is robust. Leaving this at P3 because the test is *better* than the brief implied, not worse.
**Severity:** P3 — minor strengthening opportunity.
**Reference:** `quality-testing.md` Principle 6.
**Fix:** Optional — add `expect(document.querySelectorAll("script")).toHaveLength(0)` and `expect(document.querySelectorAll("[onerror]")).toHaveLength(0)` as belt-and-suspenders, so future malicious-string permutations also light up.

---

### B7. `council-slice.test.ts` cross-test contamination defended ad-hoc; persistent-map reset belongs in `beforeEach`

**Where:** `web/src/store/council-slice.test.ts:335-347` and `web/src/use-council-shortcuts.test.ts:51-52` each contain a one-line comment explaining why the test guards against `observerPanelOpen` Map persistence across tests by either using a unique sessionId or by manually `useStore.setState({ observerPanelOpen: new Map() })`.
**What this means concretely:** Both files reinvent the same workaround inline. The store's `reset()` intentionally preserves user-preference maps (parallels `collapsedProjects`), which is correct production behaviour, but the test cost is that every test file that touches these maps has to either pollute its identifiers or reach into `setState`. A future test author who doesn't read the inline comment will write a test that passes alone and fails in suite — the exact "passes alone, fails in suite" canary that's bitten Aura before.
**Why it matters:** The defence is currently per-test; a single test that forgets it will introduce flakes that won't always reproduce. The brief's #2 question (does toggle test use a unique sessionId?) answers yes — but only this one test does. The collective pattern is fragile.
**Severity:** P3 — maintenance / convention.
**Reference:** `quality-testing.md` Principle 10 (AI agents will reproduce ad-hoc workarounds; codify them).
**Fix:** Either (a) expose a `resetCouncilPreferences()` helper on the slice that test `beforeEach` can call without affecting production `reset()` semantics, or (b) add a comment block at the top of `store.ts` documenting which fields survive `reset()` and pointing test authors to the canonical clearing pattern. Option (a) preferred — discoverable from autocomplete.

---

### B8. `routes.test.ts` Council branch mock-result shape pinned by integration, not by type

**Where:** `web/server/routes.test.ts:344-349, 562-565`.
**What this means concretely:** The mock `createCouncilGroup` returns `{ ok: true, sessionGroupId, primary: { sessionId, state, cwd, createdAt, backendType }, observer: { sessionId, ... } }`. The route handler forwards `sessionGroupId`, `primary`, `observer` to the client. The test asserts `json.primary.sessionId === "sess_orch"` and so on. The shape is consistent across mock + route + assertion — but the mock is a hand-rolled `vi.fn(async () => ({ ok: true, ... }))` with no link to the real `CouncilGroupCreateResult` type from `session-orchestrator.ts`. A future change to the real type that adds a required field (e.g. `pairingResolved: string`) wouldn't break this test; the route handler would compile because it spreads `primary`/`observer` whole, and the test would stay green.
**Why it matters:** This is a low-grade structure-coupling smell — the test pins the mock's shape, not the real type's shape.
**Severity:** P3 — typed-mock opportunity.
**Reference:** `quality-testing.md` Principle 2 (structure-insensitive).
**Fix:** Either (a) import `CouncilGroupCreateResult` from session-orchestrator types and annotate the mock factory's return type so a field addition breaks the file, or (b) leave as-is and accept that integration tests at the orchestrator level catch the missing field. (a) is cheap and worth the touch.

---

### B9. `observer-prompt.test.ts` and `observer-attribution.test.ts` exercise oversize via a single boundary value

**Where:** `web/server/observer-prompt.test.ts:104-108`, `observer-attribution.test.ts:51-53`.
**What this means concretely:** Each oversize defence is tested by `OBSERVER_PROMPT_MAX_BYTES + 1` (and `129` for `isAttributeSafeToken(128)`). One-past-the-boundary is correct; the *at-the-boundary* case (exactly `MAX_BYTES` long) is not asserted. A regression that flipped `> MAX` to `>= MAX` would not trip the +1 test (the function would still throw at +1) and the boundary case would now over-reject (legal MAX-byte inputs get rejected). The pair (`MAX` accepted, `MAX+1` rejected) is the Beck-canonical boundary pair.
**Why it matters:** Lone-side-of-boundary tests catch direction but miss off-by-one. This is exactly the failure mode of `> vs >=` that the boundary pair is designed to catch.
**Severity:** P3 — boundary completeness.
**Reference:** `quality-testing.md` Principle 5 (test list = analysis; boundary cases are part of the variant list).
**Fix:** Add `it("accepts exactly MAX bytes", () => { ... })` for both `loadObserverSystemPrompt` (with a body length of exactly `OBSERVER_PROMPT_MAX_BYTES`) and `isAttributeSafeToken` (with a 128-char string).

---

## What I did NOT flag (positive notes — for the implementor)

- **Pure-helper exposure pattern is consistent and load-bearing.** Every test file pairs a pure helper with its integrated wrapper (e.g. `checkStopGrounding` + `validateObserverFindings`, `applyTitleAlertPrefix` + `useBrowserTitleAlert`, `matchesCouncilShortcut` + `useCouncilShortcuts`, `clampWidth` + slice actions, `parsePairing` + `ProviderBadges`, `severityClass` + `FindingsLog`). This is exactly the Beck F4 idiom — branch-by-branch testable without the integration weight. Resist the urge to inline these "for readability".
- **In-repo prompt artifact load canary is the right shape** (`observer-prompt.test.ts:132-140`). A loader-vs-artifact schema drift would surface here; same hand-off as Aura's existing `/api/sessions` shape canary.
- **Symlink test in `observer-grounding.test.ts:237-251` is real** — it creates an out-of-workspace target, symlinks it into `src/escape.ts`, and asserts the grounding wrapper downgrades. This is the EC-7 boot canary in test form.
- **`use-council-shortcuts.test.ts` textarea/input ignore tests are correctly wired** — the test creates the element, focuses it, AND dispatches keydown on the element itself with `bubbles: true`, so the global window listener sees the event with `event.target === textarea` and `shouldIgnoreShortcut` rejects. The brief's #4 risk is unfounded; this test is solid.
- **`council-slice.test.ts` toggleObserverPanel uses a per-test-unique sessionId** (line 341) precisely to avoid contamination from the persistent `observerPanelOpen` map. The inline comment documents the why. This is good defensive testing; my B7 above is about codifying the pattern, not faulting the current test.
- **`observer-panel-state.test.ts` derives the priority ladder state-by-state** with one test per priority level — exemplary Beck-style analysis-as-tests. The five named states correspond to five visible UI affordances; the tests pin the priority order so a refactor that swaps `degraded` and `blocker-found` precedence would go red immediately.
- **`BlockerBanner.test.tsx` provider chip assertion uses exact selector** (`getByText("codex", { selector: "span" })`, line 35) to avoid substring collision with `gpt-5-codex`. This is the kind of disciplined assertion that's normally an LLM-test failure mode; the implementor caught it correctly.
- **Playground coverage is complete** for all five new council components plus a `CouncilDegradedPanelDemo` that exercises the live store path. CLAUDE.md mandate satisfied.
- **No `.skip`, `.todo`, `xit`, weakened assertions, or mock-built-never-injected detected** in any reviewed file. Mock count per test is ≤2 throughout (typically just `vi.fn()` for handler callbacks). EC-6 replay-based fixtures aren't relevant to these new modules (they aren't protocol parsers); the existing checkpoint-watcher / claude-adapter replay tests are unchanged and out of scope here.

---

## Summary

| Severity | Count | Tag                                                                 |
|----------|------:|---------------------------------------------------------------------|
| P1       | 1     | B1 — `handleCouncilReview` pipeline untested                        |
| P2       | 4     | B2 SSE branch · B3 reviewing-state axe · B4 wall-clock waits · B5 traversal-branch mistargeted |
| P3       | 4     | B6 escape belt-and-suspenders · B7 codify reset pattern · B8 typed mock · B9 boundary pairs |
