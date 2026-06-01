# Council Review (Aura): `detect-stack.ts` + depth=2 monorepo scan

**Scope:** Commit `99336b5` on `feat/council-spawn-ack` — 4 files: `web/scripts/detect-stack.ts`, `web/scripts/detect-stack.test.ts`, `specs/council-stack-autodetect-monorepo.md`, `.agents/knowledge/codebase-facts.jsonl`. NOT in scope (outside repo): 3 SKILL.md mirror updates at `~/.claude/skills/{council-plan,council-implement,council-review}` — sync enforced by `detect-stack.skill-mirror.test.ts` canary.

**Context:** Phase 0 stack-detection for council router skills was workspace-root-only — friction in monorepos forced `.council-stack-override` on every invocation. This commit widens scan to workspace root + depth-1 subdirs (with 24-entry SKIP_SUBDIRS list + 64-candidate cap + EC-7 symlink guard) and renders the previously-defined-but-unrendered `override_conflict` discriminant. Marker semantics unchanged (literal-only match contracts preserved).

**Council dispatched:** Hunt (Security), Fowler (Refactoring), FS-JSON Persistence, Beck (Test Quality). Skipped (no in-scope files): Backend-TS, Realtime/NDJSON, Subprocess, React/UI, a11y, Saarinen, Friedman, Willison, Deploy.

**Automated checks:** ✓ typecheck, ✓ 56/56 detect-stack tests, ✓ 6521/6521 full suite. A11y N/A (no .tsx changes). Pre-commit hook passed.

---

## P1 — Fix Now

(no P1 findings — `detect-stack.ts` is shipping-quality; everything below is forward-looking maintenance debt)

---

## P2 — Fix Soon

### 1. EC-7 boundary regression: `enumerateCandidatePrefixes` re-implements filesystem-access discipline inline instead of using `resolveMarker`

| | |
|---|---|
| **File** | `web/scripts/detect-stack.ts:231-259` |
| **Council** | Hunt × Carmack — Principle 2 (Automate defences) + project convention EC-7. **Cross-ref:** Persistence flagged the same (his Finding 4 — "second EC-7 site with weaker discipline + misleading inline comment"). |
| **Ref** | `references/security.md` → Principle 2; `references/quality-persistence.md` → Principle 6 |

**Finding:** The file's stated convention (`detect-stack.ts:12-14` header) says "every marker access goes through `resolveMarker`". The new helper does its own inline `lstatSync` + symlink reject but never calls `realpathSync` to bounds-check the resolved path against `rootResolved`. The comment at line 246 says "Defensive realpath bounds check — never traverse outside workspace" — the code does no realpath call. The comment lies about what the code does.

**Consequence:** Not exploitable today — downstream per-file `resolveMarker` calls rescue the actual access. But EC-7 invariant is violated at the new access site: a future change to `resolveMarker` (deny-list addition, case-fold check, length cap) silently won't apply to enumeration. Drift hazard — the file-header invariant becomes load-bearing-but-untrue, which is the worst kind of documentation.

**Fix:** Either (a) route the directory check through `resolveMarker(rootResolved, name)` and reuse its result, or (b) extract a shared `lstatNonSymlinkInsideRoot(rootResolved, name)` helper that both `resolveMarker` and `enumerateCandidatePrefixes` call. At minimum, correct the misleading comment so the next maintainer knows the lstat is the only gate.

---

### 2. `MAX_CANDIDATE_SUBDIRS=64` silent cap: no log, no `DetectionResult` flag, no MarkerCheck, no test

| | |
|---|---|
| **File** | `web/scripts/detect-stack.ts:101, 239-244` (impl); `web/scripts/detect-stack.test.ts` (test gap) |
| **Council** | Persistence × Carmack — Principle 5 (bound resource consumption WITHOUT losing meaning). **Cross-ref:** Hunt flagged observability (his Finding 3); Beck flagged untested boundary (his Finding 6) — 3-way convergence on the same silent-failure pathway. |
| **Ref** | `references/quality-persistence.md` → Principle 5/10; `references/quality-testing.md` → Principle 4/5 |

**Finding:** When the workspace root has >64 non-skip, non-hidden directories, the loop silently stops at entry 64. No log line, no field in `DetectionResult` (e.g. `scanTruncated: true`), no synthetic MarkerCheck, no test exercising the boundary. The 65th directory in `readdirSync` order (filesystem-defined, not guaranteed alphabetical) could be `apps/` containing the only matching marker — `detectStack` returns `unknown` with zero indication that the scan was budget-capped, not exhaustive.

**Consequence:** Real-world lerna/nx/turborepo monorepos easily exceed 64 depth-1 entries. User sees "unknown stack — add override" when the actual fix is "increase cap" or "move marker closer to root". Refusal text is mismatched to root cause. The test gap means a future contributor cannot tell whether silent-miss-at-65 is intentional contract or accidental cliff.

**Fix:** Add `scanTruncated: boolean` to `DetectionResult` set when the cap is hit; surface in `renderRefusal` as a one-line note ("Scan capped at 64 subdirs — increase or move marker closer to root"). Add a boundary test that mints 65 dirs, places the marker in the 65th, and asserts the chosen contract (silent-miss documented, OR surface-the-cap implemented). Export `MAX_CANDIDATE_SUBDIRS` so the test references it. The cap as a defensive budget is fine — silent truncation of a defensive budget is not.

---

### 3. `prefix === ""` sentinel is hidden polymorphism scattered across 4 probes; post-collection dedupe is fix-up for a model collision

| | |
|---|---|
| **File** | `web/scripts/detect-stack.ts:268-446` (probes), `544-551` (dedupe) |
| **Council** | Fowler × Carmack — Principle 5 (Primitive Obsession) + Principle 2 (wasted work). **Cross-ref:** Beck flagged dedupe-untested (his Finding 4) — structurally undetectable mutation risk. |
| **Ref** | `references/refactoring.md` → Principle 4/5 |

**Finding:** All four probes start with `const relPath = prefix === "" ? CANONICAL : prefix + "/" + SUFFIX`. The empty string is acting as a discriminated-union tag. The canonical case (`"web/package.json"`) is also accidentally a zeroth-order path: `prefix === ""` produces `web/package.json`, and `prefix === "web"` ALSO produces `web/package.json`. The dedupe at line 544 exists specifically to resolve this collision — the model is internally inconsistent and patched up after the fact. AND no test asserts dedupe behaviour — `r.checked.filter(...).length > 0` would pass at 4× duplication.

**Consequence:** Adding a third layout shape (deeper monorepo, Windows backslash, etc.) requires touching all 4 probes' ternaries. The dedupe is load-bearing for the line-count budget (each duplicate adds 2 lines per refusal) but a "simplification" PR removing it silently breaches AC-3.2 with no test failure. Future depth-2 extension fragments the model further.

**Fix:** Drop the `prefix === ""` sentinel. Make `web` the first explicit prefix candidate from `enumerateCandidatePrefixes` (skip it from depth-1 iteration if it's the canonical Aura location). All probes become `const relPath = prefix + "/" + SUFFIX` with no ternary; dedupe vanishes. Add a regression test: mint `web/package.json` canonical layout, assert `r.checked.filter(c => c.path === "web/package.json" && c.name === MARKER_NAMES.AURA_PACKAGE_NAME).length === 1` — locks "one disk file → one MarkerCheck per marker name."

---

### 4. `probeRequirementsAndBot` is two probes wearing a trench coat

| | |
|---|---|
| **File** | `web/scripts/detect-stack.ts:387-446` |
| **Council** | Fowler × Carmack — Principle 2 (Long functions mixing distinct semantics) |
| **Ref** | `references/refactoring.md` → Principle 2/4 |

**Finding:** Root mode has a two-marker AND gate (`requirements.txt + bot/`) and emits path `"requirements.txt + bot/"`; subdir mode has a single-marker gate (`<prefix>/requirements.txt`) and emits path `"<prefix>/requirements.txt"`. The fork lives inside the function as `if (prefix === "")` with a compressed `present: reqPresent || (prefix === "" && botPresent)` boolean. The two branches do meaningfully different semantic work; the dual `path` semantics also means the dedupe at line 547 is doing real semantic work that isn't obvious from reading the call site.

**Consequence:** The next contributor extending this (adding `pyproject.toml` co-requirement for subdir mode, aligning bot/ semantics for monorepo aiogram layouts) has to mentally simulate both branches. One more branching dimension and it's a bug factory.

**Fix:** Split into `probeRequirementsAtRoot(rootResolved)` (AC-2.2 backward-compat probe with `bot/` co-req) and `probeRequirementsAtSubdir(rootResolved, prefix)`. The dispatcher calls the right one based on `prefix === ""`. Net line count is similar but each function reads top-to-bottom and the "subdir doesn't need bot/" rule is a function boundary rather than an inline conditional. Couples cleanly with Finding 3 (if 3 is done first, this becomes "split because semantics differ", not "split because branching grew").

---

### 5. AC-3.2 line-cap (≤18 lines) test silently excludes the new `override_conflict` refusal branch

| | |
|---|---|
| **File** | `web/scripts/detect-stack.test.ts:163-170` |
| **Council** | Beck × Carmack — Principle 5 (Tests as behavioural variants — boundary case missing) + Principle 6 (Mutation resistance) |
| **Ref** | `references/quality-testing.md` → Principle 5/6 |

**Finding:** The existing AC-3.2 test mints an EMPTY workspace, hitting the `unknown` branch — the SHORTEST refusal body. The new `override_conflict` branch adds 3 extra header lines + replaces the 3-line OVERRIDE_FOOTER with a 2-line "To resolve" footer. Counted: ~17 lines for a full conflict refusal — compliant today, but no test asserts this. A future addition (third "alternative override" line, second "Auto-detected" annotation) silently breaches 18 with no signal.

**Consequence:** The "10-second read budget" claim in the comment becomes aspirational for the most complex branch — exactly the regression AC-3.2 was supposed to guard against.

**Fix:** Add a third AC-3.2 case explicitly for `override_conflict`: workspace with `.council-stack-override = aura\n` + `pyproject.toml` containing aiogram, assert `renderRefusal(...).split("\n").length <= 18`. While there, parametrise the existing test over `[unknown_empty, ambiguous_full, override_malformed_full, override_conflict_full]` via `describe.each` so all four refusal branches share the contract.

---

### 6. `renderRefusal(override_conflict)` test asserts substring inclusion only — content-leak canary missing (asymmetric with existing security canary)

| | |
|---|---|
| **File** | `web/scripts/detect-stack.test.ts:485-497` |
| **Council** | Beck × Carmack — Principle 6 (Assertions ARE the test — trivial assertions on complex returns). **Cross-ref:** Hunt verified no leak in current code (his Finding 5 — clean) but no test locks the contract going forward. |
| **Ref** | `references/quality-testing.md` → Principle 6 |

**Finding:** The override_conflict render test asserts 5 substrings present + first-person regex absent. The existing `refusal never echoes raw file content` test at L244-255 uses a `SUPER_SECRET_PASTED_TOKEN` canary against `web/package.json` content — but the same canary is NOT applied to `.council-stack-override` content for the new branch. Asymmetric coverage of the same security principle.

**Consequence:** A future refactor that inlines `read.text` (the raw `.council-stack-override` content) into the conflict body — say to make the error more helpful by showing what was typed — would be structurally undetectable by the test suite.

**Fix:** Write `.council-stack-override` content as `aura\nSECRET_LEAK_CANARY_42\n` (validator only consumes `.trim()` of first valid token; extra line ignored at parse but COULD leak through a future "show what was in the file" refactor), then `expect(text).not.toContain("SECRET_LEAK_CANARY_42")`. Cheap canary, symmetric with the existing one. Optional bonus: fold the AC-3.2 line-cap assertion here too.

---

### 7. `readdirSync` failure in `enumerateCandidatePrefixes` silently degrades depth-1 scan to root-only — no `read_error` surfaced

| | |
|---|---|
| **File** | `web/scripts/detect-stack.ts:231-238` |
| **Council** | Persistence × Carmack — Principle 3 (every failure mode becomes a structured result; never silently downgrades). |
| **Ref** | `references/quality-persistence.md` → Principle 3 |

**Finding:** When `readdirSync(rootResolved, {withFileTypes:true})` throws (EACCES on the workspace root, transient EIO, EMFILE), the catch returns `["", ]` — caller proceeds as if depth-1 scan ran but found no candidates. Indistinguishable from "this workspace genuinely has no depth-1 subdirs." Every per-marker `resolveMarker` failure surfaces as a `MarkerCheck` with `reason: "read_error"` — the convention this commit broke for the new enumeration layer. The file's own header comment ("never silently downgrades 'malformed' to 'absent'") explicitly forbids this pattern.

**Consequence:** A monorepo where the user accidentally chmod-700'd the workspace root for an unrelated reason gets the same refusal as a flat single-stack workspace — they are told to add an override, not told their FS permissions are wrong. Diagnostic regression vs the per-marker discipline.

**Fix:** Emit a synthetic enumeration-level MarkerCheck with `name: "<workspace>/ (directory scan)"`, `reason: "read_error"`, surfaced in the rendered refusal under "Found at workspace root" so the user sees the FS error. At minimum log the caught error to stderr from this script.

---

### 8. SPECIFICITY-guard negative tests don't distinguish pre-commit (root-only) from post-commit (depth-2) implementation

| | |
|---|---|
| **File** | `web/scripts/detect-stack.test.ts:380-396` |
| **Council** | Beck × Carmack — Principle 1 (Red step is the proof — a test that never could fail proves nothing) |
| **Ref** | `references/quality-testing.md` → Principle 1 |

**Finding:** Two SPECIFICITY tests assert `detectStack(w).kind === "unknown"` for fixtures putting markers EXCLUSIVELY in subdirs with workspace root marker-free. On the pre-commit root-only detector the answer would have been `unknown` (root had nothing to match); on the post-commit depth-2 detector the answer is also `unknown` because the literal-match guards correctly reject the directory-name heuristic. The tests pass on BOTH implementations — they cannot distinguish "we widened scope but kept specificity" from "we never widened scope at all." The actual depth-2 widening is regression-protected by the POSITIVE depth-1 tests (which IS coverage), but the negative tests labeled "SPECIFICITY-guard" don't add new signal.

**Consequence:** False confidence in mutation resistance. A reviewer (or AI agent) reading the test names assumes the negatives lock the depth-2 behaviour; they don't. A subsequent edit weakening the literal-match guard would still need a positive test to catch.

**Fix:** Either add a comment to the two tests stating "these also pass on root-only detector — depth-2 dimension is covered by positive tests above," OR add a positive twin pair via `it.each` so the contrast is the test itself: `bot/ alone → unknown` AND `bot/requirements.txt with ^aiogram → python` side-by-side. Lowest-cost: the comment.

---

## P3 — Consider

### 9. `renderRefusal` mixed responsibilities — extract pure helpers before more refusal kinds land

| | |
|---|---|
| **File** | `web/scripts/detect-stack.ts:666-726` |
| **Council** | Fowler × Carmack — Principle 2 (Extract pure logic) |

The function now does three things in one ~60-line body: headline selection (4-way), override_conflict body emission, footer dispatch. Extract `pickHeadline(result): string`, `renderConflictBlock(result): string[]`, `pickFooter(result): string[]`. Main function becomes 12 lines of concatenation. Pure functions, trivially safe extraction, no test churn (substring asserts on output). Small safe move now before more discriminants land.

---

### 10. Refusal text enumerates depth-1 subdirectory names from the workspace — disclosure surface

| | |
|---|---|
| **File** | `web/scripts/detect-stack.ts:702-713` |
| **Council** | Hunt × Carmack — Principle 3 (Minimise state) |

With depth-1 scan, `result.checked` accumulates MarkerCheck entries whose `path` contains `<subdir>/package.json`, `<subdir>/pyproject.toml`. `renderRefusal` prints every `present === true` entry. If a subdir is named to reveal sensitive intent (`acquisition-target-acme/`, `nda-foo-deal/`), the refusal output enumerates that name verbatim whenever it contains a probed marker file. A user pasting refusal output into a public bug report inadvertently discloses sibling-directory structure. Existing root-only scan never had this property. Document the disclosure in the function header (the subdir name is needed for the user to know which subdir to act on, so this is documentation hygiene, not a P1 leak).

---

### 11. Per-entry `lstatSync` failure in `enumerateCandidatePrefixes` silently skips — non-deterministic across re-runs

| | |
|---|---|
| **File** | `web/scripts/detect-stack.ts:248-254` |
| **Council** | Persistence × Carmack — Principle 3 (idempotency on state transitions) |

Per-entry lstat is wrapped in `try { … } catch { continue; }`. Transient EIO or EACCES causes the entry to be silently dropped. Two back-to-back invocations could enumerate different candidate sets (a real concern in CI containers under fd/inode pressure, on network-mounted homes, on FUSE-encrypted filesystems). Determinism contract weakened. Match the per-marker discipline: on lstat failure, push a synthetic MarkerCheck with `reason: "read_error"` for that prefix. Pairs with Finding 7 (same root cause: enumeration-layer silent fallback).

---

### 12. `Dirent.isDirectory()` follows-symlink ambiguity comment encodes a false invariant

| | |
|---|---|
| **File** | `web/scripts/detect-stack.ts:245-254` |
| **Council** | Hunt × Carmack — Principle 1 (If syntactically possible, it statistically exists) |

The inline comment asserts "also rejects symlinks (isDirectory false on dirent symlinks)". This is misleading: `Dirent.isDirectory()` reflects the `d_type` byte; on filesystems returning `DT_UNKNOWN` (some NFS/FUSE), Node falls back to a `stat`-style probe that FOLLOWS the symlink, so `isDirectory()` can return `true` for a symlinked dir. The code is saved by the subsequent `lstatSync` reject, but a future cleanup trusting the comment and removing the "redundant" lstat would silently let symlinked dirs into the candidate list. Rewrite the comment: "Dirent.isDirectory() is unreliable for symlinks on filesystems that return DT_UNKNOWN; the lstatSync below is the actual gate."

---

### 13. SKIP_SUBDIRS sampling tests only 2-of-22 closed-list entries

| | |
|---|---|
| **File** | `web/scripts/detect-stack.test.ts:413-439` (test gap); `web/scripts/detect-stack.ts:76-100` (calibration) |
| **Council** | Beck × Carmack — Principle 5 (Tests as behavioural variants). **Cross-ref:** Persistence flagged calibration concerns (his Finding 8) — `coverage/`, `.nuxt`, `.svelte-kit` missing for symmetry with `.next`/`.turbo`. |

Only `node_modules` + `dist` exercise the SKIP_SUBDIRS set; `.local` matches via `name.startsWith(".")` (a SEPARATE rule). A mutation removing `"venv"`, `"build"`, `"target"`, `".next"`, etc. from the set would not be caught. One `it.each(Array.from(SKIP_SUBDIRS))` test parametrised over the entire set — mint workspace with `<dir>/package.json` containing aura marker, assert `unknown`. 22 test cases for zero maintenance cost (loops over the exported set). Separately, rename the `.local` test to "hidden-dir scan rule" to disambiguate.

---

## Summary

| # | Finding | Severity | Council | Fix effort |
|---|---|---|---|---|
| 1 | EC-7 boundary regression (enumeratePrefixes bypasses resolveMarker) | P2 | Hunt × Persistence | ~30 LOC + comment |
| 2 | MAX_CANDIDATE_SUBDIRS=64 silent cap, no obs, no test | P2 | Persistence × Hunt × Beck | ~20 LOC + boundary test |
| 3 | `prefix === ""` sentinel polymorphism + post-collection dedupe | P2 | Fowler × Beck | ~40 LOC refactor + 1 test |
| 4 | `probeRequirementsAndBot` semantic fork split | P2 | Fowler | ~30 LOC split (after #3) |
| 5 | AC-3.2 line-cap test misses override_conflict branch | P2 | Beck | ~15 LOC, `describe.each` |
| 6 | override_conflict content-leak canary missing | P2 | Beck | ~5 LOC test |
| 7 | `readdirSync` failure silently degrades to root-only | P2 | Persistence | ~10 LOC + 1 test |
| 8 | SPECIFICITY-guard negatives don't distinguish pre/post-commit | P2 | Beck | comment OR `it.each` pair |
| 9 | `renderRefusal` extract pure helpers | P3 | Fowler | ~30 LOC extraction |
| 10 | Refusal enumerates depth-1 subdir names — disclosure | P3 | Hunt | doc comment |
| 11 | Per-entry lstatSync silent skip non-determinism | P3 | Persistence | ~5 LOC + 1 test |
| 12 | `Dirent.isDirectory` comment misleading | P3 | Hunt | 1-line comment fix |
| 13 | SKIP_SUBDIRS sampling tests only 2-of-22 | P3 | Beck × Persistence | parametrised test loop |

**Totals:** 0 P1, 8 P2, 5 P3.

## Verdict

Shipping-quality. The commit cleanly extends scope (depth=2 monorepo) and renders a pre-existing-but-dormant discriminant (`override_conflict`) without breaking any of the 24 prior tests + 15 mirror canary tests. There is no P1 — no exploitable security gap, no test failure, no broken backward compat.

The single most important thing to address is **the EC-7 boundary regression (Finding 1) + the silent-cap observability gap (Finding 2)**, ideally together. They share a root cause: the new enumeration layer introduces FS-access patterns that don't follow the disciplines the rest of the file explicitly upholds (no-silent-fallback per the file header; EC-7 path-resolution wrapper per project convention). Fixing both simultaneously closes the asymmetry — silent failures and weak boundaries in `enumerateCandidatePrefixes` either become structured results (matching the per-marker discipline) or route through `resolveMarker` (matching EC-7). 

The Carmack rule applies bluntly: **boundaries earn their place**. The new enumeration is a second filesystem boundary; you can't have two different rules for the same kind of access. Either fold it into resolveMarker or surface the failures in the result so downstream sees them.

**Persistence and Hunt are the load-bearing council members** for this code today. Fowler's structural findings (3, 4, 9) are correct but earn their economic place only after Persistence/Hunt close the silent-failure modes — premature structural surgery on top of silent failures multiplies the surprise budget.

Beck's gaps (5, 6, 8, 13) are all in the same family: the suite has predictable LLM-co-authored shape (positives-heavy, weak around invisible internal logic). Fix them when Finding 3 lands — `describe.each` parametrisation falls out naturally during that refactor.

---

## Findings Breakdown by Expert

| Expert | P1 | P2 | P3 | Total | Key Areas |
|---|---|---|---|---|---|
| Hunt (Security) | 0 | 1 | 2 | 3 | EC-7 boundary, Dirent semantics comment, subdir disclosure |
| Fowler (Refactoring) | 0 | 2 | 1 | 3 | prefix-sentinel polymorphism, requirementsAndBot fork, renderRefusal extraction |
| FS-JSON Persistence | 0 | 2 | 2 | 4 | EC-7 regression cross-ref, silent cap, readdir silent degrade, lstat silent skip |
| Beck (Test Quality) | 0 | 4 | 1 | 5 | dedupe untested, AC-3.2 misses conflict branch, leak canary missing, specificity-guard non-distinguishing, SKIP_SUBDIRS sampling |
| **TOTAL** | **0** | **8** | **5** | **13** | |

(Each cross-referenced finding counted once toward the primary domain; Hunt × Persistence on Finding 1 → Hunt; Persistence × Hunt × Beck on Finding 2 → Persistence; Fowler × Beck on Finding 3 → Fowler.)

**Review output written to:** `.council/review-output/2026-06-01-2026/FINAL-REVIEW.md`

**Expert output files:**
- Hunt: `.council/review-output/2026-06-01-2026/hunt.md`
- Fowler: `.council/review-output/2026-06-01-2026/fowler.md`
- Persistence: `.council/review-output/2026-06-01-2026/persistence.md`
- Beck: `.council/review-output/2026-06-01-2026/beck.md`
