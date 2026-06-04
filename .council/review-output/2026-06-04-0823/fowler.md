# Fowler — Refactoring Review

PR: feat/dynamic-claude-models (fdf88e0)
Scope: `anthropic-models-cache.ts` (1221 LOC), `routes.ts` Claude branch,
`settings-slice.ts`, `utils/backends.ts`, `ModelSwitcher.tsx`.

Economic test applied: "Will this slow us down in the next few months?"

---

## Summary

Three structural findings. None at P1.

The 1221 LOC headline for `anthropic-models-cache.ts` is misleading once
measured: ~523 lines JSDoc + ~95 blank + ~603 actual code. AP-3
(writer+reader+parser+orchestrator+fetch co-located) justifies the file
budget. The module reads top-to-bottom as one sequential cache pipeline,
sections cleanly demarcated by header comments. Cohesion is intact — every
exported function operates on `CachedModelsRecord` or its primitives.
**Not flagging the file-size axis.**

The structural questions the brief raises split as follows:

- **AP-3 hold?** Yes. See above.
- **`settings-slice` invariant softened?** Yes, but the slice's own
  JSDoc has been updated to document the divergence and PLAN parked a
  follow-up split. The current shape pays its way (refetch trigger
  naturally fires off Settings save which the slice already owns). The
  divergence is documented, not silent. Watchpoint, not finding.
- **`pickSessionDefaultModel` widening avoided?** Yes — `getDefaultModel`
  is untouched. New helper composes rather than widening. Clean R3.
- **Codex/Claude parallel-path drift?** Yes, see Finding 1.

---

## Finding 1

- **Title:** Codex models branch in `routes.ts` and the new Claude module
  have grown into parallel-but-drifting paths
- **File:** `web/server/routes.ts:1532-1561` (Codex inline) vs
  `web/server/anthropic-models-cache.ts` (Claude module)
- **Principle:** Principle 5 — Shotgun Surgery (cross-cutting changes
  require edits in two places) and Principle 4 — Names reveal design
- **Severity:** P3
- **What's wrong:** PLAN parked the Fowler R4 "fold Codex into a shared
  `backend-models-cache.ts`" stretch goal as "speculative generality"
  because the two backends read from genuinely different sources (Codex
  reads a CLI-managed file; Claude fetches HTTPS). That reasoning held at
  plan time. But after this PR, three properties HAVE leaked into both
  paths and are now structurally shared:

    (a) Both return `{ value, label, description }` triplets.
    (b) Both sort server-side (Codex by `priority`; Claude by tier +
        created_at + version).
    (c) Both emit a 404 envelope on "no cache" semantics.

  The Claude branch's `BackendModelInfo` type even has a server-side
  mirror, but the Codex inline read constructs the same shape ad-hoc with
  no shared type reference. A future change to the wire shape (add
  `deprecated: boolean`, add `pricing: ...`) is now a TWO-file edit:
  Codex inline + Claude module. The Codex literal in `routes.ts:1553-1557`
  silently has no per-item shape validation; the Claude path is strict.
  Drift is structurally invited.

- **Consequence:** First time someone adds a wire-shape field, they will
  almost certainly update the Claude module (where the type lives) and
  forget the Codex inline branch (where the same shape is open-coded).
  Frontend `toModelOptions` will then see asymmetric inputs at runtime
  without a type-system tripwire. Cost: 1-2 review cycles per field add,
  small but compounding.
- **Fix:** Do NOT fold the two backends into one module yet — PLAN's
  reasoning still holds for the data-source asymmetry. Cheaper fix:
  (i) Promote `BackendModelInfo` to a shared location (or just import it
  from `anthropic-models-cache.ts` into `routes.ts`) and use it as the
  return-type annotation of the Codex literal. (ii) Add a one-line
  `satisfies BackendModelInfo[]` on the Codex `.map(...)` result.
  That is the minimum structural tripwire that makes wire-shape drift a
  typecheck error rather than a runtime mystery. Defer the full extract
  until a third backend or a shared lifecycle concern appears.

---

## Finding 2

- **Title:** `dynamicBackendModels` colocation in `settings-slice`
  weakens the slice's stated invariant; status-vs-data fanout multiplies
  the consequence
- **File:** `web/src/store/settings-slice.ts:30-90`
- **Principle:** Principle 4 — Names reveal design; Principle 6 —
  Missing boundaries where they matter
- **Severity:** P3
- **What's wrong:** The slice header still reads "Server-authoritative
  settings facts surfaced as a single source of truth. Holds only flags
  the server owns." The slice now ALSO holds a server-derived cache that
  is not a "setting" in any user-facing sense — `dynamicBackendModels`
  + `dynamicBackendModelsStatus` + `loadBackendModels` action +
  per-backend module-scope inflight counters + `__resetBackendModelInflightForTests`
  test escape. That is a complete second concern with its own lifecycle
  (status enum, inflight token guard, fetch trigger, silent rejection),
  and the JSDoc on `dynamicBackendModels` openly acknowledges this
  ("stretches the 'server-authoritative settings facts only' invariant").

  The name `settings-slice` now lies about what lives inside it.
  Concretely: when a new contributor goes hunting for "where does the
  model list cache live", `settings-slice` is not the first place they
  look. When someone adds a new selector to the slice, they have to
  visually parse which section to extend. That is the Carmack "hiding
  state that will surprise someone" test — it surprises mildly today,
  will surprise more as the slice grows.

  The PLAN's defence ("refetch fires off Settings save, which the slice
  already owns") is real but not unique to this slice — the save handler
  could dispatch into a separate `backendModelsSlice.loadBackendModels(...)`
  call just as easily.

- **Consequence:** Discoverability tax compounds: every new model-list
  feature (manual refresh button, periodic poll, "Codex fetch broke"
  inline hint) adds another concept to a slice whose name says it
  doesn't host them. Within a few months, the slice will be ~500 LOC
  with two concerns sharing one file because the seam was never drawn.
- **Fix:** Spin out `web/src/store/backend-models-slice.ts` now while the
  surface is exactly 3 fields + 1 action + 1 test reset. Cost: ~50 LOC
  move + 3-4 import sites updated + 2-3 test file imports. Pay-off: the
  invariant in `settings-slice` header becomes true again, future
  lifecycle additions land in an obviously-named file. Confirmed cheap
  by inspection — `loadBackendModels` has zero dependencies on existing
  settings-slice state (no shared `set` cross-reads). This is exactly
  the kind of "draw the boundary while it's free" move Fowler treats as
  high-leverage. The PLAN parked this on R4 grounds; the case for
  un-parking is that the slice JSDoc itself flags the divergence — the
  team already feels the smell.

---

## Finding 3

- **Title:** `tierOf` duplicated between client `ModelSwitcher.tsx` and
  server `anthropic-models-cache.ts` — drift risk on tier vocabulary
- **File:** `web/src/components/ModelSwitcher.tsx:15-20` (client `tierOf`)
  vs `web/server/anthropic-models-cache.ts:404-409` (server `tierRankOf`)
- **Principle:** Principle 4 — Inconsistent vocabulary across modules;
  Principle 5 — Shotgun surgery
- **Severity:** P3
- **What's wrong:** The same conceptual operation (extract tier from a
  Claude model id) is implemented twice with different signatures and
  different return types:

  - Server: `tierRankOf(id) → number` (0|1|2|99), used for sort.
  - Client: `tierOf(value) → "opus" | "sonnet" | "haiku" | "unknown"`,
    used for "Latest" badge per tier.

  Both use the same heuristic (`id.includes("opus")` etc.). Both share
  the same correctness anchor: if Anthropic ever ships
  `claude-opus-sonnet-fusion` (or any composite naming), BOTH paths
  silently classify it as `opus` because `.includes()` short-circuits.
  The client and server will agree by accident, not by design — but if
  one is fixed (e.g., switch to regex `^claude-(opus|sonnet|haiku)-`)
  and the other forgotten, badge tier and sort tier disagree silently
  for the bad row.

  The client's `latestPerTier` Set is derived FROM the server-sorted
  list, so the contract is "first-of-each-tier in the server's sort
  IS the latest of that tier" — the client tier function is a literal
  re-implementation of the server's tier function, used only to detect
  tier transitions in an already-sorted list.

- **Consequence:** Low individual-edit cost (both functions are
  trivial), but the structural invariant "client's tier classifier
  must agree with server's tier classifier" is hidden. If anyone ever
  edits one without the other (perfectly plausible — they live in
  different files, different layers, different review surfaces), the
  Latest badge silently lies. The 2-call-site pattern of "implement
  same thing twice in different layers" is exactly the family
  CLAUDE.md (`feedback_symmetric_path_missing_transformation.md`)
  flags as Aura's recurring bug class.
- **Fix:** Two cheap options, either acceptable:
  (i) Server emits `tier` field alongside `value/label/description` —
  client reads it directly, never re-classifies. Adds one string per
  model row on the wire (~50 bytes total). Eliminates the duplication
  permanently. This is the "shared types catch shape, not function"
  remedy from `feedback_symmetric_path_missing_transformation.md`.
  (ii) Client detects tier transitions by comparing adjacent entries
  in the sorted list rather than classifying each entry independently
  — "first entry, OR previous entry's tier-prefix differs from this
  one's tier-prefix". Equivalent observable behaviour, zero tier
  classifier on the client side. Requires no wire change.

  (i) is more honest to the architecture; (ii) is smaller. Either
  closes the drift seam.

---

## Items NOT flagged (and why)

- **1221 LOC in `anthropic-models-cache.ts`** — 603 lines of code under
  AP-3 co-location. Reads top-to-bottom as one pipeline. No god-module
  smell.
- **In-memory `memoryCache` module global** — context-brief notes
  single-tenant single-process. Module-scope is correct for the
  intended deployment shape. EC-7 bounds + fingerprint-keying contain
  the cross-request leak path. Not a structural debt.
- **Inflight-token module-scope counter in `settings-slice`** — same
  reasoning: single-process scope, documented intent.
- **Synthetic fixture** — Beck/Backend territory, not refactoring.
- **`__deleteDiskCacheForTests` `require("node:fs")`** — test-only
  escape hatch hygiene is Beck/Backend territory.
- **Sticky-vs-dynamic[0] precedence not wired through HomePage /
  CronManager** — PLAN Risks & Watchpoints already parked. Not
  re-flagged per brief instruction.
- **APG keyboard `queueMicrotask` focus** — a11y / React-frontend
  territory, not refactoring.

---

## Verdict

This PR is structurally cleaner than the average Aura feature delivery.
The two true smells (parallel Codex/Claude paths and slice-name lie) are
both P3 — pay them down opportunistically in the next iteration on this
area; do not block this PR. The tier-vocabulary duplication is the most
likely future-bug surface but is also P3 because both copies are
currently correct and the test surface for the badge would surface
disagreement before users notice.

If forced to pick one structural change to do BEFORE merge: Finding 1's
`satisfies BackendModelInfo[]` annotation on the Codex inline branch.
Five-line edit, closes a future drift seam at typecheck time, costs no
runtime. Everything else can ship in a follow-up.
