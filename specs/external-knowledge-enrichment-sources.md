# External knowledge enrichment sources

**Purpose:** capture user-provided material (frameworks, projects, persona inspirations) for post-Phase-2 enrichment workstreams. NOT input для current Phase 2d (per validator Option A — defer github research post-Phase-2).

**Date captured:** 2026-05-16
**Provided by:** user (recall from prior sessions, re-articulated in current validator session)

---

## A. Architecture frameworks (multi-agent orchestration)

These were referenced in prior design discussions. They inform **architecture**, not per-expert knowledge content. **Already partially captured** in spec `council-experts-catalog-v2-expansion.md` line 343:

> _(confirmed) v2 architecture (LangGraph Brahman, CrewAI runtime, AutoGen debates, OpenDevin executors, vector memory, MCP RUNTIME) is roadmap context only; out of v1 scope. MCP/pydantic-ai LENS becomes its own ID (`colvin`), separate from `willison` (LLM pipeline)._

### Captured architecture references

| Project | Role в Aura Companion v2 architecture | Status |
|---|---|---|
| **LangGraph** | Brahman Orchestrator (Layer 1) — stateful workflows, graph orchestration, retries, checkpoints, memory, subagents, human-in-loop, model routing | spec'd as roadmap context (out of v1) |
| **CrewAI** | Specialist Agent Runtime (Layer 2) — roles/goals/tools/tasks abstraction | spec'd as roadmap context |
| **AutoGen** | Code Review Layer — agents debate, planner/reviewer/coder/critique loops | spec'd as roadmap context |
| **OpenDevin** | Coding Executor (Layer 3) — shell + browser + editor + planner + filesystem + autonomous coding | spec'd as roadmap context |
| **agent-zero** | "Agents spawn agents" recursive orchestration pattern | not yet spec'd; aspirational |
| **PydanticAI** | Typesafe Python agent ecosystem — strict tool schemas, MCP, structured outputs, FastAPI | spec'd as `colvin` expert ID candidate (Phase 3) |
| **MCP** (Model Context Protocol) | Tool/server/context standard | spec'd as roadmap (RUNTIME, Phase 5) |
| **Semantic Kernel** | .NET / C# / enterprise alternative | not aligned с current TS/Bun stack |
| **Vercel AI SDK** | Frontend / browser AI helpers | tangential — Aura frontend is React + Zustand custom |
| **CAMEL AI / AI Town / SuperAGI / OpenAI Swarm / Suna** | Survey-level references, not direct adoption | informational only |

### Architectural takeaways

User's proposed Aura Companion v2 stack (paraphrased):

- **Layer 1 — Brahman Orchestrator** — LangGraph (stateful, graph-based, persistent memory)
- **Layer 2 — Specialist Agent Runtime** — CrewAI + AutoGen
- **Layer 3 — Coding Executors** — Claude Code + Codex CLI + OpenDevin + local Ollama/Qwen
- **Layer 4 — Specialist Agents** — 7-15 strong (NOT 100+; user explicit anti-pattern: "token furnace / zombie agents / context hell")
- **Layer 5 — Memory** — vector + session + project + per-agent
- **Layer 6 — MCP ecosystem** — tools/servers/shared context

User explicit guidance: **NOT 100+ agents** ("almost все такие системы → token furnace / zombie agents / context hell"). Target: 7-15 strong allies + routing + shared memory + human approval + context compression. **10x value vs "159 агентов ради агентов".**

This **strongly aligns** с current v2 catalog target: 14 experts post-Phase-2d (down from β 17), не expansion to 100+. Architecture-level conviction preserved.

### Где это уже learns implementation

- `specs/council-mode-bidirectional-pipeline.md` Phase 5 plans REST :3457 server + heartbeat + cross-half memory propagation — это **partial Layer 5 (memory) + Layer 1 (orchestration)** in Aura's specific shape (Council pair, не full LangGraph)
- `colvin` (Phase 3 candidate per HANDOFF) — PydanticAI lens directly captured
- MCP runtime — explicit in spec roadmap

---

## B. Persona name inspirations (DECISION ALREADY MADE — NOT TO BE REVISITED)

User's prior session mentioned mythical/abstract specialist names: **Python Sage / PHP Monk / Node Architect / React Weaver / DevOps Keeper / Postgres Oracle / Security Watcher / Refactor Spirit / UX Alchemist / Telegram Master**.

**Council plan Task 1 (Phase 2a-N1 ratified) chose REAL-PERSON SURNAMES instead.** Per `specs/council-experts-catalog-v2-expansion.md` line 263:

> _Do NOT: Use flavor names (`python-sage`, `php-monk`, `frontend-wizard`) — only real-person surnames._

Final v2 IDs: hunt, fowler, beck, willison, saarinen, friedman, watson, brandur, abramov, durov, vanrossum, dahl, ritchie, hashimoto.

**Rationale (per willison REC-4 in Phase 2 council-plan-output):** Distinct proper-noun tokens disambiguate cleanly при LLM dispatch; domain names like `deploy-devops` collide с prose-level verbs. Person-named IDs win on LLM-pipeline grounds.

**Persona-name dimension is CLOSED.** Will NOT be revisited.

---

## C. Per-expert knowledge sources (STILL NEEDED)

User's original aspiration: enrich each expert's reference doc (`references/quality-X.md`) с external content. **This material was NOT captured anywhere** — user can re-provide in this section as he recalls or re-researches.

Template для каждого expert:

```yaml
fowler:
  urls: [...]
  concepts: [Tidy First (Beck), "economic refactoring test", ...]
  tone: "..."
  anti_patterns: [...]

hunt:
  urls: [...]
  ...

# ...
```

**To be populated by user** in subsequent dump sessions. Each addition will be appended below this line.

---

### User dump #1 (2026-05-16)

```yaml
fowler:
  urls:
    - https://martinfowler.com/articles/refactoring-2nd-ed.html
    - https://martinfowler.com/bliki/CodeSmell.html
    - https://martinfowler.com/articles/microservices.html
    - https://martinfowler.com/articles/feature-toggles.html
    - https://martinfowler.com/bliki/Yagni.html
  concepts:
    - economic refactoring
    - deviation amplification
    - strangler fig migration
    - feature toggles
    - evolutionary architecture
    - code smell taxonomy
    - bounded context awareness
  tone: [pragmatic, architecture-first, incremental modernization, anti-big-rewrite]

beck:
  urls:
    - https://www.tidyfirst.com/
    - https://martinfowler.com/bliki/TestDrivenDevelopment.html
    - https://tidyfirst.substack.com/
    - https://en.wikipedia.org/wiki/Test-driven_development
  concepts:
    - TDD microcycles
    - empirical test design
    - test infect
    - make the change easy then make the easy change
    - small safe steps
    - locality of behavior
    - optimistic programming
  tone: [minimalist, calm precision, tiny iterations, code as communication]

hunt:
  urls:
    - https://owasp.org/Top10/
    - https://troyhunt.com/
    - https://haveibeenpwned.com/
    - https://cheatsheetseries.owasp.org/
  concepts:
    - modern password storage
    - credential stuffing
    - data breach forensics
    - attack surface reduction
    - secure defaults
    - secret leakage prevention
    - zero trust mindset
  tone: [paranoid but practical, evidence-driven, breach-oriented thinking, security hygiene first]

willison:
  urls:
    - https://simonwillison.net/tags/prompt-engineering/
    - https://simonwillison.net/tags/llms/
    - https://github.com/simonw/llm
    - https://github.com/simonw/files-to-prompt
  concepts:
    - tool-use patterns
    - structured outputs
    - prompt injection defense
    - context packing
    - agent ergonomics
    - transcript-first debugging
    - local-first AI workflows
  tone: [exploratory, practical experimentation, transparent reasoning, notebook mindset]

carmack:
  urls:
    - https://twitter.com/ID_AA_Carmack
    - https://github.com/id-Software/DOOM
    - https://www.youtube.com/results?search_query=john+carmack+programming
  concepts: [simplicity over abstraction, profiling first, cache-aware thinking, systems-level debugging, low-latency iteration, ruthless technical clarity]
  tone: [blunt, performance-obsessed, engineer-minimalism, anti-bloat]

torvalds:
  urls:
    - https://github.com/torvalds/linux
    - https://www.kernel.org/doc/html/latest/process/
    - https://yarchive.net/comp/linux/
  concepts: [backward compatibility, pragmatic engineering, ugly solutions that work, distributed contribution models, subsystem ownership, stable interfaces]
  tone: [direct, no-nonsense, engineering realism, anti-theory]

unclebob:
  urls:
    - https://blog.cleancoder.com/
    - https://github.com/unclebob/cmuratori-discussion
    - https://8thlight.com/insights/uncle-bob-clean-architecture
  concepts: [clean architecture, SOLID boundaries, screaming architecture, dependency inversion, policy vs detail separation]
  tone: [didactic, principled, architecture purity, discipline-focused]

evans:
  urls:
    - https://domainlanguage.com/ddd/
    - https://martinfowler.com/tags/domain%20driven%20design.html
  concepts: [bounded contexts, ubiquitous language, aggregates, context mapping, domain events]
  tone: [domain-centric, modeling-first, collaborative language, strategic design]

rich_hickey:
  urls:
    - https://www.youtube.com/watch?v=SxdOUGdseq4
    - https://www.youtube.com/watch?v=YR5WdGrpoug
    - https://clojure.org/about/rationale
  concepts: [simplicity vs easy, complecting avoidance, immutable thinking, value semantics, state management clarity]
  tone: [philosophical, deep systems thinking, conceptual rigor, anti-accidental complexity]

roddenberry_ai_ops:
  urls:
    - https://opentelemetry.io/
    - https://www.honeycomb.io/
    - https://sre.google/
  concepts: [observability-first systems, distributed tracing, high-cardinality debugging, reliability engineering, production introspection]
  tone: [operational awareness, telemetry-driven, systems visibility, production realism]

postgres_oracle:
  urls:
    - https://www.postgresql.org/docs/
    - https://use-the-index-luke.com/
    - https://wiki.postgresql.org/wiki/Main_Page
  concepts: [query plan literacy, index selectivity, transactional integrity, lock contention awareness, migration safety, explain analyze culture]
  tone: [data integrity first, performance-aware, migration cautious, correctness over magic]

node_architect:
  urls:
    - https://nodejs.org/en/docs
    - https://expressjs.com/
    - https://fastify.dev/
    - https://github.com/goldbergyoni/nodebestpractices
  concepts: [event loop awareness, async boundary hygiene, backpressure handling, streaming-first APIs, graceful shutdown, runtime observability]
  tone: [runtime-aware, scalable pragmatism, DX balanced with ops, async-first]

python_sage:
  urls:
    - https://docs.python.org/3/
    - https://fastapi.tiangolo.com/
    - https://docs.pydantic.dev/latest/
    - https://peps.python.org/
  concepts: [explicit over implicit, type-safe APIs, async IO boundaries, pydantic validation, dependency injection, maintainable automation]
  tone: [readable, explicit, automation-friendly, production pragmatic]

react_weaver:
  urls:
    - https://react.dev/
    - https://nextjs.org/docs
    - https://tanstack.com/query/latest
    - https://ui.shadcn.com/
  concepts: [server/client boundary clarity, optimistic UI, streaming SSR, state minimization, composable components, hydration safety]
  tone: [UX-centric, compositional, modern frontend realism, interaction-aware]

devops_keeper:
  urls:
    - https://kubernetes.io/docs/home/
    - https://docs.docker.com/
    - https://12factor.net/
    - https://developer.hashicorp.com/terraform/docs
  concepts: [immutable infrastructure, idempotent deploys, infra as code, rollback safety, runtime parity, deployment observability]
  tone: [reliability-first, automation-heavy, operational discipline, failure-aware]
```

### Reconciliation with existing v2 catalog

| User key | Status | Existing v2 expert (after rename) | Action |
|---|---|---|---|
| `fowler` | ✅ direct match | `fowler` (Martin Fowler) | ENRICH existing `references/refactoring.md` + `fowler/*.md` prompts |
| `beck` | ✅ direct match | `beck` (Kent Beck) | ENRICH `references/quality-testing.md` |
| `hunt` | ✅ direct match | `hunt` (Troy Hunt) | ENRICH `references/security.md` |
| `willison` | ✅ direct match | `willison` (Simon Willison) | ENRICH `references/quality-llm.md` |
| `postgres_oracle` (flavor) | → maps to `brandur` (Brandur Leach) | brandur covers Postgres/Alembic | ENRICH `references/quality-postgres.md` under `brandur` |
| `node_architect` (flavor) | → maps to `dahl` (Ryan Dahl) | dahl covers Node/Bun + NDJSON | ENRICH `references/quality-dahl.md` (Phase 2b authored; can be augmented) |
| `python_sage` (flavor) | → maps to `vanrossum` (Guido van Rossum) | vanrossum covers Python backend | ENRICH `references/quality-backend.md` (vanrossum's seat) |
| `react_weaver` (flavor) | → maps to `abramov` (Dan Abramov) | abramov covers React/Web UI | ENRICH `references/quality-frontend.md` |
| `devops_keeper` (flavor) | → maps to `hashimoto` (Mitchell Hashimoto) | hashimoto covers infra/deploy | ENRICH `references/quality-hashimoto.md` (Phase 2b authored) |
| **`carmack`** | ⚠️ Chair role, NOT seated expert | Per CLAUDE.md "Carmack's philosophy chairs..." | DO NOT seat. Carmack signature already applied as chair filter в synthesis. His concepts (simplicity-over-abstraction, profiling-first) can inform **chair-side panel-selection logic** (Phase 3 chair-side stack detection task) OR be folded into Council Mode philosophy doc. NOT a separate seated expert. |
| **`torvalds`** | 🆕 NEW expert candidate (Phase 3) | systems/kernel-level lens; backward compat + subsystem ownership | Phase 3 decision: seat as NEW expert "torvalds" OR fold concepts into `ritchie` (Unix discipline) §A Process lifecycle. Lean toward separate expert — distinct philosophy (Linux-era pragmatism vs. classic Unix). |
| **`unclebob`** | 🆕 NEW expert candidate (Phase 3) | Clean Architecture, SOLID, dependency inversion | Phase 3 decision: seat as NEW expert OR augment `fowler` with SOLID concepts. **Recommend separate** — Uncle Bob's didactic + discipline-purity differs from Fowler's pragmatic-economic. Two genuine views on structural design. |
| **`evans`** | 🆕 NEW expert candidate (Phase 3) | Domain-Driven Design — bounded contexts, ubiquitous language, aggregates | Phase 3 decision: seat as NEW expert. DDD is its own lens, не overlaps с existing. Highly applicable to Aura Companion's session/group/checkpoint/observer domain model. |
| **`rich_hickey`** | 🆕 NEW expert candidate (Phase 3) | Simplicity vs Easy, complecting avoidance, immutable thinking | Phase 3 decision: seat as NEW expert. Strong philosophical lens на state management. Adds depth beyond fowler/unclebob structural views. |
| **`roddenberry_ai_ops`** (flavor) | 🆕 NEW domain, needs person-name | Observability — OpenTelemetry/Honeycomb/SRE | NO existing expert covers this. Person-name candidates: Charity Majors (Honeycomb co-founder, observability voice), Liz Fong-Jones (observability/SRE), Cindy Sridharan (book "Distributed Systems Observability"). Phase 3 decision. |

### Resulting catalog roadmap

- **Phase 2 (current scope, no enrichment):** 14 experts, references untouched beyond merges
- **Phase 3 candidates per HANDOFF + this dump:** lerdorf (PHP) + colvin (pydantic-ai) + torvalds + unclebob + evans + rich_hickey + Charity-Majors-or-similar (observability) = **+7 new experts → 21 total**

If all 7 seated, catalog moves from 14 → 21. **Still within user's "7-15 strong agents NOT 100+" principle** (21 is reasonable for diverse-stack engineering domain — each adds genuine non-overlapping lens).

### Enrichment priority recommendation (post-Phase-2)

**Phase 3-α (low-risk reference enrichment, no new experts):**
- ENRICH 9 existing experts via user-provided URLs/concepts: fowler, beck, hunt, willison, brandur, dahl, vanrossum, abramov, hashimoto
- One commit per expert (atomic), append sections to existing `quality-X.md` references
- Update `_phase2-coverage-tokens.yml` с new token keys per expert
- Estimated: 9 commits, similar discipline to Phase 2b authoring

**Phase 3-β (catalog expansion с new experts):**
- ADD lerdorf (PHP), colvin (pydantic-ai), torvalds, unclebob, evans, rich_hickey, Majors-observability
- Each expert = new dir + meta.yaml + plan/review prompts + references/quality-X.md authored from scratch с user-provided material
- Higher scope per expert (full authoring vs append), ~3-5 commits each

**Phase 3-γ (chair-side panel selection):**
- Implement stack-detection per spec Phase 3 plan
- Carmack philosophy folded as chair-side filter signature (NOT seated)
- Per-stack panel selection: PHP project → seat lerdorf + hunt + fowler; Aura → seat dahl + ritchie + watson + etc.

### Open questions для user (when Phase 3 starts)

1. **Carmack chair-only**: confirm Carmack stays chair (filter), not seated. ✅ или хочешь reconsider?
2. **Torvalds vs Ritchie split**: separate experts или fold Torvalds into Ritchie's §A Process lifecycle? Recommend separate (Linux pragmatism ≠ Unix purity).
3. **Observability person-name**: Charity Majors / Liz Fong-Jones / Cindy Sridharan / иной? Phase 3 framework will pick.
4. **Catalog ceiling**: 21 experts post-Phase-3 OK? Anti-pattern threshold is 100+, 21 still well within "strong allies" zone.

---

### User dump #2 (2026-05-16) — Phase 3 expert candidates + BALANCING design principle

```yaml
lerdorf:
  urls: [https://www.php.net/manual/en/, https://talks.php.net/, https://github.com/php/php-src, https://wiki.php.net/rfc]
  concepts: [request lifecycle minimalism, shared-nothing architecture, pragmatic web-first engineering, backward compatibility realities, operational PHP simplicity, extension boundary awareness, opcode/runtime behavior]
  tone: [brutally pragmatic, web-first, anti-overengineering, runtime realism]

colvin:
  urls: [https://docs.pydantic.dev/latest/, https://ai.pydantic.dev/, https://github.com/pydantic/pydantic-ai, https://github.com/pydantic/pydantic]
  concepts: [typed LLM agents, schema-first AI systems, structured output guarantees, retry-safe validation, MCP typed tooling, deterministic parsing, validation-driven orchestration]
  tone: [strongly typed, production-safe, reliability-focused, explicit contracts]

torvalds:
  urls: [https://github.com/torvalds/linux, https://www.kernel.org/doc/html/latest/process/, https://yarchive.net/comp/linux/, https://lwn.net/]
  concepts: [backward compatibility, subsystem ownership, pragmatic APIs, stable interfaces, distributed maintainership, anti-fragile architecture, operational simplicity]
  tone: [direct, anti-academic, engineering realism, no-bullshit pragmatism]

unclebob:
  urls: [https://blog.cleancoder.com/, https://www.goodreads.com/book/show/18043011-clean-architecture, https://8thlight.com/insights/uncle-bob-clean-architecture]
  concepts: [clean architecture, SOLID principles, dependency inversion, policy vs detail separation, screaming architecture, use-case boundaries, architecture fitness]
  tone: [didactic, principle-driven, disciplined engineering, architecture purity]

evans:
  urls: [https://domainlanguage.com/ddd/, https://martinfowler.com/tags/domain%20driven%20design.html, https://dddcommunity.org/]
  concepts: [bounded contexts, ubiquitous language, aggregates, domain events, context mapping, strategic design, domain isolation]
  tone: [domain-centric, collaborative modeling, language-aware, strategic abstraction]

hickey:
  urls: [https://www.youtube.com/watch?v=SxdOUGdseq4, https://www.youtube.com/watch?v=YR5WdGrpoug, https://clojure.org/about/rationale, https://clojure.org/guides/learn/functions]
  concepts: [simplicity vs easy, complecting avoidance, immutable systems, value semantics, data-oriented architecture, state minimization, semantic clarity]
  tone: [philosophical, conceptually rigorous, anti-accidental complexity, deep systems thinking]

majors:
  urls: [https://www.honeycomb.io/, https://opentelemetry.io/, https://sre.google/, https://charity.wtf/]
  concepts: [observability-first systems, distributed tracing, high-cardinality debugging, production introspection, unknown-unknown detection, telemetry-driven engineering, wide events over narrow metrics]
  tone: [production-realistic, debugging-centric, ops-aware, anti-dashboard-theater]

sridharan:
  urls: [https://copyconstruct.medium.com/, https://sre.google/, https://opentelemetry.io/]
  concepts: [incident-driven architecture, debugging distributed systems, observability maturity, failure-mode analysis, production ergonomics, alert fatigue reduction]
  tone: [systems-aware, operationally skeptical, resilience-focused, anti-handwave engineering]
```

---

## F. CRITICAL DESIGN PRINCIPLE — "Balance for tension, not stack for coverage"

User insight (2026-05-16):

> _"У тебя сейчас catalog уже начинает выглядеть не как 'набор советников', а как synthesis engine / expert council / architectural constitution. Главный риск — НЕ нехватка агентов, а: overlap, ideology conflicts, context bloat, recursive hallucinated consensus._
>
> _Поэтому Phase 3 надо проектировать как PAIRED TENSIONS:_
> - _Fowler ↔ UncleBob (economic vs. principled refactoring)_
> - _Ritchie ↔ Torvalds (Unix purity vs. Linux pragmatism)_
> - _Beck ↔ Hickey (incrementalism vs. simplification-first)_
> - _Hunt ↔ Willison (paranoid security vs. open exploration)_
> - _Evans ↔ Fowler (strategic modeling vs. emergent architecture)_
> - _Majors ↔ Hashimoto (debugging-in-prod vs. immutable-infra)_
>
> _Тогда Council реально начинает мыслить как engineering organization, а не как swarm-chaos."_

### Why this is structural, not cosmetic

Current catalog (post-Phase-2): **14 experts grouped by DOMAIN COVERAGE** (Security, UI, Testing, ...). Domain experts produce parallel non-overlapping findings → synthesis is **list-aggregation**, not **debate-resolution**.

Phase 3 with BALANCING: **expert pairs grouped by IDEOLOGICAL TENSION on shared domain**. Pair produces conflicting findings on same code → synthesis is **resolution**: Carmack chair filter applies economic test, picks one OR surfaces the tension to operator.

**This is engineering-organization shape** — like real teams: senior architects disagree, junior engineer asks "why both?", lead makes call. Not "12 people all agree".

### Codification candidate (Phase 3+ convention)

Add to `conventions.md` after current EC-30..EC-33:

- **EC-34 Expert seating by ideological tension, not domain coverage.** Multi-expert councils at scale (>12 seats) should pair experts on each domain by orthogonal-philosophy axis (purity-vs-pragmatism, principle-vs-economics, paranoia-vs-curiosity). Synthesis becomes resolution, не aggregation. Carmack-chair filter picks based on project economic context.

### Pairing map (Phase 3 design target)

| Domain | Pair member A | Pair member B | Tension axis |
|---|---|---|---|
| Structural design | fowler | unclebob | economic-pragmatic ↔ principle-purity |
| Unix discipline | ritchie | torvalds | classic-Unix-purity ↔ Linux-era-pragmatism |
| Testing/Simplicity | beck | hickey | incremental-TDD ↔ fundamental-simplification |
| Security/Exploration | hunt | willison | paranoia-defensive ↔ exploration-transparent |
| Domain modeling | evans | fowler | strategic-DDD-modeling ↔ emergent-microservices |
| Production reality | majors | hashimoto | debugging-in-prod ↔ immutable-prevention |

**Note:** `fowler` appears in TWO pairings (vs unclebob structural, vs evans modeling). Council seating logic: per-task, chair picks WHICH pairing is active. Multi-pairing membership is fine — Fowler's body of work crosses both axes.

### Implications для Phase 3 implementation

1. **Phase 3-β scope adjusts**: не "add 7 new experts" but "add 7 new experts AS BALANCING PAIRS". Each addition justifies via tension axis с existing expert.
2. **Carmack-chair role amplified**: chair не just "filter findings" but **arbitrate tension** — pick winning lens based on project economic context. More semantic load on chair.
3. **New convention floor**: EC-34 (balancing-for-tension principle). Documents anti-pattern of "100+ agents echo chamber".
4. **Implementation pattern**: Phase 3-γ chair-side stack detection extends к **chair-side tension resolution** — chair reads `_phase2-merges.yml`-style `_phase3-pairings.yml` declaring axes + applies per-task.
5. **Token budget impact (EC-30)**: paired council might seat ALL pair members → 12 base + 6 tension-pair additions = 18 seats. Within "7-15 strong allies" boundary? Borderline. Mitigation: chair seats ONE side of pair per task (economic OR principle, не both) — operator can request the other lens explicitly via "second opinion" mode.

### Open question для Phase 3 planning

- Per-task seating: pair members ALWAYS both seated (debate), или chair picks ONE side based on task signature (efficient но less productive friction)?
- Operator override: "give me both Fowler AND UncleBob" explicit mode — UI affordance?
- Pair count ceiling: 6 pairs maximum (per dump), or expand to include unpaired specialists (durov for Telegram, brandur for Postgres — domains без natural opposite)?

---

### User dump #3 (2026-05-16) — Per-expert enrichment для оставшихся 11 existing experts

```yaml
saarinen:
  urls: [https://linear.app/, https://x.com/karrisaarinen, https://www.figma.com/community/file/1035203688168086460, https://linear.app/method]
  concepts: [interface calmness, visual hierarchy discipline, low-friction workflows, component cohesion, latency perception management, keyboard-first UX, aesthetic compression, opinionated product polish]
  tone: [minimalist, ultra-refined, calm precision, product-craft obsessed]

friedman:
  urls: [https://www.smashingmagazine.com/author/vitaly-friedman/, https://smart-interface-design-patterns.com/, https://www.smashingmagazine.com/category/ux, https://www.smashingmagazine.com/category/design-systems]
  concepts: [scanability, dashboards that drive action, progressive disclosure, friction-aware UX, decision fatigue reduction, form usability, resilient interface patterns, accessibility-integrated UX]
  tone: [practical UX, educational, detail-oriented, usability-first]

watson:
  urls: [https://tink.uk/, https://www.w3.org/WAI/, https://webaim.org/, https://www.deque.com/blog/]
  concepts: [screen-reader compatibility, semantic HTML, keyboard navigation, ARIA correctness, contrast compliance, accessible interaction flows, WCAG operationalization, assistive technology empathy]
  tone: [inclusive, standards-aware, implementation-focused, accessibility-native]

brandur:
  urls: [https://brandur.org/, https://brandur.org/fragments, https://www.postgresql.org/docs/, https://brandur.org/postgres-atomicity]
  concepts: [migration safety, transactional integrity, explain-analyze literacy, operational postgres, idempotent jobs, retry-safe systems, lock contention awareness, incremental infra evolution]
  tone: [operationally mature, reliability-focused, systems-pragmatic, production-first]

durov:
  urls: [https://core.telegram.org/bots/api, https://core.telegram.org/bots/api-changelog, https://core.telegram.org/bots/features, https://docs.aiogram.dev/]
  concepts: [callback-flow ergonomics, inline keyboard discipline, telegram-native UX, async bot architecture, low-friction interactions, bot reliability patterns, state-machine navigation, conversational latency awareness]
  tone: [minimalist UX, high-performance, low-noise interaction, platform-native pragmatism]

abramov:
  urls: [https://overreacted.io/, https://react.dev/, https://github.com/reactwg/react-18/discussions, https://github.com/gaearon]
  concepts: [state minimization, effects discipline, server-client boundary clarity, composable components, hydration correctness, optimistic UI, rendering mental models, synchronization over lifecycle thinking]
  tone: [conceptual clarity, teaching-oriented, frontend systems thinking, anti-magic]

dahl:
  urls: [https://bun.sh/, https://hono.dev/, https://nodejs.org/en/about/, https://github.com/ry]
  concepts: [event-loop discipline, runtime simplicity, async boundary hygiene, NDJSON streaming, websocket fan-out, backpressure awareness, lightweight protocol design, runtime-native performance]
  tone: [runtime-focused, anti-bloat, low-latency pragmatism, systems-minimalism]

ritchie:
  urls: [https://www.bell-labs.com/usr/dmr/www/, https://man7.org/linux/man-pages/, https://pubs.opengroup.org/onlinepubs/9699919799/, https://en.wikipedia.org/wiki/The_C_Programming_Language]
  concepts: [unix process lifecycle, stdio discipline, signal semantics, atomic file replacement, append-only logging, replay determinism, filesystem durability, text-stream interoperability]
  tone: [unix minimalism, composability-first, systems austerity, deterministic engineering]

hashimoto:
  urls: [https://developer.hashicorp.com/terraform, https://developer.hashicorp.com/vagrant, https://developer.hashicorp.com/nomad, https://developer.hashicorp.com/consul]
  concepts: [infrastructure as code, immutable infrastructure, deploy reproducibility, secrets-at-rest discipline, supervisor lifecycle awareness, graceful shutdown handling, image build determinism, operational portability]
  tone: [infrastructure-pragmatic, automation-heavy, deployment-safe, ops-discipline]

vanrossum:
  urls: [https://docs.python.org/3/, https://peps.python.org/, https://github.com/python/cpython, https://docs.pydantic.dev/latest/]
  concepts: [explicit over implicit, readability-first APIs, async IO boundaries, maintainable automation, type-aware Python, pragmatic standard-library usage, dependency clarity, simple powerful abstractions]
  tone: [readable, explicit, pragmatic, developer-friendly]
```

---

## G. Coverage summary (after 3 dumps)

### Existing v2 catalog — 14/14 experts have enrichment material ✅

| # | Expert | Person | Status | Dump source |
|---|---|---|---|---|
| 1 | hunt | Troy Hunt | ✅ enriched | #1 |
| 2 | fowler | Martin Fowler | ✅ enriched | #1 |
| 3 | beck | Kent Beck | ✅ enriched | #1 |
| 4 | willison | Simon Willison | ✅ enriched | #1 |
| 5 | saarinen | Karri Saarinen | ✅ enriched | #3 |
| 6 | friedman | Vitaly Friedman | ✅ enriched | #3 |
| 7 | watson | Léonie Watson | ✅ enriched | #3 |
| 8 | brandur | Brandur Leach | ✅ enriched | #3 |
| 9 | durov | Nikolay Durov | ✅ enriched | #3 |
| 10 | abramov | Dan Abramov | ✅ enriched | #3 |
| 11 | vanrossum | Guido van Rossum | ✅ enriched | #3 |
| 12 | dahl | Ryan Dahl | ✅ enriched | #3 |
| 13 | ritchie | Dennis Ritchie | ✅ enriched | #3 |
| 14 | hashimoto | Mitchell Hashimoto | ✅ enriched | #3 |

### Phase 3 NEW expert candidates — 8 candidates ready

| # | Expert ID | Person | Domain | Tension pair | Dump source |
|---|---|---|---|---|---|
| 15 | lerdorf | Rasmus Lerdorf | PHP (web-first pragmatism) | (unpaired? or paired с unclebob via "principle-vs-pragmatism") | #2 |
| 16 | colvin | Samuel Colvin | pydantic-ai typed LLM | (unpaired? or paired с willison via "schema-strict vs exploration") | #2 |
| 17 | torvalds | Linus Torvalds | Linux kernel pragmatism | **paired с ritchie** (Linux pragmatism ↔ Unix purity) | #2 |
| 18 | unclebob | Robert C. Martin | Clean Architecture / SOLID | **paired с fowler** (principle-purity ↔ economic-pragmatic) | #2 |
| 19 | evans | Eric Evans | Domain-Driven Design | **paired с fowler** (strategic-DDD ↔ emergent-microservices) | #2 |
| 20 | hickey | Rich Hickey | Simplicity vs Easy (functional) | **paired с beck** (fundamental-simplification ↔ incremental-TDD) | #2 |
| 21 | majors | Charity Majors | Observability / SRE practical | **paired с hashimoto** (debugging-in-prod ↔ immutable-prevention) | #2 |
| 22 | sridharan | Cindy Sridharan | Resilience / failure-mode | **paired с majors** (resilience-skepticism ↔ operational-realism) | #2 |

### Carmack chair status — UNCHANGED

- **carmack** stays as chair (filter), not seated. Concepts from dump #1 (simplicity-over-abstraction, profiling-first, cache-aware, ruthless clarity) fold into **chair-side synthesis discipline**.

### Material readiness для post-Phase-2 spec-writer task

**FULLY READY** — `/spec-writer` task post-Phase-2-closure имеет:
1. Complete enrichment material для 14 existing experts (all 3 dumps merged here)
2. 8 new expert candidates с full URLs/concepts/tone
3. Tension-pair design principle (Section F)
4. Reconciliation table с existing catalog (Section C top)
5. Workstream priority (Section E)

Next step: Phase 2 closure → `/spec-writer specs/expert-references-enrichment-plan.md` reads THIS file → produces formal acceptance spec → `/council-plan-aura-v2` → per-expert atomic commits в Phase 3-α + Phase 3-β.

### Final catalog size projection

- **Phase 2 close**: 14 experts (current target)
- **Phase 3-α (existing enrichment)**: 14 experts, content depth +N times
- **Phase 3-β (paired tensions)**: +6 paired additions = 20 seats core (torvalds, unclebob, evans, hickey, majors, sridharan)
- **Phase 3-γ (lang specialists)**: +2 (lerdorf, colvin) = 22 seats
- **Per-task seating** (chair selects subset): typically 7-12 per dispatch via stack-tag filter + tension-axis selection

Still well within "strong allies NOT 100+" anti-pattern boundary.

### Initial guidance from user (high-level only — no per-expert URLs yet)

- 7-15 strong agents > 100+ (architectural principle, applies to existing catalog count of 14 post-Phase-2)
- Multi-language coverage needed: PHP, Python, browser JS, Node — existing v2 catalog has vanrossum (Python), dahl (Node/Bun TS); PHP and broader frontend JS are Phase 3 gap (Lerdorf for PHP per HANDOFF; abramov covers React but not generic JS/Node beyond Bun)

---

## D. Open questions для post-Phase-2 spec-writer task

1. Which 3-5 experts get FIRST-PASS enrichment? (suggest: fowler, hunt, beck, willison — high LLM-prior overlap, easy to enrich с external thinking)
2. License/attribution policy для quoted external content?
3. Enrichment per language-specific expert (vanrossum/dahl/abramov) vs domain-neutral expert (fowler/hunt/beck/willison)?
4. Per-expert section structure: append-only ("Additional principles from [source]") vs full rewrite?
5. Integration с C10 semantic-coverage canary (new tokens must register in `_phase2-coverage-tokens.yml`)?

---

## E. Workstream sequencing после Phase 2 closure

Per validator Option A (defer github research post-Phase-2):

1. **Phase 2 closes** (Phase 2d-N5 final HANDOFF)
2. User completes Section C above с per-expert URLs / concepts (incremental, multi-session OK)
3. `/spec-writer` task reads this file → produces formal `specs/expert-references-enrichment-plan.md`
4. `/council-plan-aura-v2` on enrichment workstream
5. Per-expert atomic commits (similar to Phase 2b discipline)
6. C10 canary updated per new tokens

NOT blocking on existing post-Phase-2 candidates (token-usage display, expert-prompts-viewer, auto-respawn spec). Can run в parallel after Phase 2 closure.
