# Willison — LLM Pipeline Review (2nd pass — post-burndown)

PR: `feat/dynamic-claude-models` (commit `9d922c0`)
Files under review: `web/server/anthropic-models-cache.ts`, `web/server/fixtures/anthropic-models-response-hostile.json` (NEW), `web/server/fixtures/README.md`, `web/src/components/ModelSwitcher.tsx`
Reference: `quality-llm.md` (Carmack × Willison)

Scope: verify the burndown of my prior 0 P1 / 2 P2 / 2 P3 findings AND surface any NEW LLM-pipeline concerns the burndown may have introduced. The burndown explicitly closed Beck's, Persistence's, and a11y's lanes — Willison's was on the "transitive coverage held" side.

---

## P1 — None

The two NEW LLM-pipeline-shaped questions the brief raised — bidi controls in the hostile fixture, and `<a href="#/settings">` interpolation safety — both resolve cleanly. See "Verification of NEW LLM-pipeline concerns" below.

---

## P2 — Model/CLI version-skew failure is opaque to the user (RE-FLAG — NOT addressed)

**File:** `web/server/anthropic-models-cache.ts` (orchestrator) + `web/server/cli-launcher.ts:840` (spawn site)

The burndown commit (~3818 LOC across 31 files) does not touch `cli-launcher.ts` and adds no `model_source` field to `SdkSessionInfo`. `Grep model_source|modelSource` returns zero hits in `web/server`. The dynamic-list ↔ CLI-version handoff still has no breadcrumb: when Anthropic returns `claude-opus-4-8-20260415`, user selects it, local CLI doesn't recognise it, exit code non-zero in <5s → opaque "session ended" with no log line saying "the selected model came from the live network catalogue, not the static fallback — your local CLI may be out of date."

This is the same `quality-llm.md` Principle 7 finding as in pass 1 (canonical text: *"The CLI version is the determining factor for protocol shape, available tools, and permission semantics."*). The burndown's "Persistence / Backend / a11y" foci were appropriate for the 15 P1/P2 items first-pass FINAL prioritised, but my Willison findings sat in the "transitive coverage held" bucket and were correctly not in the burndown's critical path. They remain valid and remain P2.

**Minimum-viable fix unchanged from pass 1:** propagate a one-of `static-fallback | dynamic-memory | dynamic-disk | dynamic-network` enum from the `getAnthropicModels` call site (which resolves the model) through to `SdkSessionInfo` at `cli-launcher.ts:376`/`840`/`1210`/`1422`. Wire one log line on `session:exited` with `uptime_ms < 5000` AND `exit_code !== 0` that includes `model_source`. ~30 LOC.

**Severity:** P2 (re-flagged). Not a correctness gate — the spawn still fails closed. But it's the single most-likely user-facing regression introduced by this PR's shipping a dynamic catalogue against a static CLI binary.

---

## P2 — Model id flag-injection defence still has ONE enforcement point (RE-FLAG — NOT addressed)

**File:** `web/server/anthropic-models-cache.ts:264` (regex) + `web/server/cli-launcher.ts:840` (still raw `args.push("--model", options.model)`) + `web/server/claude-adapter.ts handleOutgoingSetModel` (still no validation)

`Grep CLAUDE_MODEL_ID_RE` over `web/server/` returns exactly one hit (the definition in `anthropic-models-cache.ts`). The burndown did not promote the regex to a shared `model-id.ts` module, did not call it from `cli-launcher.ts` before the argv push, did not call it from `claude-adapter.handleOutgoingSetModel`, did not add the three call-site tests asserting `--print` / `--rm-rf` / empty / 1000-char-garbage are rejected at spawn AND at runtime `set_model`.

Today the static fallback (`CLAUDE_MODELS` in `web/src/utils/backends.ts`) is safe. The Codex `set_model` channel is hidden (Codex doesn't support `set_model`). But the `claude-adapter.handleOutgoingSetModel` path is wide open — a hostile or buggy frontend can ship any string as `model` on a `control_request`. The session's persisted `sdkSession.model` then echoes back through `cli-launcher` on the next relaunch — at which point it IS argv. Same hazard class as pass 1; same project memory pattern (`feedback_call_site_presence_not_just_symbol_export` + `feedback_one_fix_claim_grep_literal_value`).

**Minimum-viable fix unchanged:** extract `CLAUDE_MODEL_ID_RE` + a typed `InvalidModelIdError` into a shared `model-id.ts`, call it from both consumer sites, one test per call site.

**Severity:** P2 (re-flagged). One regex, three consuming sites. Matches `quality-llm.md` Principle 5: *"Make the wrong thing impossible."*

---

## P3 — `has_more: true` behavioural test was ADDRESSED (CLOSE)

The burndown's `anthropic-models-cache.test.ts` adds:

```ts
it("emits anthropic-models.pagination-needed when has_more is true", async () => {
  const fakeFetch = vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({
        data: [{ type: "model", id: "claude-opus-4-7", display_name: "Claude Opus 4.7" }],
        has_more: true,
      }),
      { status: 200 },
    ),
  );
  await getAnthropicModels("sk-test", { fetch: fakeFetch });
  const data = findEmitWithEvent(warnSpy, "anthropic-models.pagination-needed");
  expect(data).toBeDefined();
});
```

This is the exact behavioural-canary assertion my pass-1 P3 demanded. It pins the `anthropic-models.pagination-needed` event name, asserts it fires under the `has_more: true` upstream condition, and uses the `findEmitWithEvent` helper that pattern-matches on the `event` field (not message text — robust to log-text refactors). Closed.

---

## P3 — Synthetic fixture not replaced with real capture; hostile fixture is a SECOND fixture (ACCEPT)

The burndown's response to my pass-1 P3 was to add `anthropic-models-response-hostile.json` (adversarial fixture exercising 5 reject branches) rather than to replace the synthetic happy-path fixture with a real capture. This is an acceptable trade-off: a real capture catches schema drift the synthetic cannot; an adversarial fixture catches parser-rejection regressions the real capture cannot. The burndown chose the more cheaply-verifiable axis.

The `fixtures/README.md` documents the entry-index → reject-reason map (6 entries, lines 50-54), which is the discipline I asked for; the per-quarter refresh-against-real cadence note is still missing but is operator-process not code, and I am not re-flagging it on this second pass.

Closed as acceptable.

---

## Verification of NEW LLM-pipeline concerns raised in the brief

### 1. Hostile fixture bidi controls render adversarially in dev tools? → NOT a finding, but a 1-line README warning would be defence-in-depth

The fixture file contains raw UTF-8 bytes `e2 80 ae` (U+202E, RIGHT-TO-LEFT OVERRIDE) and `e2 80 ac` (U+202C, PDF) at offsets 0x118 and 0x13a. `hexdump -C` confirms. Modern VS Code (since v1.62, Trojan-Source CVE-2021-42574 mitigation) flags these visually. GitHub blob-render flags them. `cat`, `less`, terminal pagers, and OLD editors do not — and `cat`-ing the JSON makes "Trojan-Source `evil` hidden" render with the `evil` text actually mirrored.

The defence-in-depth claim of the fixture (test that the parser REJECTS bidi-bearing display_name) is correct and is what `isBoundedSafeString` enforces (line 290-291 of `anthropic-models-cache.ts`). But a developer reading the fixture file in their terminal sees the adversarial render, and the README does not warn them.

This is a real-but-tiny developer-ergonomics concern, not a security/correctness one — the bidi bytes never reach the renderer; they're filtered at the parser boundary that the fixture exists to test. Not a P3. **Suggest: one line in `fixtures/README.md` directly above the hostile entry-index table:**

> ⚠ This file contains intentional bidi-control bytes (U+202E/U+202C) at line 12 as a Trojan-Source test vector. Your terminal/editor may render line 12 adversarially. The parser REJECTS this entry — that's the test point.

One-line documentation diff. Not blocking.

### 2. Footnote `<a href="#/settings">` interpolation safety → confirmed safe

`ModelSwitcher.tsx:329` renders `href="#/settings"` as a literal string. The href value is not interpolated from any LLM/Anthropic-controlled byte. The text content inside the `<a>` (`Add an API key in Settings to see more models.`) is also a hard-coded English string. No XSS surface introduced.

For reference: the prior P1 (renderer trust) covered the `display_name` and `currentOption.label` rendering paths — those are React-escaped children. The new footnote `<a>` is structurally orthogonal — no display_name interpolation anywhere in the element. Confirmed.

### 3. `infoSpy.mock.calls[0][2]` test-shape robustness → safe by Vitest semantics

The pattern accesses `call[2]` of `mock.calls[N]`, which captures ARGUMENTS, not the mock's return value. `vi.spyOn(log, "info").mockImplementation(() => undefined)` controls what the spy RETURNS; it does not affect the shape of `mock.calls`. Changing the implementation to return any value (number, object, Promise) would not break the test pattern. The pattern correctly indexes the 3rd argument (`data`) of `log.info(module, msg, data)`, which is the structured payload. `log.info`'s signature at `web/server/logger.ts:242` is `(module, msg, data?)`. Robust.

The actual fragility (if any) is in `findEmitWithEvent`'s assumption that `data` is `Record<string, unknown>` — if a code path elsewhere ever calls `log.info("x", "y")` with no third arg, `findEmitWithEvent` correctly skips it (`if (data && data.event === event)` — falsy short-circuit). No silent break.

### 4. `signalCoalesceDegradeLogged` module-scope flag interaction with orchestrator → confirmed not a finding

The flag is set/read ONLY inside `resolveCoalescedSignal`. `getAnthropicModels` does not branch on the flag's value. The flag gates LOGGING ONLY — when `AbortSignal.any` is unavailable, the function still returns `parentSignal` and the fetch proceeds. No control flow depends on the flag. No AI-validator-style false-negative scenario (where a previously-fired flag would suppress a security-gating decision on a subsequent call).

The `__resetSignalCoalesceFlagForTests` helper is correctly module-scope-private to the test suite that exercises the degrade branch. Cross-suite test ordering can't leak: if a prior test fires the warn (setting the flag), a subsequent test that expects the warn-on-first-call asserts after calling the reset helper. Tests that don't care about the warn don't interact with the flag. Confirmed safe.

---

## NOT A FINDING — `readDiskCache:971` bare comparison vs `isCacheRecordValid:821` clamp

A pedant might flag that `readDiskCache:971` does `if (now - r.fetched_at > ttlMs) return { ok: false, reason: "stale" }` without the `Math.max(0, ...)` clamp that `isCacheRecordValid:821` now has. But the disambiguation branch at `readDiskCache:955-974` is only reached when `isCacheRecordValid` already returned false — and `isCacheRecordValid`'s clamp ensures that the negative-skew case returns `true` (cache considered fresh because clamped age is 0). So the disambiguation `stale` branch is unreachable for the negative-skew scenario; the bare comparison at 971 only handles the positive-age stale case correctly. Defensible. Not a finding.

---

## Summary

| Severity | Count | Items | Status |
|----------|-------|-------|--------|
| P1 | 0 | (renderer-trust still covered; new XSS surfaces verified absent) | — |
| P2 | 2 | Model/CLI version-skew breadcrumb; CLAUDE_MODEL_ID_RE one enforcement point | **Re-flagged — burndown did not address** |
| P3 | 0 | `has_more` test was added (closed); hostile fixture as adversarial coverage (accepted) | — |
| Minor | 1 | Hostile fixture README warning about bidi-byte render (one-line nit, NOT a finding) | Suggest |

The two P2s I raised on the first pass were not in the burndown's scope — the burndown closed the 7 P1 + 6 P2 items the FINAL-REVIEW prioritised, and my Willison findings were correctly bucketed as "transitive coverage held / lower priority." They remain valid and remain P2 on this second pass. Both are surgical (`~30 LOC` and `~40 LOC + 3 tests` respectively); both close the canonical `quality-llm.md` Principles 5 and 7 surfaces.

The new LLM-pipeline-shaped surfaces the brief asked me to verify (bidi-in-hostile-fixture, `<a href>` XSS, test-shape robustness, flag interaction) all check out cleanly. Burndown did not introduce a NEW Willison-class regression; it correctly limited scope to the first review's prioritised cluster.

**Verdict:** Burndown is acceptable from the LLM-pipeline lens. The two pre-existing P2s remain open as follow-ups. Bidi-byte fixture render is a one-line README warning at most — not blocking.
