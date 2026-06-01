# Fowler Review — detect-stack.ts (commit 99336b5)

Scope: `web/scripts/detect-stack.ts` (~640 lines). Lens: refactoring economics. File changes infrequently, has mirror canary discipline, and is pure. Economic bar is high — only structural issues that will cost time in the next few months.

---

## FINDING 1

- **Title:** `probeRequirementsAndBot` is two probes wearing a trench coat
- **File:** `/root/aura-companion/web/scripts/detect-stack.ts` (lines 387–446)
- **Principle:** Principle 4 — Names reveal design / Principle 2 — Long functions mixing distinct semantics
- **Severity:** P2
- **What's wrong:** The function takes `prefix: string` and forks internally on `if (prefix === "")` for the `bot/` co-requirement. The two branches do meaningfully different semantic work: root-mode has a *two-marker AND* gate (`requirements.txt + bot/`); subdir-mode has a *single-marker* gate (`<dir>/requirements.txt`). They also produce **different `path` field values** (`"requirements.txt + bot/"` vs `"<prefix>/requirements.txt"`), so even the observable shape differs by branch. The `path` field is then consumed downstream by the renderer's "Found at workspace root:" enumeration and by the `(name, path)` dedupe key. The "shared" parts (resolveMarker call, readText call, regex match) are mechanical wiring; the *decision* is forked.
- **Consequence:** The next person extending this — e.g. adding `pyproject.toml` co-requirement for subdir mode, or aligning the bot/ semantics for monorepo aiogram layouts — has to mentally simulate both branches inside one function. The compressed `present: reqPresent || (prefix === "" && botPresent)` boolean at line 421 is already the kind of expression that takes 30 seconds to parse on a second reading; one more branching dimension and it's a bug factory. The dual `path` semantics also means the dedupe at line 547 is doing real semantic work (different `path` strings = different entries) that isn't obvious from reading the call site.
- **Fix:** Split into `probeRequirementsAtRoot(rootResolved)` (the AC-2.2 backward-compat probe with `bot/` co-req, label `"requirements.txt + bot/"`) and `probeRequirementsAtSubdir(rootResolved, prefix)` (the monorepo probe, label `"<prefix>/requirements.txt"`). The dispatcher loop calls the right one based on `prefix === ""`. Both still return `MarkerCheck` with name `PYTHON_REQS_AIOGRAM`. Net line count is similar but each function reads top-to-bottom without branch tracking, and the "subdir doesn't need bot/" rule is a function boundary rather than an inline conditional. The Carmack rule applies inverted here: state mutation is fine sequential, but the **semantic differences** are what should be visible — the fork hides them inside a uniform-looking signature.

---

## FINDING 2

- **Title:** `prefix === ""` sentinel is a hidden polymorphism scattered across 4 probes
- **File:** `/root/aura-companion/web/scripts/detect-stack.ts` (lines 268–446)
- **Principle:** Principle 4 — Names reveal design / Principle 5 — Primitive Obsession
- **Severity:** P2
- **What's wrong:** All four probes start with the same ternary: `const relPath = prefix === "" ? CANONICAL : prefix + "/" + SUFFIX`. The empty string is acting as a discriminated union tag for "use the canonical Aura layout" vs "use the monorepo-subdir layout". This is primitive obsession — a `string` parameter where two distinct cases (canonical root layout, depth-1 subdir) are encoded by sentinel value. The canonical case `"web/package.json"` is also accidentally a zeroth-order path: `prefix === ""` produces `web/package.json`, but `prefix === "web"` would *also* produce `web/package.json`. The dedupe at line 544 exists specifically to resolve this collision — meaning the model is internally inconsistent and patched up after the fact.
- **Consequence:** Adding a third layout shape (e.g. `apps/companion/web/package.json` deep monorepo) requires touching all 4 probes' ternaries. The "canonical" branch is also the implicit-default path that contributors will mentally privilege — but it's structurally indistinguishable from a depth-1 candidate where the subdir happens to be named `web`. This is what causes the dedupe step at line 544 to be load-bearing rather than belt-and-suspenders. Speculative-generality risk on the flip side: extending to depth-2 means the `prefix` model fragments further (does `prefix` carry separators? what about Windows backslash?).
- **Fix:** Either (a) make the canonical Aura layout simply `"web"` as the first entry in the prefix list — drop the special case entirely; all probes become `const relPath = prefix + "/" + SUFFIX` with no ternary; or (b) introduce a `type ProbeLayout = { kind: "canonical-aura" } | { kind: "monorepo-subdir"; dir: string }` so the polymorphism is explicit and exhaustively switched. Option (a) is cheaper and aligns with what the dedupe is already implicitly asking for: there is no "canonical" magic, only a privileged-first-candidate `web`. Probe functions become uniform; dedupe goes away; future depth-2 extension is additive. Combined with FINDING 3 below this is the bigger structural shift.

---

## FINDING 3

- **Title:** Post-collection `(name, path)` dedupe is fix-up for a model collision the enumerator could prevent
- **File:** `/root/aura-companion/web/scripts/detect-stack.ts` (lines 544–551, enumerator at 231–259)
- **Principle:** Principle 2 — Wasted work / Principle 6 — Boundaries earn their place
- **Severity:** P3 (severity capped: tiny `O(prefixes)` work, file changes infrequently)
- **What's wrong:** The dedupe loop at 544–551 is *only* needed because `prefix=""` and `prefix="web"` produce the same `relPath` for the package.json + ws-bridge probes. It runs every call, allocates a Set, walks every accumulated MarkerCheck. The comment at 539–543 honestly admits the collision and resolves it after the fact. This is the wrong level of generalisation: it pretends there is a *general invariant* ("no duplicate (name, path) pairs") when actually the only duplication source is the canonical/web overlap from FINDING 2.
- **Consequence:** Two costs. (1) Extra work on every probe call (small — bounded by `4 × prefixes.length`). (2) The dedupe step itself is now a **reader trap**: someone debugging "why did my marker disappear?" will spend time on the dedupe logic when the real answer is "two probes produced identical output." If the model from FINDING 2(a) is adopted (drop the `prefix === ""` sentinel; just put `"web"` as the first prefix candidate), the dedupe becomes vestigial and can be deleted, because `enumerateCandidatePrefixes` would skip `web` if it's already implicit. Alternative narrow fix: in `enumerateCandidatePrefixes`, if `"web"` would be a depth-1 candidate AND the canonical-root probe is enabled, suppress `"web"` upfront. That's a kludge but cheap.
- **Fix:** Tie this to FINDING 2's resolution. If 2(a) is taken, this finding evaporates with it. If 2 is left alone, downgrade the dedupe to a defensive `assertNoDuplicates` in tests (mirror canary territory) and have `enumerateCandidatePrefixes` filter `"web"` when canonical-root is in play. Don't carry both the collision AND the dedupe as the steady-state design.

---

## FINDING 4

- **Title:** `renderRefusal` now exceeds its single-responsibility budget
- **File:** `/root/aura-companion/web/scripts/detect-stack.ts` (lines 666–726)
- **Principle:** Principle 2 — Extract pure logic (pure function, safe extraction)
- **Severity:** P3
- **What's wrong:** The function now does three things in one ~60-line body: (1) headline selection (4-way dispatch: malformed → conflict → ambiguous → unknown), (2) override_conflict body emission (3-line block conditional on kind), (3) footer dispatch (override_conflict footer vs OVERRIDE_FOOTER). The shared parts ("Checked for:" enumeration, "Found at workspace root:" enumeration) sit between the conflict-specific blocks. Reading it requires holding the kind discriminant in mental scope across the whole function. Beck's "tests that break on refactoring without behaviour change" rule applies inversely here: the substring-asserting tests downstream will tolerate small reordering, so extraction is mechanically safe.
- **Consequence:** Each new refusal kind adds another branch in three places (headline, body, footer). The spec doc mentions the AC-conflict "ask-first" language deficiency that may need fixing post-ship — when someone reaches for that change, they will be staring at a 60-line procedural function with cross-branch invariants and the cost of making the change rises with each kind added. Not a fear-zone yet; trajectory is going there.
- **Fix:** Extract three pure helpers: `pickHeadline(result): string`, `renderConflictBlock(result): string[]` (returns `[]` when not conflict), `pickFooter(result): string[]`. The main function becomes a 12-line concatenation: headline + blank + maybeConflictBlock + checkedFor + foundAt + blank + footer. All extractions are pure (no I/O) so the Carmack/Fowler test passes trivially. Tests don't move (substring asserts on output). This is the small, safe move now before more discriminants land.

---

## FINDING 5

- **Title:** `enumerateCandidatePrefixes` mixes three responsibilities (no extraction needed yet)
- **File:** `/root/aura-companion/web/scripts/detect-stack.ts` (lines 231–259)
- **Principle:** Principle 2 — Extract pure logic / Principle 6 — Premature modularisation (don't)
- **Severity:** P3 (advisory, do NOT act unless adding a 4th responsibility)
- **What's wrong:** The function reads a directory, applies a *name-shape* filter (hidden + SKIP_SUBDIRS), applies a *type* filter (isDirectory), applies a *security* filter (separate lstat symlink reject), and applies a *budget* cap (MAX_CANDIDATE_SUBDIRS=64). Four distinct concerns in 28 lines. By Fowler's letter this is a candidate for Extract Function (`shouldSkipByName`, `isSafeDirectory`).
- **Consequence:** None imminent. The function is short, pure-ish (`readdirSync` + `lstatSync` only), and changes rarely. Extracting now buys readability at the cost of indirection; given the economic test ("will this slow us down?") the answer right now is no.
- **Fix:** Leave alone. Flag for revisit if a 4th concern lands (e.g. per-prefix size budget, depth-2 recursion, configurable allow-list). At that point extract `shouldSkipByName(name: string): boolean` and `isSafeDirectory(rootResolved, name): boolean` — both pure-ish, both trivially testable. **Recording this so the next reviewer doesn't independently rediscover and act prematurely.**

---

## FINDING 6

- **Title:** `MARKER_NAMES` are identifiers but the type field is called `name` — naming mismatch with `path`
- **File:** `/root/aura-companion/web/scripts/detect-stack.ts` (lines 39–46, 114–121, 268–446)
- **Principle:** Principle 4 — Names reveal design
- **Severity:** P3
- **What's wrong:** `MARKER_NAMES.AURA_PACKAGE_NAME = "web/package.json:name=aura-companion"` is an opaque canonical *identifier* (mirror-canary load-bearing — SKILL.md docs cite it verbatim). It is stamped on every MarkerCheck regardless of where the marker was actually found. The `MarkerCheck.path` field shows the *actual probed path* (`"webapp/package.json"` if probed in a `webapp/` subdir). So `name` field stays static (it's an ID), `path` field varies (it's the disk location). The naming reads naturally — but `name` looking like `"web/package.json:..."` makes contributors think it's a path-shaped string they can transform; in fact it's a string-keyed enum value. The SKILL.md mirror canary preserves this confusion because the contract is "verbatim quote."
- **Consequence:** Low: hard to find a path-shaped change that would silently miss a typo because the mirror test will fire. But a contributor reading `MarkerCheck` for the first time will mistake `name` for "the path this marker refers to," reach for it as a disk path, and the bug only fails downstream in the renderer. A name like `MARKER_LABELS` or `MARKER_IDS` makes the semantic obvious; `name` field on `MarkerCheck` becomes `label` or `id`.
- **Consequence (cost of fixing):** The verbatim mirror canary at `detect-stack.skill-mirror.test.ts` plus the 3 SKILL.md files would all need touching. That mechanical cost is real — would not flag if no other naming work were pending.
- **Fix:** Defer. Rename `MARKER_NAMES → MARKER_LABELS` and `MarkerCheck.name → MarkerCheck.label` *only if* the SKILL.md mirror is being edited for another reason in the same PR. Otherwise the verbatim canary discipline pays its way and `name`/`path` is tolerable. The file's structural debt budget is best spent on FINDINGS 1 and 2.

---

## FINDING 7 (NULL)

- **Title:** Module size at 640 lines does NOT warrant splitting yet
- **File:** `/root/aura-companion/web/scripts/detect-stack.ts`
- **Principle:** Principle 6 — Premature modularisation
- **Severity:** N/A (recording the non-finding so it's not reopened)
- **Reasoning:** Total ~640 lines, single-file, single-export-surface, pure, no I/O beyond `node:fs`. Split candidates would be `detect-stack-types.ts` + `detect-stack-probes.ts` + `detect-stack-render.ts`. **Don't do it.** Three reasons: (1) the mirror canary discipline already enforces colocation of constants + types with the exported behaviour; splitting adds import gymnastics across the canary boundary, (2) the file is consumed by a single caller path (the 3 SKILL.md skills via `bun run detect-stack.ts` invocation) — no shotgun-surgery pressure from multiple consumers, (3) the file changes infrequently and the closest economic threshold (~1000 lines or god-module behaviour where multiple unrelated things change for unrelated reasons) is not yet hit. The Carmack rule applies: the function least likely to cause a problem is the module that doesn't exist. Flag for revisit at ~1000 lines or when probes start importing from each other.

---

## Summary

- **P2 (fix soon):** 2 findings (`probeRequirementsAndBot` fork, `prefix` sentinel polymorphism)
- **P3 (consider):** 4 findings (post-collection dedupe — tied to P2 #2, `renderRefusal` extraction, `enumerateCandidatePrefixes` cohesion — DEFER, `MARKER_NAMES` naming — DEFER)
- **NULL (record):** 1 finding (module size — do not split)

Critical-path action: F1 and F2 should be addressed together — F2(a) (drop `prefix === ""` sentinel; make `web` the first explicit prefix candidate) cleanly subsumes F3 (dedupe vanishes) and makes F1 (the requirementsAndBot fork) the only remaining branch-on-prefix in the file, which is then split per F1. That gives a uniform probe model + one explicit semantic fork, instead of four implicit forks + a fix-up step.

F4 (`renderRefusal` extraction) is the safe small move regardless of F1/F2 outcomes — pure functions, no test churn, prepares for future refusal-kind additions.

No P1 findings. detect-stack.ts is structurally healthy; the commit added scope (depth-1 monorepo) cleanly but the `prefix === ""` sentinel is the seam where future maintenance will accumulate friction.
