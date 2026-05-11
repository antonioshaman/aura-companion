# Fowler — Structural Review (Council Mode, Phase A+B+C)

Lens: refactoring economics — will this slow us down in weeks, not months?
Scope: 11 source modules under `web/server/` + 1 SessionState extension.

---

## F1 — 11 new top-level files in an already 187-file `web/server/` flat directory
- **File:** all 11 new modules at `web/server/*.ts`
- **Principle:** P6 Architecture earns its boundaries (missing boundary)
- **Severity:** P2
- **What's wrong:** `web/server/` already mixes 187 files at the root and has subdirectories for cohesive concerns (`routes/`, `middleware/`, `recording-hub/`, `protocol/`). The Council Mode feature ships 11 new files (atomic-write, checkpoint-watcher, council-types, group-state-machine, session-group-coordinator, group-authorization, group-reconciliation, observer-write-policy, observer-permissions, backend-provider, codex-envelope) that share a single feature seam and prefix family but get dropped at root next to unrelated agent / cron / claude-* modules.
- **Consequence:** Phase D wiring + Phase F UI will add more files at the same level; "where does the council-mode logic live" becomes a grep exercise instead of a directory pointer; refactors lose a natural rename surface.
- **Fix:** Move the 11 files (and their `.test.ts`) under `web/server/council/` (or `web/server/session-group/`) before Phase D wires them up — relocation now is one PR; relocation after callers across cli-launcher / ws-bridge / routes import them is a fan-out edit.

---

## F2 — `groupId` shape encoded in two places, drift surface
- **File:** `session-group-coordinator.ts:12-14` (`grp_` + `randomBytes(16).toString("hex")`); `group-authorization.ts:29-33` (`GROUP_ID_PATTERN = /^grp_[a-f0-9]{32}$/`, plus `length === 36`)
- **Principle:** P5 Duplication of knowledge (Shotgun Surgery candidate)
- **Severity:** P2
- **What's wrong:** The producer (`generateGroupId`) and the validator (`isWellFormedGroupId`) independently know the same three facts: prefix is `grp_`, suffix is 32 lowercase hex chars, total length is 36. Changing entropy or prefix means editing both files and remembering the `length === 36` literal. The producer also lives inside the coordinator, not the type module — so callers who need to check shape import from `group-authorization` while callers who mint IDs reach into the coordinator.
- **Consequence:** First time someone widens the ID (e.g. 24-byte entropy, base32, a `cg_` prefix for a new "council-group" variant), the validator silently rejects legitimate IDs and the failure surfaces as 404s — not a typecheck error.
- **Fix:** Hoist `generateGroupId` + `isWellFormedGroupId` + the length constant into a single tiny module (e.g. `council/group-id.ts`) so the regex, the length, and the random-byte count are co-located. One source of truth.

---

## F3 — Inconsistent vocabulary: `council-*` vs `group-*` vs `session-group-*` for one concept
- **File:** `council-types.ts`, `group-state-machine.ts`, `group-authorization.ts`, `group-reconciliation.ts`, `session-group-coordinator.ts`, `observer-*`, `backend-provider.ts`
- **Principle:** P4 Names reveal design (inconsistent vocabulary across modules)
- **Severity:** P3
- **What's wrong:** The same domain object surfaces as "council artifact" in `council-types.ts`, "group" in `group-state-machine.ts` / `group-authorization.ts` / `group-reconciliation.ts`, "session group" in `session-group-coordinator.ts` and SessionState fields (`sessionGroupId`, `sessionGroupRole`), and "pairing" in `backend-provider.ts`. The type itself is `GroupRecord` but its field is `sessionGroupId`. A new reader has to learn the synonym set before they can navigate.
- **Consequence:** Search for one term misses two-thirds of the call sites; PR descriptions and commit messages drift between three names for one thing; onboarding cost compounds with each phase.
- **Fix:** Pick one root noun (likely `sessionGroup` — it's the one already in SessionState and the coordinator class name) and rename the module prefixes + types to match. Doing this once now, before Phase D imports stabilise, is cheap.

---

## F4 — `backend-provider.ts` is a manifest pretending to be a seam
- **File:** `backend-provider.ts:11-14` (`BackendProvider` interface with only `backendType` + `binaryName`)
- **Principle:** P5 Speculative generality
- **Severity:** P2
- **What's wrong:** The interface advertises itself as the "seam over the two CLI backends" but exposes only two read-only strings — exactly the information `BackendType` (a string union) already conveys. The promised migration (replace `if (backendType === "codex")` branches in `cli-launcher.ts`) is honestly logged as deferred, but the current shape gives the appearance of an adapter while delivering a typed constant. `SUPPORTED_PAIRINGS` is the only real value here, and it has nothing to do with the `BackendProvider` interface — it's a separate concept bundled into the same file.
- **Consequence:** Future readers will plumb their new branch through `BackendProvider` to "respect the seam" and discover the interface is empty, then either (a) widen the interface speculatively, or (b) bypass it. Either path leaves the abstraction in a worse state than before.
- **Fix:** Until the cli-launcher migration lands, demote `BackendProvider` to a comment + `BackendType` re-export, and split `SUPPORTED_PAIRINGS` + `isSupportedPairing` into their own `council/pairings.ts` (or sibling) file. When the real adapter arrives, introduce the interface alongside the first method that actually differs by backend.

---

## F5 — `archiveGroup` swallows kill failures silently
- **File:** `session-group-coordinator.ts:153-162`
- **Principle:** P2 Functions that lie about side effects (mutation hidden)
- **Severity:** P2
- **What's wrong:** Both `kill` calls are wrapped in empty `catch { /* swallow */ }` with no log, no diagnostic, no signal to the caller. The method then returns `true` regardless. The state machine has already transitioned to `archived`, so a kill failure leaves a "ghost" subprocess running with no in-memory record and no error telemetry. The matching swallow in `createGroup`'s rollback (line 124-127) is justified by the comment ("preserves the original error") — these two are not.
- **Consequence:** A kill returning an error (permission, ESRCH, race with reconnection) becomes invisible — the orphan survives until OS or operator notices. Hunt or subprocess-lifecycle reviewer will flag this from a different angle, but structurally the function lies about whether it completed its job.
- **Fix:** Either return a richer result (e.g. `{ ok: true, killErrors?: Error[] }`) or surface kill failures through the `onDropped`-style optional logger injected at construction time. "Best-effort sequential kill" must still report what didn't go best.

---

## F6 — `parseLineRange` returns dual-meaning `undefined`
- **File:** `council-types.ts:85-93` + caller at `council-types.ts:160-161`
- **Principle:** P4 Names reveal design (function lies about return semantics)
- **Severity:** P3
- **What's wrong:** `parseLineRange` returns `undefined` for both "no input — that's fine, the field is optional" and "input was malformed — reject it". The caller then has to disambiguate with `if (f.evidence_lines !== undefined && lines === undefined) return null;` — a check that re-reads the raw field to recover the distinction the parse function erased. Drift-prone: a future maintainer who tightens `parseLineRange` to also return `undefined` for `null` input could silently regress validation.
- **Consequence:** The validator's "return null on any failure" discipline (a strong property elsewhere in this file) is breached locally; a single-line edit by a future reader could turn a strict rejection into a silent accept.
- **Fix:** Return a discriminated result (e.g. `{ ok: true, value } | { ok: false } | { ok: true, value: undefined }` for "absent") OR keep returning `[number, number] | undefined` but pre-check `v === undefined` at the call site and pass only present values to a non-optional inner parser. Either way, one signal carries one meaning.

---

## F7 — Validator return-null discipline (council-types + codex-envelope) — clean
- **File:** `council-types.ts:102-178`, `codex-envelope.ts:54-105`
- **Principle:** P2 Extract pure logic, keep mutations visible
- **Severity:** No finding
- **What's wrong:** Nothing. Both validators are pure, never throw, and consistently funnel every failure path through `return null`. Caller branches are exhaustive over the discriminated unions. This is the right shape for a cross-process contract and the consistency between the two files is doing real work.
- **Consequence:** N/A.
- **Fix:** N/A — keep this pattern as the model for future Phase D/E validators.

---

## F8 — Observer allow/deny redundancy: pattern worth its keep
- **File:** `observer-permissions.ts:25-87`
- **Principle:** P5 Smells that compound (anti-finding — duplication that earns its existence)
- **Severity:** No finding
- **What's wrong:** Nothing. The allow + deny lists with `assertObserverToolPolicyConsistent` boot-time check is a documented static-grep canary against accidental widening. Six explicit deny names + a boot assertion is cheap insurance; the redundancy is the security property. Removing the deny list would be a regression, not a simplification.
- **Consequence:** N/A.
- **Fix:** N/A. (Note for future: if the deny list grows past ~20 entries, consider a positive single-source-of-truth `tool-policy` table instead.)

---

## F9 — SessionState extension: two optional fields are not yet a data clump
- **File:** `session-types.ts:434-441`
- **Principle:** P5 Primitive obsession / Data clump
- **Severity:** P3
- **What's wrong:** `sessionGroupId?: string` + `sessionGroupRole?: SessionGroupRole` are added as two parallel optional fields that are always present together or both absent — the classic data-clump prelude. A third field is plausible (group-relative `pairedSessionId`, or join timestamp). At two fields the rule "extract a class when you have three" does not yet fire, and forcing `sessionGroup?: { id; role }` now creates a one-shot rename through cli-launcher/ws-bridge once they start reading the fields.
- **Consequence:** Low — flag, don't act. If Phase D adds a third co-travelling field, that's the moment to collapse them into a `sessionGroup?: { id, role, ... }` sub-object.
- **Fix:** Leave as is for Phase A-C; revisit at the start of Phase D and group into a nested object if a third field appears.

---

## Summary

| Severity | Count | Findings |
|----------|-------|----------|
| P1 | 0 | — |
| P2 | 3 | F1, F2, F4, F5 (4 — recounting) |
| P3 | 2 | F3, F6, F9 (3 — recounting) |

Corrected: **4 P2** (F1, F2, F4, F5) + **3 P3** (F3, F6, F9) + 2 no-finding observations (F7, F8) = **7 substantive findings**.

The cluster around F1/F3 (placement + vocabulary) is the cheapest to fix now and the most expensive to fix after Phase D wiring lands — those two are the economic top priority. F4 (backend-provider) is the speculative-generality risk that compounds if Phase D imports the empty interface unchanged. F5 is a correctness-adjacent structural smell (function lies about side effects). F2 is the drift surface most likely to bite during the first ID-format change. F6 + F9 are hygiene that compounds; F7 and F8 confirm the pattern is healthy where it lands.
