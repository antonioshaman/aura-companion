# Backend (Bun + Hono + TS) Review — PR #91 dynamic Claude models

Reviewer: Bun + Hono + TypeScript Backend Expert (Carmack × Collina × Bun/Hono lane)
Scope: `web/server/anthropic-models-cache.ts`, `web/server/routes.ts` Claude branch (~L1518–1602), `web/src/store/settings-slice.ts` (`loadBackendModels`).
Convention floor + PLAN "Risks & Watchpoints" honoured — items parked or already addressed there are not re-flagged.

---

## Verdict

The PR is **structurally tight on the backend axis**. Resource discipline (AbortController + `clearTimeout` in `finally`, body-drain on every status branch, fingerprint-keyed memory + single-flight Promise lock with `finally`-delete) is implemented to the spec the PLAN named. Error mapping respects the Backend R2 invariant (upstream 401/403 → 502 `upstream_unauthorized`, NOT a 401 echoed to the browser). Structured-log shape is consistent across all eight emit sites and honours EC-9 / EC-21 / EC-23. The handler change from sync to `async` is a no-op for Hono middleware composition (Hono awaits the handler return; ordering is registration-order, unaffected).

Findings below are P2/P3 polish only — no P1.

---

## P2 — Fix Soon

### P2-BT-1. Parent-signal propagation silently regresses to timeout-only when `AbortSignal.any` is unavailable

`fetchAnthropicModelsRaw` resolves `signal` via:

```
((AbortSignal as any).any?.([timeoutController.signal, deps.parentSignal]) ?? timeoutController.signal)
```

If `AbortSignal.any` is undefined at runtime, the fallback `timeoutController.signal` is used and the parent (request) signal is **dropped silently**. On Bun 1.0+ and Node 20.3+ the method is present, so this is dormant today — but the failure mode (browser cancels REST request via `c.req.raw.signal`, server keeps hitting Anthropic until 5s timeout) is invisible because there is no log, no warn, and no test that exercises the missing-`any` branch.

Concrete failure mode: a future downgrade to a runtime without `AbortSignal.any` (or running the module under a polyfill that didn't reach the spec) turns parent-cancellation into a 5-second tail of upstream traffic per cancelled request. With the inflight lock active, a series of cancel-then-retry users all wait the timeout for the leader to give up before any progress.

Recommendation: either crash loudly on `AbortSignal.any === undefined` at module load (programmer-error-is-a-crash per Principle 1 — Bun has it; absence means wrong runtime), or fall through to the parent-signal alone and log `signal-coalesce-degraded` on the first occurrence. The current silent demote is the worst of both.

### P2-BT-2. Module-scope `inflightModelLoadTokens` counter can discard a successful late-resolving fetch in favour of an earlier-resolving failure

In `settings-slice.ts loadBackendModels`, the token counter increments on every call. Both success and error commit only when `inflightModelLoadTokens[backend] === myToken`. Consider this interleaving:

1. Call A: `myToken = 1`. Status → "pending". Fetch starts.
2. Call B: `myToken = 2`. Status → "pending" (already). Fetch starts.
3. Call B's fetch **rejects fast** (network blip). Check `1 + 1 (== myToken 2)` → commits status = "rejected".
4. Call A's fetch **succeeds slowly**. Check `2 !== 1` → dropped silently. The actual models payload is discarded.

Net: the slice ends in `status === "rejected"` with `dynamicBackendModels[backend] === undefined`, even though one concurrent call returned a clean list. UI shows the static fallback indefinitely until the next manual `loadBackendModels` invocation.

This isn't a P1 because the server-side cache will make the next call cheap, but the contract ("the latest call wins, silently fall back on error") leaks: it actually means *the latest-resolving token's outcome wins regardless of correctness order*. A token bump is also a token's-result invalidation, which is fine for the obvious case (key rotation) but pessimistic for transient flakes.

Recommendation: don't flip status to "rejected" if a newer token is still pending. Either keep "pending" until the latest token resolves, or track the highest-tokened result and prefer success on tie-breaks. Minimum: a comment documenting the tradeoff so the next reader doesn't think it's a bug.

### P2-BT-3. `fetched_at` snapshot is taken before the fetch, not after — record claims earlier provenance than reality

In `getAnthropicModels`:

```
const currentTime = nowImpl();      // captured pre-fetch
// ...
const record: CachedModelsRecord = {
  schema_version: SCHEMA_VERSION,
  fetched_at: currentTime,           // same pre-fetch snapshot
  ...
};
```

The disk record's `fetched_at` therefore reflects when the orchestrator was *called*, not when the upstream successfully returned. For a 5s-timeout window that's bounded, but it skews the in-memory TTL and disk-staleness calculations in the conservative direction (cache appears older than it is — expires earlier).

The asymmetric concern: piggyback callers under the single-flight lock will also see `fetched_at = leader's currentTime`. If the leader's call happens to take 4.8s and 50 piggybackers arrived during that window, the cache record records the leader's start time. Five seconds later they'd all be eligible to re-fetch (still within memory TTL, so no practical impact at 1h TTL).

Recommendation: capture `fetched_at` from a `nowImpl()` snapshot taken *after* `fetchAnthropicModelsRaw` returns success. This aligns the field name with the semantic and removes a subtle EC-21 source-of-truth ambiguity (the elapsed_ms log and the fetched_at field disagree on what moment counts as "fetched").

---

## P3 — Consider

### P3-BT-1. `__deleteDiskCacheForTests` uses `require("node:fs")` with `eslint-disable` despite the module already statically importing `node:fs`

Top of file:

```
import { readFileSync, realpathSync } from "node:fs";
```

Then in `__deleteDiskCacheForTests`:

```
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require("node:fs") as typeof import("node:fs");
fs.unlinkSync(ANTHROPIC_MODELS_CACHE_PATH);
```

The eslint-disable + `require` is unnecessary. `import { unlinkSync } from "node:fs"` at the top is the symmetric solution and avoids the lint suppression entirely. The `__` prefix already signals test-only use; making the import "harder" via `require` doesn't actually prevent a production caller from invoking the function, so the obfuscation buys nothing.

If the concern was bundler tree-shaking the unused-in-production helper, ESM static imports are already shaken correctly by Bun's bundler.

Recommendation: hoist `unlinkSync` into the static import list, delete the eslint-disable + `require` form.

### P3-BT-2. `upstream.success` log payload drops `fetched_at` — partial EC-21 triplet

EC-21 names the documented triplet as `(fetched_at, key_fingerprint, model_count)`. Two of the three appear in the `anthropic-models.upstream.success` payload:

```
log.info("anthropic-models-cache", "upstream.success", {
  event: "anthropic-models.upstream.success",
  http_status: fetched.httpStatus,
  key_fingerprint: fingerprint,
  model_count: parsed.models.length,
  dropped_items: parsed.droppedItems,
  elapsed_ms: fetched.elapsed_ms,
});
```

`fetched_at` is omitted. Forensic replay that wants to correlate a write to a cache hit downstream has to back-compute from `now - elapsed_ms` or use the timestamp the logger itself stamps (different source of truth).

Recommendation: add `fetched_at: currentTime` (or the post-fetch snapshot suggested in P2-BT-3). Cheap, symmetric with `cache.hit.memory` / `cache.hit.disk` which already carry `cache_age_ms` derived from the same field.

### P3-BT-3. `response.body?.cancel()` in the `catch` swallows its own rejection — fine, but the comment overstates when it fires

In `fetchAnthropicModelsRaw`'s `catch`:

```
if (response !== undefined) {
  try {
    await response.body?.cancel();
  } catch { /* ignore */ }
}
```

The accompanying comment says "happens if `.json()` throws AFTER non-ok status but we already returned above — defence-in-depth". In practice, the only realistic catch-block entry path *with* a defined `response` is:

- 2xx received → `response.json()` throws mid-parse with a non-`AbortError` (e.g. socket reset during body read). The `.json()` try/catch catches `SyntaxError` and returns `unavailable: parse`, NOT thrown out — so the outer catch doesn't fire from this path.
- AbortError thrown from `fetchImpl(...)` itself before `response` is assigned → `response` is `undefined`, the `if` guards correctly.

So the `response.body?.cancel()` is mostly dead code today. It's harmless (defence-in-depth is on principle), but the comment promises a path that the current code structure has already neutralised (the inner `try { raw = await response.json() } catch { return ... }` doesn't propagate).

Recommendation: keep the cancel for future-proofing, but trim the comment to "defensive — current callers don't reach here, but a future refactor that throws inside the 2xx branch will rely on it".

### P3-BT-4. `assertCachePathInBounds` errors carry the same prefix but are not enum-discriminated

Two distinct failure modes:

```
throw new Error("anthropic-models-cache: cache path resolved to home root — refusing write");
throw new Error("anthropic-models-cache: cache path escaped COMPANION_HOME — refusing write");
```

Both surface to the orchestrator's `try { writeDiskCache(...) } catch { ... }` and get logged with `error_name: err.name === "Error"`. The cache-write log line can't distinguish "path-escape" from "path-equal-home" from "fs error during atomic write" from "key suffix accidentally in payload" — they all map to `error_name: "Error"`.

Per Principle 6 (per-session log context missing), the structured-log payload should carry the concrete failure reason for forensic triage.

Recommendation: throw typed errors (a thin `class CachePathBoundsError extends Error { constructor(public readonly reason: "root" | "escape" | "key-leak") { ... } }`) and surface `reason` in the `cache.write-failed` log payload.

---

## Items deliberately not flagged (already addressed in PLAN Risks & Watchpoints or upstream review)

- Hunt R3 pre-auth oracle (auth middleware at `routes.ts:158` registered BEFORE `/backends/:id/models` — verified).
- Hunt R4 `?refresh=1` escape hatch (confirmed absent in handler).
- Hunt R5 recording exclusion regression (Task 7 territory, Beck's lane).
- Sticky vs dynamic[0] (parked; Frontend R1).
- EC-22 emit-path coverage (Beck's lane).
- Fowler stretch — Codex shared module extraction (explicitly parked).
- AP-3 writer+reader+parser co-location for disk cache (followed).
- AP-14 `toModelOptions` single converter (followed at the frontend boundary).
- Schema versioning + strict-equality on read (Persistence lane).
- `memoryCache` module-scope global (single-process Bun OK — context-brief flagged for future multi-tenant).
- ModelSwitcher / HomePage / CronManager wiring (Frontend / a11y / UX lanes).

---

## One-liner

Backend axis is structurally tight — resource discipline, body-drain, single-flight, and EC-9/21/23 log shape all clean. Four polish findings only: P2 silent parent-signal demote on missing `AbortSignal.any`, P2 inflight-token rejection clobbering a slower success, P2 `fetched_at` snapshot taken pre-fetch (semantic skew), and P3 polish on `require("node:fs")` test-hatch, `upstream.success` log triplet completeness, dead-code catch comment, and untyped `assertCachePathInBounds` errors.
