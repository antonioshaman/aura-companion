# Council Review (Aura v1) — Composer permission-mode toggle

**Implementation commit:** `8a244e7` `feat(composer): A/B v1 implementation for permission-mode-toggle`
**Plan commit:** `e2e76b0` `docs(plan): A/B v1 plan for composer-permission-mode-toggle`
**Diff scope:** 9 files, +687 / −5 LOC (3 src + 3 src tests + 1 server + 1 server test + 1 playground)
**Council seats reviewed:** Hunt (security), Fowler (refactoring), Beck (test quality), Friedman+a11y (UX/accessibility, combined), Backend-TS

**Gates:** `bun run typecheck` clean; `bun run test` 6307 passed / 4 skipped / 0 failed.

---

## Headline

The headline P1 silent-privilege-upgrade defect (Codex empty-previous fallback → `bypassPermissions`) is **CLOSED** and pinned with a negative-control regression test (`pickRestoreMode("", true)` asserts both `=== "default"` AND `!== "bypassPermissions"`). The EC-1 server mirror (Hunt × Backend-TS) is correctly positioned in `routeBrowserMessage` before adapter delivery with EC-17 fail-closed semantics for `(sessionGroupId present, role undefined)`. No XSS in the new affordance render; no path/operator-topology leakage in the new log payloads (EC-23 clean).

One **new P1** surfaced from the UX seat: observer half loses the Composer with no banner explaining why — users navigating into the observer pane see a chat that mysteriously can't accept input and conclude the session is broken. Five **P2** items + several P3 polish items. None block ship; all are deferrable to a follow-up PR if the A/B test selects this branch.

---

## Convergence

No multi-expert P1 convergence in the review of v1. Each P1/P2 finding came from a single seat — the implementation passed the obvious chokepoints (security, refactoring structure, server boundary) without contested issues. The UX seat surfaced the most P2-level work; this is expected because the spec's three Gherkin scenarios were behavioural-correctness-focused, not affordance-quality-focused.

---

## P1 — must address before merging this branch

### P1.1 — Observer half has no visual cue explaining absent Composer
- **File:** `web/src/components/ChatView.tsx:163-167`
- **Seat:** UX (Friedman) — Principle P2 (five screen states — empty/explanation state) + P9 (trust)
- **What's wrong:** When `sessionGroupRole === "observer"`, the Composer simply disappears with no banner, badge, or explanatory text. A user (especially keyboard- or screen-reader-driven) looking at the observer ChatView sees a chat that mysteriously cannot accept input — indistinguishable from a bug. The Playground card hand-waves this with italic copy ("Observer half of a Council pair has no Composer"), but the live UI ships no equivalent.
- **Consequence:** Users open the observer tab, try to type, lose Tab focus into nothing, and conclude the session is broken; this contradicts the trust-compounds-slowly principle precisely at the role-boundary moment.
- **Fix:** Render a dedicated read-only role banner in the slot where Composer would have rendered ("You are viewing the observer half — input is locked at spawn"). Pair with `role="status"` so SR users hear it on navigation. Plan flagged the structural invariant but not the user-facing affordance; the v1 plan's Task 5 should have included this companion banner.

---

## P2 — should address before considering this stable

### P2.1 — `role="alert"` on refuse-affordance is over-assertive
- **File:** `web/src/components/Composer.tsx:617-636` (the role="alert" affordance div)
- **Seat:** UX/a11y — ARIA live-region politeness (assertive reserved for emergencies)
- **What's wrong:** `role="alert"` maps to `aria-live="assertive"` and interrupts the user's screen-reader mid-sentence on every keystroke that matches a discovery skill. Since the affordance re-renders on each keystroke after the trigger, NVDA/VoiceOver re-announce or interrupt typing flow. The implementation comment itself says "wrong tool selected, not 'you broke something'" — but the ARIA shape is the latter.
- **Consequence:** Screen-reader users typing `/council-plan-aura` get their letter-by-letter announcement clobbered; they may abandon input or never hear what they typed.
- **Fix:** Switch to `role="status"` (implicit `aria-live="polite"`) and add `aria-atomic="true"` so the unchanged message isn't re-announced on every keystroke once stable.

### P2.2 — Focus is not returned to textarea after "Switch to agent mode" click
- **File:** `web/src/components/Composer.tsx:628-635` (the inline button)
- **Seat:** UX/a11y — focus management on dynamic UI (dismiss returns focus to triggering element / intended next step)
- **What's wrong:** Clicking the inline "Switch to agent mode" calls `toggleMode`, the affordance unmounts (because `refuseDispatch` flips false), and DOM focus falls to `<body>` since the button that had focus no longer exists.
- **Consequence:** Keyboard-only users complete the affordance flow only to land in `<body>`, defeating the "remove the blocker, keep typing" intent.
- **Fix:** After `toggleMode` in the affordance's `onClick`, call `textareaRef.current?.focus()` (queue via `requestAnimationFrame` so it runs after the re-render that unmounts the affordance).

### P2.3 — Axe-pass on the affordance is necessary-but-not-sufficient for color contrast
- **File:** `web/src/components/Composer.tsx:621` (yellow `bg-cc-warning/8` over panel)
- **Seat:** a11y — color contrast is one of the rules axe explicitly disables in jsdom
- **What's wrong:** 8 % opacity on the warning color over an unknown panel background, with 12 px body text, has not been measured against 4.5 : 1. The axe scan runs against jsdom which **cannot measure rendered contrast** — `toHaveNoViolations()` passing here does NOT prove this combination meets WCAG.
- **Consequence:** Low-vision users may miss the very affordance that exists to slow them down.
- **Fix:** Run a real-browser axe pass (or a manual contrast checker) on the rendered affordance in both light and dark themes; bump opacity if border < 3 : 1 or text + icon < 4.5 : 1.

### P2.4 — `pickRestoreMode` regression canary is not mutation-resistant against inline-literal refactor
- **File:** `web/src/utils/backends.test.ts:175-202` × `web/src/components/Composer.test.tsx`
- **Seat:** Beck — Mutation resistance (Principle 6) + EC-19 static-grep canaries
- **What's wrong:** `pickRestoreMode("", true)` is asserted in isolation, and the Composer integration asserts the on-wire `mode: "default"` — but no test asserts the integration call **uses** `pickRestoreMode`. A refactor that inlines the literal `"default"` directly into `Composer.tsx`, then leaves `pickRestoreMode` returning `"bypassPermissions"`, would pass both suites. Helper would become dead code; future "cleanup" deletes it; silent-privilege-upgrade defect re-emerges under a renamed call site without either test failing.
- **Consequence:** The fix's durability degrades over time. The exact failure class EC-19 was codified to defend.
- **Fix:** Add an EC-19 static-grep canary in `backends.test.ts` that reads `Composer.tsx` source at test time and greps for `pickRestoreMode(previousMode, isCodex)` (or regex over `pickRestoreMode\s*\([^)]*\)`). Mirrors `feedback_static_grep_canary_regex_over_substring`.

### P2.5 — Observer-guard test does not lock the no-permissionMode-mutation invariant
- **File:** `web/server/ws-bridge.test.ts` (observer-reject + role-probe-null cases)
- **Seat:** Beck — EC-22 behavioural-assertion + mutation resistance
- **What's wrong:** The reject branch asserts `cli.send` was not called AND inspects the WARN payload, but a future refactor that moved the `permissionMode` snapshot/mutation BEFORE the reject would still pass — `cli.send` still unreached, runtime state still leaked. The exact bug the EC-1 mirror exists to prevent.
- **Consequence:** Server-side `session.state.permissionMode` could silently move from `acceptEdits` to `plan` for an observer even though the frame never reached the CLI — and tests would not catch it.
- **Fix:** Append `expect(session.state.permissionMode).toBe(<prior>)` to both reject-case tests. Same on the role-probe-null case. Locks the no-mutation invariant explicitly.

---

## P3 — polish, defer or do incrementally

- **P3.1 (Beck)** — Affordance "Switch to agent mode" click test does not assert that after the switch, the originally-typed `/council-plan-aura` text is dispatchable. Half of Friedman's P5 disabled-control recovery path. Extend the test to fire the post-switch Send.

- **P3.2 (Beck)** — `Object.isFrozen(INTERACTIVE_DISCOVERY_SKILLS)` passes vacuously for any frozen array. `.toContain` covers three slugs; three (`council-plan-aura-v2`, `council-plan`, `council-plan-v2`) are un-anchored. Use deep-equality against the full canonical list.

- **P3.3 (UX)** — `"Switch to agent mode"` button copy. "agent mode" is not a label that appears elsewhere in the Composer (the mode chip shows `plan`, `acceptEdits`, `default`, `bypassPermissions`). Either rename to "Exit plan mode" or interpolate the restored mode: `"Switch to {restoreMode}"`.

- **P3.4 (UX)** — No loading/error state for the toggle round-trip. Plan flagged as acceptable deferral (Risks list). Next iteration: gate optimistic update on server-side ack with a non-blocking inline error if it doesn't arrive within ~1.5s.

- **P3.5 (UX)** — Keyboard-activation test for the inline "Switch to agent mode" button is missing. Click test uses `fireEvent.click`. A `<div onClick>` regression would slip past CI. Add a Tab + Enter behavioural assertion.

- **P3.6 (Fowler)** — Refuse-affordance JSX duplicated between `Composer.tsx` and `Playground.tsx`. They will drift on the first iteration (already do: live is `<button>`, mock is `<span>`). Lift copy + classes to a shared constant; resist extracting a component (still single live consumer).

- **P3.7 (Fowler)** — `INTERACTIVE_DISCOVERY_SKILLS` + `detectInteractiveDiscoverySkill` co-located in `backends.ts` mix concerns (slash-command parser vs backend-keyed option tables). `pickRestoreMode` belongs here, the discovery pair does not. Move to `utils/discovery-skills.ts` ONLY when a second consumer appears (server validator, command palette). Economic test: don't refactor yet.

- **P3.8 (Fowler)** — `pendingMessages` queue-flush path is safe by construction today (the only enqueue site is inside `routeBrowserMessage` AFTER the new gate), but the invariant is undocumented. Add a one-line comment at `enqueuePendingMessage`: "Callers MUST have already passed `routeBrowserMessage` policy gates — this queue is post-gate."

- **P3.9 (Fowler)** — `previousMode` selector default switched from `"acceptEdits"` to `""`. Sentinel-string for "absent" + threaded through `pickRestoreMode` with a `length > 0` check. Two negative signals (`undefined`, `""`) for one concept. Tighten `pickRestoreMode` to accept `string | null | undefined` and let the selector pass through `string | undefined` directly. 10-line typed-API cleanup; doesn't change behaviour.

- **P3.10 (Backend-TS)** — `// fall through to existing adapter delivery` comment is misleading — fall-through is just exiting the `if`-block. Reword to "no early return — continues to the generic adapter delivery section below" OR extract the gate into a `gateSetPermissionMode(session, msg)` helper.

- **P3.11 (Backend-TS)** — Queue-flush replay theoretical race: if `sessionGroupRole` flips to `"observer"` AFTER a `set_permission_mode` was enqueued but BEFORE it's flushed, the gate is not re-evaluated. Today `set_permission_mode` is not in `RETRYABLE_BACKEND_MESSAGE_TYPES`; the race is structural but unreachable. Either route flush replays through `routeBrowserMessage` or add an `assertObserverNotTargeted` check in the flush loop. Document the role-stability invariant.

- **P3.12 (Backend-TS)** — EC-15 (exhaustive switch on discriminated unions): the new gate uses sequential `if` checks on `sessionGroupRole` (`"orchestrator" | "observer" | undefined`). A future fourth role variant falls through to `log.info` silently. Use `switch` with explicit cases + `const _: never = sessionGroupRole` exhaustiveness check.

- **P3.13 (Backend-TS)** — EC-16 origin discriminator: `routeBrowserMessage` accepts an `origin` parameter the new gate doesn't read. Today `set_permission_mode` is only browser-originated. Add an inline comment noting the assumption so a future REST `/sessions/:id/set-permission-mode` doesn't inadvertently bypass the observer-guard.

- **P3.14 (Backend-TS)** — `from`-snapshot comment overstates risk. The bridge does not mutate `session.state.permissionMode` post-send today; the snapshot is forward-defensive, not load-bearing. Reword to "Snapshot before any state mutation downstream" without the "post-send mutation doesn't collapse the transition" claim.

---

## Positive recognition (do not regress)

- **Codex fallback canary** at `backends.test.ts:184` (`pickRestoreMode("", true)` paired with `not.toBe("bypassPermissions")`) is textbook mutation-resistant for the literal-return assertion. Pair it with P2.4 above to make it refactor-resistant.
- **Server-guard test suite** covers all 4 cases (observer-reject, role-probe-null, orchestrator-allow, solo-allow) with **input-keyed setup** (state fields directly mutated), not call-counter fakes — `feedback_parallel_test_fakes_keyed_by_input` discipline upheld.
- **Refuse-affordance derived flag** (`refuseDispatch`) is genuinely the single expression driving BOTH the render and the `handleSend` early-return (Composer.tsx:55, :157, :585). No two-source drift risk.
- **EC-9 log shape** in the new `ws-bridge.ts` block matches the existing convention's field order and types (`event` first, `sessionId`, `sessionGroupId`, then context). Reuses the existing `log` import.
- **Trust-boundary matcher** (`detectInteractiveDiscoverySkill`) uses exact equality on a frozen tuple with first-token parsing, no `startsWith`/`includes`/regex — closed by construction. Rejection-set tests (`/council-plan-aura-x`, `/council`, `/x-council-plan-aura`) anchor that prefix-bypass cannot work.
- **No XSS, no path leakage, no PII** in the new log/console payloads (Hunt clean across all four channels — server INFO/WARN + client `console.warn`).
- **All gates green:** typecheck clean, 6307 tests pass / 4 skipped / 0 failed.

---

## Verdict

**Ship-ready** for the A/B comparison. The headline P1 (silent-privilege-upgrade on Codex empty-previous) is closed and pinned. The five P2 items are real but each is a small fix (banner addition, ARIA token swap, focus-call, contrast check, 2 test invariants). The 14 P3 items are pure polish.

If this branch wins the A/B selection, the recommended follow-up PR sequence is:
1. **P1.1** observer banner (one component, ~15 LOC + axe test) → ships with the merge.
2. **P2.1-2.3** UX/a11y triple — same file, same iteration.
3. **P2.4-2.5** test-canary tightenings — separate commit for clarity.
4. **P3.1-14** polish — slot into the next sprint's refactor budget; not blocking.

**Most important architectural decision honoured:** Task 6's single-chokepoint placement of the server-side gate inside `routeBrowserMessage` after dedup and before adapter delivery — this is the EC-1 mirror that makes the UI guard structural rather than ornamental. Verifying that the queue-flush path is safe-by-construction today (Fowler P3.8 invariant) was the load-bearing trace; document it now so a future contributor doesn't accidentally break it.
