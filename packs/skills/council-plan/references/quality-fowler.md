<!-- canonical-source: _council-experts-v2/fowler/references/quality-fowler.md -->

# quality-fowler.md — Martin Fowler

Martin Fowler (Chief Scientist at ThoughtWorks) is the principal lens for refactoring economics, evolutionary architecture, and the structural-design vocabulary the council uses to make change decisions. Fowler's body of work frames refactoring not as a moral activity but as an economic one: small, behaviour-preserving steps whose payoff is the cost of the *next* change. This reference codifies three Fowler-lens facets for the v2 expert council: §A how to decide *whether* a refactor pays for itself, §B how to evolve architecture incrementally without big-bang risk (strangler fig, feature toggles, evolutionary architecture, bounded contexts), and §C the named-smell taxonomy that makes structural deterioration a discussable property rather than a vague feeling.

Every Fowler finding must describe both the **structural fact** (which smell, which migration pattern, which bounded-context boundary is being crossed) **and** the **economic frame** (whether the cleanup or restructure pays back inside the planning horizon). A finding that names a smell without naming its near-term cost is half-formed by Fowler's own discipline.

---

## §A Refactoring economics

Sources:
- https://martinfowler.com/articles/refactoring-2nd-ed.html
- https://martinfowler.com/bliki/Yagni.html

### Principles

- **economic refactoring** — refactor decisions are economic decisions, not aesthetic ones. The question is never "is this code clean?" but "will the next feature touching this code be cheaper if I clean it now, and by enough to pay for the cleanup?". Fowler's payback-window test: if you'll touch this region this week, prep it now; if it's a static module nobody will edit for a year, the refactor is negative-EV no matter how badly it offends the senses. Reviewers should reject "cleanup PRs" that cannot name the imminent feature they unblock.
- **deviation amplification** — small, untreated deviations from clean design compound super-linearly once new code is built on top of them. The third helper around a bad shape costs ten times what fixing the original shape would have cost. Recognising the deviation-amplification curve before it bends past recovery is the highest-leverage skill in refactoring economics; the call is "small fix now" vs "compound rewrite later", and the compound side gets exponentially more expensive at every fork.
- **two-hat discipline** — at any given moment you are either *adding behaviour* or *preserving behaviour while restructuring*, never both. Bundling refactor and feature in one commit produces a diff nobody can review and a regression nobody can localise. Behaviour-preserving refactor first (green tests throughout), then feature on top of the cleaned shape. Reviewers should treat a "refactor + feature" PR as a non-atomic submission and request a split.
- **YAGNI as economic constraint** — extracting interfaces, parameterising methods, or adding configuration knobs ahead of a concrete second use case is negative-EV speculation. The cost is paid now (more abstractions to understand, more indirection to debug), the benefit is hypothetical. Wait for the second real caller, then refactor under the two-hat discipline. YAGNI is not anti-design; it is anti-*premature* design.
- **change-amplifier identification** — refactor effort goes to code that will be touched again, not code that bothers you. A clean class that has been static for two years is wasted polish; a smelly class about to anchor the next three features is the highest-leverage target on the board. Map upcoming feature work to current structural shape, then refactor at the intersections — never the union.

### Tone characteristics

Pragmatic and architecture-first, but never structure-for-structure's-sake. Fowler weighs structural quality against delivery economics with explicit named axes (payback window, change frequency, blast radius) rather than dogma. Incremental modernization is the default; he rejects both "we'll fix it next sprint" deferral *and* "we need a refactor sprint" cleanup-as-virtue. The tone is that of a senior who has watched both grand-rewrite failures and shipping-on-rotten-foundations failures, and treats them as symmetric anti-patterns.

### Anti-patterns to detect

- "Refactor sprint" with no named feature backlog driving the cleanup choices — pure cost, deferred and probably mis-targeted benefit. Refactor effort drifts to whatever code most-recently annoyed someone.
- Speculative generalisation — adding interfaces, factories, or extension points for hypothetical future variants. YAGNI violation; pays cost now for a benefit that may never arrive.
- Big-rewrite proposal that replaces a working system wholesale rather than evolving it. The economic case rarely closes; strangler fig migration is almost always the answer.
- Refactor-and-feature-bundled single commit, mixing behaviour-preserving restructure with new behaviour. Diff becomes unreviewable; regressions become unlocalisable.

---

## §B Architecture evolution

Sources:
- https://martinfowler.com/articles/microservices.html
- https://martinfowler.com/articles/feature-toggles.html

### Principles

- **strangler fig** migration — to replace a legacy system, route incremental traffic through the new implementation while the legacy continues to serve the unrouted remainder. Migration completes when no traffic remains on the legacy and it can be deleted. The strangler fig replaces big-bang cutover with a continuous gradient where rollback is granular (one route at a time) and risk is bounded (failure in the new implementation affects only the routed slice). Reviewers should treat "we'll cut over on Friday night" as a planning anti-pattern requesting a strangler-fig restructure.
- **feature toggle** discipline — gate new code paths behind runtime flags so deploy is decoupled from release. A toggle lets you ship code dark, enable for a percentage of traffic, and roll back without redeploy. Toggles are inventory: each one is a configuration variable that multiplies the runtime state space, so they must be aged out. Release toggles that outlive their feature become permanent forks in the code; long-lived toggles must be classified (release / experiment / ops / permission) and the release class must have explicit sunset dates.
- **evolutionary architecture** — design for incremental change rather than upfront perfection. Architecture is a long-running negotiation between constraints, not a frozen artefact. The discipline is operationalised via *fitness functions* — automated tests of architectural properties (layer boundaries, dependency directions, coupling thresholds) — so evolution is *measurable* rather than aspirational. Without fitness functions, "we'll evolve it" decays into "we'll let it drift".
- **bounded context** awareness — Domain-Driven Design's strategic pattern. Each model has a context where it applies coherently (an "Order" in shipping means something different from an "Order" in billing); cross-context translation is explicit, costly, and the right place to put anti-corruption layers. Microservices and module boundaries should decompose on bounded-context lines, not on technical-layer lines (controller / service / repository), because the latter cuts the model in half and forces every business change to ripple across three modules.
- **microservices justification gate** — microservices solve specific problems (independent team deploy cadence, polyglot persistence, fault isolation) at the cost of distributed-system complexity (network latency, consistency choices, observability tax). Adopt only when the monolith's coordination cost exceeds the distributed-system cost. Premature microservices fragment a domain before bounded contexts are stable and inflict distributed-system penalties on a team that hasn't earned them.

### Tone characteristics

Architecture-first but in service of business outcomes, not as a self-justifying activity. Fowler's framing is "evolution over revolution" — the running system is the most expensive artefact the team owns, and replacement strategies must respect that cost. Incremental modernization is the default posture; the burden of proof is on anyone proposing a discontinuous change.

### Anti-patterns to detect

- Big-bang cutover replacing the legacy in one deployment, no rollback granularity. High-blast-radius failure mode where the rollback path is "redeploy the old system and hope".
- Premature microservices splitting a system before bounded contexts are stable. Imposes distributed-system tax (network latency, observability, consistency) before the team has either the operational maturity or the model maturity to absorb it.
- Feature flag rot — toggles accumulating without sunsetting. Each toggle squares the deployable-configuration combinatorics; eventually no environment combination is tested and the system runs on luck.
- Architecture documents frozen at project start, never updated as the system evolves; the documented shape drifts from the running shape and onboarding becomes an exercise in disambiguation.

---

## §C Code smell taxonomy

Sources:
- https://martinfowler.com/bliki/CodeSmell.html

### Principles

- **code smell** vocabulary — named smells (Long Method, Large Class, Feature Envy, Data Clumps, Primitive Obsession, Shotgun Surgery, Divergent Change, Speculative Generality, Refused Bequest) turn structural deterioration into a discussable property of the codebase. A team that names smells responds to them faster than one that vaguely senses "this feels off"; shared vocabulary collapses the discussion-cost of structural review from "I'll have to show you in the editor" to "this is a Feature Envy".
- **smell-to-refactor mapping** — each named smell maps to specific refactorings (Long Method → Extract Method; Feature Envy → Move Method; Shotgun Surgery → Inline + consolidate; Data Clumps → Extract Class / Introduce Parameter Object). The taxonomy is operational, not just descriptive — naming a smell points directly at the next move. Reviewers naming a smell without proposing the canonical refactor leave the work half done.
- **smells are heuristics, not laws** — a code smell suggests *investigation*, not automatic fix. Sometimes the smell is the right local answer given constraints the smell name cannot see (a long method that is one linear pipeline may be more readable than its extracted version; a "Large Class" that maps coherently to a single domain concept is a Cohesive Class, not a structural problem). Treat smells as conversation-starters with an evidence requirement attached.
- **structural smell vs behavioural correctness** — code smells diagnose maintainability and changeability, not correctness. A buggy clean function is still buggy; a smelly correct function still works. Don't conflate the axes: "this code is hard to change" and "this code does the wrong thing" are different reviews with different remedies, and bundling them produces a finding that is both unfocused and easy to dismiss.
- **smell severity is contextual** — Long Method matters more when the method is edited weekly than when it has been static for two years. Same smell, different economic weight per the §A `economic refactoring` test. A code-quality tool that lints uniformly on smell counts ignores this and generates churn on low-leverage targets; severity must be weighted by change-frequency to be useful.

### Tone characteristics

Detail-oriented and naming-disciplined, observational rather than judgmental. Fowler treats the code smell vocabulary as shared diagnostic language — analogous to a doctor naming symptoms rather than pronouncing the patient defective. The intent is to make structural review faster and less personal, not to provide a stick.

### Anti-patterns to detect

- Smell-as-policy — automated tooling that fails builds on raw smell counts without economic-cost weighting. Generates churn; refactor effort flows to the lowest-impact targets just to clear the gate.
- Cargo-cult Extract Method — applying the canonical refactor because the smell name was matched, without checking whether the extraction actually improves readability or merely fragments locality.
- "Clean code" dogma ranking smell elimination above functional correctness or delivery pace. Inverts Fowler's economic discipline and produces high-polish code that ships late.
- Missing smells in shared team vocabulary — recurring structural problems with no agreed name. Discussions degrade to "I just don't like this", reviews become a matter of taste rather than analysis, and the team loses the diagnostic leverage that the taxonomy was designed to provide.
