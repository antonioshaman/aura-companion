# Simon Willison — LLM Pipeline Quality Review

**Scope:** Council Mode = a second LLM session (the observer) consuming the orchestrator's filesystem artifacts and emitting structured findings. The reviewed files define the cross-process contract (`council-types.ts`), the observer's tool surface (`observer-permissions.ts`), and the Codex frame parser through which observer messages will reach the bridge (`codex-envelope.ts`). LLM-pipeline lens only.

---

## P1 — `ObserverReviewFinding` lacks per-finding model/provider provenance for forensic re-run

- **File:** `web/server/council-types.ts:41-49,51-62`
- **Principle:** Quality-LLM Principle 4 — *Recording-based replay is your only honest regression test* (also Principle 7 — *Model/CLI portability: versions shift, behaviour shifts*).
- **Severity:** P1.
- **What's wrong:** `ObserverReviewPayload` records `observer_provider` exactly once at the payload level (a free-form `string` bounded only by length; no enum, no version). Individual `ObserverReviewFinding` entries carry severity + claim + evidence but **no model id, no CLI version, no provider, no recording-pointer, no checkpoint-input-hash**. Two observer halves on the same checkpoint (or one observer re-run after a model change) cannot be A/B compared because findings carry no model-identity. There is also no `model` field at any level — only the bare provider label.
- **Consequence:** When the Council ships and a STOP finding turns out to be a hallucination, you cannot answer the only question that matters — "which model produced this, against which CLI version, replaying which recording?" This is the exact failure mode Willison's 8,000 logged interactions are designed to defeat. Bug reports against the observer collapse into "it said this once" with no path back to a deterministic repro.
- **Fix:** Extend `ObserverReviewPayload` with `observer_model: string` (e.g. `claude-opus-4-7`), `observer_cli_version: string`, `checkpoint_input_sha256: string` (hash of the canonical concatenation of `artifact_paths` contents at review time), and `recording_path: string` (relative path under `~/.companion/recordings/` covering the review window). Optionally promote `observer_provider`/`observer_model` to per-finding when the observer is permitted to call multiple models in one review (it currently isn't, so payload-level is acceptable *if* the other three forensic fields are added).

---

## P1 — Severity is bipolar (`STOP | NOTE`) — no INFO tier, no QUESTION tier, no CONFIDENCE field

- **File:** `web/server/council-types.ts:23,41-49`
- **Principle:** Quality-LLM Principle 5 — *The user is the final auth check; communicate clearly enough that they catch a malicious or surprising tool call.* Also Principle 3 — *both automated evals AND human vibe checks are necessary.*
- **Severity:** P1.
- **What's wrong:** `CouncilFindingSeverity = "STOP" | "NOTE"` forces the observer LLM to binarise every observation into "halt the pipeline" or "footnote". There is no INFO/observational tier for context the orchestrator should know about but should not interrupt on, no QUESTION tier for "I cannot verify this — human please look", and no `confidence: "high" | "medium" | "low"` field. With two tiers, an LLM trained to be helpful will either (a) demote borderline real bugs to NOTE so it doesn't "halt" the orchestrator, or (b) escalate trivia to STOP because NOTE feels dismissive. Both failure modes are well-attested in LLM grader literature.
- **Consequence:** STOP becomes either inflationary (orchestrator alert-fatigue → real STOPs get ignored, c.f. `feedback_alert_text_symptom_not_cause` in your memory) or deflationary (the model self-censors). NOTE becomes a junk drawer. Either way, the orchestrator's decision to halt-or-continue runs on a signal the observer is mis-shaped to produce. This is structurally the same failure pattern as the i18n-substring assertion (`feedback_i18n_test_assert_key_not_substring`): the schema undersells what the producer wants to express, so the producer drifts.
- **Fix:** Expand to at minimum four levels (`STOP | WARN | NOTE | INFO`), add a sibling `confidence: "high" | "medium" | "low"` field, and add an optional `requires_human_review: boolean` for the case where the observer is uncertain. Document the semantics so the observer's system prompt can be calibrated against the schema. If you stay binary, name it `halt: boolean` and stop pretending the schema captures severity gradients.

---

## P1 — `codex-envelope.ts` has no method allow-list — Council Mode wants observer findings only

- **File:** `web/server/codex-envelope.ts:14-22,54-105`
- **Principle:** Quality-LLM Principle 8 — *Validate at the boundary; context propagation across the LLM boundary is a security gate.* Also Principle 1 — *the bridge is downstream of an LLM, treat its bytes as untrusted.*
- **Severity:** P1.
- **What's wrong:** The parser validates shape (request/notification/result/error) and bounds method length to 128 ASCII-printable characters, but accepts **any** method name. The context-brief explicitly states: *"Codex JSON-RPC method allow-list — deferred until wiring; current `codex-envelope.ts` validates frame shape only."* For the orchestrator-half this is acceptable because the full Codex method surface is exercised. For the **observer-half** the Council Mode requirement is far narrower — the observer should be making findings-shaped notifications and reading tool calls from a curated set. A shape-only parser lets a prompt-injected observer emit arbitrary Codex methods (e.g. tool invocations the human never approved) that ride straight through `ws-bridge.ts` into the orchestrator's UI session-store and replay corpus. This is the asymmetric-trust issue spelled out in `feedback_single_ack_defensive_path_first` — the defensive path (method filter) must fire FIRST, before forwarding.
- **Consequence:** A prompt-injected observer can forge orchestrator-shaped Codex frames because both halves cross the same `codex-envelope` boundary. The denylist in `observer-permissions.ts` (Bash/WebFetch/etc.) restricts what the observer's CLI *executes locally*, but the envelope parser is what gates what the observer *broadcasts* into the bridge — and right now it gates nothing role-specific. The two restrictions are not redundant; they are different layers, and only one of them is implemented.
- **Fix:** Add a per-role method allow-list keyed by `SessionGroupRole` ("orchestrator" | "observer"). Observer methods should be a tight set (e.g. tool-result/notification frames that match the review-emitting shape). Reject frames whose method is not in the role's allow-list with `null`, same fail-closed contract as the rest of the parser. Wire this in before Phase D, not after — the deferral note in the context-brief is the exact kind of "we'll add it when we wire it" that creates the gap.

---

## P2 — Observer toolset includes `Edit` and `TodoWrite`; both are unneeded for review-emitting and widen the surface

- **File:** `web/server/observer-permissions.ts:25-32`
- **Principle:** Quality-LLM Principle 5 — *Make the wrong thing impossible; shrink the attack surface.* Also Principle 8 — *context propagation: what state crosses the LLM boundary.*
- **Severity:** P2.
- **What's wrong:** The allow-list includes `Edit` and `TodoWrite`. The observer's job, per the schema in `council-types.ts`, is to read `artifact_paths` and **write** an `ObserverReviewPayload` markdown/JSON file under `.council/reviews/`. That is a `Write` operation (one new file per review). `Edit` lets the observer modify pre-existing files — including, if `observer-write-policy.ts` is mis-bounded, the orchestrator's checkpoint artifacts themselves, which would silently corrupt the upstream contract. `TodoWrite` is an *agentic planning* tool — it is meaningful for an autonomous executor with a multi-step plan, not for an LLM that reads N files and emits one structured artifact. The doc comment claims tools were *"Curated to exactly what's needed"* — but neither Edit nor TodoWrite is needed for the documented job.
- **Consequence:** A prompt-injected observer can use `Edit` to mutate the orchestrator's checkpoint JSON it just read (poisoning the contract), or use `TodoWrite` to manufacture a synthetic plan trail that confuses any human reading the session later. Neither widens the abstract trust boundary much (same uid, same workspace), but both violate principle of least surface and both make observer behaviour harder to reason about under replay.
- **Fix:** Drop `Edit` and `TodoWrite` from `OBSERVER_ALLOWED_TOOLS`. Add them to `OBSERVER_DISALLOWED_TOOLS` so the boot-time canary catches reintroduction. If the observer ever genuinely needs to amend a prior review (it probably shouldn't — append a new review file instead), gate that via `Write` to a fresh path under `observer-write-policy`'s allowed prefix.

---

## P2 — `CheckpointPayload.artifact_paths` is orchestrator-trusted with no countersignature or hash

- **File:** `web/server/council-types.ts:25-39,102-131`
- **Principle:** Quality-LLM Principle 8 — *Validate at the boundary; context distraction when context is shaped by an upstream LLM.* Also Principle 1 — *content that has been "blessed" by an LLM that may have been tricked.*
- **Severity:** P2.
- **What's wrong:** `artifact_paths` is the curated reading list — the per-checkpoint context window that the observer LLM will consume. The validator enforces shape (relative, no `..`, bounded length, ≤50 entries), which is excellent for path-traversal defence, but the *content* of the list is fully trusted: whatever paths the orchestrator emits, the observer reads. The orchestrator is itself an LLM session; a prompt-injected orchestrator can shape the observer's attention by selecting which files appear in `artifact_paths` and which don't. There is no counter-hash of file contents, no minimum-paths invariant, no orchestrator-signature, no observer-side cross-check against `evidence_path` (does the observer's emitted `evidence_path` have to be a member of `artifact_paths` for that checkpoint? The schema doesn't say.). This is the asymmetric-trust issue the prompt flagged.
- **Consequence:** Context-curation poisoning. A compromised orchestrator can quietly omit the file containing the bug it wants to hide, and the observer — reading only what it was handed — emits a clean review. The observer schema's `evidence_path` field is constrained to be relative and traversal-free, but is not constrained to be a member of the parent checkpoint's `artifact_paths`, so even an observer that wanted to flag "you didn't give me X" has no schema-supported way to signal *"the manifest was incomplete."*
- **Fix:** (a) Add `artifact_paths_sha256: string` to `CheckpointPayload` — orchestrator computes the canonical hash of `[path, file_content]` pairs; observer recomputes and embeds it in the review payload for tamper-evidence in the recording. (b) Add an `out_of_scope_paths` field to `ObserverReviewFinding` so the observer can flag "I think the manifest was missing something" as a first-class finding type. (c) Document in the schema header that `artifact_paths` is orchestrator-trusted and the observer must treat it as a context-shaping vector, not a directive.

---

## P2 — `phase` field rejects spaces and is bounded to 64 chars, but `observer_provider` accepts arbitrary 32-char strings with spaces banned only via `isBoundedString`

- **File:** `web/server/council-types.ts:21,51-62,70-72,151`
- **Principle:** Quality-LLM Principle 7 — *Model/CLI portability: hard-coded discriminators without fallback; no version detection.* Also Principle 3 — *validator output not validated.*
- **Severity:** P2.
- **What's wrong:** `observer_provider` is validated by `isBoundedString(_, 32)` — that means it must be 1–32 chars and contain no spaces, but it can be any non-space ASCII or Unicode glob. Downstream consumers (UI, replay, audit logs) will inevitably branch on string equality (`if (provider === "claude")`). With no enum and no normalisation, you get `Claude` vs `claude` vs `claude-code` vs `claude_code` vs `anthropic` drift across versions. The same goes for `phase` — its regex permits `.` and `_` and `-` and case, so `council-plan` vs `council_plan` vs `Council-Plan` all validate.
- **Consequence:** Forensic queries ("how many STOP findings did Codex produce in council-implement phases?") break on punctuation drift, and the resulting metrics are silently wrong. This is the exact pattern in your memory `feedback_i18n_test_assert_key_not_substring` — under-constrained string fields drift silently as producers change.
- **Fix:** Make `observer_provider` an enum: `type ObserverProvider = "claude" | "codex"`. Make `phase` an enum of canonical phase names (the council-plan/implement/review set the orchestrator actually emits), with a permissive fallback only for forward-compat *and* a runtime warning when a non-canonical phase is seen. Normalise to lower-case-kebab at the validator boundary, not at every consumer.

---

## P3 — `findings` array is capped at `MAX_FINDINGS = 50`; same constant also caps `artifact_paths`

- **File:** `web/server/council-types.ts:19,118,153`
- **Principle:** Quality-LLM Principle 8 — *Context distraction when context grows so long the model over-focuses on it.*
- **Severity:** P3.
- **What's wrong:** A single constant `MAX_FINDINGS = 50` is reused for *both* checkpoint `artifact_paths` length *and* observer `findings` length. These bounds answer different questions: how many files should an observer be asked to read in one go (a context-budget question) vs. how many findings is the observer permitted to emit (an output-shape question). Fifty is plausible for one and excessive for the other — fifty findings on a single checkpoint is almost certainly observer-confabulation rather than fifty distinct real defects, and a schema that permits it normalises it.
- **Consequence:** Constant-reuse drift. If you later tune `artifact_paths` down to 20 for context-window hygiene, you also unintentionally tune the findings limit. Conversely, if you raise findings to 200 for an exhaustive-mode review, you also raise the per-checkpoint reading list, blowing the observer's attention budget.
- **Fix:** Split into `MAX_ARTIFACT_PATHS = 50` and `MAX_FINDINGS_PER_REVIEW = 20` (or whatever the calibrated numbers are). Document the rationale (context budget vs. output shape) in the constant's JSDoc so the next maintainer doesn't re-merge them.

---

## P3 — Observer-permissions canary is opt-in (`assertObserverToolPolicyConsistent()` must be called at boot)

- **File:** `web/server/observer-permissions.ts:79-87`
- **Principle:** Quality-LLM Principle 3 — *Use the type system as armour; validator output not validated.*
- **Severity:** P3.
- **What's wrong:** The disjointness invariant between `OBSERVER_ALLOWED_TOOLS` and `OBSERVER_DISALLOWED_TOOLS` is checked by a function that must be explicitly called from server startup. There is no module-load guarantee. A refactor that drops the boot-time call (or wires Council Mode behind a feature flag whose disable path skips the assertion) silently loses the canary the JSDoc promises. This is structurally the same pattern as `feedback_trust_diff_not_prose` — claims about an invariant in comments are not the invariant being enforced.
- **Consequence:** The denylist becomes documentation, not protection. A future hand that adds "Bash" to allowed and forgets to run the assertion at boot has widened the surface silently.
- **Fix:** Evaluate the assertion at module load time (top-level `assertObserverToolPolicyConsistent()` call in `observer-permissions.ts`, after the constant definitions). Module load runs once per process and is the natural place to enforce frozen-data invariants. The function can still be exported for explicit re-validation in tests.

---
