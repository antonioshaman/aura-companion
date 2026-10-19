## Context Brief for Aura Council Review (v2 router A/B)

### What this code does
Adds an auto-stack-detection router on top of the three suffixless council slash commands (`/council-plan`, `/council-implement`, `/council-review`). The skill agent inspects workspace markers (`web/package.json`, `web/server/ws-bridge.ts`, `pyproject.toml`, `requirements.txt`+`bot/`, optional `.council-stack-override`) and dispatches the correct stack-specific variant (Aura/Bun vs Python/aiogram), or refuses loudly on ambiguous/unknown. The three `-aura` suffixed skills remain unchanged as explicit overrides.

### Architecture
Two artefact layers:

1. **In-repo verifier (the AC binder):**
   - `web/scripts/detect-stack.ts` — pure synchronous TS detector. Exports `detectStack(workspaceRoot)`, `renderRefusal(result)`, and the closed allow-lists `MARKER_NAMES`, `OVERRIDE_VALUES`, `REFUSAL_HEADLINES`.
   - `web/scripts/detect-stack.test.ts` — 24 Vitest tests using `mkdtempSync` isolated workspaces. Covers AC-1.1..1.4 (Aura), AC-2.1..2.3 (Python), AC-3.1..3.3 (refusal), defensive-read discipline (symlink, oversize, CRLF, BOM, content-leak), and `.council-stack-override` precedence.
   - `web/scripts/detect-stack.skill-mirror.test.ts` — 15 cross-artefact drift tests reading the 3 SKILL.md files at `~/.claude/skills/` and asserting they contain every canonical marker name, refusal headline, and override value. `describe.skipIf(!existsSync(SKILLS_ROOT))` so CI without the skills tree skips gracefully.

2. **Skill prompt edits (outside this repo, in `~/.claude/skills/`):**
   - `~/.claude/skills/council-plan/SKILL.md` — Phase 0 inserted before existing Phase 1.
   - `~/.claude/skills/council-implement/SKILL.md` — same.
   - `~/.claude/skills/council-review/SKILL.md` — same, inserted before "Customising the Council".
   - The Phase 0 body cites the canonical marker names, refusal headlines, and override values verbatim — the mirror test (Task 8) locks against drift.

### Stack in use within scope
- Node/Bun standard library: `node:fs` (readFileSync, statSync, lstatSync, realpathSync, existsSync, symlinkSync, mkdtempSync, mkdirSync, rmSync, writeFileSync), `node:path` (join, resolve, sep), `node:os` (tmpdir, homedir). No new npm deps.
- Vitest 4 test framework. Standard `describe.skipIf` pattern.
- NOT touched: Hono routes, WebSocket bridge, NDJSON adapter, subprocess lifecycle, React components, Zustand store, atomic writes, recordings, persistent state, Docker, CI, husky. The feature is purely a read-side detector and a prompt-corpus edit.

### Key observations
- Sibling pattern in the repo: `web/scripts/aura-drift-check.ts` + `.test.ts` is the model that was followed (named exports, plain JSDoc-lite comments, ESM `.js` import suffix, fixtures via tmp dirs).
- EC-7 idiom (filesystem-access predicates inline path resolution OR exposed via resolving wrapper) is honored: `resolveMarker(rootResolved, relative)` is the single resolving wrapper; every marker access goes through it.
- "No silent fallback" memory rule (`feedback_no_sentinel_user_id_fallback.md`) directly drove the malformed-override and oversize-marker handling — they refuse loudly rather than degrade to a default stack.
- Carmack-economic dispatch from the plan: 5-of-10 experts dispatched at plan time (Security, Refactoring, FS, UX, a11y/Test); the others were explicitly skipped because their domains had no scope. Same applies here at review time.
- Two commits land this work: aura-side `53c5feb feat(router): A/B v2 router implementation` (3 TS files, 979 lines including tests), and skills-repo `a593c16 feat(router): Phase 0 stack detection on 3 suffixless skills` (3 SKILL.md, 192 lines).

### Automated check results
- **Typecheck:** PASS (`bun run typecheck` → `tsc --noEmit` clean across full repo).
- **Test suite:** PASS — 245 files, 6346 tests, 4 skipped, 0 failures. The new files contribute 39 tests (24 detector + 15 mirror).
- **a11y:** No DOM surface added; existing axe assertions on other components unaffected.

### Plan Acceptance Criteria (verbatim from spec, for AC binding)
- AC-1.1..1.4: Aura detection via 3 markers + ambiguity refusal.
- AC-2.1..2.3: Python detection via 2 markers + no-prompt success.
- AC-3.1..3.3: Refusal names markers checked + filenames found; plain English; never silent fallback.
- AC-4.1..4.3: `-aura` skills untouched as first-class entries.
- AC-5.1: Variant dispatch produces same output paths (no router-introduced wrapper dirs).

### Domain File Assignments

**Hunt (Security):**
- `web/scripts/detect-stack.ts` — realpath/lstat boundary, content-leak surface in refusal, JSON parse failure semantics, override allow-list

**Fowler (Refactoring):**
- `web/scripts/detect-stack.ts` — single-source-of-truth design, exported constants, function decomposition
- `web/scripts/detect-stack.skill-mirror.test.ts` — drift-canary discipline
- `~/.claude/skills/council-plan/SKILL.md` Phase 0 block (3 mirror copies in scope)
- `~/.claude/skills/council-implement/SKILL.md` Phase 0 block
- `~/.claude/skills/council-review/SKILL.md` Phase 0 block

**ritchie (Unix-discipline §B persistence — read-side):**
- `web/scripts/detect-stack.ts` — §B path validation, BOM/CRLF/encoding, size cap, symlink rejection
- `web/scripts/detect-stack.test.ts` — fixture portability, mkdtemp pattern, cleanup

**Beck (Test Quality):**
- `web/scripts/detect-stack.test.ts` — 24 tests; AC binding, fixture isolation, assertion strength
- `web/scripts/detect-stack.skill-mirror.test.ts` — 15 tests; drift canary, skipIf gate

**Friedman (UX Quality):**
- `web/scripts/detect-stack.ts` — `renderRefusal` + `REFUSAL_HEADLINES` + `OVERRIDE_FOOTER`
- 3 SKILL.md Phase 0 refusal templates

Skipped experts (no domain in scope):
- **dahl** — no Hono route / NDJSON / WS handler added
- **abramov / saarinen / watson** — no DOM / visual / a11y surface
- **willison** — no LLM-content rendering
- **hashimoto** — no Docker / GHA / CI changes
- **ritchie §A** — no subprocess / spawn / signal surface
