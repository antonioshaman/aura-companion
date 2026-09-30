# Fowler — Refactoring lens, PR #68

Reviewer: Martin Fowler (refactoring + evolutionary architecture + code-smell taxonomy)
Scope: `browser-group-record.ts`, `session-orchestrator.ts` (delta), `ws-bridge.ts` (delta), `session-group-coordinator.ts` (delta), `session-types.ts` (delta), `store/council-slice.ts` (delta)
Convention floor in force: AP-1..EC-13. New candidate AP-X (single assembly site for multi-producer wire shapes) is implicit in the keystone refactor.

---

## Summary

The keystone refactor — three independent `group_created` producers (orchestrator push listener, REST bootstrap, ws-bridge synthetic hydration) routing through one `buildBrowserGroupRecord` helper — is the right move and is economically well-targeted. The helper is narrowly-scoped, documents its three call sites, and makes the four wire fields (`sessionGroupId`, `primarySessionId`, `observerSessionId`, `pairing`) drift-impossible by construction. Two refinements would tighten the seam further (one P2, two P3). No P1.

The `hydrateGroups` idempotency contract is correct for the "live WS wins" intent. There is one observable hole in the contract (stale `groupBySessionId` mappings — P2) which is small enough to defer but needs naming.

The 3353-line `session-orchestrator.ts` god-module pre-dates this PR; this PR adds 45 lines net which is not material to the smell, but the new `getAllGroupsForBootstrap` is a pure data fan-in that has no behavioural ties to the orchestrator and would naturally live next to `SessionGroupCoordinator.listAll` (P3 — economic refactor case is weak unless someone touches this region again).

---

## P2-Fowler-1 — Defensive `?? "claude"` fallback duplicated at all three call sites

**File:** `web/server/session-orchestrator.ts:1207-1216`, `web/server/ws-bridge.ts:1287-1296`, plus implicit at `web/server/session-orchestrator.ts:2987-2990` (REST bootstrap — coordinator-sourced, no fallback needed there)

**Severity:** P2 (smell: Duplicated Logic / Feature Envy across call sites of a freshly-extracted helper)

**Finding:** The pre-refactor pairing-assembly line `\`${primary?.backendType ?? "claude"}+${observer?.backendType ?? "claude"}\`` carried both the field-selection AND a defensive fallback for "launcher hasn't propagated backendType yet". The refactor pulled field-selection into the helper but left the `?? "claude"` fallback duplicated at two of the three call sites (push listener + ws-bridge synthetic). The third site (REST bootstrap) doesn't need the fallback because it sources from coordinator records where `backendType` is required. This means the helper's contract is implicitly "caller MUST resolve fallback before calling", which is a documentation invariant rather than a type-system one.

**Consequence:** A fourth call site added six months from now will replicate the bug-class the helper was extracted to prevent — it will either omit the fallback (and pass `undefined` cast as `BackendType`, producing a wire payload with `pairing: "undefined+undefined"`) or replicate the literal `"claude"` default, drifting if the system ever changes the safe-default backend. Adding a fourth producer is plausible: the bootstrap brief itself names ws-bridge:1289 as a future audit target.

**Fix:** Either (a) move `backendType` to `BackendType | undefined` in `BrowserGroupRecordParts` and let `buildBrowserGroupRecord` apply `?? "claude"` internally, with a JSDoc note that the fallback is for launcher-propagation-lag and a future no-undefined contract should remove it; or (b) tighten the type-system contract by making the launcher's `getSession()` return type guarantee non-undefined `backendType` post-spawn, eliminating the fallback at the source. Option (a) is the cheaper near-term move and matches the helper's existing remit; option (b) is the structurally cleaner answer but bleeds outside PR scope.

---

## P2-Fowler-2 — `hydrateGroups` skips `groupBySessionId` repair for already-known group ids

**File:** `web/src/store/council-slice.ts:259-271`

**Severity:** P2 (smell: Incomplete Idempotency / partial invariant)

**Finding:** The idempotency contract documented in the JSDoc is "live WS wins for already-present groups" — and the implementation enforces this by `continue`-ing the loop on `groups.has(g.sessionGroupId)`. That correctly protects the mutable runtime fields (`lastCheckpointAt`, `observerReviewing`, `convergenceState`) that REST does not carry. But the `groupBySessionId` map writes (lines 266-267) are inside the `continue`-guarded block, so a stale state where the WS pushed a group whose `groupBySessionId` mapping was somehow lost (e.g. by a prior `removeGroup` that missed the inverse-map cleanup, or by a Map-rebuild bug elsewhere) will NOT be repaired by the REST bootstrap. The "live WS wins" intent applies to the group record's mutable fields, not to the index invariant.

**Consequence:** The REST bootstrap nominally exists to repair "browser missed the live push" states. Today the only way to miss the push is at app mount. If a future bug lets the WS path establish a group but corrupt the inverse map, the REST bootstrap is structurally unable to repair it because the group-id-presence check short-circuits the inverse-map writes too. The current production setup is unlikely to hit this, but the contract claim is wider than the implementation.

**Fix:** Separate the two invariants — always write `groupBySessionId` for both halves (it's a pure idempotent projection of the GroupRecord into the inverse map), and gate ONLY the `groups.set(...)` + bucket-init behind the `!groups.has(...)` check. The `mutated = true` flag should fire if either the forward map OR the inverse map was actually changed (compare-then-set). This is a 3-line change inside the existing loop and tightens the documented contract without widening it.

---

## P3-Fowler-3 — `getAllGroupsForBootstrap` lives in `session-orchestrator.ts` but conceptually belongs near the coordinator

**File:** `web/server/session-orchestrator.ts:2972-2991`

**Severity:** P3 (smell: Misplaced Method, weighted by §A economic-refactor frame — low change-frequency)

**Finding:** `session-orchestrator.ts` is 3353 lines (pre-existing god-module concern unrelated to this PR). The new `getAllGroupsForBootstrap` method has zero behavioural ties to the orchestrator's responsibilities — it's a pure data fan-in: `coordinator.listAll()` → filter archived → map through `buildBrowserGroupRecord` → return. The only reason it sits on the orchestrator is the existing convention "the orchestrator is the public API surface the REST layer talks to" — `routes.ts` calls `orchestrator.getAllGroupsForBootstrap()` rather than reaching into the coordinator. That convention has real value (single REST-facing seam), so this finding is informational rather than blocking.

**Consequence:** A reader navigating Council Mode group lifecycle will find five related concerns (coordinator state, state-machine transitions, bus-event fanout, REST surface, bootstrap snapshotting) spread across two files where four naturally cluster on the coordinator side and one (push-listener fanout) is genuinely the orchestrator's. The §A economic frame says this matters only if the region is touched again. The REST bootstrap is foundational and unlikely to be edited weekly — the cleanup is negative-EV until a second bootstrap-related method lands.

**Fix:** When the next bootstrap-shaped method lands (deadRole repair, archived-window snapshot, or any other "snapshot coordinator state for browser hydration" concern), promote `getAllGroupsForBootstrap` into a focused module — `council-bootstrap.ts` next to `browser-group-record.ts` — and have `routes.ts` call it directly. Until then, leave it; the §A test is the right discipline here, not aesthetic offence.

---

## P3-Fowler-4 — `as BackendType` casts at call sites bypass the type system

**File:** `web/server/session-orchestrator.ts:1209,1213`, `web/server/ws-bridge.ts:1289,1293`

**Severity:** P3 (smell: Type-system Bypass; minor — load-bearing only if a future regression breaks the launcher's backendType propagation)

**Finding:** The inline `(primary?.backendType ?? "claude") as BackendType` casts at two of the three call sites are unnecessary if the launcher's `SdkSessionInfo.backendType` is typed as `BackendType` (non-optional). The cast exists because `primary?.backendType` returns `BackendType | undefined` through the optional-chaining. The shape of the cast tells the reader "we believe this is a BackendType but the compiler can't prove it" — and the proof IS available (the `?? "claude"` literal narrows undefined out). TypeScript should infer `BackendType` directly without the cast.

**Consequence:** Casts are local trust statements. A future change that makes "claude" no longer a literal `BackendType` (e.g. moving to a branded type) will silently keep compiling because the cast bypasses the check, and the wire emit will produce an invalid pairing label. Small risk; bounded by the typescript-strict gate that already exists on this codebase.

**Fix:** Remove the `as BackendType` casts and let TypeScript infer — if the inference fails, that's a signal `BackendType` needs to include `"claude"` as an explicit member or the fallback should change. If the inference succeeds, the casts were dead weight and tightening the helper-internal fallback (per P2-Fowler-1) eliminates them entirely.

---

## P3-Fowler-5 — `BrowserGroupRecord` (wire) vs client `GroupRecord` (state) duck-typing at `fetchGroups`

**File:** `web/src/api.ts:898` + `web/src/types.ts:113-166` + `web/server/session-types.ts:546-580`

**Severity:** P3 (smell: Structural Duck Typing across a process boundary)

**Finding:** `api.fetchGroups()` declares its return type as `Promise<{ groups: GroupRecord[] }>` using the CLIENT `GroupRecord` (which is the full Zustand-store shape with `lastCheckpointAt`, `observerReviewing`, etc.). The server actually emits `BrowserGroupRecord` (the strict wire subset, just 7 fields). The wider client type is structurally compatible with the narrower server emit because all the extra client fields are optional, so the cast works at runtime by accident-of-optionality. But the API client lies about what comes back — a reader expects `cycleNumber` to potentially populate from REST, and it never will. The AP-3 convention says writer and reader schemas co-locate; here the wire-reader IS the same place as the wire-writer (`session-types.ts`) so AP-3 is satisfied, but the client-side `fetchGroups` is reading into a wider type than the wire defines.

**Consequence:** A future developer wiring "use REST snapshot for `lastCheckpointAt` recovery" will write code that compiles and silently does nothing. The drift is "client wider than wire", which is fail-quiet by construction (undefined fields stay undefined).

**Fix:** Type `fetchGroups` as `Promise<{ groups: BrowserGroupRecord[] }>` and let `hydrateGroups` accept `BrowserGroupRecord` as input rather than the client `GroupRecord`. The store's `groups` map can still hold the wider client type; the action signature should accept the narrower wire type and the store knows the input fills only the wire-defined subset. This makes the "REST snapshot does NOT carry mutable runtime fields" claim type-system-enforced rather than documented.

---

## P3-Fowler-6 — `status: "active"` literal at two of three call sites; helper takes it as parameter

**File:** `web/server/session-orchestrator.ts:1215`, `web/server/ws-bridge.ts:1298`

**Severity:** P3 (smell: Parameter that's a constant at two of three call sites; observation only)

**Finding:** The helper's signature requires `status: BrowserGroupRecord["status"]` as a parameter. Two call sites pass the literal `"active"` because by construction they only fire when the group is active (push listener fires on a state-machine transition that LEAVES the group active; ws-bridge synthetic hydration fires only when both halves are bridge-registered which implies active). The third call site (REST bootstrap) passes `g.status` from the coordinator record because a reload during `degraded`/`reconnecting` must surface the true status. This is documented well in `browser-group-record.ts` lines 21-26 — the comment explicitly justifies the asymmetry.

**Consequence:** Zero today. The asymmetry is intentional and defensible. The only thing to watch: if a future change removes the "always active" invariant on either of the two literal-`"active"` call sites (e.g. push listener gains a path that fires on a state-machine reconnect transition), the literal `"active"` will lie. The invariant is currently load-bearing but unguarded.

**Fix:** Either (a) leave as-is and trust the inline comments — current state, defensible; or (b) add a comment-anchored unit test on the push listener verifying it only fires on `pairing → active` and `reconnecting → active` transitions, so a future change that breaks the invariant trips a test rather than a runtime mis-label. Option (a) is fine for now; option (b) is a worthwhile EC-6-style canary if the seam comes up again.

---

## Convention promotion candidate (Phase 7 input)

The keystone refactor is a textbook instance of the proposed `AP-X: Multi-producer wire shapes route through one assembly site`. The three producers — push listener, REST snapshot, synthetic hydration — share the *same wire variant*, so the convention is "if a wire variant has more than one server-side emit site, the field-assembly must funnel through one helper". The helper signature accepts the *minimum data the wire shape needs* and the call sites pass whatever fields they have locally, with non-trivial transforms (the `?? "claude"` fallback discussed in P2-Fowler-1) ideally absorbed inside the helper. PR #68 is a positive example modulo the P2-Fowler-1 refinement.

---

## Things I deliberately did NOT flag

- Helper file size (59 lines) and location (next to `session-types.ts`) — these are correct. Narrow, single-purpose, documents its three callers.
- `BrowserGroupRecord` placed in `session-types.ts` — correct per AP-3 (writer + reader co-located).
- `coordinator.listAll()` returning a fresh array via `Array.from(this.groups.values())` — correct snapshot semantics; the JSDoc explicitly documents non-isolation from later mutations is NOT a concern because the caller iterates synchronously.
- `hydrateGroups` empty-input + no-mutation short-circuits — correctly avoids spurious re-renders; this is good Zustand discipline.
- The orchestrator's existing 3353-line god-module — pre-dates this PR; +45 lines is not the place to surface that smell. Out of scope.
