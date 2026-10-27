# Backend Quality Reference — Carmack × Matteo Collina × Cross-stack backend discipline

Philosophy: John Carmack. Specifics: Matteo Collina's Node.js error/resource discipline applied generically to any HTTP/WebSocket backend, regardless of runtime or framework.
Stack context: framework-neutral. This reference applies wherever a server speaks HTTP and/or WebSocket — Python (FastAPI, aiohttp), Node/Bun (Express, Fastify), or any other runtime. Concrete framework specifics for the Aura TypeScript stack live in `quality-dahl.md`. Concrete Python specifics live with the Python backend expert. Postgres/SQL concerns live in `quality-postgres.md`. Filesystem persistence and subprocess lifecycle live in their own reference docs per stack.

Every finding must describe the **concrete failure mode** — not just "this is bad practice."
Security patterns are in `security.md` (Hunt). This doc covers: async error discipline, HTTP-framework boundary validation, middleware composition, WebSocket handler hygiene, resource lifecycle, structured logging, async correctness, and type safety at boundaries.

---

## Principle 1: Programmer errors are crashes — operational errors are handled

*Carmack: "Assertions catch assumption violations."*
*Collina: "The best way to recover from programmer errors is to crash immediately." Modern runtimes (Node since v15, Bun, Python 3 with `asyncio` if configured strictly) crash on unhandled rejection / unawaited coroutine by default. That's correct. Adding a global `unhandledRejection: 'silent'` (or its equivalent) hides the alarm.*

### What to check

**Swallowed rejection on durable state**
- `.catch(() => {})` (JS/TS) or bare `except: pass` (Python) on a call that writes to disk, broadcasts to clients, or updates session state. The state is now inconsistent and no one knows.
- Severity: **P1** for swallowed errors on persistence/broadcast paths. **P2** elsewhere.

**Async function used as event handler**
- `socket.on('message', async (data) => { ... throw ... })`. The throw becomes an unhandled rejection — the handler is fire-and-forget from the emitter's perspective. Wrap in try/catch and route to the bridge's error handler.
- Severity: **P1**.

**Mixed sync/async error delivery**
- A function that throws synchronously on bad args but rejects on network errors. Callers can't write a unified try/catch. Pick one (always async).
- Severity: **P2**.

**`process.on('uncaughtException', ...)` masking crashes** (or `sys.excepthook` in Python)
- A global handler that logs and continues turns programmer errors into silent corruption. Use only for last-gasp logging; always exit afterward.
- Severity: **P2**.

---

## Principle 2: Validate at the HTTP framework boundary, sanitise at the response

*Carmack: "Deploy assertions as tripwires."*
*The HTTP framework's request handler is the entry point. Every route should validate inputs (Zod, valibot, Pydantic, hand-written) before the handler runs. Every error response should be free of internal details.*

### What to check

**Routes without input validation**
- `app.post('/api/sessions', async handler -> uses body directly)`. A typo, missing field, or hostile payload causes downstream crashes or worse. Use the framework's input-validation idiom or hand-validate at the top of the handler.
- Severity: **P2** for unvalidated mutation routes. **P3** for read-only routes with safe defaults.

**Path params not validated**
- `GET /api/sessions/:id → read file at id` without checking that `id` is a known shape (e.g. uuid or `[a-z0-9-]+`). A request for `../../etc/passwd` reads through file boundaries. Cross-reference `security.md` Principle 1.
- Severity: **P1** for path params used in fs operations without validation.

**Error responses leaking stack traces**
- Returning the entire stack to the client ships internal detail. Worse: ships filesystem paths revealing the server layout. Default to `{ error: 'Internal error' }` and log full detail server-side.
- Severity: **P1** in any branch reachable in production.

**Framework-specific request context passed downstream**
- The per-request context (e.g. `c` in some frameworks, `request` in others) is a per-request object. Stash useful values there (auth, session ID). Don't pass the whole context object into services — they shouldn't depend on the framework.
- Severity: **P3** for clean architecture; **P2** if it has caused testability pain.

---

## Principle 3: Middleware ordering and composition

*Carmack: "Structure should make the intended behavior obvious."*
*Most HTTP frameworks run middleware in registration order. Auth before routes; CORS before any response writes; logging at the right granularity. Wrong order = subtle correctness bugs.*

### What to check

**Auth check after route handler**
- A route registered before its auth middleware runs without auth. The router resolves the route, then walks middleware — order matters. Verify: every protected route's middleware is registered first.
- Severity: **P1** for unprotected routes that should require auth.

**Middleware that throws inside async without try/catch**
- A middleware that does `await loadUser(c)` and throws on missing user. If not wrapped, the request hangs (no response written). The framework may catch some classes but not all; always finish the response in the catch path.
- Severity: **P2**.

**Logging middleware logs raw request bodies**
- Bodies may contain prompts, tool inputs, env profiles, secrets. Logging them to console or external telemetry leaks data. Log structural metadata (method, path, status, duration), not bodies.
- Severity: **P2** for body-logging middleware.

**Per-request session ID not propagated**
- A `requestId` middleware that stores in the request context should also include it in every log line. Without that, you can't correlate logs across one request. Use a child logger pattern.
- Severity: **P3**.

---

## Principle 4: WebSocket handlers — same discipline, different shape

*Carmack: "Make data flow visible and explicit."*
*The runtime's WebSocket upgrade is a different path from HTTP handlers. The same validation/error/cleanup hygiene must be applied — but it's a separate surface that's easy to skip.*

### What to check

**WebSocket message handler without try/catch**
- `socket.on('message', (data) => JSON.parse(data))` — `JSON.parse` throws on malformed input, the throw becomes an unhandled error, the socket may close mid-stream. Always parse inside try/catch and respond with a typed error to the peer.
- Severity: **P1** for parse-without-catch on any WS message path.

**Auth on HTTP upgrade missing or weak**
- WebSocket auth typically happens at HTTP upgrade (handshake). If the upgrade accepts connections without checking a token, anyone with the session ID can join. Cross-reference `security.md`.
- Severity: **P1**.

**`socket.close` without code/reason on error**
- `socket.close()` with no args sends code 1005 (no status). Clients can't distinguish "server full" from "session ended" from "auth failed". Use specific close codes and reasons.
- Severity: **P3**.

**Per-socket cleanup omitted**
- Listeners attached on the socket (`socket.on('data', ...)`) without paired `socket.on('close', () => cleanup)` leak across reconnects.
- Severity: **P2**.

---

## Principle 5: Resource lifecycle — connections, FDs, streams

*Carmack: "Understand the lifecycle of every resource you allocate."*
*Collina: every unclosed FD is a slow leak. A backend opens session state files, log files, sometimes external HTTP calls. Every open requires a corresponding close.*

### What to check

**File handles opened without `try/finally` close**
- `const fd = await fs.open(path)` (or Python `f = open(path)`) followed by use, no close in a finally block. If anything between throws, the FD leaks. Use the language's resource-management idiom (`await using` in modern JS/TS, context manager `with open(...)` in Python) or `try/finally`.
- Severity: **P2**.

**`fetch` response bodies not consumed**
- Collina: every fetch body must be read or explicitly cancelled. An unread body holds the connection. Flag if any outbound HTTP calls exist where the body is ignored.
- Severity: **P2** for outbound HTTP calls with unread bodies.

**Recorder FDs held by closed sessions**
- See the persistence reference doc (per stack) for atomic-write + close discipline on long-lived recorder files.

**Timers (`setTimeout`/`setInterval`, or `asyncio.create_task` in Python) without explicit cancellation**
- A debounce timer that isn't cleared on shutdown keeps the process alive (or, after process exit, leaks across hot-reload in dev). Track every timer ID/handle and clean up on lifecycle end.
- Severity: **P3**.

---

## Principle 6: Structured logging — JSON to stdout

*Carmack: "If you can't measure it, you can't improve it."*
*Console logging has its place in dev. Production needs structured JSON with consistent fields: timestamp, level, requestId, sessionId, event, message. Without structure, log search is grep-on-a-haystack.*

### What to check

**`console.log` / `print` peppered throughout server code**
- Ad-hoc logging is fine for dev debugging but should not be the production log path. Use a logger (`pino`, `bun-logger`, Python `structlog` / `loguru`) with structured fields. Default to JSON in production, pretty in dev.
- Severity: **P3** for ad-hoc logs. **P2** if logs are the primary observability surface.

**Logger format inconsistent across modules**
- One module uses a structured logger, another uses `console.log`, another uses a custom format. Logs aren't queryable as one stream.
- Severity: **P3**.

**Per-session log context missing**
- A log line saying "Tool call rejected" with no session ID can't be correlated. Always include the session ID in log lines that touch session state.
- Severity: **P2**.

---

## Principle 7: Async correctness — the event loop is not magic

*Carmack: "Latency is always a bug."*
*Collina: "Contrary to popular belief, promises do not yield to the event loop." Microtasks drain entirely before the loop proceeds. A `for...of` with synchronous `await`s is still synchronous-equivalent. Equivalent traps exist in Python's `asyncio` (a coroutine that never `await`s blocks the loop).*

### What to check

**CPU-bound work in request paths**
- Synchronous `JSON.parse` on a 10MB payload, sync hashing in a hot path, sync crypto. The JS runtime is single-threaded for JS; Python's GIL holds for CPU-bound code. Offload to a worker (Web Worker, Worker thread, Python `concurrent.futures.ProcessPoolExecutor`) for heavy CPU.
- Severity: **P2** for any sync CPU work that scales with request size.

**Promise chains in tight loops without yield**
- Processing 10,000 messages with `await processOne(m)` where `processOne` resolves synchronously blocks the event loop. Insert `await new Promise(r => setImmediate(r))` periodically, or break work into chunks.
- Severity: **P2** for unbounded loops without yield points.

**`Promise.all` / `asyncio.gather` over unbounded arrays**
- `Promise.all(items.map(processItem))` with N=10,000 items opens 10,000 concurrent operations. If `processItem` opens an FD or makes a network call, this blows the limit. Use `p-limit` / a semaphore or batch.
- Severity: **P2**.

**`async` functions without `await`**
- `async function load() { return data; }` — the `async` is meaningless, but a lint rule (`require-await`) catches the wasted promise allocation. Indicates someone confused about the model.
- Severity: **P3**.

---

## Principle 8: Type safety at the boundary

*Carmack: "Use the type system as armour."*
*A backend exposes WebSocket and REST surfaces. Both are validated at runtime. The static type (TypeScript types, Python type hints, Pydantic models) must match the runtime validators — drift is the most common source of "works in test, fails in prod".*

### What to check

**`any` / `Any` / untyped on body/payload at request boundary**
- Untyped request body where the validator beneath this should narrow to a real type. If it doesn't, the rest of the handler is unchecked.
- Severity: **P2**.

**Schema and static type diverged**
- A Zod/Pydantic schema parses `{ sessionId: string }` but the static type used by the handler also includes `userId`. Either the schema is too loose or the type is wrong. Use `z.infer<typeof schema>` (TS) or `typing.cast` from a Pydantic model.
- Severity: **P2**.

**Discriminated union without exhaustive switch**
- A WS message type union with a `switch` that has no `default` and no `never`-typed assertion (TS) or no `else: assert_never` (Python). New types slip through silently.
- Severity: **P2**.

**Catch block typing `error` as `Error`**
- Per Collina/Dodds (TS): `catch (e: any)` or `catch (e: Error)` is wrong — JS can throw anything. Type as `unknown`, narrow with `instanceof Error`. Equivalent in Python: `except Exception` is too broad; narrow to the specific exception class you actually handle.
- Severity: **P3**.

---

## Principle 9: Know your gaps

*Carmack: epistemic humility — you can't fix what you don't know is broken.*

### Areas this doc is weaker on (supplement from other sources)

- **Performance tuning under load**: real load testing is project-stage-dependent. Load patterns differ by product surface.
- **Streaming HTTP responses (SSE)**: most frameworks support SSE; if introduced, document the framework-specific idiom separately.
- **CORS in production deploy**: CORS is permissive in dev. For deployed services, narrow allowed origins. Covered partly by `security.md`.
- **Concrete Aura TypeScript backend specifics**: see `quality-dahl.md` (Aura stack only).
- **Concrete Python (FastAPI / aiohttp / Pydantic) specifics**: see the Python backend expert's reference doc.

---

## Quick Reference: Severity Guide

| Severity | Pattern | Examples |
|----------|---------|----------|
| **P1 — Fix Now** | Crash, data leak, unprotected route, hung WS | Async WS handler with no try/catch, path params used in fs without validation, stack traces in error responses, unauthenticated WebSocket upgrade, unprotected route after auth middleware |
| **P2 — Fix Soon** | Resource leak, validation gap, logging blind spot | Swallowed errors on durable paths, unvalidated mutation routes, FD leaked through throw path, unread fetch bodies, CPU-bound sync work in request paths, type/schema drift, per-session context missing from logs |
| **P3 — Consider** | Convention, observability polish | Ad-hoc `console.log` / `print` in production paths, inconsistent logger format, async-without-await, missing exhaustive switch on unions, over-broad catch types |

### The Overriding Filter

Before writing any finding, apply the cross-stack backend synthesis:

1. **Is every external input validated before it touches state?** HTTP framework boundary or WS upgrade — same rule.
2. **Does every error path either crash loudly or respond cleanly?** Hung sockets and silent rollbacks are the worst defaults.
3. **Is every resource cleaned up on every exit path?** FDs, timers, listeners, child processes.
4. **Is logging structured and per-session?** Otherwise debugging is grep-archaeology.
5. **Is the runtime used idiomatically, or is the code pretending to be on another runtime?** Mixed assumptions silently slow the server.
