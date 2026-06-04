# Fowler — Refactoring Review (2nd pass, post-burndown)

PR: feat/dynamic-claude-models (burndown commit `9d922c0`)
Scope: `anthropic-models-cache.ts` (helper extraction + module-scope warn flag),
`settings-slice.ts` (`anthropicModel` sticky + "soft-rejected" status),
`ModelSwitcher.tsx` (wrapper > listbox + sibling footnote restructure, `wasOpenRef`).

Economic test re-applied: "Did the burndown's structural changes pay their way,
or did they buy P1/P2 closes by softening cohesion?"

---

## Verification of prior verdict

First-pass findings 1-3 (all P3) were left as opportunistic follow-ups — none
re-flagged here. AP-16 (1221-LOC file justified by AP-3 co-location) still
holds: the new helper `resolveCoalescedSignal` is co-located inside the same
file, no extraction across the AP-3 boundary occurred. AP-14 single-assembly
discipline is untouched (no wire shape changed). The first review's
non-flagged items remain non-flagged.

---

## Summary

Two new structural findings from the burndown. Both P3. The burndown is
materially clean on the refactoring axis — its helper extractions are cohesion-
preserving, the slice extension is documented, the DOM restructure pulls a
phantom-option out of `role="listbox"` (a structural improvement, not a softening).
The two findings are about (i) the slice header now lying MORE than before
because the new sticky field IS a server-authoritative setting but the JSDoc
still calls out the older `dynamicBackendModels` divergence without folding
the new field into the "true to its name" body, and (ii) "soft-rejected"
status semantics overload one enum value with two distinct meanings.

The structural questions the prompt raises split as follows:

- **AP-3 hold?** Yes. `resolveCoalescedSignal` is a 17-line private helper
  inside the same file, co-located with the fetch boundary it serves. Module-
  scope `signalCoalesceDegradeLogged` flag + the `__reset…ForTests` companion
  follow the existing convention floor for test-only escape hatches
  (`__resetMemoryCacheForTests`, `__resetInflightForTests`,
  `__resetBackendModelInflightForTests`). No new module boundary; no extraction
  across the AP-3 seam.
- **AP-14 hold?** Yes — the burndown touched neither the wire-shape assembly
  nor the producer set. Untouched.
- **AP-16 hold?** Yes — the file is now ~1281 LOC (a +60 delta from helper
  extraction + JSDoc); the cohesion axis is unchanged. Not re-flagged.
- **"Soft-rejected" — clean discriminated-union extension?** No, see Finding 1.
- **`wasOpenRef` — React-idiomatic?** Yes, see Items NOT flagged.
- **Slice JSDoc drift?** Yes, see Finding 2.

---

## Finding 1

- **Title:** `dynamicBackendModelsStatus: "rejected"` now overloads TWO
  semantically distinct outcomes (data-bearing + data-empty) — consumer cannot
  distinguish them without a second slice read
- **File:** `web/src/store/settings-slice.ts:281-302` (the soft-rejected
  branch) + `web/src/store/settings-slice.ts:58` (the enum declaration) +
  `web/src/components/ModelSwitcher.tsx:52-53` (the consumer fallback chain)
- **Principle:** Principle 4 — Names reveal design; Principle 6 — Missing
  boundaries where they matter
- **Severity:** P3
- **What's wrong:** The burndown fixed P2 #9 (inflight clobber) by introducing
  a defensive branch: if `dynamicBackendModels[backend]` already has data when
  the rejection lands, "leave the data intact, flip status to `rejected`."
  The JSDoc on the inner branch coins this as "soft-rejected" — preserves
  last-known data while signalling a failed refresh.

  The problem: `DynamicModelsStatus` is declared as a flat 4-value enum
  `"idle" | "pending" | "resolved" | "rejected"`, and `"rejected"` is now
  consumed by TWO distinct states:

    (a) `status="rejected"` + `dynamicBackendModels[b] === undefined`
        — hard reject (no data ever produced, fall back to static).
    (b) `status="rejected"` + `dynamicBackendModels[b] !== undefined`
        — soft reject (stale-but-good data preserved from prior success).

  A consumer that reads `selectDynamicBackendModelsStatus(s, "claude")` alone
  cannot distinguish "show error banner, fall back to static" from "show stale
  data + 'could not refresh' inline hint, KEEP the list rendered." It has to
  ALSO read `selectDynamicBackendModels(s, "claude")` and combine the two —
  the discriminated-union invariant that the status enum encodes the outcome
  has been broken at the type-system layer. The slice JSDoc on the action
  documents the trade-off verbally; the type system does not.

  This is the same shape as the inflight-token guard the same burndown JUST
  closed (P2 #9): "what looks like one state in the type system is actually
  two states the reader must demultiplex from a second field." First the
  token, now the data-presence — recurring class.

- **Consequence:** The first consumer who tries to add a "could not reach
  Anthropic — showing last-known list" inline hint will discover they cannot
  write `if (status === "rejected") show banner` because that branch ALSO
  fires for the cold-rejected case where they should fall back to static + a
  DIFFERENT banner ("no Claude models available"). They will pull the
  data-presence check inline at the call site, and the next consumer will do
  it again — Shotgun Surgery for a logical state already known to the slice.
  The next 1-2 model-list features (manual refresh button, periodic poll)
  will compound this.
- **Fix:** Extend the enum to make the distinction first-class. Either:
  (i) Replace `"rejected"` with `"rejected-empty"` + `"rejected-stale"` so a
  discriminated-union match on the status exhaustively names both outcomes;
  the inflight branch already has the data-presence check, just emit the
  right variant directly. (ii) Keep the single `"rejected"` value but expose
  a derived selector `selectDynamicBackendModelsViewState(s, backend)` that
  returns `"loading" | "ready" | "stale" | "empty"` — one read, one source
  of truth for the consumer. Either closes the implicit second-read tax.

---

## Finding 2

- **Title:** Slice JSDoc header still claims "server-authoritative settings
  facts only" — the burndown ADDED a server-derived non-setting (`anthropicModel`
  IS a setting, but the header was already telling a half-truth about
  `dynamicBackendModels`) and did NOT update the header invariant
- **File:** `web/src/store/settings-slice.ts:1-21` (the file header JSDoc)
  vs `:88-105` (the `dynamicBackendModels` JSDoc that acknowledges the
  divergence inline)
- **Principle:** Principle 4 — Names reveal design (the header is the file's
  "name" at the documentation layer); Principle 6 — Missing boundaries where
  they matter (the boundary the header asserts no longer matches the slice's
  actual contents)
- **Severity:** P3
- **What's wrong:** The first review's Finding 2 flagged the slice header
  lie about `dynamicBackendModels` not being a "setting." The burndown left
  that header text untouched ("Holds only flags the server owns — fields the
  SettingsPage form input is 'the truth of' stay as component-local draft
  state") and added `anthropicModel: string | null` as a new field.

  `anthropicModel` IS a server-authoritative setting (it's the user's saved
  preference, mirrored from `GET /api/settings`), so it fits the header's
  stated invariant. But the header now ALSO doesn't reflect that the slice
  holds two distinct concern-classes — server-authoritative flags AND a
  server-derived dynamic cache. The inline field JSDoc on
  `dynamicBackendModels` acknowledges the divergence (`"stretches the
  'server-authoritative settings facts only' invariant the slice header
  documents"`); the slice header itself is unchanged.

  This is documentation-debt-by-omission. The first review treated it as
  watchpoint (PLAN parked Fowler R4); the burndown had a free moment to
  either (i) split the slice (PLAN's parked move) or (ii) update the header
  to truthfully describe the now-widened scope. Neither happened. The header
  now lies MORE than before, because a casual reader will note "Holds only
  flags" + see `anthropicModel: string | null` and assume `string` IS one of
  those flags — then encounter `dynamicBackendModels` and have no warning
  that this slice also carries a cache.

  This is the `feedback_council_documented_contract_canary` pattern from
  the project memory: JSDoc invariants ARE doku, not enforcement — but
  when the invariant is structurally false, the docu shape itself becomes
  a drift footgun. The slice's NAME (`settings-slice`) ties up with the
  HEADER (`server-authoritative settings facts only`); both are subtly
  out-of-sync with the BODY (cache + status + inflight machinery).

- **Consequence:** Future contributor reads the header, sees "settings
  only," interprets `dynamicBackendModels` as "must be a setting since it's
  in settings-slice," extends the slice further along that mistaken axis
  (e.g., adds Codex-model-list lifecycle + per-tier-default state + a
  manual-refresh action). Each addition compounds the divergence; the
  slice grows past the point where extraction is structurally cheap. This
  is exactly the trajectory the first review's Finding 2 named as the
  cost path.
- **Fix:** Two cheap options, either acceptable:
  (i) Update the slice header to truthfully describe the two concern
  classes: "Holds (a) server-authoritative flags + sticky settings the
  server mirrors back, (b) the dynamic per-backend model-list cache and
  its fetch lifecycle. See per-field JSDoc for the boundary between
  the two." 4 lines, no behaviour change, header stops lying. (ii) Spin
  out `backend-models-slice.ts` now (the first review's recommendation
  remains valid; the burndown made it cheaper because the new
  `anthropicModel` field clearly belongs in `settings-slice` proper —
  the seam between the two concerns is even more obvious now).

  (i) is the minimum honest move; (ii) is the structural close. Either
  closes the documentation/code drift.

---

## Items NOT flagged (and why)

- **`wasOpenRef` as ref-based open-edge tracker** — React-idiomatic. The
  pattern is the canonical "previous value" idiom for effects that need to
  fire on a state EDGE rather than every render-while-the-state-is-true.
  The alternative ("fire on every render, idempotently") is worse because
  the autofocus call is NOT idempotent (it steals focus from a user who
  Tab'd away while the dropdown was open). `wasOpenRef` is the right tool;
  the inline JSDoc explicitly names the edge-trigger reason. Not a smell.
- **`resolveCoalescedSignal` indirection** — 17-line private helper, single
  call site, kept in-file. Extracted because the original inline ternary
  had grown two concerns (capability detect + degrade warn). The extraction
  is cohesion-preserving (still operates on AbortSignal pair, still inside
  the fetch boundary's lexical scope) and the new test surface for it is
  cleaner. Fowler R3 (extract method) without violating AP-3.
- **`signalCoalesceDegradeLogged` module-scope flag** — same pattern as the
  existing module-scope state in this file (memory cache, inflight map),
  same `__reset…ForTests` companion shape. Convention floor honoured.
  Process-lifetime persistence is correct for the "warn-once-per-process"
  semantics. Not a smell.
- **DOM restructure (`wrapper > listbox + sibling footnote`)** — structural
  IMPROVEMENT, not a regression: pulls the footnote OUT of `role="listbox"`
  so it's not iterated as a phantom option. The wrapper is the natural
  enclosing element. JSX comment explicitly names the reason. Clean.
- **`anthropicModel: string | null` as a slice field** — IS a server-
  authoritative setting (user's saved preference). Belongs in the slice
  per the slice's TRUE scope (modulo the header drift in Finding 2 above).
  The `selectAnthropicModel` selector follows the existing narrow-selector
  convention. Clean addition; the seam from `dynamicBackendModels` (which
  ISN'T a setting) is unaffected.
- **`hydrateSettings` extension for `anthropicModel`** — accepts both
  `string` and `null` (explicit clear), rejects other types. Follows the
  existing forward-compat pattern (`typeof payload.x === "boolean" ? : s.x`)
  with the right widening for nullable string. Clean.
- **First review's three P3s** — verified still applicable / still
  unaddressed (Codex inline vs Claude module parallelism; slice
  scope-lie partial repeat in Finding 2; `tierOf` client/server
  duplication). The burndown did not touch any of these surfaces and did
  not regress them. Not re-raised at higher severity.
- **`require("node:fs")` in `__deleteDiskCacheForTests`** — first review's
  Beck convention floor (EC-40 added in Phase 7). Still inline-eslint-
  disabled; the burndown did not fix it but the project floor parked it
  with the convention addition. Not re-flagging.

---

## Verdict

The burndown is structurally clean on the refactoring axis. The two new
findings are both P3 and both about documentation/type-system drift, not
about code-shape regressions. The helper extractions preserved cohesion;
the DOM restructure improved structure; `wasOpenRef` is idiomatic.

If forced to pick ONE structural change to do before merge: Finding 2's
slice header update (option (i)). Four-line JSDoc edit, no behaviour
change, stops the header from lying about its own contents. Finding 1
(soft-rejected enum overload) is more impactful in the long run but the
fix is more invasive — defer to the same iteration that addresses the
first review's Finding 2 (slice split / view-state derivation).

AP-3 and AP-14 held perfectly through the burndown. AP-16 held — the
file is now slightly larger, the cohesion is unchanged, do not re-flag.
The first review's P3 cluster remains the right next-iteration target.
