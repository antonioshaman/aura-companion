# Beck — Test Quality findings — PR #68 bootstrap-fix

Reviewer: Kent Beck (test-driven discipline + small safe steps)
Scope: every `.test.ts(x)` file touched by `feat/council-mode-bootstrap-rest` over `origin/main`.

Going in with the working hypothesis that the suite is healthy (validator reports flagged the test-body shape as substantive, gates green at HEAD `8f3e675`), I'm filtering for what's still missing rather than what's there. The headline finding is one P2 reachability gap on the App-mount bootstrap wiring; the rest are graded down deliberately because the empirical evidence does not motivate higher severity.

---

## P2 — App.tsx bootstrap useEffect has no direct test; `fetchGroups → hydrateGroups` plumbing is unverified

**File:** `web/src/App.test.tsx:96` (mock added, no assertion); `web/src/App.tsx:174..` (the useEffect under test)
**Severity:** P2

**Finding.** The new App-mount bootstrap is a three-link chain: `isAuthenticated` flips → `useEffect` fires → `api.fetchGroups()` resolves → `useStore.getState().hydrateGroups(groups)` dispatches. Every link is individually covered (api unit, reducer unit, integration test calls `store.hydrateGroups` directly), but the link that **wires them together at the App layer** — the useEffect body itself — has no test. `App.test.tsx` only adds `fetchGroups: vi.fn().mockResolvedValue({ groups: [] })` so existing authenticated tests don't blow up on `undefined`; no test asserts `mockApi.fetchGroups` was called, or that an authenticated render dispatches into the store, or that the auth-flip dependency works (an unauth → auth transition mid-render).

**Consequence.** A future refactor that drops the bootstrap useEffect, changes its dependency array to a stale value, removes the `hydrateGroups` dispatch, or accidentally gates it behind another condition will type-check, will pass every existing test, and will silently re-open `BUG-council-mode-group-rest-bootstrap-gap.md` in production. The integration test in `glyph-after-reload.test.tsx` does NOT catch this — it imports `Sidebar` directly and calls `store.hydrateGroups()` manually, bypassing `App.tsx` entirely. Empirically: the very chain whose absence motivated this PR is the chain with no end-to-end assertion. This is the `feedback_call_site_presence_not_just_symbol_export` / `feedback_recovery_branch_reachability` shape — every component is implemented and unit-tested, but the wiring is unverified.

**Fix (minimum-step alternative).** Add ONE test to `App.test.tsx`: render `App` in an authenticated state, await microtasks, assert (a) `mockApi.fetchGroups` was called exactly once, and (b) the store's `groups` map has the record returned by the mock. One test, ~15 lines, closes the reachability gap that motivated the entire PR. Do not extend the integration test to mount `App` — its job is store ↔ Sidebar, and widening it loses the bug-isolation it has now.

---

## P3 — Integration test's "bug repro" canary does not distinguish "no group in store" from "ProjectGroup didn't plumb councilRole"

**File:** `web/src/glyph-after-reload.test.tsx:181..199` (the `WITHOUT hydrateGroups` test)
**Severity:** P3

**Finding.** The bug-repro test asserts `store.groups.size === 0 && store.groupBySessionId.size === 0` BEFORE rendering and then asserts the glyph is absent. This makes the test a valid regression for the REST-bootstrap gap (no group → no glyph), but it does NOT exercise the second bug the PR fixed: `ProjectGroup.tsx` was silently dropping `councilRole` even when the group WAS in the store. Against a hypothetical state of "group present but ProjectGroup forgot to spread role", this test would still see `groups.size === 1`, would not match the early `expect(0)`, and would never reach the glyph-absent assertion that would distinguish the two failure modes. The PR's commit message frames this as caught by the integration test ("the integration test surfaced this"), but what surfaced it was the AFTER-hydrate test failing — the bug-repro test would have passed on either codebase.

The context brief itself acknowledges this in its question to me — "does the WITHOUT hydrate → no glyph test actually distinguish ProjectGroup didn't plumb councilRole from no group in store? Yes — because both halves are present as sessions, and groupBySessionId is empty (verified explicitly via expect(store.groups.size).toBe(0))" — but the answer is structurally wrong. The two failure modes have different store states; the test pins ONE of them. Verifying `groups.size === 0` confirms the bug-repro state corresponds to the REST gap, not that the test would distinguish the OTHER bug. They share an observable outcome (no glyph) but not a precondition; the precondition assertion is doing valid pre-state checking, not differential diagnosis.

**Consequence.** The integration suite over-claims its coverage. If someone re-introduces the ProjectGroup `councilRole`-drop bug in isolation (e.g. by reverting just the +7/−2 ProjectGroup fix while keeping the REST bootstrap), the bug-repro test passes (it sets up the no-group state), the after-hydrate test fails (no glyph despite hydrate landing). That fail-mode IS protective, so the regression IS caught — but the way the bug is reported reads as "WITHOUT hydrate → glyph absent" which is misleading attribution. Future bisects will be slower because the test's title says "bug reproduction (no hydrate)" while what actually fails is the after-hydrate test against the ProjectGroup-only regression.

**Fix.** Add a third small test pinning the ProjectGroup plumbing specifically: seed both halves AND seed the group record, do NOT call hydrate (it's already in the store via direct `upsertGroup`), assert both glyphs render. That isolates "group present in store → glyph renders" from "REST hydrate path → glyph renders". Or, less invasively, rename the current bug-repro test to "without group record → glyph absent" (the actual precondition) and add a comment that the ProjectGroup regression-protection lives in the after-hydrate test's pass condition.

---

## P3 — `ws-bridge` synthetic-hydration test surface does not assert `status` field or wire-shape parity with the helper

**File:** `web/server/ws-bridge.test.ts:5145..5263`
**Severity:** P3

**Finding.** The ws-bridge `deriveGroupCreatedForBrowser` path now routes through the same `buildBrowserGroupRecord` helper as the live push and REST bootstrap (refactor in this PR). The PR's cross-site parity test in `session-orchestrator.test.ts:3741+` asserts byte-identity between push and REST. But the ws-bridge synthetic-hydration tests at line 5145+ check only `sessionGroupId`, `primarySessionId`, `observerSessionId`, and `pairing` — they do NOT assert `status: "active"` or `wakeTimeoutMs: OBSERVER_WAKE_TIMEOUT_MS`. The PR's wire-shape diff added BOTH fields to the synthetic-hydration output. The validator's carry-forward finding flagged this: cross-site parity covers push vs REST, not ws-bridge:1289 directly.

The context brief offers the trade-off "helper-determinism + structural-keys canary cover it indirectly" — that's the right framing, and at this PR's risk level (additive `status` field, defensive `?? "active"` fallback on the client) I agree the gap is acceptable. The structural-keys assertion in `browser-group-record.test.ts` does catch a field-drop at the helper layer, and if the ws-bridge call site stops passing one of the four parts, TypeScript flags it.

**Consequence.** Three producers exist; two have direct field-by-field assertions on their output (push via the parity test, REST via the route test), one (ws-bridge synthetic hydration) trusts the helper. A future ws-bridge refactor that bypasses the helper (e.g. inlining the construction for a perf reason) and accidentally hardcodes `status: "active"` would NOT be caught by the existing tests — they pin pairing + ids but not status. The helper-determinism canary fires only if the helper itself is called.

**Fix.** Either (a) extend ONE of the existing ws-bridge synthetic-hydration tests to also assert `groupMsg.status === "active"` and `groupMsg.wakeTimeoutMs === OBSERVER_WAKE_TIMEOUT_MS`, or (b) add a single test that does the three-way parity check (push, REST, ws-bridge synthetic) against the same coordinator state. Option (a) is the minimum-step alternative — one or two extra `expect()` lines in an existing test.

---

## P3 — Idempotency reference-identity tests are correctly testing reference equality, but coverage of `findings`/`groundingDowngrades` reference stability is incomplete

**File:** `web/src/store/council-slice.test.ts:323..340` (the two no-op tests)
**Severity:** P3

**Finding.** The empty-input and all-duplicate-input tests assert `after.groups === before.groups` and `after.groupBySessionId === before.groupBySessionId` — that's the strict version, and it's the right invariant for Zustand-subscribed selectors. The empty-input test ALSO asserts findings + groundingDowngrades reference stability (lines 327-328). The all-duplicate-input test (line 333+) asserts groups + groupBySessionId reference stability but does NOT assert findings + groundingDowngrades reference stability. The production code (council-slice.ts:255+) returns `{}` in both no-op paths, so reference stability holds for all four maps in both cases. The test is asymmetric where the production code is symmetric.

**Consequence.** If a future refactor accidentally re-clones findings or groundingDowngrades in the all-duplicate path (e.g. moves the `new Map(s.findings)` outside the `mutated` short-circuit), the empty-input test catches it for the empty path but the all-duplicate test passes silently. Selectors over `findings` (FindingsLog announcer) would spuriously re-fire on every bootstrap that happens to re-hydrate an already-present group.

**Fix.** Add two lines to the all-duplicate test: `expect(after.findings).toBe(before.findings); expect(after.groundingDowngrades).toBe(before.groundingDowngrades);`. Minimum step.

---

## P3 — Cross-site parity test in `session-orchestrator.test.ts` is the right test for the keystone invariant; flagging one gap

**File:** `web/server/session-orchestrator.test.ts:3879..3909` (the cross-site parity test)
**Severity:** P3

**Finding.** The test is well-shaped for the invariant — it seeds the launcher's `getSession` mock with matching `backendType` for both halves, emits the bus event, captures `broadcastToGroup` args, calls `getAllGroupsForBootstrap`, and asserts the five shared fields equal byte-for-byte. This is the empirical test for the keystone invariant ("push and REST produce identical wire shapes from the same coordinator state"). The loop over `["sessionGroupId", "primarySessionId", "observerSessionId", "pairing", "status", "wakeTimeoutMs"]` makes any field-drop loud — the assertion identifies which field diverged.

One small gap: the test seeds `backendType: "claude"` for the primary and `backendType: "codex"` for the observer, which yields `pairing: "claude+codex"`. It does NOT exercise the symmetric `pairing: "claude+claude"` path. If the helper had a bug where it ordered the two backends alphabetically only when both were "claude", this test would not catch it. The structural-keys canary in `browser-group-record.test.ts:71` partially covers this but doesn't compare ACROSS producers.

**Consequence.** Low — the helper is one line (`${primary}+${observer}`), the asymmetric case is the harder one and is covered. But the empirical test is "claude+claude is the most common pair, claude+codex is the experimental cross-family variant" (helper test header line 16-17). Covering parity only on the rare variant inverts the priority.

**Fix.** Either (a) add a second cross-site parity test for the `claude+claude` case (~20 lines, copy-paste with two field changes), or (b) extend the existing test to seed two groups (one of each pairing) and run the parity loop twice. Option (b) is fewer lines and exercises the parity invariant across pairings in one test body — which is also the more empirically-motivated shape (real production state has multiple groups of mixed pairings simultaneously, not one).

---

## NOTE — Test bodies are substantive (validator concern resolved)

**File:** `web/src/store/council-slice.test.ts:241..266` (the "DOES NOT overwrite" test)
**Severity:** NOTE — no fix required, recording the verification

**Finding.** I verified the test the context brief specifically asked about. The "does NOT overwrite groups already in the store — live WS wins" test:
1. Calls `upsertGroup` to seed the group.
2. Calls `recordCheckpoint` to populate `lastCheckpointAt` (1_700_000_000_000), `lastCheckpointSeq` (5), and `observerReviewing` (true) — verified the seeded state survives the seed (lines 261-262).
3. Dispatches `hydrateGroups` with the same group id but no runtime-state fields.
4. Asserts ALL THREE fields survive: `lastCheckpointAt === 1_700_000_000_000`, `observerReviewing === true`, `lastCheckpointSeq === 5`.

This is the substantive shape — runtime state is observably set BEFORE hydrate (the pre-assertions on lines 261-262 catch a fixture regression where `recordCheckpoint` didn't seed what we expected), then verified AFTER hydrate. Pair with the `wireFinding` / `appendObserverReview` test (lines 273-285) which does the same shape for findings — seed via the WS dispatch path, verify hydrate preserves. The empirical evidence motivating both tests is "REST snapshot doesn't carry runtime fields → hydrate must not clobber"; the tests pin exactly that, no speculation.

This is the kind of test body that passes my "test infected" sniff test: the assertions are specific values, not `toBeDefined()` / `toBeTruthy()` shapes, and the pre-state assertions catch fixture rot.

---

## NOTE — Per-finding format check on integration test mock surface

**File:** `web/src/glyph-after-reload.test.tsx:65..72` (the `mockApi` shape)
**Severity:** NOTE

**Finding.** The integration test mocks `api.listSessions`, `api.fetchGroups`, and four CRUD methods. The fact that the test's `beforeEach` (line 156) re-asserts `mockApi.fetchGroups.mockResolvedValue({ groups: [] })` AFTER `vi.clearAllMocks()` is correct — `clearAllMocks` resets `mockResolvedValue` to undefined, and Sidebar's mount path WILL hit `api.listSessions` during render even though this test doesn't probe it. This is the `feedback_test_env_pollution_explicit_unset` shape applied to mock state — explicit re-binding after a reset, not trusting baseline. Good.

The single shape-watcher detail: the mock for `mockApi.fetchGroups` is never asserted in this file. The test exercises `store.hydrateGroups([...])` directly. That's correct for the test's scope (store ↔ Sidebar reactive chain), but it means this file does NOT prove the App.tsx bootstrap useEffect dispatches into the same `hydrateGroups`. See P2 above.

---

## Missing tests audit

Following the empirical-test-design rule (write tests for observed failure modes, not for symmetry), the gaps that meet the bar:

1. **App.tsx mount-effect dispatch** (P2 above) — observed failure mode is `BUG-council-mode-group-rest-bootstrap-gap.md` itself; the bridging useEffect has no end-to-end test.
2. **`fetchGroups` REST error path** (P3) — `App.tsx:188` swallows the error with `console.warn`. No test asserts the catch fires, no test asserts the store remains untouched when `fetchGroups` rejects. Real-world failure mode: network blip on cold start, group store stays empty, next live `group:created` arrival populates it. Test would be 5 lines. NOTE only because the failure mode is recoverable (next WS event saves you).
3. **deadRole carry-forward** — context brief flags this as out-of-scope, agreed. The frontend's `?? "observer"` fallback in the panel-state deriver is unrelated to this PR's surface. Beck would not add the test in this PR.

The gaps that do NOT meet the bar (speculation, not empirical):
- Per-field passthrough tests for every wire-shape field individually (the structural-keys + cross-site parity tests already pin the contract; per-field would be combinatorial-test-explosion territory).
- Per-status passthrough tests for the four possible `BrowserGroupRecord.status` values (the helper test pins `degraded`; the orchestrator test pins `active` and `degraded`; that's empirically sufficient).

---

## Summary

The PR's test surface is mostly healthy. Test bodies are substantive (not vacuous), runtime state is observably seeded before idempotency assertions, the reference-identity assertions are testing the strict version that matches Zustand's subscription semantics, and the cross-site parity test is the right shape for the keystone invariant. The single P2 is the App.tsx mount-effect wiring — the chain whose absence motivated this PR has no end-to-end test; every individual link is covered, the bridging useEffect is not. That's the minimum-step-alternative fix: ONE test, ~15 lines, in `App.test.tsx`. The P3 findings are real but ship-acceptable; they collectively cost ~30 lines to close if the PR wants to land at full test density.

The PR is also doing the Beck-tidy-first shape correctly elsewhere — the `buildBrowserGroupRecord` helper was extracted in its own commit (`d6d4a60`) BEFORE the call sites were rewritten to use it, and the helper has its own test file before any consumer test relies on it. That's textbook "make the change easy, then make the easy change." I want to flag that explicitly because it's the kind of discipline the council often only notices when it's missing.
