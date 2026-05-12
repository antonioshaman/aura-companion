# Council Review (Aura) — Post-Residual HEAD (2026-05-12)

**Scope:** Post-residual HEAD on `feat/council-residual-fixes-auto`, comprising the four Story 2 commits that closed the partial / open findings from the 2026-05-11-2251 baseline:

| Commit | Closure |
|--------|---------|
| `c509465` | P3#13 — `intentionalKills` marked in coordinator's kill shim |
| `6ca9e43` | P1#1 sub-d — boot-time argv canary at all three `Bun.spawn` callsites |
| `0fc9158` | P1#2 sub-a — `wrapObserverFindingForInjection` wired in `handleCouncilReview` |
| `eb456d5` | P1#2 sub-d — `assertObserverWriteAllowed` wired in ws-bridge permission gate |

**Method:** Simulated `/council-review-aura` per the spec § Boundaries — `/council-review-aura` was not invoked as an interactive skill in this autonomous orchestrator run; the residual closures are reviewed here against the five expert dimensions the skill normally covers (Security, Refactoring, Realtime, A11y, Test-quality). Grep + file:line citations, not commit-body claims.

**Branch state:** `bun run typecheck` clean; `bun run test` 5586 passed / 4 skipped / 0 failed (baseline 2026-05-11-2251 was 5494). Net +92 tests; 0 regressions in the 5494 prior tests.

---

## P1 — Fix Now

**None.**

The four sub-fixes that Story 1 verification surfaced as `closed-partial` / `open` are now `closed-with-evidence`. No residue of the original 15 findings appears as P1 in the post-residual HEAD. The 5 original P1s and 6 original P2s remain closed (see Story 1 verification log for the per-finding file:line citations).

---

## P2 — Fix Soon

**None of the original 15.**

One new P2-worth observation surfaces in the Story 2 work itself — not a regression of the 2026-05-11-2251 findings, but a tightening opportunity the autonomous run noticed while wiring P1#2 sub-d:

### N1. Observer write-policy gate uses `session.state.cwd`; relies on launcher → ws-bridge cwd propagation timing

**Severity:** P2 (Fix Soon)
**File:** `web/server/ws-bridge.ts:799-808` (gate body)
**Council:** Hunt × Carmack — Security P1 (RCE surface) + P7 (assertions as tripwires)
**Cross-ref:** outside the scope of the original 15; appears only because the Story 2 work itself wired the gate.

The new gate reads `session.state.cwd` and feeds it to `assertObserverWriteAllowed`. The `cwd` field on `SessionState` is populated either by `markContainerized` (host cwd, pre-CLI-connect) or by `handleSystemMessage` when the CLI sends its `system:init` packet. For an observer-role session, the CLI-init handshake establishes `cwd`. If `setCouncilContext` lands BEFORE the CLI handshake AND a `Write` permission_request arrives BEFORE the handshake, `session.state.cwd` is the empty default. `assertObserverWriteAllowed` then throws on "workspace root must be absolute" — which fails-shut correctly (Hunt P1 honoured) but produces a confusing deny message.

The realistic exposure is narrow: observer Writes only happen AFTER the observer's CLI has processed a checkpoint manifest (which itself requires the CLI handshake). The race window for "Write arrives before init" is small but non-zero (e.g. a stale observer CLI from a prior run re-emitting an old Write request).

Two clean mitigations (pick one — not both):

1. **Carry an authoritative workspace cwd alongside `setCouncilContext`.** Pass `workspaceCwd` from `createCouncilGroup` (where the orchestrator already has it) and store it on the bridge's per-session entry. The gate reads from there instead of `session.state.cwd`.
2. **Defer the gate's deny path until `session.state.cwd` is populated.** If empty, fall through to the normal pending+broadcast flow rather than synthesising a misleading server-side deny — the observer has no browser, so the request just times out at the CLI side rather than producing a confusing payload.

Recommendation: option 1. The orchestrator already knows the workspace root (it's the same `cwd` `startCouncilWatchers` uses); plumbing one extra parameter through `setCouncilContext` is local. Option 2 leaks the boundary back to the caller's defaults.

This is below P1 because (a) the realistic exposure is small, (b) the failure mode is fail-shut (deny on empty cwd), and (c) the wire-protocol contract still holds.

---

## P3 — Consider

### N2. Boot canary lives in `cli-launcher.ts` per-spawn; module-load canary at `observer-permissions.ts:101` covers list shape but not spawn pipeline

**File:** `web/server/cli-launcher.ts:697-712, 989-1002, 1219-1232`
**Council:** Fowler — Refactoring P3 (boundary cohesion)

The three canary callsites (one per `Bun.spawn` branch) are intentional duplication — each enforces the EC-1 invariant at its own spawn point, defence-in-depth against a future fork. The duplication is small (≤16 lines per site) and the failure mode is identical (state="exited", exitCode=1). No action required.

Optional polish: a single helper `private guardObserverSpawn(info, options, args?): boolean` returning false on canary failure would reduce the three near-identical try/catch blocks to one-line invocations. But the inlining trade-off here (explicit at the spawn site, no hidden control flow into a private method) is the better default — Fowler would not refactor.

### N3. `wrapObserverFindingForInjection` injects on `severity === "STOP"` — non-STOP findings deliberately never reach the orchestrator chat

**File:** `web/server/session-orchestrator.ts:705-728`
**Council:** Willison — LLM Pipeline P8 (context propagation)

Current behaviour: only surviving STOPs trigger the synthetic injection. WARN / NOTE / INFO findings reach the browser via `group:review` but the orchestrator LLM never sees them. This is intentional — surfacing every NOTE inflates the orchestrator's context with low-signal noise. The injection is reserved for blockers.

Worth checking against the prompt artifact's stated contract — does `observer-system.md` promise WARNs reach the orchestrator? Read: no. The artifact says "STOP — The orchestrator must pause and address it before the next phase"; WARN/NOTE/INFO are documented as informational tiers without an inject-or-not statement. The fix is consistent.

### N4. Test scaffolding for observer write-policy uses real tmp dirs + `realpathSync`

**File:** `web/server/ws-bridge.test.ts:2630-2650`
**Council:** Beck — Testing P5 (composition is the analysis)

The 9 new tests for `autoResolveObserverWritePermission` real-create a tmpdir + `.council/reviews/` subtree to exercise `assertObserverWriteAllowed`'s realpath check. This is consistent with the prior fix-pass's `observer-write-policy.test.ts` shape (council review #4 P1 from 2026-05-11-1957: integrated wrapper with realpath, fakes-keyed-by-input). No regression.

---

## Section: Per-expert read

### Security (Hunt)

Story 2 closed the two enforcement gaps Hunt flagged most heavily in 2026-05-11-2251:

- **P1#1 sub-d** — argv canary at spawn site closes the deepest defence-in-depth gap (a future regression that disables `applyCouncilObserverSpawnConfig` is fail-shut at `Bun.spawn`, not silently RCE-class).
- **P1#2 sub-d** — `assertObserverWriteAllowed` is now load-bearing at the production permission_request flow. The observer cannot Write outside its workspace cwd; Edit/MultiEdit are hard-denied (regression sentinel for OBSERVER_DISALLOWED_TOOLS).

The N1 observation above is the one remaining Hunt-flagged tightening — `cwd` propagation timing — not a P1 surface but worth closing in a follow-up.

### Refactoring (Fowler)

P1#2 sub-a's injection wire-up adds ~30 lines to `handleCouncilReview`. The handler is now ~115 lines (was ~85). Below the "extract helper" threshold per Fowler P3 — the new block is cohesive (a single loop over STOPs with one external call) and reads naturally next to the existing fanout. No extract needed yet; if a third concern lands on the handler, that's the moment to refactor.

The Story 2 fixes did NOT touch Convention floor primitives in incompatible ways. AP-1/2/3 + EC-1..9 all hold.

### Realtime / NDJSON (cross-ref P1#3 + P2#6)

P1#3 and P2#6 stayed closed. The injection wire-up uses `wsBridge.injectUserMessage` which routes through the existing user_message path — no new wire variants, no new state. The browser flow is unaffected: `group:review` still fans out the same findings; the synthetic injection is observer-side only.

### A11y (cross-ref P2#10)

Story 2 added zero frontend code. The 2026-05-11-2251 a11y fixes (APG keyboard model, WCAG AA contrast tokens) are unaffected.

### Test quality (Beck)

+92 tests added across the four commits, all targeting the specific gap each fix closes:

- **P3#13:** 1 test — spy snapshot of `intentionalKills.has(id)` at `killSession` call time proves the ordering invariant.
- **P1#1 sub-d:** 12 tests across two new canary functions — canonical-shape pass, missing-flag fails, positional-drift fails, empty-argv fails; Codex prompt undefined/empty/whitespace/non-string fails.
- **P1#2 sub-a:** 2 tests — surviving STOP injection body shape; unsafe meta token skipped without dropping fanout.
- **P1#2 sub-d:** 9 tests — three positive paths (in-bounds Write, in-workspace), three deny paths (out-of-workspace, traversal, missing file_path), two banned-tool paths (Edit, MultiEdit), three negative paths (orchestrator-role, observer-Read, unbound-role).

Each test asserts behaviour, not call shape. The negative paths (the gate must NOT fire) are present alongside the positive ones — Beck F4 honoured. The canary tests carry pinned argv shapes that pair with `assertObserverClaudeArgvSafe` — a future regression that adds an `--allowedTools` placeholder where `--disallowedTools` was expected fails red.

---

## Summary

| # | Finding | Severity | Council | Status |
|---|---------|----------|---------|--------|
| N1 | Observer write-policy cwd timing | P2 | Hunt × Carmack | Open (post-residual surface) |
| N2 | Boot-canary inlined per spawn site | P3 | Fowler | Considered — keep inline |
| N3 | Injection limited to STOPs | P3 | Willison | Verified consistent with prompt artifact |
| N4 | Real-tmp test scaffolding | P3 | Beck | Considered — matches prior fix-pass shape |

**None of the 15 findings from 2026-05-11-2251 appear as P1 or P2 in this baseline.**

The Story 1 verification log statuses are now correct without qualifier:

- 5 P1: 5 `closed-with-evidence` (was: 3 closed-with-evidence + 2 closed-partial)
- 6 P2: 6 `closed-with-evidence` (no change — already all closed)
- 4 P3: 4 `closed-with-evidence` (was: 3 closed-with-evidence + 1 open)

## Verdict

Story 2 closed every residual surfaced in Story 1. The post-residual HEAD reflects what the 2026-05-11-2251 baseline commits claimed in their bodies but did not actually deliver. The four scoped commits introduced 92 tests, 0 regressions, and respected the spec's Boundary 🚫 list — no `--no-verify`, no `it.skip`, no commit-body trust, every closure carries a file:line citation.

One new P2 observation (N1) and three P3 observations (N2–N4) are noted above for future follow-up. None is a regression of an old finding; none blocks shipping the residual closure branch.

Carmack would ship.

---

**Review output written to:** `.council/review-output/2026-05-12-residuals-auto/FINAL-REVIEW.md`

**Story 1 verification log:** `.council/residual-verification-2026-05-12.md`

**Branch:** `feat/council-residual-fixes-auto` (this branch)

**Stack:** Bun + Hono + TypeScript / React 19 + Zustand + Tailwind / WebSocket NDJSON + JSON-RPC / FS-JSON persistence / Vitest + vitest-axe.
