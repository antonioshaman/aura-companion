# Council Plan (Aura v1) — Composer permission-mode toggle: honesty pass

**Scope:** Make the `>> agent / >> plan` toggle in `Composer.tsx` mean what users think it means: refuse-and-affordance when a plan-mode user dispatches an interactive-discovery skill; close the Codex `bypassPermissions` silent-upgrade on plan→agent restore; keep observer-half permission-mode locked at spawn (EC-1) under both UI and server boundaries; emit one EC-9 telemetry line per toggle.

**Context:** This is a ~60-LOC fix across three surfaces — `Composer.tsx` (toggle handler + affordance render), `utils/backends.ts` (constants + pure helpers), and `ws-bridge.ts` (server chokepoint for observer-guard + telemetry). The headline defect (silent "recommended defaults" substitution) collapses to one root: the toggle's user-facing label "plan" promises deliberation, the underlying Claude Code permission-mode delivers the opposite. We treat the symptom (refuse on discovery-skill collision) as the hotfix and flag the label-honesty root for follow-up. The secondary `bypassPermissions` defect is fixed in the same pass because it shares the file and ships in the same toggle handler.

**Boundaries (explicit out-of-scope):**
- Toggle label rename (`>> plan` → `>> finalize` or similar). Friedman pushed back — flagged in Risks.
- Frontmatter convention for "interactive_discovery: true" skill metadata. Stop-gap hard-coded list now; loader deferred.
- Adding `client_msg_id` to `toggleMode`'s `set_permission_mode` send. Frontend-React: do not bundle without paired EC-22 test.
- Discriminated-union refactor of toggle render state (`{kind: ideal|loading|error}`). Friedman R3 — defer until a second consumer appears.
- Server-side reconstruction of `composer.toggle.codex-fallback-default`. Backend-TS + Hunt converge: server cannot reliably distinguish "user picked default" from "client auto-fell-back" — keep WARN client-side.

**Council dispatched:** 5 of 12 expert seats — hunt (security), fowler (refactoring), friedman (UX), frontend-react, backend-ts. **Skipped (zero relevance for this 60-LOC fix):** a11y (no new ARIA surface — affordance reuses existing semantic tokens; will be axe-scanned in tests), saarinen (no visual-design redesign), willison (no LLM-content rendering), persistence-fs (no FS-touching code), realtime-ndjson (no protocol shape change — reusing `set_permission_mode`), subprocess (EC-1 spawn-only enforcement already in place; only server-side runtime gate is added), deploy-docker-gha (no deploy surface).

---

## Task Sequence

### 1. Add `INTERACTIVE_DISCOVERY_SKILLS` constant + `detectInteractiveDiscoverySkill` helper to `utils/backends.ts`

| | |
|---|---|
| **Domain** | Fowler × Frontend-React × Hunt — co-located convention + trust boundary |
| **Ref** | `references/refactoring.md` → P4 (Names reveal design) + P6 (Composition over configuration) |
| **Depends on** | — |

Add one frozen `readonly` tuple of skill slugs alongside the existing mode constants in `web/src/utils/backends.ts` (sibling of `CLAUDE_MODES`/`CODEX_MODES`). Derive a `InteractiveDiscoverySkill` union type from the tuple's elements. Export a pure `detectInteractiveDiscoverySkill(text: string): InteractiveDiscoverySkill | null` that: (a) trims, (b) splits on first whitespace, (c) rejects input that doesn't start with `/`, (d) strips the leading `/` and lowercases the first token, (e) returns the token only if it matches by **exact equality** against the tuple — never `startsWith`, `includes`, or regex (Hunt's trust-boundary rule). Initial slugs: `council-plan-aura`, `council-plan-aura-v2`, `council-plan`, `council-plan-v2`, `spec-writer`, `plan-feature`. EC-20 single-source-of-truth: same module imports the slugs into Composer and any future server echo.

---

### 2. Add `pickRestoreMode(previousMode, isCodex)` pure helper to `utils/backends.ts`

| | |
|---|---|
| **Domain** | Fowler — Extract pure logic, keep mutations visible |
| **Ref** | `references/refactoring.md` → P2 (Extract pure logic) |
| **Depends on** | — |

Replace the inline fallback ladder at `Composer.tsx:302` with a pure function in `utils/backends.ts`. Contract:
- `pickRestoreMode("plan", true)` → `"plan"` (passthrough — never reached in practice because the toggle only calls this on plan→agent)
- `pickRestoreMode(<non-empty>, _)` → returns the non-empty value (preserves user's saved prior mode)
- `pickRestoreMode("", true)` → `"default"` (**THE Codex fix** — was `"bypassPermissions"`)
- `pickRestoreMode("", false)` → `"acceptEdits"` (Claude unchanged)

Function takes `previousMode: string` (the Map entry or `""`) and `isCodex: boolean` (from `sessionData.backend_type === "codex"`). Pure, unit-testable in isolation, EC-22 behavioural canary attaches here.

---

### 3. `Composer.tsx`: replace fallback ladder + emit client-side WARN on Codex `default` fallback

| | |
|---|---|
| **Domain** | Hunt × Fowler — Fail-closed Codex restore + economic seam |
| **Ref** | `references/security.md` → P7 (Assertions as tripwires); `references/refactoring.md` → P2 |
| **Depends on** | Task 2 |

At `Composer.tsx:302`, replace `const restoreMode = previousMode || (isCodex ? "bypassPermissions" : "acceptEdits");` with a call to `pickRestoreMode(previousMode, isCodex)`. When the function returns the Codex empty-previous fallback (detect: `previousMode === ""` && `isCodex === true`), emit a client-side structured WARN via `console.warn` with shape:

```
{ event: "composer.toggle.codex-fallback-default",
  sessionId,
  previousMode: null,
  chosenMode: "default",
  backend: "codex" }
```

Client-side log is intentional: server cannot reliably distinguish user-explicit `default` from auto-fallback (Backend-TS R4 + Hunt R1 convergence). Cross-ref: Risks — server-side `composer.permission-mode.toggled` (Task 6) gives the observable transition; this WARN gives the client-side intent.

---

### 4. `Composer.tsx`: inline refuse-affordance + early-return on discovery-skill + plan-mode collision

| | |
|---|---|
| **Domain** | Friedman × Frontend-React × Fowler — Disabled-control discoverability + ephemeral derived state |
| **Ref** | `references/quality-ux.md` → P5 (Disabled controls dead end) + P2 (Five screen states); `references/quality-frontend.md` → P1 (Derived state) |
| **Depends on** | Task 1 |

Compute `matchedDiscoverySkill = detectInteractiveDiscoverySkill(text)` derived per render (no `useMemo` unless profiling shows hot-path cost). When `isPlan && matchedDiscoverySkill !== null`:
- Render an inline yellow warning-token affordance **above the textarea** (same DOM-slot family as `PermissionBanner` — predictable stacking). Friedman: yellow (warning), NOT red (destructive); this is "wrong tool selected", not "you broke something".
- Affordance copy: `"Plan mode disables discovery questions. Switch to agent mode to continue."` with a clickable inline button `"Switch to agent mode"` that calls `toggleMode()`.
- `handleSend` early-returns when `isPlan && matchedDiscoverySkill !== null` (Frontend-React R3: gate the action, do NOT pre-disable Send — user must be able to click and read the affordance; one source of truth for "refuse" branches both the early-return AND the affordance render).
- Render-on-keystroke (NOT only on Send-click): the affordance appears the instant input matches, so the user sees the rule before pressing Send.

Refusal state is ephemeral local — never enters Zustand (Frontend-React R1). Inline JSX in Composer; do NOT extract `PlanModeAffordance.tsx` (Fowler R4: premature for one consumer + ~5 LOC).

---

### 5. `ChatView.tsx`: short-circuit `<Composer>` mount when `sessionGroupRole === "observer"`

| | |
|---|---|
| **Domain** | Frontend-React × Fowler — Composition over configuration |
| **Ref** | `references/quality-frontend.md` → P6 (Composition over configuration); `references/refactoring.md` → P3 (State containment) |
| **Depends on** | — |

Guard inside `ChatView.tsx` immediately before the `<Composer>` mount: when the session record's `sessionGroupRole === "observer"`, render the rest of the chat surface (message history, task panel sibling) WITHOUT instantiating `<Composer>`. Use strict equality (not truthiness) — non-council sessions whose role is `undefined` MUST keep their Composer. ChatView (not App.tsx) is the right boundary: future contributors asking "why doesn't this session have a Composer?" land on the component that mounts it; App.tsx remains a routing concern (Frontend-React R4 over Fowler R5 — Frontend-React's argument that ChatView preserves the rest of chat surface for observer sessions, which the spec scope only forbids for Composer, is the stronger framing).

---

### 6. `ws-bridge.ts`: single-chokepoint observer-guard + EC-9 telemetry for `set_permission_mode`

| | |
|---|---|
| **Domain** | Backend-TS × Hunt — Single boundary + fail-closed gate |
| **Ref** | `references/quality-backend.md` → P4 (WS handlers) + P8 (Boundary types) + P6 (Structured logging); `references/security.md` → P7 (Session-ID-as-authorisation) |
| **Depends on** | — |

In `routeBrowserMessage` (already the documented dispatch chokepoint), add one block branching on `msg.type === "set_permission_mode"` placed **after** dedup and **before** the adapter `send`/queue tail. The block:

1. **Snapshot `from`** from `session.state.permissionMode` BEFORE delivery (the adapter post-delivery write at `ws-bridge.ts:713` mutates this; sampling after loses the transition).
2. **Observer reject (EC-1 server mirror).** If `session.state.sessionGroupRole === "observer"`: do NOT forward; emit `log.warn("ws-bridge", "set_permission_mode rejected on observer", { event: "composer.permission-mode.observer-rejected", sessionId, sessionGroupId, sessionGroupRole: "observer", from, to: msg.mode })`; return.
3. **Probe-null fail-closed (EC-17).** If `session.state.sessionGroupId` is present AND `session.state.sessionGroupRole` is `undefined`: do NOT forward; emit `log.warn("ws-bridge", "set_permission_mode rejected — role probe null", { event: "composer.permission-mode.role-probe-null", sessionId, sessionGroupId, from, to: msg.mode })`; return.
4. **Success path.** Emit `log.info("ws-bridge", "Composer permission-mode toggled", { event: "composer.permission-mode.toggled", sessionId, sessionGroupId, sessionGroupRole, from, to: msg.mode, backend: session.state.backendType })`; fall through to existing adapter send.

Reuse existing `log` import from `./logger.js` (already at line 60). Do NOT create `composer-telemetry.ts` (Fowler R3: premature modularisation for one event type).

---

### 7. Tests: pure-function unit tests in `utils/backends.test.ts`

| | |
|---|---|
| **Domain** | Beck (implicit) × EC-22 behavioural canary |
| **Ref** | `references/quality-testing.md` → Risk-calibrated coverage |
| **Depends on** | Tasks 1, 2 |

Add tests covering THE locked contracts:

- `pickRestoreMode("", true) === "default"` ← **THE Codex fix; this assertion is the regression canary**
- `pickRestoreMode("", false) === "acceptEdits"` ← Claude unchanged
- `pickRestoreMode("plan", true) === "plan"` (passthrough)
- `pickRestoreMode("acceptEdits", false) === "acceptEdits"` (passthrough)
- `detectInteractiveDiscoverySkill("/council-plan-aura") === "council-plan-aura"`
- `detectInteractiveDiscoverySkill("/Council-Plan-Aura") === "council-plan-aura"` (case-insensitive)
- `detectInteractiveDiscoverySkill("/council-plan-aura some args") === "council-plan-aura"` (first-token match)
- `detectInteractiveDiscoverySkill("/help") === null`
- `detectInteractiveDiscoverySkill("council-plan-aura") === null` (no leading slash)
- `detectInteractiveDiscoverySkill("") === null`
- `detectInteractiveDiscoverySkill("/") === null`

Document each assertion's purpose in a one-line comment per CLAUDE.md test-doc rule.

---

### 8. Tests: `Composer.test.tsx` — affordance render + Codex fallback + axe

| | |
|---|---|
| **Domain** | Beck (implicit) × Friedman × a11y |
| **Ref** | `references/quality-testing.md` → Behavioural assertions; `references/quality-ux.md` → P2 (Error state) |
| **Depends on** | Tasks 3, 4 |

Per CLAUDE.md component-test rule (`toHaveNoViolations()` mandatory, behavioural assertions for every interactive change). Tests to add:

- Plan mode + type `/council-plan-aura` → affordance text rendered + Send click does NOT call `sendToSession`
- Plan mode + type ordinary message ("hello") → no affordance, Send works
- Click the inline "Switch to agent mode" action → `toggleMode` is invoked → `sendToSession` called with `set_permission_mode` → agent mode
- Affordance visible state → axe scan returns `toHaveNoViolations()`
- Codex session, no `previousPermissionMode` map entry → toggle plan→agent → `sendToSession` called with `mode: "default"`, NOT `"bypassPermissions"`; `console.warn` spy receives object matching `{event: "composer.toggle.codex-fallback-default"}`
- Claude session, no `previousPermissionMode` map entry → toggle plan→agent → `sendToSession` called with `mode: "acceptEdits"` (Claude unchanged; negative-control assertion)

---

### 9. Tests: `ChatView.test.tsx` — observer Composer guard

| | |
|---|---|
| **Domain** | Beck × Frontend-React |
| **Ref** | `references/quality-testing.md` → Structural assertions |
| **Depends on** | Task 5 |

Add tests:

- Render `<ChatView sessionId="X" />` with session state where `sessionGroupRole === "observer"` → assert Composer is **NOT** in the DOM (query by `aria-label="Message input"` and assert `null`)
- Render `<ChatView sessionId="X" />` with session state where `sessionGroupRole === "orchestrator"` → assert Composer **IS** in the DOM
- Render with `sessionGroupRole === undefined` (non-council solo session) → assert Composer **IS** in the DOM (negative-control: undefined role must not collapse to "observer")

---

### 10. Tests: `ws-bridge.test.ts` — server-side observer-guard + telemetry

| | |
|---|---|
| **Domain** | Beck × Backend-TS × Hunt — EC-22 + EC-17 |
| **Ref** | `references/quality-testing.md` → Behavioural side-effect assertions |
| **Depends on** | Task 6 |

Per EC-22 — typed log emit + adapter-call branch must have behavioural assertions. Tests:

- Observer session: ingest `{type: "set_permission_mode", mode: "plan"}` → assert adapter `send` was NOT called + `log.warn` spy received `{event: "composer.permission-mode.observer-rejected", sessionGroupRole: "observer", from: <prior>, to: "plan"}`
- Orchestrator session: same ingest → assert adapter `send` WAS called with the frame + `log.info` spy received `{event: "composer.permission-mode.toggled", sessionGroupRole: "orchestrator", from: <prior>, to: "plan"}`
- `sessionGroupId` present but `sessionGroupRole === undefined` (corrupted council session): ingest → assert reject + `log.warn` spy receives `{event: "composer.permission-mode.role-probe-null"}` (EC-17 fail-closed canary)
- Solo session (`sessionGroupId === undefined`, `sessionGroupRole === undefined`): ingest → assert adapter `send` WAS called + `log.info` spy received `{event: "composer.permission-mode.toggled", sessionGroupRole: undefined, sessionGroupId: undefined}` (non-council allow-path canary)

---

### 11. Playground update

| | |
|---|---|
| **Domain** | CLAUDE.md project rule — playground mirrors message-flow components |
| **Ref** | CLAUDE.md "Component Playground" section |
| **Depends on** | Tasks 4, 5 |

Update `web/src/components/Playground.tsx` to add:
- Composer mock in plan mode with `/council-plan-aura` text — affordance visible
- ChatView mock for an observer session — Composer absent

---

## Risks & Watchpoints

- **Toggle-label honesty (Friedman R4).** The headline finding's root cause is that `plan` reads as "more deliberate" and means the opposite. The refuse-affordance treats one symptom (discovery skills) while leaving the root semantic mismatch in place for every other plan-mode flow (mid-debug "let me plan this out" → ExitPlanMode). Spec excludes label changes; flag as Phase-2 work. Sibling memory: `feedback_partial_fix_passed_as_complete` — restate the full boundary in the PR description so the gap is visible.

- **Discriminated-union refactor on chip render state (Friedman R3).** Current toggle is a boolean (`isPlan`). The right shape is `{kind: "ideal" | "loading" | "error", mode, reason?}` with EC-10 exhaustiveness — but this is a Composer-internal change with no consumer today. Defer; revisit when the SECOND server-rejection path lands.

- **`client_msg_id` on `set_permission_mode` (Frontend-React R5 + spec).** The WS ingest layer already deduplicates this type by `client_msg_id`, but the client toggle doesn't currently send one. Adding it without a paired EC-22 dedup test = unenforced contract. Defer to a dedicated commit pairing the id + test.

- **Frontmatter-driven skill metadata loader (spec Open Q2 path-ii).** Long-term shape: skills declare `interactive_discovery: true` in their frontmatter, server loads at startup, client receives the list. Hard-coded constant is the stop-gap; the cutover happens when (a) the list grows past ~10 entries OR (b) a third-party skill author needs to opt in. Track ownership.

- **In-band assistant notice for Codex fallback (Frontend-React R5).** Frontend-React proposed a server-pushed system message for the Codex fallback event; Backend-TS R4 rejected because the server cannot reliably distinguish user-driven `default` from auto-fallback. Resolution: client-side `console.warn` only (Task 3). If forensic correlation becomes painful, revisit by adding a single `from` field to the WS frame's payload AND its boundary parser — not for this fix.

- **EC-1 server mirror (Hunt R2 + Backend-TS R5).** The observer-reject branch in `ws-bridge.ts` (Task 6) is a defence-in-depth mirror of the spawn-only enforcement; the UI guard at ChatView (Task 5) is the affordance, not the boundary. Both ship together — UI alone would let a buggy/hostile client land the frame; server alone would let a confused user click an enabled toggle that silently fails.

- **`CODEX_MAPPING.md` line 93 doc drift.** Says `set_permission_mode` is "Not supported" for Codex; tests at `codex-adapter.test.ts:975-976` confirm IS supported. Doc fix is out of scope but worth a one-line PR follow-up.

---

## External Setup Required

No external setup required. All tasks can be implemented within the codebase. No new env vars, no new dependencies, no deploy-pipeline changes.

---

## Summary

| # | Task | Domain | Depends on |
|---|------|--------|------------|
| 1 | Add `INTERACTIVE_DISCOVERY_SKILLS` + `detectInteractiveDiscoverySkill` to `utils/backends.ts` | Fowler × Frontend-React × Hunt | — |
| 2 | Add `pickRestoreMode` pure helper to `utils/backends.ts` | Fowler | — |
| 3 | Composer: replace fallback ladder + client WARN on Codex default fallback | Hunt × Fowler | 2 |
| 4 | Composer: inline refuse-affordance + early-return | Friedman × Frontend-React × Fowler | 1 |
| 5 | ChatView: short-circuit Composer mount when role === observer | Frontend-React × Fowler | — |
| 6 | `ws-bridge.ts`: single-chokepoint observer-guard + EC-9 telemetry | Backend-TS × Hunt | — |
| 7 | Unit tests: `pickRestoreMode` + `detectInteractiveDiscoverySkill` | Beck | 1, 2 |
| 8 | `Composer.test.tsx`: affordance + Codex fallback + axe | Beck × Friedman × a11y | 3, 4 |
| 9 | `ChatView.test.tsx`: observer Composer guard | Beck × Frontend-React | 5 |
| 10 | `ws-bridge.test.ts`: server-side gate + telemetry | Beck × Backend-TS × Hunt | 6 |
| 11 | Playground mocks for new states | CLAUDE.md project rule | 4, 5 |

## Verdict

The structural keystone is **Task 1** (`INTERACTIVE_DISCOVERY_SKILLS` as a single exported constant per EC-20) — get this wrong and the next contributor copy-pastes the list, the gate drifts silently, and the headline defect re-emerges under a renamed skill. The most operationally important task is **Task 6** (server-side single-chokepoint gate): it's the EC-1 mirror that prevents a hostile or buggy client from mutating the observer's runtime permission state and is the boundary that EC-22 behavioural canaries (Task 10) lock down. Start with Tasks 1 + 2 (pure helpers) because they're zero-risk, fully testable in isolation, and unblock both the client edits (Tasks 3, 4) and the test scaffolding. The Codex empty-fallback assertion in Task 7 (`pickRestoreMode("", true) === "default"`) is the single line that makes the silent-privilege-upgrade defect uncross-able by a future refactor — that's the regression canary worth defending.

A pair agent during build is not necessary for this 60-LOC fix — the surface is narrow and each task is independently verifiable. If anything, the value lies in a focused observer review of Tasks 4 + 6 jointly (affordance render text drift vs. server-side log event-name drift — the EC-20 single-source class).
