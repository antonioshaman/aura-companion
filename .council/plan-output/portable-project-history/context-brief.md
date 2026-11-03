# Context + Feature Brief for Aura Council Plan

Confirmed by user: portable project history V1: archive/export/import/view; Claude ↔ Codex continuation with explicit draft; human-readable Markdown/Obsidian; accurate landing announcement. Local GPU agent deferred. User explicitly requested council planning then implementation, no further identical scope gate needed. Read specs/portable-project-history-v1.md: AC1–15 are binding; recommendations MUST cite AC ids. No code in recommendations.

Stack: Bun/Hono/TS; React19/Zustand/Tailwind; filesystem JSON. Existing session-store persists ~/.companion/sessions (overview doc stale). wsBridge.getSession(id) returns live history. SessionStore.loadAll()/loadArchived? inspect methods. launcher.listSessions metadata. handoff-extractor.ts already makes bounded Markdown stripping images and truncating tools; do NOT use it as full archive. routes.ts continue-in-new creates new session + wsBridge.setPickupDraft without auto-send. session-orchestrator createSession owns backend preflight. secret-redaction.ts is existing policy. No new protocol frames or LLM calls required. Do not add a tool-execution runtime.

Potential boundaries: new portable-history data module + separate durable imported archive store outside live session store, new routes module using existing auth middleware, settings UI entry avoids touching message/chat components and Playground. Existing SettingsPage has category tabs and individual settings child components. Use existing API layer, no new state library. Need include both active and archived available histories; avoid credentials/raw protocol/config/env/PID/permission state. Preserve data, version schema, bounded import and rendering, content-based duplicate detection; imports never restore executability.

Domain assignments:
- hunt: web/server/secret-redaction.ts, web/server/routes.ts auth and register seams, web/server/atomic-write.ts, new portable-history import/export boundary. AC3,5,9,11.
- fowler: web/server/session-store.ts, web/server/handoff-extractor.ts, routes.ts continue-in-new, web/src/components/SettingsPage.tsx, web/src/api.ts. AC1,4,6,8,12,15; UI/FS lenses folded into concrete modules.
- willison: handoff-extractor.ts, session-types.ts browser message shapes, ws-bridge setPickupDraft, routes continue-in-new. AC2,7,8,9,10,13,14.
- beck: existing routes and settings tests + new archive/store/routes/component tests; all AC verifier mapping, render/axe/interactive including errors.

Council: economy, 4 guaranteed cross-stack lenses beck/fowler/hunt/willison, skipping other specialists per engine over-budget/no-domain ledger. Estimated 18 files/1500 lines; persistence and untrusted import make council mandatory. Catalog root /home/auracomp/.companion/skill-pack/versions/59704fb494ae548d/_council-experts . Fingerprint TS/Bun/Hono/React, no Python/database. AGENTS symlink scan warning; user supplied complete instructions in conversation.

Read relevant code only; propose minimal concrete tasks with principles/AC ids/dependencies and test file verifiers. Write each report to .council/plan-output/portable-project-history/<seat>.md. No code changes. Beck is review-only in catalog; ask him to review this acceptance/verification design before code, explicitly not pretend a plan-aura.md exists. No production deployment, no commits/push required.
