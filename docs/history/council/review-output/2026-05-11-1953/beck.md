# Beck — Test Quality Review

Scope: 11 paired source+test files in `web/server/` for Council Mode. Headline: tests are predominantly behaviour-on-realistic-inputs, mock count is low (system-boundary only — `kill`/`spawn` injection in coordinator, FS in watcher), no `.skip`/`.todo`/`xit` debt anywhere, no mock-built-never-injected pattern. The high-risk security modules (`observer-write-policy`, `group-authorization`, `codex-envelope`, `atomic-write`, `council-types`) carry the strongest tests — risk-calibrated coverage is correctly weighted. State-machine isn't over-tested relative to security: both are exhaustively parameterised.

The findings below are mostly P2 coverage gaps and one P1 in `observer-permissions.test.ts` where the load-bearing deny-list and the boot canary's failure path are never exercised. No theatre-level fakery, no weakened assertions, no impl-derived literal magic.

---

## P1 — Fix Now

### P1.1 — `getObserverSpawnOverrides` test never asserts on `disallowedTools` — the load-bearing deny list could return `[]` and tests still pass

**File:** `/root/aura-companion/web/server/observer-permissions.test.ts:52-66`

The function under test returns `{ allowedTools, disallowedTools, permissionMode }`. The test asserts:
- `b.allowedTools).not.toContain("Bash")` (line 60) — verifies a single negative on the allow list
- `permissionMode).toBe(OBSERVER_PERMISSION_MODE)` (line 64)

`disallowedTools` is **never read in any assertion** in `getObserverSpawnOverrides` tests. A regression that returns `disallowedTools: []` — or omits the field entirely with `disallowedTools: undefined as any` — would pass this suite. The entire point of the deny list is to be passed to the SDK spawn at runtime; if the seam returning it to the spawner drops it, the observer ends up with no explicit denials and only allow-list scoping. Allow-list-only is weaker than allow+deny because future SDK changes (e.g. permission-mode default flips) can widen at any time, with the explicit deny acting as the defence-in-depth layer.

Per `feedback_verify_test_bodies_not_just_names`: read the body — this is a "list pinned in constant, not asserted on the seam's return value" pattern. The constant test (`describe("OBSERVER_DISALLOWED_TOOLS")` at line 33) verifies the constant, but not that the seam **propagates** it. The propagation seam IS the production path that wires into spawn args. Pin the deny list on the return value too:

```ts
const o = getObserverSpawnOverrides();
expect(o.disallowedTools).toEqual([...OBSERVER_DISALLOWED_TOOLS]);
```

Also: the "returns fresh array copies" test (lines 56-61) mutates only `allowedTools`; no test confirms `disallowedTools` is also a fresh copy. Mutating the source array via the returned reference is exactly the kind of escalation a prompt-injected observer would attempt if it could.

**Consequence:** the deny list — the explicit defence layer for the highest-risk security module per PLAN — has no test asserting it flows through the actual spawn seam. Wire it up. **P1.**

---

### P1.2 — `assertObserverToolPolicyConsistent` boot canary: failure path never exercised — the canary cannot prove it bites

**File:** `/root/aura-companion/web/server/observer-permissions.test.ts:68-76`

The boot canary's only test is `expect(() => assertObserverToolPolicyConsistent()).not.toThrow()` on the canonical lists. The throw branch — when allow and deny intersect — is the entire reason the function exists. If someone refactored the function to `export function assertObserverToolPolicyConsistent(): void {}` (empty body) the test would still pass.

The comment on line 70-72 even acknowledges this: *"With the canonical lists this is a no-op; the test exists so that a later edit that breaks the invariant surfaces immediately at startup."* But the test never confirms the function would, in fact, surface anything. Per the quality-testing reference Principle 6 ("Mutation resistance"): if `return null` (or in this case, `{}`) in the function body would pass the test, the assertion is too weak.

Beck's principle: the red step is the proof. The canary needs a test that proves it goes red:

```ts
it("throws when the allow and deny lists intersect", () => {
  // Temporarily widen by injecting overlap via test double or by
  // re-importing the module and monkeying the frozen list (or extract
  // the predicate to a pure function that takes both lists as args).
});
```

This is doubly important because `OBSERVER_ALLOWED_TOOLS` and `OBSERVER_DISALLOWED_TOOLS` are frozen at module load — a static-grep canary inspecting `inspect.getsource` equivalent (i.e. reading the source string and grep'ing for `OBSERVER_ALLOWED_TOOLS` not containing "Bash") would survive renames. The function should be refactored to accept lists as parameters so its red path can be tested directly without monkey-patching frozen module state.

**Consequence:** the security canary that's supposed to catch a future edit silently widening the observer's surface has no proof it actually catches anything. **P1.** (P1 because this is the explicit fallback for the regression scenario the codebase fears most — observer escalation via prompt injection.)

---

## P2 — Fix Soon

### P2.1 — `parseObserverReviewPayload` missing oversize and invalid-JSON tests — silent coverage parity gap with `parseCheckpointPayload`

**File:** `/root/aura-companion/web/server/council-types.test.ts:114-164`

`parseCheckpointPayload` has explicit tests for:
- invalid JSON (line 33)
- oversize via `COUNCIL_ARTIFACT_MAX_BYTES + 1` (line 39)
- mismatched `schema_version` (line 46)

`parseObserverReviewPayload` has **none** of these despite the implementation containing the same three guards (council-types.ts:138-146):

```ts
if (raw.length > COUNCIL_ARTIFACT_MAX_BYTES) return null;     // not tested
try { parsed = JSON.parse(raw); } catch { return null; }      // not tested
if (parsed.schema_version !== COUNCIL_SCHEMA_VERSION) return null;
```

(The `schema_version` case IS tested via "missing schema_version" on line 159, which deletes the field — but a `999` mismatched-version is not, and that's the case the writer-on-newer-schema scenario produces.) The two parsers are symmetric in production but asymmetric in test coverage. The observer review is the *higher-risk* parser because findings flow into the orchestrator's chat — an oversize hostile observer review (5 MB error message scenario) bloats recordings and storage if the guard regresses.

**Consequence:** if the oversize / invalid-JSON / mismatched-version guards regress in `parseObserverReviewPayload`, no test surfaces it. **P2.**

---

### P2.2 — `writeArchiveTombstone` "creates .council/ directory" test only asserts `not.toThrow()` — does not verify the directory or file actually exists

**File:** `/root/aura-companion/web/server/group-reconciliation.test.ts:86-88`

```ts
it("creates the .council/ directory if missing", () => {
  expect(() => writeArchiveTombstone(dir, "grp_xyz")).not.toThrow();
});
```

This test passes if the function returns without throwing — even if the implementation silently skips the write. Per the quality-testing reference Principle 4 ("assertion-free tests") and Principle 6 ("trivial assertions on complex returns"): the test promises one thing in its name ("creates the directory") but asserts a weaker thing ("doesn't throw"). The first proper test (lines 75-82) does verify file creation on a *flat* directory, but the nested-directory case — the actual behavioural claim — is only proven by absence-of-exception.

The fix is trivial:

```ts
writeArchiveTombstone(dir, "grp_xyz");
const raw = readFileSync(join(dir, ".council", "ARCHIVED"), "utf-8");
expect(JSON.parse(raw).session_group_id).toBe("grp_xyz");
```

**Consequence:** an implementation that swallowed the mkdir error silently would pass this test. Mutation-resistance: low. **P2.**

---

### P2.3 — `atomic-write.ts` parent-directory `fsync` best-effort path has no test

**File:** `/root/aura-companion/web/server/atomic-write.test.ts` (all 67 lines)

The implementation (atomic-write.ts:43-51) wraps the parent-dir `fsync` in `try { ... } catch { /* best-effort */ }` because some filesystems (tmpfs) don't support directory fsync. The comment explicitly calls this out as durability-critical: *"so the rename itself survives a power cut."*

No test verifies:
- normal-case behaviour when parent fsync succeeds (the happy durability path)
- swallowed-error behaviour when parent fsync fails (the tmpfs path)

The round-trip tests (line 20-65) cover the data-on-disk contract but cannot distinguish "rename succeeded + parent fsync succeeded" from "rename succeeded + parent fsync silently swallowed". If a future refactor accidentally removes the parent fsync, every test still passes. The bug would only surface on a power-loss test bed, where we cannot run it.

This is the kind of `feedback_trust_diff_not_prose` case — the docstring claims durability across power loss, but no test proves the fsync happens. Spy on `fsyncSync` or use a vitest mock of `node:fs` to assert `fsyncSync` is called on both the data fd and the directory fd.

**Consequence:** the durability claim that motivates the entire module's existence is asserted in prose but not in test. **P2.**

---

### P2.4 — `checkpoint-watcher.test.ts` debounce coalescing not tested — only the dotfile-ignore rule covers `.tmp` filtering

**File:** `/root/aura-companion/web/server/checkpoint-watcher.test.ts` (all 156 lines)

The implementation has a 150 ms debounce (`DEBOUNCE_MS`, line 10) explicitly justified as *"Some platforms fire two events for one atomic rename — coalesce them so the handler runs once per logical write."* (lines 7-9).

No test fires two events for the same filename within the debounce window and asserts the handler runs **once**. The handler-throws test (lines 131-154) uses two separate writes to *the same filename* but waits between them — that tests sequential processing, not coalescing.

A regression that changes the debounce to `setImmediate` or removes the timer-clearing logic would still pass every existing test. The behavioural claim in the docstring is unverified.

```ts
it("coalesces two rapid events on the same file into one handler call", async () => {
  // Either: write same atomic file twice within ~50ms, assert seen.length === 1
  // Or: synthetic event emitter test if watcher accepted one (it doesn't today)
});
```

**Consequence:** the historical "болтается" regression risk (per memory and the file's own docstring) is mitigated by debounce + atomic-write — but only one half of that pair is under test. **P2.**

---

### P2.5 — `backend-provider.test.ts` unsupported-pairing test uses `as "claude"` type-cast to defeat the type system

**File:** `/root/aura-companion/web/server/backend-provider.test.ts:35-40`

```ts
it.each<[string, string]>([
  ["codex", "claude"],
  ["codex", "codex"],
])("rejects unsupported pairing %s+%s", (a, b) => {
  expect(isSupportedPairing(a as "claude", b as "claude")).toBe(false);
});
```

The `as "claude"` cast bypasses TS's typecheck because `BackendType = "claude" | "codex"` already covers both values — the cast is unnecessary noise that hints the test author was wrestling with `BackendType` import. Functionally the assertion is correct; smell-wise it's a `feedback_trust_diff_not_prose` adjacent issue — when reviewers see `as`-casting in test inputs, the immediate question is "did the test go around the type system to make a wrong shape pass?" Here, no — but a future "unsupported pairing should be rejected" test that *does* want to feed a non-BackendType value (e.g. `"gemini"` to test that the registry rejects unknown providers) will inherit this `as` pattern and the line between "legitimate widening for negative test" and "type bypass to hide a bug" will blur.

Either import `BackendType` and use it directly, or pass `unknown` and have the function accept unknown and validate. Today the call signature is `isSupportedPairing(primary: BackendType, observer: BackendType)` which means an attacker-supplied unknown value would NOT pass through this allow-list check at all in production (TS would refuse). So the negative test is testing something that can't happen — the actual route-layer validation that this allow-list is meant to back is in `routes.ts` (per the file's docstring), and that's where a `"gemini"` rejection test belongs.

**Consequence:** the test exists, passes, and gives a sense of "we tested the deny path" — but the deny path it tests is one the type system already enforces. The real security boundary is at the deserialisation point. **P2 — coverage misplacement.**

---

### P2.6 — Co-committed test + impl with no intermediate-failure evidence (signal-only)

**File:** all 22 files in this batch

Per the PLAN, this batch landed in 3 commits. Per `feedback_trust_diff_not_prose`, the canonical AI-generated-test failure mode is "test and impl in same commit, expected values that look impl-derived." Spot checks:

- `observer-permissions.test.ts:16` pins `["Read","Grep","Glob","Write","Edit","TodoWrite"]` — identical to source. Mitigated by the test's stated intent (catch widening) and the structural fact that this list IS the API. **Acceptable.**
- `group-reconciliation.test.ts:23-26` pins `sessionGroupId: "grp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"` (a synthetic test value, not impl-derived). **Acceptable.**
- `codex-envelope.test.ts:8-13` pins the full output shape — but this is JSON-RPC, a real external protocol contract, so the literal IS the spec. **Acceptable.**
- `group-state-machine.test.ts:21-26` — state transitions are pinned with `.toBe("degraded")` etc. Names come from the lifecycle vocabulary that predates the implementation. **Acceptable.**

No expected value smells impl-derived. **P3 signal at most.** Filed here for transparency given the principle-1 risk profile of this batch.

---

## P3 — Consider

### P3.1 — `atomic-write.test.ts` oversize test depends on JSON-wrapping to push the payload over the limit

**File:** `/root/aura-companion/web/server/atomic-write.test.ts:36-39`

```ts
const big = { huge: "a".repeat(COUNCIL_ARTIFACT_MAX_BYTES) };
expect(() => writeAtomicJson(join(dir, "x.json"), big)).toThrow(/exceeds/);
```

The implementation checks `json.length > COUNCIL_ARTIFACT_MAX_BYTES` where `json = JSON.stringify(payload)`. The test relies on the implicit `{"huge":"..."}` wrapping (≈11 chars) to push the stringified output above the limit. Reader has to mentally compute "MAX + 11 > MAX" to know the test will trigger the guard. It works, but the intent is muddled — a future MAX change that interacts with JSON wrapping size could subtly invalidate the test.

Either size the input explicitly to land just above the limit (e.g. `repeat(COUNCIL_ARTIFACT_MAX_BYTES + 1)`), or refactor the production check to take `payload size after stringify` and pass `JSON.stringify(big).length === MAX + 11` as the assertion's basis. The cleaner version is:

```ts
const big = { huge: "x".repeat(COUNCIL_ARTIFACT_MAX_BYTES + 1) };  // guaranteed > MAX
```

**Consequence:** test intent obscure; future numeric edit could break implicit margin. **P3.**

---

### P3.2 — `group-authorization.test.ts` unused-looking `observerId` (it IS used)

**File:** `/root/aura-companion/web/server/group-authorization.test.ts:12,24,77`

False alarm during scan. `observerId` is declared, set, and used on line 77 (`resolveSessionGroup(coord, observerId)`). No finding — flagging here to document the trace.

---

### P3.3 — `OBSERVER_PERMISSION_MODE = "default"` test reads back the constant — tautological

**File:** `/root/aura-companion/web/server/observer-permissions.test.ts:63-65`

```ts
it("returns the canonical permission mode", () => {
  expect(getObserverSpawnOverrides().permissionMode).toBe(OBSERVER_PERMISSION_MODE);
});
```

Asserts the returned value equals the constant it's read from. If someone changed `OBSERVER_PERMISSION_MODE = "bypassPermissions"` (the catastrophic regression), this test passes silently because the constant on both sides shifts in lockstep.

Pin the literal:

```ts
expect(getObserverSpawnOverrides().permissionMode).toBe("default");
```

Same critique applies wherever a test reads `expect(fn()).toBe(MODULE_CONSTANT)` — the constant should appear as a literal on at least one side. Combine with P1.1 (assert `disallowedTools` literal on the return value) for one strong "wire-through" test.

**Consequence:** the most security-critical constant ("default" = approval prompts on every tool use) is asserted via tautology. **P3 — escalates to P1 if you accept the wire-through pattern above.**

---

## Summary

11 P-findings across 22 files (≈0.5 per file pair). Strongest tests: `observer-write-policy.test.ts`, `codex-envelope.test.ts`, `group-state-machine.test.ts`, `council-types.test.ts` (Checkpoint side). Weakest: `observer-permissions.test.ts` (P1.1, P1.2, P3.3 all cluster here).

Highest-leverage fixes:
1. **P1.1** — assert `disallowedTools` literal on `getObserverSpawnOverrides()` return value (1-line fix, plugs the deny-list propagation gap).
2. **P1.2** — refactor `assertObserverToolPolicyConsistent` to accept lists as params, then test the throw branch directly.
3. **P2.1** — port the three missing parser tests (oversize, invalid-JSON, mismatched-version) from `parseCheckpointPayload` to `parseObserverReviewPayload`.

No mock theatre, no `.skip` debt, no mock-built-never-injected, no `_, never been red` smoking guns. Risk-calibrated coverage is correctly weighted toward the security modules. The failures above are tightly localised; this is a Beck-friendly test suite that needs three targeted additions, not a rewrite.
