# Hunt — Security findings, PR #68 (`feat/council-mode-bootstrap-rest`)

Scope: `web/server/routes.ts` (new `GET /api/groups`), `web/server/session-orchestrator.ts` (`getAllGroupsForBootstrap`), `web/server/browser-group-record.ts` (shared wire-shape helper).

The new endpoint is read-only, takes no parameters, is mounted under the existing `/api/*` auth gate, and projects the coordinator's `GroupRecord` set through a structural helper whose output is the four pair-identity fields, the live `status`, and the wake-timeout bound — no `cliSessionId`, no PID, no observer prompt hash, no workspace path, no `createdAt`, no cycle/convergence telemetry, no internal coordinator state. The auth verification at `web/server/routes.ts:155-175` is declared above the new route at line 481 in the same `api` Hono instance, so the route inherits the `Authorization: Bearer` + cookie + localhost-bypass model that every other authenticated route uses. No new auth surface, no new parameter surface, no new logging surface.

Below is the one forward-looking note worth recording per the prompt's "flag any pattern that would break if multi-tenant were introduced" instruction. Nothing rises to P1 or P2.

---

## F1 — Snapshot helper is tenant-blind by construction (forward-looking)

**Severity:** P3
**File:** `web/server/session-orchestrator.ts:2972-2991` (`getAllGroupsForBootstrap`) + `web/server/session-group-coordinator.ts:498-504` (`listAll`).

**Finding.** The new bootstrap path returns every live group the coordinator currently tracks across the entire process — `coordinator.listAll()` is unqualified, and `getAllGroupsForBootstrap` filters only by `status !== "archived"`, never by caller identity. This is correct under Aura's current single-tenant contract (one bearer token equals full operator access, same posture as `GET /api/sessions` enumerating all sessions), and the brief explicitly flags this as the operating assumption.

**Consequence.** If Aura ever ships a multi-operator deployment (or a Cursor-Cloud-style shared-host pattern where one server fronts several owners), this endpoint and `listAll()` become the structural blast-radius site: a compromised or curious operator-A token would enumerate operator-B's Council pair sessionGroupIds, pair-member sessionIds, pairing labels, and live degradation status — the metadata an attacker would use to plan a lateral pivot via the pair's `.council/` filesystem channel.

**Fix.** Document the single-tenant assumption inline as a `// SINGLE-TENANT INVARIANT:` comment at the top of `getAllGroupsForBootstrap` and at `listAll` — the comment is the prompt that a future multi-tenant PR cannot miss. When/if multi-tenant lands, the boundary is `getAllGroupsForBootstrap(callerIdentity)` filtering against a `GroupRecord.ownerId` field added to the coordinator; the route handler at `routes.ts:498` reads the identity off the auth context and passes it down. Cost today: one comment per call site. Cost deferred: a forensic enumeration disclosure on the first multi-tenant release that forgets to retrofit the filter.

---

## F2 — `deadRole` declared on the wire interface but never populated by the helper

**Severity:** P3 (correctness, not security; noted because it shows on the wire-shape surface assigned to Hunt)
**File:** `web/server/session-types.ts:577` (`BrowserGroupRecord.deadRole?`) + `web/server/browser-group-record.ts:51-58` (`buildBrowserGroupRecord` return literal).

**Finding.** The `BrowserGroupRecord` interface declares an optional `deadRole?: SessionGroupRole` field, but `buildBrowserGroupRecord` does not populate it — neither the live `group:created` listener, nor `getAllGroupsForBootstrap`, nor the ws-bridge synthetic hydration ever assigns it, and the underlying `GroupRecord` does not carry it either. The context brief already flags this as out-of-PR-68-scope (the deadRole-gap carry-forward), so this is informational rather than a regression.

**Consequence.** Strictly a correctness/UX issue, not a security one: a browser reloading mid-`degraded` pair sees `status: "degraded"` but no role attribution, so the frontend deriver falls back to `?? "observer"` and may mislabel the dead half in the panel header. No information disclosure, no auth implication.

**Fix.** Out of scope for this PR per the brief. When addressed, the field flows from `GroupRecord` (added at the state-machine layer when the degraded transition fires) through `buildBrowserGroupRecord` (one new optional input field, conditionally spread into the return literal). No security work required at that time.

---

## Summary

- F1 (P3) — single-tenant invariant load-bearing for snapshot helper; document the assumption inline so a future multi-tenant PR cannot land without a tenant filter.
- F2 (P3) — `deadRole` declared on wire but never populated; correctness gap acknowledged in the context brief, no security implication.

No P1 or P2 findings. The keystone refactor (single `buildBrowserGroupRecord` construction site across three producers) is itself a security-positive change: drift between push, REST bootstrap, and ws-bridge hydration can no longer accidentally leak a new field added to `GroupRecord` because the helper's output is a typed structural literal — every new internal field is explicitly opt-in at the wire boundary, not opt-out.
