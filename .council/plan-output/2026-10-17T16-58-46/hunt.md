# Troy Hunt — Security recommendations (planning, pre-build)

Scope reviewed: `web/server/routes.ts` (`POST /sessions/:id/continue-in-new`, auth middleware at ~L413-430), `session-recovery.ts` (`driftDetectorTick`, `maybeFireCompactionAdvisory`), `context-size-suggester.ts`, `ws-bridge.ts:recordContextAdvisory`, `session-types.ts:ContextAdvisoryRecord`, `silent-stdio-drift-detector.ts:resolveCliSessionPaths`, `review-watcher.ts` (EC-4 reference), `checkpoint-watcher.ts`, `codex-adapter.ts:handleTokenUsageUpdated` (grep only).

Threat model, stated: single operator, bearer-token auth already enforced on the REST router (the new work adds **no** route, **no** WS message type, **no** spawn argument, **no** rendered content). So command injection, WS-upgrade auth, XSS and IDOR gain no new surface here and I do not re-flag them. The security exposure of this feature is concentrated in two places: (1) **a server process that deletes files in an operator-chosen directory** (AC3), and (2) **widening the set of inputs that reach `stat()` / the persisted session record** from live-adapter-only to persisted-state and Codex-subprocess counters (AC1/AC2). Everything below follows from those two.

---

## R1 — Pruning allow-list: exact filename contract, `lstat`-only, `readdir`-sourced names, non-recursive, never from request body

- **Title:** Bound the deletion authority to `readdir(cwd)` entries that exactly match the endpoint's own timestamp pattern and are regular files
- **Principle:** P1 "If it's syntactically possible, it statistically exists" (path traversal) + P7 "Assertions as tripwires"
- **Defends AC:** AC3
- **What to get right:** The ONE exported pattern (per the EC-19-ish filename contract, co-located with the route's builder) must be fully anchored and require the full `T\d{2}-\d{2}-\d{2}` time component — `.aura-handoff-2026-10-17.md` (owner's hand-written notes, five of them currently sitting in this very repo root) must fail the match by shape, not by a "skip known names" list. Candidate names come only from a non-recursive `readdirSync(cwd, { withFileTypes: true })`, are filtered by `isFile()` on the Dirent / `lstat` (a symlink is not a file under `lstat`; never `stat`, which follows), and the unlink target is `join(cwd, direntName)` — nothing from `c.req.json()` (the free-text `reason`) and nothing from the session's persisted state besides `cwd` may participate in building the path or the pattern. Add a tripwire assertion in the helper that refuses any candidate containing `/`, `\`, or `\0`, or whose resolved path does not sit directly inside `resolve(cwd)` — it should never trigger, which is exactly why it belongs there.
- **Risk if skipped:** A regex with an optional time component, or a `stat`-based file test, turns a feature meant to tidy up after itself into a process that silently deletes the operator's own session notes (or follows a planted symlink in a shared cwd like `/tmp`), with no attacker required — just the organic matter.
- **Depends on:** —

## R2 — Retention is a conjunction, request-path only, and the deletion log is the audit trail

- **Title:** Delete only when BOTH "beyond newest N=3" AND "mtime older than 7 days" hold; no startup sweep; one structured log line per unlink, filename only
- **Principle:** P3 "Minimise state — you cannot lose what you do not have" + P9 "Assume breach — design for failure"
- **Defends AC:** AC3
- **What to get right:** Accept the developer's proposal as an AND, not an OR, and keep it strictly in the `continue-in-new` request path: a startup sweep would iterate every persisted session's `cwd` — including archived sessions and directories the operator has since repurposed — and delete in places nobody just asked the server to touch. Age must come from `lstat` mtime, not from parsing the timestamp in the filename (a file renamed or re-touched by the operator is then protected by the stricter of the two). Every unlink (and every refusal/failure) emits one EC-9 JSON line with `event`, `sessionId`, `cwd`, `file` (basename), and `reason` — never the file content, never the `reason` body text — and the helper swallows its own errors so the 200 response of the handoff is never degraded to a 500 and the response body never carries an `errno`/path string from the prune step (the existing `Cannot write handoff file: ${String(err)}` is already leaking more than it should; do not add a sibling).
- **Risk if skipped:** An OR policy or a boot-time sweep makes deletion reach directories and files whose only connection to the current request is a stale JSON record, and without a per-file log there is no way to answer "what did the server delete and why" after the fact.
- **Depends on:** R1

## R3 — Validate `cliSessionId` as a single id-shaped path segment inside `resolveCliSessionPaths` before AC2 widens its callers

- **Title:** Make the resolver's documented promise ("not a single id-shaped segment → null") actually true
- **Principle:** P1 path traversal check: validate against `^[A-Za-z0-9_-]+$` AND confirm the joined path stays under the root
- **Defends AC:** AC2
- **What to get right:** The docstring on `resolveCliSessionPaths` and the comment at `session-recovery.ts:601` both claim the resolver returns null for a non-id-shaped `cliSessionId`; the code does not — it only null-checks and then string-interpolates `${claudeHome}/projects/${slug}/${cliSessionId}.jsonl`. Today that input arrives from the live CLI's init frame; AC2 makes the tick stat transcripts for disconnected/exited sessions, where `cliSessionId` comes from the persisted FS-JSON record — a different trust boundary (a file on disk, editable by anything running as the service user, including a misbehaving council pair). Add the segment check (and a `resolve(...).startsWith(resolve(projectsRoot) + sep)` guard) in the resolver itself so every caller inherits it, and cover it with a test that feeds `../../etc/passwd` and expects null.
- **Risk if skipped:** A corrupted or hand-edited session JSON lets the tick `stat()` an arbitrary host path and, via the 5 MB milestone, surface its size as a persisted banner — low impact today, but it is the textbook shape of the P1 the reference doc exists to prevent, and it is one line to close.
- **Depends on:** —

## R4 — Codex context signal: treat `thread/tokenUsage/updated` as an untrusted protocol input; persist a discriminated record

- **Title:** Parse Codex token counters strictly (finite, non-negative, integer) before they reach the pure suggester or the persisted `context_advisory`
- **Principle:** P2 "Validation at every boundary — a mutation without input validation is the runtime equivalent of `any`" + EC-5
- **Defends AC:** AC1
- **What to get right:** Of the two candidate signals, (a) `last.inputTokens` vs `modelContextWindow` from `handleTokenUsageUpdated` is the one that does not force the server to `JSON.stringify` a base64-laden `messageHistory` every tick for every session (option (b) is a self-inflicted CPU/GC load that scales with exactly the payload the handoff is trying to escape — a denial-of-service you ship to yourself). The adapter already narrows `params.tokenUsage` loosely; the new code must accept only finite non-negative integers for the counters and reject (log + skip, EC-9) anything else — `NaN`, `Infinity`, negative, string — so a malformed frame can neither fire the handoff banner nor land a garbage value in persisted state. Keep `nextCompactionMilestone` pure by injecting the measured scalar plus the ladder; record on `ContextAdvisoryRecord` which signal fired (e.g. `signal: "transcript_bytes" | "context_tokens"`) so the route's existing `contextBytes` → "> N MB" quoting cannot misreport a token count as megabytes, and the browser's per-milestone dismissal key stays unambiguous.
- **Risk if skipped:** A single malformed or hostile `tokenUsage` frame from the subprocess becomes a persisted, replayed-on-every-`session_init` banner that nudges the operator into a handoff, and a tokens-as-bytes record produces a confidently wrong "> 0 MB" in the handoff file itself.
- **Depends on:** —

## R5 — Checkpoint-watcher EC-4 port: keep the filename guards, log mtimes not payloads

- **Title:** Carry over the `.`-prefix skip, `\0` rejection and strict pattern check with the `(file, mtimeNs)` keying; `onDropped("superseded")` detail must contain only the two mtimes
- **Principle:** P3 "`console.log` of bodies / payloads leaks the same content"
- **Defends AC:** AC4
- **What to get right:** The reference implementation in `review-watcher.ts:345-420` is already correct on this point — its `onDropped` detail string is `mtime A → B`, and the stat is on `join(dir, file)` where `file` comes from the fs event. When porting (or cherry-picking 31946bb9), verify the checkpoint variant still rejects NUL-bearing and dot-prefixed names before the new `stat`, and that neither the superseded-drop log nor any new test fixture writes checkpoint content (which carries task text and tool output) into a log line. This is a hygiene gate on a mechanical port, not a new risk.
- **Risk if skipped:** A debug-friendly "here is what we dropped" log line turns the superseded-payload loss into a plaintext copy of session content in journald.
- **Depends on:** —

---

## Adjacent — flagged, not recommended as part of this plan

- **Handoff file mode `0o644` + unconditional write into an arbitrary `cwd`.** The handoff markdown is the session's prompts and tool outputs (secrets pasted by accident included), written world-readable into a directory that is only gitignored in *this* repo. That is #381 behaviour, tied to no AC in this brief — scope creep to fix here. Since PR-B touches the builder anyway, switching the mode to `0o600` is a one-token change; raise it with the owner rather than slip it in.
- **`String(err)` in the 500 body of the handoff route** leaks absolute path + errno (P9). Pre-existing; R2 only asks that the prune step not add a second instance.

No recommendations on: command injection (no spawn argv changes), WebSocket upgrade auth (no new frames; `session_update` reuses the existing authenticated broadcast), XSS (browser unchanged), IDOR (no new route; bearer-token-gated single-operator model is unchanged).
