# Task: Sidebar Chip Redundancy — Full Suppression vs Backend Indicator

**Status:** Ready to implement
**Type:** Frontend UX fix (small)
**Owner:** Picked up overnight by Deep Falcon or Warm Delta council pair, OR human in next session
**Predecessor PR:** #27 (homogeneous-pair suppression — partial fix, this extends it)

---

## Problem

In the sidebar `SessionItem`, three chips currently render for a Claude+Codex council session:

```
[CC] [CLAUDE] + [CODEX]
```

The green `CC` chip is the **backend indicator** (Claude Code session). The `CLAUDE` chip is the **council orchestrator pair-half** — and it duplicates `CC` semantically. The user's intent across the day was: "зеленый `CC` и этого достаточно" — the backend chip already says Claude; rendering an additional `CLAUDE` chip in the pair badge is redundant.

PR #27 only suppressed the **fully-homogeneous** case (`claude+claude`). The asymmetric case (`claude+codex`) still renders the redundant `CLAUDE` chip alongside the new-info `CODEX` chip. That is the partial-fix-passed-as-complete failure mode this task closes.

## Goal

Suppress the **specific pair-half that duplicates the backend indicator**, keep the **non-duplicate pair-half** that adds new information. The non-council case is unchanged (no chips beyond backend).

## Target state — exhaustive table

| Backend (left chip) | Council pair | Sidebar render |
|---|---|---|
| `CC` (Claude Code) | _no pair_ | `[CC]` |
| `CC` (Claude Code) | `claude+claude` (homogeneous) | `[CC]` — already shipped in PR #27 |
| `CC` (Claude Code) | `claude+codex` | `[CC]  [CODEX]` — drop the redundant `CLAUDE` half |
| `CX` (Codex) | _no pair_ | `[CX]` |
| `CX` (Codex) | `codex+codex` (hypothetical homogeneous, observer = orchestrator) | `[CX]` — same logic as claude+claude |
| `CX` (Codex) | `claude+codex` | `[CX]  [CLAUDE]` — drop the redundant `CODEX` half |
| `CX` (Codex) | `codex+claude` (hypothetical) | `[CX]  [CLAUDE]` — drop the redundant `CODEX` half |

**Rule:** for each half of the pair, hide it if its provider matches the backend indicator's provider. Render the remaining half (or nothing) as a single chip. The `+` separator from the existing `ProviderBadges` becomes irrelevant when ≤1 chip remains.

## Out of scope (do NOT change)

- `TopBar` rendering of `ProviderBadges` — keeps full `CLAUDE + CODEX` because TopBar has space and there is no backend indicator next to it.
- `ObserverPanel` header rendering — same reason.
- `Playground` mocks — keep existing entries for the full-render case; add new entry for the suppress case.
- Backend chip (`CC` / `CX`) rendering — unchanged.

## Files to touch

1. **`web/src/components/council/ProviderBadges.tsx`**
   - Extend the existing `isHomogeneousPairing` helper region with a new helper:
     ```typescript
     /** Return the pair halves that should remain visible given the backend
      *  already shown alongside. Backend "claude" hides any "claude" half;
      *  backend "codex" hides any "codex" half. Returns up to two providers
      *  in original orchestrator-then-observer order. */
     export function pairHalvesAfterBackendCollapse(
       pairing: string,
       backend: "claude" | "codex",
     ): string[]
     ```
   - Pure function; trivial to test exhaustively.
   - Re-export from `web/src/components/council/index.ts`.

2. **`web/src/components/SessionItem.tsx`**
   - Where the homogeneous-pair check currently lives (added by PR #27), extend the logic:
     - Read `session.backendType` (already passed into the component for the `CC`/`CX` chip rendering)
     - Call `pairHalvesAfterBackendCollapse(councilPairing, backendType)`
     - If result has length 0 → render nothing (matches PR #27 homogeneous behavior)
     - If result has length 1 → render a SINGLE chip for that provider (no `+` separator)
     - If result has length 2 → render both (this would be the case where pairing matches NO part of backend, which is impossible today but the type stays correct)
   - The single-chip render path may require small additions inside `ProviderBadges` to expose a "render one half" mode, OR `SessionItem` can render the chip directly using existing chip styling tokens. Prefer the latter — `ProviderBadges` stays focused on pair rendering and `SessionItem` opts into the suppressed-render via plain markup.

3. **`web/src/components/council/ProviderBadges.test.tsx`**
   - Add coverage for `pairHalvesAfterBackendCollapse`:
     - `("claude+claude", "claude")` → `[]`
     - `("claude+codex", "claude")` → `["codex"]`
     - `("claude+codex", "codex")` → `["claude"]`
     - `("codex+codex", "codex")` → `[]`
     - Malformed pairing → `[]` (or whatever existing helpers do for malformed input — match prior behavior)

4. **`web/src/components/SessionItem.test.tsx`**
   - Add behavioural test for the asymmetric case:
     - Given `backendType="claude"` + `councilPairing="claude+codex"` → exactly ONE chip rendered (the `CODEX` chip), no `CLAUDE` chip, no `+` separator.
     - Given `backendType="codex"` + `councilPairing="claude+codex"` → exactly ONE chip rendered (the `CLAUDE` chip).
     - Existing homogeneous-suppression tests from PR #27 stay green (regression invariant).

5. **`web/src/components/Playground.tsx`**
   - Add a new card next to the existing "homogeneous: chips suppressed" entry:
     - `Council pair — claude+codex on Claude backend (orchestrator-half suppressed)`
     - `Council pair — claude+codex on Codex backend (observer-half suppressed)`
   - These let the user verify the new states visually without creating live council pairs.

## Test plan

```bash
cd /root/aura-companion/web
/home/auracomp/.bun/bin/bun run typecheck      # must pass
/home/auracomp/.bun/bin/bun run test           # full suite, expect ≥5740 pass / 0 fail
/home/auracomp/.bun/bin/bun run test -- src/components/council/ProviderBadges.test.tsx src/components/SessionItem.test.tsx
# targeted tests should run in <5s and pass cleanly
```

The PR #27 regression test ("hides ProviderBadges for homogeneous council pair") MUST stay green — the new logic is a superset of #27, not a replacement.

## Verification on deployed server (post-merge)

1. Pull main + rebuild:
   ```bash
   cd /root/aura-companion
   git pull --ff-only origin main
   rm -rf web/dist
   cd web && /home/auracomp/.bun/bin/bun run build
   ```
2. In Aura UI (after SW unregister + reload):
   - **Fleet Ridge** (non-council, CC) → `[CC]` (unchanged)
   - **Warm Delta** (CC + claude+codex) → `[CC]  [CODEX]` (was `[CC] [CLAUDE] + [CODEX]`)
   - **Deep Falcon** (CX + claude+codex) → `[CX]  [CLAUDE]` (was `[CX] [CLAUDE] + [CODEX]`)
3. TopBar of any active session still shows full `[CLAUDE] + [CODEX]` — out-of-scope verification.

## Boundaries

✅ **Always**
- Render exactly the chips described in the table above.
- Keep `TopBar` and `ObserverPanel` chip rendering identical.
- Add tests covering all four backend × pairing combinations.

⚠️ **Ask first**
- Changing the visual style (color, size, padding) of the remaining chip vs the existing pair-chip style — this task is suppression-only, not restyle.
- Modifying `ProviderBadges.tsx` rendering API in a way that breaks TopBar/ObserverPanel call sites.

🚫 **Never**
- Hide the backend chip (`CC` / `CX`) — those are the load-bearing semantic, not redundant.
- Hide the unread-STOP counter — separate signal entirely.
- Touch `web/dist/` (it's gitignored and rebuilt; never commit dist files).
- Run destructive git ops (force push, reset --hard) without explicit instruction.

## Commit + PR

Branch name: `fix/sidebar-chip-redundancy-full-suppression` (consistent with PR #27's `fix/sidebar-hide-homogeneous-pair-chips`).

Commit message (commitizen style):

```
fix(council): suppress pair-chip half that duplicates backend indicator

Extends PR #27 (homogeneous-pair suppression) to also hide the pair-half
whose provider equals the backend chip's provider. Rationale: the green
`CC` (Claude Code) chip already conveys "this is a Claude session";
rendering an additional `CLAUDE` chip in the pair badge is pure
redundancy. Same logic on the Codex-backend side: `CX` already conveys
Codex; hide the `CODEX` half of any pair containing Codex.

Behaviour table:
- CC + no pair → `[CC]`
- CC + claude+claude → `[CC]` (PR #27 already)
- CC + claude+codex → `[CC]  [CODEX]`
- CX + claude+codex → `[CX]  [CLAUDE]`

TopBar and ObserverPanel keep full `CLAUDE + CODEX` rendering — they
have space and no backend indicator next to them.

Closes the partial-fix-passed-as-complete failure mode from PR #27.
```

PR description should reference this TASK file path so future readers see the full rationale.

## Why this matters

The user reported this redundancy four separate times across the day. Each prior round, I (the implementing agent) interpreted only the most-recent partial mention and shipped a partial fix without re-reading the full request. The trust-axiom feedback memory captures that meta-lesson; this task closes the underlying UI defect end-to-end so the user does not have to escalate a fifth time.
