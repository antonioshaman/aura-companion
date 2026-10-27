<!-- canonical-source: council-review-aura-v2/references/quality-dahl.md -->
# Bun + Hono + TypeScript Backend + NDJSON/WS Protocol Quality Reference — Carmack × Matteo Collina × Realtime Protocol Expert

Philosophy: John Carmack. Specifics: Matteo Collina's Node.js error/resource discipline + Hono's lean middleware model + Bun runtime quirks; realtime protocol discipline drawn from `ws` library design (Node), HTTP/2 framing, and reverse-engineered Claude Code CLI `--sdk-url` protocol observed in `web/server/`.
Stack context: Bun 1.0+ runtime. Hono 4.7 (web framework) on `Bun.serve` with dual WebSocket upgrade for CLI (`/ws/cli/:id`) and browser (`/ws/browser/:id`). REST routes under `web/server/routes.ts`. Session lifecycle in `web/server/ws-bridge.ts`, `session-orchestrator.ts`, `cli-launcher.ts`, `session-store.ts`. JSONL recorder in `recorder.ts`. Env-manager in `env-manager.ts`. CLI side speaks **NDJSON** (newline-delimited JSON over WebSocket text frames). Browser side speaks typed JSON. Bridge message translation in `web/server/claude-adapter.ts`. Codex backend speaks JSON-RPC over the same socket. No tRPC, no Prisma, no Postgres, no SQLAlchemy, no Express, no FastAPI. Strict TypeScript on.

Every finding must describe the **concrete failure mode** — not just "this is bad practice."
Security patterns (token auth, WebSocket auth-bypass, command injection in spawn) are in `security.md` (Hunt). Subprocess lifecycle (CLI spawn, reconnect after PID change) is in `quality-ritchie.md` §A. Filesystem persistence (atomic writes, JSONL recorder, session JSON state) is in `quality-ritchie.md` §B. This doc covers: async TS error discipline, Hono middleware correctness, route shape, validation at boundaries, resource lifecycle, structured logging, Bun-specific behaviour, type safety at boundary, NDJSON framing safety, message dedup, sequence/replay correctness, broadcast fan-out, keep-alive cadence, control_request/response ack discipline, protocol drift, two-protocol adapter, backpressure.

---

## Why this expert exists

The bridge is reverse-engineered from an undocumented CLI flag (`--sdk-url`). It is the load-bearing element of the entire product — every byte the user sees passes through it. A drift between assumed protocol shape and actual CLI behaviour silently degrades the product before any test fails. No other expert on the council has this protocol as their primary lens — and the same authority covers the Bun/Hono runtime that hosts the bridge: async TS error discipline, Hono middleware ordering, resource lifecycle, and Bun-vs-Node behaviour drift are inseparable from the protocol surface they wrap.

---

## §A Bun/Hono runtime surface — Aura backend hygiene

### Principle A1: Programmer errors are crashes — operational errors are handled

*Carmack: "Assertions catch assumption violations."*
*Collina: "The best way to recover from programmer errors is to crash immediately." Bun (like Node) crashes on unhandled rejection by default since Node v15. That's correct. Adding a global `unhandledRejection: 'silent'` hides the alarm.*

#### What to check

**Swallowed rejection on durable state**
- `.catch(() => {})` on a call that writes to disk, broadcasts to browsers, or updates session state. The state is now inconsistent and no one knows. Cross-reference `quality-ritchie.md` §B Principle 1.
- Severity: **P1** for swallowed errors on persistence/broadcast paths. **P2** elsewhere.

**Async function used as event handler**
- `socket.on('message', async (data) => { ... throw ... })`. The throw becomes an unhandled rejection — the handler is fire-and-forget from the emitter's perspective. Wrap in try/catch and route to the bridge's error handler.
- Severity: **P1**.

**Mixed sync/async error delivery**
- A function that throws synchronously on bad args but rejects on network errors. Callers can't write a unified try/catch. Pick one (always async).
- Severity: **P2**.

**`process.on('uncaughtException', ...)` masking crashes**
- A global handler that logs and continues turns programmer errors into silent corruption. Use only for last-gasp logging; always exit afterward.
- Severity: **P2**.

---

### Principle A2: Validate at the Hono boundary, sanitise at the response

*Carmack: "Deploy assertions as tripwires."*
*Hono middleware is the entry point. Every route should validate inputs (Zod, valibot, hand-written) before the handler runs. Every error response should be free of internal details.*

#### What to check

**Routes without input validation**
- `app.post('/api/sessions', async (c) => { const body = await c.req.json(); /* use body directly */ })`. A typo, missing field, or hostile payload causes downstream crashes or worse. Use Hono's `@hono/zod-validator` or hand-validate at the top of the handler.
- Severity: **P2** for unvalidated mutation routes. **P3** for read-only routes with safe defaults.

**Path params not validated**
- `app.get('/api/sessions/:id', async (c) => { const id = c.req.param('id'); /* read file at id */ })` — without checking that `id` is a known shape (e.g. uuid or `[a-z0-9-]+`), a request for `../../etc/passwd` reads through file boundaries. Cross-reference `security.md` Principle 1 and `quality-ritchie.md` §B Principle 6.
- Severity: **P1** for path params used in fs operations without validation.

**Error responses leaking stack traces**
- `c.json({ error: err.stack }, 500)` ships the entire stack to the browser. Worse: ships filesystem paths revealing the server layout. Default to `{ error: 'Internal error' }` and log full detail server-side.
- Severity: **P1** in any branch reachable in production.

**Hono context (`c`) passed downstream**
- `c.get`/`c.set` is a per-request context. Stash useful values there (auth, session ID). Don't pass the whole `c` into services — they shouldn't depend on Hono.
- Severity: **P3** for clean architecture; **P2** if it has caused testability pain.

---

### Principle A3: Middleware ordering and composition

*Carmack: "Structure should make the intended behavior obvious."*
*Hono middleware runs in registration order. Auth before routes; CORS before any response writes; logging at the right granularity. Wrong order = subtle correctness bugs.*

#### What to check

**Auth check after route handler**
- A route registered before its auth middleware runs without auth. The Hono router resolves the route, then walks middleware — order matters. Verify: every protected route's middleware is registered first.
- Severity: **P1** for unprotected routes that should require auth.

**Middleware that throws inside async without try/catch**
- A middleware that does `await loadUser(c)` and throws on missing user. If not wrapped, the request hangs (no response written). Hono catches some classes but not all; always finish the response in the catch path.
- Severity: **P2**.

**Logging middleware logs raw request bodies**
- Bodies may contain prompts, tool inputs, env profiles, secrets. Logging them to console or external telemetry leaks data. Log structural metadata (method, path, status, duration), not bodies.
- Severity: **P2** for body-logging middleware.

**Per-request session ID not propagated**
- A `requestId` middleware that stores in `c.set('requestId', uuid())` should also include it in every log line. Without that, you can't correlate logs across one request. Use a child logger pattern.
- Severity: **P3**.

---

### Principle A4: WebSocket handlers — same discipline, different shape

*Carmack: "Make data flow visible and explicit."*
*Bun.serve's WebSocket upgrade is a different path from HTTP handlers. The same validation/error/cleanup hygiene must be applied — but it's a separate surface that's easy to skip.*

#### What to check

**WebSocket message handler without try/catch**
- `socket.on('message', (data) => JSON.parse(data))` — `JSON.parse` throws on malformed input, the throw becomes an unhandled error, the socket may close mid-stream. Always parse inside try/catch and respond with a typed error to the peer.
- Severity: **P1** for parse-without-catch on any WS message path.

**Auth on HTTP upgrade missing or weak**
- WebSocket auth typically happens at HTTP upgrade (handshake). If `/ws/browser/:id` accepts upgrades without checking a token, anyone with the session ID can join. Cross-reference `security.md`.
- Severity: **P1**.

**`socket.close` without code/reason on error**
- `socket.close()` with no args sends code 1005 (no status). Browsers can't distinguish "server full" from "session ended" from "auth failed". Use specific close codes and reasons.
- Severity: **P3**.

**Per-socket cleanup omitted**
- Listeners attached on the socket (`socket.on('data', ...)`) without paired `socket.on('close', () => cleanup)` leak across reconnects. Cross-reference §B below.
- Severity: **P2**.

---

### Principle A5: Resource lifecycle — connections, FDs, streams

*Carmack: "Understand the lifecycle of every resource you allocate."*
*Collina: every unclosed FD is a slow leak. The Companion server opens session JSONs, recordings, sometimes external HTTP calls. Every open requires a corresponding close.*

#### What to check

**File handles opened without `try/finally` close**
- `const fd = await fs.open(path)` followed by use, no close in a finally block. If anything between throws, the FD leaks. Use `await using` (Bun supports the explicit resource management proposal) or `try/finally`.
- Severity: **P2**.

**`fetch` response bodies not consumed**
- Collina: every fetch body must be read or explicitly cancelled. An unread body holds the connection. The Companion isn't a heavy HTTP client — flag if any `fetch` calls exist where the body is ignored.
- Severity: **P2** for `fetch` calls with unread bodies.

**Recorder FDs held by closed sessions**
- See `quality-ritchie.md` §B Principle 5 and §A Principle 8.

**Timers (`setTimeout`/`setInterval`) without `clearTimeout`/`clearInterval`**
- A debounce timer in `session-store.ts` that isn't cleared on shutdown keeps the process alive (or, after process exit, leaks across hot-reload in dev). Track every timer ID and clean up on lifecycle end.
- Severity: **P3**.

---

### Principle A6: Structured logging — Pino-style, JSON to stdout

*Carmack: "If you can't measure it, you can't improve it."*
*Console logging has its place in dev. Production needs structured JSON with consistent fields: timestamp, level, requestId, sessionId, event, message. Without structure, log search is grep-on-a-haystack.*

#### What to check

**`console.log` peppered throughout server code**
- `console.log` is fine for ad-hoc debugging but should not be the production log path. Use a logger (`pino`, `bun-logger`) with structured fields. Default to JSON in production, pretty in dev.
- Severity: **P3** for ad-hoc `console.log`. **P2** if logs are the primary observability surface.

**Logger format inconsistent across modules**
- One module uses `pino`, another uses `console.log`, another uses a custom format. Logs aren't queryable as one stream.
- Severity: **P3**.

**Per-session log context missing**
- A log line saying "Tool call rejected" with no session ID can't be correlated. Always include the session ID in log lines that touch session state.
- Severity: **P2**.

---

### Principle A7: Async correctness — the event loop is not magic

*Carmack: "Latency is always a bug."*
*Collina: "Contrary to popular belief, promises do not yield to the event loop." Microtasks drain entirely before the loop proceeds. A `for...of` with synchronous `await`s is still synchronous-equivalent.*

#### What to check

**CPU-bound work in request paths**
- Synchronous `JSON.parse` on a 10MB payload, sync hashing in a hot path, sync crypto. Bun is fast but it's still single-threaded for JS. Offload to `Worker` (Bun supports `Worker`) for heavy CPU.
- Severity: **P2** for any sync CPU work that scales with request size.

**Promise chains in tight loops without yield**
- Processing 10,000 messages with `await processOne(m)` where `processOne` resolves synchronously blocks the event loop. Insert `await new Promise(r => setImmediate(r))` periodically, or break work into chunks.
- Severity: **P2** for unbounded loops without yield points.

**`Promise.all` over unbounded arrays**
- `Promise.all(items.map(processItem))` with N=10,000 items opens 10,000 concurrent operations. If `processItem` opens an FD or makes a network call, this blows the limit. Use `p-limit` or batch.
- Severity: **P2**.

**`async` functions without `await`**
- `async function load() { return data; }` — the `async` is meaningless, but a lint rule (`require-await`) catches the wasted promise allocation. Indicates someone confused about the model.
- Severity: **P3**.

---

### Principle A8: Type safety at the boundary

*Carmack: "Use the type system as armour."*
*The Aura backend exposes WebSocket and REST surfaces. Both are validated at runtime. The TypeScript types must match the runtime validators — drift is the most common source of "works in test, fails in prod".*

#### What to check

**`any` on body/payload at request boundary**
- `const body: any = await c.req.json()`. The validator beneath this should narrow to a real type. If it doesn't, the rest of the handler is unchecked.
- Severity: **P2**.

**Zod schema and TypeScript type diverged**
- A Zod schema parses `{ sessionId: string }` but the TypeScript type used by the handler also includes `userId`. Either the schema is too loose or the type is wrong. Use `z.infer<typeof schema>` as the type.
- Severity: **P2**.

**Discriminated union without exhaustive switch**
- A WS message type union with a `switch` that has no `default` and no `never`-typed assertion. New types slip through silently.
- Severity: **P2**.

**Catch block typing `error` as `Error`**
- Per Collina/Dodds: `catch (e: any)` or `catch (e: Error)` is wrong — JS can throw anything. Type as `unknown`, narrow with `instanceof Error`.
- Severity: **P3**.

---

### Principle A9: Bun-specific behaviour

*Carmack: "Don't build on assumptions you can't verify."*
*Bun is Node-compatible-ish. Most things work; subtle things differ. Code that assumes pure Node behaviour can fail under Bun in production.*

#### What to check

**`Bun.serve` vs `http.createServer`**
- Bun's native server is fastest. Using `http.createServer` works but loses perf. Confirm the entry uses `Bun.serve` per CLAUDE.md.
- Severity: **P3** unless mixed.

**`Bun.spawn` vs `child_process.spawn`**
- Cross-reference `quality-ritchie.md` §A Principle 9. Prefer Bun's API on Bun.
- Severity: **P3**.

**`Bun.file()` vs `fs.readFile`**
- `Bun.file().text()` is faster but has different error semantics for missing files. Mixing them across modules creates inconsistent error shapes. Pick one per concern.
- Severity: **P3**.

**Node `--experimental-...` flags assumed available**
- Bun has its own flag surface. If a Node-only flag is documented as a runtime requirement, it won't apply.
- Severity: **P2** if startup depends on a Node-only flag.

**Test runner mix-up: Vitest vs `bun test`**
- Project uses Vitest per CLAUDE.md. If anyone introduces `bun test`-style tests, they live in a parallel runner. Pick one (Vitest).
- Severity: **P3**.

---

## §B NDJSON/WS protocol correctness — realtime discipline

### Principle B1: NDJSON splits on newline — never trust a single `read` to contain a whole message

*Carmack: "If a mistake is possible, it will eventually happen."*
*NDJSON is a stream protocol: a frame may carry zero, one, or multiple newline-delimited JSON objects. TCP/WebSocket boundaries do not align with message boundaries. The reader must buffer until it sees `\n`, parse, then continue.*

#### What to check

**Whole-frame `JSON.parse` on incoming bytes**
- Code that does `JSON.parse(message.data)` on a WebSocket message and treats it as one record. If the CLI ever flushes two messages in the same write — which it CAN under load — the second message is lost or both fail to parse.
- Correct pattern in `claude-adapter.ts`: maintain a `pendingBuffer`, append incoming text, split on `\n`, parse each line, keep the unterminated remainder in the buffer.
- Severity: **P1** for any NDJSON consumer that doesn't line-split.

**Buffer reset on parse error**
- If a malformed line wipes the buffer, every subsequent valid message after it is lost too. Skip the bad line, keep the buffer position, continue.
- Severity: **P2** for over-eager buffer reset.

**Unbounded buffer growth on a never-terminated stream**
- If the CLI sends bytes without ever including `\n` (bug, hostile process, slow producer), the buffer grows to OOM. Cap the buffer at a sane size (e.g. 16 MB) and drop with a loud error on overflow.
- Severity: **P2** for missing buffer cap.

**Binary frames misrouted to NDJSON parser**
- WebSocket supports both text and binary frames. If the parser receives a binary frame and assumes utf-8 text, it can throw or silently corrupt. Reject binary frames at the protocol boundary or define a contract that says "all CLI frames are text".
- Severity: **P3** unless binary actually arrives.

---

### Principle B2: Dedup is a correctness mechanism, not a performance hack

*Carmack: "Deploy assertions as tripwires."*
*`claude-adapter.ts` keeps a rolling 2000-entry hash window to deduplicate CLI messages. This exists because the CLI can re-emit on reconnect with `--resume`. Without dedup, the user sees doubled messages after every reconnect.*

#### What to check

**Hash function that collides on real CLI payloads**
- If the dedup key is `JSON.stringify(msg)` and two messages differ only in a `ts` field, they hash differently and both pass. If the dedup is on a `message.id` field that's optional, anything without an id slips through.
- Choose a deterministic, content-derived hash (sha256 over canonical JSON) or rely on protocol-level IDs only when they are guaranteed present.
- Severity: **P1** for dedup with predictable false negatives on the happy path.

**Window size too small for reconnect bursts**
- `--resume` may replay the last N messages. If N > the dedup window, the oldest replayed messages slip through and double-render. Profile real CLI replay sizes; cap window at ≥ max observed replay + slack.
- Severity: **P2** if the window is below observed CLI replay buffer.

**Dedup state lost on adapter restart**
- If `claude-adapter.ts` is re-instantiated mid-session (e.g. on socket reconnect inside the same process), the dedup window must persist OR the reconnect handshake must re-establish from a sequence number. A blank-slate adapter post-reconnect doubles everything within the window.
- Severity: **P1** for dedup state reset on every reconnect.

---

### Principle B3: Sequence numbers + replay — the only honest reconnect

*Carmack: "Make data flow visible and explicit."*
*Browser-side reconnect (in `web/src/ws.ts`) handles network blips, tab background-throttling, and laptop sleep. A naive "reopen and resume from now" loses every message sent during the disconnect.*

#### What to check

**No sequence number on broadcast messages**
- Server sends events to browser without `seq`. Browser reconnects. Server has no way to know what the browser missed. Either the server replays everything (expensive, may double-deliver) or sends only future events (lossy).
- Pattern: assign a monotonic `seq` per-session at broadcast time. Browser sends `lastSeqSeen` on reconnect. Server replays `seq > lastSeqSeen` from its in-memory ring buffer.
- Severity: **P1** for any user-facing event channel without a replay mechanism.

**Server-side replay buffer unbounded**
- If the server keeps every event ever for replay, memory grows linearly with session length. Cap at a window (e.g. last 5000 events). On reconnect with `lastSeqSeen < window.tail`, do a full state resync (re-send the whole snapshot) instead of partial replay.
- Severity: **P2** for unbounded replay buffers.

**Browser `seq` not persisted across page reload**
- Tab refresh resets `lastSeqSeen` to 0. The server replays from 0 or sends a full snapshot — both fine if explicit. Reset to "wherever the snapshot ends" before resuming the live stream.
- Severity: **P2** if the order of operations leaves a gap between snapshot and live.

---

### Principle B4: Broadcast fan-out — one CLI, many browsers, atomic-ish delivery

*Carmack: "Structure should make the intended behavior obvious."*
*A single session may have multiple browser tabs connected (`/ws/browser/:id`). The bridge must deliver each CLI event to every browser exactly once, in order, despite browsers connecting and disconnecting independently.*

#### What to check

**Per-browser send loop with no error isolation**
- If broadcasting to 3 browsers fails on browser 2 (slow socket, full buffer), does browser 3 still get the message? If the broadcast loop short-circuits on the first send error, later browsers are starved.
- Pattern: each per-browser send is independent (`Promise.allSettled`-style). Failures detach the failed browser but don't block others.
- Severity: **P1** for synchronous short-circuit on broadcast.

**Adding a new browser mid-stream without snapshot**
- New tab opens, server attaches it to the session, but the new tab has no history. Either send a full state snapshot before resuming the live stream, OR send the entire message history. Otherwise the new tab shows blank-then-streaming, missing all context.
- Severity: **P1** for new-tab attach with no history backfill.

**Broadcast order not preserved per-browser**
- If broadcast uses `Promise.all` and one send awaits longer than another, the order in which events land on each browser may differ from the order they arrived from the CLI. Per-browser sends must be serialised (write to a per-browser queue, drain in order).
- Severity: **P2** if ordering matters for the UI (it does — streaming text, tool results).

---

### Principle B5: Keep-alive cadence — silence is not health

*Carmack: "Latency is always a bug."*
*The CLI sends `keep_alive` heartbeats. The browser's WebSocket also sends pings. Both exist because TCP can be silently broken (NAT timeout, network blip) without RST. Without keep-alives, sockets stay "open" but undeliverable for minutes until the first failed write.*

#### What to check

**Server-side `keep_alive` interval > browser idle-timeout**
- Browsers (and intermediate proxies, load balancers) may close idle WebSockets after 30-60s. If the server sends keep-alives every 90s, the socket is closed before the first keep-alive. Document the constraint: keep-alive must be more frequent than the strictest upstream idle timeout.
- Severity: **P2** for cadence mismatch with typical proxy timeouts.

**No timeout-detection on missing keep-alives**
- If the browser hasn't seen a CLI keep-alive in 2× the interval, the bridge is dead. Show "reconnecting" state, don't pretend everything is fine. Conversely: if the server hasn't seen browser pings in 2× the interval, assume the browser is gone and clean up.
- Severity: **P2** for both directions if missing.

**Keep-alive payload that affects state**
- A keep-alive that updates `lastActivity` triggers idle-kill recalculation. If keep-alive frequency is high, idle-kill never fires. Keep keep-alives metadata-only (don't bump activity timers) or document the design.
- Severity: **P3** unless it breaks idle-kill behaviour expected by `quality-ritchie.md` §A.

---

### Principle B6: control_request / control_response — single-shot ack discipline

*Carmack: "If it's syntactically possible, it statistically exists."*
*The CLI sends `control_request` (e.g. `can_use_tool`) and blocks until it receives a matching `control_response`. A missing response wedges the CLI. A duplicate response confuses the CLI's request map.*

#### What to check

**Pending request map without timeout reaper**
- Server holds a map of `request_id → resolver`. If the browser disconnects mid-permission, the entry is never resolved. The CLI waits forever (or until its own timeout). On reconnect, that request must either auto-deny, auto-deny-with-reprompt, or be re-presented to the browser.
- Severity: **P1** for permission requests that wedge after browser disconnect.

**Response without matching request**
- If a `control_response` arrives whose `request_id` isn't in the pending map, log loudly and drop. Silently accepting unmatched responses opens a class of state-confusion bugs.
- Severity: **P2** for silently-dropped unmatched responses without telemetry.

**Allow/deny race on rapid clicks**
- User clicks "allow" twice. Browser sends two `control_response`s. Server forwards both; CLI sees a duplicate. Debounce/idempotency: the resolver should fire once and subsequent calls are no-ops. The browser UI should also disable the buttons after first click.
- Severity: **P2**.

---

### Principle B7: Protocol drift — the CLI is undocumented, the contract is observed

*Carmack: "Don't build on assumptions you can't verify."*
*The protocol is documented in `WEBSOCKET_PROTOCOL_REVERSED.md` based on observation. Any CLI version bump may add fields, remove fields, rename types, or change semantics. The bridge must be defensive against unknown shapes — not crash on a new field.*

#### What to check

**Discriminator field used in a switch without default**
- `switch (msg.type) { case 'system': ... case 'assistant': ... }` with no `default` silently drops new message types. New CLI features become invisible. Add a `default` that logs the unknown type at info level.
- Severity: **P2** for switch-without-default on protocol discriminators.

**Required-field strictness on optional shapes**
- If the bridge throws when `msg.session_id` is missing, but the CLI omits it on certain message types, every such message kills the bridge. Validate only fields you actually consume, treat absent optionals as `undefined`.
- Severity: **P2** for over-strict validation on speculative fields.

**No replay-based regression test**
- `codex-protocol-*.test.ts` exists for Codex. Does an equivalent exist for Claude Code NDJSON? A recording-based regression test (load a known JSONL, feed it through the adapter, assert the typed-event output) catches CLI version drift before users do.
- Severity: **P1** for a load-bearing protocol with no replay test.

**Hard-coded assumptions about ordering**
- Code that expects `init` then `assistant` then `result`. If a new CLI version inserts a `system: compact_boundary` in between, ordering assumptions break. Build state machines that tolerate interleaved events.
- Severity: **P2** for ordering assumptions baked into branching.

---

### Principle B8: Two protocols, one bridge — Codex JSON-RPC vs Claude NDJSON

*Carmack: "Eliminate special cases that don't need to exist."*
*The bridge supports both Claude Code (NDJSON) and Codex (JSON-RPC over WebSocket). Each protocol has its own framing, ID schemes, error envelopes, and lifecycle. Mixing the two in one router is a recipe for cross-protocol bug bleed.*

#### What to check

**Shared abstraction that leaks per-protocol concerns**
- A unified message handler that internally branches on backend type (`if (cliType === 'codex')`) tends to grow asymmetric over time. Cleaner: one adapter per protocol, both producing the same internal event shape. The bridge composes adapters, doesn't switch on them.
- Severity: **P3** for moderate leakage. **P2** if cross-protocol state pollution has been observed.

**JSON-RPC `id` collision across backends**
- If the bridge generates request IDs for both protocols from the same counter and one protocol expects string IDs while the other expects numeric, IDs collide or fail to dispatch. Namespace IDs per protocol.
- Severity: **P2**.

**Error envelope translation losing fidelity**
- JSON-RPC errors are `{ code, message, data }`. Claude NDJSON errors are different. If the bridge maps both to a single `{ error: string }`, debugging downstream is harder. Preserve the original shape under a typed `kind`.
- Severity: **P2** for error fidelity loss.

---

### Principle B9: Backpressure — what happens when the browser is slow

*Carmack: "Latency is always a bug — but data loss is worse."*
*WebSocket has no native backpressure signal. If the browser is slow (background tab, mobile), the server's send buffer grows. Eventually the OS rejects sends and the bridge may drop or crash.*

#### What to check

**Send queue with no bound**
- If the server queues outbound events to a slow browser indefinitely, memory grows linearly. Cap the queue. On overflow: either drop oldest non-critical events, or close the slow browser and require a reconnect-with-replay.
- Severity: **P2** for unbounded outbound queues per browser.

**Backpressure not signalled to the CLI**
- The CLI doesn't stop sending because browsers are slow. The bridge buffers. If the buffer overflows, the bridge has to drop messages or kill the slow browser. There's no "slow down" signal to the CLI — design accordingly.
- Severity: **P3** — this is an architectural reality, not a bug. Flag if there's an attempt to artificially throttle the CLI based on browser pace.

---

## Principle 10: Know your gaps

*Carmack: epistemic humility — you can't fix what you don't know is broken.*

### Areas this doc is weaker on (supplement from other sources)

- **Performance tuning under load**: real load testing is project-stage-dependent. The current product is single-user dev tool; load patterns differ from SaaS.
- **Streaming HTTP responses (SSE)**: Hono supports it; if added later, document separately.
- **CORS in production deploy**: CORS is permissive in dev. For deployed Companion, narrow allowed origins. Covered partly by `security.md`.
- **Hono RPC client**: not used. If introduced for backend-to-frontend type sharing, revisit.
- **WebSocket security**: token-in-URL auth, origin checks, CSWSH (cross-site WebSocket hijacking). Covered by `security.md` (Hunt).
- **Subprocess and CLI lifecycle**: PID tracking, auto-relaunch, `--resume`. Covered by `quality-ritchie.md` §A.
- **MCP protocol**: Model Context Protocol routing through the bridge — not deeply covered here, only the WS-transport layer.
- **HTTP/2 / WebTransport**: out of scope; the protocol is plain WebSocket.

---

## Quick Reference: Severity Guide

| Severity | Pattern | Examples |
|----------|---------|----------|
| **P1 — Fix Now** | Crash, data leak, unprotected route, hung WS; bridge wedges, doubles, or loses user-visible events | Async WS handler with no try/catch, path params used in fs without validation, stack traces in error responses, unauthenticated WebSocket upgrade, unprotected route after auth middleware, whole-frame `JSON.parse` on NDJSON, dedup state reset on reconnect, broadcast short-circuit, pending-request map without timeout, no replay test against captured recordings |
| **P2 — Fix Soon** | Resource leak, validation gap, logging blind spot; drift opportunity, broken reconnect semantics, partial fan-out | Swallowed errors on durable paths, unvalidated mutation routes, FD leaked through throw path, unread fetch bodies, CPU-bound sync work in request paths, type/Zod drift, per-session context missing from logs, missing seq numbers, unbounded replay buffer, switch-without-default on protocol type, mismatched keep-alive cadence, JSON-RPC ID collision, unbounded outbound queues |
| **P3 — Consider** | Convention, observability polish, Bun consistency; boundary clarity, future-proofing | `console.log` in production paths, inconsistent logger format, mixed `Bun.spawn`/`child_process`, async-without-await, missing exhaustive switch on unions, `as Error` on caught values, binary frames not rejected, keep-alive payload semantics unclear, abstraction leak between Codex and Claude adapters, backpressure signalling philosophy |

### The Overriding Filter

Before writing any finding, apply the Bun/Hono + realtime synthesis:

1. **Is every external input validated before it touches state?** Hono boundary or WS upgrade — same rule.
2. **Does every error path either crash loudly or respond cleanly?** Hung sockets and silent rollbacks are the worst defaults.
3. **Is every resource cleaned up on every exit path?** FDs, timers, listeners, child processes.
4. **Is logging structured and per-session?** Otherwise debugging is grep-archaeology.
5. **Is the runtime (Bun) used idiomatically, or is the code pretending to be on Node?** Mixed assumptions silently slow the server.
6. **Will this survive a reconnect?** Lost messages on reconnect are the most common silent failure.
7. **Is the dedup window honest?** If it reset, narrowed, or false-negatives on real CLI replay, the user sees doubled messages.
8. **Does the bridge tolerate unknown shapes?** Protocol drift is inevitable; crashes from new fields are unforgivable.
9. **Does fan-out preserve order per receiver?** Streaming text out of order is worse than no streaming.
10. **Is there a recording-based replay test for the load-bearing protocol path?** Without one, regressions slip in unobserved.

---

## §Z External-source enrichment

Sources:
- https://bun.sh/
- https://hono.dev/
- https://nodejs.org/en/about/
- https://github.com/ry

### Additional principles

- **Event-loop discipline** beats clever scheduling. Bun's loop has predictable phases — blocking any one phase blocks the whole runtime, and CPU-bound work on the request path is the canonical anti-pattern. Following event-loop discipline means deferring or offloading anything ≥1ms on the hot path.
- **Runtime simplicity** is a feature, not a deficit. Hono is value-add precisely because it stays out of the way of `Bun.serve`. Choose runtime simplicity over framework expressivity when the diff is two lines of code; layered abstractions that hide the request/response are the cost of expressivity nobody asked for.
- **Lightweight protocol design** privileges parseability over feature surface. NDJSON wins precisely because `for await (const line of stream)` is one line of code; lightweight protocol design makes drift recoverable when the parser fits in your head.
- **Runtime-native performance** comes from honoring the runtime's grain. `Bun.serve` is fast because it skips the `http.IncomingMessage` abstraction; runtime-native performance evaporates if you wrap Bun in Express-style middleware. The runtime tax compounds across every user-visible byte.

### Tone characteristics

Runtime-focused: read like the runtime docs, not the framework marketing. Anti-bloat: a code review finding that says "this should be in stdlib" is always actionable; the bridge stays small or it doesn't stay correct. Low-latency pragmatism: a 50ms p99 regression on the bridge is worse than a 500ms p99 on the homepage — protocol path performance compounds. Systems-minimalism: a framework you didn't write is one whose bugs you don't control.

### Anti-patterns to detect

- Dispatching Node-only API on Bun runtime (e.g., `node:cluster`, `node:worker_threads`) where Bun's built-in equivalent or omission is the correct choice.
- Mixed sync/async boundary where a CPU-bound transform runs on the request thread before `await`. Breaks event-loop discipline.
- NDJSON framing by substring search on a chunked stream — produces broken frames whenever a chunk ends mid-line. Violates lightweight protocol design.
- Hiding `Bun.serve` behind a layered Express-style middleware stack — pays the abstraction cost of one framework while losing the runtime cost benefit of another.
