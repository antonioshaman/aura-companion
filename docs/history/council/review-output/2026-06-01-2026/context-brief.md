## Context Brief for Aura Council Review

### Scope under review

Commit `99336b5` on branch `feat/council-spawn-ack`:
- `web/scripts/detect-stack.ts` — canonical Phase 0 stack-detection logic for council router skills. Implements `detectStack(workspaceRoot): DetectionResult` + `renderRefusal(result): string` + closed-list constants. THIS COMMIT extends scan from workspace-root-only to **workspace root + depth-1 subdirs** for monorepo support, and rendres the existing `override_conflict` discriminant (previously defined but returned empty string).
- `web/scripts/detect-stack.test.ts` — 17 new test cases (24 → 41 in this file; +15 mirror canary = 56 total in `scripts/detect-stack*`).
- `specs/council-stack-autodetect-monorepo.md` — new spec doc (sibling/follow-up to `specs/council-command-stack-router.md`).
- `.agents/knowledge/codebase-facts.jsonl` — added `fact-005` documenting that detect-stack.ts is the canonical implementation and SKILL.md files at `~/.claude/skills/` are mirror artifacts enforced by `detect-stack.skill-mirror.test.ts`.

NOT under review (outside repo): 3 SKILL.md files at `~/.claude/skills/{council-plan,council-implement,council-review}/SKILL.md` that were updated as mirror citations. Their drift discipline is enforced by `detect-stack.skill-mirror.test.ts` (canary), which still passes — so the mirror is in sync with this commit's canonical changes.

### What this code does

`detect-stack.ts` is the Phase 0 stack-detection utility consumed by 3 router-style council skills (`/council-plan`, `/council-implement`, `/council-review`). Given a workspace root path, it inspects filesystem markers and returns a discriminated union — `aura` (dispatch to `-aura` variant), `python` (continue in suffixless body), `ambiguous` / `unknown` / `override_conflict` / `override_malformed` (refuse loudly). It is also citied by `web/scripts/detect-stack.skill-mirror.test.ts` which asserts the 3 SKILL.md files quote every canonical constant (MARKER_NAMES + REFUSAL_HEADLINES + OVERRIDE_VALUES) verbatim.

Pre-commit (root-only): probes `web/package.json`, `web/server/ws-bridge.ts`, `pyproject.toml`, `requirements.txt + bot/` at workspace root only. Friction in monorepos (rapesha_academy: `advisor_bot/requirements.txt`, `webapp/package.json` — no root markers) → forced `.council-stack-override` workaround on every invocation.

This commit: scan workspace root + depth-1 subdirs (with a 24-entry SKIP_SUBDIRS skip-list + 64-candidate cap), preserving marker specificity (no directory-name signals; literal-match contracts unchanged). The previously-defined `override_conflict` discriminant is now actually rendered (was returning `""`).

### Architecture (within scope)

The TS file is ~640 lines, single-module, pure (no side effects, no imports beyond `node:fs` + `node:path`). Public surface:
- Constants: `MARKER_NAMES`, `OVERRIDE_VALUES`, `REFUSAL_HEADLINES` (added `override_conflict` headline this commit).
- Types: `MarkerCheck`, `DetectionKind`, `DetectionResult`.
- Entry: `detectStack(workspaceRoot)`, `renderRefusal(result)`.
- Internals: `resolveMarker` (EC-7 boundary wrapper), `readText`, `isDirectory`, `enumerateCandidatePrefixes` (NEW — produces `["", "<subdir1>", "<subdir2>", ...]` list), 4 probe functions (each refactored to take `prefix: string` arg), `readOverride`.

`detect-stack.test.ts` is ~480 lines. Test fixture pattern: each test mints a fresh `mkdtempSync` workspace, writes specific markers via small helper functions, asserts `detectStack(w).kind` + `renderRefusal()` substrings. `afterEach` `rmSync` cleanup.

### Stack in use within scope

Present: Node fs APIs (sync, defensive — lstat + realpath + size cap + BOM + CRLF), Vitest, vitest mkdtempSync fixtures.
Absent: NO Hono, NO WebSocket, NO subprocess, NO React, NO Zustand, NO Tailwind, NO storage state, NO LLM, NO a11y surface. detect-stack.ts is a pure pre-spawn utility consumed by skill prose (read by Claude Code harness from SKILL.md prose, then optionally executed by the user as `bun web/scripts/detect-stack.ts`).

### Key observations / risks worth attention

1. **EC-7 path-resolution boundary** (security canon): the existing code routes every marker access through `resolveMarker` (workspace-root realpath + bounds check + symlink reject). The new `enumerateCandidatePrefixes` adds a SECOND filesystem-access site (`readdirSync` + `lstatSync` per dir) that does its OWN symlink check inline — same defensive shape but not via `resolveMarker`. Worth a Hunt look at whether this is a regression vs convention.

2. **`probeRequirementsAndBot` branching**: root mode preserves `bot/` co-requirement (AC-2.2 backward compat); subdir mode drops it (replaced by "subdir owns its own requirements.txt" as the project-shape signal). The branching is `if (prefix === "")` — a small fork worth a Fowler look (is this hiding a polymorphism?).

3. **Candidate dedupe**: when `web` is a depth-1 candidate, `probePackageJson(root, "")` and `probePackageJson(root, "web")` both target `web/package.json`. Resolved by `(name, path)` dedupe in `detectStack`. Whether this is the right level of abstraction (post-collection dedup vs upfront skip) is a Fowler question.

4. **SKIP_SUBDIRS list hardcoded**: includes hidden + node_modules + dist + .git + venv + etc. Not configurable. Specificity invariant explicitly forbids name-based heuristics for STACK signals — but the skip-list IS a name-based heuristic for SCOPE. Consistency question worth Persistence + Hunt review.

5. **Test coverage scope**: 17 new tests target monorepo (3 aura layouts + 2 python layouts), specificity-guards (3 negative), SKIP_SUBDIRS (3 — node_modules/dist/hidden), and override_conflict (5). Render output is asserted via substring inclusion. Beck question: are there mutation-killer cases? E.g. if someone "improves" the specificity by allowing `name === "something-else" + dependencies.react` to imply Aura, do tests catch?

6. **`MAX_CANDIDATE_SUBDIRS=64` cap**: silent stop, no warning. Worth a finding on observability if a real monorepo has 65+ depth-1 dirs (unlikely but unbounded by spec).

7. **renderRefusal `override_conflict` body**: the new branch emits `.council-stack-override asserts: X` + `Auto-detected from markers: Y` + `To resolve: correct or delete .council-stack-override`. No "ask user which to honor" wording even though spec §5 AC-conflict calls it "ask-first". The CLI utility cannot prompt; the SKILL.md docs do that. Persistence/UX question.

### Automated check results

- **TypeScript** (`bun run typecheck`): PASS (no errors).
- **detect-stack tests** (`bun run test scripts/detect-stack`): 56/56 PASS (24 existing + 17 new + 15 mirror canary).
- **Full test suite** (run before commit): 254 files, 6521/6521 PASS, 4 skipped.
- **a11y**: NOT APPLICABLE — no `.tsx` / component changes in this commit; the scoped review skips a11y per skill rules.
- **Pre-commit hook**: passed during `git commit` (typecheck + tests).

### Domain File Assignments

**Hunt (Security):** `web/scripts/detect-stack.ts` — focus on EC-7 path-resolution boundary, symlink-reject discipline in BOTH `resolveMarker` and the new `enumerateCandidatePrefixes`, BOM/CRLF input parsing, size caps, refusal-text leakage (no raw file content in error output), `override_conflict` semantic safety (does it fail closed?).

**Fowler (Refactoring / Structure):** `web/scripts/detect-stack.ts` — focus on `probeRequirementsAndBot` root-vs-subdir branching, the `prefix` parameter abstraction added to all 4 probes (is it pulling its weight or creating dead modes?), `(name, path)` post-collection dedupe vs upfront filtering, `enumerateCandidatePrefixes` cohesion (is it a helper or its own responsibility?), the SKIP_SUBDIRS hardcoded set (config or invariant?).

**FS-JSON Persistence Expert:** `web/scripts/detect-stack.ts` — focus on `readdirSync` failure handling, `lstatSync` symlink discipline in the new helper, BOM tolerance, size caps, the `MAX_CANDIDATE_SUBDIRS` silent-cap policy (failure-mode disclosure), and the path discipline relative to workspace root.

**Beck (Test Quality):** `web/scripts/detect-stack.test.ts` — focus on the 17 new tests' behavioral discipline (do they assert OBSERVABLE results, not implementation), the specificity-guard negative tests (do they kill the mutation "directory name = signal"?), the `override_conflict` test bodies (do they verify both the discriminant AND the rendered body?), fixture isolation (`mkdtempSync` cleanup discipline), and whether AC-3.2 line-cap (≤18 lines) is preserved given the new override_conflict branch may push longer.

### Council dispatched (reduced council — files-in-scope only)

- Hunt (Security)
- Fowler (Refactoring)
- FS-JSON Persistence
- Beck (Test Quality)

Skipped (no in-scope files): Bun/Hono/TS Backend, Realtime/NDJSON, Subprocess, React/Web UI, a11y, Saarinen, Friedman, Willison, Docker/GHA Deploy.

### Relevant prior conventions / memory

- `EC-7` from `conventions.md`: filesystem-access predicates inline path resolution OR exposed only via a resolving wrapper. The existing `resolveMarker` is the canonical EC-7 wrapper; the NEW `enumerateCandidatePrefixes` does its own inline lstat-then-bounds check (NOT via `resolveMarker`). Possible EC-7 regression — primary Hunt finding candidate.
- `feedback_skill_marker_mismatch_use_override.md` (memory): refusal on mismatch ≠ wrong stack; `.council-stack-override` is the documented escape hatch. This commit reduces frequency of that override BUT preserves it as escape hatch.
- `feedback_stack_gated_skill_refusal_three_options.md` (memory): when refusing, present three options (inline / fork / override). The new `override_conflict` body says "To resolve: correct or delete" — does that align with the three-options pattern? Possible Friedman question if dispatched (NOT dispatched in this reduced council — out of scope).
