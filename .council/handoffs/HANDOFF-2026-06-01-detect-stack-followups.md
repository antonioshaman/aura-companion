# Pickup: 2026-06-01 detect-stack.ts council-review follow-ups

> **Mode:** semi-autonomous, council pair (orchestrator + observer). The 8 P2 + 5 P3 findings are mostly mechanical and form three natural phases. Decompose each phase into ≤100k working tokens per `feedback_phase_decomposition_by_token_budget`. Stop only on (a) all P2s merged to main OR (b) hard blocker (test red, typecheck red, or council-observer STOP that resists three attempts).

---

## TL;DR

Council review on commit `99336b5` (depth=2 monorepo scan + `override_conflict` refusal) returned **0 P1, 8 P2, 5 P3**. Two commits on `feat/council-spawn-ack` already shipped to origin (`99336b5`, `af87eca`). PR not yet opened — open at https://github.com/antonioshaman/aura-companion/pull/new/feat/council-spawn-ack OR keep stacking follow-up work on this branch and open one PR at the end.

Full review: `.council/review-output/2026-06-01-2026/FINAL-REVIEW.md` (canonical source — read first).

The 13 findings split cleanly into **3 phases by structural cohesion**, NOT by severity:

| Phase | Findings | Theme | Est. effort |
|---|---|---|---|
| **A** | 1, 2, 7, 11 (4 findings: 3 P2 + 1 P3) | Silent-failure modes in new enumeration layer — restore no-silent-fallback invariant + EC-7 boundary | ~80 LOC + 3 tests |
| **B** | 3, 4, 9 (3 findings: 2 P2 + 1 P3) | Probe abstraction refactor — drop `prefix===""` sentinel, split `probeRequirementsAndBot`, extract `renderRefusal` pure helpers | ~120 LOC refactor + 1 regression test |
| **C** | 5, 6, 8, 13 (4 findings: 3 P2 + 1 P3) | Test-quality pass — fix what current tests don't catch | ~60 LOC test additions |

P3 not in any phase: **Finding 10 (doc comment about subdir name disclosure)** + **Finding 12 (Dirent comment correction)** — fold into Phase A as documentation hygiene.

**Total estimated:** ~260 LOC + ~10 new tests. Realistically 1 council pair session per phase (3 sessions) given the 100k-token budget per phase rule + observer review delay.

---

## Operating rules (read once)

- **Workspace:** `/root/aura-companion` (this repo). Branch: stay on `feat/council-spawn-ack` (already pushed to origin) — stack follow-up commits, open one combined PR at the end. Do NOT rebase or force-push without explicit user confirmation.
- **Git identity:** verify before every commit per CLAUDE.md critical rule. Pre-commit hook blocks wrong email; correct identity is `Anton Shmonin <anton@shmonin.ru>`.
- **Council pair is live in this session.** Each phase: write `.council/checkpoints/<phase>.json` via REST POST to `/api/sessions/<orchestrator-sid>/council/checkpoint`. Schema in `web/server/council-types.ts` — required: `schema_version: 1`, `session_group_id`, `checkpoint_id`, `phase` (regex `/^[A-Za-z0-9_-][A-Za-z0-9_.\-]{0,63}$/`), `sequence`, `emitted_at` (ISO), `artifact_paths` (workspace-relative).
- **Auth token** for REST: `cat /home/auracomp/.companion/auth.json` → `.token`.
- **Pre-commit gates:** typecheck + tests must pass per `.husky/pre-commit`. Don't `--no-verify` — diagnose root cause per `feedback_no_ignore_failing_test_diagnose_first.md`.
- **Conventions floor:** EC-7 (FS-access discipline), now ratified specifically for this file by EC-36. AP-15 locks the editing direction (detect-stack.ts canonical → SKILL.md mirrors after). Read `conventions.md` if unsure.
- **Memory checkpoint:** before non-trivial refactor, grep `/home/auracomp/.claude/projects/-root-aura-companion/memory/` for relevant prior wisdom. Especially load-bearing: `feedback_recovery_branch_reachability.md`, `feedback_call_site_presence_not_just_symbol_export.md`, `feedback_trust_diff_not_prose.md`, `feedback_validator_per_semantic_category.md`.

---

## Phase A — Silent-failure modes + EC-7 boundary (4 findings: 3 P2 + 1 P3 + 2 doc-only P3)

**Headline:** the new `enumerateCandidatePrefixes` helper introduced FS-access patterns that don't follow the disciplines the rest of the file explicitly upholds. Findings 1+2+7+11 share root cause: silent failures in enumeration vs structured failures in per-marker probes.

### A1. Finding 1 — EC-7 boundary regression (P2, Hunt × Persistence)

`web/scripts/detect-stack.ts:231-259`

Either (a) route the directory check through `resolveMarker(rootResolved, name)` and reuse its result, OR (b) extract a shared `lstatNonSymlinkInsideRoot(rootResolved, name)` helper that both `resolveMarker` and `enumerateCandidatePrefixes` call. At minimum: correct the misleading inline comment at line 246 ("Defensive realpath bounds check" — no realpath is called). EC-36 in `conventions.md` is the convention floor.

### A2. Finding 2 — MAX_CANDIDATE_SUBDIRS=64 silent cap (P2, Persistence × Hunt × Beck)

`web/scripts/detect-stack.ts:101, 239-244` + test gap.

Add `scanTruncated: boolean` to `DetectionResult` set when the cap is hit; surface in `renderRefusal` as a one-line note. Export `MAX_CANDIDATE_SUBDIRS` so tests can reference it. Add boundary test that mints 65 dirs, places marker in 65th, asserts the chosen contract (silent-miss documented OR surface-the-cap implemented).

### A3. Finding 7 — readdirSync failure silent degradation (P2, Persistence)

`web/scripts/detect-stack.ts:231-238`

On `readdirSync` failure, emit a synthetic enumeration-level `MarkerCheck` with `name: "<workspace>/ (directory scan)"`, `reason: "read_error"`, surfaced in the rendered refusal under "Found at workspace root". At minimum log the caught error to stderr.

### A4. Finding 11 — Per-entry lstatSync silent skip (P3, Persistence)

`web/scripts/detect-stack.ts:248-254`

Same pattern as A3 but per-entry. On lstat failure, push a synthetic `MarkerCheck` with `reason: "read_error"` for that prefix. Pairs with A3 (same root cause).

### A5 — Documentation hygiene (Findings 10 + 12, P3)

- Finding 10 (`detect-stack.ts:702-713`): add header comment documenting that depth-1 subdir names appear in refusal output — disclosure surface for users pasting refusals into public bug reports.
- Finding 12 (`detect-stack.ts:245-254`): rewrite the misleading "Dirent.isDirectory() rejects symlinks" comment — on filesystems returning `DT_UNKNOWN`, Node falls back to stat-style probe that follows the symlink. The `lstatSync` is the actual gate.

**Phase A acceptance:**
- typecheck + 56/56 detect-stack tests + 6521+ full suite green.
- New tests: boundary case for MAX_CANDIDATE_SUBDIRS, readdirSync failure surfacing, lstatSync failure surfacing.
- EC-36 satisfied: every FS-access predicate either routes through `resolveMarker` OR inlines complete equivalent discipline + names the inlined checks.

---

## Phase B — Probe abstraction refactor (3 findings: 2 P2 + 1 P3)

**Headline:** the `prefix === ""` sentinel is hidden polymorphism scattered across 4 probes; the post-collection `(name, path)` dedupe is fix-up for a model collision. Resolve together by dropping the sentinel.

### B1. Finding 3 — `prefix===""` sentinel + post-collection dedupe (P2, Fowler × Beck)

`web/scripts/detect-stack.ts:268-446` (probes) + `544-551` (dedupe).

Drop the `prefix === ""` sentinel. In `enumerateCandidatePrefixes`, make `web` the first explicit prefix candidate (canonical Aura location) AND skip it from depth-1 iteration if it's already covered. All four probes become `const relPath = prefix + "/" + SUFFIX` with no ternary — dedupe vanishes.

Add regression test: mint `web/package.json` (canonical Aura layout), assert `r.checked.filter(c => c.path === "web/package.json" && c.name === MARKER_NAMES.AURA_PACKAGE_NAME).length === 1` — locks "one disk file → one MarkerCheck per marker name" against both dedupe removal AND double-count regressions.

### B2. Finding 4 — `probeRequirementsAndBot` semantic fork split (P2, Fowler)

`web/scripts/detect-stack.ts:387-446`

After B1 lands, split into `probeRequirementsAtRoot(rootResolved)` (AC-2.2 backward-compat probe with `bot/` co-req, label `"requirements.txt + bot/"`) and `probeRequirementsAtSubdir(rootResolved, prefix)` (single-marker probe, label `"<prefix>/requirements.txt"`). Dispatcher calls the right one based on prefix kind (after B1 the kind is a clean prefix-vs-no-prefix decision, not a sentinel string compare).

### B3. Finding 9 — `renderRefusal` extract pure helpers (P3, Fowler)

`web/scripts/detect-stack.ts:666-726`

Extract `pickHeadline(result): string`, `renderConflictBlock(result): string[]` (returns `[]` when not conflict), `pickFooter(result): string[]`. Main function becomes ~12-line concatenation: headline + blank + maybeConflictBlock + checkedFor + foundAt + blank + footer. Pure functions — trivially safe extraction, no test churn (substring asserts on output).

**Phase B acceptance:**
- All 56 detect-stack tests + 15 mirror canary tests green (mirror canary verifies SKILL.md cites every MARKER_NAMES + REFUSAL_HEADLINES verbatim; refactor must preserve constants).
- New "one disk file → one MarkerCheck per marker name" regression test added.
- Probe functions read top-to-bottom without branch tracking on a sentinel string.

---

## Phase C — Test-quality pass (4 findings: 3 P2 + 1 P3)

**Headline:** the suite has predictable LLM-co-authored shape (positives-heavy, weak around invisible internal logic). Phase C closes the mutation-resistance gaps Beck flagged.

### C1. Finding 5 — AC-3.2 line-cap test misses override_conflict branch (P2, Beck)

`web/scripts/detect-stack.test.ts:163-170`

Add third AC-3.2 case for `override_conflict`: workspace with `.council-stack-override = aura\n` + `pyproject.toml` containing aiogram, assert `renderRefusal(detectStack(w)).split("\n").length <= 18`. Parametrise via `describe.each` over `[unknown_empty, ambiguous_full, override_malformed_full, override_conflict_full]` — all four refusal branches share the line-cap contract.

### C2. Finding 6 — `override_conflict` content-leak canary missing (P2, Beck)

`web/scripts/detect-stack.test.ts:485-497`

Add to the override_conflict render test: write `.council-stack-override` content as `aura\nSECRET_LEAK_CANARY_42\n` (validator only consumes `.trim()` of first valid token; extra line ignored at parse but COULD leak through a future "show what was in the file" refactor), then `expect(text).not.toContain("SECRET_LEAK_CANARY_42")`. Cheap canary, symmetric with the existing `SUPER_SECRET_PASTED_TOKEN` canary on `web/package.json` content (test at L244-255).

### C3. Finding 8 — SPECIFICITY-guard negatives don't distinguish pre/post-commit impl (P2, Beck)

`web/scripts/detect-stack.test.ts:380-396`

Lowest-cost fix: add comment to the two existing tests stating "these also pass on root-only detector — depth-2 dimension is covered by positive tests above." Better: add a positive twin pair via `it.each` so the contrast is the test itself: `bot/ alone → unknown` AND `bot/requirements.txt with ^aiogram → python` side-by-side.

### C4. Finding 13 — SKIP_SUBDIRS sampling tests only 2-of-22 entries (P3, Beck × Persistence)

`web/scripts/detect-stack.test.ts:413-439`

Export `SKIP_SUBDIRS` (currently const-defined). Add `it.each(Array.from(SKIP_SUBDIRS))` test parametrised over the entire set — mint workspace with `<dir>/package.json` containing aura marker, assert `unknown`. 22 test cases for zero maintenance cost. Separately, rename the `.local` test to "hidden-dir scan rule (name.startsWith('.'))" to disambiguate from set-membership tests — the rule is structurally different.

Optional (Persistence calibration concern): add `coverage/`, `.nuxt`, `.svelte-kit`, `.astro` to `SKIP_SUBDIRS` for symmetry with `.next`/`.turbo`. Defer unless one of those dirs is actually causing noise in a real monorepo.

**Phase C acceptance:**
- 56 + ~25 new tests green (line-cap parametrisation over 4 branches, leak canary, SKIP_SUBDIRS loop, optional specificity twin pair).
- Mutation resistance: removing the dedupe, removing a SKIP_SUBDIRS entry, OR leaking `.council-stack-override` content into refusal — each becomes test-detectable.

---

## Out of scope for this handoff

- The PR creation itself — open `gh pr create` when all three phases are green OR open immediately as a draft PR. User preference unspecified.
- Manual version bump in `package.json` — release-please handles this on main merge. Do NOT manually edit `package.json:version`.
- The 3 SKILL.md files at `~/.claude/skills/` are MIRRORED automatically via the canary test; do not edit them directly unless you change MARKER_NAMES / REFUSAL_HEADLINES / OVERRIDE_VALUES in `detect-stack.ts` first. AP-15 in `conventions.md` is the convention floor.
- Spec doc `specs/council-stack-autodetect-monorepo.md` already documents the depth=2 contract + Specificity invariant + AC-conflict — no need to extend unless a Phase A/B/C change deviates from spec.

---

## How to open the council pair (for the user reading this)

1. Open the Aura Companion UI in browser (`http://localhost:3456` if not already open).
2. Click "New Session" in the sidebar.
3. In the New Session form, find the **Council Mode toggle** (or `CouncilToggle` component per `web/src/components/council/CouncilToggle.tsx`). Enable it.
4. **Provider pairing dropdown** appears — choose `claude+claude` for symmetric review, or `claude+codex` for asymmetric (Codex as observer brings different bias). For this work `claude+claude` is fine; the findings are mechanical, not strategic.
5. **Workspace:** `/root/aura-companion` (this repo).
6. **Branch:** confirm `feat/council-spawn-ack` is checked out.
7. **First message to the orchestrator** — paste this handoff path:
   ```
   Read .council/handoffs/HANDOFF-2026-06-01-detect-stack-followups.md and execute Phase A.
   Council pair is live — emit a checkpoint at .council/checkpoints/phase-A.json
   after each sub-task (A1, A2, A3, A4, A5) so the observer can cross-review.
   ```

The observer wakes within ~1s of each checkpoint write and emits its independent review to `.council/reviews/phase-A-<provider>-observer.md`. The orchestrator reads observer findings before next sub-task. STOPs from the observer block progress until resolved per `feedback_council_review_multirepo_scoping.md` discipline.

---

## Memory / KB pointers for the pickup session

Before Phase A starts, load these (cap to ≤3 per `feedback_writer_pickup_parallel_read_auto_compact_deadlock.md`):

1. `.council/review-output/2026-06-01-2026/FINAL-REVIEW.md` — canonical source of truth for all 13 findings + Carmack verdict.
2. `conventions.md` — EC-7 (filesystem-access discipline) and the newly-added EC-36 (detect-stack.ts specific tightening) + AP-15 (canonical-vs-mirror).
3. `web/scripts/detect-stack.ts` — the file under modification.

Memories worth surfacing if the pickup session hits ambiguity:
- `feedback_recovery_branch_reachability.md` (related to override_conflict discriminant — produced but historically unrendered until this commit).
- `feedback_call_site_presence_not_just_symbol_export.md` (related to EC-7 boundary: `resolveMarker` exists but new site doesn't call it).
- `feedback_validator_per_semantic_category.md` (relevant to MarkerCheck.reason expansion if A2/A3 add new reason kinds).

---

## Commit shape per phase

Suggested per-phase commits (don't combine — each phase is independently reviewable):

- Phase A: `fix(council-router): restore no-silent-fallback in detect-stack.ts enumeration + EC-36 compliance`
- Phase B: `refactor(council-router): drop prefix sentinel + split probeRequirementsAndBot + extract renderRefusal helpers`
- Phase C: `test(council-router): mutation-resistance pass — line-cap, leak canary, SKIP_SUBDIRS, specificity twin`

Each commit subject ≤70 chars; bullet body explains the structural argument. Conventional-commit type matters for release-please: Phase A is `fix:`, Phase B is `refactor:`, Phase C is `test:`. None of these bump minor version (only `feat:` does) — they all land as patch bumps when merged to main.

---

## Done criteria for the whole handoff

- All 13 findings either addressed in a commit on this branch OR documented as deferred with rationale.
- typecheck + tests + a11y all green.
- Mirror canary green (no SKILL.md drift introduced).
- Council observer has STOPped-then-cleared each phase (or never STOPped — clean run).
- PR opened OR a final commit message explaining why the PR is being held back.

**On hard blocker:** write `.council/handoffs/CLOSURE-2026-06-XX-detect-stack-followups.md` with what landed, what's stuck, what the next session needs to know. Surface the blocker in the orchestrator-half message to the user.
