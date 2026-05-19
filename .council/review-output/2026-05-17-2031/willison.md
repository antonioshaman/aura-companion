# Willison (LLM Pipeline Legibility) — Council Mode Docs Review

Scope: `docs/guides/council-mode.mdx`, `docs/reference/council-mode-architecture.mdx`. Lens: factual accuracy of the LLM-pipeline mental model, trust-boundary honesty, restart-replay determinism clarity, grounding-gate fidelity, pairing tradeoffs, prompt-version audit discoverability, troubleshooting precision.

The PR substantially improves legibility — the fallible-observer framing, can/cannot enumeration, worked grounding example, and finding lifecycle are exactly the Willison-grade affordances missing from earlier drafts. Findings below are mostly about residual mismatches between the prose mental model and the runtime contract documented in `CLAUDE.md`.

---

## P1-W1: Guide implies orchestrator auto-writes checkpoints; runtime requires explicit POST

**File:lines:** `docs/guides/council-mode.mdx:86` (worked example step 1: "the orchestrator records a checkpoint listing `modifiedFiles: [...]`"); also `docs/reference/council-mode-architecture.mdx:55` ("Written by the orchestrator after each Carmack-Council phase via `writeAtomicJson`").

**Severity:** P1.

**Principle:** Willison Principle 1 (LLM-shaped surfaces honestly described) + Principle 10 (know your gaps — don't paper them over).

**Finding:** Both docs describe checkpoint emission as a thing the orchestrator does as a matter of course, with passive-voice phrasing ("the orchestrator records", "Written by the orchestrator"). `CLAUDE.md` is explicit that the producer-side surface is `POST /api/sessions/:id/council/checkpoint` — the CLI does not write checkpoint files by itself; something (a skill, a hook, an explicit tool call) must POST. The reference's data-flow ASCII even shows "orchestrator CLI ────► writes .council/checkpoints/<phase>.json" with no actor caveat. The guide's "When to use it" section names `/council-implement` etc. but never connects those skills to checkpoint emission. A reader walking through Council Mode for the first time will turn it on, run a normal session, and conclude the feature is broken when no review ever fires — because nothing wrote a checkpoint.

**Consequence:** Users perceive Council Mode as silently inert. The fallible-observer framing then earns blame the observer doesn't deserve ("observer never wakes — must be hallucinating idleness"). This is the inverse of the trust-boundary honesty the rest of the doc establishes.

**Fix:** In the guide's "When to use it" or a new "How checkpoints are written" subsection, state plainly: checkpoints are not automatic — your orchestrator must POST `/api/sessions/:id/council/checkpoint` (or invoke a skill that does). Name which built-in skills currently emit checkpoints, and what to do if you're driving the orchestrator manually. In the reference, change "Written by the orchestrator after each Carmack-Council phase" to identify the producer endpoint and clarify that emission is caller-driven, not automatic on phase boundary. Add a troubleshooting row: "ObserverPanel stays on `never-checkpointed-yet` even after work landed" → "Nothing called the checkpoint POST. Confirm your orchestrator skill emits checkpoints or POST manually for a smoke test."

---

## P2-W1: `claude+codex` correlated-failure-mode claim is presented as fact, not hypothesis

**File:lines:** `docs/guides/council-mode.mdx:51` ("two Claudes tend to echo each other's blind spots (same training distribution, similar refusal patterns), while a Codex observer can surface issues a Claude observer would rationalise past").

**Severity:** P2.

**Principle:** Willison Principle 10 (epistemic humility — eval practice is "still evolving") + Principle 4 (replay-based evidence over assertion).

**Finding:** The correlated-failure-mode argument is plausible, even likely, but stated as established behaviour with no caveat. Willison's own canon repeatedly flags that cross-model "diversity" claims need empirical evidence — same training data leakage, same RLHF lineage, and shared web-scrape provenance make the "different blind spots" assumption uncertain absent measurement. The doc has no link to an internal eval, no recording-corpus comparison, no "we observed this on N sessions" data point. A reader takes the prose at face value and pays asymmetric tooling + separate billing cost on a benefit that may not materialise on their workload.

**Consequence:** Over-claim erodes the credibility the rest of the page is carefully building. If a user runs `claude+codex` for a sprint and sees no meaningfully different findings, the whole fallible-observer frame gets re-read as marketing.

**Fix:** Hedge the claim. Phrase the benefit as a hypothesis worth testing on the user's workload: "two Claudes *may* echo each other's blind spots; a Codex observer is a hedge against that, though the empirical magnitude on your codebase is unmeasured." Drop "rationalise past" — that's a colour adjective that asserts more than the evidence base supports. Optionally surface "compare both pairings on your repo via the recordings under `~/.companion/recordings/`" as the falsification path.

---

## P2-W2: Prompt-version audit affordance describes the fields but not where to read them

**File:lines:** `docs/reference/council-mode-architecture.mdx:46-51` ("Auditing observer behaviour across runs" section).

**Severity:** P2.

**Principle:** Willison Principle 5 (the user is the final auth check — give them enough to act) + Principle 6 (the recorder is the observability layer).

**Finding:** The section enumerates three fields — `observerPromptSha256`, `observerPromptSource`, and the `council.observer-prompt.bundled-fallback` WARN log — and explains what each means semantically, but does not tell the user *where* to find them at runtime. Is `observerPromptSha256` surfaced in a REST response? In the recording header? In the ObserverPanel UI? In server logs only? The WARN log is the only one with an implicit answer (server stderr/log file), and even there no log path is given. A user asking "why does my workspace prompt seem ignored" can read this section twice and still not know where to type the next command.

**Consequence:** The audit affordance exists in code but is undiscoverable from docs. Users either give up (worst case) or open the source to find the answer (defeats the docs).

**Fix:** Add one sentence per field naming its surface. Sha256 + source live on `SdkSessionInfo` — point to the recording header (`recorder.ts` writes session metadata to line 1) or `GET /api/sessions/:id` if that field is exposed. WARN log: name the file (`~/.companion/...` or stderr of the dev server). If any of these are not currently surfaced to the user-facing API, that's a separate Fowler/Friedman finding — but the docs should at minimum state the truth.

---

## P2-W3: Restart-replay determinism section confuses two different "re-running" scenarios

**File:lines:** `docs/guides/council-mode.mdx:106-108` ("Restart-replay determinism" section).

**Severity:** P2.

**Principle:** Willison Principle 9 (non-determinism — same bytes, same effect).

**Finding:** The section conflates two distinct events. Scenario A: the orchestrator restarts, re-reads the *same review file already on disk*, and the same `(sessionGroupId, checkpointId, observerProvider, findingIndex, evidence_path, claim)` tuple produces the same id — fully deterministic. Scenario B: the observer is *re-run* on the same checkpoint (fresh LLM pass), produces a different `claim`, and therefore a different id — non-deterministic. The current text "What is deterministic: the id, given identical inputs. What is not: the claim text" technically covers both, but a casual reader reads "Restart-replay" in the heading and assumes the determinism guarantee applies to re-running the observer. The browser-dedup mechanism only protects scenario A; it does NOT collapse scenario B into one finding (different ids → two entries).

**Consequence:** Users observing a re-spawn of the observer (e.g. after `degraded` → respawn) on a still-current checkpoint may be surprised to see two findings for what feels like one issue. The doc's framing implies dedup will handle it, but dedup is keyed on the id which already drifted.

**Fix:** Split the section into two named scenarios — "Restart with existing review file" (deterministic, dedup catches it) and "Re-running the observer (e.g. after respawn)" (non-deterministic; expect multiple findings). State that the `claim` participating in the id derivation is the mechanism that makes scenario B non-collapsing — that's the design choice, not a bug.

---

## P2-W4: "Cannot write to workspace" undersells the defence-in-depth

**File:lines:** `docs/guides/council-mode.mdx:26` (Cannot: "Write to your workspace. The write boundary is enforced at spawn argv (tool allow-list + permission mode).").

**Severity:** P2.

**Principle:** Willison Principle 1 (LLM content is untrusted — the renderer is the last line of defence; cf. defence-in-depth).

**Finding:** The "Cannot" enumeration names only the argv-level boundary (EC-1), which is the spawn-time gate. `CLAUDE.md` describes a second layer: `observer-write-policy.ts`'s `assertObserverWriteAllowed(path, root)` performs realpath + workspace-bounds-check at the path level, defending against a hypothetical case where a tool is misconfigured to allow writes. The reference doc page mentions both layers (line 142-146), but the guide's user-facing "Cannot" list does not. A user reading only the guide takes away a single-layer model and may either over-trust or under-trust accordingly (e.g. believing the observer is one config slip away from arbitrary write).

**Consequence:** The trust boundary is honestly stated but incompletely. Defence-in-depth is part of the actual security posture; flattening it to a single argv claim weakens user mental model of the failure modes.

**Fix:** In the guide's "Cannot" bullet, add a parenthetical: "(enforced at spawn argv — tool allow-list + permission mode — and re-checked at the path level by `assertObserverWriteAllowed`)." One sentence; preserves brevity; mirrors the reference doc's two-layer truth.

---

## P3-W1: Worked grounding example omits the "missing on disk" branch

**File:lines:** `docs/guides/council-mode.mdx:84-95` (Worked example).

**Severity:** P3.

**Principle:** Willison Principle 4 (recording-based, full-coverage replay — happy-path-only is incomplete).

**Finding:** The worked example covers exactly one downgrade reason: STOP `evidence_path` not in `modifiedFiles` (out-of-delta). `CLAUDE.md` describes the gate as "STOPs outside the modified set OR missing on disk → downgrade to NOTE." The "missing on disk" branch is a meaningfully different failure mode — the path *was* in `modifiedFiles` but the observer hallucinated a line range for a file the build then deleted, or the observer fabricated a path that looks plausible. A user inspecting a downgrade-reason will see one of two distinct strings and the doc only prepares them for one.

**Consequence:** Users see "downgraded: missing on disk" and second-guess the system because the worked example didn't show this branch. Minor confidence dent in the gate.

**Fix:** Extend the worked example with a third finding (or a "Variant" subsection): STOP whose `evidence_path` IS in `modifiedFiles` but the path no longer exists on disk → downgraded to NOTE with a different reason. Half a paragraph; closes the symmetry gap.

---

## P3-W2: Failsafe-wake row's "5-minute" wording understates the worst case

**File:lines:** `docs/guides/council-mode.mdx:154` (Troubleshooting: "Wrote a checkpoint and no review for >5 min ... Wait one more failsafe cycle: a recurring 5-minute scan reconciles unprocessed checkpoints. Worst-case observer latency is bounded by this tick.").

**Severity:** P3.

**Principle:** Willison Principle 9 (precise determinism boundaries).

**Finding:** The row says "Worst-case observer latency is bounded by this tick" — true in the strict sense that two consecutive ticks are 5 min apart, but a checkpoint landing immediately after a tick fires must wait nearly a full tick + the observer's own pass time before findings reach the user. The user's symptom row is keyed on ">5 min" which a strict reading of the bound would not produce. Slight under-specification could mislead a user into thinking exactly 5 min is the worst case, then debugging at 6-7 min thinking something is wrong.

**Consequence:** Edge-case noise. Most readers won't notice; some will file false "failsafe broken" issues.

**Fix:** Phrase the bound as "worst-case ≤ 5 min from the next failsafe tick + observer pass time" or "checkpoint-to-finding upper bound: roughly two failsafe ticks (~10 min) in the pathological case." Precision over brevity here is worth the few extra words because the doc otherwise establishes precise contracts.

---

## P3-W3: Recording-filter affordance is named but not explained mechanically

**File:lines:** `docs/guides/council-mode.mdx:124` ("pull the observer's recording at `~/.companion/recordings/` and filter by `sessionGroupRole=observer`"), also `docs/guides/council-mode.mdx:155` (troubleshooting recordings row), and `docs/reference/council-mode-architecture.mdx:179` (Recordings section).

**Severity:** P3.

**Principle:** Willison Principle 6 (the recorder IS the observability layer — make it usable).

**Finding:** "Filter by `sessionGroupRole=observer`" is mentioned three times across both docs but never shown as a concrete command. JSONL files; is the field on every line, or only the header? Is the user expected to `grep '"sessionGroupRole":"observer"'`, run `jq`, use a REST endpoint, or open in Datasette? Per CLAUDE.md the field is on the recording header (line 1), which makes a naive `grep` work only when filtering files (not lines). A user new to the recording subsystem cannot execute on the affordance without spelunking.

**Consequence:** Recordings are described as the "ground truth for any disputed finding" but the path from symptom to ground-truth bytes is opaque.

**Fix:** Add one fenced command per direction. e.g. "List observer-half recordings: `grep -l '"sessionGroupRole":"observer"' ~/.companion/recordings/*.jsonl`" and "Find the review-write frame: `jq 'select(.raw | contains("observer-review"))' <file>.jsonl`." Even one example unlocks the affordance.

---

## Notes (not findings)

- The fallible-observer framing block (lines 12-14) is excellent — directly addresses Willison Principle 1's "the LLM may have been tricked" trust calibration. Preserve it verbatim in any future rewrite.
- The grounding-gate-is-quality-not-security framing in the reference (`docs/reference/council-mode-architecture.mdx:138`) is the most important sentence on the page; it honestly bounds the security claim. Do not let this regress.
- The `<provider>` filename-segment contract framing is repeated in both docs and clearly marked non-negotiable; good convention surface.
- EACCES/EISDIR/ELOOP vs ENOENT distinction in the bundled-fallback troubleshooting row is correct against `CLAUDE.md` line 90.
- The reference doc's deliberate decision to link to `conventions.md` rather than restate AP-/EC- IDs in-page is the right canonical-home discipline; reviewers should not request a re-inline.

---

**Summary:** 1 P1, 4 P2, 3 P3 = 8 findings total.
