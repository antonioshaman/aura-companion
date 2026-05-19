# Willison subplan — Phase 3β LLM pipeline + content quality

**Council role:** LLM-pipeline-ergonomics + LLM-content-quality lens for new catalog + dispatcher prompts
**Reference doc:** `~/.claude/skills/_council-experts-v2/willison/references/quality-willison.md`
**Dispatched via:** `~/.claude/skills/_council-experts-v2/willison/plan-aura.md` substituted with Phase 3β brief

---

## Recommendations (verbatim from subagent)

### 1. Author `quality-colvin.md` as genuinely orthogonal to `quality-willison.md`, not as schema-strict variant of exploration

- **Principle:** §A structured outputs (Principle 2)
- **AC defended:** AC2, AC4, AC9
- **What to get right:** Colvin's reference doc must claim what I (Willison) would refuse to claim — that the type contract precedes the exploration, that the schema IS the spec, that constrained sampling + parse-or-fail eliminates the iterate-on-failures loop rather than being one stage of it. If `quality-colvin.md` recapitulates my §A structured outputs principle ("validate the parse"), the pair adds noise to subagent context, not signal. Chair-side dispatch logic depends on the two docs being materially distinguishable.
- **Risk if skipped:** Council subagents reading both docs receive correlated context; the LLM-as-validator-by-two-similar-LLMs failure mode I name in my §A anti-patterns lands inside the council itself.

### 2. Lock dispatcher prompt structure across all 8 new experts; treat schema drift as a release-gated change

- **Principle:** §A tool-use patterns (Principle 1)
- **AC defended:** AC1, AC7, AC8
- **What to get right:** The dispatcher prompt files (`plan-aura.md`, `review-aura.md`, etc.) ARE the tool schema the chair invokes against each subagent. Adding 8 new experts × ~3-4 prompts = ~24-32 new "tool surfaces". Each must follow the exact same section-header set, output-shape block, "If no recommendations" escape clause that Phase 3α settled. A reviewer who finds a new dispatcher with renamed `## OUTPUT SHAPE` header or re-ordered `## YOUR LENS` block has found silent schema drift; validator brief for that commit must surface this in D7 shell-paste (`$ diff dispatcher-a.md dispatcher-b.md | grep ^##`).
- **Risk if skipped:** Subagent behaviour silently shifts per-dispatcher across the 22-seat catalog.

### 3. Validator-brief artifact MUST record the raw subagent output, not just the verdict

- **Principle:** §B transcript-first debugging (Principle 2)
- **AC defended:** AC7, AC8
- **What to get right:** EC-31's `/tmp/phase-3-beta-NX-validator-brief.md` is the council's transcript layer. For each commit it should preserve the full envelope — brief that went to validator, validator's prose response, `$ <command>` shell-paste outputs, PASS/FAIL verdict — not a summary. When Phase 3γ or later needs to ask "why did N3.17 land at depth 71L instead of 75L", the transcript is the only forensic surface that answers; brief that only logs "PASS" forfeits debugging and reproducibility for marginal storage savings. Parallel role: NDJSON recordings for orchestrator+observer.
- **Risk if skipped:** Phase 3β closes with 22 commits whose acceptance-claim provenance lives only in writer's session memory; next reviewer cannot replay.

### 4. Each new `meta.yaml` must declare its `tension_axis` + `paired_with` fields as machine-readable, not buried in prose

- **Principle:** §B context packing (Principle 1)
- **AC defended:** AC1, AC5, AC9
- **What to get right:** The chair (Carmack) needs structured fields in `meta.yaml` to make per-task dispatch decisions for paired panels (Phase 3γ work, but Phase 3β authors the data substrate). If `tension_axis: "schema-strict ↔ exploration"` and `paired_with: willison` are explicit YAML fields, chair-side dispatch logic becomes a deterministic lookup; if tension is only described in prose, chair must LLM-parse the doc to decide which seat to invoke, and the dispatch becomes itself an unconstrained LLM call. Constrain chair's input the same way constrained sampling constrains model output.
- **Risk if skipped:** Phase 3γ chair-side dispatch becomes LLM-on-LLM lookup with correlated failure modes.

### 5. Run one dry-run dispatch per new expert before claiming AC1 green

- **Principle:** §A structured outputs (Principle 2) + §B transcript-first debugging (Principle 2)
- **AC defended:** AC1, AC2, AC7
- **What to get right:** Each of the 8 new experts ships a dispatcher prompt never exercised against a real subagent. Before sub-phase HANDOFF declares the expert "available", chair (or writer) should invoke `/council-plan-aura` against a synthetic micro-brief and inspect that subagent returns canonical OUTPUT SHAPE block (not blank, not malformed, not "I have no recommendations in my domain" if synthetic brief designed to elicit one). Prompt-engineering analog of a smoke test; dispatcher prompt that parses as markdown but produces empty output under live dispatch is the silent-regression case §A structured outputs parse-or-fail principle exists to prevent. Capture synthetic-dispatch transcript into validator-brief.
- **Risk if skipped:** First real Phase-3γ dispatch against (e.g.) evans returns empty output and chair cannot distinguish "evans truly had no recommendations" from "evans's dispatcher prompt has a typo".

### 6. `quality-lerdorf.md` should bridge web-runtime pragmatism → LLM-stream-lifecycle pragmatism in exactly one principle, then stay in PHP lane

- **Principle:** §B agent ergonomics (Principle 3)
- **AC defended:** AC2, AC9
- **What to get right:** Lerdorf's web-first pragmatism has one genuinely transferable principle for Aura's stack: the request-lifecycle realism that says "the request ends; resources are reclaimed; long-running state is the exception, not the default" maps directly to LLM-stream-lifecycle realism ("the stream ends; the model's context is reclaimed; long-running agent state is the exception"). One Aura-applicable principle authored at Path-3 depth bridges the lens; remaining principles can stay in PHP/web-runtime lane without straining for Aura applicability. Trying to force all lerdorf principles into Aura applicability produces strained metaphors that degrade subagent context.
- **Risk if skipped:** lerdorf reads as "PHP expert with no Aura relevance" OR "PHP expert with strained metaphors throughout"; catalog gains a seat with low signal-to-token ratio.

---

## Self-tension framing for colvin↔willison

As Willison, I claim: **prompts are living artefacts; you reach the right output by visible iteration with the transcript in front of you; the validator on the receiving side is non-negotiable BECAUSE the model can produce schema-valid-but-semantically-wrong output; the team that publishes its failures designs better experiments.**

Colvin should claim what I would refuse to claim:

**Where schema-strict wins (and exploration loses).** When the consumer of the LLM output is another program — a tool dispatch, a database write, an API call into a typed system — the typed schema IS the spec; iteration against transcripts is a debugging mode, not a production stance. A pydantic-ai-style typed agent that refuses to ship the call when validation fails is structurally safer than a Willison-style "parse-or-fail" agent that ships the failure to a human transcript, because the human-transcript loop assumes a human is reading transcripts. In a production multi-tenant deployment with 10k calls/day, nobody reads the transcripts; the schema is the only enforcement that survives operational scale. Colvin should claim: **types are the contract; iteration is the cost of having no contract.**

**Where exploration wins (and schema-strict loses).** When the prompt is the artefact under development — when the team is learning what the model can do on a new domain — the schema is a premature constraint that masks the model's actual capability surface. A typed agent fails on outputs that a transcript-first agent would have learned from; the schema was written before the team knew what to demand of it. Schema-strict on a not-yet-understood domain is over-fitting the contract to assumptions; exploration-first gives the team the negative results that inform what the schema should be.

**Crisp boundary:** Colvin wins when consumer is a program; Willison wins when consumer is a developer iterating on the prompt. Chair's per-task dispatch: *is the LLM output flowing into typed code, or into a human reading a transcript?* If typed code → seat Colvin; if developer iteration → seat Willison; if both (most real systems) → seat both and let tension surface the schema-vs-prompt-iteration trade-off in the finding set.

This is the orthogonality `quality-colvin.md` must encode. If Colvin's reference doc claims "validate the parse, capture the transcript, iterate on failures" the pair collapses to redundancy and the catalog loses a seat's worth of token budget.
