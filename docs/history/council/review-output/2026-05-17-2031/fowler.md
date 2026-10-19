# Fowler — Refactoring / Structure / DRY Review

Scope: `README.md`, `docs/guides/council-mode.mdx`, `docs/reference/council-mode-architecture.mdx`, `docs/index.mdx`. Applying the economic test ("will this slow us down?") to docs surfaces.

---

## F-1 — Council Mode "headline" paragraph DRY violation between README and guide

- **File:** `README.md:21` ↔ `docs/guides/council-mode.mdx:8`
- **Severity:** P2
- **Principle:** DRY across canonical surfaces (Principle 4 — names/structure reveal intent; Principle 6 — boundaries earn themselves).
- **Finding:** The README's "Why Council Mode" paragraph and the guide's lead paragraph are near-verbatim duplicates of the same sentence: both contain "The multi-agent pattern that worked manually in past pipelines — catching a couple of P1 issues per phase that single-author review missed — is reproducible" with only "now reproducible without two terminals and manual coordination" vs "reproducible in one click instead of two terminals" varying. The fallible-observer disclaimer is also paraphrased in both (`README.md:23` ↔ `council-mode.mdx:12-14`). The PR's stated discipline (README = elevator pitch, guide = canonical) is violated at exactly the place that matters most — the lead.
- **Consequence:** The next copy edit to the framing claim will land in only one surface; over 2-3 releases the two paragraphs drift, and the README becomes an unreliable mirror of the guide. This is the classic doc-fork failure mode the PR was supposed to prevent.
- **Fix:** Shorten the README "Why Council Mode" paragraph to ONE sentence of mechanism + one sentence of value (no shared phrases with the guide), and delete the fallible-observer disclaimer from the README — that nuance belongs only in the guide where the user can act on it. Keep the link to the guide as the load-bearing affordance.

---

## F-2 — README architecture port number drift vs CLAUDE.md / running build

- **File:** `README.md:64-65,68-69`
- **Severity:** P2
- **Principle:** Names that lie (Principle 4).
- **Finding:** The README's ASCII data-flow block shows `:5174` for browser and `:3456` for the Hono server (matching prod). CLAUDE.md states dev is `:3457` (backend) + `:5174` (Vite). The README's `Open http://localhost:5174` line (line 39) is correct for dev. But `docs/index.mdx:18` says `Open http://localhost:3456` (which is the prod/`bunx` flow). A reader who follows the Quick Start (`bun run dev`) and then references the diagram sees `:3456` and assumes the server is reachable there in dev — it isn't (it's `:3457`). The "Backend: Hono on Bun (port 3456)" bullet (line 68) is similarly prod-mode only.
- **Consequence:** First-run user confusion; the diagram becomes a lie within minutes of the Quick Start. Each port label has at least three reasons to change (prod vs dev, backend rename, Cursor-Cloud override). This is the kind of drift that compounds across docs.
- **Fix:** Either drop the explicit port numbers from the README ASCII diagram (use `:BROWSER` / `:SERVER` placeholders and reference the guide), OR add a one-line note distinguishing dev (`:3457`) vs prod (`:3456`). Same applies to the bullet on line 68. Source of truth = `web/package.json` scripts; do not restate.

---

## F-3 — "Skill chain" inventory is the largest DRY/rot surface in the README

- **File:** `README.md:75-106`
- **Severity:** P2
- **Principle:** DRY + economic test (will this rot before the next release?).
- **Finding:** The PR replaces "29 skills" with "growing skill chain" prose, which is a good move — but the README still inventories every individual skill in three tables/lists totaling 19 named skills (5 Self-Learning + 6 Carmack Council + 18 Design & UX named inline). `ls .agents/skills/` shows 30 — the math `5 + 6 + 18 = 29` is wrong by one (`karpathy` is not in any of the three lists), and the line "Counts may shift between releases — `ls .agents/skills/` is authoritative" is contradicted by the table itself enumerating fixed members. The "growing skill chain" caveat applies only to *counts*; the *enumerations* still rot.
- **Consequence:** Every new or renamed skill triggers a README edit OR silently outdates this section. The PR's stated goal (avoid skill-count drift) is half-solved — counts are gone but the named enumerations are now the drift surface.
- **Fix:** Replace the three tables with one short paragraph per pillar (2-3 sentences naming only the load-bearing skills, e.g. `/prime`, `/council-plan`, `/council-review`) and a single sentence telling the reader to run `ls .agents/skills/` or visit the docs nav for the current set. The Design & UX inline list (18 names) is the worst offender — collapse to "design + UX hardening skills (`/polish`, `/critique`, ...) — see [impeccable](...) for the full set." Net signal-density goes up; rot surface drops by ~30 lines.

---

## F-4 — `docs/index.mdx` CardGroup tree only covers 6 of 8 nav surfaces

- **File:** `docs/index.mdx:31-61`
- **Severity:** P3
- **Principle:** Boundaries earn themselves (Principle 6) — if the home page splits "Featured" from "More features," each card group must mean something.
- **Finding:** The "Featured" group has exactly one card (Council Mode). The "More features" group has 7 cards (Sessions, Docker, Worktrees, Agents, Saved Prompts, Linear, Deploy). The split is structurally valid (Council Mode IS the differentiator), but the visual asymmetry — a single Card at `cols={1}` followed by 7 at `cols={2}` — invites future drift: the next contributor will be tempted to promote a second card to "Featured" without clear criteria. There is no documented rule for what "Featured" means.
- **Consequence:** Card hierarchy will degrade as features are added — the README has already exhibited this failure mode with the skill chain tables.
- **Fix:** Add a one-line HTML comment in the MDX above the Featured CardGroup stating the inclusion criterion (e.g. `<!-- Featured = headline differentiator; cap at 1. Everything else lives in More features. -->`). Cheapest possible defense against future drift; survives renames; reviewable in diffs.

---

## F-5 — Anchor stability: cross-doc links use page-level `/path` only, no section anchors

- **File:** `docs/guides/council-mode.mdx:167`, `docs/reference/council-mode-architecture.mdx:8,183`, `README.md:27,71`
- **Severity:** P3
- **Principle:** Boundaries / shotgun-surgery prevention.
- **Finding:** All four cross-references between guide ↔ reference ↔ README point at page-level URLs (`/guides/council-mode`, `/reference/council-mode-architecture`). None deep-link to a section. This is *defensible* for short docs (the reader lands at the top and scrolls), but two specific cross-links would benefit from anchors and would survive renames better:
  - The reference's "convention floor" section (line 112-127) links to GitHub blob URL for `conventions.md` (line 114). If `conventions.md` gets restructured (renumbered headings, file split), this stays as a coarse pointer — fine. But the reference itself does NOT have its own anchored `#convention-floor` heading that the README or guide could deep-link to. Right now the guide links to the reference page top — a reader looking for "where is the state machine?" has to scroll.
  - The README's two links (lines 27, 71) both point at the same architecture page — line 71 could deep-link `#high-level-data-flow` to be more useful at that bullet's context.
- **Consequence:** Low-grade; anchors don't pay off until docs grow. The economic test marginally fails today. Worth flagging only because every additional page makes this worse.
- **Fix:** Defer until either doc exceeds ~250 lines, then add `id`/anchor headings and update the cross-links. Not blocking for this PR.

---

## F-6 — Reference doc "convention floor" section is half-deleted but still half-restates

- **File:** `docs/reference/council-mode-architecture.mdx:112-127`
- **Severity:** P3
- **Principle:** Link-not-restate discipline (the PR's stated principle for this section).
- **Finding:** The PR's commit message says the AP-/EC- table was dropped in favor of the link to `conventions.md`. The bulk DELETE happened, but seven specific entries (`AP-2`, `AP-3`, `EC-1`, `EC-2`, `EC-4`, `EC-6`, `EC-7`, `EC-13`) are restated as a bulleted list with one-line summaries. This is the same DRY problem at smaller scale — these one-liners are now a second source of truth for those seven entries. If `conventions.md` rewords (e.g. `EC-13` failsafe tick changes from 5min to 3min), the reference page silently drifts.
- **Consequence:** Mild — drift on these specific entries. The PR went from "12 rows of duplication" to "7 rows of duplication"; the principle should be 0.
- **Fix:** Replace the bulleted list of EC-/AP- entries (line 118-125) with prose: "The load-bearing entries for this architecture are `AP-2..3` and `EC-1, EC-2, EC-4, EC-6, EC-7, EC-13` — follow the link above for current text." Reader gets the *which IDs apply* signal without restating their content. This is what the link-not-restate discipline actually means.

---

## F-7 — README `bunx aura-companion` reference and Quick Start clone flow live in two stacked blocks with overlapping shape

- **File:** `README.md:32-49`
- **Severity:** P3
- **Principle:** Signal density (Principle 4 — names/structure should reveal intent).
- **Finding:** Two adjacent code blocks under the same H2 cover three install paths (clone-and-dev, global install, bunx) with `bun install -g` and `bunx` blurred together visually. Reading order forces the user to scan all three before deciding. CLAUDE.md and `web/package.json bin` confirm `bunx aura-companion` is the published path — that's the one-line answer most readers want; clone-and-dev is the contributor path.
- **Consequence:** Mild signal dilution. First-time visitors who just want to try it have to read past the contributor flow.
- **Fix:** Lead with `bunx aura-companion` (one-line "try it"), then a `<details>` collapsed block or sub-heading for "Or build from source" with the clone flow. Mirrors `docs/index.mdx:14-18` which already does this cleanly.

---

## Summary

7 findings: **0 P1, 3 P2, 4 P3**.

The PR's structural goal (canonical guide, elevator-pitch README, link-not-restate reference) is mostly delivered. The two material drift surfaces remaining are: **(F-1)** the lead-paragraph duplication between README and guide, and **(F-3)** the per-skill inventories in the README. F-2 is a small but reader-visible port-number drift that will burn first-run users. The rest are hygiene.

Recommendation: ship the PR; land F-1, F-2, F-3 fixes in a follow-up before the next docs-touching PR — they pay off in weeks, not months.
