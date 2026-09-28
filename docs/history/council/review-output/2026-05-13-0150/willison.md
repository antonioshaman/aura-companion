# Willison Regression Review — Observer Auto-Wake (fix-pass on top of 2026-05-13-0100)

Scope: `web/server/session-orchestrator.ts` (mandatory wake-version echo + downgrade path), `.council/prompts/observer-system.md` v1 (new `dropped` semantic in contract step 2 + version echo in output spec), `web/server/observer-prompt.ts` (wake body directive — re-read for cross-cut).

Convention floor (AP-1..AP-3, EC-1..EC-12) is not re-flagged.
Prior 24 closed findings are not re-flagged.

---

## P1 — Wake-body directive names the SOURCE field, not the ECHO field — every conforming observer mints findings that all downgrade to NOTE

**File:** `web/server/observer-prompt.ts:501` (wake body directive sentence)
**Cross-ref:** `.council/prompts/observer-system.md:121,141-142` (output spec uses `observer_wake_payload_version_echo`)
**Cross-ref:** `web/server/session-orchestrator.ts:1766-1791` (mandatory-echo downgrade path)

**Concrete failure mode.** The wake body's directive terminator ends with:

> "Emit one review file matching the `ObserverReviewPayload` JSON schema described in your system prompt. Echo `observer_wake_payload_version`, `session_group_id`, `checkpoint_id`, and `phase` from the manifest verbatim. Begin."

The named field — `observer_wake_payload_version` — is the **manifest's** key (set at `observer-prompt.ts:477`). It is **not** the review's echo key, which the system prompt specifies as `observer_wake_payload_version_echo` (line 121, 141). The wake body's directive instructs the observer to "echo `observer_wake_payload_version` ... verbatim from the manifest." A literal-following observer (the desirable behaviour the prompt's "verbatim" emphasis cultivates) will write:

```json
{ "schema_version": 1, "observer_wake_payload_version": 1, "checkpoint_id": "...", ... }
```

— mirroring the source field name verbatim, as the directive said. The parser at `council-types.ts:344` keys on the literal string `observer_wake_payload_version_echo`; the lookalike key is silently ignored. `wakeEcho` is `undefined`. The session-orchestrator branch at `1767` (`if (wakeEcho !== OBSERVER_WAKE_PAYLOAD_VERSION)`) fires — and the fix-pass deliberately collapsed missing-echo and mismatch into the same downgrade path (per closed Willison #12). All STOPs and WARNs in EVERY conforming review collapse to NOTE.

This is the worst kind of LLM-pipeline failure: the system is correct in isolation (system prompt → schema name is right; parser → schema name is right; orchestrator → downgrade path is right), but the **handoff prose** in the wake body crosses the wires. Two consequences:

1. The mandatory-echo defence (#12 close) becomes a **fail-loud-but-silent** trap: every legitimate observer review degrades to NOTE, BlockerBanner never fires, and the `observer.schema_mismatch` log line spams every checkpoint with `actual: undefined`. The user sees "Observer reviewed (skipped N)" forever, and a careful reader of logs would conclude the observer is broken — when really the **wake body** is misleading it.
2. The Carmack-philosophy advice in the system prompt ("be literal, evidence-grounded, do not paraphrase") works AGAINST correctness here: a sloppy observer that paraphrases the directive into "I should echo the version field" and reaches for the output-spec name might land on the right key by accident; the disciplined observer follows the directive literally and produces the WRONG key.

**Severity rationale.** P1 because: (a) it nullifies the closed #12 mandatory-echo contract by routing every conforming output into the downgrade-all path; (b) it is invisible to the test suite — fixtures hand-author `observer_wake_payload_version_echo` because the schema reader is in the same file as the schema writer, but a live observer reads the wake body, not the schema; (c) it is a single 2-word fix (`observer_wake_payload_version` → `observer_wake_payload_version_echo` in the directive, or, better, name the **echo** field and explain what to copy into it).

**Recommended fix shape (no code).** Replace the wake body's directive sentence with two clauses: (1) name the manifest field being echoed FROM (`observer_wake_payload_version`) and (2) name the review field to write it INTO (`observer_wake_payload_version_echo`). Example: "Set `observer_wake_payload_version_echo` in your review to the integer value of `observer_wake_payload_version` from the manifest below." This both pins the verb (echo = copy-the-integer-into-a-different-field) and removes the ambiguity. Pair with a fixture test in `observer-wake-fixture.test.ts` that asserts the wake body, when parsed by `validateObserverFindings` against a synthetic review using the source field name `observer_wake_payload_version`, yields `wakeEcho === undefined` — the canary that would have caught this.

**Why this isn't already caught.** No replay test uses an actual LLM-emitted review; the fixture pre-canonicalises the field name. The static-grep canary on the prompt (per Beck rec) checks for presence of the echo field name in the prompt body — not in the wake body. The two strings are in different files, both correct on their own, and the typo of intent lives across the boundary.

---

## P2 — Cached observer context is unrevocable mid-session; prompt v1's new `dropped` teaching applies only to observers spawned after the fix-pass landed

**File:** `.council/prompts/observer-system.md` (contract step 2 rewritten with `dropped` OUT-OF-SCOPE semantic)
**File:** `web/server/cli-launcher.ts` (system prompt applied via `applyCouncilObserverSpawnConfig` — at spawn argv, per EC-1)

**Concrete failure mode.** The observer's system prompt is delivered ONCE at CLI subprocess spawn — via `--append-system-prompt` (Claude) or `systemPrompt` option (Codex). The fix-pass rewrote contract step 2 to teach the `dropped` semantic ("Files listed under `dropped` are explicitly OUT OF SCOPE this cycle — even if you reviewed them before, do NOT re-read them now; their contents may have moved, been deleted, or been replaced with unrelated work, and citing them produces grounded-looking findings about state the orchestrator no longer considers part of the current phase").

A council pair spawned **before** the fix-pass landed runs the OLD prompt (the one that did not carry the `dropped` warning) for the entire lifetime of its CLI subprocess. The system prompt is not re-injected per wake — it's the system prompt, fixed at spawn. The orchestrator and observer share the workspace, not the conversation context; they don't get re-keyed between phases. Two consequences:

1. **The pre-fix-pass observer reads `dropped` paths anyway**, despite the wake body's prose ("Files listed under `dropped` are explicitly out of scope this cycle") which CAN be ignored because the system prompt outranks per-turn user-content in instruction priority for most model families. A pre-fix-pass observer that internalised the previous prompt's framing ("re-read everything in the manifest") may emit findings against `dropped` paths. Those findings have `evidence_path` in `dropped`, which is NOT in `modifiedFiles` (the grounding validator uses `manifest.delta`, not `manifest.delta ∪ manifest.dropped`), so they downgrade to NOTE — but the observer wastes turn budget reading the dropped files and the findings clutter the FindingsLog.
2. **The version echo is also a spawn-time contract**: the OLD prompt did not require it. An observer running the OLD prompt cannot be **told** to start echoing it via wake-body prose alone (user-content can't reliably override a system-prompt absence). All findings from pre-fix-pass observers downgrade to NOTE — quietly, indistinguishably from the P1 above.

**Severity rationale.** P2 because (a) it applies only to long-lived sessions that bridged the deploy moment, not to fresh ones; (b) the failure mode is fail-safe (downgrade-to-NOTE), not fail-open. But it deserves an explicit watch: a deployed Aura instance with hours-old council pairs SHOULD have a forced rotation path. The current implementation has none — the observer subprocess survives across server restarts via PID/reconnect.

**Recommended fix shape (no code).** Option A: bake the prompt's SHA-256 (`observerPromptSha256` is already on `SdkSessionInfo`) into a per-checkpoint comparison; if the running observer's prompt hash does not match the loader's current hash, force a relaunch on next checkpoint. Option B: include the prompt's SHA-256 (truncated, e.g. first 8 hex chars) in the wake body as `expected_observer_prompt_sha256_prefix`, and add a contract clause "if this prefix does not match the prompt you were spawned with, emit zero findings + one INFO finding stating the mismatch." Option B is safer (no kill) but depends on the observer being able to read its own prompt — which neither Claude nor Codex CLI expose to the model directly. Option A is the only one that works without protocol changes. The watchpoint is whether the rollout strategy includes "kill all pre-fix-pass observer halves on deploy."

**Cross-ref.** Memory `feedback_pin_dev_tool_versions_with_resolver_caret` (running build ≠ on-disk build, dual for prompts).

---

## P3 — `dropped`-in-prompt teaching makes the wake-body `dropped` mention redundant; consider shortening the body

**File:** `web/server/observer-prompt.ts:495` (wake body prose pointer)

The wake body's prose sentence currently says: "Read only the workspace-relative paths listed under `delta` and `carried` in the manifest below. Files listed under `dropped` are explicitly out of scope this cycle." The system prompt v1 contract step 2 now carries the `dropped` warning with much stronger framing ("even if you reviewed them before, do NOT re-read them now"). The wake body's second sentence is no longer load-bearing — the system prompt's version is stricter and more specific.

Two observations on whether to shorten:

1. **Redundancy is cheap defence.** Both Claude and Codex have shown drift in honouring system-prompt rules across long conversations (Willison's "context distraction" / "lost in the middle"). Repeating the constraint at the wake-body level — exactly where the manifest is — keeps the per-turn reminder near the data. Don't shorten.
2. **The wake body's redundancy is asymmetric.** It mentions `dropped` (the new addition) but does NOT mention `carried` having a different semantic from `delta` (read OR re-read). If the goal is to shorten, drop the `dropped` sentence and rely on the system prompt; if the goal is to be complete, mention what `carried` is for. Right now the body half-teaches.

**Recommended.** Keep the `dropped` mention in the body — the per-turn reminder is worth the few bytes. Watchpoint only; this is not a defect.

---

## NOTE — fence-triplet replacement at parser boundary preserves intent adequately for display, but mangles intent for future tooling

**File:** `web/server/council-types.ts:327`

The parser replaces `` ``` `` with `` ʼ`ʼ`ʼ` `` in `claim` fields at the validation boundary (closes Hunt #22). The substitution is on **input** parsing, not on output rendering, so by the time the chip displays the claim, the original triplet is gone — the user sees `ʼ`ʼ`ʼ`` literally. This is acceptable for human reading (visually distinct from regular code, signals "this had a fence triplet"), but if a future feature wants to round-trip the claim back into a tool (e.g. "open this finding's claim as a comment in the orchestrator's chat"), the substitution is lossy and the round-trip will not re-produce the original observer-emitted text.

Severity rationale: NOTE — not a defect today, watchpoint for any future tooling that treats `claim` as round-trippable. The current FindingsLog is display-only and the substitution choice is fine.

A more conservative variant: replace `` ``` `` with a Unicode-escape-bracketed marker like `[<fence:```>]` (with `<` and `>` literal) — visually distinct AND grep-able from logs back to original intent. But this is a stylistic call; do not change unless a round-trip use case emerges. **Hunt's concern**, properly — flagging here only for the LLM-output-rendering angle.

---

## Confirmations (no finding — fix landed correctly)

- **Number-type rigour on the echo**: `council-types.ts:346` rejects non-integer (`typeof v !== "number" || !Number.isInteger(v)`), so string `"1"` and float `1.0` both fail. `Number.isInteger(1.0)` is `true` in JS (because `1.0` is the same Number as `1`); the parser accepts it. That is correct behaviour — JS has no distinct integer type, and the JSON `1.0` literal serialises to the same Number as `1`. The only failure modes are non-integer Numbers (NaN, Infinity, decimals like `1.5`) and non-Number types. All correctly rejected.
- **Field-name explicitness in the system prompt**: the output spec at line 121 names `observer_wake_payload_version_echo`. An observer that emits `wakeEcho: 1` (different name) fails the parse — correct EC-5 behaviour.
- **Confirmation that `verbatim` is well-scoped in the SYSTEM PROMPT**: lines 141-142 say "must be the integer value of `observer_wake_payload_version` taken verbatim from the manifest JSON block." The two field names ARE both present here — source (`observer_wake_payload_version`) and target (`observer_wake_payload_version_echo`) — and the contract is unambiguous. The defect is solely in the WAKE BODY (P1 above), not the system prompt.

---

## Summary

- **1 P1** (wake body directive names source-field instead of echo-field — nullifies the #12 mandatory-echo close in the field).
- **1 P2** (cached observer context — pre-fix-pass observers run old prompt; no rotation mechanism).
- **1 P3** (`dropped`-in-prompt makes wake-body mention redundant; keep for defence-in-depth, watchpoint only).
- **1 NOTE** (fence-triplet substitution is lossy for hypothetical round-trip tooling; not a defect today).
