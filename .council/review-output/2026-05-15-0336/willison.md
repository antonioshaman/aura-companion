# Willison — LLM Pipeline Quality Review

**Scope:** Task 11.8 auto-proceed synthetic-frame send path. Reviewed against the LLM pipeline reference (Principles 1, 3, 4, 7) plus the trust-boundary framing the brief calls out.

**Stance:** This PR ships a *server-internal-origin* `user` NDJSON frame on the orchestrator socket — a frame that, on the wire, is byte-identical to a user-typed message. The CLI cannot tell them apart; the bridge tells them apart only at the recorder. That is the right framing. My findings concentrate on the gaps where that framing leaks: the denylist's defence-in-depth honesty, the gate's fail-open on probe-null, the absence of a replay-corpus regression for the new origin, and the operator-visibility loss for server-suppressed permission requests.

---

## P1 — Fix Now

### W-P1-1 — `can_use_tool` denylist gate fails open on `idleTimerProbe === null`

`claude-adapter.ts:896-913`. The gate predicate is:

```
this.idleTimerProbe?.isSyntheticTurnInFlight(this.sessionId) &&
isToolUseDeniedForSynthetic(...)
```

When `idleTimerProbe` is null — the documented default for unit-test paths *and* the production state during the boot window between `WsBridge` construction and `wsBridge.setIdleTimerProbe(...)` in `index.ts` — the optional chain short-circuits to `undefined` and the entire denylist branch is skipped. A `can_use_tool` arriving in that window flows through to the browser permission UI as normal, which is fine *only* if no synthetic frame can be in flight at that moment. There is nothing in the type system or runtime that asserts this invariant. Adapter constructors run *before* `setIdleTimerProbe` is called; if any code path manages to send a synthetic frame before the probe lands (today: no; tomorrow: one DI ordering change away), the gate is silently absent and the denylist promise of "destructive tools never get approved by auto-proceed" silently evaporates.

This is the exact `feedback_identity_binding_placeholder_void` shape your memory index already calls out: a recovery branch that's structurally unreachable in the failure case it claims to handle. Compounded by `feedback_recovery_branch_reachability` (sibling pattern). The unit tests for the gate inject a real probe; the no-probe path is never exercised under the synthetic-in-flight precondition because production never sets up that combination *yet*.

**Concrete failure mode:** A future refactor that moves synthetic-frame send earlier in the boot sequence (or a unit test that wires the synthetic path without wiring the probe) produces a session where `isToolUseDeniedForSynthetic` returns true for a Bash:git push command — but the outer guard short-circuits and the request reaches the browser permission UI looking like an ordinary tool call. If the user is genuinely AFK (which is the *only* time the synthetic fires), one click on a stale prompt by an inattentive operator approves it.

**Fix shape:** Assert non-null at the spawn seam (`applyCouncilObserverSpawnConfig`-equivalent for the orchestrator) — make probe a constructor *required* parameter for sessions in council mode, OR make the gate fail-closed on `idleTimerProbe === null` for ANY `can_use_tool` whose tool/input matches the denylist regardless of in-flight state (defence-in-depth over availability). The current shape optimises for "tests don't have to wire a probe" — a developer-ergonomics concern that buys ergonomic convenience by trading away the safety promise.

This is the LLM-pipeline analogue of Principle 3's *"LLM-graded permission with no rule-based fallback ... If 'allow', a transient model failure becomes an auth bypass."* The probe is functioning as the rule-based fallback here; nulling it is fail-open.

---

### W-P1-2 — No replay test exercises the `server:auto-proceed` origin

`recorder.ts:73-85` defines `"server:auto-proceed"` as a distinct provenance discriminant in the v2/v3 recording schema. `claude-adapter.ts:1159-1161` writes that origin on every synthetic-frame send. *No replay-based regression test in the new test files asserts that the recorder writes `origin: "server:auto-proceed"` on this path, nor that the replay loader round-trips the field without re-serialisation drift, nor that a replay corpus containing both `server:council-wake` AND `server:auto-proceed` entries can be filtered.*

Reference Principle 4 is unambiguous on this: *"Cross-reference `quality-realtime.md` Principle 7. The adapter, the validator, and the renderer all should have replay-based tests. Severity: P1 for load-bearing modules without replay tests."* The recorder origin field IS the load-bearing forensic discriminant the PR description leans on ("replays can distinguish auto-proceed-driven turns from council-wake-driven ones") — and there's nothing in CI that catches a regression where:

1. The synthetic-frame send accidentally drops the origin parameter (recorder defaults to "browser", which is the SILENT-WRONG state — replay tooling now thinks a user typed `[auto-proceed:idle-timeout]`).
2. The recorder reader/replay tool stops recognising the `"server:auto-proceed"` discriminant after a schema bump (today v3 — already at +1 vs when origin was introduced; v4 is plausible).
3. JSON re-serialisation in a future replay harness reorders object keys and the entry no longer matches a byte-level fixture expectation.

The PR description acknowledges this as scope-limited ("5-step race-regression integration test ... deferred"), but the gap matters at a *narrower* layer than full pipeline orchestration: a single-frame round-trip through `RecorderManager.record` → file → `replay.ts` loader, asserting the origin field survives, would close the most likely regression vector without any FakeClock plumbing.

**Concrete failure mode:** A future PR refactors `recorder.ts` to compact origin into a single-byte flag for disk-size reasons. Unit tests still pass (they assert the field exists at write time). Replay tools silently misclassify auto-proceed turns as browser-relayed → forensic analysis attributes operator actions to the user → incident response writes the wrong post-mortem.

**Fix shape:** One Vitest case that records a synthetic frame via `ClaudeAdapter.sendOrchestratorSyntheticFrame`, reads the resulting file with the replay loader, and asserts `entries[0].origin === "server:auto-proceed"` AND `entries[0].raw === <byte-identical expected frame>`. Add a second case with mixed `server:council-wake` + `server:auto-proceed` + (omitted) browser frames to prove the filter works. This is *the* replay regression vector the recorder origin discriminant was *added for*.

---

## P2 — Fix Soon

### W-P2-1 — Operator visibility loss: server-denied synthetic tool-uses never reach the permission UI or the chat history

`claude-adapter.ts:896-913`. When the denylist fires, the adapter:

1. Sends `{behavior: "deny", message: <human-readable>}` directly to the CLI.
2. Does NOT emit a `permission_request` to the browser.
3. Does NOT emit any `permission_denied` or `permission_auto_denied` signal to the browser.

The denial message is consumed by the CLI and appears in *its* assistant feedback channel — the user *might* see "tool call denied" in the next assistant turn, depending on how the model surfaces it. There is no first-class browser-side signal. The Council Mode `ObserverPanel` won't show it; `FindingsLog` won't show it; the chat thread won't show it as a server-side action.

Reference Principle 5: *"Tool call display — the user is the final auth check ... Building guardrails, permissions and approval flows is so critical."* The auto-proceed denylist *is* a guardrail. Operators reviewing a session after the fact need to see: "at 14:23:11, auto-proceed attempted `Bash:git push` and the server denied it." Without this, the operator only learns of the denial via the CLI's assistant prose, which the model can paraphrase, summarise, or omit. The forensic trail is in the recording — but the *live operator surface* has no signal.

The asymmetry is also notable: a *user-typed* `Bash:git push` during a synthetic-in-flight window WOULD be denied via the same path (since the gate doesn't distinguish provenance), but the user only sees the CLI's prose-paraphrased message, not a structured "this was server-blocked because auto-proceed is in flight" affordance.

**Concrete failure mode:** An operator returns from AFK, opens the chat, sees the model said "I tried to run `git push` but it was blocked." They have no way to know: was this a normal Claude permission denial? A user-set permission rule? Or the auto-proceed denylist? Triage takes longer than necessary; operators distrust the auto-proceed feature because they can't see *what it suppressed*.

**Fix shape:** Emit a `permission_auto_denied` (or piggyback on an existing system_event subtype) browser message with `{request_id, tool_name, input, reason: "auto-proceed-denylist", denial_message}`. Render in the chat thread as a server-action chip — same visual weight as a tool_progress, with the denylist match shown verbatim. This makes the synthetic-frame gate *visible* without making it *clickable* (operators can't override the denial — the synthetic context is precisely the wrong moment to ask for input).

Severity P2 not P1 because: forensic trail IS in the recording (operator can reconstruct), and the failure mode is degraded observability, not safety bypass.

---

### W-P2-2 — Denylist is per-tool-prefix-string, not CLI-version-aware

`auto-proceed-permissions.ts:61-66`. The denylist is a hard-coded `ReadonlySet<string>` keyed `"Bash:git push"`, `"Bash:git commit"`, `"Bash:gh pr create"`, `"Bash:gh pr merge"`. Reference Principle 7: *"Hard-coded tool names ... Code that requires a tool to be in a known set, and rejects unknowns, breaks on CLI upgrade. Severity: P2 for tool name allowlists with no fallback."*

The denylist itself is fine — it's a *denylist*, so a CLI upgrade that introduces a new dangerous tool name (e.g. `Bash:git push --tags` as a separate tool, or a hypothetical `GitOps` first-class tool, or Codex's tool naming convention diverging) silently doesn't match the prefix and the new operation passes the gate. This is the documented limitation, BUT:

- The Codex backend is mentioned nowhere in this module. The `BackendProvider` seam supports `claude+codex` pairings (CLAUDE.md says so). Codex's `can_use_tool` request shape may not be `Bash:command` at all — it may surface as a different tool name or input shape entirely. If a Codex orchestrator (or future Codex auto-proceed) ever reaches this gate, the denylist returns false for ALL inputs and the gate is functionally absent.
- There is no test that asserts the denylist behaviour against a Codex-shaped `can_use_tool` payload. The gate is wired into `claude-adapter.ts` only; if `codex-adapter.ts` ever grows a parallel synthetic-frame path, this denylist silently doesn't follow.

**Concrete failure mode:** A future PR adds auto-proceed to the Codex half of a council pair. The author copies the `sendOrchestratorSyntheticFrame` shape but the `can_use_tool` gate in `codex-adapter.ts` either doesn't exist or matches against `Bash:` prefixes that Codex never produces. The denylist appears wired but is structurally unreachable. (Same pattern as W-P1-1 — `feedback_recovery_branch_reachability`.)

**Fix shape:** Either (a) document in the module preamble that this denylist is Claude-Code-tool-naming-specific and Codex requires a parallel module, OR (b) lift the denylist into a backend-agnostic `BackendProvider`-injected predicate so each adapter implements its own matching against its own tool-call shapes. (a) is sufficient for this PR; (b) is the proper architectural target.

---

### W-P2-3 — Synthetic frame body shape is `content[0].text` only — no marker that survives prompt rewriting

`claude-adapter.ts:1141-1146`. The synthetic frame is:

```
{type:"user", message:{role:"user", content:[{type:"text", text:<content>}]}, ...}
```

`<content>` is the assembled wake message body. There is *no structural marker* in the NDJSON that says "this is server-synthesised, not user-typed." The only provenance signal lives in the recorder origin field, which the CLI never sees. The CLI's session state, when serialised for a future `--resume`, will replay this as a literal user message — no different from any other.

Reference Principle 1: *"LLMs are unable to reliably distinguish the importance of instructions based on where they came from."* This is the *protocol-level* version of that principle. The orchestrator CLI will, in future turns, see the synthetic frame in its conversation history and may quote it back, treat it as user intent, or — most concerningly — use it as precedent ("the user asked me to auto-proceed earlier, so I should keep proceeding"). The content text presumably starts with `[auto-proceed:idle-timeout]` per the plan name, but that's *prose*, not structure — the model can ignore it.

This is partially out of scope for this PR (the wake-payload builder isn't in the reviewed diff) but the *send seam* in the adapter is the right place to assert the invariant. If the payload builder ever drops the `[auto-proceed:...]` prefix the gate has nothing to enforce it — and the model has nothing to distinguish "I was nudged" from "I was instructed."

**Concrete failure mode:** A model rewrites its understanding of its own instructions across compaction. The `[auto-proceed:idle-timeout]` prefix is summarised away during a `compact_boundary` event (`claude-adapter.ts:689-697` proves these are real). After compaction, the conversation history shows "user said proceed" with no indication it was synthetic. Subsequent auto-proceed nudges chain on top of the rewritten context, amplifying the model's confidence that the user wants this. Context-distraction in the prompt-injection sense.

**Fix shape:** Assert (at the adapter send seam) that `content` starts with the documented synthetic marker prefix (e.g. `[auto-proceed:idle-timeout]`). Reject the send if not — same severity as the existing NDJSON line-discipline check (line 1147). This is a cheap tripwire that catches builder regressions. P2 not P1 because the prefix-presence is *probably* asserted by the payload builder upstream — this just makes the seam-level invariant explicit.

---

## P3 — Consider

### W-P3-1 — Denial-message text is rendered verbatim by the CLI assistant turn — markdown injection surface

`auto-proceed-permissions.ts:111-120`. The denial message includes the command head wrapped in backticks:

```
return `Auto-proceed synthetic frame may not invoke destructive operations (denied: \`${head}\`). Engage manually to push / commit / open PRs.`;
```

`head` is the first 80 chars of the trimmed first line of the command — extracted directly from `toolInput.command`. The CLI's `can_use_tool` deny response feeds this string back into the assistant feedback loop, where it likely renders as markdown in the user's chat surface (the standard `MessageBubble` rendering).

If `head` contains markdown control characters — e.g. `git push  ](javascript:alert(1))` or `git push\n\n# Heading injection` — the resulting denial message becomes:

```
... (denied: `git push  ](javascript:alert(1))`). Engage manually...
```

The backtick wrapping mitigates this (markdown-code-span is render-safe for most control chars), but: the `\n` in head is already split out (line 115's `.split("\n", 1)[0]`), and trim handles leading whitespace; backticks inside the command head, however, *would* terminate the code span early and let downstream markdown render. Reference Principle 1: *"Tool output displayed without escaping ... Always render tool output as plain text (or fenced code), never as markdown."*

**Concrete failure mode:** Low. The denial message round-trips through the CLI (which is the user's own claude-code process running with their model), so any exploit here requires the CLI itself to have been prompt-injected into producing a command with embedded backticks AND for the renderer to honour markdown in tool-feedback context. The combination is low-probability, but the gap is structurally identical to `feedback_format_transformation_validation` in your memory index — the wrapper trusts upstream validation that doesn't cover format-specific escape chars.

**Fix shape:** Either (a) strip backticks from `head` before interpolation, OR (b) document that the renderer must treat denial messages as code, not markdown. Both are cheap; (a) is one line.

---

### W-P3-2 — No CLI version detection on the synthetic-frame send path

`claude-adapter.ts:1126-1172`. The synthetic-frame send uses a hard-coded NDJSON envelope shape (`type:"user"`, `message:{role:"user", content:[{type:"text", text:...}]}`, `parent_tool_use_id:null`, `session_id:""`). This shape is *current* Claude Code SDK convention. Reference Principle 7: *"The bridge should detect the running CLI version ... When a bug report comes in, you need to know which protocol version the recording targets."*

There is no log line at send time that says "Claude Code version X.Y.Z saw a synthetic frame" — and `CLISystemInitMessage.claude_code_version` IS available on init (it lands on `SessionState` per `handleSystemInit:798`). When the synthetic frame's envelope shape eventually drifts vs a future Claude Code version's `user`-frame expectation, the recording won't record what version was running unless the operator manually correlates timestamps with the init frame's version field.

**Concrete failure mode:** Low. Recordings DO carry the init frame, so the version IS recoverable. The gap is convenience, not correctness.

**Fix shape:** Add a one-time structured log at first synthetic-frame send per session: `{event: "auto-proceed.first-send", sessionId, claudeCodeVersion}`. EC-9 shape per the project's convention floor. P3 because the data IS already in the recording.

---

## Honest scope-limits acknowledged

- The brief flagged: "no new replay tests added for synthetic-frame send path — gap?" → W-P1-2 confirms this. I'm calling it P1 because the recorder origin field is the *explicit replay-distinguisher* the PR added, and there's no test that exercises it.
- The brief flagged: "denied synthetic tools never reach browser permission UI — operator visibility loss?" → W-P2-1 confirms; severity P2 because the recording preserves the trail, only the *live* surface is missing.
- The brief flagged: "deterministic fallback on probe-null (gate falls open: safe default for development, but if a production deploy ships with null probe nothing prevents auto-proceed from approving dangerous tools)" → W-P1-1 confirms; severity P1 because the failure mode is silent (no test catches it; no log line fires) and the invariant lives in DI ordering that next-refactor can flip.
- The brief flagged: "denylist as defence-in-depth NOT primary safety (string-match cannot catch `bash -c 'rm -rf'` style chained-or-substituted commands)" → The module preamble already documents this limitation explicitly (`auto-proceed-permissions.ts:40-52`). I am NOT flagging this — the honesty is appropriate for the gate's positioning. The PR description's stance ("behavioural guardrail, not security boundary") matches the implementation. **Not a finding.** (If a future PR moves this gate into a position where it IS load-bearing for security, re-evaluate then.)
- The brief flagged: "model/CLI version portability (no hard-coded allowlists in scope; check)" → Confirmed no hard-coded allowlists; the *denylist* has the Codex-blind shape gap (W-P2-2), but that's a different concern.

## Out of scope (deferred to other reviewers)

- General prompt-injection in the wake-payload content itself: not in this PR's diff — the wake builder is upstream.
- Sticky-token race conditions / cleanup paths in `IdleTimerManager`: out of scope (Subprocess Lifecycle reviewer).
- General secret-redaction policy in the recorder: pre-existing v3 schema, not in this PR.
- WebSocket transport-state semantics on the synthetic-frame socket: Realtime/NDJSON reviewer.

---

**Summary:** 2 × P1 (probe-null fail-open + missing replay-corpus regression on `server:auto-proceed` origin), 3 × P2 (operator visibility loss for denied tools + Codex-blind denylist scope + missing structural marker on synthetic frame body), 2 × P3 (markdown injection in denial message + no CLI version stamp on first synthetic send). The PR's *framing* is correct — the trust-boundary characterisation in the module comments + recorder origin field is well-conceived. The *gaps* are at the seams where that framing is supposed to be enforced but is in fact only documented.
