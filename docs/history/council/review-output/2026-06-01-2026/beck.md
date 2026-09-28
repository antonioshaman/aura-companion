# Beck — Test Quality Review

Scope: `web/scripts/detect-stack.test.ts` (17 new cases), source-under-test `web/scripts/detect-stack.ts`, sibling canary `web/scripts/detect-stack.skill-mirror.test.ts`.

Verdict summary: the new suite is well-isolated (real fs, mkdtempSync, deterministic cleanup), uses observable assertions on `.kind` and rendered substrings, has no `.skip`/`.only`/`expect(true).toBe(true)` cheating, and the mirror canary correctly iterates `Object.values(REFUSAL_HEADLINES)` so the new `override_conflict` headline is picked up automatically. Six findings below — three structural mutation-resistance gaps (P1/P2), three coverage/boundary holes (P2/P3). No P1 false-confidence blockers; the writer's discipline is sound but the suite has predictable LLM-co-authored shape (positives-heavy, weak around `(name, path)` dedupe and the 64-candidate cap).

---

FINDING:
- Title: SPECIFICITY-guard negatives ("`bot/` without aiogram → unknown", "`webapp/package.json` with `name=marketing-site` → unknown") would pass on the OLD root-only implementation — they don't actually exercise the depth-2 scan
- File: `web/scripts/detect-stack.test.ts:380-396`
- Principle: 1 (Red step is the proof — a test that never could fail proves nothing) + 11 (Predictive desideratum)
- Severity: P1
- What's wrong: The two SPECIFICITY tests assert `detectStack(w).kind === "unknown"`. Both fixtures put markers EXCLUSIVELY in subdirs and leave workspace root marker-free. On the **pre-commit** root-only detector, the answer would have been `unknown` for both (root had nothing to match). On the **post-commit** depth-2 detector, the answer is also `unknown` because the guards correctly reject the directory-name heuristic. The tests pass on BOTH implementations — they cannot distinguish "we widened scope but kept specificity" from "we never widened scope at all". The mutation the writer (per the assignment brief) wanted to kill — "subdir name `bot/` should imply Python" — would require an implementation that conflates `bot/` with the Python signal; but no implementation under realistic refactor would land that mutation because the source structure of `probeRequirementsAndBot` keys on `requirements.txt` content, not dir name. The MORE likely mutation — "loosen the package.json `name` check to any string OR any `dependencies` key" — IS caught by the marketing-site case, but only because that test also coincidentally exercises depth-1 (subdir is `webapp/`). Pair it with a root-level marketing-site case as a control to see if the depth dimension matters.
- Consequence: Two of the three "specificity-guard" tests provide false confidence. A future refactor that accidentally re-disables depth-1 enumeration (e.g. `enumerateCandidatePrefixes` returns only `[""]`) would not be caught by these — only by the POSITIVE depth-1 tests (`webapp/package.json → aura`, etc.), which IS what catches the regression, but the negative tests don't add new signal.
- Fix: Add one assertion that genuinely requires depth-2: `it("specificity AT depth-2: webapp/package.json with name='marketing-site' AND companion/server/ws-bridge.ts → aura because ws-bridge IS a literal aura marker, NOT because of webapp dir name")` — confirms ws-bridge at depth-1 still wins while the marketing-site sibling stays correctly ignored. Or: explicitly add a "negative depth-2 control" comment + a positive twin pair: `bot/ alone → unknown` AND `bot/requirements.txt with ^aiogram → python` side-by-side (the second already exists at L362; just cross-reference them and assert both in one `it.each`-driven describe so the contrast is the test). Lowest-cost: add a comment `// Note: this test ALSO passes on root-only detector; pair with positive depth-1 case above for full coverage of the depth dimension.` so the next reviewer doesn't mistake it for proof of the widened scan.

---

FINDING:
- Title: AC-3.2 line-cap (≤18 lines) test silently excludes the new `override_conflict` refusal branch
- File: `web/scripts/detect-stack.test.ts:163-170`
- Principle: 5 (Tests as behavioural variants — boundary case missing) + 6 (Mutation resistance)
- Severity: P2
- What's wrong: The existing AC-3.2 test (`refusal stays scanable`) mints an EMPTY workspace, which hits the `unknown` branch — the SHORTEST refusal body. The new `override_conflict` branch adds 3 extra header lines (asserts + detected + blank) + replaces the 3-line `OVERRIDE_FOOTER` with a 2-line "To resolve" footer. Counting against the renderer at `detect-stack.ts:684-725` for a `override_conflict` result with 5 unique marker names + 1 present file: headline(1) + blank(1) + asserts(1) + detected(1) + blank(1) + "Checked for:"(1) + 6 deduped markers(6) + blank(1) + "Found at workspace root:"(1) + ~1 present line + blank(1) + "To resolve:"(1) + footer(1) ≈ 17 lines. Tight but compliant. HOWEVER: no test asserts this. A future addition (e.g. a third "alternative override" line in the To-resolve footer, or a second "Auto-detected" annotation) silently breaches 18 with no signal. The AC-3.2 line-cap was the writer's primary user-facing performance contract — and the new branch the writer just added is the one NOT covered by it.
- Consequence: The renderer can grow the conflict branch unboundedly without triggering AC-3.2 — exactly the regression the existing test was supposed to guard against. The "10-second read budget" claim in the comment becomes aspirational for the most complex branch.
- Fix: Add a third AC-3.2 case explicitly for `override_conflict`: mint a workspace with `.council-stack-override = aura\n` + `pyproject.toml` containing aiogram, then `expect(renderRefusal(detectStack(w)).split("\n").length).toBeLessThanOrEqual(18)`. While there, parametrise the existing test over `[unknown_empty, ambiguous_full, override_malformed_full, override_conflict_full]` via `describe.each` so all four refusal branches share the contract — that's the structural form of "test what might break".

---

FINDING:
- Title: `renderRefusal(override_conflict)` test asserts substring inclusion only — would pass on a renderer that ALSO leaks override file contents or extraneous markers
- File: `web/scripts/detect-stack.test.ts:485-497`
- Principle: 6 (Assertions ARE the test — trivial assertions on complex returns) + Hunt's adjacent concern about content leakage
- Severity: P2
- What's wrong: The test asserts 5 substrings are present + the first-person regex is absent. There's no negative-shape assertion on the conflict body. Specifically: the rendered output is sourced from `result.overrideConflictAsserted` / `result.overrideConflictAutoDetected` (both bounded to the OVERRIDE_VALUES allow-list `{"aura","python"}`), but the renderer takes `result.overridePath` and various `MarkerCheck` fields elsewhere; if a future refactor inlined `read.text` (the raw `.council-stack-override` content) into the body — say to make the error more helpful by showing what was typed — the substring test would still pass. The existing `refusal never echoes raw file content` test (L244-255) tests this for `web/package.json` content via a `SUPER_SECRET_PASTED_TOKEN` canary, but NOT for `override_conflict` against `.council-stack-override` content. Asymmetric coverage of the same security principle.
- Consequence: Silent content-leak regression on the override_conflict branch is structurally undetectable by the test suite. The principle (refusal text is bounded to the closed allow-list + marker names) is enforced for the existing branches but quietly skipped on the new one.
- Fix: Add to the override_conflict render test: write `.council-stack-override` content as `aura\nSECRET_LEAK_CANARY_42\n` (the validator only consumes `.trim()` of the first valid token, so the extra line is ignored at parse but COULD leak through a future "show what was in the file" refactor), then `expect(text).not.toContain("SECRET_LEAK_CANARY_42")`. Cheap canary, symmetric with the existing one. Optional bonus: assert line count `≤ 18` here (folds into the previous finding).

---

FINDING:
- Title: `(name, path)` post-collection dedupe is internal logic with NO direct test — mutation that removes dedupe is undetectable
- File: `web/scripts/detect-stack.test.ts` (whole file) vs. source `detect-stack.ts:544-551`
- Principle: 6 (Mutation resistance — if `return null` would still pass, assertion is too weak) + 2 (Structure-insensitive but behavioural)
- Severity: P2
- What's wrong: When workspace has a top-level `web/` directory (real Aura case), `enumerateCandidatePrefixes` returns `["", "web"]`. `probePackageJson(root, "")` resolves `web/package.json`; `probePackageJson(root, "web")` ALSO resolves `web/package.json` (because the prefix-vs-root path math collides). The dedupe at L544-551 collapses these so the refusal renderer's `present` filter and the test at L185 (`r.checked.filter(c => c.path === "web/package.json")`) see one entry per real disk file. If a refactor removed the dedupe block, the AC-3.3 malformed test (L179-191) still passes because it asserts `pkgChecks.length > 0` — a count of 4 (2 markers × 2 prefixes) is `> 0`. The renderer test for the refusal "Found at workspace root" list uses `printed.add(c.path)` internally so wouldn't show duplicate file lines either. Net: the dedupe is load-bearing for correctness of the `present.length === 0` check and for the line-count budget (each dup adds 2 lines per `web/package.json` marker), but no test would fail if it were removed.
- Consequence: Silent regression risk. A "simplification" PR that removes the post-collection dedupe in favour of upfront skip in `enumerateCandidatePrefixes` (e.g. excluding `web` from the depth-1 list because root already covers it) is plausible refactor territory; the upfront-skip version would change `r.checked.length` for the aura monorepo case but no test asserts that count.
- Fix: One targeted test: mint a workspace with literal `web/package.json` (the canonical Aura layout, hitting BOTH prefix="" and prefix="web" code paths), assert `detectStack(w).checked.filter(c => c.path === "web/package.json" && c.name === MARKER_NAMES.AURA_PACKAGE_NAME).length === 1`. That locks the invariant "one disk file → one MarkerCheck per marker name" against both dedupe removal AND "double-count if web is also a depth-1 candidate" bugs.

---

FINDING:
- Title: SKIP_SUBDIRS sampling tests only 2-of-22 closed-list entries (node_modules + dist); the hidden-dir test exercises a SEPARATE rule
- File: `web/scripts/detect-stack.test.ts:413-439`
- Principle: 5 (Tests as behavioural variants) + 4 (Test what might break — economics)
- Severity: P3
- What's wrong: The skill brief flags 3 SKIP_SUBDIRS tests covering `node_modules`, `dist`, and `.local`. Reading the source: `.local` matches via `name.startsWith(".")` (L243), NOT via `SKIP_SUBDIRS.has(name)` (L244). So only 2 of the 22 named entries in SKIP_SUBDIRS are actually exercised. A mutation that removes `"venv"`, `"build"`, `"target"`, `".next"`, `".turbo"`, `".cache"`, `"__pycache__"`, etc. from the set would not be caught. Equally, a mutation that REORDERS the check so `name.startsWith(".")` runs AFTER `SKIP_SUBDIRS.has(name)` would change `.local` behaviour from "skipped by prefix" to "skipped by set membership" — but `.local` isn't in the set, so it would suddenly leak through. The test would still pass because `.local` is checked via `startsWith`. Mid-confidence: sampling 2-of-22 is acceptable engineering, BUT the test labels them as "SKIP_SUBDIRS: …" which implies set-membership coverage; a reader assumes broader coverage than there is.
- Consequence: Documentation-vs-coverage drift. A reviewer skimming test names assumes "SKIP_SUBDIRS is tested" when only 2 entries are. A subsequent edit to SKIP_SUBDIRS (add/remove) gets no signal.
- Fix: One `it.each(Array.from(SKIP_SUBDIRS))` test parametrised over the entire set — mint workspace with `<dir>/package.json` containing aura marker, assert `unknown`. 22 test cases for zero maintenance cost (loops over the exported set). Separately, rename the `.local` test to "hidden-dir scan rule (name.startsWith('.'))" to disambiguate from set-membership tests — the rule is structurally different.

---

FINDING:
- Title: `MAX_CANDIDATE_SUBDIRS=64` silent cap has no test — boundary behaviour is unverified
- File: `web/scripts/detect-stack.test.ts` (whole file) vs. source `detect-stack.ts:101, 241`
- Principle: 5 (Tests as behavioural variants — boundary cases) + 4 (Test what might break)
- Severity: P3
- What's wrong: The implementation caps depth-1 enumeration at 64 subdirs (`if (scanned >= MAX_CANDIDATE_SUBDIRS) break`). No test exercises this boundary. The behaviour at the boundary is non-trivial: the BREAK is unsorted (uses `readdirSync` iteration order, which is filesystem-dependent), so on a workspace with 65 directories where the 65th alphabetically is the only one containing aura markers, detection silently returns `unknown` instead of `aura` — with no indication in the refusal that the cap fired. This is exactly the kind of "fails closed silently" boundary that AC-3.3 was designed to forbid. Beck framing: a test would force a decision — either "we accept silent miss at >64" (then the test asserts `unknown` and documents the contract) or "we surface the cap" (then the test asserts the refusal mentions it). Currently neither is enforced.
- Consequence: A real monorepo with 65+ depth-1 directories silently misdetects. The contract is ambiguous because no test pins it down.
- Fix: Add one boundary test: mint 65 dirs (`for (let i = 0; i < 65; i++) mkdirSync(...)`), place the aura marker (`web/package.json`) in the 65th by name, observe the actual behaviour, and either (a) `expect(r.kind).toBe("unknown")` to lock the "silent miss is by-design" contract, or (b) drive an implementation change to surface the cap in `checked` or refusal text. The decision is the value, not the assertion itself. Bonus: extract `MAX_CANDIDATE_SUBDIRS` as an export so the test can reference it instead of hard-coding 64.

---

## Items verified clean (no findings)

- **`.skip` / `.only` / `expect(true).toBe(true)` scan**: clean. No AI-cheating signals in the 17 new tests.
- **Mock discipline**: zero mocks. All tests use real fs via `mkdtempSync` with `afterEach rmSync` cleanup — exemplary per Principle 3 ("mock almost nothing"). The symlink test (L197-218) correctly handles the unsupported-fs case with early-return rather than `.skip`, which preserves the test count signal.
- **Mirror canary structure**: `detect-stack.skill-mirror.test.ts:72` iterates `Object.values(REFUSAL_HEADLINES)`, so the new `override_conflict` headline is automatically asserted against each SKILL.md body. Iteration over `Object.values(MARKER_NAMES)` (L62) and `OVERRIDE_VALUES` (L82) is symmetric. No hardcoded count of 3 headlines — adding a 5th would be caught. Mirror discipline is structurally correct.
- **Implementation-detail leak**: no test asserts on `enumerateCandidatePrefixes` or any internal helper directly. All assertions go through `detectStack(w).kind` or `renderRefusal(r)` substrings — Principle 2 (structure-insensitive) clean. The two tests that touch `r.checked` (AC-3.3 malformed at L185, override-doesn't-silence-enumeration at L298) are observable contract assertions (the `checked` field is part of the public `DetectionResult` shape).
- **Happy-path coverage**: positive `aura` and `python` cases at depth-1 are present (L335, L344, L353, L362, L371). Not LLM-skewed toward error paths.
- **Override-conflict discriminant coverage**: 5/5 cases per the brief are present and assert BOTH `r.kind === "override_conflict"` AND the sub-fields `overrideConflictAsserted` / `overrideConflictAutoDetected`. Strong behavioural assertions on the new discriminated-union variant.
- **First-person/apology negative regex**: applied to the new override_conflict render test (L496). Symmetric with existing `AC-3.2` test (L177). UX discipline preserved.

---

Total: 6 findings (1 × P1, 3 × P2, 2 × P3). Three blocks of verified-clean coverage listed above to document what the suite handles well so the rebuttal can focus on the gaps.
