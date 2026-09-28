# Beck — Test Quality Review (v2 router)

Scope: `web/scripts/detect-stack.test.ts` (24 tests) and `web/scripts/detect-stack.skill-mirror.test.ts` (15 tests). Lens: Test Desiderata — Behavioural, Structure-insensitive, Specific, Predictive; the cross-stack Aura memory `feedback_verify_test_bodies_not_just_names.md`; and the AC-binding contract from the v2-router plan §6.

Headline reading: the 24 detector tests are mostly real assertions on real fixtures (mkdtemp + writeFileSync, no mocks — Beck principle 3 satisfied) and the AC binding for AC-1.x..3.x is honest. Two structural gaps dominate the findings: **(a)** AC-4.3 and AC-5.1 have ZERO test coverage in this repo — they are assumed by the SKILL.md prose but never asserted, and **(b)** the entire 15-test mirror canary silently no-ops in any environment without `~/.claude/skills/`, including the very CI the test was designed to gate. Several individual tests check only the discriminated-union tag (`r.kind`) and would still pass if the detector wired the wrong markers to the wrong stack — those are the Aura "test-body" canary cases.

---

### 1. Mirror canary's `describe.skipIf(!skillsRootExists)` is fail-open in CI — the drift gate the test was meant to be does not fire where it matters most
| | |
|---|---|
| **File** | `web/scripts/detect-stack.skill-mirror.test.ts:45-101` |
| **Principle** | Principle 1 (red step is the proof) + Principle 10 (.skip / .todo accumulation = debt). The whole 15-test block becomes structurally inert when the gating predicate is false. |
**Finding:** `skillsRootExists` is evaluated once at module load against `~/.claude/skills` (or `$COUNCIL_SKILLS_ROOT`); when the path is absent, `describe.skipIf` collapses ALL 15 assertions to a green "skipped" status with zero CI-side surfacing of the gap. The test header even admits this — "CI environments that do not host the user's skills tree may skip this suite" — which is precisely the environment a drift canary must NOT skip in. The repo wiring confirms no `$COUNCIL_SKILLS_ROOT` is set in any CI workflow file or `vitest.config.ts`, so on any clean CI runner the canary advertises 15 green tests and asserts nothing.
**Consequence:** The "single source of truth + mechanical drift canary" architecture Fowler signed off on is enforced only on the original author's laptop. A PR that edits `MARKER_NAMES` in `detect-stack.ts` and forgets to update one SKILL.md mirror lands green on CI; the breakage surfaces the first time a real user invokes `/council-plan` after pulling main. The skip pattern converts the load-bearing canary into pure documentation.
**Fix:** Replace `describe.skipIf` with an explicit either-or: require `$COUNCIL_SKILLS_ROOT` in CI (default to a checked-in `web/scripts/fixtures/skill-mirror/` with frozen copies of the three SKILL.md bodies the test asserts against), and fail loudly when neither is found instead of skipping. The fixture-dir variant lets the test run hermetically; the env-var variant gates it on the real artefact. Both share the same body. Today's silent-skip is the worst of both.

---

### 2. AC-4.3 (back-compat of `-aura` skills when invoked directly) and AC-5.1 (variant output artifact paths unchanged) have zero test coverage
| | |
|---|---|
| **File** | `web/scripts/detect-stack.test.ts` (entire file) + `web/scripts/detect-stack.skill-mirror.test.ts:88-99` |
| **Principle** | Principle 4 (test what might break — high-risk path untested). AC with zero binding = vacuous AC. |
**Finding:** The plan's AC-4.3 says "explicit `-aura` invocations preserve their pre-router behaviour"; the only test the mirror file has for the AURA family is a negative assertion that the three `-aura` SKILL.md files do NOT contain a Phase 0 heading (`detect-stack.skill-mirror.test.ts:93-97`). That is half the contract — it proves the suffixed skills aren't accidentally polluted, but it does not prove they still dispatch to the same council compositions, the same expert reference docs, or the same review-output directory structure they did pre-router. AC-5.1 ("variant dispatch produces the same output paths — no router-introduced wrapper dirs") has no test at all: no assertion anywhere reads the SKILL.md output-path directives or compares them against a frozen baseline.
**Consequence:** A subtle SKILL.md edit that changes the output-artefact directory in `council-plan` from `.council/abtest/` to `.council/router/abtest/` ships green; the spec says path stability is a hard contract; the verifier proves it for the headline strings only. This is a P1 by the rubric ("an AC with zero test coverage").
**Fix:** Two new assertions in the mirror canary, each one-liner: **(a)** the three `-aura` SKILL.md files must each still contain their canonical "Output: write to `.council/...`" directive (assert presence of the stable substring); **(b)** the three suffixless SKILL.md files' Phase 0 blocks must NOT introduce any new output-path token (regex-negate `\.council/(router|abtest)/`). Both run inside the existing `describe.each` block — cost is six lines total. If the silent-skip from Finding 1 is also addressed, this lands properly gated.

---

### 3. Five core AC-1.x / AC-2.x detection tests assert only `r.kind` — they would pass if the detector wired Aura markers to the Python kind (or vice versa) provided the tag happens to match
| | |
|---|---|
| **File** | `web/scripts/detect-stack.test.ts:85-99, 117-126` |
| **Principle** | Principle 6 (Assertions ARE the test) + Aura memory `feedback_verify_test_bodies_not_just_names.md` — assertion on enum tag without behavioural evidence is structurally weak. |
**Finding:** AC-1.1, AC-1.2, AC-1.3, AC-2.1, AC-2.2 each end with `expect(detectStack(w).kind).toBe("aura")` (or `"python"`) and no further assertion. The five tests do not verify which marker actually matched, do not verify that `result.checked` contains the expected matched-name entry, do not verify that the OTHER stack's markers reported `matched: []`. If `probePackageJson` were swapped to look for `pyproject.toml` and `probePyproject` for `web/package.json`, the kind tag would still flip correctly per fixture and all five tests would stay green.
**Consequence:** This is the exact failure mode the Aura memory `feedback_verify_test_bodies_not_just_names.md` warns about — assertion on the discriminated-union tag without inspecting the body that produced it. A refactor that mis-wires the marker→kind mapping (or a future expert who reuses one of the probe functions for the wrong stack) lands green. The defence Fowler praised (the deduped `checked` enumeration) is not exercised by these tests.
**Fix:** Each of the five tests gains one line: `expect(r.checked.find(c => c.name === MARKER_NAMES.AURA_PACKAGE_NAME)?.matched).toContain(MARKER_NAMES.AURA_PACKAGE_NAME)` (and the symmetric Python case). Cost: five lines total. Payback: tests now break on wrong-marker-wired-to-wrong-kind, not just wrong-tag-from-right-marker. The AC-1.4 ambiguity test (line 100-111) already does this correctly — copy that pattern down.

---

### 4. Refusal-body substring assertions are weaker than the snapshot lock Fowler is going to ask for in Finding 1 of his review
| | |
|---|---|
| **File** | `web/scripts/detect-stack.test.ts:145-162, 244-255` |
| **Principle** | Principle 6 (Mutation resistance) + Principle 10 (weakened assertions). Substring-`toContain` passes on `"FOOBAR/council-plan-aura"` and on `"do-not-run /council-plan-aura"`; it does not lock structural position or word boundaries. |
**Finding:** The AC-3.1 test asserts `text.toContain("/council-plan-aura")`, `text.toContain("/council-plan-python")`, `text.toContain("Checked for:")`, `text.toContain("Found at workspace root:")`. None of these lock the structural ordering, the indentation of bullet lines, or that the override footer appears AFTER the marker enumeration. A copy-edit that re-orders sections, swaps two lines, or strips the two-space bullet prefix lands green. The AC-3.2 length cap (`≤18 lines`) is the only structural assertion in the suite.
**Consequence:** Two artefacts are downstream of this: the user's 10-second read budget (AC-3.2), and Fowler's load-bearing skeleton claim in his Finding 1 (the SKILL.md mirrors quote this skeleton verbatim). A substring-based assertion can't catch reordering or whitespace drift in either. If the SKILL.md mirrors get a snapshot-extension fix (Fowler Finding 1) but the runtime test stays substring-only, the two artefacts can still desync — the SKILL.md prose says "Found at workspace root:" appears third, the runtime renderer puts it first, the mirror canary checks presence only, this test checks presence only.
**Fix:** Add ONE snapshot assertion against a hand-frozen expected refusal body for the ambiguous case (the AC-1.4 fixture) using Vitest's `toMatchInlineSnapshot`. That single test becomes the structural lock; everything else (substring `toContain`) becomes redundant safety net. The inline-snapshot pattern keeps the expected body visible in the test file, which is what the test header (lines 5-8) already aspires to — "verifies its body, not only the discriminated-union tag."

---

### 5. Two redundant first-person/apology guards — and the `renderRefusal` one is the only one that exercises the actual rendered surface
| | |
|---|---|
| **File** | `web/scripts/detect-stack.test.ts:171-178, 315-319` |
| **Principle** | Principle 4 (Beck's economics — test what might break, once). Principle 11 (Specific Desideratum — the test should pinpoint which surface broke). |
**Finding:** The test at line 171 ("AC-3.2: refusal has no first-person, no apology, no hedge") runs the full pipeline against an ambiguous fixture and regex-negates `/\b(I|sorry|unfortunately|I'm)\b/` on the rendered body. The test at line 315 ("all three failure-class headlines avoid first-person + apology") iterates `Object.values(REFUSAL_HEADLINES)` and regex-negates `/\b(I|we|sorry|unfortunately)\b/i`. The two regexes are non-identical (`I'm` vs `we`, case-sensitive vs `/i`), and only the first test actually exercises `renderRefusal` — the second tests only the headline constants. The first one is the one that catches a future drift where the headline is clean but the body footer accidentally re-introduces "I'm sorry" via copy-edit on `OVERRIDE_FOOTER`.
**Consequence:** The second test (line 315) is closer to theatre than coverage — it tests three string literals at module load, which is what the type system already does. The first test does the real work. Removing the second one and pushing its regex into the first one (so the body and headlines share one denylist) keeps the same coverage with half the assertions and one source of truth for "forbidden words." Today, a future expert adding a new headline with `"I'm"` in it ships green-on-second-test (because the regex differs) and red-on-first-test only if the headline lands in a rendered fixture.
**Fix:** Merge the two regex denylists into one exported constant (`FORBIDDEN_TONE_WORDS`) and apply it in both tests; OR delete the second test and add `for (const h of Object.values(REFUSAL_HEADLINES)) expect(renderRefusal-of-fixture-containing-h).not.toMatch(denylist)`. Either way: one denylist, one source of truth, two assertions sharing it.

---

### 6. `OVERRIDE_VALUES` allow-list test is a re-statement of a TS literal type, not a behavioural test
| | |
|---|---|
| **File** | `web/scripts/detect-stack.test.ts:320-324` |
| **Principle** | Principle 6 (Trivial assertions on simple returns) + Principle 11 (Predictive Desideratum — test should predict a future breakage that the type system doesn't already prevent). |
**Finding:** `expect([...OVERRIDE_VALUES].sort()).toEqual(["aura", "python"])` asserts on the value of an exported `as const` tuple. The TS type system already enforces this at compile time — `OverrideValue` is `"aura" | "python"` by construction. Adding a third value to `OVERRIDE_VALUES` requires editing the const, which is exactly the change the test is supposed to canary, but the test will be edited in the same commit because TypeScript will refuse to compile other modules until the type literal is updated everywhere. The test comment claims this "guards against silent inflation" — but silent inflation is impossible: any added value triggers a TS error at every `OverrideValue` consumer.
**Consequence:** Low-cost (one assertion), low-yield. Not harmful, just non-predictive. The test would correctly fail if someone added `OVERRIDE_VALUES.push("hybrid")` at runtime — but `as const` makes the array readonly, so even that is a TS error.
**Fix:** Either delete this test (the type system covers it) or strengthen it into a behavioural test: write a fixture with `.council-stack-override` containing each non-allow-list value (`"hybrid"`, `"unknown"`, `"AURA"` for case) and assert `r.overrideMalformed === true`. That tests the actual allow-list enforcement at the `readOverride` boundary, which IS a runtime contract.

---

### 7. Fixture cleanup pattern is correct under serial Vitest defaults, but the global `workspaces` array is a parallelism trap
| | |
|---|---|
| **File** | `web/scripts/detect-stack.test.ts:29-49` |
| **Principle** | Principle 4 (concurrent scenarios) + cross-stack memory `feedback_parallel_test_fakes_keyed_by_input.md` — shared mutable state across `beforeEach/afterEach` keyed by side-effect, not by test identity. |
**Finding:** The `workspaces: string[]` array is module-scoped; `beforeEach` resets it via `workspaces.length = 0`, and `afterEach` walks it to `rmSync`. This is correct under Vitest's default sequential test execution within a file. The moment anyone enables `vitest --threads` or `describe.concurrent`, two tests in the same file mutating the same array concurrently will race — one test's `beforeEach` clear can drop another test's pending workspaces, leaving tmp dirs leaking on the CI runner and (rarely) a `rmSync` racing against another test's `mkdtempSync` if `mkdtemp` somehow re-used a freed name (unlikely with random suffixes but not impossible).
**Consequence:** The pattern works today and tomorrow, but it is the exact shape the Aura memory `feedback_parallel_test_fakes_keyed_by_input.md` warns about — shared mutable state keyed by call-order. The first PR that enables concurrent test execution to speed up CI will hit a 1-in-N flake that's very hard to diagnose because the symptom is "tmp dirs leaking" not "test failed."
**Fix:** Local-scope the array inside each `describe` block, OR replace the array+afterEach pattern with an in-test `using w = makeTempWorkspace()` disposable (Vitest 4 supports `using` via TC39 explicit-resource-management). The second variant is hermetic per-test and survives parallel execution by construction. Cost: ~5 LOC refactor; no behavioural change today.

---

### 8. Symlink test silently passes on filesystems that don't support symlinks — not a flake, but the assertion was never run
| | |
|---|---|
| **File** | `web/scripts/detect-stack.test.ts:197-218` |
| **Principle** | Principle 1 (the red step is the proof — a test that never failed proves nothing). |
**Finding:** The symlink test wraps `symlinkSync` in `try {} catch { return; }` — on Windows or filesystems without symlink support, the test returns early and reports green. There's no `console.warn`, no `it.skip`, no surfacing of "this assertion was not executed today." A developer running the suite on Windows would see the symlink test passing and reasonably believe the symlink defence is exercised; it isn't.
**Consequence:** The symlink defence (`detect-stack.ts:121-123`) is the load-bearing security predicate the Hunt expert is signing off on — but in CI environments that lack symlink support, the test that proves it lands green-without-assertion. Aura's CI runs on Linux today so this is theoretical, but `feedback_running_build_vs_disk_build.md` and `feedback_fs_watch_macos_dirname_quirk.md` both make the case that "works on Linux today" is not a sustainable guarantee.
**Fix:** Change `catch { return; }` to `catch (e) { return ctx.skip(); }` (Vitest provides `ctx.skip()` inside `it` callbacks) — that surfaces "symlink defence untested on this platform" in the test reporter instead of falsely greening. Alternatively, since CI is Linux-only and the test is load-bearing security, assert `symlinkSync` does NOT throw at the start and let it red-flag the platform: `expect(() => symlinkSync(...)).not.toThrow()`.

---

## Summary

P1 (2): #1 silent-CI-skip of the entire mirror canary, #2 AC-4.3/AC-5.1 zero test coverage.
P2 (4): #3 enum-tag-only assertions on 5 AC tests, #4 substring-not-snapshot refusal body, #7 parallelism-trap fixture pattern, #8 symlink-test silent-pass on non-symlink platforms.
P3 (2): #5 two-redundant tone guards, #6 OVERRIDE_VALUES allow-list re-asserts the type system.

The strongest tests in the suite are AC-1.4 (ambiguous), AC-3.3 (malformed JSON inspects the `checked` body), and the override-precedence tests (lines 261-310) — those exercise the actual `MarkerCheck` records, not the kind tag. Copy that discipline down to AC-1.1..1.3 and AC-2.1..2.2 and Finding 3 disappears. Address Finding 1 and Finding 2 in the same commit — they share the mirror-canary file.
