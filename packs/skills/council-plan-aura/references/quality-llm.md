# LLM Pipeline Quality Reference — Carmack × Simon Willison

Philosophy: John Carmack. Production LLM expertise: Simon Willison (Datasette, LLM CLI, prompt-injection canon, 8,000+ logged LLM interactions).
Stack context: Aura Companion is a **protocol bridge** between a browser and a local LLM CLI (Claude Code or Codex). It is NOT an LLM client — it does not call models directly. The LLM-shaped surfaces in this codebase are:
- `web/server/claude-adapter.ts` — NDJSON translation, message dedup, stream lifecycle.
- `web/server/ai-validator.ts` — rule-based + LLM-graded permission gating.
- `web/server/recorder.ts` — every byte both directions, replayable for regression.
- Tool call rendering (`MessageBubble`, `ToolBlock`) — display of arbitrary tool inputs/outputs from the LLM.

Every finding must describe the **concrete failure mode** — not just "this is bad practice."
Security patterns (prompt injection as security) are in `security.md` (Hunt). Async/error discipline in `quality-backend.md`. Realtime protocol shape in `quality-realtime.md`. This doc covers: stream lifecycle correctness, tool-call display safety, AI-validator discipline, recording-based replay, content trust boundaries, prompt-injection defence at the renderer layer.

---

## Principle 1: The bridge isn't the model — but everything it touches is LLM-shaped

*Carmack: "Make data flow visible and explicit."*
*Willison: "LLMs are unable to reliably distinguish the importance of instructions based on where they came from." Content from the CLI may contain quoted user prompts, tool outputs, file contents, even injected instructions.*

The Companion bridge is downstream of an LLM. Every byte that flows through it should be treated as untrusted content that has already been "blessed" by an LLM that may have been tricked. The renderer is the last line of defence.

### What to check

**Renderer assumes the LLM's output is safe**
- The chat surface renders assistant content as markdown. If the markdown renderer allows raw HTML or arbitrary URLs, an LLM that was prompt-injected can produce content that exfiltrates state. Cross-reference `security.md` Principle 1.
- Severity: **P1**.

**Tool output displayed without escaping**
- `ToolBlock` renders tool results. If a tool returns content containing markdown control characters or HTML, it can hijack the chat layout or trick the user. Always render tool output as plain text (or fenced code), never as markdown.
- Severity: **P1**.

**Tool input shown as-is to the user**
- A `can_use_tool` request includes the tool's input. The user reviewing must see the actual bytes, not a "rendered" version that could hide newlines, ANSI escapes, or homoglyphs.
- Severity: **P1**.

---

## Principle 2: Stream lifecycle correctness — start, append, finish, error

*Carmack: "If a mistake is possible, it will eventually happen."*
*Willison: "Half the work is figuring out how to work around the limitations." Streaming LLM output has at least four states; treating it as a single happy path produces silent UX bugs.*

### What to check

**No clear "stream complete" state in store**
- The store may have `messages[id].content` that's appended to, but no `status: 'streaming' | 'complete' | 'errored'`. UI can't differentiate "still typing" from "stopped mid-word due to error".
- Severity: **P2** for the message status not having a complete state machine.

**Stream completion not flushed to persistence**
- A message that's streaming when the server crashes leaves the session JSON with a partial `content`. On reload, the UI either shows the partial as if complete (wrong) or fails to render (also wrong). Cross-reference `quality-persistence.md` Principle 2.
- Severity: **P1**.

**Error mid-stream silently dropped**
- If the CLI errors after sending 80% of a response, the user sees a truncated message with no indication. Must show "Stream interrupted: <reason>" inline.
- Severity: **P2**.

**Streaming + tool call interleaved without state**
- The CLI may interleave a tool call inside a streaming response. The renderer must handle a tool-block appearing mid-text, then more text after the tool result. Cross-reference `quality-realtime.md`.
- Severity: **P2** for tool-mid-stream rendering bugs.

---

## Principle 3: ai-validator — gate by rule first, by model second

*Carmack: "Use the type system as armour."*
*Willison: "Both automated evals AND human vibe checks are necessary — neither alone is sufficient."*

`ai-validator.ts` decides whether a tool call requires user confirmation. It can combine deterministic rules (tool name + path allowlist) with LLM-based grading. Each mode has its own failure profile.

### What to check

**LLM-graded permission with no rule-based fallback**
- If the AI validator's model call fails (rate limit, network, malformed response), permission decisions default to … what? If "deny", the user is locked out on flakes. If "allow", a transient model failure becomes an auth bypass. Both are bad without an explicit default + visible state.
- Severity: **P1** for fail-open. **P2** for fail-closed without UI feedback.

**Rule allowlist drift**
- A "safe tools" list embedded in code. Without versioning or a test that asserts known-safe tools are listed, a refactor can silently drop entries.
- Severity: **P2**.

**No log of validator decisions**
- Every permission decision (allow/deny + reason) should be loggable for post-hoc audit. Without logs, users can't reconstruct "why was this allowed?"
- Severity: **P3**.

**Validator output not validated**
- If the validator is an LLM call returning JSON, parse with try/catch, validate against expected schema, fail-closed on bad JSON.
- Severity: **P1** for unchecked JSON parse on a security-gating call.

---

## Principle 4: Recording-based replay — your only honest regression test

*Carmack: "If you can't reproduce a bug, you can't fix it."*
*Willison: VS Code's "SQLite-based caching mechanism" enables deterministic tests against LLM outputs.*

Recordings are the project's secret weapon for testing. Any reported bug becomes reproducible: replay the recording, get the same broken state.

### What to check

**No replay test against recorded sessions**
- Cross-reference `quality-realtime.md` Principle 7. The adapter, the validator, and the renderer all should have replay-based tests.
- Severity: **P1** for load-bearing modules without replay tests.

**Replay broken by re-serialisation**
- A recording test that loads JSONL, parses, re-serialises, and feeds back drifts on whitespace. The replay must use the EXACT raw string. Cross-reference `quality-persistence.md` Principle 7.
- Severity: **P1**.

**Replay only happy-path recordings**
- A library of recordings should include error cases, interruptions, mid-stream disconnects. If only "successful sessions" are recorded, regressions in error handling never trigger.
- Severity: **P2** for replay corpus without negative cases.

---

## Principle 5: Tool call display — the user is the final auth check

*Carmack: "Make the wrong thing impossible."*
*Willison: "Building guardrails, permissions and approval flows is so critical."*

`PermissionBanner` shows the user what tool the LLM wants to run. This is the moment where the user decides whether to trust the LLM's intent. The display has to communicate clearly enough that the user catches a malicious or surprising tool call.

### What to check

**Tool diff not visualised**
- A `Write` or `Edit` tool call should show old/new contents (or diff) for the file being modified. A button "Allow Write to foo.py" with no preview is meaningless — the user has no idea what's being written.
- Severity: **P1** for write-style tools without preview.

**Long tool inputs truncated without "expand"**
- A 100-line command shown as the first line + "…" hides the dangerous part. Expandable display is mandatory.
- Severity: **P2**.

**Permission suggestions auto-applied**
- The CLI can offer `permission_suggestions` (e.g. "add this command to your allowlist"). Auto-clicking these on Enter without explicit confirmation is the single-shot-ack failure pattern from your memory: `feedback_single_ack_defensive_path_first`. Make the default action conservative; require explicit confirmation for ever-permitting.
- Severity: **P1** for auto-apply on permission suggestions.

**Markdown links in tool descriptions clickable without warning**
- A `description: "View [the docs](http://evil.example)"` becomes a clickable link in the banner. The user clicks expecting docs and gets phished. Strip markdown link rendering from tool metadata, or show URLs verbatim.
- Severity: **P2**.

---

## Principle 6: Log every CLI message — the bridge IS the observability

*Carmack: "If you can't measure it, you can't improve it."*
*Willison: "Keep reading logs until you feel like you aren't learning anything new."*

The recorder is the observability layer. If it's missing, sparse, or lossy, you cannot debug LLM behaviour.

### What to check

**Recording disabled by default**
- `COMPANION_RECORD=0` is the off switch. The default must be ON (per CLAUDE.md it is). Verify no path silently disables recording in error conditions.
- Severity: **P2**.

**Per-session vs per-process recording confused**
- Cross-reference `quality-persistence.md` Principle 5 and `quality-subprocess.md` Principle 8.

**No way to extract a specific session's recording**
- Recordings are findable by REST endpoint per CLAUDE.md. Verify the path actually works and returns the full file.
- Severity: **P3**.

---

## Principle 7: Model/CLI portability — versions shift, behaviour shifts

*Carmack: "Don't build on assumptions you can't verify."*
*Willison: "The best available model for a task can change every few months."*

The CLI version is the determining factor for protocol shape, available tools, and permission semantics. Hard-coded assumptions about a specific CLI version are versionic debt.

### What to check

**Hard-coded tool names**
- Code that branches on `if (toolName === 'Edit')` is fine as long as new tools are tolerated (fall through to generic display). Code that requires a tool to be in a known set, and rejects unknowns, breaks on CLI upgrade.
- Severity: **P2** for tool name allowlists with no fallback.

**Hard-coded message type discriminators without default**
- Cross-reference `quality-realtime.md` Principle 7.
- Severity: **P2**.

**No CLI version detection**
- The bridge should detect the running CLI version (`claude --version`) and log it with every session. When a bug report comes in, you need to know which protocol version the recording targets.
- Severity: **P3**.

---

## Principle 8: Context propagation — what state crosses the LLM boundary

*Carmack: "Validate at the boundary."*
*Willison: "Context distraction — when context grows so long that the model over-focuses on it."*

The Companion doesn't construct prompts directly, but it does decide what state the CLI sees on resume, what tool history is replayed, and what the AI validator sees when grading.

### What to check

**AI validator prompt includes irrelevant history**
- If the validator's prompt is "here's the entire session, decide if this tool call is safe", it suffers context distraction. Validator should see: the proposed tool, the file paths, recent few messages — not the whole session.
- Severity: **P2** for over-broad validator prompt.

**Resume sends only metadata, not tool outputs**
- CLI resume by ID. If the CLI's notion of resume doesn't include previously-displayed tool outputs, behaviour diverges from pre-restart. Document or fix.
- Severity: **P3**.

---

## Principle 9: Non-determinism — same bytes, same effect

*Carmack: "If you can't reproduce a bug, you can't fix it."*
*Willison: "Programmer tests should be deterministic."*

The bridge itself is deterministic in code, but its behaviour depends on the CLI subprocess which is non-deterministic. The strategy: feed deterministic inputs (recordings), assert exact outputs.

### What to check

**Tests against live CLI**
- A test that spawns the actual CLI and asserts on its output is flaky by construction. Use recordings.
- Severity: **P2**.

**Validator tests with live LLM**
- If `ai-validator.ts` calls a real LLM in tests, the suite is slow, costs money, and is unreliable. Mock the model boundary; assert the validator's decisions on the mocked outputs.
- Severity: **P1** if tests gate CI.

---

## Principle 10: Know your gaps

*Carmack: epistemic humility.*
*Willison: openly admits eval practice is "still evolving."*

### Areas this doc is weaker on (supplement from other sources)

- **Direct LLM API client patterns**: not applicable — we don't call models directly. If `ai-validator.ts` evolves to call a model API, supplement with general LLM API best-practices.
- **Streaming JSON parse robustness**: covered by `quality-realtime.md`.
- **Token budgets / cost control**: the CLI handles its own token economy. Not the bridge's concern.

---

## Quick Reference: Severity Guide

| Severity | Pattern | Examples |
|----------|---------|----------|
| **P1 — Fix Now** | LLM content executes / silently corrupts / bypasses gate | Renderer trusts LLM output, tool output rendered as HTML/MD, validator fail-open on model error, no replay test on load-bearing module, replay broken by re-serialisation, write-tool permission with no preview, auto-apply on permission suggestions, unchecked JSON parse in validator, validator tested with live LLM in gated CI |
| **P2 — Fix Soon** | Stream state confusion, audit gaps, drift potential | No stream-complete state, error mid-stream silently dropped, tool input truncated without expand, validator allowlist without test, recording corpus without negative cases, over-broad validator prompt, hard-coded tool allowlist without fallback |
| **P3 — Consider** | Observability hygiene, version visibility | No CLI version detected per session, recording extraction edge cases, no decision log on validator |

### The Overriding Filter

Before writing any finding, apply the Willison-Carmack synthesis:

1. **Is LLM-shaped content rendered/executed without escape?** P1 — this is the most common injection vector.
2. **Is the stream lifecycle fully modelled?** Half-streaming + crash = corrupt state.
3. **Does the AI validator have a deterministic fallback for model failures?** Otherwise its decisions are non-deterministic security gates.
4. **Is there a replay test for this module?** If not, regressions slip silently.
5. **Does the user see enough to give informed consent to tool calls?** A "trust" UI with no preview is meaningless consent.
