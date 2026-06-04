# Backend (Bun + Hono + TS) Review — PR #91 SECOND PASS (post-burndown)

Reviewer: Bun + Hono + TypeScript Backend Expert (Carmack × Collina × Bun/Hono lane)
Scope: `web/server/anthropic-models-cache.ts` (clock-skew clamp + `resolveCoalescedSignal` + `signalCoalesceDegradeLogged` + `__resetSignalCoalesceFlagForTests`), `web/server/atomic-write.ts` (chmod retrofit), `web/src/store/settings-slice.ts` (loadBackendModels reject defence + sticky preference).

Convention floor (EC-1..EC-41, AP-1..AP-16) honoured — items the first review's Phase 7 added are not re-flagged.

---

## Verdict

Two of the three P2-BT findings from the first review are addressed; one was deferred without acknowledgement. The two new P3-BT items (P3-BT-2, P3-BT-4) the burndown was asked about remain UNclosed verbatim — the burndown commit landed only on the P2 axis and left the P3 backlog from this lane untouched. None of these are ship-blockers, but the brief's claim of "15/15 closed" was scope-claimed against the FINAL-REVIEW.md aggregate (which intentionally excluded my lane's P3s), so this isn't itself a regression — just worth noting so the residual is tracked.

The burndown also introduces **two new structural concerns** that weren't present at the first review:

1. **P2-BT-1 the new `resolveCoalescedSignal` is dead-on-arrival in production** — `routes.ts:1586` calls `getAnthropicModels(settings.anthropicApiKey)` with no `deps`, so `deps?.parentSignal` is always `undefined`, the ternary at line 665 takes the `timeoutController.signal` branch, and `resolveCoalescedSignal` is never invoked. The warn flag, the reset helper, the helper itself — all unreached by production code paths. Classic `feedback_call_site_presence_not_just_symbol_export` shape.
2. **P2-BT-2 the "soft-rejected" semantic introduces an undocumented discriminated-union state** — `status === "rejected"` is now overloaded: it means EITHER "no data, fetch failed" OR "stale data preserved, latest fetch failed." Consumers reading `dynamicBackendModelsStatus.claude === "rejected"` cannot tell these apart without a second selector call. The type alias `DynamicModelsStatus` was not widened to discriminate.

Findings below are P2/P3 polish. No P1.

---

## P2 — Fix Soon

### P2-BT-A. New: `resolveCoalescedSignal` is dead-on-arrival in production — no caller supplies `parentSignal`

The burndown closes the **shape** of the prior P2-BT-1 (silent demote → log + parent-only fallback). But:

- `web/server/routes.ts:1586` is the only production caller of `getAnthropicModels`. It invokes `getAnthropicModels(settings.anthropicApiKey)` — no second arg. Therefore `deps?.parentSignal === undefined` always.
- At `anthropic-models-cache.ts:665`, the ternary `deps?.parentSignal ? resolveCoalescedSignal(...) : timeoutController.signal` always takes the right branch in production.
- `resolveCoalescedSignal`, `signalCoalesceDegradeLogged`, and `__resetSignalCoalesceFlagForTests` are unreached at runtime in production. (`grep` confirms zero call sites for the reset helper across the whole repo.)
- The original finding's failure mode ("browser cancels REST request via `c.req.raw.signal`, server keeps hitting Anthropic until 5s timeout") still ships — the fix is on the wrong axis. To actually realise the fix, `routes.ts:1586` must thread `c.req.raw.signal` as `{ parentSignal: c.req.raw.signal }`.

**Trade-off question from the prompt:** "does the parent-only fallback create a new resource-leak vector (timeout no longer applies)?" — Yes, in theory: if production ever wired `parentSignal` AND the runtime lacked `AbortSignal.any`, the timeoutController would still fire and `.abort()` itself, but the returned signal (`parentSignal`) would not see it. Result: the request never aborts on timeout. Bun's pool-managed `fetch` would hold the socket until the kernel TCP timeout (~75s+) on a hung TLS handshake, with the inflight lock pinning all concurrent requests to that dead promise. The cleanup `clearTimeout(timeoutHandle)` in `finally` makes the timer benign on fast paths, but the slow path loses its outer bound. **The current burndown ships this trade-off without a test exercising it** (zero `signalCoalesce` matches in the test file).

**Recommendation:** either (a) wire `parentSignal` at the routes.ts call site so the burndown's fix actually does something, then add a test for the dead-`AbortSignal.any` branch; or (b) acknowledge the dead code by removing the helper + flag and revert to the prior shape, treating the P2-BT-1 finding as "wontfix — production never passes parentSignal." Current state is the worst-of-both: extra surface, extra warn flag, no actual behavioural change.

### P2-BT-B. "Soft-rejected" status is an undocumented discriminated-union state

The slice now ships two distinct semantic states behind one `DynamicModelsStatus = "rejected"`:

- **Hard reject** (slot empty, fetch failed): `dynamicBackendModelsStatus[backend] === "rejected"` AND `dynamicBackendModels[backend] === undefined`.
- **Soft reject** (slot populated, latest fetch failed): `dynamicBackendModelsStatus[backend] === "rejected"` AND `dynamicBackendModels[backend]` holds a valid array from a prior success.

The type `DynamicModelsStatus = "idle" | "pending" | "resolved" | "rejected"` does not encode the distinction. A consumer that wants to render "stale data shown — refresh failed" inline hint vs "no data — refresh failed" full-fallback CANNOT decide from the status field alone; it must read both `dynamicBackendModels[backend]` and `dynamicBackendModelsStatus[backend]` and combine them. The comment at line 290 names "soft-rejected" as a concept but the type system doesn't carry it; the test at `settings-slice.test.ts:312` calls the status "soft-rejected" in a comment but asserts `=== "rejected"`. The naming + semantic don't agree.

This is the canonical `feedback_council_documented_contract_canary` shape: JSDoc says one thing ("soft-rejected — preserves last known data while signalling the most recent fetch did not produce a fresher result"), the type union doesn't carry the distinction, so the next reader writing a refresh-button surface will either flatten the two cases or invent a per-consumer composite check.

**Recommendation:** widen the type to `"idle" | "pending" | "resolved" | "rejected" | "rejected-stale"` (or `{kind: "rejected", hasStaleData: boolean}`). Single source of truth, type-system-enforced, no rediscovery cost. ~10 LOC change in the slice + the test assertion bump. Alternative (cheaper but weaker): document the field as `"rejected" + (selectDynamicBackendModels(s, b) !== undefined)` is "stale-data" in the slice JSDoc so future readers don't have to reverse-engineer it from the test.

### P2-BT-3 (carried from first review). `fetched_at` is still snapshotted PRE-fetch

Not addressed in the burndown. `web/server/anthropic-models-cache.ts:1109` still captures `currentTime = nowImpl()` before any fetch happens; line 1237 still writes `fetched_at: currentTime` into the record. The semantic skew (record's `fetched_at` reflects when the orchestrator was *called*, not when the fetch *returned*) survives, which means the in-memory TTL and disk-staleness math still systematically over-expire by `elapsed_ms` (5s worst case).

This was correctly P2/P3 territory in the first review and remains so; flagging only because the brief asked whether it was addressed. **Re-flagged as not closed; carry forward.**

---

## P3 — Consider

### P3-BT-2 (carried from first review). `upstream.success` log payload still drops `fetched_at`

`anthropic-models-cache.ts:1256-1263`:

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

Still missing `fetched_at`. The EC-21 triplet (`fetched_at`, `key_fingerprint`, `model_count`) is incomplete on the success emit, complete on `cache.hit.memory` / `cache.hit.disk` / `stale-served`. Asymmetric.

**Re-flagged as not closed; same fix as before (add `fetched_at: currentTime`).**

### P3-BT-4 (carried from first review). `assertCachePathInBounds` errors still untyped

`anthropic-models-cache.ts:899-920` still throws raw `new Error("anthropic-models-cache: cache path resolved to home root — refusing write")` and `new Error("anthropic-models-cache: cache path escaped COMPANION_HOME — refusing write")`. The catch at line 1252 logs `error_name: err instanceof Error ? err.name : "unknown"` — both errors carry `err.name === "Error"`, so the `cache.write-failed` log entries cannot distinguish "path-equal-home" from "path-escape" from "fs EACCES" from "key suffix in payload" at forensic-triage time.

**Re-flagged as not closed; same fix as before (`class CachePathBoundsError extends Error { constructor(public readonly reason: "root" | "escape" | "key-leak") }` + surface `reason` in the log payload).**

### P3-BT-C. New: `atomic-write.ts` chmod best-effort silently swallows EACCES regression class

The burndown adds `chmodSync(dir, 0o700)` in a `try { ... } catch { /* best-effort */ }` at line 43. The JSDoc names the intended legitimate failure ("a recursive parent (e.g., COMPANION_HOME) may already exist with broader perms set by a different writer"). That case is sound: the wrapper has already created the immediate `dir` with `mode: 0o700`; only when chmod targets an EXISTING parent owned by a different UID does the chmod legitimately fail.

But the swallow is too wide. The catch absorbs:

- `EACCES` on a recursive parent owned by a different UID — the intended legitimate case (silent swallow correct).
- `EACCES` on the immediate `dir` because the umask masked out write permission on creation in a way that prevents chmod — silently swallowed; mode stays at `0o755` or whatever umask produced; file `0o600` is still the primary defence, but the side-channel the burndown was meant to close (filename + mtime metadata leakage on multi-UID hosts) is silently NOT closed.
- `EPERM` on macOS SIP-protected paths — silently swallowed; same outcome.
- `ENOENT` race (some other process deletes the dir between mkdir and chmod) — silently swallowed; the next openSync at line 64 will then throw a different error, masking the original race.

For a wrapper used by every writer in the codebase (env profiles, council artifacts, settings.json, the new anthropic models cache), silently dropping the chmod result is a Principle 1 / Principle 6 leak: the JSDoc claims "0o700 parent dir" as a defence, the catch silently downgrades, and there's no log entry telling the operator the defence was bypassed for this writer instance.

**Recommendation:** narrow the catch to the legitimate case. Either (a) check `dir === COMPANION_HOME || dir.startsWith(COMPANION_HOME + sep) === false` and skip chmod entirely for cross-UID paths, throwing on any chmod error otherwise; or (b) log a structured `warn` ("atomic-write.chmod-failed" with `event`, `dir`, `error_name`) before swallowing, so the operator at least has a forensic trace when the defence is bypassed. Current shape is silent-and-best-effort, which is the worst-of-both for a security-adjacent mode bit.

### P3-BT-D. New: `__resetSignalCoalesceFlagForTests` exported but has zero call sites

`grep` of `__resetSignalCoalesceFlagForTests` across the entire repo finds it only at its definition site (`anthropic-models-cache.ts:612`). No test imports it; no test calls it. The flag it resets (`signalCoalesceDegradeLogged`) survives across tests in the same file because Vitest reuses the module-graph within a worker. If any future test exercises the dead-`AbortSignal.any` branch and asserts the warn fires, suite-ordering will determine whether that test passes — first test in worker sees the warn; subsequent tests don't.

This is the kind of latent test-ordering bug that ships green until someone reorders the suite. The reset helper is the correct shape; it just needs an `afterEach()` call site OR a `beforeEach()` in any describe block that touches the cache module.

**Recommendation:** add `beforeEach(() => { __resetSignalCoalesceFlagForTests(); })` in `anthropic-models-cache.test.ts`'s top-level scope, OR remove the exported helper as YAGNI since no test exercises the warn branch today.

### P3-BT-1 (carried from first review). `__deleteDiskCacheForTests` still uses `require("node:fs")` + eslint-disable

Not addressed in the burndown. The convention floor's new EC-40 ("Test-only escape hatches use static `import`, NOT inline `require()` + `eslint-disable`") was added by the first review's Phase 7. The burndown should have applied EC-40 to its own helper as part of conformance with the new convention.

`anthropic-models-cache.ts:1043-1057` still uses the inline-require + eslint-disable shape. EC-40 violation against the convention the first review added.

**Re-flagged as not closed; per EC-40 (which the burndown commit itself added), should be `import { unlinkSync } from "node:fs"` at the top of the file.**

---

## Items deliberately not flagged (already addressed in burndown or first review)

- P2-BT-1 (silent demote of parent signal) — **shape addressed** (warn + fallback), but call-site still dead. Flagged as P2-BT-A above with a different angle.
- P2-BT-2 (inflight clobber on rejection) — **addressed** at the slice (lines 280-302); but introduces P2-BT-B (undocumented discriminated-union state). Flagged separately.
- P2-BT-3 (`fetched_at` pre-fetch snapshot) — **NOT addressed in burndown**, carried forward.
- P3-BT-1 (`require`+eslint-disable) — **NOT addressed in burndown**, EC-40 violation, carried forward.
- P3-BT-2 (`upstream.success` missing `fetched_at`) — **NOT addressed in burndown**, carried forward.
- P3-BT-3 (`response.body?.cancel()` comment overstates) — not re-checked; first-review priority unchanged.
- P3-BT-4 (`assertCachePathInBounds` untyped errors) — **NOT addressed in burndown**, carried forward.
- EC-22 emit-path tests (Beck's lane) — confirmed via grep that `log.info`/`log.warn` spies now exist; out of this lane.
- Sticky preference call-site wiring at `HomePage.tsx:260` — verified threaded through `pickSessionDefaultModel(newBackend, dynamicForNew, stickyForNew)`. Closed.
- Clock-skew clamp at line 821 — `Math.max(0, now - r.fetched_at) > ttlMs` — correct EC-38 implementation. Closed.

---

## One-liner

Two P2-BT items addressed in shape but with caveats (resolveCoalescedSignal is dead-on-arrival because routes.ts:1586 never passes parentSignal; "soft-rejected" introduces an undocumented union state that the `DynamicModelsStatus` type doesn't encode); three first-review items (P2-BT-3 pre-fetch fetched_at, P3-BT-1 require+eslint-disable now an EC-40 violation, P3-BT-2 upstream.success missing fetched_at, P3-BT-4 untyped assertCachePathInBounds errors) NOT closed by burndown — these were within scope but the burndown commit landed only on the higher-priority axes; two new findings (atomic-write chmod catch swallows EACCES too widely, __resetSignalCoalesceFlagForTests is exported with zero call sites and risks suite-ordering bugs).
