<!-- council-selection-engine v1 -->
# Council selection engine (RC-2 — universal, adaptive, Carmack-arbitrated)

**Single source of truth for how every `/council-*` skill selects its advisors.**
`council-plan`, `council-review`, `council-implement` and their `-aura` variants all
follow THIS flow — there are no per-skill fixed `Panel:` lists and no per-skill
stack-router. A skill file references this document; it does not re-implement it
(AC5.1). The catalog IS the panel: any advisor whose `meta.yaml` declares a valid
`capabilities` block is seatable; anyone without one is never seated (AC2.2).

## Reference implementation + verifier

The deterministic engine is implemented and unit-tested in the Aura Companion repo
under `web/scripts/` — it is the canonical spec and the CI verifier, and (when that
repo is checked out) an executable the Chair MAY run directly:

| Concern | Module |
|---|---|
| Closed vocabulary (signals + domains) | `_council-experts/.verify/capability-vocabulary.json` |
| Fingerprint a workspace → `Fingerprint` | `web/scripts/fingerprint.ts` (`detectFingerprint`) |
| Load + validate catalog capability profiles | `web/scripts/capability-catalog.ts` (`loadCatalog`) |
| Score + guardrails + dedup → ranked candidates | `web/scripts/advisor-scorer.ts` (`composeCouncil`) |
| Fail-closed validation of the Chair's roster | `web/scripts/roster-validation.ts` |
| Stack-accurate brief + contradiction flag | `web/scripts/advisor-brief.ts` |
| Roster ledger + confirm-stack rendering | `web/scripts/roster-render.ts` |

The Chair follows the SAME algorithm in prose below; the TS is the ground truth a
review/CI checks the prose against. Determinism, guardrails and fail-closed
behaviour are guarantees of that implementation — the prose must not diverge from it.

## Phase 0 — Fingerprint (replaces the old two-stack router)

Inspect the workspace cwd + each depth-1 subdirectory (monorepo-aware) and emit a
structured **fingerprint** of signal tokens grouped by dimension. The dimensions are
whatever `web/scripts/fingerprint.ts` `SignalDimension` declares (currently
`languages, runtimes, frameworks, datastores, orm-migrations, infra, surfaces`) — the
code is canonical, so read it there rather than trusting a count here. Tokens are
drawn from the closed vocabulary. Coexistence of multiple stacks is normal DATA, not
an "ambiguous" error. File reads go through the hardened resolver (realpath + bounds
+ symlink-reject + size-cap); every failure is surfaced, never a silent absence.

- If ANY recognised signal is found → proceed to Phase 1 with the fingerprint.
- If NONE is found → the fingerprint is `needs-confirmation`: **ASK the developer to
  confirm the stack** (see Confirm-stack below). Never refuse, never guess (AC1.3).

## Phase 1 — Score + compose the council

1. Load every advisor's `capabilities` profile from the catalog (fail loud on a
   malformed/typo'd/unknown-token profile; skip — never seat — a profile-less one).
2. Score each advisor as a weighted sum of `|profile.signals ∩ fingerprint.signals|`
   and `|profile.domains ∩ feature-domains|`, plus a cross-stack baseline for advisors
   declaring the `any` signal (so a security / refactor / test / LLM lens is always a
   candidate and cannot be starved by the fingerprint — hunt #4). **The exact weights
   and baseline are the named constants `W_SIGNAL` / `W_DOMAIN` / `CROSS_STACK_BASELINE`
   in `web/scripts/advisor-scorer.ts` — read them there; this doc deliberately does NOT
   restate the arithmetic so the numbers cannot drift out of sync (fowler #2).**
   Feature-domains are the closed-vocab domain tags YOU (the Chair) derive from the brief.
3. Rank by score desc, then advisorId asc (total, deterministic). Drop score-0
   advisors (no quota padding). Drop redundant duplicates (identical matched sets);
   keep genuine lane-splits. A relevant cross-stack lens is NEVER deduped away.
4. Apply guardrails via `composeCouncil`: seat between `MIN_SEATS` and `MAX_SEATS`
   (`advisor-scorer.ts`; currently **3** and **11**), reserving any relevant cross-stack
   lens ahead of rank-fill. Candidates that scored > 0 but fell below the cap are
   **crowded-out** — list them so the developer can add one back (a starved security
   lens must be VISIBLE, not silently dropped).

5. **Economy council — the DEFAULT (owner decision 2026-10-03, AuraBench COUNCIL-PANEL).**
   Unless the developer explicitly asks for a **"full council"** (or the run is a
   release / security audit), replace step 4's rank-fill with the economy rules
   (reference: Aura repo `web/scripts/dispatch-policy.ts` `composeEconomyCouncil`):
   - a seat must match a domain the CHANGE actually touches — a stack-signal match
     alone does not seat an advisor (no Python/PostgreSQL/Telegram seats on a TS-only diff);
   - rank-fill budget: **2** for a known ≤ 3-file / ≤ 150-line diff, **3** otherwise;
   - every relevant cross-stack lens (**hunt / fowler / willison / beck**) is seated
     even past the budget — fail-closed lenses are never dropped;
   - list every dropped seat with its reason (`no-domain-match` / `over-budget`) in the
     roster ledger so the developer can add one back.
   Evidence: on 6 historical PRs with known defects, economy found as many known
   defects as the full panel (10/18 vs 10/18, judge-verified) at ~40% of the cost
   ($19.48 vs $47.88). Full council = steps 1–4 only.

## Phase 2 — Present the roster, then arbitrate (fail-closed)

Present the proposed council as a scannable ledger — one line per seat: advisor,
primary matched domain, and the matched signals that earned the seat (the WHY). The
WHY is code-emitted, not model-authored: render it via `roster-render.ts`
`renderRosterPreview(composition, fingerprint)` and reproduce that output **verbatim**
— do NOT paraphrase the per-seat rationale, or it can drift from the scorer's
`matchedSignals` (drop a real signal, invent a plausible-sounding one). If a read
failed during fingerprinting, `renderRosterPreview` also surfaces the DEGRADED SCAN
warning — keep it. Offer `confirm` / `veto <id>` / `add <id>`. The roster is a
proposal, not a verdict.

Your final seated roster MUST be a subset of the ranked candidate set, within the
min/max guardrails, with no duplicates and no advisor invented outside the pool. This
is validated fail-closed: on any drift the engine falls back to the deterministic
top-N by score. You choose WITHIN the candidate set; you never overrule it.

## Phase 3 — Brief each seat on the DETECTED stack

Each seated advisor's dispatch prompt names the detected-stack tokens **it actually
covers** (its matched signals), injected from the one shared fingerprint — never the
advisor's full declared signal set. A Python advisor seated on a FastAPI repo is
briefed for FastAPI and never mentions aiogram, because aiogram is not in the
fingerprint. When a framework-specialist advisor is seated with NONE of its
frameworks in the fingerprint, the brief carries a visible MISMATCH flag pointing at
the detected frameworks (AC4.1 / AC4.2) — this is a computed branch, not a judgement
call.

## Confirm-stack (needs-confirmation)

When Phase 0 finds no recognised signals, present a recoverable prompt: show what (if
anything) was detected, then offer forward actions — confirm the detection, name the
stack, or write `.council-stack-override` with the intended tokens. Never emit a
dead-end "unsupported stack" refusal.

## `-aura` aliases

The `-aura` skill variants are thin aliases: they carry NO `Panel:` list and NO
stack-router — they reference this engine like every other council skill. They exist
only for muscle-memory / back-compat. "Contains selection logic" is the disqualifying
test for whether an alias is still thin.
