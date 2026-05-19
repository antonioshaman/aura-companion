# Fowler subplan — Phase 3β structural design

**Council role:** structural-design lens for the catalog as artefact + the EC-34/EC-35 conventions amendment
**Reference doc:** `~/.claude/skills/_council-experts-v2/fowler/references/quality-fowler.md`
**Dispatched via:** `~/.claude/skills/_council-experts-v2/fowler/plan-aura.md` substituted with Phase 3β brief

---

## Recommendations (verbatim from subagent)

### 1. Treat the 6 tension-pair axis docs as the bounded-context boundary, not the per-expert dir

- **Principle:** §B bounded context awareness
- **AC defended:** AC9 (6 axis docs), AC5 (EC-34 codification), AC1 (8 expert dirs)
- **What to get right:** The natural decomposition impulse is "one doc per expert" (8 docs), but the structural truth of Phase 3β is that 6 of the 8 new experts only have meaning *in relation to* another seat. The axis doc (e.g. `unclebob-vs-fowler.md`) is the bounded context where both reference docs become coherent; the per-expert ref docs are the model objects inside that context. Author the axis docs FIRST inside each paired sub-phase (sub-2/3/4) before the second member of each pair, so the second ref doc is written *against* a settled axis statement rather than inferring tension retroactively.
- **Risk if skipped:** Pairs drift into "stack-for-coverage" (the very anti-pattern EC-34 codifies against); the axis docs become post-hoc summaries rather than the contract that disciplines the two ref docs against each other.

### 2. Apply the two-hat discipline to the conventions.md amendment — split EC-34/EC-35 from sub-4 content commits

- **Principle:** §A two-hat discipline
- **AC defended:** AC5 (conventions amendment), AC8 (gates green every commit)
- **What to get right:** Sub-4 currently bundles two distinct activities: *adding behaviour* (majors + sridharan + 2 axis docs are net-new catalog content) and *preserving-behaviour-while-restructuring* (EC-34/EC-35 are documentation of conventions that already empirically hold). Bundling them produces a sub-4 commit cluster where a reviewer cannot localise whether a failing gate came from a new ref doc or from an amended convention statement. The conventions amendment should land as its own atomic commit at the head OR tail of sub-4, with its own validator brief, citing only the empirical evidence (Phase 3α zero-drift sequence for EC-35; Section F spec text for EC-34).
- **Risk if skipped:** A gate failure in sub-4 has two candidate causes per commit; bisecting a regression to "ref doc shape" vs "conventions wording" becomes ambiguous, which inflates validator-brief volume for no architectural gain.

### 3. Make the runtime panel-file probe (D8) a sub-phase entry gate, not a per-commit afterthought

- **Principle:** §B evolutionary architecture (fitness functions)
- **AC defended:** AC1, AC8
- **What to get right:** D8 says mirror-set shape is runtime-mechanical — but the PLAN's hypothesis table (lerdorf non-aura, torvalds full-panel, etc.) is exactly the kind of frozen-at-project-start artefact §B warns against. Each sub-phase should begin with an explicit "probe step" that re-derives shape from `ls ~/.claude/skills/<panel>/agents/<id>/` for every expert in that sub-phase AFTER dispatcher files land, and the result becomes the input to mirror cp + lock attestation. This is a fitness function in the §B sense — automated, mechanical, structural — that prevents the PLAN's hypothesis from silently drifting into prescriptive specification.
- **Risk if skipped:** PICKUP-style drift recurs (the brief notes beck was hypothesised plan-dispatch but is actually review-only); a writer session honours the table rather than the probe and lands a structurally-wrong mirror-set, failing C12 sha256 attestation at the gate.

### 4. Resist speculative generalisation in the EC-34 axis enumeration — name only the 6 axes that ship in Phase 3β

- **Principle:** §A YAGNI as economic constraint
- **AC defended:** AC5 (EC-34 spec text), AC9 (6 axis docs — not 10, not "extensible")
- **What to get right:** The spec text lists three axis archetypes ("purity-vs-pragmatism, principle-vs-economics, paranoia-vs-curiosity"). The temptation is to publish a generic taxonomy of axis-types and let future phases slot into it. Don't. Enumerate the 6 concrete axes that ship in Phase 3β by name in the convention body, mark the archetype list as illustrative, and explicitly defer "general axis taxonomy" to a future phase when ≥10 pairs exist and the pattern is observed rather than hypothesised. YAGNI: the second real caller for "general axis taxonomy" doesn't exist yet.
- **Risk if skipped:** EC-34 becomes a meta-framework before the empirical base supports one; future phases inherit a frozen vocabulary that constrains good pairings into bad archetypes.

### 5. Treat lerdorf and colvin's "unpaired" status as a first-class structural fact, not a temporary anomaly

- **Principle:** §C smells are heuristics, not laws
- **AC defended:** AC2, AC5
- **What to get right:** Phase 3β has 6 paired + 2 unpaired experts. The "every seat must be paired" reading of EC-34 would either force a false pair onto these two or treat them as awkward exceptions. The structural truth: some domains are coherent standalone (PHP web-first pragmatism has no orthogonal-philosophy peer in the current panel; pydantic-ai has only a weak tension with willison). EC-34 should explicitly admit unpaired seats as valid when no orthogonal peer exists, rather than treating them as transitional debt.
- **Risk if skipped:** Subsequent phases force-pair every new seat, creating axis docs that are post-hoc rationalisations rather than genuine tensions.

### 6. Keep `quality-<id>.md` reference docs at exactly 3 §-sections each — resist scope-creep when an expert "deserves more"

- **Principle:** §C Large Class smell + §A change-amplifier identification
- **AC defended:** AC2 (Path-3 hybrid depth, sections ≥67L)
- **What to get right:** Phase 3α settled the section count at 3 (`§A/§B/§C`) at 67-83L each. Some Phase 3β candidates will tempt a 4th section — torvalds has both kernel-process and patch-review-discipline material; majors has observability-philosophy + on-call-economics. Resist. A 4th section turns a coherent reference doc into a Large Class — cohesion erodes, dispatcher prompts get longer, chair can't cite "Principle N from §X" unambiguously. If an expert genuinely needs more coverage, that's a signal a second pair seat is missing — file it as Phase 3γ scope.
- **Risk if skipped:** Reference-doc bloat compounds (deviation amplification); the third helper section is always cheaper to add than the first, until the doc is 300L and nobody re-reads it.

### 7. Anchor EC-35 wording to the empirical zero-drift sequence, not the aesthetic discipline

- **Principle:** §A economic refactoring (economic frame, not aesthetic)
- **AC defended:** AC5 (EC-35 codification)
- **What to get right:** EC-35 promotes D7 shell-paste discipline after 7 consecutive zero-drift commits (N3.08..N3.14). The wording temptation is "validator artifacts SHOULD use shell-paste because shell-paste is more rigorous" (aesthetic). The Fowler-correct framing is "validator artifacts MUST cite `$ <command>` output for numerical claims because empirically, 7/7 commits using this convention had zero drift while the prior 7 commits had measurable drift — the cost (one extra paste per claim) pays back as `validator FAIL` events avoided." The convention text must surface the cost-and-payback axis explicitly.
- **Risk if skipped:** EC-35 reads as ritual ("good writers shell-paste") rather than economics; first time a writer is under time pressure, the convention erodes.

---

## Tension-pair codification framing (EC-34 wording advisory)

The Section F spec text is structurally correct but under-specified on two axes:

1. **Scale threshold needs economic justification, not numeric cliff.** "(>12 seats)" reads as arbitrary. Reword to surface the why: tension-pairing pays for itself when the council can no longer be held in working memory in one read, because at that point chair synthesis degrades from "weighing N findings" into "skimming for the loudest ones". 12 is the observed elbow from Phase 3α, not a derived constant.

2. **"Synthesis becomes resolution, not aggregation" is the load-bearing sentence — promote it.** This is the actual structural-design claim. Aggregation is what most multi-expert reviews degrade into. Resolution is what tension-pairing forces. The convention should lead with this.

3. **The "Carmack-chair filter picks based on project economic context" clause needs explicit non-prescription.** Without it, future phases will try to formalise the filter. The convention should say explicitly that the chair's filter is judgement under context and not subject to mechanical codification — and any future codification attempt must clear a "second real caller" gate.

**Structural watchpoint:** EC-34 is a convention about how the catalog is organised, while every other EC-* governs runtime code. This is a category boundary worth marking explicitly in the convention header (e.g. a `Scope:` line distinguishing catalog-organisational from runtime conventions) — otherwise EC-34 reads like a runtime invariant readers will look for in the wrong place.
