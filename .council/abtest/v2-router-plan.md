# Council Plan: Auto-stack-detection router for council slash commands

**Scope:** Add a Phase 0 stack-detection preamble to the three suffixless council slash commands (`/council-plan`, `/council-implement`, `/council-review`) so they dispatch the correct stack-specific variant (Aura/Bun vs Python/aiogram) without the user remembering which suffix to type. Refuse loudly on ambiguous or unknown stacks. The three `-aura` suffixed entries stay unchanged as explicit overrides.

**Context:** The user maintains six parallel skills on disk — three suffixless (Python-stack) and three `-aura`-suffixed (Aura-stack). Cross-stack invocation seats the wrong council. This feature converts the three suffixless skills into stack-detecting routers. Detection runs filesystem-only against workspace markers; the `-aura` skills are untouched.

**Boundaries:**
- No new stacks beyond Aura+Python (separate spec).
- No edits to `-aura` SKILL.md files.
- No network calls, no `gh repo view`, no detection caching.
- No new runtime persistence; no new HTTP route; no new WebSocket message; no subprocess spawn.

**Council dispatched (5 of 10):** Security expert, Refactoring expert, FS/Persistence expert, UX expert, a11y/Test-quality expert. Skipped (with AC-bound rationale): Backend expert (no Hono/NDJSON surface), Frontend expert (no React/component surface), UI expert (no visual UI surface), LLM expert (no LLM-content rendering), DevOps expert (no Docker/CI changes — gates still run on existing `bun run typecheck && bun run test`).

---

## Task Sequence

### 1. Define canonical detection contract in TS — `web/scripts/detect-stack.ts`

| | |
|---|---|
| **Domain** | Refactoring expert × Carmack — Principle: economic refactoring, single-source-of-truth |
| **Ref** | Principle: §A economic refactoring + §C Shotgun Surgery prevention |
| **Depends on** | — |

Implement `detectStack(workspaceRoot: string): DetectionResult` as the canonical rules artifact. The detector returns a discriminated union `{kind: "aura"|"python"|"ambiguous"|"unknown", checked: MarkerCheck[], overrideUsed: boolean, overridePath: string | null}` where each `MarkerCheck` is a structured descriptor `{name, path, present, parsed, matched: string[]}`. Marker names are drawn from a closed allow-list (`web/package.json:name`, `web/package.json:dependencies.hono`, `web/server/ws-bridge.ts`, `pyproject.toml:aiogram`, `requirements.txt:aiogram + bot/`). Export both the function and a `REFUSAL_TEMPLATE` constant; this constant is the single source for the refusal English that the three SKILL.md mirror blocks reference.

---

### 2. Path-resolution boundary inside `detectStack` (EC-7 wrapper)

| | |
|---|---|
| **Domain** | Security expert × Carmack — Principle: attack-surface reduction, zero trust |
| **Ref** | Principle: §A — secure defaults; cross-ref EC-7 from conventions.md |
| **Depends on** | Task 1 |

At function entry, `realpathSync` the incoming `workspaceRoot` once and treat it as the canonical bounds prefix. For each marker file/directory, `path.join(rootResolved, relativeMarker)`, re-resolve via realpath, and assert `resolvedMarker.startsWith(rootResolved + path.sep)`. Additionally `lstat` each file leaf and refuse to follow `isSymbolicLink()` — the contract is "is this a repo-authored marker," not "does this name shape happen to resolve to one." Realpath failures (ENOENT/EACCES/ELOOP) on the root itself become a structured error result, not an exception. Cross-ref FS/Persistence expert REC B-R1 — same idiom, FS-discipline framing.

---

### 3. Defensive marker reads — size cap, BOM strip, encoding, parse-failure handling

| | |
|---|---|
| **Domain** | Security expert × FS/Persistence expert × Carmack — Principle: fail-closed; line-discipline at read boundary |
| **Ref** | Principle: §A secure defaults + §B B4 (line/encoding hygiene at read), B9 (FS-portability) |
| **Depends on** | Task 2 |

Each marker read uses `readFileSync(path, "utf8")` (explicit encoding, never raw `Buffer`), strips a leading BOM (`U+FEFF`), and is gated by a prior `statSync` size cap (16KB for `package.json`, 64KB for `pyproject.toml` and `requirements.txt`, 1KB for `.council-stack-override`). `JSON.parse` failures on `package.json` are caught and recorded as `{present: true, parsed: false, reason: "json_parse"}` — never silently treated as "absent" (which would falsely satisfy Python-side rules) and never crash the detector. The substring scan for `aiogram` uses `/^aiogram\b/m` which is CRLF-tolerant; a CRLF fixture must lock this. Size-exceeded reads downgrade the marker to `parsed: false, reason: "size_exceeded"` and the overall result tilts toward `ambiguous`/`unknown` per AC-3.3 (fail closed, never fall through).

---

### 4. `.council-stack-override` precedence with strict allow-list

| | |
|---|---|
| **Domain** | Security expert × FS/Persistence expert × Carmack — Principle: explicit override visibility, defensive parsing |
| **Ref** | Principle: §A zero trust + §B B8 (validate at load boundary), B3 (idempotent read) |
| **Depends on** | Task 3 |

If `.council-stack-override` is present, read with the same defensive discipline (encoding + BOM + size cap + trim), then validate against the closed allow-list `Set(["aura", "python"])`. Empty/whitespace-only → record as malformed override, **never** silently force a default. Unknown value (`Aurra`, `both`, etc.) → loud refusal naming the bad value. Override-success result MUST carry `overrideUsed: true, overridePath: <absolute path>` so callers can surface the fact that auto-detection was bypassed — silent override-success is a form of silent fallback against AC-3.3's spirit. Override takes precedence over auto-detection markers but does NOT silence the marker enumeration in the `checked` list (so a user still sees what would have been detected).

---

### 5. Refusal template — structured fields, plain-English shell

| | |
|---|---|
| **Domain** | UX expert × Security expert × Carmack — Principle: scanability, fail-closed sink hardening |
| **Ref** | Principle: §A scanability + §B form usability + §A secret leakage (sink-side default) |
| **Depends on** | Task 1, Task 3 |

The `REFUSAL_TEMPLATE` exported from `detect-stack.ts` produces three distinct refusal copies — one per failure class (unknown / ambiguous / parse-error) — each with the structure: declarative headline (1 line) → blank → `Checked for:` labelled list of marker NAMES (3–6 lines) → blank → `Found at workspace root:` list of actual filenames present (1–4 lines) → blank → `To override, run:` code-fenced list of the two suffix commands (3 lines). Hard ceiling: 15 lines total. The "found" list NEVER echoes raw file content (only filename + parse-status annotation per Security expert REC-H3). The "checked" list uses internal marker NAMES drawn from the closed allow-list. Tone: declarative noun phrases, no first-person, no apology, no hedge, no question-back-to-user. Cross-ref a11y/Test-quality expert REC 1 — terminal screen-reader linearisation: one fact per line, no ASCII-art boxes, code-fenced commands one-per-line.

---

### 6. Phase 0 preamble — mirror into three SKILL.md files

| | |
|---|---|
| **Domain** | Refactoring expert × Carmack — Principle: divergent-change prevention via canonical-source mirroring |
| **Ref** | Principle: §C Divergent Change prevention |
| **Depends on** | Task 5 |

Add a "Phase 0: Stack Detection" section to the top of each suffixless SKILL.md (`council-plan`, `council-implement`, `council-review`). The Phase 0 body is content-identical across all three files except for the dispatch-target sentence (which names the variant the skill is part of). The body cites the SAME marker name list and the SAME refusal-template structure that `detect-stack.ts` exports — these are the mirror surface that a snapshot test (Task 8) locks against drift. Phase 0 runs BEFORE the existing Phase 1 (Context Gathering) of each skill. Do NOT extract Phase 0 to a shared markdown file loaded at skill runtime — Refactoring expert REC 2 explicitly rules this against; runtime transclusion adds a path-resolution boundary (EC-7 surface) to three prompt files that previously had none, paying real complexity tax to defer manageable duplication.

---

### 7. Fixture corpus under `web/scripts/__fixtures__/detect-stack/`

| | |
|---|---|
| **Domain** | a11y/Test-quality expert × FS/Persistence expert × Carmack — Principle: tests verify body not just name; cross-platform discipline |
| **Ref** | Principle: a11y §1 + §B B9 (FS-portability) |
| **Depends on** | Task 3 |

Fixture directories committed under `web/scripts/__fixtures__/detect-stack/`. Required cases: pure Aura (each of the 3 markers in isolation × one combined), pure Python (each of the 2 markers in isolation × one combined), ambiguous (Aura + Python markers present), unknown (empty dir, near-miss `package.json` without name or hono), parse-error (malformed `package.json`), CRLF `requirements.txt` containing `aiogram`, BOM-prefixed `pyproject.toml` containing `aiogram`, oversize `package.json`, symlinked `package.json` (created at test setup time to keep git-tracking sane), override file (`.council-stack-override`) with each of: `aura`, `python`, empty, whitespace-only, unknown value (`both`). Fixture-uniqueness invariant: a meta-test walks the fixture root and asserts unique-when-lowercased basenames to catch case-collision on APFS checkouts.

---

### 8. Vitest suite — fixture × enum × refusal-body assertions + EC-6 static-grep canaries

| | |
|---|---|
| **Domain** | a11y/Test-quality expert × Refactoring expert × Carmack — Principle: test bodies, not names; snapshot-lock the drift surface |
| **Ref** | Principle: a11y §1 (test discipline lane) + Refactoring §C |
| **Depends on** | Task 6, Task 7 |

Two test files. `detect-stack.test.ts` exercises each fixture, asserts the full `DetectionResult` shape (kind + checked entries + overrideUsed), and snapshot-asserts the `REFUSAL_TEMPLATE` rendered against each failure-class fixture — locking the AC-3.1 marker enumeration, the AC-3.2 plain-English structure, and the AC-3.3 no-silent-fallback contract. `detect-stack.skill-mirror.test.ts` reads each of the three SKILL.md files at `~/.claude/skills/{council-plan,council-implement,council-review}/SKILL.md`, asserts each contains the canonical marker names and the canonical refusal-template body verbatim, and asserts the THREE `-aura` SKILL.md files do NOT contain a Phase 0 stack-detection section (AC-4.1 — first-class entry-point preservation). The mirror test is the cross-artifact drift canary identified by Refactoring expert REC 1.

---

## Risks & Watchpoints

- **Security expert — REC-H3:** Refusal must not echo raw file content; only filename + parse-status. Watch the AC-3.1 "what was found" wording during implementation — natural phrasing tempts toward "found `name: "secret-token"` in package.json" which is exactly the sink-leak path.
- **FS/Persistence expert — B-R3:** Fixture filenames must be unique when lowercased to survive macOS APFS checkouts. The meta-test in Task 8 enforces this but reviewers should grep for case-only differences during PR review.
- **UX expert — REC 5 tone:** First-person pronouns, apologies, and conversational hedges are forbidden in refusal copy. The snapshot test in Task 8 locks the literal wording — drift toward chatty refusal is a visible diff during code review.
- **a11y/Test-quality expert — REC 1:** Terminal screen-reader linearisation rules out ASCII-art boxes or table-aligned columns in refusal output. Pure newline-delimited text with one fact per line.
- **Refactoring expert — REC 2 (don't):** Do NOT introduce a shared `phase-0.md` file loaded at skill runtime. The duplication across 3 SKILL.md files is bounded (N=3, stable) and is correctly addressed by the canonical-source-plus-snapshot-test pattern in Task 8; runtime transclusion adds EC-7 surface to three prompt files for zero net benefit.

---

## External Setup Required

No external setup. All tasks land within this repo + the user's existing `~/.claude/skills/` directory (already on disk per Phase 1 context gathering).

---

## Summary

| # | Task | Domain | Depends on |
|---|------|--------|------------|
| 1 | Define `detect-stack.ts` contract + canonical constants | Refactoring | — |
| 2 | Path-resolution boundary (realpath + lstat + bounds) | Security | 1 |
| 3 | Defensive marker reads (size cap + BOM + encoding + parse-fail) | Security × FS | 2 |
| 4 | `.council-stack-override` precedence + allow-list | Security × FS | 3 |
| 5 | Refusal template — three failure-class copies, structured | UX × Security | 1, 3 |
| 6 | Phase 0 preamble mirrored into 3 SKILL.md files | Refactoring | 5 |
| 7 | Fixture corpus under `__fixtures__/detect-stack/` | a11y/Test × FS | 3 |
| 8 | Vitest suite + skill-mirror drift canary | a11y/Test × Refactoring | 6, 7 |

## Verdict

The most important architectural decision in this plan is **making `detect-stack.ts` the canonical rules artifact and having the three SKILL.md Phase 0 blocks be tested-mirrored copies of its exported constants** (Tasks 1, 6, 8 as a triangle). This pattern collapses a real Shotgun Surgery risk (three near-identical prompt blocks) into a single source of truth with a mechanical drift canary, paying zero runtime cost. The second-most-critical surface is the realpath + lstat boundary in `detectStack` (Task 2) — the entire feature's safety story hinges on the detector never being trickable into reading outside the declared workspace root via symlinks or `..`-laden paths.

The developer should start with Tasks 1–3 (the detector core), validate via a smoke fixture, then expand to Tasks 4–5 (override + refusal template), and only then touch the three SKILL.md files in Task 6. The skill-mirror test (Task 8) should be authored alongside Task 6 — write the assertion first, then edit the SKILL.md files until the test passes; this is the cheapest way to keep the three mirror copies byte-identical without manual diffing.

If a pair agent would be especially valuable during build, name it: the Security expert pair, watching Tasks 2–4 specifically — the realpath/lstat/bounds idiom is the load-bearing safety contract and is the easiest place to introduce a regression with a plausible-looking refactor.
