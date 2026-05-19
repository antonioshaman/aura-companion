# Council Review: Auto-stack-detection router

**Scope:** `web/scripts/detect-stack.ts` (553 lines) + `web/scripts/detect-stack.test.ts` (24 tests) + `web/scripts/detect-stack.skill-mirror.test.ts` (15 tests) + Phase 0 sections in `~/.claude/skills/council-{plan,implement,review}/SKILL.md`.
**Context:** Adds Phase 0 stack-detection routing to the three suffixless council slash commands so they dispatch the matching variant (Aura/Bun vs Python/aiogram) without manual suffix. The detector is the AC binder; the SKILL.md edits are the runtime surface. The `-aura` skills stay first-class as explicit overrides.
**Council dispatched:** Security expert, Refactoring expert, FS/Persistence expert (§B only — no subprocess surface), Test-quality expert, UX expert. Skipped (no scope): Backend expert, Frontend expert, UI expert, a11y expert, LLM expert, DevOps expert.

**Phase 0 gates:** Typecheck PASS. Tests PASS (245 files, 6346 tests, 4 skipped, 0 failures). No axe regressions (no DOM surface added).

---

## P1 — Fix Now

### 1. Refusal footer advertises `/council-plan-python` (and siblings) — commands that do not exist

| | |
|---|---|
| **File** | `web/scripts/detect-stack.ts:493-497` + mirrored in all 3 SKILL.md Phase 0 footers |
| **Council** | UX expert × Refactoring expert × Security expert convergence — Principle: trust compounds slowly, breaks fast; Divergent Change in hard-coded constants; secure defaults guide to safer action |
| **Ref** | `references/quality-ux.md` Principle 9 / `references/refactoring.md` §C |

**Finding:** The `OVERRIDE_FOOTER` constant tells users to run `/council-plan-aura` OR `/council-plan-python` when detection fails. Only the Aura side has a suffixed sibling skill — the Python body lives INSIDE the suffixless skill itself (per the dispatch rules in the same SKILL.md). A user typing `/council-plan-python` hits "skill not found" and is stranded after the refusal told them to.

**Consequence:** The user's primary recovery path on detection failure is a dead end. AC-3.2's 10-second readability holds only insofar as the override line is fast to read — but it points at nothing. The refusal becomes a trust-eroding event the moment a user actually tries the suggestion.

**Fix:** Replace the python-suffix line with a directive that actually works: `Or create '.council-stack-override' with 'aura' or 'python' on a single line.` Apply the same fix in all three SKILL.md Phase 0 mirror copies. The structural follow-up (Fowler) is to stop hard-coding skill-family-specific text in `renderRefusal` at all — either accept an `invocationFamily` arg, or hoist the footer out of the renderer and let each consumer prepend its own.

---

### 2. Mirror drift canary silently skips in any CI environment without `~/.claude/skills/`

| | |
|---|---|
| **File** | `web/scripts/detect-stack.skill-mirror.test.ts:45-101` |
| **Council** | Test-quality expert — Principle 1 (red step is the proof) + Principle 10 (.skip accumulation = debt) |
| **Ref** | `references/quality-testing.md` |

**Finding:** `describe.skipIf(!skillsRootExists)` collapses ALL 15 mirror assertions to green-skipped when the skills directory is absent. No CI workflow file or vitest config sets `$COUNCIL_SKILLS_ROOT`, so on every clean CI runner the canary reports 15 passing tests and asserts nothing. The "single source of truth + mechanical drift canary" architecture is enforced only on the original author's laptop.

**Consequence:** A PR that edits `MARKER_NAMES` in `detect-stack.ts` and forgets to update one SKILL.md mirror lands green on CI; the breakage surfaces the first time a real user invokes `/council-plan` after pulling main. The load-bearing canary is structurally void in production.

**Fix:** Replace silent-skipIf with an either-or: require `$COUNCIL_SKILLS_ROOT` in CI (default to a checked-in `web/scripts/__fixtures__/skill-mirror/` carrying frozen copies of the three Phase 0 bodies), and fail loudly when neither resolves. The fixture-dir variant lets the test run hermetically; the env-var variant gates on the real artefact. Both share one body.

---

### 3. AC-4.3 (`-aura` skills back-compat) and AC-5.1 (variant output paths) have zero test coverage

| | |
|---|---|
| **File** | `web/scripts/detect-stack.test.ts` (entire file) + `web/scripts/detect-stack.skill-mirror.test.ts:88-99` |
| **Council** | Test-quality expert — Principle 4 (test what might break — high-risk path untested); AC with zero verifier = vacuous AC |
| **Ref** | `references/quality-testing.md` |

**Finding:** AC-4.3 says explicit `-aura` invocations preserve their pre-router behaviour. The only test is a negative assertion that `-aura` SKILL.md files do NOT contain a Phase 0 heading — that proves they aren't accidentally polluted, but does not prove they still dispatch to the same council compositions, expert reference docs, or output paths. AC-5.1 ("variant dispatch produces the same output paths — no router-introduced wrapper dirs") has no test at all.

**Consequence:** A SKILL.md edit that quietly changes `.council/abtest/` to `.council/router/abtest/` ships green. AC-5.1 is a hard contract per the spec; the implementation has no canary against it.

**Fix:** Two new assertions in the mirror canary: (a) each `-aura` SKILL.md still contains its canonical output-path directive (substring lock on `.council/...` references); (b) the suffixless SKILL.md Phase 0 blocks must not introduce any new output-path token (regex-negate `\.council/(router|abtest)/wrapper`). Six lines total, lands inside the existing `describe.each` block.

---

### 4. `override_malformed` refusal never tells the user the allow-list — the actionable rule is missing

| | |
|---|---|
| **File** | `web/scripts/detect-stack.ts:516-553` (`renderRefusal`) + SKILL.md mirrors |
| **Council** | UX expert × Security expert convergence — Principle 2 (error states need recovery action); secure defaults guide to fix |
| **Ref** | `references/quality-ux.md` Principle 2 / `references/security.md` §A |

**Finding:** When `.council-stack-override` is malformed, the refusal headline reads `Stack detection: .council-stack-override is malformed.` and the body lists `.council-stack-override (malformed)`. The closed allow-list (`aura` or `python`, single-line, lowercase, no quotes) appears nowhere in the rendered output — only in the SKILL.md prose at line 42, which is documentation the user does not see. A user who wrote `Aura`, `both`, or `python\n  trailing space` has no in-message hint about the rule.

**Consequence:** AC-3.2 (10-second to determine cause) fails for this failure class. The user knows their file is wrong but cannot fix it without reading the source or guessing.

**Fix:** In the `override_malformed` branch of `renderRefusal`, append one line under the "Found" section: `Expected exact lowercase: 'aura' or 'python', single line, no quotes.` Treat the malformed-override path as a distinct body, not just a distinct headline. Update SKILL.md mirrors to cite the same line.

---

## P2 — Fix Soon

### 5. JSON parse coercion treats non-object roots as `parsed: true, matched: []` — silent semantic mismatch with AC-3.3

| | |
|---|---|
| **File** | `web/scripts/detect-stack.ts:213-226` |
| **Council** | Security expert × FS/Persistence expert convergence — fail-closed on malformed; schema-validate parsed payloads |
| **Ref** | `references/security.md` §A / `references/quality-ritchie.md` §B Principle 7 |

**Finding:** After `JSON.parse(text)`, the code coerces `pkg` to `{}` if `typeof pkg === "object"`. This accepts arrays (`typeof [] === "object"`) and `null` — both fall through as "parsed but no markers matched" instead of "json structurally wrong." A `package.json` containing `null`, `[]`, or `["aura-companion"]` produces no parse-error reason in the refusal even though the content is semantically unusable. AC-3.3 forbids silent downgrade of malformed to absent.

**Fix:** After `JSON.parse`, reject `Array.isArray(pkg)` and `pkg === null` — record `reason: "json_parse"` to keep the refusal enumeration accurate. One extra conditional, no behaviour change for well-formed inputs.

---

### 6. Five AC-1.x / AC-2.x detection tests assert only `r.kind` — would pass if Aura markers were wired to the Python kind

| | |
|---|---|
| **File** | `web/scripts/detect-stack.test.ts:85-99, 117-126` |
| **Council** | Test-quality expert — Principle 6 (assertions ARE the test); Aura memory `feedback_verify_test_bodies_not_just_names.md` |
| **Ref** | `references/quality-testing.md` |

**Finding:** AC-1.1, AC-1.2, AC-1.3, AC-2.1, AC-2.2 each end with `expect(detectStack(w).kind).toBe("aura")` (or `"python"`) and no further assertion. The tests do not verify which marker matched, which body produced the verdict, or that the other stack's markers reported empty. If `probePackageJson` were swapped with `probePyproject` mid-refactor, the kind tag would still flip correctly per fixture and all five tests stay green.

**Fix:** Each of the five tests gains one line asserting the actual matched marker in `result.checked.find(c => c.name === MARKER_NAMES.X)?.matched`. The AC-1.4 ambiguity test (line 100-111) already does this — copy the discipline down.

---

### 7. Intermediate directory symlinks are not rejected, only out-of-root ones

| | |
|---|---|
| **File** | `web/scripts/detect-stack.ts:104-134` |
| **Council** | FS/Persistence expert — Principle 1 (resolving-wrapper EC-7 must catch ALL symlink traversal paths) |
| **Ref** | `references/quality-ritchie.md` §B Principle 1 |

**Finding:** `resolveMarker` uses `lstatSync` on the final candidate, which only inspects the leaf component — intermediate directory symlinks (e.g. `web/` itself replaced by a symlink to a sibling directory) are followed silently. The realpath bounds-check catches escapes outside the workspace, but a `web/`-as-symlink-to-in-root-sibling passes both gates while still being a symlink the spec intends to reject.

**Fix:** Walk each intermediate path component with `lstatSync` and reject if any component is a symlink, OR explicitly document that the rejection applies to the leaf only and update the test suite to lock the chosen contract.

---

### 8. Refusal-body assertions are substring `toContain`, not snapshot — structural reorder lands green

| | |
|---|---|
| **File** | `web/scripts/detect-stack.test.ts:145-162, 244-255` |
| **Council** | Test-quality expert × Refactoring expert convergence — Principle 6 (mutation resistance); Shotgun Surgery |
| **Ref** | `references/quality-testing.md` / `references/refactoring.md` §C |

**Finding:** AC-3.1 tests assert `text.toContain(...)` for marker names, headlines, and footer commands. No assertion locks structural ordering or indentation. A copy-edit reordering "Checked for:" and "Found at workspace root:" sections, or stripping the two-space bullet indent, passes every existing assertion. The mirror test (Refactoring expert Finding 1) covers leaf strings but not the structural skeleton the SKILL.md mirrors quote verbatim.

**Fix:** Add one `toMatchInlineSnapshot` assertion against a hand-frozen expected body for the ambiguous-class fixture. The single snapshot becomes the structural lock; `toContain` becomes redundant safety net.

---

### 9. Three distinct failure-class headlines — but the body is identical for all three

| | |
|---|---|
| **File** | `web/scripts/detect-stack.ts:516-553` (`renderRefusal`) |
| **Council** | UX expert — Principle 6 (lists drive action); Principle 8 (structure over conversation) |
| **Ref** | `references/quality-ux.md` |

**Finding:** `REFUSAL_HEADLINES` has three keys (`unknown`, `ambiguous`, `override_malformed`) but `renderRefusal` produces an identical body for all three: same "Checked for" enumeration, same footer, only the "Found" section varies. The user re-reads the headline to determine which class they're in. The ambiguous case wants a different action (pick one stack via override) than the unknown case (likely wrong cwd or broken file tree).

**Fix:** Branch one summary line per class under each headline: `unknown → "Run from a recognised workspace, or set .council-stack-override."`; `ambiguous → "Two stacks share this directory — pin one with .council-stack-override."`; `override_malformed → see Finding 4.` One extra line per class; stays within the line budget.

---

### 10. `MarkerReason` enum values leak into user-facing refusal as raw jargon

| | |
|---|---|
| **File** | `web/scripts/detect-stack.ts:534-549` (`renderRefusal`, `Found` branch) |
| **Council** | UX expert — Principle 1 (structure complexity, don't simplify away user value) |
| **Ref** | `references/quality-ux.md` |

**Finding:** The "Found at workspace root" line renders `c.reason` directly: `  - web/package.json (json_parse)`, `  - pyproject.toml (size_exceeded)`. These are internal enum tags from the `MarkerReason` union, not user-facing copy. A user reading `(json_parse)` cannot tell whether their file has a syntax error, a stray BOM, or is empty.

**Fix:** Map `MarkerReason` to user-facing phrases: `json_parse → "could not parse as JSON"`, `size_exceeded → "exceeds 16 KB cap"`, `symlink → "is a symlink (rejected)"`, `out_of_bounds → "resolves outside workspace"`, `read_error → "could not be read"`. No content leak — these are file-state descriptors, not file contents.

---

## P3 — Consider

### 11. `MarkerCheck.present` + `parsed` + `reason?` triple encodes a four-state intent

| | |
|---|---|
| **File** | `web/scripts/detect-stack.ts:69-83 + every probe site` |
| **Council** | Refactoring expert — Primitive Obsession |

The two-boolean-plus-optional-reason shape encodes `absent` / `present-and-parsed` / `present-but-unparseable` / `unresolvable` (symlink, out-of-bounds, lstat-failed). Probes set `present: true` even when the file may not exist on disk (the resolve failed with `out_of_bounds` for a not-yet-existent path). Replace with a discriminated `status: "absent" | "ok" | "unparseable" | "unresolvable"` and a single switch in the renderer.

### 12. Plan ceiling 15 lines vs SKILL.md prose "≤18" vs test bound 18 — three numbers, no canary

| | |
|---|---|
| **File** | plan §5 + SKILL.md mirrors line 59 + `detect-stack.test.ts:167-168` |
| **Council** | UX expert — consistency across mirror copies |

Worst-case unknown refusal is 16 lines today — over the plan ceiling, under the test bound. Codify one number as a `MAX_REFUSAL_LINES` constant in `detect-stack.ts` and have both the test and the SKILL.md prose cite it.

### 13. Symlink test silently passes on filesystems without symlink support

| | |
|---|---|
| **File** | `web/scripts/detect-stack.test.ts:197-218` |
| **Council** | Test-quality expert — Principle 1 (red step is the proof) |

`try { symlinkSync(...) } catch { return; }` reports green when symlinks are unsupported. Replace `return` with `ctx.skip()` so the platform skip surfaces in the reporter — load-bearing security predicate must be visibly exercised or visibly skipped, never silently absent.

### 14. TOCTOU window between realpath bounds-check and read

| | |
|---|---|
| **File** | `web/scripts/detect-stack.ts:126-133, 159` |
| **Council** | Security expert — defence in depth |

`resolveMarker` validates `realpathSync(candidate)` is within bounds, then returns `candidate` (pre-resolution); the subsequent `readFileSync(absolute, "utf8")` reads `candidate` again. Belt-and-suspenders fix: read from `real` (the resolved canonical path). Practically zero risk in the deployed threat model (single-user developer workspace) but cheap to add and durable against future callers.

### 15. Test fixture pattern uses module-scoped array — parallelism trap

| | |
|---|---|
| **File** | `web/scripts/detect-stack.test.ts:29-49` |
| **Council** | Test-quality expert — parallel-test-fakes anti-pattern |

`workspaces: string[]` module-scoped + `beforeEach` clear + `afterEach` rmSync is correct under serial Vitest; the moment anyone enables `vitest --threads` or `describe.concurrent`, two tests in the same file mutating the array race. Replace with TC39 `using` disposable or local-scope the array per `describe`. Aura memory `feedback_parallel_test_fakes_keyed_by_input.md`.

---

## Summary

| # | Finding | Severity | Council | Fix effort |
|---|---------|----------|---------|------------|
| 1 | Footer suggests non-existent `/council-plan-python` | P1 | UX × Refactoring × Security | ~6 lines, 3 mirrors |
| 2 | Mirror canary silently skips in CI | P1 | Test-quality | ~15 lines + fixture dir |
| 3 | AC-4.3 + AC-5.1 zero coverage | P1 | Test-quality | ~6 lines |
| 4 | `override_malformed` omits allow-list | P1 | UX × Security | ~3 lines |
| 5 | JSON parse coerces non-object roots silently | P2 | Security × FS | ~2 lines |
| 6 | Detection tests assert only `r.kind` | P2 | Test-quality | ~5 lines |
| 7 | Intermediate-dir symlinks not rejected | P2 | FS/Persistence | ~10 lines |
| 8 | Refusal body substring vs snapshot | P2 | Test-quality × Refactoring | ~5 lines |
| 9 | Identical body for 3 distinct headlines | P2 | UX | ~3 lines |
| 10 | `MarkerReason` jargon leaks to refusal | P2 | UX | ~10 lines |
| 11 | MarkerCheck tri-state encoding | P3 | Refactoring | ~20 lines |
| 12 | 15-vs-18 line-ceiling drift | P3 | UX | ~2 lines + 3 mirrors |
| 13 | Symlink test silent-pass on no-symlink FS | P3 | Test-quality | ~1 line |
| 14 | TOCTOU realpath vs read | P3 | Security | ~1 line |
| 15 | Module-scoped fixture array vs parallel tests | P3 | Test-quality | ~5 lines |

**Totals:** 4 P1, 6 P2, 5 P3 = 15 findings.

## Verdict

The detector core is **well-designed for its scope**: EC-7 resolving wrapper is the right shape, marker probes are partitioned correctly, the override allow-list is closed, security expert found no exploit path. The single-source-of-truth pattern (TS constants + SKILL.md mirrors + drift canary) is the right architectural call — Refactoring expert explicitly confirms not extracting Phase 0 to a runtime-loaded markdown is economically correct at three callers.

The **four P1s cluster on two surfaces** and both surfaces are about the contract between the implementation and the user / CI:
- The refusal text contract (Findings 1, 4) — the strings users will actually read are wrong in one place (`/council-plan-python` doesn't exist) and missing actionable detail in another (`override_malformed` allow-list).
- The verification contract (Findings 2, 3) — the drift canary and AC-4.3/AC-5.1 coverage gaps mean the architecture's safety claims are not exercised in CI.

**Start with Finding 1** (3 lines × 3 mirror copies — instant user-impact fix). Then Finding 2 (the canary that was supposed to prevent Finding 1 from being a problem at all) and Finding 4 in the same commit cluster. Findings 5–10 (P2) bundle cleanly into a second commit; the P3s defer.

The single most critical expert for this surface is the **Test-quality expert** — three of the four P1s are test-gating gaps, and the verification contract is what turns a small clean module into a load-bearing safety boundary.

---

## P1 Self-Block Gate

Four P1 findings are self-introduced by this implementation cycle (not pre-existing). Per the gate protocol, the operator's three options are:
- **(a) fix now** — loop back to implement with the P1 list as input.
- **(b) accept** — append acceptance rationale to this review verbatim.
- **(c) defer** — file follow-up tasks.

This review run is the A/B test artefact for blind comparison — the operator-facing summary table above presents the four P1s for downstream triage. The gate is surfaced, not bypassed. Recommended path for the next implementation cycle: fix 1, 2, 3, 4 in that order — total impact is ~30 lines including the new fixture directory for Finding 2.
