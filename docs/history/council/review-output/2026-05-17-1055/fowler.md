# Fowler — Refactoring Review (v2 router)

Scope: `web/scripts/detect-stack.ts` exported surface and decomposition; `detect-stack.skill-mirror.test.ts` canary effectiveness; Phase 0 mirror discipline across three `~/.claude/skills/*/SKILL.md` files; economic frame on the explicit plan decision to NOT extract Phase 0 to a shared runtime-loaded markdown.

Headline reading: the single-source-of-truth design holds — exported constants in `detect-stack.ts` are cited verbatim across three SKILL.md blocks and locked by a mechanical canary. The architecture is sound for the current scope. The findings below are concentrated on the *gaps in the canary* (the things that drift surface-quietly past the snapshot test), one structural smell in the refusal renderer, and one P3 cohesion observation. The plan's "do not extract Phase 0 to a runtime-loaded markdown" decision is confirmed below as economically correct at this scale.

---

### 1. Refusal-body and override-footer structure are duplicated as prose in three SKILL.md files but the canary only locks marker names and headlines
| | |
|---|---|
| **File** | `~/.claude/skills/council-plan/SKILL.md:67-87`, `~/.claude/skills/council-implement/SKILL.md:67-87`, `~/.claude/skills/council-review/SKILL.md:67-87`, `web/scripts/detect-stack.skill-mirror.test.ts:50-86` |
| **Principle** | §C Divergent Change / Shotgun Surgery — the canary covers the leaf strings but not the surrounding structural skeleton that the runtime `renderRefusal` actually emits |
**Finding:** The three SKILL.md Phase 0 blocks each carry a hand-typed copy of the full refusal body (the `Checked for:` list, the `Found at workspace root:` line, the `To override, run:` footer with two example invocations) but the cross-artefact drift canary only asserts presence of marker names, override allow-list values, and the three headline strings. A copy-edit that quietly rewords `Found at workspace root:` to `Detected at workspace root:` in one of the three SKILL.md mirrors (or in the runtime `renderRefusal` in `detect-stack.ts:533`) lands green tests and produces a router whose user-visible refusal differs depending on whether you read the prompt prose or the verifier output.
**Consequence:** The canary advertises "snapshot-lock the drift surface" but actually only locks ~30 % of it; the load-bearing structural skeleton of the refusal — the part a user actually reads — is enforced by hope, and any future copy-edit on one of the four sources will silently desync. This is Shotgun Surgery with a canary that catches three of the seven shots.
**Fix:** Extend `skill-mirror.test.ts` with three additional `toContain` assertions per SKILL.md for the load-bearing skeleton tokens: `Checked for:`, `Found at workspace root:`, `To override, run:`. Cost is six lines per skill × three skills = 18 LOC; payback is full coverage of the canary's advertised contract. Keep the snapshot-of-rendered-refusal in `detect-stack.test.ts` as the canonical lock and assert structurally-identical anchors in the mirror.

---

### 2. The override-footer in the runtime renderer is hard-coded to `/council-plan-aura` and `/council-plan-python` regardless of which skill dispatched
| | |
|---|---|
| **File** | `web/scripts/detect-stack.ts:493-497` |
| **Principle** | §C Divergent Change — single point-of-edit must scale to all callers, or each caller has to override |
**Finding:** `OVERRIDE_FOOTER` is a module-level constant naming `/council-plan-aura` and `/council-plan-python` specifically. The same `renderRefusal` is the canonical source of truth for the refusal body across three skills (`council-plan`, `council-implement`, `council-review`), yet a user invoking `/council-review` who hits an ambiguous workspace will see a footer that tells them to run `/council-plan-aura` — wrong skill family. The three SKILL.md prose bodies each correctly localise this footer to the matching skill (verified at council-plan:84-86, council-implement:84-86, council-review:84-86), but `detect-stack.ts` cannot be invoked-with-context the same way.
**Consequence:** The first user who copies a refusal from the verifier (rather than from the SKILL.md mirror prose) into the wrong skill is mis-directed. This is a hidden coupling: the "single source of truth" claim is partially false — the headlines and marker list are shared, but the call-to-action is skill-specific and the runtime renderer can only encode one.
**Fix:** Either accept `renderRefusal(result, { invocationFamily: "plan" | "implement" | "review" })` and render the footer per-family, or remove the footer from the runtime renderer entirely and let each consumer prepend its own footer — the marker enumeration and headlines stay locked, the per-skill call-to-action becomes the consumer's responsibility. Second option is YAGNI-cleanest: today there are no programmatic consumers of `renderRefusal` beyond the test, so push the footer up.

---

### 3. `probePackageJson` returns a heterogeneous batch (two `MarkerCheck` records from one read) via a closure helper — Long Function with embedded data clump
| | |
|---|---|
| **File** | `web/scripts/detect-stack.ts:183-227` |
| **Principle** | §C Long Method + Data Clump — the local `both()` factory threads five booleans plus an optional reason through every return |
**Finding:** `probePackageJson` reads one file but must produce two `MarkerCheck` records (one for `name=aura-companion`, one for `dependencies.hono`) because both markers are factored against the same JSON parse. The function couples the parse-success / parse-failure / size-exceeded / read-error branching to the two-record output via a nested `both(present, parsed, matchedName, matchedHono, reason?)` factory whose argument list is itself a data clump. Eight call sites each repeat a different boolean tuple; the reader has to mentally evaluate which tuple corresponds to which failure class.
**Consequence:** This is the function most likely to be edited when the Aura marker set grows (e.g. adding `dependencies.zod` or `engines.bun`). Each new marker adds another boolean to the clump and another `both()` call-site permutation. By the third Aura marker the factory becomes harder to read than three explicit returns.
**Fix:** Extract a `parsePackageJsonOnce(rootResolved): { state: "missing" | "ok" | "error"; pkg?: object; reason?: MarkerReason }` helper, then have two trivial probe functions consume the parsed result. Each probe owns its own `MarkerCheck` shape with no shared factory. The parse happens once (memoised by passing `pkg` into both probes). Net: ~10 LOC larger, but each probe is 8 lines of straight-line code instead of one branching function with a 5-arg closure. Defer until the third Aura marker is added (YAGNI) — flag as a Long-Method-in-waiting, not a now-fix.

---

### 4. `MarkerCheck.present` semantics are overloaded — `present: true, parsed: false, reason: "read_error"` means three different things at three call sites
| | |
|---|---|
| **File** | `web/scripts/detect-stack.ts:69-83, 209, 231-240, 297-315` |
| **Principle** | §C Primitive Obsession on a boolean pair (`present`+`parsed`) carrying tri-state semantics |
**Finding:** The `MarkerCheck` shape uses two booleans (`present`, `parsed`) plus an optional `reason` to encode what is really a four-state enum: `absent` / `present-and-parsed` / `present-but-unparseable` / `unresolvable` (symlink, out-of-bounds, lstat-failed). Some probe code paths set `present: true` when the file may not actually exist on disk — they're saying "we tried, we hit a resolution error, treat it as present-with-reason" (e.g. `probeWsBridge` line 235: `present: true, parsed: false` on `resolveMarker` failure where the file may not even exist). The `dedupedMarkerList` and `renderRefusal` downstream readers then have to interpret this overloaded triple to decide what to print.
**Consequence:** A reader cannot answer "is this marker on disk?" without consulting both fields AND the reason. The four-state intent is reconstructed at every read site. The next person adding a `reason` value (e.g. `not_regular_file`) has to verify they updated every consumer's boolean-pair interpretation.
**Fix:** Replace the `present` + `parsed` + `reason?` triple with a discriminated union: `status: "absent" | "ok" | "unparseable" | "unresolvable"; reason?: MarkerReason`. `matched: string[]` stays separate. Single source of truth for marker state; render code becomes a switch. Cost is ~20 LOC of mechanical replacement and one snapshot-test update. Payback is every future reader / writer of the marker probe family.

---

### 5. Decision to NOT extract Phase 0 to a runtime-loaded shared markdown is economically correct at three callers — confirmed
| | |
|---|---|
| **File** | `~/.claude/skills/council-plan/SKILL.md:29-89`, `~/.claude/skills/council-implement/SKILL.md:29-89`, `~/.claude/skills/council-review/SKILL.md:29-89`, plan §6 (`v2-router-plan.md:87`) |
| **Principle** | §A Economic refactoring + YAGNI — three near-identical prose blocks are below the threshold where transclusion pays back |
**Finding:** Three SKILL.md Phase 0 blocks are ~60 lines each, content-identical except for the skill-family dispatch target sentence (one line out of sixty). The plan explicitly rules against extracting Phase 0 to a runtime-loaded markdown (`@-include` or equivalent) because it would add a path-resolution boundary (EC-7 surface) to three prompt files that previously had none. The economic frame: extraction would save 120 lines of prose duplication once, but adds (a) a new failure mode (file-not-found at skill load time), (b) a debugging step for anyone reading SKILL.md ("where does this `@include` resolve from?"), and (c) cross-platform path resolution semantics that prompt-loaders may not all share. At three callers and one annual edit cadence, this is below Fowler's payback-window — the canonical "three strikes" rule for extraction is not yet met because each strike here is a 1-line edit (the dispatch target), not a 60-line edit.
**Consequence:** None — this is a confirm-the-plan finding. The duplication is real but the cost of de-duplication is higher than the cost of three coordinated edits.
**Fix:** No code change. Re-evaluate IF a fourth suffixless skill is added OR if the Phase 0 body grows past ~120 lines OR if a non-trivial dispatch-class change (more than two stack families) forces synchronised edits across all three blocks. Trigger condition: the moment marker count grows past ~10 OR a fourth caller appears, extract — the canary will tell you it's drifting before then.

---

### 6. `dedupedMarkerList` always appends `.council-stack-override` even when the override file was already checked — silent semantic redundancy
| | |
|---|---|
| **File** | `web/scripts/detect-stack.ts:499-514` |
| **Principle** | §C Speculative Generality — special case in renderer hiding what should be invariant at the producer side |
**Finding:** `dedupedMarkerList` dedupes by `MarkerCheck.name`, then unconditionally appends `MARKER_NAMES.OVERRIDE` at the end if absent. The comment justifies this as "Always include the override marker in the 'Checked for' enumeration, even when its file is absent — the spec lists it as a checked marker." But the override IS always consulted via `readOverride` — the right place to enforce this invariant is the caller side: ensure `result.checked` always contains an OVERRIDE entry, then `dedupedMarkerList` doesn't need the special-case append.
**Consequence:** A future maintainer reading `dedupedMarkerList` has to know which markers are auto-appended by the renderer vs which come from the probe list. The producer/consumer contract is asymmetric — `detectStack` produces 5 entries, `dedupedMarkerList` produces 6, and the sixth materialises from the renderer's special case. Smells of Renderer Doing Producer's Work.
**Fix:** Have `detectStack` always emit an OVERRIDE `MarkerCheck` (with `present: <override consulted>`, `matched: []` always — it's a directive, not a stack signal). Then `dedupedMarkerList` collapses to plain dedup. Net 0 LOC; clarifies which module owns the "always-listed" invariant. Defer if the override surface stays at exactly one file; promote to a fix if a second directive file is added.

---

### 7. `detect-stack.ts` is a 553-line module with five public exports and seven internal helpers — at the upper edge of single-module cohesion but still coherent
| | |
|---|---|
| **File** | `web/scripts/detect-stack.ts:1-553` |
| **Principle** | §C Large Class (file) — observational, not yet a fix |
**Finding:** The file mixes five concerns: closed allow-lists (constants), path-resolution boundary (`resolveMarker`), defensive reads (`readText`, `isDirectory`), four marker probes (`probePackageJson`, `probeWsBridge`, `probePyproject`, `probeRequirementsAndBot`), the override reader, the public `detectStack` orchestrator, and the `renderRefusal` formatter. Each section is well-commented with a banner, and the call graph is shallow (orchestrator → probes → resolveMarker/readText → fs). For a single feature in active development with one consumer (the test) and a frozen export surface, this is Cohesive Module not Large Class.
**Consequence:** If the marker set doubles or refusal rendering acquires variants (per-skill footer per finding 2; per-locale strings), this module will cross the line. The three observed pressure points (finding 2 footer-localisation, finding 3 marker-set growth, finding 4 state model) all push outward.
**Fix:** No action now. If any one of findings 2/3/4 is acted on, split at the seam: `detect-stack.ts` (orchestrator + types) ↔ `detect-stack-probes.ts` (the four probe functions) ↔ `detect-stack-render.ts` (refusal formatter). The current banner-comments already mark the seams — extraction would be mechanical.

---

Findings written to `.council/review-output/2026-05-17-1055/fowler.md` — 7 findings (0 P1, 3 P2, 4 P3 — findings 1, 2, 4 are P2; findings 3, 5, 6, 7 are P3).
