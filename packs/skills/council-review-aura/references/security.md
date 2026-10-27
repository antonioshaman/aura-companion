# Security Reference — Carmack × Troy Hunt

Philosophy: John Carmack. Specifics: Troy Hunt + OWASP 2025.
Stack context: Bun + Hono + TypeScript backend. React 19 + Vite SPA frontend. WebSocket bridge to local Claude Code / Codex subprocess. File-based JSON persistence under `$TMPDIR/vibe-sessions/`, `~/.companion/envs/`, `~/.companion/recordings/`. Auth via long-lived bearer token in URL/header (`bun run generate-token`). No external DB, no Telegram, no Clerk.

Every finding must describe the **concrete attack vector** — not just "this is insecure."
When Carmack and Hunt independently converge on a principle, it earns its place here.

---

## Principle 1: If it's syntactically possible, it statistically exists

*Carmack: "If a vulnerability is syntactically possible, it statistically exists in your codebase."*
*Hunt: "It's us — the organic matter — that despite the best of intentions make bad choices."*

### What to check

**Command injection (the #1 risk in this stack)**
- The Companion server spawns the CLI as a subprocess. Any user input flowing into `Bun.spawn` / `child_process.spawn` is a command-injection vector.
- Look for: shell-mode spawns (`shell: true`, `exec`, `execSync`), arguments built from user input by string concat, arguments that flow flags (`--foo`) into the CLI argv without an allowlist. Cross-reference `quality-subprocess.md` Principle 1.
- Severity: **P1**.

**Path traversal**
- Slug-based file paths in `env-manager.ts` and any session-id-derived path. A slug of `../../etc/passwd` reads off-volume. Validate against `^[a-z0-9-_]+$` AND `path.resolve(joined).startsWith(path.resolve(root) + path.sep)`. Cross-reference `quality-persistence.md` Principle 6.
- Severity: **P1**.

**XSS in chat content**
- The chat surface renders assistant content as markdown. If the markdown renderer permits raw HTML, untrusted content can inject script tags. The CLI's content is "untrusted" because it can echo user inputs and external file contents.
- Look for: `dangerouslySetInnerHTML` without DOMPurify/sanitisation, markdown libraries with `html: true` and no sanitiser, direct DOM mutation from streamed content. Cross-reference `quality-frontend.md`.
- Severity: **P1** for stored XSS (recorded in session JSON and replayed). **P2** for transient.

**`eval`/`new Function` / `vm.runInContext`**
- Any of these on user input is RCE. No reason for any of these in a UI-shell product.
- Severity: **P1**.

---

## Principle 2: Automate defences — TypeScript and lint are your continuous validators

*Carmack: "Anything that can be mechanically checked should be."*
*Hunt: "Security scanning needs to be continuous, not just a one off."*

### What to check

**TypeScript not in strict mode**
- `tsconfig.json` should have `"strict": true`. Without it, `null`/`undefined` slip through, function args may be `any`, and class fields are unchecked.
- Severity: **P2**.

**Scattered `any` on request bodies**
- `c.req.json()` returns `unknown`. Casting to `any` (or to a hand-typed interface without runtime validation) is an unchecked assumption. Use Zod or hand-validate.
- Severity: **P2** for boundary `any`. **P3** for internal.

**`@ts-ignore` / `@ts-expect-error` without inline reason**
- Each one is a deliberate hole. Permitted if the reason explains why TypeScript is wrong; not permitted as a quick-silence.
- Severity: **P3** for unreasoned. **P2** at security-sensitive boundaries.

**Dependency scanning**
- `bun audit` (or equivalent npm audit), Dependabot/Renovate config. The lockfile must be committed. Cross-reference `quality-deploy.md` Principle 3.
- Severity: **P2** if no CI scan exists.

**Validation at every Hono boundary**
- Cross-reference `quality-backend.md` Principle 2. A mutation route without input validation is the runtime equivalent of `any`.
- Severity: **P2**.

---

## Principle 3: Minimise state — recordings, sessions, env profiles

*Carmack: "State is the enemy."*
*Hunt: "You cannot lose what you do not have."*

### What to check

**Sensitive content in recordings**
- `recorder.ts` writes raw protocol payloads to JSONL. If the CLI ever transmits an API token, an OAuth secret, a private SSH key snippet, or a credit-card-shaped string, it lands on disk in plaintext. Decide policy: never record auth flows, redact known secret patterns, or accept the risk and protect the directory permissions.
- Severity: **P2** for an unredacted recorder in a multi-user environment. **P3** for single-user local dev.

**Session JSONs containing prompts and tool outputs**
- These can contain user data, secrets pasted accidentally, internal codebase contents. Treat the persistence directory as sensitive. Ensure file mode is `0600`/dir `0700`.
- Severity: **P2** if perms are world-readable.

**`console.log` of bodies / payloads**
- Logging request bodies, NDJSON lines, or WebSocket messages leaks the same content. Cross-reference `quality-backend.md` Principle 3.
- Severity: **P2** if logs are persisted (file, journald, telemetry).

**Secrets in `.env` committed**
- `.gitignore` must cover `.env`, `.env.*`, `*.token`, anything secret-shaped. A token committed even once requires rotation. Cross-reference `quality-deploy.md` Principle 4.
- Severity: **P1**.

---

## Principle 4: WebSocket auth — the most under-defended surface

*Carmack: "Make the wrong thing impossible."*
*Hunt: "Authentication and authorization are not the same. Most breaches come from getting the second one wrong."*

### What to check

**Unauthenticated WS upgrade**
- The `/ws/browser/:id` upgrade handler MUST check a token (URL query, cookie, or header). Without it, anyone reachable on the same network can join any session by guessing the session ID.
- Severity: **P1**.

**Token in URL leaked through Referer / logs / browser history**
- `?token=...` in URLs ends up in browser history, Referer headers to embedded images, server access logs. Prefer header (set via `WebSocket` constructor's `protocols` arg as a workaround) or short-lived signed token from a separate REST call.
- Severity: **P2** for token-in-URL on a remote-deployed Companion. **P3** for local-only dev.

**Origin not checked on WS upgrade**
- WebSocket bypasses same-origin policy by design. Without an `Origin` check on upgrade, a malicious page in another tab can connect to `ws://localhost:3456/...` and steal session content. Validate `Origin` against an allowlist (`http://localhost:5174`, `null` for some embedding scenarios).
- Severity: **P1** for missing origin check on a multi-page browser context.

**Long-lived token without rotation**
- `bun run generate-token` produces a token. Without rotation policy, a leaked token is valid forever. Document rotation procedure; ideally support per-session ephemeral tokens.
- Severity: **P3**.

---

## Principle 5: Shrink the attack surface

*Carmack: "Code reduction is the most effective strategy for defect reduction."*
*Hunt: "Third-party dependencies increasingly feature in breaches."*

### What to check

**Unused REST endpoints**
- Routes that exist but no client calls. Each is unaudited code. Trace from `routes.ts` to actual UI uses; delete dead ones.
- Severity: **P2** for endpoints accepting writes; **P3** for read-only.

**Debug / `/api/test-*` endpoints in production paths**
- Any endpoint that bypasses auth, dumps state, or runs arbitrary code. Even "internal" endpoints get reached from the public surface.
- Severity: **P1**.

**Dependency bloat**
- Big package trees expand transitive attack surface. Periodically prune.
- Severity: **P3** unless a specific dep has a known CVE.

**CDN-loaded assets without SRI**
- If any external script is loaded by URL, `integrity="sha384-..."` ensures it can't silently change.
- Severity: **P3**.

---

## Principle 6: Code transparent to analysis — CSP, security headers

*Carmack: "Write code that cooperates with analysis tools."*
*Hunt: "Always monitor your CSP reports."*

### What to check

**No Content Security Policy on the SPA**
- Hono can set headers. A baseline CSP (`default-src 'self'`, `script-src 'self'`, `connect-src 'self' ws: wss:`) prevents most XSS exploitation even if a flaw exists.
- Severity: **P2** for production deploy. **P3** for local-only.

**`unsafe-inline` / `unsafe-eval` on script-src**
- Each defeats most of CSP. Use nonces or hashes for genuinely-required inline scripts.
- Severity: **P1** if present on the script directive.

**Missing `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `Permissions-Policy`**
- Cheap to set, useful defence-in-depth.
- Severity: **P3**.

**Mixed-content / `http://` hardcoded**
- For local dev, http is fine. For deployed Companion, all URLs (including WebSocket) must be `https`/`wss`.
- Severity: **P1** in deployed contexts.

---

## Principle 7: Assertions as tripwires — access control

*Carmack: "Assertions catch assumption violations."*
*Hunt: "Broken access control is #1 on OWASP for a reason."*

### What to check

**Routes without auth middleware**
- Cross-reference `quality-backend.md` Principle 3. Every mutation route must require auth. Verify by reading the router file end-to-end.
- Severity: **P1** for unprotected mutation routes.

**Session ID as authorisation**
- The session ID is a capability. If the browser sends `sessionId` and the server uses it without checking that the requesting client owns it, anyone with a session ID can act. Bind session ownership to the token.
- Severity: **P1** for ownerless session operations.

**IDOR on session/recording/env endpoints**
- `GET /api/sessions/:id` should return only sessions the requester owns. `GET /api/recordings/:id` likewise. Without the check, incrementing the ID reveals other sessions.
- Severity: **P1**.

**Rate limiting absent on expensive endpoints**
- Session creation spawns a subprocess. Without rate limit, a misbehaving client can fork-bomb the host.
- Severity: **P2**.

---

## Principle 8: Education through findings — make the vector visceral

*Carmack: reviews build shared understanding.*
*Hunt: "Education is the best ROI on security spend."*

### Reviewer guidance

- "This endpoint is insecure" is useless. "This endpoint spawns a process based on `req.body.cmd` — an attacker sends `cmd: ['rm', '-rf', '/']` and the host is wiped" is the right level of explanation.
- Tie to real-world breach analogues where applicable (Hunt's catalog: VTech IDOR, TalkTalk SQLi, Spoutible over-fetch).
- The reviewer's goal is to make the developer never want to write that pattern again.

---

## Principle 9: Assume breach — design for failure

*Carmack: "If a mistake is possible, it will eventually happen."*
*Hunt: "Absence of evidence is not evidence of absence."*

### What to check

**Stack traces in error responses**
- Cross-reference `quality-backend.md` Principle 2. Production error responses must be generic; full detail logs server-side only.
- Severity: **P1** in any production-reachable branch.

**Unhandled rejection killing the process silently in dev, loudly in prod**
- Inconsistent failure mode across environments hides bugs in dev. Configure both to crash loudly.
- Severity: **P2**.

**Logs that grow forever**
- A leak vector: an attacker triggers verbose logging, fills the disk, brings the host down. Rotate logs.
- Severity: **P3**.

---

## Principle 10: Know your gaps

*Carmack: epistemic humility.*
*Hunt: "We take security seriously" — otherwise known as "we didn't take it seriously enough."*

### Areas this doc is weaker on (supplement from other sources)

- **Modern supply chain attacks**: dependency confusion, postinstall script exfiltration. Two of the project's deps have blocked postinstalls per CLAUDE.md — that's a yellow flag worth auditing.
- **CI/CD pipeline integrity**: covered partly by `quality-deploy.md` Principle 5.
- **Privacy / compliance**: GDPR/CCPA implications of storing user-generated prompts. Not a finding source until deployed for others.

---

## Quick Reference: Severity Guide

| Severity | Pattern | Examples |
|----------|---------|----------|
| **P1 — Fix Now** | Exploitable vulnerability, data exposure, access control bypass | Command injection via spawn, path traversal in env-manager, XSS via markdown, unauthenticated WS upgrade, missing Origin check, IDOR, stack traces in production, secrets in repo, unprotected mutation routes |
| **P2 — Fix Soon** | Defence gap, attack-surface bloat | Missing CSP, no rate limiting, weak typing at boundaries, `console.log` of bodies, world-readable session dir, token-in-URL on deployed Companion, missing dependency scan, unused mutation endpoints |
| **P3 — Consider** | Hygiene that compounds | Long-lived token without rotation, no SRI on CDN scripts, scattered `any`, missing minor security headers, dependency bloat |

### The Overriding Filter

Before writing any finding, apply the Hunt-Carmack synthesis:

1. **Can user input reach `spawn`, `eval`, or a file path?** If yes, P1 until proven otherwise.
2. **Is auth enforced at every boundary, including WebSocket upgrade?** Routes are easy; sockets are skipped.
3. **Does the error response leak detail an attacker can use?** Stack traces and Postgres-style messages are gifts.
4. **Is every piece of stored data needed?** Recordings, logs, env profiles — anything sensitive is a future breach.
5. **Would a developer reading this finding learn enough to never write that pattern again?** If not, the finding is incomplete.
