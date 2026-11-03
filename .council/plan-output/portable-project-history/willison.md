# Simon Willison — portable history LLM-content recommendations

Aura remains a protocol bridge. V1 needs no model call, validator change, CLI replay into a running agent, or local agent runtime. Inspected `handoff-extractor.ts`, `session-types.ts`, `ws-bridge.ts:setPickupDraft`, and `routes.ts:continue-in-new`.

## W1. Keep the archive separate from a bounded continuation brief

- **Principle:** Preserve evidence; transform only an explicitly labelled derivative.
- **What to get right:** AC2/AC7/AC10: serialize available user/assistant content, tool inputs/results, role, order, timestamps, provenance, embedded attachments and explicit omissions. Do not serialize `extractHandoff()` as the archive: it strips images, truncates tools, drops unknown events and caps transcript. Produce a separate deterministic continuation brief with explicit truncation/omission metadata and a hard UTF-8 byte bound. Existing `capTranscript()` deliberately retains an arbitrarily large last chunk; its defaults are not a strict bound. Avoid claiming extracted todos or latest user text constitute an authoritative current task. Archive content may contain old, contradictory instructions.
- **Risk:** A successful-looking export silently destroys the exact work users need; an oversized last message defeats continuation limits.
- **Depends on:** Canonical archive schema and selected-history snapshot task.
- **Verifiers:** `web/server/portable-history.test.ts` (new): both providers, long final text block, long tool output, image attachment, unknown block omission and strict brief cap; existing `web/server/handoff-extractor.test.ts` if that helper is changed.

## W2. Imported records are inert evidence, including apparent tools and permissions

- **Principle:** An LLM-shaped instruction does not confer authority.
- **What to get right:** AC8/AC9/AC11: dedicated archive viewer renders content as plain escaped text; tool metadata/input/output remain literal and expandable. No raw HTML, markdown remote images, iframe/embed, automatic URL/resource loads, imported tool execution or actionable historical permission buttons. Historical tool names need a generic text fallback. Do not hydrate imported records into `message_history` of a live bridge session. Imported approval suggestions and resolved permission events must confer no runtime permission. A draft should clearly distinguish quoted historical context from the user's present instructions.
- **Risk:** Importing a plausible transcript creates a new command/permission or loads an attacker-controlled resource while reading it.
- **Depends on:** Archive schema and settings viewer task; Hunt owns general import security.
- **Verifiers:** `web/src/components/PortableHistorySettings.test.tsx` (new): malicious HTML, remote images, tool names/arguments with markup, ANSI/control content, expandable full preview, and absence of executable permission controls. `web/server/routes/portable-history-routes.test.ts` (new): historical permission fields do not become create-session options.

## W3. Continue through an explicit provider choice and held draft

- **Principle:** Transfer context without transferring execution state.
- **What to get right:** AC8/AC9: call the existing session orchestrator with the user's selected backend and validated existing working directory; create a new independent solo session, then call `setPickupDraft(newId, draft, selectedBackend)`. Do not reuse source CLI session ids, models, Council membership, credentials, permissions or auto-proceed state. Existing continue-in-new preserves original backend and can create a Council pair, so do not blindly call its endpoint for this feature. Verify that draft restoration on refresh works and that no user message/CLI input is sent before the user sends the draft. Invalid folder/unavailable backend must not mutate the archive/source.
- **Risk:** Claude archive accidentally creates Claude when Codex was selected; provider failure destroys original state; a draft auto-sends historical instructions.
- **Depends on:** W1 and import store, existing orchestrator preflight seam.
- **Verifiers:** `web/server/routes/portable-history-routes.test.ts`: Claude→Codex and Codex→Claude, spy on orchestrator options, failed create and archive/source immutability, selected backend passed to pickup draft, no CLI send. `web/src/components/PortableHistorySettings.test.tsx`: draft preview and explicit continuation action. Existing `web/server/ws-bridge.test.ts` for held-draft persistence if changed.

## W4. Preserve uncertainty and interrupted streams across versions

- **Principle:** A snapshot is evidence of what was observed, not proof the model finished.
- **What to get right:** AC1/AC2/AC7/AC10: preserve existing assistant `streamStatus` (`complete`, `interrupted`, `errored`) and error result text in archive/view/Markdown/brief. Legacy absent status means unknown/not recorded in the portable presentation; do not infer successful completion from absence of a terminal frame or successful export. Distinguish attachment absent, redacted, unsupported and truncated. Store provider/model/CLI version provenance only when available; never fabricate a CLI version. Version the portable schema independently from CLI protocols and tolerate unknown tool names through literal display. Unsupported protocol blocks should produce explicit omission metadata rather than disappearing.
- **Risk:** A half-written answer is presented as finished guidance; a CLI upgrade silently drops tool results or breaks archive viewing.
- **Depends on:** W1 schema and viewer task.
- **Verifiers:** `web/server/portable-history.test.ts` and component tests: interrupted/errored/legacy fixtures, unknown tool and block type, missing provenance, visible omission markers.

## W5. Replay captured content deterministically; do not add an AI summarizer

- **Principle:** Same bytes, same archive and brief; tests should not call a live model.
- **What to get right:** AC1/AC2/AC7/AC8/AC9: use small sanitized fixtures from both provider message shapes, preserving exact raw recording strings when testing adapter ingestion. Include mid-stream interruption, tool/text interleaving, malformed/unsupported blocks and permission suggestions. Archive tests assert semantic preservation after approved redaction, not raw byte equality with secrets. No AI validator changes are needed: imported context must not enter its recent-message context before explicit sending. New sessions use existing current permission controls; historical allow suggestions cannot create validator allow rules. If implementation unexpectedly adds model-derived summaries or permission grading, stop that scope expansion: deterministic extraction already satisfies V1, and model output would require schema validation and explicit failure fallback.
- **Risk:** Happy-path-only tests miss provider divergence; live-model tests flake; model summaries rewrite original user intent or fail when the blocked provider is unavailable.
- **Depends on:** W1–W4 fixture contract; Beck verification plan.
- **Verifiers:** New `web/server/portable-history.test.ts`, route tests and existing `web/server/handoff-extractor.test.ts`; existing adapter replay tests only if adapter code changes. No reason to modify `ai-validator.ts` or its tests in this feature.

## W6. Announce context portability with provider limits visible

- **Principle:** Do not confuse a portable transcript with portable model state or equivalent agent capability.
- **What to get right:** AC13/AC14: landing copy promises available-history preservation and reviewed context transfer Claude ↔ Codex. It must not imply native CLI resume across providers, model memory/state transfer, identical model performance, comprehensive block immunity, or an already working GPU/local agent. In-product brief labels should use the same scope.
- **Risk:** Users discover the portability promise depended on a provider account or local agent runtime that V1 does not supply.
- **Depends on:** Passing W1–W5 and landing task; no production deployment in scope.
- **Verifiers:** Landing copy review against AC13/AC14 and source assertions only if the repository already maintains landing copy tests; verify supported provider wording in new settings component tests.

## Task 4 preparation — API contract and Settings integration (read-only)

Read frontend-design and council-implement frontend/a11y references. Use existing `cc-*` semantic colors, typography and 44px controls. This is an archive utility within Settings; avoid a new marketing visual style or dependency.

Settings categories currently scroll to sections; all children mount together. Therefore mount a lightweight `PortableHistorySettings` in its own section but **load on an explicit “Open portable history” button**, not an unconditional effect. This keeps unrelated Settings visits quiet and avoids breaking old `SettingsPage.test.tsx` API mocks that do not expose the new methods. Add an integration render assertion plus axe to SettingsPage tests, and isolate actual service mocking/behavior tests in `PortableHistorySettings.test.tsx`. Do not put API loading inside a hidden-but-mounted child.

Suggested exact contract, to reconcile once with Task 3 before implementation (not an additional endpoint if equivalent already exists):

| Client method | HTTP | Request | Response |
|---|---|---|---|
| `listPortableHistory()` | GET `/portable-history` | none | `{ sessions: [{id, project, backend, messageCount, archived}], archives: [{id, importedAt, sessionCount}], limits: {maxArchiveBytes, maxBriefBytes}, warnings: string[] }` |
| `exportPortableHistory(sessionIds)` | POST `/portable-history/export` | `{sessionIds: string[]}` | canonical portable archive JSON |
| `importPortableHistory(archive)` | POST `/portable-history/import` | parsed archive object | `{id: string, duplicate: boolean}` |
| `getPortableHistory(id)` | GET `/portable-history/:id` | none | `{archive, briefs: [{sessionId, text, omissions}]}` |
| `continuePortableHistory(id, sessionId, backend, cwd)` | POST `/portable-history/:id/continue` | `{sessionId, backend: "claude" | "codex", cwd: string}` | `{newSessionId, draft}` |

JSON returned through existing authenticated `get`/`post` helpers is sufficient. Browser download can use Blob/object URL with immediate URL revocation after use; readable Markdown can be supplied with detail response or generated using the same tested server pure formatter. Do not download through an unauthenticated anchor. Backend owns published actual limits; UI displays those values rather than duplicating constants.

Composition: open/load control → compact error/status line → source-session checkboxes grouped by project + export selection → labelled JSON file input/import button → imported archive list → selected archive's session selector and expandable literal transcript → separate visibly capped continuation preview + labelled provider select + working-folder input + “Create session with draft”. Keep labels plain, source provenance visible, and the draft unsent. Render a bounded page of transcript entries or use native collapsed details; never mount multi-megabyte arrays into the DOM. Avoid new global store: local selected IDs, archive detail, pending operation and error suffice. Guard asynchronous selections from stale responses.

Accessibility verification: render + axe on loaded, empty and error states; real keyboard/user-event import/export retry, checkbox selection, provider/folder controls and expansion; errors use `role=alert`, success/loading use polite status, no forced focus on load. Preserve selected archive and source selection on failures. An empty source list still permits import. Use labelled native controls and full-width wrapping at narrow sizes. Archive/plain-text preview must wrap long URLs/commands.

Landing reminder for later task: the real RU-facing deployed source is `landing-legacy/site/index.html`. Editing only `landing/src` does not satisfy AC13/AC14. No production deploy requested.

## Verified Task 1 follow-up — continuation usefulness and readable fidelity

Read-only `bun -e` reproduction against finished `portable-history.ts`:

1. **Newest goal disappears behind earliest history.** A first user message of `"OLD".repeat(MAX_DRAFT_BYTES)` followed by `"CURRENT GOAL: finish release"` produces `latestGoalIncluded=false`, `omittedMessages=2`. AC7's bounded/disclosed condition is met mechanically, but this weakens the intended continuation story. Minimal recommendation: retain bounded initial setup and prioritize the newest tail, with an explicit middle omission marker; strictly cap both sides including a huge final message on UTF-8 boundaries. Add a regression with earliest setup, overflowing middle and newest goal; assert both sentinels, omission count, UTF-8 byte bound and no replacement characters. Do not summarize using a model.

2. **Arbitrary historical JSON becomes an empty object silently.** Source `content: [{custom: "valuable evidence"}]` exports `content: [{}]`. `validateContent()` intentionally accepts arbitrary no-type objects, but `historicalContent()` projects all objects through `BLOCK_FIELDS`. Preserve validated no-type JSON as evidence (normal redaction still applies), or explicitly label the omitted shape. Add a round-trip evidence regression including an arbitrary object nested in tool output, and assert no silent `{}` replacement. AC2/AC10.

3. **Readable Markdown does not quote untrusted transcript content.** A string `<img src=https://example.test/x>\n![external](https://example.test/y)` appears verbatim directly below `### user ...` in `archiveMarkdown()`. A plain `<pre>` Aura viewer remains safe, so this alone is not an AC11 violation inside Aura; external Markdown readers may interpret the HTML/image. Prefer literal transcript fences (choose a fence longer than any run in content), with roles/provenance outside fences and explicit metadata escaping. Add fixture containing HTML, remote Markdown image, headings and backtick/tilde fence escapes; verify literal representation and full evidence preservation. The full Markdown currently otherwise includes all messages/tool bytes and interrupted/unknown states; no additional fidelity claim is made without a reproducer.

No implementation changes made during this inspection.
