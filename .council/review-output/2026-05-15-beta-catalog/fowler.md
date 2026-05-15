# Fowler — β Catalog Refactor Plan

The economic test first: AC-5.1 says TOTAL across six SKILL.md files must end strictly below 3177 LOC. The duplicated surface is the 13 inline subagent prompts in each of the four planner/reviewer skills (council-plan, council-plan-aura, council-review, council-review-aura — implementers do NOT seat 13 experts inline; they just reference `references/`). Each inline subagent block in `council-review-aura/SKILL.md` is 15–30 lines (Hunt 30, Fowler 28, Backend/Persistence/Realtime ~16 each). At roughly 18 LOC × 13 experts × 4 dispatch skills = ~936 LOC of pure duplication. That is the budget the refactor must capture. It IS achievable — but only with the right axis combination.

## Axis 1 — File format

- **Decision: B (single markdown file per expert, with frontmatter)**
- **Why:** Option A (directory-per-expert) trades one duplicate for three filesystem entries per expert; for a 13-entry catalog that is 39 files where the same data fits in 13. Carmack's "the function least likely to cause a problem is the one that doesn't exist" applies to files too. Option C (hybrid dir+single file) is A's filesystem cost without A's separation benefit — pure overhead. B keeps each expert self-explanatory in one read (satisfies AC-5.3) and lets `Read` tool callers grab prompt + reference in one open.
- **LOC implication per consumer skill:** The current ~18-LOC inline prompt block reduces to a 1-line catalog reference (e.g. `- hunt` inside an `experts:` YAML list). Net per skill: ~18 → 1 = ~17 LOC saved per expert per skill. Four dispatch skills × 13 experts × ~17 LOC ≈ **~884 LOC removed** from the six-SKILL.md total. That clears the AC-5.1 bar by a wide margin EVEN after Axis 2 adds catalog-side framing.

## Axis 2 — Phase-prompt framing

- **Decision: 2a (one generic catalog prompt + short per-phase wrapper in the consumer skill)**
- **Why:** 2b stores three near-identical copies of each expert prompt (plan/implement/review variants) — that re-introduces the very duplication this refactor exists to kill, just one layer down. The phase-specific framing is small: "advising on a feature that has not been built yet" vs "reviewing code for issues" is a single sentence. Lift the EXPERT identity + reference pointer + FINDING shape into the catalog; let each consumer skill prepend a 2-3 line phase frame at dispatch. This honours Fowler's "extract pure logic, keep mutations visible" — the per-phase verb is the variable; the expert's lane is the invariant.
- **Catalog-side LOC:** 13 experts × ~14 LOC (identity + reference + FINDING shape + output instructions) ≈ **182 LOC in catalog**. Plus per consumer skill, a single ~6-line `dispatch_wrapper` block reused for all 13 experts (defined once at top of skill, referenced by name). Net: catalog adds ~182, six skills add ~36 (6 × 6) = ~218 total NEW. Versus ~884 removed → **net SKILL-side reduction ≈ 866 LOC** (catalog LOC doesn't count against AC-5.1 by construction). Post-refactor SKILL.md total estimate: ~2311. Comfortably under 3177.

## Axis 3 — Stack overlay tagging

- **Recommended frontmatter shape:**
  ```
  ---
  name: hunt
  stack: common
  panels: [plan, review]   # which phases this expert is normally seated in
  reference: references/security.md
  ---
  ```
- **How aura-vs-python skills express their panel:** Each consumer skill carries a hard-coded `experts:` list that names the 13 experts it dispatches — the stack filter is RESOLVED AT AUTHORSHIP, not runtime. `council-review-aura/SKILL.md` lists `[hunt, fowler, backend-ts, persistence-fs, realtime-ndjson, subprocess, frontend-react, a11y, saarinen, friedman, willison, beck, deploy-docker-gha]`. `council-review/SKILL.md` lists the python-stack equivalents. No registry walks `stack: aura | python`; the frontmatter is documentation + a lint target (Axis 4), not a runtime selector. This honours the spec's 🚫 No plugin loaders constraint absolutely.

## Axis 4 — Backwards-compat validation

- **Mechanical proof shape:** A one-shot diff harness. For each of the four dispatch skills, render the assembled prompt for each of the 13 experts (catalog body + consumer-skill phase wrapper + file-list placeholder substitution) and emit one text blob per (skill, expert). Compare byte-for-byte against the pre-refactor inline blocks extracted from the baseline tag. Whitespace-normalise only at the trailing-newline boundary; everything else MUST match.
- **Where the check lives:** `~/.claude/skills/_council-experts/_verify/render-diff.sh` (or `.ts` — bun is available) — run by hand before the refactor PR merges. NOT a CI gate (these skills are not in a CI'd repo; the `~/.claude/skills/.git` baseline commit established yesterday IS the rollback anchor). Output: zero diff on all 4 × 13 = 52 cells, OR the script fails loudly with the first mismatch and the refactor is rolled back to the baseline commit. Pairs with `feedback_verify_test_bodies_not_just_names` — proof is rendered output, not "I checked manually".

## Risks I see

- **Catalog-files-only-readable-with-cross-reference smell (AC-5.3 violation).** If the per-expert catalog file becomes a stub that says "see references/security.md for everything", first-time reader has to open two files. Mitigation: the catalog entry MUST carry the FINDING shape + lane statement inline; the `references/` doc carries only the deep principles. Don't degrade catalog files to pointer-shells.
- **Phase-wrapper drift.** Once consumer skills own a short phase wrapper, those wrappers will drift in tone over months ("you're reviewing" → "review the following" → "look for issues in"). Axis 4's render-diff harness only catches first-commit identity; thereafter you need a convention that says "phase wrappers are byte-identical across the four dispatch skills". Pair with `feedback_council_documented_contract_canary` — pull the wrapper text into a single shared snippet referenced by name, not duplicated.
- **Stack frontmatter becomes vestigial.** If no tool ever reads `stack: common | aura | python`, it's documentation, and documentation drifts. Mitigation: Axis 4's diff harness asserts that each consumer skill's `experts:` list intersects the catalog correctly (every named expert exists; no python expert leaks into aura skill's list).
- **Speculative generality from JS-2.** The spec mentions future selective-panel filtering (`/council-review` seats only verification panel). That is NOT this refactor's first commit (AC-3.2 says byte-identical 13-expert panels at first commit). The catalog frontmatter should NOT pre-bake `panels: [plan, review]` filtering logic until JS-2 lands as its own spec. Recommendation: include the `panels:` field as a comment/disabled until JS-2 spec exists. Otherwise this refactor ships dead code.
- **God-list emerging in consumer skills.** If each consumer skill ends up with a 13-line `experts: [...]` block PLUS a 6-line phase wrapper PLUS a customisation paragraph PLUS the file-list-per-expert assignment, the skill might balloon back near the baseline. Watch for that during execution — re-measure after the first skill is converted; if savings under 80% of forecast, halt.

## Abandon-trigger

**If the rendered six SKILL.md total LOC after Axis 1+2 extraction is ≥ 2900 (under 9% reduction from 3177) — ABANDON.** Per AC-5.4 the spec accepts no-op. Sub-10% reduction means the catalog-side cost is eating the duplication savings and the structural shape isn't paying for itself — exactly the Fowler economic test failing. Re-measure after converting `council-review-aura/SKILL.md` (the biggest dispatch skill, 829 LOC, 13 inline prompts) — if that one skill alone doesn't drop ≥ 200 LOC, none of the others will, and the refactor doesn't pay back in 3–6 months. Leave the inline shape in place and revisit when expert #14 needs adding (the natural trigger the spec already names).
