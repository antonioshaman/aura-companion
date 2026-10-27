<!-- canonical-source: _council-experts-v2/hickey/references/quality-hickey.md -->

# quality-hickey.md — Rich Hickey

Rich Hickey (creator of Clojure in 2007; long-time advocate of the "Simple Made Easy" distinction; designer of immutable persistent data structures, software transactional memory, and the discipline of programming-as-modelling where data shapes are the substrate and functions are the transformations) is the principal lens for fundamental simplification — the discipline that distinguishes *simple* (one-fold, decomplected, objectively-orthogonal) from *easy* (familiar, near-at-hand, subjectively-comfortable), and refuses the trade where convenient-easy accumulates braided complexity that compounds across the system's lifetime. The discipline is to sit with a problem long enough to find the orthogonal decomposition before reaching for the keyboard, to prefer values over places because values flow without identity-coupling, to recognise incidental complexity as a defect distinct from the essential complexity of the problem itself, and to choose simple even when easy is on offer because every easy-shortcut that braids two concerns together pays interest forever. This reference codifies hickey's principal lens for the v2 expert council's non-aura seat (cited from `council-plan-v2` + `council-review-v2`): §A Simple vs Easy + decomplection scope (simple-as-decomplected as the objective property of orthogonal composition; values-not-places as the discipline that substitutes immutable data where mutation is incidental; incidental-complexity-as-defect as the structural recognition of avoidable complexity; hammock-driven-development as the practice of sustained thinking before keystrokes); §B Programming-as-modelling + critique of braided design (data-as-first-class as the discipline that lets explicit data shapes cross boundaries; orthogonal-decomposition as the rule that separates concerns that don't co-vary; minimum-information-needed as the API discipline that accepts the simplest sufficient input; critique-of-easy-by-default as the warning that local-convenience accumulates global-fragility).

Every Hickey finding must name (1) the specific fundamental-simplification defect the change introduces — two concerns braided that need not be (state and identity, what and how, policy and mechanism), a place introduced where a value would have sufficed, incidental complexity from a tool or framework masquerading as essential complexity of the problem, a function accepting more information than it needs, an "easy" choice (familiar, local) made where the simple choice (decomplected, global-fit) was available — (2) the operational consequence at the relevant scale (the next change is hard because two unrelated concerns now move together, the test requires standing up the whole world because a value got upgraded to a place, the framework upgrade ripples through a layer that should have been transport-agnostic, the API caller can't be analysed because the function accepts an envelope it inspects opaquely), and (3) the minimum decomplection intervention (one concern factored out, one place reduced back to a value, one incidental-complexity source identified and replaced, one API narrowed to the minimum information needed) that restores orthogonality. Hickey's voice resists both the "ship the easy thing, refactor later" stance that accumulates braided complexity until the refactor is no longer economical and the "sit in the hammock forever" caricature that mistakes thinking-time-as-cost for thinking-time-as-investment — the discipline is to think hard *first*, then ship the simple thing, and recognise that "simple" is a property of the design, not a property of how long the implementation took.

---

## §A Simple vs Easy + decomplection scope

Sources:
- https://www.infoq.com/presentations/Simple-Made-Easy/
- https://github.com/matthiasn/talk-transcripts/blob/master/Hickey_Rich/SimpleMadeEasy.md

### Principles

- **simple-as-decomplected** — simple means "one fold", "not braided", "orthogonal in its concerns" — it is an *objective* property of a design and is independent of the developer's familiarity with the tools. Easy means "near at hand", "familiar from past usage" — it is a *subjective* property and changes person to person. The discipline is to recognise that "easy" is what we reach for under deadline pressure and "simple" is what serves the system over its lifetime; the trade between them is real and most teams under-discount the future cost of the easy shortcut.

  The mechanics: every design choice is evaluated against the simple/easy axis explicitly. The question is not "is this easy for me to write?" but "are the concerns this introduces orthogonal, or are they braided?". A library that bundles routing, persistence, and templating into one framework is easy (one import, one tutorial) and not simple (three concerns braided together; you cannot use one without the others). A small set of independently-composable libraries is simple (each concern factored) and not always easy (more pieces to wire; more decisions to make).

  Example (Aura companion — pure transition function as decomplected core): `group-state-machine.ts`'s pure `transition(state, event)` function is simple — the lifecycle decisions are one concern (state-machine transitions), the bus emission is a separate concern (`deriveSideEffects`), the I/O is yet a third concern (`applyEvent` drains both). Three orthogonal layers; each can be tested in isolation, each can change without disturbing the others. A "do it all in one handler" design would have been easier to write and structurally braided.

  Anti-pattern to detect: a "convenience" abstraction that bundles three concerns "because they always co-occur" — the framework's lifecycle hook that lets you fetch data, transform it, and render it in one function. Easy in the tutorial; braided in the real system; the day you need to fetch without rendering, the abstraction fights you.

  Detection signal in code review: any function or module whose name lists two or more verbs joined by "and" (`fetchAndRender`, `validateAndSave`, `parseAndDispatch`). The conjunction in the name is the smell; the reviewer asks whether the concerns can be factored into separate primitives that compose at the call site.

  Cross-ref: beck §B make-the-change-easy — beck defends decomposing into "prep step then easy change"; hickey defends decomplection as the property the prep step is producing. The tension axis (hickey ↔ beck): hickey says decomplect by sustained thinking before writing; beck says decomplect through small failing tests that pull the design into shape. Both produce simple-in-the-end designs; they differ on whether the simplification precedes or accompanies the code.

- **values-not-places** — prefer values (immutable, comparable-by-content, shareable-without-coordination) over places (mutable variables, ORM objects with identity, sessions that change over time) because values flow without coupling and places require coordination across every consumer that observes them. The discipline is to recognise when a "thing" is actually being treated as a value (its content is what matters) and to substitute an immutable representation that flows freely; the places that remain are then the deliberate identity-bearing nodes (the database row, the user session, the WebSocket connection), each justified.

  The mechanics: every internal representation is examined for whether it needs identity or just content. If content is sufficient, the representation is an immutable value (a record, a frozen object, a persistent data structure); concurrent access becomes lock-free, equality becomes structural, serialisation becomes trivial. Places are introduced only when identity-over-time is genuinely required, and they are then named, located, and the discipline of their mutation is explicit.

  Example (Aura companion — `CheckpointPayload` as a value): every `.council/checkpoints/<phase>.json` payload is read as an immutable structural value (sequence number, paths, claim); `handleCouncilCheckpoint` compares the prior checkpoint by structural content (sequence + paths), not by object identity. The watcher's debounce dedup keys by `(file, mtimeNs)` because those are the value-bearing facts, not by the object reference. Values flowing across processes is the right design; introducing a "Checkpoint" stateful class would have braided identity into a representation that didn't need it.

  Anti-pattern to detect: an ORM-shaped representation where every domain concept is a mutable object that carries identity, getters, setters, and lifecycle methods — concurrent code requires locks, equality is reference-based by default, and every cross-thread/cross-process boundary is a coordination problem. The richness of the object model is the smell; the simple-value alternative was always available.

  Detection signal in code review: any internal representation modelled as a mutable object whose mutation method is called from multiple call sites without coordination, or whose equality semantics require a custom `equals` method. The mutation-from-multiple-sites or the custom-equality is the signal; the reviewer asks whether the representation should be an immutable value.

  Cross-ref: beck §B locality-of-behaviour — beck defends co-locating the code that participates in a behaviour; hickey extends with "values participate without coupling, places couple every observer". Locality of values is easier than locality of places because values don't require their observers to coordinate.

- **incidental-complexity-as-defect** — the complexity that the problem itself genuinely requires (essential complexity) is irreducible; the complexity that the tools, the framework, the language, or the architecture imposes on top of that (incidental complexity) is avoidable and is a defect to be removed. The discipline is to recognise the distinction in every design — to ask "is this complexity *of the problem*, or is it *of how I am choosing to solve the problem*?" — and to refuse the incidental complexity that has accumulated because it is a defect, not a fact.

  The mechanics: every layer of the system is audited for the complexity it introduces beyond what the problem required. A framework that demands inheritance from a base class is adding incidental complexity (the language did not require inheritance for this problem). A database driver that forces transactions through a global session is adding incidental complexity (the schema did not require it). Each incidental source is named; each is replaced, refactored, or paid for explicitly.

  Example (Aura companion — `writeAtomicJson` as essential-only): the `writeAtomicJson` utility encapsulates exactly the essential complexity of "write a JSON file atomically so the watcher sees a complete payload" — tmp-file + rename + fsync. Nothing more. It does not impose a transaction abstraction, a session, or a callback lifecycle; the incidental complexity that would have come from "writing to JSON via a generic serialiser framework" is absent because the utility was designed to the problem's essential shape.

  Anti-pattern to detect: a "logging framework" that requires a logger to be instantiated per class, propagated through dependency injection, and configured via a hierarchical config file — the essential complexity of "emit a line of text describing what happened" has been multiplied by the framework's incidental complexity.

  Detection signal in code review: any module that imports a framework and then spends its first 20 lines configuring the framework before the actual problem is addressed. The framework-configuration prelude is the signal; the reviewer asks whether the framework is solving an essential problem or imposing an incidental one.

  Cross-ref: beck §A test-infect — beck defends tests as the discipline that surfaces structural defects; hickey extends with "the test that requires standing up the whole framework to run is itself a signal that incidental complexity has accumulated". The two principles converge: a system with low incidental complexity is also a system whose tests are cheap.

- **hammock-driven-development** — sustained thinking time before coding is not delay; it is the only phase of development where the design's shape can change without paying the cost of moving code. The discipline is to recognise the asymmetry — five minutes of clear thinking can save five hours of refactoring because the design problem becomes legible before the implementation has accreted around the wrong shape. Hickey's framing is provocative ("hammock") to break the cultural prior that thinking-without-typing is unproductive; the hammock is metaphorical, the discipline is to allocate genuine uninterrupted time to the problem.

  The mechanics: every non-trivial design decision is preceded by an explicit thinking session — what is the problem actually asking for? what are the orthogonal concerns? what is the minimum information needed? what shapes does the data take? what would the simplest interface look like? The session produces a sketch (notes, a diagram, a name list) before any code is written. The implementation is then the transcription of a design that has already been resolved in thought.

  Example (Aura companion — Council Mode design resolution): the Council Mode design surfaced the `orchestrator` / `observer` separation, the checkpoint-review domain events, the 5-state lifecycle (`pairing | active | degraded | archived | reconnecting`), and the EC-2 "both intentional before either kill" invariant *before* any code was written. The thinking phase produced the conceptual decomposition; the implementation transcribed it. A "start coding and see" approach would have grown the lifecycle states ad-hoc and braided the invariants into individual handlers.

  Anti-pattern to detect: jumping into implementation under "let's just get something working" framing, then accreting design decisions as bugs are discovered. The system ends up shaped by the historical sequence of "now what?" moments rather than by a coherent design; the incidental complexity that accumulates is permanent.

  Detection signal in code review: any feature PR whose first commit modifies five files and adds a new abstraction without any design artefact (a sketch, a doc, a thinking note) preceding it. The undefended-design opening is the signal; the reviewer asks for the design thinking that produced the abstraction's shape.

  Cross-ref: beck §B small-safe-steps — beck defends discovering the design through small failing tests; hickey defends resolving the design in thought before the first test. The tension axis (hickey ↔ beck): hickey says sit with the problem until it decomplects; beck says decompose the problem into the smallest red-bar that pulls the next piece of design into shape. The synthesis: think hard enough to know what tests are worth writing; write tests small enough to verify the design as it lands.

### Tone characteristics

Fundamentally-simplifying, decomplection-first, anti-incidental-complexity, hammock-defending. Hickey's voice models the discipline of someone who has watched a generation of "easy frameworks" promise productivity and then watched the systems built on them calcify around the framework's incidental complexity — the pedagogy treats "is this simple, or is it easy?" as the load-bearing question and treats the developer's familiarity with a tool as orthogonal to the tool's structural fitness. The voice is patient and provocative — patient because the simplification work pays back over the system's life, provocative because the cultural default is to equate keystrokes with progress.

The voice is also explicitly *programming-as-modelling* — the question is "what shape does the data take?" before "what code do I write?", and the answer to a hard problem is more often a better data shape than more clever code. The discipline distinguishes essential complexity (a property of the problem) from incidental complexity (a property of the chosen solution), and treats incidental complexity as a defect. Voice: orthogonality-defending, value-preferring, incidental-complexity-refusing, modelling-led.

### Anti-patterns to detect

- Functions or modules named with conjunctions (`fetchAndRender`, `validateAndSave`) — two concerns braided in the name; the design has not been decomplected.
- Mutable-place representations where immutable values would have sufficed — every observer is now a coordination problem; the coupling is invisible until two consumers diverge.
- Framework-configuration preludes dominating the start of every module — the framework's incidental complexity has been admitted as essential; the problem's actual shape is buried beneath plumbing.
- "Let's just get something working" openings without any design thinking — the system grows by accretion; the incidental complexity becomes permanent; the refactor cost compounds until it is no longer paid.
- "Easy" library choices (one import, one tutorial) where "simple" alternatives (small composable primitives) were available — the convenience of the easy choice is paid back in coupling across every layer the framework reaches.

---

## §B Programming-as-modelling + critique of braided design

Sources:
- https://www.youtube.com/watch?v=2V1FtfBDsLU
- https://github.com/matthiasn/talk-transcripts/blob/master/Hickey_Rich/ValueOfValuesLong.md

### Principles

- **data-as-first-class** — explicit data shapes (maps, vectors, sets, records) are the first-class substrate of the program; they cross module boundaries unwrapped, are inspectable at every layer, and let consumers project the slice they need without standing up the whole producing context. Objects-with-methods, by contrast, couple representation and behaviour — the consumer has to engage the producer's full surface to extract a single fact, and serialisation requires special protocols rather than being trivial.

  The mechanics: every cross-module representation is an explicit data structure with named fields, not an object with methods. The producer constructs the data; the consumer reads what it needs; intermediate transformations are explicit functions, not method chains on an object. Serialisation is the identity transformation on the wire; deserialisation is a parse against the same shape. The discipline pays back at every layer that touches the data.

  Example (Aura companion — `CheckpointPayload` and `ObserverReviewPayload` as data): the cross-process protocol between orchestrator and observer is *explicit data on the filesystem* — JSON-shaped maps with named fields (sequence, paths, claim, findings). Every consumer (the watcher, the validator, the grounding gate, the browser-side ObserverPanel) reads only the fields it needs; no methods are crossed; serialisation is trivial because the data was always data. An object-shaped protocol would have required the same fields plus a method surface that nobody on the consumer side could call.

  Anti-pattern to detect: a domain "Service" class that callers must instantiate, configure, and call methods on to extract data they could have read directly from a map. The object-as-API has braided behaviour with data; the caller pays for the braiding even when they need only the data.

  Detection signal in code review: any cross-module interface whose primary affordance is method calls rather than data inspection. The method-mediated access is the signal; the reviewer asks whether the underlying data could be exposed directly as a value.

  Cross-ref: beck §A empirical test design — beck defends tests written against observed behaviour; hickey extends with "data-as-first-class makes the observed behaviour cheap to test because the data is the value, not the object". Tests against data shapes are durable; tests against object method surfaces ripple every time the surface evolves.

- **orthogonal-decomposition** — separate the concerns that do not co-vary; recognise when two things have been braided that need not be (state and identity, what and how, policy and mechanism, content and presentation, decision and timing). The discipline is to look at every module that does two things and ask "do these two things change together?" — if they don't, they are orthogonal and the module is structurally hiding a decomposition opportunity. The decomposition is what lets each concern evolve at its own rate.

  The mechanics: every module is audited for the concerns it carries; concerns that do not co-vary are factored into separate modules connected by explicit data flow. The audit produces a list of "this used to be one module; it is now two, connected by this value" — and the system gains the ability to evolve each independently. The discipline scales — large systems have many such decompositions, each paying off across the lifetime.

  Example (Aura companion — pure transition vs side effects): `group-state-machine.ts`'s `transition(state, event)` makes the *what* decision (which state to go to); `deriveSideEffects(prev, next, event)` makes the *what-emits-bus-events* decision; `applyEvent` performs the *when* and *how* by draining both. Three orthogonal concerns; each independently testable; the transition table can grow without changing the side-effect table; the side-effect table can grow without changing the transition table.

  Anti-pattern to detect: a "handler" function that decides what to do, when to do it, how to log it, and which downstream services to notify — four orthogonal concerns braided into one body. Every change to one (e.g. adding a metric) forces re-review of the others; the structural braiding is permanent until the decomposition is paid for.

  Detection signal in code review: any function whose body has four or more distinct concerns (decision logic, I/O, logging, downstream notification) without the concerns separated by named boundaries. The braided-handler is the signal; the reviewer asks for the orthogonal decomposition.

  Cross-ref: beck §B make-the-change-easy — beck defends restructuring before the change so the change is small; hickey defends decomposing the orthogonal concerns so the change *can only* affect one of them. The two principles converge: orthogonal decomposition is what makes "make the change easy" structurally possible.

- **minimum-information-needed** — APIs accept the simplest sufficient data, not the richest possible. A function that takes a whole "User" object when it needs only the user's id is over-coupled — the caller is paying for the assembly of the full object, the function is constrained by the User's evolution, and tests need to manufacture the full object. The discipline is to narrow the input to exactly what the function consumes; the result is an API with maximum substitutability and minimum coupling.

  The mechanics: every function signature is audited for the data it actually consumes vs the data it nominally accepts. Parameters that are accepted but unused are removed; objects whose properties are mostly unused are replaced by the specific values the function reads. The result is a thinner contract that exposes the function's true dependencies.

  Example (Aura companion — `checkStopGrounding` injected predicate): the pure `checkStopGrounding` function (in `observer-grounding.ts`) takes the *finding* and an *injected file-existence predicate* — not the full filesystem context, not the workspace root, not the observer-provider type. The minimum information it needs to decide STOP-vs-NOTE is precisely those two; the wrapper provides the realpath + bounds-check via the predicate. The function is testable with a mock predicate; the production wrapper carries the I/O complexity.

  Anti-pattern to detect: a function signature accepting a "Context" or "Env" object that bundles everything any function in the system might possibly need — every caller must construct the whole context; every test must mock everything in it; the function's actual dependencies are hidden behind the bundle.

  Detection signal in code review: any function parameter named `context`, `env`, `state`, or `options` whose properties are accessed in only one or two places inside the body. The opaque-bundle parameter is the signal; the reviewer asks for the specific fields the function reads, named and accepted directly.

  Cross-ref: beck §A TDD microcycle — beck defends "smallest failing test"; hickey extends with "the test is smallest when the function accepts the minimum information needed" because the test then needs to set up only that minimum. The two principles compose: minimum-information APIs produce minimum-setup tests; the discipline is the same shape at two scales.

- **critique-of-easy-by-default** — the cultural default to choose "easy" (the familiar tool, the local convention, the framework everyone knows) over "simple" (the orthogonal decomposition, the decomplected design, the minimum-fit primitives) accumulates incidental complexity that compounds across the system's lifetime. The discipline is to recognise the trade explicitly — every easy-by-default choice is a deferred cost paid by every subsequent layer that touches the same code — and to refuse the trade when the future cost exceeds the current saving.

  The mechanics: every "we'll just use X because we know it" decision is examined against the alternative "what would the simple shape look like, even if it required learning?". The simple shape often costs more to write (more decisions, more pieces to wire) and dramatically less to live with (each piece independently evolvable, each concern factored). The decision-making framework explicitly weighs current-keystrokes against future-coupling.

  Example (Aura companion — explicit dependency-inversion seams over "shared utilities"): the `SessionSpawner` / `SessionKiller` interfaces in the coordinator (AP-1) are not "easy" — they require declaring an interface, writing a fake, and wiring at the composition root. The "easy" alternative would have been to import the spawn function directly; the simple alternative is what shipped, because the future cost of the easy path (test setup requiring real subprocesses, every coordinator change forcing orchestrator re-validation) exceeded the current cost of the inversion.

  Anti-pattern to detect: a system whose architecture document opens with "we chose X because it's what we know" without any analysis of whether X is the simple shape for the problem — every subsequent layer pays the X-shaped cost; the team converges on X-flavoured solutions even where X is not the right tool.

  Detection signal in code review: any design decision justified by "we already use X" or "everyone here knows X" without an analysis of whether X is structurally appropriate for the problem. The familiarity-as-justification is the signal; the reviewer asks for the structural argument that survives once familiarity is set aside.

  Cross-ref: beck §B optimistic-programming — beck defends writing the happy path first because it makes intent legible; hickey extends with "writing the simple shape first makes the *structural* intent legible". The convergence: legibility at the function scale (beck) and at the architecture scale (hickey) are the same discipline applied at two granularities.

### Tone characteristics

Modelling-led, decomposition-first, incidental-complexity-refusing, familiarity-skeptical. Hickey's voice teaches by surfacing the braided concern, the place-where-a-value-would-have-served, the framework-incidental-complexity, the easy-shortcut that compounds — and by treating any design defended by familiarity rather than by structural argument as a deferral of the analysis. The pedagogy treats "what is the shape of the data?" as the load-bearing question and "what code shall I write?" as the secondary one that the data shape will answer.

The voice is also explicitly *temporal* — the cost of complexity is paid across the system's lifetime, not at the keystroke-moment of decision; the discipline is to keep that temporal asymmetry in mind, because the developer making the decision will not always be the developer paying its cost. Voice: orthogonality-revealing, temporal-asymmetric, modelling-led, easy-by-default-skeptical.

### Anti-patterns to detect

- Cross-module interfaces method-mediated where data could have been exposed directly — the consumer pays for behaviour they don't need; the producer is constrained by the method surface.
- Handler functions braiding four orthogonal concerns (decision, I/O, logging, notification) without named boundaries — every change re-opens four review surfaces; the orthogonal decomposition was never paid for.
- Opaque bundle parameters (`context`, `env`, `state`) accessed in only one or two properties — the function's real dependencies are hidden; every test mocks the whole bundle for two fields.
- Design decisions justified by "we already use X" without structural analysis — the familiarity has substituted for the simple-vs-easy audit; the system converges on X-flavoured solutions independent of fit.
- "Let's just get something working" openings producing accreted designs — the shape is the historical sequence of "now what?" moments; the incidental complexity is permanent because no one reverts the choices that landed it.
