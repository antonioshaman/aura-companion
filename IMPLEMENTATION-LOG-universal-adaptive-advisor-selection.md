# Council Implementation Log (Aura): Universal Adaptive Advisor Selection (RC-2)

**Plan:** `PLAN-aura-universal-adaptive-advisor-selection.md`
**Tasks:** 12 total. Status tracked below; resume from the last `✅ COMPLETED`.
**Conventions respected:** catalog-as-shared-cross-project-source (README); ritchie B8 (schema_version + fail-loud load); hashimoto P6 (mechanically checkable gate); "no silent fallback" (detect-stack.ts file ethos).

> **Resume marker:** ALL 12 TASKS COMPLETE. Engine core (T1–T8, T11) + selection-engine.md (T9 linchpin) done earlier; the T9+T10+T12 coordinated migration (6 SKILL.md rewired to the engine, panels/router/counts removed, `detect-stack.ts` retired, canaries C2/C6/C13 + C11 call-site rewritten to the capability model, re-lock) landed together. `bun run typecheck` clean; full `bun run test` green (with the `AURA_*_TIMEOUT_MS` env vars unset — they pollute 7 claude-adapter timeout-default tests in this shell); `verify-catalog.sh` → RESULT: PASS. Only open item: the meta.yaml-in-lock decision (see Task 12).

---

## Task Log

### Task 1: Closed capability vocabulary — single source of truth ✅ COMPLETED

**Domain:** ritchie/dahl/hunt/hashimoto × Carmack — Single source of truth
**Ref applied:** ritchie B8 (`schema_version`, closed set validated at boundary); hashimoto P6 (mechanically checkable).

**Files changed:**
- `~/.claude/skills/_council-experts/.verify/capability-vocabulary.json` (NEW) — the canonical closed vocabulary: `signals` (56 stack-fingerprint tokens grouped by dimension + reserved `any`) and `domains` (18 expertise lanes). Single source both the TS scorer and the catalog verifier read.

**Decision (for review):** canonical home is the **catalog `.verify/`**, not the repo. Rationale: the catalog is the shared cross-project source of truth (per README) and the scorer already reaches into the catalog tree at runtime to load `meta.yaml` (ritchie B-7 catalog trust-root); repo Vitest tests will use in-repo fixture catalogs (dahl #9) carrying their own fixture vocab, so tests don't couple to the live `~/.claude` path. `_doc` field documents intent (JSON has no comments).

**Verification:** ✅ JSON parses; ✅ no duplicate signal tokens across groups; ✅ no duplicate domains; ✅ all tokens lowercase (56 signals / 18 domains). Wiring-level verification (scorer consumes it, verifier enforces it) deferred to Task 5 / Task 10 by design — the file is inert until then.
**Notes:** Inert-until-wired ⇒ safe against a mid-build cutoff.

---

### Task 2: `meta.yaml` capability schema + versioned catalog migration ✅ COMPLETED

**Domain:** hashimoto/ritchie × Carmack — Config-as-code, idempotent, no half-migration
**Ref applied:** ritchie B8 (`schema_version` distinguishes v1-no-caps from v2-migrated); hashimoto D5 (single idempotent backfill script + fail-loud completeness).

**Files changed:**
- `~/.claude/skills/_council-experts/.verify/backfill-capabilities.py` (NEW) — idempotent backfill: validates every token ⊆ vocabulary (fail-loud abort before any write), appends `schema_version: 2` + `capabilities: {signals, domains}` to each seated advisor's meta.yaml only if absent, preserves existing content verbatim (raw append, clean diff).
- 14 seated advisor `meta.yaml` (MODIFIED): `hunt fowler saarinen friedman willison hashimoto beck dahl ritchie abramov watson durov vanrossum brandur` — each gained `schema_version: 2` + capability profile.

**Decision (for review):** only the **14 seated** advisors migrated (not all ~23 with meta.yaml). Rationale + observer NOTE: the gate keys on the seated set; the 8 unseated-but-present dirs (`evans hickey majors sridharan torvalds unclebob lerdorf colvin`) stay v1/no-caps = correctly "never seated" until promoted; the 3 with no meta.yaml (`firestore-doc backend-python-ptb deploy-copilot`) remain recorded in `unseated.allow`. So "~22-file migration" is really "14 seated files"; denominator is the seated set, not a file count.

**Verification:** ✅ backfill run (14 migrated); ✅ re-run idempotent (0 changed, 14 skipped); ✅ existing fields preserved (vanrossum `paired_with`/`tension_axis`, hunt `unpaired_reason`); ✅ all 14 parse via `yaml.safe_load`, `schema_version==2`, non-empty caps, tokens ⊆ vocabulary.
**Notes:** `yaml` module IS available in the host python3 — the Task 10 verifier can rely on it. vanrossum declares both `aiogram` AND `fastapi/starlette` signals: on the snowlevel (FastAPI) fingerprint it seats via `fastapi`, and Task 7's stack-accurate briefing must ensure its brief is FastAPI-not-aiogram (the 0-aiogram success metric).

---

### Task 3: Fingerprinter — `detectStack` → structured `Fingerprint` ✅ COMPLETED

**Domain:** dahl/ritchie/hunt × Carmack — Parse-don't-validate; deterministic read discipline; branch-by-abstraction
**Ref applied:** dahl A8 (type-as-armour, exhaustive union, `catch(unknown)`), A9 (sync `node:fs`, no Bun.file mixing), #3 (declarative signal table); ritchie B-1 (single EC-7 wrapper), B-4 (sort-before-cap), B-9 (`..`-segment), B-6 (deterministic set-union merge); hunt #2 (literal-token match, no ReDoS).

**Files changed:**
- `web/scripts/marker-fs.ts` (NEW) — shared EC-7 primitives extracted from detect-stack.ts (`resolveMarker`/`readText`/`isDirectory`/`enumerateCandidatePrefixes`/`resolveRoot`) WITH the ritchie B-4 (sort-before-cap) + B-9 (`..`-segment reject) fixes folded in.
- `web/scripts/fingerprint.ts` (NEW) — `detectFingerprint(root) → Fingerprint`: structured `{signals, byDimension, provenance, scanTruncated, failures}`; declarative JS/PY/infra/ws-bridge signal table; `needs-confirmation` on empty; per-surface provenance; deterministic dedup+sort merge; every failure surfaced (no silent absence).
- `web/scripts/fingerprint.test.ts` (NEW) — 6 tests: aura back-compat (hono+ws surfaces+ts+bun), aiogram back-compat, snowlevel monorepo merge (fastapi+react+ptb, **asserts zero aiogram**), determinism (two runs byte-identical), needs-confirmation ×2.

**Decision (for review — branch-by-abstraction):** implemented ADDITIVELY as new modules; `detect-stack.ts` (the old verdict-router) is left UNTOUCHED and still compiling/passing so a mid-build cutoff can't leave a broken detector. The switchover + deletion of the old path + dedup of the temporarily-duplicated primitives happens in **Task 9** (collapse). This is Fowler parallel-change, and matches dahl #1 (fingerprint and scorer are separate functions/modules).

**Verification:** ✅ `bun run typecheck` (tsc --noEmit clean); ✅ 6/6 fingerprint tests pass; ✅ old detect-stack.ts untouched → its suite unaffected (full-suite confirm below).
**Notes:** snowlevel modelled with `python-telegram-bot` (not aiogram) + async FastAPI so the fingerprint is legitimately aiogram-free; the "0 aiogram in the plan" metric is enforced downstream at Task 7 (stack-accurate briefing) + Task 11 (golden fixture).

---

### Task 4: Capability loader + validator (catalog = 2nd trust root) ✅ COMPLETED

**Domain:** dahl/ritchie/hunt × Carmack — Validate at the boundary, fail closed
**Ref applied:** dahl #5 (use existing `yaml` dep, synchronous), #6 (validator per category); ritchie B-3 (absent≠malformed distinction), B-7 (catalog second trust-root path discipline), B-8 (YAML coercion guard).

**Files changed:**
- `web/scripts/capability-catalog.ts` (NEW) — `loadVocabulary` / `loadAdvisorProfile` / `loadCatalog`. Catalog-root-anchored realpath/bounds/symlink discipline (distinct from marker-fs's workspace root); `ADVISOR_ID_RE` slug canary; partitions into `profiles` (seatable) / `skipped` (absent-caps or no-meta = deliberate, not error) / `errors` (malformed / unknown-token / traversal = LOUD). Uses `yaml` `parse`, synchronous.
- `web/scripts/capability-catalog.test.ts` (NEW) — 7 tests: valid load+lowercase, partition (absent≠error), unknown-token→loud, numeric YAML-coercion→malformed, bare-word `no` stays loud, empty-list→malformed.

**Verification:** ✅ typecheck; ✅ 7/7 tests; ✅ **integration against the LIVE migrated catalog**: 14 seated profiles load, **0 errors**, 11 unseated partition correctly (3 no-meta + 8 absent-capabilities). Ties Task 1+2+4 end-to-end.
**Notes (for review):** discovered `yaml` v2 uses YAML 1.2 core schema → `no`/`yes`/`on` stay strings (NOT booleans as in 1.1); only numeric bare scalars coerce. The coercion guard rejects non-string members regardless, so both paths stay loud — but the ritchie B-8 risk is narrower than stated (numeric-only under this parser).

---

### Task 5: Deterministic scorer + guardrails + dedup/lane-split ✅ COMPLETED

**Domain:** dahl/hunt/hashimoto × Carmack — Determinism + economy (no scoring DSL)
**Ref applied:** dahl #7 (total deterministic tie-break, integer scores), #8 (dedup/lane-split pure pass); hunt #4 (cross-stack floor + crowded-out visibility); Fowler R7 (fixed boring weights, no DSL).

**Files changed:**
- `web/scripts/advisor-scorer.ts` (NEW) — `scoreAdvisors` (weighted-sum W_SIGNAL=2/W_DOMAIN=3, `any`→CROSS_STACK_BASELINE, score≤0 excluded), `dedupRedundant`, `applyGuardrails` (MIN_SEATS=3/MAX_SEATS=11 named constants), `composeCouncil` (score→dedup→guardrail, returns `seated`+`crowdedOut`+`belowMin`+`cappedAtMax`). Total tie-break: score desc, advisorId asc.
- `web/scripts/advisor-scorer.test.ts` (NEW) — 10 tests: ranking, no-overlap-excluded, cross-stack floor, dedup vs lane-split, broad→cap@11, narrow→small, crowded-out visibility, determinism/total-order.

**Verification:** ✅ typecheck; ✅ 10/10 tests; ✅ **full-pipeline integration on the LIVE catalog** — snowlevel fingerprint → 11-seat roster: brandur(postgres/alembic), abramov(react), **vanrossum via `fastapi` NOT `aiogram`**, durov(telegram), hashimoto(docker/gha), dahl top. Confirms the 0-aiogram intent at the selection layer.
**Watchpoint addressed (hunt #4):** on a maximally-broad (all-18-domains) request, `hunt`(security, score 4) was crowded out below the 11-cap — so `composeCouncil` now returns `crowdedOut` (ranked, score>0, visible) so the Chair/UI surfaces the exclusion for veto/add rather than silently starving the security lens. Full "always structurally seatable" enforcement is a Chair/UX concern (Task 6/8).

---

### Task 6: Chair fail-closed roster validator ✅ COMPLETED (TS); prose → Task 9

**Files:** `web/scripts/roster-validation.ts` + `.test.ts` (7 tests). `validateChosenRoster` fails closed (off-pool / duplicate / below-min / above-max / empty) to the deterministic guardrail top-N. Chair-contract PROSE deferred to `selection-engine.md` (Task 9) so it isn't written into soon-deleted per-skill copies.
**Verification:** ✅ typecheck, ✅ 7/7.

### Task 7: Stack-accurate brief + contradiction flag ✅ COMPLETED (TS); prose → Task 9

**Files:** `web/scripts/advisor-brief.ts` + `.test.ts` (4 tests); extended `capability-catalog.Vocabulary` with a `frameworks` set. Brief names matchedSignals only (kills aiogram-on-fastapi); computed MISMATCH flag when a framework specialist is seated with no matching framework.
**Verification:** ✅ typecheck, ✅ 4/4 (+catalog 7/7 still green).

### Task 8: CLI-flow renderers ✅ COMPLETED (TS); wiring → Task 9

**Files:** `web/scripts/roster-render.ts` + `.test.ts` (4 tests). `renderRosterPreview` (scannable ledger, WHY per seat, crowded-out add-hint) + `renderConfirmStackPrompt` (recoverable, structured choices).
**Verification:** ✅ typecheck, ✅ 4/4.

### Task 5 amendment (variant B) + Task 11 golden ✅ COMPLETED

- `advisor-scorer.ts composeCouncil`: added variant-B domain-gated cross-stack guarantee (`isGuaranteed`) — closes AC1.4/hunt #4. Scorer tests still 10/10.
- `web/scripts/back-compat.golden.test.ts` (NEW, 3 tests): AC1.4 superset for Aura-10 + Python-9 (stack-appropriate domains), snowlevel 0-aiogram brief metric. All green.

### Task 9: Collapse skills → one engine — ✅ COMPLETED

- ✅ `_council-experts/selection-engine.md` (NEW, attested in the lock) — the single shared engine doc (Phase 0 fingerprint → score → arbitrate fail-closed → brief; confirm-stack; `-aura` alias rule). Houses all the Chair/brief/UX prose (Tasks 6/7/8 prose live here, once).
- ✅ All 6 SKILL.md wired to `selection-engine.md`: the fixed `**Panel:**` bullet lists are gone (→ "Council roster (engine-selected, catalog-resolved)"); the suffixless `## Phase 0: Stack Detection` 2-stack router + refusal templates are replaced by "## Phase 0: Advisor Selection" delegating to the engine (no refusal path — confirm-stack instead). Substitution + pre-dispatch-assertion mechanics kept, retargeted to the SELECTED roster. `-aura` variants carry an explicit "thin variant — no independent selection logic" note. Fixed count claims ("9-expert panel", "spawn all nine", the hardcoded 10-output-file pre-synthesis list) reworded to the adaptive roster.
- ✅ `detect-stack.ts` (verdict-router) + `detect-stack.test.ts` DELETED (retired; nothing but the two test files imported it — verified). `detect-stack.skill-mirror.test.ts` REWRITTEN from the retired marker/headline drift-canary into the **structural contract**: no dispatcher embeds a panel/marker/refusal block, all 6 delegate to `selection-engine.md`, checkpoint step parity preserved. `build-council-skill-fixture.ts` rewritten to freeze WHOLE SKILL.md bodies (fail-loud if a body still carries a forbidden block or lacks the delegation tokens); fixture regenerated.

### Task 10: Verifier evolution — ✅ COMPLETED

- ✅ `.verify/c15-capabilities.py` (NEW) + wired into `verify-catalog.sh` — validates the vocabulary + every capability profile (fail-loud, closed vocab, zero-dangling).
- ✅ `.verify/c2-capability-universe.py` (NEW, replaces inline C2+C2b): candidate universe = catalog dirs with a `capabilities` mapping; universe non-empty + every member has a phase doc; orphan sweep against `unseated.allow` (no orphan / stale / contradictory). `c6-panel-count.py` REWRITTEN: forbids any fixed panel-size claim across all 6 dispatchers (roster is adaptive). `c13-implement-parity.py` REWRITTEN: required seats derived from the capability universe filtered by the paired plan-phase doc (`plan.md` / `plan-aura.md`), not a bullet list.
- ✅ **Discovered coupling not in the handoff:** `cp-mirrors.py` (C11) had a 4th ID-regex call-site that parsed the `### Council panel` block. Repointed to the implement skills' reference-table `Seat` column — the surviving production site where an expert ID enters a SKILL.md.
- ✅ **Full catalog verifier PASS** (all canaries green incl. C2/C6/C11/C13/C15).

### Task 12: Re-lock — ✅ COMPLETED

- ✅ `verify-lock.py --update-attested` re-run after the 6 SKILL.md edits → C12 green (120 standalone files re-attested). `selection-engine.md` remains attested.
- **Decision (2026-09-20, developer-confirmed): `meta.yaml` is NOT added to the attested lock.** Now that `capabilities` is selection-determining, C12 does not pin the profiles' sha256 — so in principle an attacker editing a `meta.yaml` capabilities block could re-weight the council without a lock diff. Rationale for declining to attest: (1) single-user box → low exploitation likelihood; (2) C15 already validates every profile structurally against the closed vocabulary (unknown/malformed token → CI red), so accidental corruption is caught; (3) attesting `meta.yaml` would impose a re-lock step on every legitimate future capability edit — friction not justified by the residual risk here. Recorded as a deliberate decision (not a silent gap); hashimoto D6 flagged it. Revisit if the catalog becomes multi-writer / shared beyond this operator.

---

## COUNCIL-REVIEW-AURA + AUTO-FIX (2026-09-20) — all 19 findings resolved

Ran `/council-review-aura` on the full RC-2 work (7 experts: hunt/fowler/dahl/ritchie/
willison/beck/hashimoto; UI/UX/a11y/DB/telegram correctly NOT seated — dogfood of the
adaptive selection). Review artifacts (gitignored): `.council/review-output/2026-09-20-0314/`.
Verdict: engine structurally sound; 3 P1 / 9 P2 / 7 P3. All fixed + committed + pushed
(aura branch `feat/rc2-universal-adaptive-advisor-selection`; catalog repo `master`).

| Finding | Fix commit(s) |
|---|---|
| P1-1 Variant-B floor not enforced on arbitration/fallback + dedup collision (willison/dahl/hunt convergent) | aura `e9c4cc2` |
| P1-2 symlinked advisor dir silently deseated (ritchie) | aura `4a229a4` |
| P1-3 verifier had no CI backstop (hashimoto) | catalog `81c4ced` (GH Actions) |
| P2-4 localeCompare nondeterminism | aura `e9c4cc2`,`4a229a4` |
| P2-5 duplicated trust-root escape-guard + loadVocabulary gap | aura `1aae375` |
| P2-6 prose↔TS weight/guardrail divergence | catalog `d6d331a`, aura `c61ec82` |
| P2-7 one-directional vocab closure + MISMATCH no-op | aura `ee61bb9`,`461eb86`; catalog `e36a130` |
| P2-8 failures[] dead-end + silent symlinked subdir | aura `afc6dc1` |
| P2-9 C6 false-neg/false-pos + selftest | catalog `e36a130` |
| P2-10 mirror test stale-blocklist + circular; shared contract module | aura `3ecbe6e` |
| P2-11 marker-fs/guarantee/belowMin/fail-loud untested | aura `e9c4cc2`,`4a229a4`,`1aae375` |
| P2-12 golden baseline hand-transcribed | aura `495c4d9` (freshness canary) |
| P3-13..19 null-caps / total-sort / rename / vocab-diag / scanTruncated / WHY-prose / exit-preflight | across the above + `c61ec82`,`74440c8`,`461eb86` |

Post-fix verification: `bun run typecheck` clean; scripts suite 86 tests (was 77);
catalog `verify-catalog.sh` RESULT: PASS (incl. new C6 self-test). Phase 5.5 gate: the
2 self-introduced P1s were pre-authorised fix-now by the developer and are fixed.
Fallback cron (5h-limit safety net) was armed then expired with a session boundary; not
needed — the auto-fix completed in-session.

## SESSION SUMMARY (as of this checkpoint)

**Complete + fully tested (repo-side TS engine, the load-bearing spine):** T1 vocabulary, T2
catalog migration (14 profiles, idempotent backfill), T3 fingerprinter, T4 loader/validator,
T5 scorer (+variant-B guarantee), T6 fail-closed roster validator, T7 stack-accurate briefs,
T8 CLI renderers, T11 golden back-compat + snowlevel-0-aiogram. **~55 tests across 8 new test
files, typecheck clean.** Integration-verified end-to-end on the LIVE catalog.

**Infra done:** selection-engine.md (T9 linchpin), C15 capability gate (catalog verifier PASS),
partial re-lock (C12 green).

**Remaining for a focused follow-up:** the 6-SKILL.md prose wiring (T9) + mirror-test rewrite
(T10) + final re-lock (T12). These make the skills *invoke* the engine (AC5.1/5.2); the engine
+ its guarantees + its gates are already built and proven.

### ⚠️ EMPIRICAL COUPLING FINDING (raises T9/T10/T12 scope)

Attempted the T9 skill-panel edit on `council-plan-aura/SKILL.md` (replace the fixed
`### Council panel` bullet list with an adaptive-engine reference). It broke the catalog
verifier immediately: **C2 / C6 / C13 parse the panel as a bullet list of expert IDs**
("extracted 0 expert IDs … the panel block moved or reformatted"), and **C12** flagged the
SKILL.md hash drift (SKILL.md files ARE in the attested surface). Reverted → verifier PASS.

**Conclusion:** removing the fixed panels is NOT a per-file prose edit — it is a COORDINATED
migration of {6 SKILL.md} + {C2/C6/C13 rewritten to the dynamic "candidate universe = dirs
with valid capabilities" model, exactly C15's basis} + {C12 re-lock of all 6 SKILL.md}, landed
together or the verifier is red the whole way. This is the real shape of T9+T10+T12 and is the
focused follow-up. The engine (T1–T8, T11) + C15 gate + selection-engine.md are done and green
and do not depend on it.

---

## ✅ RESOLVED DESIGN FINDING (was blocking AC1.4) — variant B applied

**Decision: variant B (domain-gated cross-stack guarantee).** `composeCouncil` now seats
any `any`-lens whose matchedDomains is non-empty BEFORE filling the rest by rank up to the
cap. Result: on the real aura repo `hunt` + `willison` are seated again (hunt #4 closed).

**Residual + resolution:** under an artificial ALL-18-domains request, `friedman` (UX, not
cross-stack, score 5) is still crowded out by db/telegram advisors (`brandur` via a stray
`drizzle` subdir dep, `durov` via chat-platform-ux) — because requesting database+telegram
expertise for a repo with neither is NOT the back-compat scenario. Under a **stack-appropriate
domain set** (the domains the stack's surfaces actually imply: aura = no database/migrations/
chat-platform-ux), the superset HOLDS exactly: all Aura-10 seated, durov/vanrossum/brandur
correctly crowded out. So the T11 golden regression check validates each stack against its
stack-appropriate broad domain set, and this is documented for council-review to adjudicate
whether "friedman on every aura feature regardless of scope" is a real requirement (the
adaptive engine deprioritising UX on a backend-only checkpoint is arguably an improvement).

---

## (historical) OPEN DESIGN FINDING (blocks AC1.4) — needs a guardrail decision

**Integration test (real aura repo + all-domains) shows the back-compat superset FAILS:**
Aura-10 members `hunt` (security) and `willison` (llm) are crowded out below the max-11 cap.
Root cause = a cross-stack `any` lens scores only `1 (baseline) + 3 (its one domain) = 4`,
which loses the cap to stack-signal matchers (dahl 19, abramov 11, hashimoto 10, ritchie/
brandur 8, fowler/saarinen/watson 7, durov 6, friedman 5). This is exactly hunt #4 (security
starved) and it violates spec AC1.4 (two current stacks must seat ⊇ today's panels) +
Success-Metric "same-or-superset."

**Secondary noise:** a depth-1 subdir (NOT `web/`) carries `drizzle-orm`, so `drizzle` enters
the aura fingerprint and seats `brandur`. Minor; provenance-scoping can address it.

**Proposed fix (needs user call — touches "⚠️ Ask first: guardrails"):** guarantee an
`any`-lens is SEATED (not merely a candidate) whenever its domain intersects the feature-
domains — the universal lenses (security/refactor/llm/test) were in EVERY old panel, so this
restores the superset while preserving adaptivity for stack-specific seats. Alternatives: (A)
always-seat all `any` lenses, (B) domain-gated guarantee [recommended], (C) raise max for
known stacks. Task 5 `composeCouncil` + Task 11 golden test depend on this decision.
