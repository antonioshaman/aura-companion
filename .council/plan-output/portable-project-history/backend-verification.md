# Backend Tasks 1–3 independent verification

Read-only verification of plan/spec, transforms, schema, store, route tests/auth integration, SessionStore export inventory, production DI registration and actual pickup setter. No implementation or test files edited. Targeted command: `cd web && bun run test server/portable-history.test.ts server/portable-history-store.test.ts server/routes/portable-history-routes.test.ts server/routes/portable-history-auth.test.ts` — 4 files / 24 tests passed.

## Actionable reproduced finding

**P2 — Accepted binary import can become unreadable and break the archive inventory (AC4, AC5).** `web/server/portable-history.ts:83` permits 10,000 exclusions, then line 114 appends the mandatory binary warning without rechecking count. An archive with an embedded attachment, 10,000 short exclusion entries and no exact binary warning is accepted and persisted with 10,001 exclusions. `PortableHistoryStore.get()` revalidates that result and rejects it; `list()` also rejects the entire inventory because it reads every archive without isolation. A normal successful import thus leaves the feature unable to list archives.

Deterministic Bun reproduction used actual store in a cleaned temporary directory: create one assistant image block `{type:"image",source:{type:"base64",media_type:"image/png",data:"YQ=="}}`; replace exclusions with `Array.from({length:10000},(_,i)=>"note "+i)`; call `store.import(archive)`, `store.get(id)`, `store.list()`. Observed output:

```
import false
get rejects Archive exceeds the published size, count or nesting limits.
list rejects Archive exceeds the published size, count or nesting limits.
```

Fix by validating the final normalized/redacted archive against all structural limits before commit, including the mandatory warning, or by reserving warning capacity and rejecting the original import atomically. Regression must exercise import→get/new store/list at this exact boundary and assert either readable successful import or precommit rejection with prior data unchanged. Mere total-byte recheck is insufficient: normalization can add an exclusion/node.

## Limits

No other actionable finding reproduced. This is backend-only internal verification, not formal Council review or release approval. UI, external resource behavior in a real browser, landing and live Claude/Codex execution were outside this pass. Existing route tests use CLI creation boundary doubles; actual `setPickupDraft` was inspected and only persists/broadcasts a draft. Existing tests cover count/depth rejection partially; passing 24 tests does not establish exhaustive combinatorial boundary coverage.
