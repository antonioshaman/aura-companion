# Hunt — Security Review

Scope: observer-write-policy, observer-permissions, group-authorization, codex-envelope, backend-provider, session-types (sessionGroupId entropy cross-ref).

The big picture: the **predicates landed correctly**. `isObserverWriteAllowed`, `parseCodexFrame`, `authorizeGroupAccess` are individually robust, well-tested, and fail-closed on every malformed input I could think of. Group-ID entropy is 128 bits via `randomBytes(16)` — clean. The headline risk is **not the predicates — it is that none of them are wired yet**. Five out of the eight security-critical helpers in this batch have zero production call sites; the wiring is deferred to Tasks 12/13/15. That is fine *as a plan*, but it means a developer landing the wiring without Hunt-level care can ship the IDOR/RCE this scope is supposed to prevent. The findings below are weighted accordingly: where the predicate is correct but the contract on its caller is non-obvious or fail-open by default, I have flagged that explicitly per the user's `feedback_no_sentinel_user_id_fallback` memory.

---

FINDING:
- Title: Observer Write/Edit tools not bound to path allowlist at spawn — `isObserverWriteAllowed` is orphaned
- File: observer-permissions.ts:25-32 (allow-list includes Write/Edit unconditionally); observer-write-policy.ts:1-43 (predicate has no production caller)
- Principle: P1 ("If it's syntactically possible, it statistically exists") + P7 ("Assertions as tripwires — access control")
- Severity: P2
- What's wrong: The observer spawn profile grants `Write` and `Edit` to the SDK with no path constraint. The path allowlist (`isObserverWriteAllowed`) is a pure predicate that nothing calls — there is no `can_use_tool` handler in this batch that consults it. The observer is currently bounded by the SDK's *tool* set only, not by *what those tools may touch*.
- Consequence: A prompt-injected observer can `Write` to `package.json`, `.husky/pre-commit`, `src/**` — the entire workspace surface — and the workspace-allowlist module is dead code until somebody remembers to wire it. The PLAN's "irreversible security decision" rides on a contract that exists only in JSDoc.
- Fix: Before Task 13 lands the observer spawn, gate Write/Edit through a `canUseTool` callback that calls `isObserverWriteAllowed(absResolvedTargetPath, realpathSync(workspaceRoot))` and denies on `false`. Add a startup integration test that spawns a fake observer, attempts a Write to `<workspace>/src/foo.ts`, and asserts denial — that test will go red the day someone deletes the wiring.

---

FINDING:
- Title: Path-allowlist predicate documents `realpath` as caller responsibility but does not enforce it — fail-open by construction
- File: observer-write-policy.ts:11-18 (the contract is documented in prose, not in code)
- Principle: P7 ("Broken access control is #1 on OWASP for a reason")
- Severity: P2
- What's wrong: The doc-comment says "callers are expected to `realpathSync` the path first so symlinks cannot escape the workspace." This makes the predicate's correctness contingent on every future caller remembering an external invariant. Per the user's `feedback_no_sentinel_user_id_fallback` memory, defence by convention rots; defence by construction holds.
- Consequence: A future caller who passes the raw target path forward (e.g. the value straight off a Codex tool-call envelope) sees `${WS}/.council/observer/escape` accepted, with `escape` being a symlink to `/etc`. The observer writes to `/etc/whatever-it-named` via that symlink and the predicate has no idea.
- Fix: Either (a) inline `realpathSync` inside the predicate, treating non-existent paths by climbing to the nearest existing parent and re-resolving, or (b) introduce a thin `assertObserverCanWrite(target, workspaceRoot)` wrapper that does the `realpath` + predicate call as one unit, and require all callers go through it (do not export the bare predicate). I'd take (b) — keeps the predicate pure for unit tests and makes "the unsafe path" un-callable by typing.

---

FINDING:
- Title: Observer denylist omits the canonical escalation vectors — `Task` (subagent spawn), MCP wildcards, `SlashCommand`, `ExitPlanMode`
- File: observer-permissions.ts:39-46 (deny list); observer-permissions.ts:25-32 (allow list)
- Principle: P5 ("Shrink the attack surface") + P1 ("If it's syntactically possible, it statistically exists")
- Severity: P2
- What's wrong: The deny list covers Bash/network/notebook but omits `Task`, `mcp__*`, `SlashCommand`, and `ExitPlanMode`. If the underlying Claude Code SDK treats `allowedTools` as authoritative (allowlist semantics) then the omission is harmless; if it treats `disallowedTools` as authoritative or merges both, an unlisted tool stays open. `Task` is the worst of these — a `Task` invocation spawns a subagent whose tool set is inherited or fresh, which is the textbook denylist bypass.
- Consequence: If allowlist semantics turn out not to be strict (or change in a future SDK update), a prompt-injected observer reaches `Task` → spawns a subagent with default tools → that subagent has `Bash`. The two `permissionMode: "default"` prompts en route are exactly the kind of thing prompt injection talks an LLM into auto-approving on the orchestrator side.
- Fix: Add `Task`, `SlashCommand`, `ExitPlanMode`, and `mcp__*` (or an enumerated explicit list of every MCP server name the orchestrator knows) to `OBSERVER_DISALLOWED_TOOLS`. Cross-link to the SDK's documented allow-vs-deny precedence in the comment so a future reader knows whether the redundancy is load-bearing or belt-and-braces.

---

FINDING:
- Title: `permissionMode: "default"` for the observer relies on a wired `can_use_tool` handler that does not exist yet — risk of fail-open prompts auto-resolving to allow
- File: observer-permissions.ts:48-53 (chooses "default" mode); observer-permissions.ts (no can_use_tool wiring exported)
- Principle: P9 ("Assume breach — design for failure")
- Severity: P2
- What's wrong: The comment claims "Council Mode wires these straight to deny so the observer cannot escalate at runtime." No such wiring exists in this batch. With `default` mode, the SDK will emit `control_request` (subtype `can_use_tool`) for each tool invocation. If those land on the existing `ws-bridge.ts` permission path, the orchestrator UI will be asked to approve observer tool calls — there is no observer UI yet (Task 15 deferred). Behaviour is then dictated by the bridge's idle/timeout default, which historically is "wait forever" but could be misconfigured to allow.
- Consequence: Either the observer hangs forever on every tool call (DoS — observer feature unusable), or worse, a misconfigured bridge auto-approves and Bash is one prompt-injection away.
- Fix: Pin the observer to a stricter mode that does not require runtime approval (e.g. `acceptEdits` is wrong here — pick a profile that denies on miss rather than prompts), or ship the `can_use_tool` handler in this same change so the wiring is not split across two PRs. Document in the comment what happens when no handler is registered, and prove it with a test that spawns an observer with no handler and asserts denial-by-timeout, not approval.

---

FINDING:
- Title: `authorizeGroupAccess` does not bind group ownership to the requesting host token — bearer-token sharing degrades into IDOR
- File: group-authorization.ts:16-22
- Principle: P7 ("IDOR on session/recording/env endpoints")
- Severity: P2
- What's wrong: The predicate verifies (a) ID shape and (b) ID known to coordinator — but not (c) "the token presenting this request created or owns this group." Aura's threat model is single-user-local so any holder of the host token is "the user", which makes this acceptable today. In any deployment where two humans share a Companion host (e.g. team dev box, the eventual Cursor Cloud multi-user scenario hinted at in CLAUDE.md), it collapses into classical IDOR — any token holder enumerates `grp_*` and reads/kills any group.
- Consequence: One developer kills another developer's running pair, or attaches their observer to a running orchestrator they did not start, reading its workspace artefacts.
- Fix: Add an `ownerToken` (or `creatorPrincipal`) field to `GroupRecord` populated at `createGroup`, and require `authorizeGroupAccess` to receive the verified principal and compare. Document the single-user assumption explicitly in the JSDoc so a future deploy that breaks it forces a code change rather than silently inheriting the gap.

---

FINDING:
- Title: `parseCodexFrame` accepts frames without the `jsonrpc: "2.0"` marker — strict-parser claim is not fully strict
- File: codex-envelope.ts:54-105
- Principle: P2 ("Automate defences — TypeScript and lint are your continuous validators")
- Severity: P3
- What's wrong: The parser validates method shape, id shape, params shape, and field mutual-exclusion — but never reads `jsonrpc`. A frame `{id:1, method:"x", params:{}}` is accepted as a "request" with no JSON-RPC version tag. The doc-comment promises strict typing; missing the version check is a small leak in that promise.
- Consequence: A drifted Codex implementation (or a hostile process spoofing Codex frames over the local bridge) can send envelopes that do not conform to JSON-RPC 2.0 at all, and the bridge happily processes them. Low impact today because nothing downstream branches on the version, but it weakens the parser's "strict gate" framing.
- Fix: Require `parsed.jsonrpc === "2.0"` as the first shape check after `isObject`. Add a unit test that asserts `null` for frames missing the version tag and for frames carrying `"1.0"` / `"2.1"`.

---

FINDING:
- Title: `parseCodexFrame` accepts unbounded `error.data` — secret/PII leak vector into recordings
- File: codex-envelope.ts:96-100
- Principle: P3 ("Minimise state — recordings, sessions, env profiles")
- Severity: P3
- What's wrong: The parser bounds `error.message` to 4000 chars but passes `error.data` through unvalidated and unbounded. JSON-RPC error `data` is free-form by spec, but anything that reaches this parser is destined for `ws-bridge.ts` + `session-store.ts` + `recorder.ts`, where unbounded blobs bloat session JSON and recordings.
- Consequence: A misbehaving or hostile Codex emits a 5 MB structured `data` payload with environment dump including API tokens or filesystem contents. It lands on disk in plaintext in `~/.companion/recordings/` per the recorder design. The host then ships those recordings to whoever has read access to that directory.
- Fix: Either drop `data` entirely (callers do not currently use it), or cap it via a JSON-stringify-then-length check (e.g. reject if `JSON.stringify(data).length > 16_000`). If kept, also document that `data` is opaque and the bridge must never render it as HTML/markdown.

---

FINDING:
- Title: `backend-provider.ts` identifies binaries by bare name — relies on PATH integrity for the spawn call site
- File: backend-provider.ts:16-24
- Principle: P5 ("Shrink the attack surface") + P3 ("Minimise state")
- Severity: P3
- What's wrong: `binaryName: "claude"` / `binaryName: "codex"` will be resolved via PATH at spawn time. The seam doesn't itself spawn, so this is a contract on the eventual caller — but the contract is "trust PATH." On any host where a directory earlier in PATH is user-writable (e.g. `~/.local/bin` poisoned by a malicious npm postinstall — CLAUDE.md flags two blocked postinstalls), an attacker substitutes a fake `claude` binary that gets driven by the orchestrator.
- Consequence: Local privilege/scope escalation: the substituted binary inherits everything Aura would have handed to the real CLI — env vars, FS access, all CLI flags.
- Fix: Resolve to an absolute path once at boot (`which claude`) and store that path on the provider, or accept a `binaryPath` override from config. Reject relative paths and any path containing `..`. This is also the right place to enforce a non-shell `Bun.spawn(..., { shell: false })` contract on whatever consumes the provider — flag it now while the seam is fresh.

---

FINDING:
- Title: `isWellFormedGroupId` length check duplicates the regex — guard rail is sound but the redundancy is a maintenance trip-wire
- File: group-authorization.ts:31-33
- Principle: P2 ("Automate defences")
- Severity: P3
- What's wrong: The function asserts `v.length === 36` AND `GROUP_ID_PATTERN.test(v)`. The regex already enforces length via `^grp_[a-f0-9]{32}$`. If a future commit widens the regex (e.g. supports a `grp2_` prefix for a new ID format) without updating the literal `36`, well-formed new IDs will be rejected; if it tightens the literal without updating the regex the opposite. Not exploitable, but the two facts can drift.
- Consequence: A future migration ships IDs that look valid but `authorizeGroupAccess` returns null for, manifesting as "groups silently disappear after upgrade."
- Fix: Drop the length check — the anchored regex is sufficient. Or compute the expected length from the regex source as a constant. Either way, one source of truth.

---

Summary: 9 findings — 0 P1, 7 P2, 2 P3. The predicates are clean; the **integration debt** is the threat. The most important single change before Task 13 ships is wiring `isObserverWriteAllowed` into a `canUseTool` handler at the observer spawn site, with a startup integration test that asserts denial. Everything else is incremental hardening.
