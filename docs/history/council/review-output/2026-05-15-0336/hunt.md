# Hunt — Security findings for Task 11.8 denylist gate

Scope: `web/server/claude-adapter.ts` `handleControlRequest` (lines 881–935) and `web/server/auto-proceed-permissions.ts` (the predicate + denial-message module wired by the gate).

I read the module's own honest scope-statement (lines 38–53 of `auto-proceed-permissions.ts`) and the gate's honest scope-statement (claude-adapter.ts lines 891–895). Most of what could be flagged is pre-flagged by the authors as documented limitations. The findings below are where the documented limitations leak from "documented" into "exploitable in a way the documentation does NOT cover" or where the gate does something stronger or weaker than the surrounding prose claims.

---

FINDING:
- Title: Denylist coverage narrower than the gate's own prose claim — over-claim risk
- File: web/server/claude-adapter.ts:881-913 (esp. comment 883-895) and web/server/auto-proceed-permissions.ts:61-66
- Principle: Principle 9 — Assume breach: false-confidence amplifies impact (security.md P9)
- Severity: P2
- What's wrong: The gate's inline comment (line 884-886) claims it denies "Bash:git push, network operations, destructive filesystem actions etc." but the actual `SYNTHETIC_FRAME_TOOL_DENYLIST` contains exactly four entries — `git push`, `git commit`, `gh pr create`, `gh pr merge`. No `rm -rf`, no `curl`, no `wget | sh`, no `ssh`, no `scp`, no `npm publish`/`bun publish`, no `docker push`, no `gh release create`, no `chmod -R`, no `git push --force` variant catch (matched by prefix but reviewer expects explicit), no `git reset --hard`, no `git clean -fdx`, no `kubectl`, no `aws s3 cp`. The denylist is a four-entry social-media-publishing-prevention list dressed up as a "destructive operations" filter in the prose. A future reviewer (or, more dangerously, a PR description quoting the comment) will assume coverage that does not exist.
- Consequence: An auto-proceed synthetic turn that escalates to "let me clean up the workspace" can issue `Bash:rm -rf node_modules` (or worse, `rm -rf ~/.companion/recordings`) without the denylist firing — exactly the unattended-destructive case the gate's prose claims to prevent. Recordings + session JSON wiped silently. Meanwhile the PR/handoff narrative reads "destructive operations are gated".
- Fix: Either widen the denylist to actually cover "network ops + destructive fs" as the gate comment claims (concrete entries: `rm -rf`, `rm -fr`, `curl `, `wget `, `ssh `, `scp `, `npm publish`, `bun publish`, `git push`, `git reset --hard`, `git clean -fd`, `gh release create`, `docker push`, etc.), or tighten the prose to match the actual list ("Bash: git push / git commit / gh pr create / gh pr merge — i.e. publish-to-others operations only; destructive local fs is NOT denied"). The module-level doc on auto-proceed-permissions.ts:6-9 is already more honest than the gate's inline comment — sync the inline comment to match.

---

FINDING:
- Title: Predicate falls open silently when CLI sends non-string `tool_name`
- File: web/server/claude-adapter.ts:896-913 (control_request branch); auto-proceed-permissions.ts:88-89 (`if (toolName === "Bash")`)
- Principle: Principle 2 — Automate defences: validate at every Hono/protocol boundary (security.md P2)
- Severity: P2
- What's wrong: `JSON.parse(line)` at claude-adapter.ts:324 is cast straight to `CLIMessage` with no runtime shape check, then `msg.request.tool_name` is fed verbatim into `isToolUseDeniedForSynthetic`. The TypeScript type says `tool_name: string`, but if a malformed or malicious upstream frame sends `tool_name: ["Bash"]` or `tool_name: {toString: () => "Bash"}`, the strict-equality check `toolName === "Bash"` returns false and the entire denylist is bypassed silently. Same hazard for `msg.request.input` — the predicate guards `typeof toolInput === "object" && toolInput !== null` but does NOT defend against `input: {command: ["git", "push"]}` (array, not string) which is silently treated as undenied. Module-level docs at lines 38-53 catalogue shell-escape evasions but not type-confusion evasions.
- Consequence: If the local Claude Code CLI ever ships a protocol drift where `tool_name` arrives as an array (Hunt has seen this exact class — Anthropic's own SDK has shipped tool_name as `string | array` in two preview iterations), the denylist falls open with no log line, no `protocolDriftSeen` entry, no test-canary, no nothing. The gate's "behavioural guardrail" claim becomes a guardrail-not-applied. The frame's other consumers (the regular permission UI path further down) ALSO mis-render, but for the gate the consequence is silent-denial-bypass rather than visible-error.
- Fix: Add a one-line strict type check at the top of `isToolUseDeniedForSynthetic` — `if (typeof toolName !== "string") return true` (fail-CLOSED to deny, since the synthetic-turn case is unattended and a malformed frame should not auto-allow). Symmetric guard for input shape. Document the fail-closed convention in the module header so a future "this rejects too aggressively" refactor does not invert it.

---

FINDING:
- Title: Denial-message embeds CLI-controlled `command` head into a backtick-quoted markdown segment
- File: web/server/auto-proceed-permissions.ts:111-120 (`denialMessageForSynthetic`)
- Principle: Principle 1 — XSS in chat content: stored content path through recordings + chat surface (security.md P1)
- Severity: P3
- What's wrong: `denialMessageForSynthetic` builds a string with the pattern `` `${head}` `` where `head` is `command.trimStart().split("\n", 1)[0]?.slice(0, 80) ?? ""` — i.e. raw CLI-supplied bytes minus the first newline, capped at 80 chars. No backtick escaping. If `command` is `"git status\` <img src=x onerror=alert(1)> \`"` (with embedded backtick), the resulting message is `` Auto-proceed synthetic frame may not invoke destructive operations (denied: `git status\` <img...> \``). `` This is sent back to the CLI as the `control_response.response.message`, which the CLI surfaces in the chat tool-use feedback panel — a stored content path (it's persisted in recordings + session JSON, replayed on reload). The chat surface renders assistant content as markdown per security.md Principle 1's framing.
- Consequence: If a malicious CLI process (or, more realistically, an LLM that read attacker-controlled file content and tried to invoke a tool with attacker-crafted text in the `command` argument) can land 80 bytes of attacker-chosen content into the chat surface as if it were Aura server output. Pre-condition is high (synthetic turn in flight + tool-use proposed with crafted command + tool happens to also match denylist prefix), but the trust elevation — from "tool input that would have shown in tool-use panel" to "server-authored denial banner in chat" — is the type of laundering Hunt's catalogue calls out.
- Fix: Escape backticks (and at minimum, normalise control chars + strip ANSI escape sequences) in `head` before interpolation, OR drop the interpolation entirely and emit a fixed message ("Auto-proceed synthetic frame may not invoke destructive operations. Engage manually."). The current message's only operational value is letting the user see *which* command was denied; that's a debug nicety, not a load-bearing UX. The fixed-message variant is also more accessible (the dynamic backtick segment breaks screen-reader code-mode signalling intermittently).

---

FINDING:
- Title: ASCII-only `trimStart` normalisation despite documented Unicode-evasion caveat — caveat under-cuts coverage
- File: web/server/auto-proceed-permissions.ts:93-99
- Principle: Principle 1 — Syntactically-possible vulnerability statistically exists (security.md P1)
- Severity: P3
- What's wrong: The module comment at line 50-52 correctly states that `String.prototype.trimStart` strips Unicode whitespace per ECMA-262, so leading NBSP / TAB / etc. do not slip past. That is accurate. What is NOT covered: a leading **non-whitespace zero-width or invisible character** — `U+200B` (zero-width space), `U+200C` (ZWNJ), `U+200D` (ZWJ), `U+FEFF` (BOM), `U+202E` (right-to-left override) — is NOT stripped by `trimStart` (it strips only chars matching the WhiteSpace+LineTerminator productions), and lands the command as `<ZWSP>git push origin main`. The prefix-match `trimmed.startsWith("git push")` is false, gate falls open. The module doc lumps this under "homoglyph substitutions" and waves it away, but ZW-class characters are a distinct evasion that the doc does not explicitly call out and that a real-world CLI (or local LLM coaxed by attacker-controlled file content) is more likely to emit accidentally than a full homoglyph swap.
- Consequence: A determined attacker (or an LLM cargo-culting unicode quoting from a code-review thread) ends up with `git push` slipping past the denylist with a single ZW-prefix byte. Combined with finding #1 above (narrow denylist), the gate's effective coverage of the four-entry list itself becomes "four exact ASCII prefixes". The author's own caveat about homoglyphs is technically true but mis-frames the actual common evasion (ZW chars, not homoglyphs).
- Fix: Either strip ZW + BOM + bidi-control characters explicitly before the prefix-match (`.replace(/[​-‏‪-‮﻿]/g, "")`), or expand the module's "Limitations" comment to enumerate ZW and bidi-control characters by codepoint, so the next person extending the denylist does not assume the existing entries cover ZW-prefixed bypasses.
