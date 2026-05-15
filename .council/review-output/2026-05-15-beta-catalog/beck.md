# Beck — β Catalog Refactor Verifiability

## The AC-3.2 invariant in test terms

Restated as a testable statement: **for each of the six consumer skills, the multiset of (expert-name → fully-rendered dispatch-prompt-string) pairs that would be passed to the `Task` tool on the FIRST invocation after the refactor is byte-equal to that same multiset captured from HEAD~1 (the commit immediately before the refactor).**

Three properties matter:

1. **Set cardinality** — exactly 13 entries per skill (no expert dropped, no expert added).
2. **Set identity** — the expert names match: `{hunt, fowler, beck, willison, saarinen, friedman, react-ui, backend-ts, fs-json, deploy, ndjson, a11y, subprocess}` (for `-aura`) and the cross-stack equivalent for the non-aura trio.
3. **Per-element byte-equality** — for every expert in every skill, the rendered prompt string (after any wrapper concatenation, after frontmatter strip, after the catalog → consumer assembly the new shape introduces) is byte-identical to the inline block from the pre-refactor SKILL.md.

Property 3 is the load-bearing one. Properties 1 and 2 fall out for free if 3 holds.

## Mechanical verification proposal

- **Pre-refactor artifact:** `~/.claude/skills/_council-experts/.verify/before.json` — a single JSON file, six top-level keys (one per consumer skill), each value an object keyed by expert name with the verbatim prompt-block string as value. Captured on the refactor branch BEFORE the catalog extraction lands, by parsing the existing inline ```` ``` ```` fenced blocks under each `### Subagent N:` heading in HEAD~1's six SKILL.md files. Committed to the refactor branch (gitignored from main).
- **Post-refactor artifact:** `~/.claude/skills/_council-experts/.verify/after.json` — same shape, but the value strings are produced by a tiny render script that walks each consumer skill's expert-name list, looks up the catalog entry, and applies whatever wrapper/template assembly the new shape uses. **The renderer must be the same function the runtime would use** — not a re-implementation. If the runtime is "Claude reads SKILL.md and concatenates inline", the renderer is `cat SKILL.md | extract-fenced-blocks-under-subagent-headings`; if Axis 2b is chosen, the renderer is `read catalog/<expert>/<phase>.md` per skill type.
- **How to compare:** `diff -u before.json after.json` — must exit 0. Equivalently: a Node/Bun one-liner `JSON.stringify(JSON.parse(before)) === JSON.stringify(after)` after canonical-key-sorting. Plain diff is preferable — diff output is the failure log; a deep-equal returns boolean.
- **Where the script lives:** `~/.claude/skills/_council-experts/.verify/verify-panels.sh` (capture + diff) plus `render-panel.ts` (the renderer). Sibling to the catalog itself, so they version together.
- **When it runs:** (a) manually on the refactor branch, before opening the PR; (b) as a pre-commit canary on the catalog directory (any commit touching `_council-experts/` or any of the six SKILL.md re-runs the diff and fails the commit on non-zero exit). CI is overkill here — `~/.claude/skills/` is a single-developer repo per the context brief.

## On Axis 2 (phase-prompt framing) test impact

**2b (per-phase prompt files in catalog) is mechanically easier to verify; 2a (generic prompt + consumer wrapper) is mechanically harder by exactly one degree of freedom.**

Under 2b, every dispatch-prompt is one filesystem read: `cat _council-experts/hunt/plan.md`. The renderer is `cat`. Byte-identity reduces to "is the file in the catalog literally the string that used to live inline?" — a single substring test per (skill, expert) pair.

Under 2a, every dispatch-prompt is `cat _council-experts/hunt/prompt.md` PLUS a per-phase wrapper sentence from the consumer SKILL.md, concatenated at some specific position (prepended? appended? with what separator — `\n\n`? `---\n`? single space?). The renderer now has a concatenation rule. **That rule is itself a test surface** — flip the separator from `\n\n` to `\n` and every byte-identity assertion fails by exactly one newline. The pre-refactor inline blocks have a specific separator-implicit shape (whatever was between the phase framing and the lane instruction); reproducing it requires reading both halves carefully.

Beck's bias is unambiguous here: **fewer moving parts in the renderer = fewer ways the test can give a false positive**. Choose 2b for verifiability, accept the LOC penalty in the catalog (which AC-5.1 explicitly excludes from the LOC budget — only SKILL.md LOC is counted).

## Static-grep canaries to add

Three EC-19-style grep invariants, expressed as literal `rg` patterns that run in the pre-commit canary alongside the diff:

1. **No SKILL.md may inline a subagent prompt block:**
   `rg --type md -l '^### Subagent \d+:' ~/.claude/skills/council-*/SKILL.md` must return zero matches. Catches "someone added a 14th expert by pasting inline next to the catalog list."
2. **Every named expert in every consumer skill exists in the catalog:**
   For each consumer SKILL.md, extract the experts list (e.g. lines matching `^- \w+$` under an `## Experts:` heading), then for each name `N` assert `test -f ~/.claude/skills/_council-experts/<N>/plan.md` (or whatever filename shape Axis 1+2 settled on). Pure filesystem check, no JSON parsing required.
3. **No expert directory is orphaned:**
   The inverse: every directory under `_council-experts/` must be named in at least one consumer skill's experts list. Catches dead catalog entries that drift from real-world use. Pattern: `ls _council-experts/ | xargs -I{} sh -c 'rg -q "^- {}$" ~/.claude/skills/council-*/SKILL.md || echo "ORPHAN: {}"'` — output must be empty.

All three are dumb shell — no parser, no JSON, no Bun runtime. They run in milliseconds and survive any refactor of the renderer.

## Failure-mode UX (AC-6.1, AC-6.2)

AC-6.1 (missing expert) and AC-6.2 (malformed entry) both want **early, loud failure** — no silent fall-back to a default. Three layers:

- **Pre-commit (catalog-level):** canary #2 above catches AC-6.1 ("expert named but not in catalog") before the bad commit lands. Canary equivalent for AC-6.2: for each catalog dir, assert all required files exist (`prompt.md`, `reference.md`, frontmatter parses); express as `rg -q '^stack: (common|aura|python)$' _council-experts/*/meta.yaml` or equivalent. Failure prints the exact missing-field name. This is the strongest layer — failure before the file enters git history.
- **Skill load (first-dispatch level):** when a consumer skill runs Phase 3, before dispatching ANY subagent it walks its experts list and stat()s each catalog entry. On the first missing or malformed entry it raises a Chair-visible error: `"Council refused: expert 'subprocess' named in council-implement-aura/SKILL.md but ~/.claude/skills/_council-experts/subprocess/plan.md not found. Either add the catalog entry or remove the name from the skill's experts list."` — no silent skip, no fall-back to "dispatch the other 12 anyway." This is the AC-6.1/6.2 contract surface and where the test for these ACs lives.
- **Render-time test:** a single `verify-panels.sh --check-only` invocation (without the `before.json` comparison) walks all six skills, attempts to render every panel, and exits non-zero on any failure. Run as part of the pre-commit canary. Covers the case where the catalog is internally consistent but a SKILL.md has typoed an expert name — pure-grep canary catches it, but render-test catches it AND prints the same error message the runtime would.

The test asserting the skill refuses with a clear error is a tiny shell snippet: stage a deliberately-malformed catalog entry (e.g. `mv _council-experts/hunt/plan.md _council-experts/hunt/plan.md.bak`), run `verify-panels.sh --check-only`, assert exit code != 0 AND stdout contains the literal expert name `hunt`. Restore the file in teardown. Lives in `verify-panels.test.sh` next to the renderer.

## Abandon-trigger

**If the renderer for Axis 2a needs more than 5 lines of logic to reproduce byte-identical pre-refactor prompts** — meaning the wrapper-concatenation rule has special cases per expert, per skill, or per phase — the catalog has not actually simplified the system; it has moved the inline complexity into a render script that future readers must also understand. Per AC-5.4: ABANDON, keep inline shape, revisit when the next new expert lands. Beck's rule: a verification script you have to debug to trust is worse than the duplication it was supposed to remove.
