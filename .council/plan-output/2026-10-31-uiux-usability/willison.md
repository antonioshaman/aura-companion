# Willison — LLM-facing UI planning advice

Read `quality-llm.md`, the supplied full scope, applicable `conventions.md` entries, assigned components and narrow dependencies/tests. Planning only; no product/state changes. Evidence below is current source inspection, not a live CLI or browser verification.

## 1. Give permission/collaboration modes truthful, backend-specific presentation

**Verified current-code issue. AC4, AC7; severity 2/4; Nielsen: match between system and real world; visibility of system status.**

`web/src/components/Composer.tsx:102–106` defaults a missing mode to `acceptEdits`, then falls back to the raw value whenever it is absent from the backend's option list. Both mobile (`:671`) and desktop (`:883`) display that result. `web/src/utils/backends.ts:157–165` offers only bypassPermissions and plan, so ordinary `default` and `acceptEdits` reach the raw-label fallback. This explains a technical label without proving a permission escalation. `web/server/codex-adapter.ts:705–707` also seeds initial-plan restoration with `acceptEdits`.

The crucial semantic constraint: `web/server/codex-adapter.ts:3671–3680` ignores the mode for approval/sandbox policy and returns `never` / `danger-full-access`; `:3690–3694` preserves an explicit observer read-only restriction at turn level. A Codex `default` or `acceptEdits` label must therefore **not** be called “Supervised” merely because that word appears in agent-mode options. Plan is a collaboration mode here, not proof of a read-only execution sandbox.

**Minimal change:** separate the displayed label/description from the transmitted value. Cover the actual backend values, keep the original stored/wire values, and use “Mode unavailable” (with raw diagnostic detail) when no mode is known rather than claiming `acceptEdits`. Derive Codex execution wording from its existing adapter semantics; describe Plan as planning collaboration and execution as automatic approval where applicable. Keep the two-option toggle behavior unchanged in this display task. Any desired change to Codex's actual permission policy requires a separately reviewed backend decision.

**Red-first verifier:** add table-driven label tests in `utils/backends.test.ts` for Claude/Codex × plan/default/acceptEdits/bypassPermissions/missing/unknown; render Composer in mobile and desktop presentations with each supported mode and assert human labels and accurate accessible descriptions. Assert rendering alone sends no `set_permission_mode`, and existing toggle tests still send exactly their original values. Include initial Codex plan → restored acceptEdits as a display fixture. Add render/axe/interaction coverage and the changed chat state in Playground. Source test expectations from adapter behavior, not UI label assumptions.

**Dependencies:** chair/UX copy decision for the plain-language terms; no new protocol/storage dependency. Integrate with any existing mode-copy task rather than creating a second mapping implementation.

## Verified safeguards / no additional necessary changes established

- `ToolBlock.tsx:25–46` tolerates unknown tool names; details use React text/pre rendering and diff views. No renderer injection or missing expansion failure was established within this surface.
- `use-chat-announcement.ts:48–53` distinguishes interrupted/errored from complete for an active prose stream; paired tests cover both. `MessageBubble.tsx:274–319` already attaches an interruption badge. Do not reopen generic “interruption invisible” work without a failing current scenario.
- `FindingsLog.tsx:252–274` uses observed model/provider provenance for reviewer labels; ordinary findings JSON is gated by observer-session provenance in `MessageBubble.tsx:345–354`. No attribution defect established.

## Hypotheses and acceptance limits

`MessageBubble` does not visibly badge `streamStatus: errored`, but no current producer of that assistant status was established in the narrow inspected path. This is a hypothesis, not an implementation task. Escalate only with a recording or failing end-to-end event fixture showing a truncated reply mistaken for a completed reply.

No replay, browser, physical iPhone/VoiceOver, or live Claude/Codex smoke was run by this expert. Those remain explicit acceptance evidence; mocked mode tests cannot establish actual permissions. No AI-validator/backend-pipeline rewrite is justified by this UI audit evidence.
