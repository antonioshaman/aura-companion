# Vitaly Friedman — UX Quality Review

Domain scope: `README.md` (triad-above-skills-inventory), `docs/guides/council-mode.mdx` (reading order, troubleshooting discoverability, lifecycle), `docs/index.mdx` (Card disambiguation).

Reference: `quality-ux.md`. Spec acceptance: `specs/aura-documentation-rebrand.md` Story 2.

---

## F-1 — Reading order satisfies Story 2 only by reordering inside the reader's head

**File:** `docs/guides/council-mode.mdx:12-78`
**Severity:** P2
**Principle:** Principle 6 (Dashboards/lists drive action) + Story 2 acceptance: "they learn (in order): what the feature does, how to enable it, the two provider pairings, the ObserverPanel states, the two keyboard shortcuts, and what to do when the observer enters Degraded."

**Finding:** Spec ordering is `what → enable → pairings → ObserverPanel states → shortcuts → degraded`. Current guide order is `what → fallible framing → can/cannot → when to use → enable + pairings (combined) → ObserverPanel states → shortcuts → grounding → lifecycle → restart-replay → provider badges → degraded → workspace artefacts → troubleshooting → limits`. Three reader-visible H2s ("How findings get grounded", "Finding lifecycle", "Restart-replay determinism", "Provider badges") sit BETWEEN "Keyboard shortcuts" and "Degraded mode" — the acceptance criterion's tail. A reader who came here to find degraded recovery has to scroll past four conceptual sections about grounding, lifecycle, determinism, and badges before reaching the action they actually need.

**Consequence:** Story 2 AC is technically satisfied (all six topics ARE present in order if you filter them out), but the reader who scans top-to-bottom hits four cognitive detours before getting to recovery. Time-to-recovery on a degraded observer is the moment the user most needs the docs to be terse, and this is where the page becomes most discursive.

**Fix:** Move "How findings get grounded" + "Finding lifecycle" + "Restart-replay determinism" + "Provider badges" to AFTER "Degraded mode" (i.e., immediately above "Workspace artefacts"). The action-oriented spine — what/enable/pairings/states/shortcuts/degraded — should be uninterrupted. Background concepts (grounding mechanics, lifecycle states, determinism, badges) belong below the action spine, before workspace artefacts and troubleshooting.

---

## F-2 — "Restart-replay determinism" is a dead-end with no onward affordance to where determinism matters

**File:** `docs/guides/council-mode.mdx:106-108`
**Severity:** P3
**Principle:** Principle 4 (Progressive disclosure with visible triggers); end-of-section onward affordance.

**Finding:** The section explains determinism in 3 lines, then ends. The reader who cares about determinism likely cares because they saw a duplicate finding (covered in troubleshooting row 4) or are debugging a session — but the section gives no pointer to either. The troubleshooting table is the disambiguating surface for "did the observer just hallucinate?" (row 7) and "Two STOPs on the same finding" (row 4), yet determinism doesn't link to it.

**Consequence:** Users who land on determinism via a Mintlify anchor link from a stack-trace or peer recommendation see the explanation but have no path forward to the diagnostic move (pull recordings, hard-refresh) they actually need.

**Fix:** Add one sentence at section end pointing to troubleshooting row 4 ("Two STOPs on the same finding") and to "How findings get grounded" — these are the two contexts where determinism is consequential, not curiosity.

---

## F-3 — Troubleshooting is the seventh H2 down — the user with a broken observer has to scroll through 7 sections to find it

**File:** `docs/guides/council-mode.mdx:146-155`
**Severity:** P2
**Principle:** Principle 6 (Dashboards/lists drive action); troubleshooting discoverability under stress.

**Finding:** "Troubleshooting" is the 13th H2 on the page (counting from the top: What is/isn't, Can/cannot, When to use, Enabling, ObserverPanel states, Keyboard, How findings, Worked example as H3, Finding lifecycle, Restart-replay, Provider badges, Degraded mode, Workspace artefacts, Troubleshooting, Limits, Further reading). A user with a broken observer arrives at this page in a hurry. Mintlify generates a right-hand TOC, which mitigates the scroll cost — but the page itself has no in-band "if something's wrong, jump to Troubleshooting" affordance. The TOC is right-rail and easy to miss on smaller laptops; in-band navigation never appears in the body.

**Consequence:** Users hitting an issue have to either trust the right-rail TOC or scroll. The page reads as a tour, not a reference — the reference affordance is invisible from the top.

**Fix:** Add one line directly under the H1 paragraph (line 8) such as: "Looking for help with a stuck or degraded observer? Jump to Troubleshooting." Cheap, single-line, materially reduces time-to-resolution for stress arrivals. Counterpart: the "Degraded mode" section (line 124) should link to the matching troubleshooting row, not stand alone.

---

## F-4 — "Limits in v1" framing is correctly placed but missing the most important limit from a calibration standpoint

**File:** `docs/guides/council-mode.mdx:157-163`
**Severity:** P3
**Principle:** Principle 9 (Trust compounds slowly, breaks fast) — expectation calibration.

**Finding:** The "Limits in v1" list enumerates five mechanical limits (no auto-invoke, N=2 only, no cross-session memory, no hot-swap, Codex experimental). It correctly avoids "marketing-grade" claims. But it does NOT restate the most consequential limit, the one that determines whether a user should trust a finding at all — the observer is fallible. That framing IS present at line 14 ("fallible second opinion, not an oracle"), which is correct, but it's separated from "Limits" by 140+ lines of mechanics. A reader skimming "Limits in v1" without having read the top of the page (a common scan path — many users hit MDX docs from search results that anchor mid-page) sees only mechanical constraints and may infer that within those constraints the observer is reliable.

**Consequence:** Mid-page arrivals (search-link anchors, peer-shared deep-links) miss the fallibility framing entirely and form an inflated trust model.

**Fix:** Restate the fallibility limit as the first bullet of "Limits in v1": "The observer is an LLM — it can hallucinate or miss real defects. STOPs are prompts to look, not verdicts to obey." This is redundant with line 14 deliberately; redundancy here is correct because Limits is the only section a search-arriving reader is guaranteed to encounter alongside the mechanics that shape expectations.

---

## F-5 — README triad works for F-pattern scan but Skill chain section breaks signal density immediately after

**File:** `README.md:15-50, 75-106`
**Severity:** P3
**Principle:** Principle 1 (Structure complexity — don't simplify away user value).

**Finding:** The triad (What this is / Why Council Mode / How to enable it) lands lines 15-29 and is excellent for F-pattern scanning: an F-scan reader gets a 1-sentence "what" (line 17), a 1-paragraph "why" with the differentiating story (line 21), and a 1-paragraph "how" with two links (line 27). Quick Start follows immediately. The screenshot at line 29 reinforces "council pair" without ambiguity. But then the "Skill chain" section (line 75-106) is dense table-heavy real estate that re-introduces 27 skills. For a reader who has already decided "I want this" after the triad, the Skill chain is below the fold and uninterrupted-prose-heavy — fine. For a reader still deciding, scrolling past it to reach "Recommended workflow" (line 108) — which is what actually persuades — is a steep ask. The triad sets expectations that the page is action-oriented; the Skill chain breaks that contract.

**Consequence:** Users in the "decide whether to install" mode (Story 1) get pulled into a skills inventory before they've seen the workflow that justifies skills. Inverted ordering against intent.

**Fix:** Move "Recommended workflow" (line 108) to immediately AFTER the "How to enable it" section / Quick Start block (i.e., above "Self-Learning"). The workflow IS the answer to "what does adopting this look like." The Skill chain inventory belongs below the workflow as a reference catalogue, not before it as a wall.

---

## F-6 — Featured Card for Council Mode is correct, but disambiguation between Featured and More features is implicit

**File:** `docs/index.mdx:29-61`
**Severity:** P3
**Principle:** Principle 6 (Dashboards drive action); Card disambiguation.

**Finding:** The page has two `<CardGroup>` sections: "Featured" (1 col, Council Mode only) and "More features" (2 cols, 7 cards). The visual hierarchy works — Council Mode gets a wider card, dedicated section, and richer copy. But there's no in-prose signal explaining the hierarchy. A reader scanning the page sees two CardGroup blocks and may infer "Featured = paid/premium" or "Featured = default mode" — neither is the actual signal ("Featured = headline differentiator and likely your first reason to install").

**Consequence:** The disambiguation works visually for desktop readers but is opaque to anyone on a narrow viewport (where 1-col vs 2-col collapses to the same column count) and to screen-reader users navigating section by section.

**Fix:** Add a one-line lead-in before the Featured CardGroup: "Council Mode is the headline differentiator — start here." Equivalent before "More features": "Other capabilities included with Aura Companion:". Cheap, makes the implicit ranking explicit, survives column-count collapse.

---

## F-7 — Empty/error/loading state coverage in user docs: missing the "never-checkpointed-yet" reader path

**File:** `docs/guides/council-mode.mdx:60-69, 146-155`
**Severity:** P2
**Principle:** Principle 2 (Design all five screen states); empty state in docs surface.

**Finding:** The ObserverPanel states section (lines 60-69) lists 7 states including `never-checkpointed-yet` ("observer is up but the orchestrator has not written a first checkpoint, so there is nothing to review yet"). This is structurally the "empty state" of a Council session — a brand-new pair right after spawn. The state is enumerated, but there is NO troubleshooting row for it, no "what do I do if I'm stuck here" guidance, and no link from this state in the list to actionable next-step ("trigger your first orchestrator phase / checkpoint to get out of this state"). A first-time user who toggles Council Mode and immediately checks the panel will see `never-checkpointed-yet` and have no idea whether to wait, configure something, or take action.

**Consequence:** The single state most likely to be a new user's first impression has zero recovery guidance — the user can't tell whether the system is broken or simply waiting for them.

**Fix:** Add one sentence to the `never-checkpointed-yet` list item explaining how to exit it: "The observer leaves this state as soon as the orchestrator writes its first checkpoint — typically when you complete the first phase of a Carmack chain or invoke `/council-plan`." This is the docs equivalent of a "no items yet — create one to start" empty-state pattern.

---

## F-8 — README screenshot alt text under-describes the most informative shot

**File:** `README.md:2, 29`
**Severity:** P3
**Principle:** Principle 2 (Design all five screen states) — degraded state coverage in docs.

**Finding:** Two screenshots, two alts:
- Line 2: "Aura Companion main workspace with Council Mode toggle on the New Session dialog" — accurate.
- Line 29: "Council Mode showing orchestrator chat alongside the observer panel surfacing a STOP finding" — accurate.

Both describe the happy path. Neither alt text — nor any screenshot anywhere in the docs — depicts a degraded state, a downgrade-to-NOTE annotation in the FindingsLog, or a `never-checkpointed-yet` panel. A user encountering an unfamiliar UI state has no visual confirmation that what they're seeing matches the docs.

**Consequence:** Visual onboarding only covers the ideal screen state (Principle 2 mismatch). Trust on first contact with a non-ideal state (degraded banner, downgraded finding, empty panel) is anchored entirely in prose with no visual confirmation.

**Fix:** Add at minimum one secondary screenshot in `docs/guides/council-mode.mdx` showing either the `degraded` ObserverPanel state with the DegradedBanner OR a FindingsLog with a `DOWNGRADED` row visible. Place it next to the relevant section. Defer if screenshot capture is out of scope for this PR; flag as P2 if shipped without.

---

## Summary

- P1: 0
- P2: 3 (F-1, F-3, F-7)
- P3: 5 (F-2, F-4, F-5, F-6, F-8)

Total: 8 findings.

The PR meets Story 2 acceptance criteria mechanically. The findings above are about how a real reader (under stress, mid-page-arrival, F-pattern scan) experiences the surface — not whether the criteria are check-box satisfied. None of the findings warrant blocking the PR; F-1 and F-3 are the highest-leverage follow-ups because they affect time-to-recovery for the most common failure mode (degraded observer).
