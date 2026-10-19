# Simon Willison — LLM Pipeline Quality Review

Scope: `web/server/observer-prompt.ts` (`buildObserverWakePayload`), `web/server/session-orchestrator.ts` (`handleCouncilReview` wake-version-mismatch downgrade), `.council/prompts/observer-system.md` (observer system prompt v1), `web/server/council-types.ts` (`ObserverWakePayload` + `observer_wake_payload_version_echo`).

Lane: LLM-content correctness. Aura is a protocol bridge downstream of an LLM; the wake body is the **new** load-bearing LLM-facing surface — the bytes the observer model autoregresses against on every checkpoint. I am NOT re-flagging AP-1..AP-3 / EC-1..EC-9.

Headline: the wake body shape is well-engineered for portability and the version-echo contract is well-formed, but **the dropped-path directive lives only in the per-cycle body — never in the system prompt** (P1), and **no recording-based replay fixture was pinned for the wake frame despite EC-6 listing wake as a load-bearing protocol parser** (P2). The version-mismatch downgrade policy is correct.

---

## P1 — `dropped` semantic taught only in the wake body, never in the system prompt; reliance is single-shot per cycle

**File:** `.council/prompts/observer-system.md`, `web/server/observer-prompt.ts:495`

**Concrete failure mode.** The wake body's terminator says: *"Read only the workspace-relative paths listed under `delta` and `carried` in the manifest below. Files listed under `dropped` are explicitly out of scope this cycle."* This is the only place the model is told that `dropped` is a do-not-read list. The system prompt (`observer-system.md`) never mentions `delta`, `carried`, or `dropped` — `grep -n "dropped\|delta\|carried"` against the prompt returns one hit and it's the unrelated *"dropped silently"* phrase in the parse-failure clause. The system prompt's contract section says only *"Receive a checkpoint manifest: a list of workspace-relative artifact paths"*, which is at odds with the actual three-section manifest the model will receive.

Willison Principle 1 ("LLMs are unable to reliably distinguish the importance of instructions based on where they came from") cuts both ways here. The role-defining no-go is hidden in the per-cycle wake body, *next to* the JSON manifest the model will copy fields out of — at exactly the location where context-distraction is most likely to dilute the directive. Any model family that under-attends to the prose around a fenced JSON block (a known Haiku/Codex failure mode, and one Opus is not immune to under long contexts) will silently treat `dropped` as readable. The EC-7 builder-side filter is excellent defence-in-depth on the paths actually emitted, but it does not protect against the *semantic* failure where the observer reads a `carried` path expecting prior content but interprets a `dropped` filename as relevant because nothing in its system role told it otherwise.

**Why this matters more than it sounds.** The whole point of `dropped` is to bound the observer's review surface to the delta + carried set, NOT to be a soft suggestion the model can override. The system prompt is the persistent role definition that survives across all wakes; the wake body is ephemeral, per-cycle, and competes with the JSON's much louder cue (a `dropped` array key visible in the model's parse). Putting the "do not read dropped" rule in the body once, and never reinforcing it in the role definition, makes the rule structurally weaker than the JSON it tries to qualify.

**Fix.** Add a paragraph to `observer-system.md` between *"Your contract — exactly one cycle"* step 1 and step 2:

> The manifest you receive will be partitioned into three sections: `delta` (paths new this cycle — primary review surface), `carried` (paths carried from the previous checkpoint — re-read only for cross-cut consistency checks), and `dropped` (paths removed from scope this cycle — **never read these**; they are listed only so you can recognise what is no longer in scope). Treat `dropped` as a do-not-touch list with the same force as the workspace boundary.

Then the wake body's terminator can be a shorter reminder rather than the sole carrier of the rule. **Severity P1** because this is the LLM-content correctness equivalent of fail-open: the EC-7 wrapper protects file-read attempts, but it does NOT stop the observer from *making findings about a `dropped` path it remembers from the previous wake* — and that observer is then writing into a review file whose findings the server treats as authoritative (subject to grounding, which checks the *modified* set, not the dropped set).

---

## P1 — Version-mismatch downgrade is correct policy, but the "absent echo is back-compat" branch is silently fail-open for the only producer that can fail it

**File:** `web/server/session-orchestrator.ts:1542-1567`, `web/server/council-types.ts:152-162`

**The policy itself is right.** When the observer echoes a wake-payload version that doesn't match `OBSERVER_WAKE_PAYLOAD_VERSION`, downgrading ALL non-NOTE/INFO findings to NOTE is the correct balance. STOPs from a model that parsed a stale schema are exactly the findings whose severity calibration we cannot trust — and dropping them entirely would silently hide a legitimate signal in the case where the observer found a real bug despite mis-parsing the manifest envelope. NOTE is the right floor: visible, not blocking, audit-trail preserved.

**But.** `parseObserverReviewPayload` accepts the field as optional (back-compat with v1 reviews that predate the contract). The handler at `session-orchestrator.ts:1543` only triggers the downgrade if `wakeEcho !== undefined && wakeEcho !== OBSERVER_WAKE_PAYLOAD_VERSION`. The reasoning ("absent is back-compat with v1 reviews that predate the contract") is fine *as a one-time migration window*, but it is structurally fail-open *as a permanent contract*. The system prompt v1 you just shipped says *"`observer_wake_payload_version_echo` must be the integer value..."* — i.e. mandatory from the prompt's perspective. So the ONLY way the field can be absent in a production review is one of:

1. The observer model silently elided the field (Claude/Codex non-compliance — exactly what the contract is supposed to detect).
2. The orchestrator that wrote the prompt artifact is on a stale prompt that doesn't yet require the echo (this is the legitimate back-compat case).
3. An adversarial scenario where the observer's output was tampered with to suppress the echo, bypassing the version-mismatch downgrade entirely.

You cannot tell these apart from absence alone. **Recommendation:** stamp the prompt sha256 you already capture (`observerPromptSha256`) into a server-known set at observer spawn time; if the prompt-sha matches a prompt that DOES include the echo requirement, treat absence as mismatch (downgrade to NOTE). If the prompt-sha is from a pre-echo version, accept absence silently. This collapses three semantics into a deterministic two without breaking the migration window. **Severity P1** because the current shape gives an attacker (or a buggy model) a free way to launder STOPs past the downgrade simply by omitting one field — and the prompt artifact and the server are co-versioned anyway, so the migration window argument doesn't hold once a single prompt version that requires the echo has shipped.

A secondary, smaller note: the prompt's wording *"must be the integer value of `observer_wake_payload_version` taken verbatim from the manifest"* is the right defence against the `"1"` string variant (Beck/parser would reject it via `Number.isInteger`), but the prompt does NOT say what to do if the observer cannot find the field in the manifest. A clever model that lost the manifest in its context window might emit `0`, `null`, or skip the field. Worth one extra sentence in the prompt: *"If you cannot locate this field in the manifest, treat that as a parse failure and emit no findings."*

---

## P2 — No replay fixture pinned for the wake frame; EC-6 names "load-bearing protocol parsers" and wake is one

**File:** missing — there should be a `.jsonl` fixture under a recordings-test corpus and a `wake-frame-replay.test.ts` that loads it.

**Concrete failure mode.** The context brief lists the wake body as the new load-bearing LLM-facing surface, and CLAUDE.md / EC-6 require recording-based regression tests for load-bearing protocol parsers. The recorder schema was bumped v1→v2 with the `origin: "server:council-wake"` tag specifically to make wake frames distinguishable in recordings (`recorder.ts:62-67`, `claude-adapter.ts:1024`). But `grep -rn "council-wake" web/server/{replay,recorder}.test.ts` returns zero hits, and `observer-prompt.test.ts` exercises the *builder* with unit tables — not the round-tripped wake frame as written by `claude-adapter.sendUserFrameFromServer` and read back by `replay.ts`.

This matters because the wake frame crosses three layers (builder → adapter `\n`-stringify → NDJSON line discipline → recorder JSONL line). A regression that re-stringifies the body, or that fails to preserve the exact `\n` placement in the fenced block, would NOT be caught by the builder's unit tests — and the observer's parse is fragile to whitespace inside the JSON block (Willison Principle 9: same bytes, same effect).

**Fix.** Pin one captured wake-frame JSONL line as a fixture, write a replay test that asserts: (1) `recorder.load` reads it without re-serialisation drift; (2) the parsed `raw` field, when `JSON.parse`d, contains a `content` whose substring `"```json\n{"` lands on a literal byte sequence matching the builder's output for a fixed checkpoint+manifest; (3) the `origin` field is `"server:council-wake"`. The fixture should be a real wake observed against a real orchestrator-driven checkpoint, captured once and checked in — exactly the pattern Willison Principle 4 lays out. **Severity P2** because nothing is currently broken, but the next adapter or stringify change will regress silently.

---

## P2 — Wake-body shape is hybrid (H1 + prose + fenced JSON + directive); good portability hedge but the directive terminator's ordering matters and is undocumented

**File:** `web/server/observer-prompt.ts:492-503`

The body shape is:

```
# Council Checkpoint — <phase>

A new checkpoint has arrived. Read only the workspace-relative paths listed under `delta` and `carried` in the manifest below. Files listed under `dropped` are explicitly out of scope this cycle.

```json
<JSON>
```

Emit one review file matching the `ObserverReviewPayload` JSON schema described in your system prompt. Echo `observer_wake_payload_version`, `session_group_id`, `checkpoint_id`, and `phase` from the manifest verbatim. Begin.
```

**This is the right shape** and your JSDoc correctly cites Willison Principle 7 (model portability). The prose on either side of the fence is the portability hedge — Haiku and Codex are both observably more reliable when prose anchors precede the structured block. The H1 preamble is a strong attention anchor. The directive terminator with imperative "Begin." is a known-good cue across families.

**The issues are smaller but real:**

1. **The "echo" directive in the terminator only lists four fields** (`observer_wake_payload_version`, `session_group_id`, `checkpoint_id`, `phase`) but the prompt and the schema also require `observer_wake_payload_version_echo` as a separately named output field. The wake body says "echo `observer_wake_payload_version`" — a model parsing this literally might emit `observer_wake_payload_version: 1` instead of `observer_wake_payload_version_echo: 1`. The system prompt's output spec does name `observer_wake_payload_version_echo` correctly, so a careful model resolves the inconsistency from the prompt; but the wake body's wording diverges from the schema. **Fix:** change the terminator to *"Echo `observer_wake_payload_version` as `observer_wake_payload_version_echo` in your output JSON."*

2. **`checkpoint_seq` is in the JSON but the directive doesn't tell the observer to echo it.** This is *deliberate* (the review schema doesn't have a `checkpoint_seq` field) but it's confusing — a model reading the JSON sees five non-array fields and is told to echo four. A defensive observer might invent an `echo` field for it. Worth one sentence of clarification *or* drop `checkpoint_seq` from the wake JSON if no consumer needs it. Looking at council-types: `checkpoint_seq` is in `ObserverWakePayload` but not `ObserverReviewPayload`, and it's not used in `handleCouncilReview` for any dedup or grounding logic — it appears to be there only for the wake body's own traceability. Either keep it and document why it's NOT echoed, or remove it.

**Severity P2** — these are wording-precision issues that a well-aligned Claude Opus 4.7 observer will resolve by reading the prompt schema, but they ARE the kind of drift Haiku and Codex resolve badly. The wake body is the primary attention surface and its wording should be tight.

---

## P2 — `checkpoint_seq` is the first content field where producer and consumer use different names (`checkpoint_seq` in wake, `sequence` in `CheckpointPayload`)

**File:** `web/server/council-types.ts:76-89` (writer field `sequence`), `web/server/council-types.ts:121-135` (wake field `checkpoint_seq`)

**Concrete failure mode.** `CheckpointPayload.sequence` is renamed to `checkpoint_seq` in `ObserverWakePayload`. The rename is presumably to disambiguate the wake JSON from prose like "the sequence number" — a fair UX choice for the model. But:

1. It increases the cross-process schema surface area: a future writer change to `sequence` semantics requires remembering to rename it in the wake too.
2. Any test fixture comparison (Willison Principle 9 — deterministic round-trip) has to know about the rename.
3. The observer prompt does NOT name `checkpoint_seq` anywhere in its output spec, so a model wanting to be helpful might decide to echo it under either name and either decision is "wrong" from one schema's perspective.

**Recommendation.** Keep the rename — but add a comment to `ObserverWakePayload` in `council-types.ts` calling out the deliberate divergence and pin a test that asserts a fixed `CheckpointPayload.sequence === ObserverWakePayload.checkpoint_seq` round-trip via the builder. The fact that AP-3 puts both schemas in the same file is the right place to enforce this. **Severity P2** because it's drift-prone, not currently broken.

---

## P3 — Prompt-injection from orchestrator-written `artifact_paths` is well-defended; one residual edge

**File:** `web/server/observer-prompt.ts:339-345, 410-419`, `web/server/council-types.ts:215-226`

You asked me to confirm or push back on this. **Confirm: the defence is sound** with one residual edge to note.

The path goes: orchestrator (an LLM, prompt-injectable) writes `CheckpointPayload.artifact_paths` → `isRelativeWorkspacePath` rejects NUL / absolute / `..` / known-sensitive dot-dirs → wake builder's `hasUnsafeWireCharacters` rejects CR/LF/NUL → wake builder rejects ``` triplet → `assertWakeManifestPathAllowed` realpath-clamps to workspace. The fenced JSON block and the prose terminator together strongly resist a path-shaped instruction injection (you can't escape the fence without ``` and you can't insert a newline-terminated "ignore previous instructions" without CR/LF).

**Residual edge.** The wake body's prose includes `phase` directly in the H1 (`# Council Checkpoint — <phase>`). `phase` is validated as `PHASE_PATTERN = /^[A-Za-z0-9_-][A-Za-z0-9_.\-]{0,63}$/` so it cannot contain newlines, spaces, or fence triplets. **Verified safe** — but it IS the one piece of orchestrator-supplied content rendered in unfenced prose. The validator regex is the entire defence; if anyone ever widens `PHASE_PATTERN` to allow spaces or `#`, the H1 becomes an injection surface. Worth a code-adjacent comment in `council-types.ts` PHASE_PATTERN noting *"This pattern is also the security boundary for unfenced prose rendering in observer-prompt.ts:493 — do not relax without re-auditing wake-body shape."*

**Severity P3** — defensive, not actionable as a fix.

---

## INFO — AI-validator independence: confirmed clean

`grep -rn "ai-validator\|aiValidator" web/server/observer-prompt.ts web/server/session-orchestrator.ts:handleCouncilReview` returns zero hits. The wake pipeline and the permission-gating pipeline (`ai-validator.ts`) are correctly independent. The wake body is server-synthesised content, not a user-typed message routed through validator. **No cross-pipeline coupling slipped in.** This is the right shape — the validator gates tool-call permission decisions on the orchestrator side; the wake gates checkpoint→observer protocol on a separate channel. Confused coupling would have made the version-mismatch downgrade and the validator's allow/deny logic interact in surprising ways.

---

## INFO — Echo-first key order is the right call

`council-types.ts:121` orders `observer_wake_payload_version` first, then `session_group_id`, `checkpoint_id`, `phase`, `checkpoint_seq`, then `delta`/`carried`/`dropped`. Willison Principle 8 (context propagation): the model parses left-to-right; having the schema discriminator AND echo fields before the content arrays means an observer that runs out of attention budget on a large manifest still preserves the discriminator → echo → review chain. The JSDoc at `council-types.ts:108-119` explains this well. The fact that `JSON.stringify(payload, null, 2)` preserves declaration order in modern V8 is load-bearing here — if you ever switch to a stringifier that sorts keys alphabetically, this property is lost. Worth a one-line tripwire test: assert that the assembled `textBody` contains `"observer_wake_payload_version":` BEFORE the first occurrence of `"delta":`.

---

## Summary

| Severity | Finding |
|---|---|
| **P1** | `dropped` do-not-read semantic taught only in the per-cycle wake body, never in the persistent system prompt — single-shot reliance across model families |
| **P1** | Version-mismatch downgrade is right policy, but "absent echo" branch is silently fail-open after the migration window — couple to `observerPromptSha256` |
| **P2** | No replay fixture pinned for the wake frame despite EC-6 listing wake as a load-bearing protocol parser |
| **P2** | Wake-body terminator says "echo `observer_wake_payload_version`" — schema field is `observer_wake_payload_version_echo`; minor wording drift |
| **P2** | `checkpoint_seq` (wake) vs `sequence` (checkpoint) rename increases cross-process schema surface; pin a round-trip test |
| **P3** | `phase` in H1 is the one unfenced orchestrator-supplied surface; PHASE_PATTERN regex is the entire defence — annotate |
| **INFO** | AI-validator independence confirmed; no coupling |
| **INFO** | Echo-first JSON key order is the right call; add a tripwire test |

The wake body shape is good engineering. The two P1s are about *where the rules live*, not whether the rules exist — and both have the same flavour: a contract that holds today but degrades silently as the system grows.
