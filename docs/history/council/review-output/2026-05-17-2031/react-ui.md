# React/Web UI Council Review — Landing TSX (Nav.tsx + Footer.tsx)

Reviewer: React 19 + Vite + Tailwind Web UI Expert
Scope: `landing/src/components/Nav.tsx`, `landing/src/components/Footer.tsx`
PR commit under review: `50a9018` (docs A/B v1)

## Diff fingerprint

`git diff HEAD~1 HEAD --shortstat`: **2 files changed, 6 insertions(+), 6 deletions(-)**. One token per anchor: `rel="noopener"` → `rel="noopener noreferrer"`. No class string changes, no whitespace shifts, no JSX shape changes, no import changes, no attribute reordering. Mechanical edit, surgical scope.

---

## Findings

### F1 — Minimal-diff discipline observed on all six anchors

| | |
|---|---|
| **File:lines** | `landing/src/components/Nav.tsx:15,23`; `landing/src/components/Footer.tsx:6,10,16,19` |
| **Severity** | P3 (positive observation) |
| **Principle** | Minimal-diff discipline; surgical-edit hygiene on docs/hardening PRs |
| **Finding** | The PR mutates exactly one token per anchor (the `rel` value string) and leaves every other property — including the long Tailwind class string on `Nav.tsx:24` (`inline-flex items-center gap-2 px-4 py-2.5 …`) and the inline JSX whitespace fragments `{" "}` on `Footer.tsx:8,12` — byte-identical to the pre-PR state. No attribute reordering, no formatter churn, no incidental class consolidation. |
| **Consequence** | Reviewers can verify the security upgrade with a one-grep canary (`rg "rel=" landing/src/`); future blame lines stay anchored to the meaningful change. |
| **Fix** | None — keep this discipline as a model for future hardening PRs touching JSX attributes. |

---

### F2 — Rel value correctness verified on all six anchors

| | |
|---|---|
| **File:lines** | `Nav.tsx:15,23`; `Footer.tsx:6,10,16,19` |
| **Severity** | P3 (verification, not a defect) |
| **Principle** | `rel` token-list semantics under `target="_blank"` |
| **Finding** | Each of the six `target="_blank"` anchors now carries the two-token list `noopener noreferrer` (space-separated, lowercase, no trailing whitespace, no duplicate tokens). Token order is conventional; both tokens are independently valid per HTML spec. Grep confirms zero remaining `rel="noopener"` (single-token) occurrences in `landing/src/`. |
| **Consequence** | Reverse-tabnabbing and `Referer`-header leakage are both closed across the entire landing-site outbound surface. |
| **Fix** | None. |

---

### F3 — Spec scope honored; "four hrefs" prompt summary was loose, "six anchors" plan is authoritative

| | |
|---|---|
| **File:lines** | `Nav.tsx:13,21` (both link to `github.com/antonioshaman/aura-companion`); `Footer.tsx:6,10,16,19` |
| **Severity** | P3 |
| **Principle** | Spec adherence; scope discipline |
| **Finding** | The review prompt summarised spec scope as "four landing-site hrefs", but `.council/abtest/v1-docs-plan.md` Task 13 explicitly mandates "all six `target="_blank"` anchors in `Nav.tsx` (2) + `Footer.tsx` (4)" and the PR matches that count exactly (6/6). The two `Nav.tsx` anchors point to the same `github.com/antonioshaman/aura-companion` URL but are distinct DOM nodes (desktop GitHub text link L13–19 + primary "Open Repo" CTA L20–27) — both correctly hardened. |
| **Consequence** | No anchor missed. Implementation aligns with the plan, not the prompt's loose paraphrase. |
| **Fix** | None for the code; future review prompts should source the spec scope directly. |

---

### F4 — MIT attribution prose + URLs preserved verbatim (spec acceptance criterion)

| | |
|---|---|
| **File:lines** | `Footer.tsx:4–13` |
| **Severity** | P3 |
| **Principle** | Surgical edit honours spec's "do not reword" rule; rel hardening does NOT imply de-linking the upstream credit |
| **Finding** | The two upstream attribution URLs (`github.com/The-Vibe-Company/companion` on L6 and `thevibecompany.co` on L10) are still rendered as live `<a>` elements with their original `href` values and the surrounding prose ("Aura Companion — forked from … by … (MIT)") is byte-identical. Plan Task 13 calls this out as load-bearing: the rel-hardening pass MUST NOT collapse the attribution into plain text. The PR honours that. |
| **Consequence** | MIT credit obligation is satisfied; the attribution links are now safer (both reverse-tabnabbing and `Referer` leakage closed) without becoming unlinked text. |
| **Fix** | None. |

---

### F5 — `target="_blank"` on every landing outbound link is intentional and not regressed

| | |
|---|---|
| **File:lines** | `Nav.tsx:14,22`; `Footer.tsx:6,10,16,19` |
| **Severity** | P3 |
| **Principle** | New-tab convention for outbound navigation on marketing surfaces |
| **Finding** | Every external link in `Nav.tsx` and `Footer.tsx` opens in a new tab (`target="_blank"`); the in-app brand link on `Nav.tsx:7` (`href="/"`) intentionally does NOT carry `target="_blank"` and does NOT carry `rel`, which is correct (same-origin same-tab navigation). The PR preserves both halves of that distinction. |
| **Consequence** | Outbound-vs-internal navigation semantics remain consistent across the landing surface. |
| **Fix** | None. |

---

### F6 — Test mandate from CLAUDE.md does NOT apply to landing tree

| | |
|---|---|
| **File:lines** | `landing/` (entire subtree) |
| **Severity** | P3 (policy clarification) |
| **Principle** | CLAUDE.md test mandate is scoped to `web/src/components/`, not `landing/src/components/` |
| **Finding** | CLAUDE.md states: "Every new or modified frontend component (`web/src/components/`) must have an accompanying `.test.tsx` file with at minimum: a render test, an axe accessibility scan (`toHaveNoViolations()`), and tests for any interactive behavior." The path is explicit and exclusive to `web/src/components/`. The `landing/` tree has its own `package.json` (no test runner declared — scripts are only `dev`/`build`/`preview`, no Vitest, no `@testing-library/react`), its own `tsconfig.json`, its own Vite config, and zero existing `.test.tsx` files anywhere under `landing/`. The PR does not need to add a Vitest setup, a test file, or an axe scan for these `rel` attribute edits. |
| **Consequence** | No test was mandated by the existing repo convention; adding one would have been scope-creep into bootstrapping a parallel test infrastructure. |
| **Fix** | None for this PR. **Separate consideration** (out of scope here): if the team wants the landing tree to participate in the same a11y/regression discipline as `web/src/`, that's a standalone task — bootstrap Vitest + `@testing-library/react` + `vitest-axe` under `landing/`, wire into the husky hook, and backfill render+axe tests for Nav, Footer, and any other landing components. It is **not** a defect of this PR that it didn't do that. |

---

### F7 — No anti-patterns introduced; no React 19 / Tailwind concerns surfaced

| | |
|---|---|
| **File:lines** | `Nav.tsx`, `Footer.tsx` (whole files post-edit) |
| **Severity** | P3 |
| **Principle** | No inline closure props on hot lists; no fresh-object Zustand selectors; no `useEffect` on derived state; no string-typed handlers; Tailwind class strings stable |
| **Finding** | These components are stateless presentational shells: no Zustand subscriptions, no `useState`, no `useEffect`, no event handlers, no refs, no `use(...)` Suspense reads. The PR adds no new imports, no new hooks, no new closure props, no new className concatenations, no key collisions. The Tailwind class strings on `Nav.tsx:5,7,11,16,24` and `Footer.tsx:3,4,6,10,15,16,19` are unchanged from pre-PR. There is no error-boundary lane to consider for static markup. |
| **Consequence** | No new performance, hydration, or reconciliation surface introduced. |
| **Fix** | None. |

---

### F8 — Two anchors in `Nav.tsx` linking to the same href are distinct UI affordances, not a duplication anti-pattern

| | |
|---|---|
| **File:lines** | `Nav.tsx:12–19` (GitHub text link) and `Nav.tsx:20–27` (Open Repo CTA) |
| **Severity** | P3 |
| **Principle** | Distinct visual affordances for the same destination is a legitimate pattern when responsive visibility differs |
| **Finding** | The two `Nav.tsx` anchors share an `href` but differ in `className`: the L12 anchor is `hidden sm:block` (visible from `sm:` breakpoint up); the L20 CTA is always visible and styled as the primary button. This is a deliberate desktop-vs-mobile hierarchy. The PR doesn't change either visibility class; it hardens `rel` on both, which is correct. |
| **Consequence** | No DRY/anti-pattern concern; the duplication is functional, not accidental. |
| **Fix** | None. |

---

## Summary

The diff is the textbook shape for a security-hardening PR on static JSX: one token per anchor, six anchors, +6/-6 lines total, zero collateral. Spec scope (six anchors) honoured. MIT attribution preserved. No tests mandated by CLAUDE.md (landing tree is out of the `web/src/components/` mandate). No anti-patterns introduced.

**Findings total: 8 — 0 P1, 0 P2, 8 P3 (all positive verifications / scope clarifications).**
